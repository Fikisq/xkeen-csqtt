use crate::configs::xray_files_with_replacement;
use crate::device_bypass;
use crate::nfqws2;
use crate::types::AppState;
use axum::{extract::State, Json};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{collections::BTreeMap, process::Stdio, sync::OnceLock, time::Duration};
use tokio::{io::AsyncWriteExt, process::Command, sync::Mutex};

const CONFIG_FILE: &str = "/opt/etc/xray/configs/00_config.json";
const API_LISTEN: &str = "127.0.0.1:18085";
static ROUTE_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
static LIVE_SWITCHES: OnceLock<Mutex<Option<LiveSwitches>>> = OnceLock::new();
struct LiveSwitches { process: String, shape: Value, targets: BTreeMap<String, String> }
pub(crate) async fn invalidate_switches() {
    *LIVE_SWITCHES.get_or_init(|| Mutex::new(None)).lock().await = None;
}
pub(crate) fn routing_lock() -> &'static Mutex<()> { ROUTE_LOCK.get_or_init(|| Mutex::new(())) }

#[derive(Deserialize)]
pub struct ApplyRoutesRequest {
    pub(crate) file: String,
    pub(crate) previous_content: String,
    pub(crate) content: String,
}

fn routing_api_enabled(config: &Value) -> bool {
    config.pointer("/api/listen").and_then(Value::as_str) == Some(API_LISTEN)
        && config.pointer("/api/services").and_then(Value::as_array)
            .is_some_and(|services| services.iter().any(|service| service.as_str() == Some("RoutingService")))
}

pub(crate) async fn replace_live_rules(config: &Value) -> Result<(), String> {
    let mut ordered = config.clone();
    prioritize_device_rules(&mut ordered);
    let mut runtime = crate::xray_subscription_refresh::live::runtime_config(&ordered).await?;
    omit_shadowed_device_rules(&mut runtime);
    let process = crate::xray_subscription_refresh::live::process_identity()?;
    let mut switches = LIVE_SWITCHES.get_or_init(|| Mutex::new(None)).lock().await;
    let targets = prepare_switches(&mut runtime)?;
    let mut shape = runtime["routing"].clone();
    for balancer in shape["balancers"].as_array_mut().into_iter().flatten() {
        if targets.contains_key(balancer["tag"].as_str().unwrap_or("")) {
            balancer.as_object_mut().unwrap().remove("fallbackTag");
        }
    }
    if let Some(active) = switches.as_mut().filter(|active| active.process == process && active.shape == shape) {
        for (balancer, target) in &targets {
            if active.targets.get(balancer) == Some(target) { continue; }
            let result = override_target(balancer, target).await;
            if result.is_err() { *switches = None; return result; }
            active.targets.insert(balancer.clone(), target.clone());
        }
        return Ok(());
    }
    *switches = None;
    let config = &runtime;
    let routing = config.get("routing").ok_or("В JSON нет маршрутизации")?;
    let input = serde_json::to_vec(&json!({ "routing": routing })).map_err(|e| e.to_string())?;
    let mut command = Command::new("/opt/sbin/xray");
    command.args(["api", "adrules", "-s", API_LISTEN, "-t", "12", "stdin:"])
        .env("XRAY_LOCATION_ASSET", "/opt/etc/xray/dat")
        .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
    let mut child = command.spawn().map_err(|e| format!("Не удалось вызвать API Xray: {e}"))?;
    let Some(mut stdin) = child.stdin.take() else { return Err("Не удалось передать правила Xray".into()) };
    stdin.write_all(&input).await.map_err(|e| format!("Не удалось передать правила Xray: {e}"))?;
    drop(stdin);
    let output = tokio::time::timeout(Duration::from_secs(18), child.wait_with_output()).await
        .map_err(|_| "API Xray не ответил за 18 секунд".to_string())?
        .map_err(|e| format!("Ошибка API Xray: {e}"))?;
    if output.status.success() {
        *switches = Some(LiveSwitches { process, shape, targets });
        return Ok(());
    }
    let error = String::from_utf8_lossy(&output.stderr);
    Err(format!("Xray не принял правила: {}", error.trim().chars().take(300).collect::<String>()))
}

