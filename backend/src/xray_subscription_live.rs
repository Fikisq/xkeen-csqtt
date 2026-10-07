//! Subscription handlers are versioned: old handlers stay alive for existing
//! sessions. No RemoveOutbound, process restart, firewall or DNS mutation.
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{collections::{HashMap, HashSet}, process::Stdio, time::Duration};
use tokio::{io::AsyncWriteExt, process::Command};

const API: &str = "127.0.0.1:18085";
const STATE: &str = "/opt/etc/xkeen/xray-subscription-live.json";
const MAX_HANDLERS: usize = 128;

#[derive(Clone, Default, Deserialize, Serialize)]
pub(crate) struct LiveState {
    process: String,
    aliases: HashMap<String, String>,
}

fn process_identity() -> Result<String, String> {
    let pids = crate::controller::get_pid("xray");
    if pids.len() != 1 { return Err("Нужен ровно один процесс Xray".into()); }
    let pid = pids[0];
    let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).map_err(|_| "Не удалось определить процесс Xray")?;
    let tail = stat.rsplit_once(") ").ok_or("Некорректный proc/stat Xray")?.1;
    let start = tail.split_whitespace().nth(19).ok_or("Нет starttime Xray")?;
    Ok(format!("{pid}:{start}"))
}

async fn state() -> Result<LiveState, String> {
    let process = process_identity()?;
    match tokio::fs::read(STATE).await {
        Ok(bytes) => {
            let saved: LiveState = serde_json::from_slice(&bytes).map_err(|_| "Повреждена карта живых узлов; обновление пропущено")?;
            if saved.process == process { Ok(saved) }
            else { Ok(LiveState { process, ..Default::default() }) }
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(LiveState { process, ..Default::default() }),
        Err(_) => Err("Не удалось прочитать карту живых узлов".into()),
    }
}

async fn api(command: &str, input: Option<&Value>) -> Result<Vec<u8>, String> {
    let mut cmd = Command::new("/opt/sbin/xray");
    cmd.args(["api", command, "-s", API, "-t", "12"])
        .env("XRAY_LOCATION_ASSET", "/opt/etc/xray/dat")
        .stdout(Stdio::piped()).stderr(Stdio::null()).kill_on_drop(true);
    if input.is_some() { cmd.arg("stdin:").stdin(Stdio::piped()); }
    let mut child = cmd.spawn().map_err(|_| "Не удалось вызвать API Xray")?;
    if let Some(input) = input {
        let data = serde_json::to_vec(input).map_err(|_| "Не удалось собрать запрос API")?;
        let mut stdin = child.stdin.take().ok_or("Нет stdin API Xray")?;
        stdin.write_all(&data).await.map_err(|_| "Не удалось передать запрос API")?;
        drop(stdin);
    }
    let output = tokio::time::timeout(Duration::from_secs(18), child.wait_with_output()).await
        .map_err(|_| "Тайм-аут API Xray; автоматический перезапуск запрещён")?
        .map_err(|_| "Ошибка вызова API Xray")?;
    if !output.status.success() {
        return Err(format!("API Xray {command} недоступен/отклонил запрос; перезапуск не выполнялся"));
    }
    Ok(output.stdout)
}

fn mapped_routing(config: &Value, aliases: &HashMap<String, String>) -> Result<Value, String> {
    let mut routing = config.get("routing").cloned().ok_or("В JSON нет routing")?;
    if let Some(rules) = routing.get_mut("rules").and_then(Value::as_array_mut) {
        for rule in rules {
            if let Some(tag) = rule.get("outboundTag").and_then(Value::as_str) {
                if let Some(alias) = aliases.get(tag) { rule["outboundTag"] = json!(alias); }
            }
        }
    }
    let tags: Vec<&str> = config["outbounds"].as_array().into_iter().flatten()
        .filter_map(|node| node["tag"].as_str()).collect();
    if let Some(balancers) = routing.get_mut("balancers").and_then(Value::as_array_mut) {
        for balancer in balancers {
            if let Some(selectors) = balancer.get("selector").and_then(Value::as_array) {
                let mut expanded = Vec::new();
                for selector in selectors {
                    let prefix = selector.as_str().ok_or("Некорректный selector балансировщика")?;
                    // Expand prefixes into the current generation only; retired
                    // handlers must never re-enter a balancer's candidate set.
                    for tag in tags.iter().filter(|tag| tag.starts_with(prefix)) {
                        expanded.push(json!(aliases.get(*tag).map(String::as_str).unwrap_or(tag)));
                    }
                }
                if expanded.is_empty() { return Err("Пустой selector балансировщика после обновления".into()); }
                balancer["selector"] = json!(expanded);
            }
            if let Some(tag) = balancer.get("fallbackTag").and_then(Value::as_str) {
                if let Some(alias) = aliases.get(tag) { balancer["fallbackTag"] = json!(alias); }
            }
        }
    }
    Ok(routing)
}

pub(crate) async fn runtime_config(config: &Value) -> Result<Value, String> {
    let saved = state().await?;
    let mut result = config.clone();
    if !saved.aliases.is_empty() { result["routing"] = mapped_routing(config, &saved.aliases)?; }
    Ok(result)
}

pub(crate) struct Update {
    old: LiveState,
    next: LiveState,
}

pub(crate) async fn prepare(old_config: &Value, new_config: &Value) -> Result<Update, String> {
    if old_config.pointer("/api/listen").and_then(Value::as_str) != Some(API)
        || !old_config.pointer("/api/services").and_then(Value::as_array).is_some_and(|services|
            ["HandlerService", "RoutingService"].iter().all(|name| services.iter().any(|s| s.as_str() == Some(name)))) {
        return Err("Для обновления без перезапуска нужны локальные HandlerService и RoutingService. Новые узлы сохранены как pending; текущая сеть не изменена".into());
    }
    let old = state().await?;
    let bytes = api("lso", None).await?;
    let start = bytes.iter().position(|byte| *byte == b'{').ok_or("API не вернул JSON узлов")?;
    let listed: Value = serde_json::from_slice(&bytes[start..]).map_err(|_| "Некорректный ответ API узлов")?;
    let existing: HashSet<String> = listed["outbounds"].as_array().ok_or("Нет списка живых узлов")?
        .iter().filter_map(|n| n["tag"].as_str().map(str::to_owned)).collect();
    let previous: HashMap<&str, &Value> = old_config["outbounds"].as_array().ok_or("Нет старых узлов")?
        .iter().filter_map(|n| n["tag"].as_str().map(|t| (t, n))).collect();
    let mut next = old.clone();
    let mut additions = Vec::new();
    let generation = uuid::Uuid::new_v4().simple().to_string();
    let nodes = new_config["outbounds"].as_array().ok_or("Нет новых узлов")?;
    let fixed = |config: &Value| config["outbounds"].as_array().into_iter().flatten()
        .filter(|node| !node["tag"].as_str().is_some_and(|tag| tag.starts_with("sub-")))
        .cloned().collect::<Vec<_>>();
    if fixed(old_config) != fixed(new_config) {
        return Err("Обновление подписки не должно менять локальные/direct/другие выходы".into());
    }
    for node in nodes {
        let tag = node["tag"].as_str().ok_or("Узел без tag")?;
        if !tag.starts_with("sub-") { continue; }
        let active = old.aliases.get(tag).map(String::as_str).unwrap_or(tag);
        if previous.get(tag).is_some_and(|before| **before == *node) {
            if !existing.contains(active) { return Err("Живые узлы расходятся с конфигурацией; обновление пропущено".into()); }
        } else {
            // Preserve the original prefix so Observatory continues probing
            // the new generation. Balancer selectors below are expanded.
            let alias = format!("{tag}-xk-live-{generation}");
            let mut addition = node.clone();
            addition["tag"] = json!(alias);
            addition.as_object_mut().unwrap().remove("xkeenDisplayName");
            additions.push(addition);
            next.aliases.insert(tag.into(), alias);
        }
    }
    next.aliases.retain(|tag, _| nodes.iter().any(|n| n["tag"].as_str() == Some(tag)));
    if existing.iter().filter(|tag| tag.starts_with("sub-")).count() + additions.len() > MAX_HANDLERS {
        return Err("Достигнут лимит 128 поколений узлов; текущие соединения сохранены, обновление отложено до планового перезапуска".into());
    }
    // Outbound chaining requires replacement of non-subscription handlers too.
    // Refuse it rather than silently keeping a stale dialer.
    for node in nodes {
        let mut settings = node.clone();
        if let Some(object) = settings.as_object_mut() { object.remove("tag"); object.remove("xkeenDisplayName"); }
            let text = serde_json::to_string(&settings).map_err(|_| "Некорректный узел")?;
            if next.aliases.keys().any(|tag| text.contains(&format!("\"{tag}\""))) {
                return Err("Цепочка outbounds требует отдельного применения; автоматический перезапуск запрещён".into());
            }
    }
    mapped_routing(new_config, &next.aliases)?;
    if !additions.is_empty() { api("ado", Some(&json!({"outbounds": additions}))).await?; }
    if process_identity()? != old.process { return Err("Процесс Xray изменился во время обновления".into()); }
    Ok(Update { old, next })
}

impl Update {
    pub(crate) async fn apply(&self, config: &Value) -> Result<(), String> {
        if process_identity()? != self.old.process { return Err("Процесс Xray изменился".into()); }
        api("adrules", Some(&json!({"routing": mapped_routing(config, &self.next.aliases)?}))).await?;
        let temporary = format!("{STATE}.{}.tmp", uuid::Uuid::new_v4());
        let data = serde_json::to_string(&self.next).map_err(|_| "Не удалось записать карту узлов")?;
        super::write_private(&temporary, &data).await.map_err(|_| "Не удалось записать карту узлов")?;
        tokio::fs::rename(&temporary, STATE).await.map_err(|_| "Не удалось сохранить карту узлов".to_string())
    }

    pub(crate) async fn rollback(&self, config: &Value) -> Result<(), String> {
        api("adrules", Some(&json!({"routing": mapped_routing(config, &self.old.aliases)?}))).await?;
        let data = serde_json::to_string(&self.old).map_err(|_| "Не удалось восстановить карту узлов")?;
        super::write_private(STATE, &data).await.map_err(|_| "Не удалось восстановить карту узлов".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> Value {
        json!({"outbounds":[{"tag":"direct"},{"tag":"sub-01"},{"tag":"sub-02"}],
            "routing":{"rules":[
                {"ruleTag":"device:192.168.0.4:VPN|bypass","outboundTag":"direct","sourceIP":["192.168.0.4"]},
                {"ruleTag":"VPN","outboundTag":"sub-01"}],
                "balancers":[{"tag":"auto","selector":["sub-"],"fallbackTag":"sub-01"}]}})
    }

    #[test]
    fn redirects_new_connections_and_preserves_office_bypass() {
        let config = fixture();
        let map = HashMap::from([("sub-01".into(), "sub-01-xk-live-new".into())]);
        let route = mapped_routing(&config, &map).unwrap();
        assert_eq!(route["rules"][0], config["routing"]["rules"][0]);
        assert_eq!(route["rules"][1]["outboundTag"], "sub-01-xk-live-new");
        assert_eq!(config["routing"]["rules"][1]["outboundTag"], "sub-01");
    }

    #[test]
    fn balancer_contains_current_generations_only() {
        let config = fixture();
        let map = HashMap::from([("sub-01".into(), "sub-01-xk-live-new".into())]);
        let route = mapped_routing(&config, &map).unwrap();
        assert_eq!(route["balancers"][0]["selector"], json!(["sub-01-xk-live-new", "sub-02"]));
        assert_eq!(route["balancers"][0]["fallbackTag"], "sub-01-xk-live-new");
    }

    #[test]
    fn rejects_empty_balancer_candidates() {
        let mut config = fixture();
        config["routing"]["balancers"][0]["selector"] = json!(["missing-"]);
        assert!(mapped_routing(&config, &HashMap::new()).is_err());
    }

    #[test]
    fn direct_rules_and_non_subscription_targets_are_unchanged() {
        let config = fixture();
        let route = mapped_routing(&config, &HashMap::new()).unwrap();
        assert_eq!(route["rules"], config["routing"]["rules"]);
    }
}