// Keep selectors in the runtime only. Saved configs retain ordinary outboundTag
// rules and work after a core restart even before the next API update.
fn prepare_switches(config: &mut Value) -> Result<BTreeMap<String, String>, String> {
    let mut targets = BTreeMap::new();
    let mut balancers = config["routing"]["balancers"].as_array().cloned().unwrap_or_default();
    let rules = config["routing"]["rules"].as_array_mut().ok_or("Нет правил маршрутизации")?;
    for (index, rule) in rules.iter_mut().enumerate() {
        // Any named row can change its connection independently, including RU,
        // YouTube and custom rules. Conditions and order remain in the shape.
        if !rule["ruleTag"].as_str().is_some_and(|tag| !tag.is_empty()) { continue; }
        let Some(target) = rule["outboundTag"].as_str().map(str::to_owned) else { continue; };
        let balancer = format!("__xkeen_switch_{index}");
        if balancers.iter().any(|item| item["tag"] == balancer) { return Err("Зарезервированный тег балансировщика XКeen занят".into()); }
        // No prefix matching against real outbounds: the fallback is the exact
        // selected handler. OverrideBalancerTarget changes it without Geo reload.
        balancers.push(json!({"tag": balancer, "selector": [format!("{balancer}_no_handler")], "fallbackTag": target, "strategy": {"type": "random"}}));
        rule.as_object_mut().unwrap().remove("outboundTag");
        rule["balancerTag"] = json!(balancer);
        targets.insert(balancer, target);
    }
    config["routing"]["balancers"] = json!(balancers);
    Ok(targets)
}

async fn override_target(balancer: &str, target: &str) -> Result<(), String> {
    let output = tokio::time::timeout(Duration::from_secs(4), Command::new("/opt/sbin/xray")
        .args(["api", "bo", "-s", API_LISTEN, "-t", "3", "-b", balancer, target])
        .kill_on_drop(true).output()).await
        .map_err(|_| "Тайм-аут переключения выхода Xray".to_string())?
        .map_err(|e| e.to_string())?;
    if output.status.success() { Ok(()) }
    else { Err(format!("Xray не переключил выход: {}", String::from_utf8_lossy(&output.stderr).trim().chars().take(200).collect::<String>())) }
}

// Device fallbacks must win over every general service rule, including RU.
// Keep disabled device rules in their block so toggling cannot move the fallback.
fn prioritize_device_rules(config: &mut Value) {
    let Some(rules) = config.pointer_mut("/routing/rules").and_then(Value::as_array_mut) else { return };
    let device = |rule: &Value| -> Option<String> {
        let tag = rule["ruleTag"].as_str()?.trim_start_matches("disabled:");
        tag.strip_prefix("device:")?.split(':').next().map(str::to_owned)
    };
    let mut ips = Vec::new();
    for rule in rules.iter() {
        if let Some(ip) = device(rule) { if !ips.contains(&ip) { ips.push(ip); } }
    }
    if ips.is_empty() { return; }
    let mut result: Vec<Value> = rules.iter().filter(|rule| device(rule).is_none() && rule["ruleTag"].as_str().is_none()).cloned().collect();
    for ip in ips {
        let own: Vec<Value> = rules.iter().filter(|rule| device(rule).as_deref() == Some(ip.as_str())).cloned().collect();
        let fallback = own.iter().position(|rule| rule["ruleTag"].as_str().is_some_and(|tag|
            tag.strip_prefix(&format!("device:{ip}:VPN")).is_some_and(|suffix| suffix.is_empty() || suffix.starts_with('|'))));
        if let Some(index) = fallback {
            let vpn = own[index].clone();
            let tag = vpn["ruleTag"].as_str().unwrap_or("");
            let bypass = vpn["outboundTag"] == "direct" && !tag.ends_with("|split") && !tag.ends_with("|selector");
            if bypass { result.push(vpn.clone()); }
            result.extend(own.into_iter().enumerate().filter_map(|(i, rule)| (i != index).then_some(rule)));
            if !bypass { result.push(vpn); }
        } else { result.extend(own); }
    }
    result.extend(rules.iter().filter(|rule| device(rule).is_none() && rule["ruleTag"].as_str().is_some()).cloned());
    *rules = result;
}

// An earlier unconditional per-host rule wins for both transports. Keep the
// saved rules intact, but avoid recompiling unreachable GeoSite/GeoIP matchers.
// Recompute from the full saved config on every apply, including bypass removal.
fn omit_shadowed_device_rules(config: &mut Value) {
    let Some(rules) = config.pointer_mut("/routing/rules").and_then(Value::as_array_mut) else { return };
    let mut covered = std::collections::HashSet::<String>::new();
    rules.retain(|rule| {
        let ips = rule.get("sourceIP").and_then(Value::as_array);
        if ips.is_some_and(|ips| !ips.is_empty() && ips.iter().all(|ip|
            ip.as_str().is_some_and(|ip| covered.contains(ip)))) { return false }
        let unconditional = rule["type"] == "field"
            && rule["outboundTag"].as_str().is_some_and(|tag| !tag.is_empty())
            && rule.as_object().is_some_and(|object| object.keys().all(|key|
                ["type", "network", "outboundTag", "sourceIP", "ruleTag"].contains(&key.as_str())))
            && match rule.get("network") {
                None => true,
                Some(Value::String(network)) => {
                    let parts: Vec<_> = network.split(',').map(str::trim).collect();
                    parts.len() == 2 && parts.contains(&"tcp") && parts.contains(&"udp")
                }
                _ => false,
            };
        if unconditional {
            for ip in ips.into_iter().flatten().filter_map(Value::as_str) {
                // Do not reason about CIDR overlap, geo categories or inversion.
                if ip.parse::<std::net::IpAddr>().is_ok() { covered.insert(ip.into()); }
            }
        }
        true
    });
}

pub async fn apply_routes(State(state): State<AppState>, Json(request): Json<ApplyRoutesRequest>) -> Json<Value> {
    let started = std::time::Instant::now();
    let _guard = ROUTE_LOCK.get_or_init(|| Mutex::new(())).lock().await;
    let _config_guard = state.app_config_lock.lock().await;
    if state.core.read().unwrap().name != "xray" || request.file != CONFIG_FILE {
        return Json(json!({ "success": false, "error": "Доступен только активный Xray 00_config.json" }));
    }
    if request.content.len() > 2_000_000 || request.previous_content.len() > 2_000_000 {
        return Json(json!({ "success": false, "error": "Слишком большой JSON" }));
    }
    let Ok(current) = tokio::fs::read_to_string(CONFIG_FILE).await else {
        return Json(json!({ "success": false, "error": "Не удалось прочитать текущий JSON" }));
    };
    if current != request.previous_content {
        return Json(json!({ "success": false, "error": "Конфигурация уже изменилась. Обновите страницу" }));
    }
    let Ok(old_config) = serde_json::from_str::<Value>(&current) else {
        return Json(json!({ "success": false, "error": "Текущий JSON повреждён" }));
    };
    let Ok(new_config) = serde_json::from_str::<Value>(&request.content) else {
        return Json(json!({ "success": false, "error": "Новый JSON повреждён" }));
    };
    if !routing_api_enabled(&old_config) || !routing_api_enabled(&new_config) {
        return Json(json!({ "success": false, "error": "Локальный API маршрутизации Xray не включён" }));
    }
    let mut old_without_routes = old_config.clone();
    let mut new_without_routes = new_config.clone();
    old_without_routes.as_object_mut().unwrap().remove("routing");
    new_without_routes.as_object_mut().unwrap().remove("routing");
    if old_without_routes != new_without_routes {
        return Json(json!({ "success": false, "error": "Без перезапуска можно менять только маршрутизацию" }));
    }
    let files = xray_files_with_replacement(CONFIG_FILE, &request.content).await;
    if files.iter().any(|item| item.file != CONFIG_FILE && serde_json::from_str::<Value>(&item.content).ok()
        .and_then(|value| value.get("routing").cloned()).is_some()) {
        return Json(json!({ "success": false, "error": "Маршрутизация разделена между файлами; требуется обычное применение" }));
    }
    // adrules builds the routing configuration and the running Xray validates
    // every matcher before atomically publishing the new rules. A second full
    // core startup test repeats that expensive geo compilation for every edit.
    // Settings outside rules/balancers are not reloaded by RoutingService.
    let routing_settings = |config: &Value| {
        let mut routing = config.get("routing").cloned().unwrap_or(Value::Null);
        if let Some(object) = routing.as_object_mut() {
            object.remove("rules");
            object.remove("balancers");
        }
        routing
    };
    if routing_settings(&old_config) != routing_settings(&new_config) {
        return Json(json!({ "success": false, "error": "Настройки маршрутизатора требуют обычного применения; API меняет только правила и балансировщики" }));
    }
    if let Err(error) = replace_live_rules(&new_config).await {
        // Restore through the same API. Never turn a failed rule update into a
        // household-wide process/firewall restart.
        let recovery = replace_live_rules(&old_config).await;
        let detail = match recovery {
            Ok(()) => format!("{error}. Прежняя маршрутизация восстановлена; повторите сохранение"),
            Err(recovery_error) => format!("{error}. API-откат не подтверждён: {recovery_error}. Автоматический перезапуск запрещён"),
        };
        return Json(json!({ "success": false, "error": detail }));
    }
    let bypass_changed = match device_bypass::needs_sync(&old_config, &new_config) {
        Ok(changed) => changed,
        Err(error) => {
            _ = replace_live_rules(&old_config).await;
            return Json(json!({ "success": false, "error": error }));
        }
    };
    let previous_bypass = if bypass_changed {
        match device_bypass::apply_for_config(&new_config).await {
            Ok(previous) => Some(previous),
            Err(error) => {
                _ = replace_live_rules(&old_config).await;
                return Json(json!({ "success": false, "error": error }));
            }
        }
    } else { None };
    if let Err(error) = nfqws2::sync_transition(&old_config, &new_config).await {
        if let Some(previous) = &previous_bypass { device_bypass::restore(previous).await; }
        _ = replace_live_rules(&old_config).await;
        return Json(json!({ "success": false, "error": error }));
    }
    let temporary = format!("{CONFIG_FILE}.{}.tmp", uuid::Uuid::new_v4());
    let write_result = async {
        tokio::fs::write(&temporary, &request.content).await.map_err(|e| e.to_string())?;
        let permissions = tokio::fs::metadata(CONFIG_FILE).await.map_err(|e| e.to_string())?.permissions();
        tokio::fs::set_permissions(&temporary, permissions).await.map_err(|e| e.to_string())?;
        tokio::fs::rename(&temporary, CONFIG_FILE).await.map_err(|e| e.to_string())
    }.await;
    if let Err(error) = write_result {
        _ = tokio::fs::remove_file(&temporary).await;
        _ = nfqws2::sync_transition(&new_config, &old_config).await;
        if let Some(previous) = &previous_bypass { device_bypass::restore(previous).await; }
        _ = replace_live_rules(&old_config).await;
        return Json(json!({ "success": false, "error": format!("Не удалось сохранить JSON: {error}") }));
    }
    let mut warning = device_bypass::clear_changed_device_connections(&old_config, &new_config).await;
    let global_vpn = |config: &Value| config.pointer("/routing/rules").and_then(Value::as_array)
        .and_then(|rules| rules.iter().find(|rule| rule["ruleTag"].as_str()
            .is_some_and(|tag| tag.split('|').next() == Some("VPN"))))
        .map(|rule| (rule["outboundTag"].as_str().map(str::to_owned),
            rule["balancerTag"].as_str().map(str::to_owned)));
    if global_vpn(&old_config) != global_vpn(&new_config) {
        let note = "Новый сервер уже выбран для новых соединений клиентов. Открытое TCP-соединение нельзя перенести между серверами: оно завершится на прежнем выходе. Перезагрузка роутера, компьютера или Wi-Fi не требуется";
        warning = Some(warning.map_or_else(|| note.to_string(), |message| format!("{message}. {note}")));
    }
    Json(json!({ "success": true, "warning": warning, "elapsedMs": started.elapsed().as_millis() }))
}
