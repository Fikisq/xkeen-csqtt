use axum::{Json, extract::State};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{os::unix::fs::PermissionsExt, path::Path, sync::OnceLock, time::{Duration, Instant}};
use tokio::process::Command;
use tokio::sync::Mutex;

use crate::types::AppState;

const CANARY: &str = "/opt/etc/xkeen/nfqws2-stage/canary.sh";
const ENGINE: &str = "/opt/etc/xkeen/nfqws2-stage/engine";
const ROOT: &str = "/opt/etc/xkeen/nfqws2-stage";
const PROFILE: &str = "/opt/etc/xkeen/nfqws2-stage/profile";
const CUSTOM: &str = "/opt/etc/xkeen/nfqws2-stage/custom-strategy.args";
const AUTO_SELECTION: &str = "/opt/etc/xkeen/nfqws2-stage/auto-selection";
const PROBE: &str = "/opt/etc/xkeen/nfqws2-stage/probe";
const PROBE_SCRIPT: &str = "/opt/etc/xkeen/nfqws2-stage/probe-check.sh";
const PROBE_CANDIDATE: &str = "/opt/etc/xkeen/nfqws2-stage/probe-candidate.args";
const LAST_CHECK: &str = "/opt/etc/xkeen/nfqws2-stage/last-check.json";
const XRAY_CONFIG: &str = "/opt/etc/xray/configs/00_config.json";
// Written only after the marked outbound and its NFQUEUE rule are installed together.
const GLOBAL_ENABLED: &str = "/opt/etc/xkeen/nfqws2-stage/global-enabled";
const MANUAL_STOPPED: &str = "/opt/etc/xkeen/nfqws2-stage/manual-stopped";
static SETTINGS_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
static PREVIEW: OnceLock<Mutex<Option<Preview>>> = OnceLock::new();

struct Preview {
    source: String,
    custom: String,
    checked_at: Instant,
    report: Value,
    mode: String,
    args: String,
}
const YOUTUBE: &str = "https://www.youtube.com/generate_204";
const TCP_LUA: [&str; 2] = [
    "--lua-desync=fake:blob=tls_clienthello:tls_mod=rnd,dupsid,sni=fonts.google.com:tcp_seq=10000:strategy=1",
    "--lua-desync=multisplit:pos=1,midsld:seqovl=1:seqovl_pattern=tls_clienthello:tcp_ts_up:strategy=1",
];
const QUIC_LUA: &str = "--lua-desync=fake:blob=quic_initial:repeats=11";

fn active_source(custom: &str) -> &'static str {
    if custom.trim().is_empty() { "preset" }
    else if Path::new(AUTO_SELECTION).exists() { "preset" }
    else { "custom" }
}

fn preset_args(variant: usize, mode: &str) -> String {
    let mut lines = vec!["--filter-tcp=443", "--payload=tls_client_hello"];
    match variant {
        1 => lines.push(TCP_LUA[0]),
        2 => lines.push(TCP_LUA[1]),
        _ => lines.extend(TCP_LUA),
    }
    if mode == "tcp-quic" {
        lines.extend(["--new", "--filter-udp=443", "--payload=quic_initial", QUIC_LUA]);
    }
    format!("{}\n", lines.join("\n"))
}

fn profile() -> String {
    if let Ok(custom) = std::fs::read_to_string(CUSTOM) {
        if !custom.trim().is_empty() {
            return if custom.lines().any(|line| line.trim() == "--filter-udp=443") { "tcp-quic" } else { "tcp" }.into();
        }
    }
    std::fs::read_to_string(PROFILE).unwrap_or_else(|_| "tcp-quic".into()).trim().into()
}

fn strategy_key(source: &str, mode: &str, custom: &str) -> String {
    format!("{:x}", md5::compute(format!("{source}\n{mode}\n{custom}")))
}

fn active_check() -> Option<Value> {
    let custom = std::fs::read_to_string(CUSTOM).unwrap_or_default();
    let source = active_source(&custom);
    let key = strategy_key(source, &profile(), &custom);
    let value = std::fs::read_to_string(LAST_CHECK).ok()
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())?;
    let fresh = value.get("checkedAt").and_then(Value::as_str)
        .and_then(|stamp| chrono::DateTime::parse_from_rfc3339(stamp).ok())
        .is_some_and(|stamp| {
            let age = chrono::Utc::now().signed_duration_since(stamp);
            age.num_seconds() >= 0 && age.num_minutes() < 30
        });
    (fresh && value.get("strategyKey").and_then(Value::as_str) == Some(key.as_str())).then_some(value)
}

fn settings_json() -> Value {
    let mode = profile();
    let custom_args = std::fs::read_to_string(CUSTOM).unwrap_or_default();
    let config = std::fs::read_to_string(XRAY_CONFIG).ok()
        .and_then(|text| serde_json::from_str::<Value>(&text).ok());
    let global_ready = Path::new(GLOBAL_ENABLED).exists() && config.as_ref()
        .and_then(|config| config.get("outbounds").and_then(Value::as_array))
        .is_some_and(|outbounds| outbounds.iter().any(|outbound| {
            outbound.get("tag").and_then(Value::as_str) == Some("nfqws-direct")
                && outbound.pointer("/streamSettings/sockopt/mark").and_then(Value::as_u64) == Some(832)
        }));
    json!({
        "mode": mode,
        "source": active_source(&custom_args),
        "customArgs": custom_args,
        "strategyName": format!("{} · {}", if active_source(&custom_args) == "preset" { "Автоподбор" } else { "Своя" }, if mode == "tcp" { "TCP" } else { "TCP + QUIC" }),
        "tcpLua": if custom_args.trim().is_empty() { TCP_LUA.to_vec() } else { custom_args.lines().filter(|line| line.starts_with("--lua-desync=") && !line.contains("quic_initial")).collect::<Vec<_>>() },
        "quicLua": QUIC_LUA,
        "lastCheck": active_check(),
        "globalReady": global_ready,
        "scope": if global_ready {
            "В селекторах выберите nfqws2 для нужных маршрутов. Они пойдут напрямую с обходом DPI; прочие маршруты останутся как настроены."
        } else {
            "Прямой выход nfqws2 в Xray ещё не включён."
        }
    })
}

fn selected_for_canary(config: &Value) -> Result<bool, String> {
    let mut selected = false;
    for rule in config.pointer("/routing/rules").and_then(Value::as_array).into_iter().flatten() {
        let Some(tag) = rule.get("ruleTag").and_then(Value::as_str) else { continue };
        if !tag.ends_with("|nfqws2") { continue }
        if tag != "device:192.168.0.130:VPN|nfqws2" || rule.get("outboundTag").and_then(Value::as_str) != Some("direct") {
            return Err("Пробный nfqws2 разрешён только как прямой маршрут устройства 192.168.0.130".into());
        }
        selected = true;
    }
    Ok(selected)
}

async fn run_canary(action: &str) -> Result<(), String> {
    if !Path::new(CANARY).exists() { return Err("Пробный сервис nfqws2 не установлен".into()); }
    let output = tokio::time::timeout(std::time::Duration::from_secs(15), Command::new(CANARY).arg(action).output()).await
        .map_err(|_| "nfqws2 не ответил за 15 секунд".to_string())?
        .map_err(|e| e.to_string())?;
    if output.status.success() { Ok(()) }
    else { Err(String::from_utf8_lossy(&output.stderr).trim().to_string()) }
}

pub async fn sync_for_config(config: &Value) -> Result<(), String> {
    if !Path::new(MANUAL_STOPPED).exists() && (selected_for_canary(config)? || Path::new(GLOBAL_ENABLED).exists()) { run_canary("start").await? }
    Ok(())
}

pub fn start_reconciler() {
    tokio::spawn(async {
        let mut interval = tokio::time::interval(Duration::from_secs(15));
        loop {
            interval.tick().await;
            if !Path::new(GLOBAL_ENABLED).exists() || Path::new(MANUAL_STOPPED).exists() || !Path::new(CANARY).exists() { continue; }
            let _guard = SETTINGS_LOCK.get_or_init(|| Mutex::new(())).lock().await;
            let status = status_json().await;
            if status["running"] != true { _ = run_canary("start").await; }
        }
    });
    tokio::spawn(async {
        let mut failures = 0u8;
        loop {
            tokio::time::sleep(Duration::from_secs(600)).await;
            if !Path::new(AUTO_SELECTION).exists() || Path::new(MANUAL_STOPPED).exists() { failures = 0; continue; }
            let _guard = SETTINGS_LOCK.get_or_init(|| Mutex::new(())).lock().await;
            if status_json().await["running"] != true { continue; }
            let current_mode = profile();
            let current_args = std::fs::read_to_string(CUSTOM).unwrap_or_default();
            let healthy = match run_probe("preset", &current_mode, &current_args).await {
                Ok(report) => {
                    _ = persist_check(&report).await;
                    healthy_report(&report, &current_mode)
                }
                Err(_) => false,
            };
            if healthy { failures = 0; continue; }
            failures += 1;
            if failures < 2 { continue; }
            failures = 0;
            let Ok((report, next_mode, next_args)) = scan_preset().await else { continue; };
            if !healthy_report(&report, &next_mode) || (next_mode == current_mode && next_args == current_args) { continue; }
            _ = apply_checked(&next_mode, &next_args, true, &report).await;
        }
    });
}

pub async fn sync_transition(previous: &Value, next: &Value) -> Result<(), String> {
    if Path::new(MANUAL_STOPPED).exists() { return Ok(()); }
    let old = selected_for_canary(previous)?;
    let new = selected_for_canary(next)?;
    if new { run_canary("start-trial").await? }
    else if old { run_canary("stop-trial").await? }
    Ok(())
}

async fn status_json() -> Value {
    let installed = Path::new(ENGINE).exists() && Path::new(CANARY).exists();
    let mode = profile();
    let report = if installed {
        Command::new(CANARY).arg("status").output().await.ok()
            .filter(|output| output.status.success())
            .map(|output| String::from_utf8_lossy(&output.stdout).into_owned())
            .unwrap_or_default()
    } else { String::new() };
    let global = report.contains("tcp global queue active")
        && (mode == "tcp" || report.contains("udp global queue active"));
    let trial = report.contains("tcp trial queue active")
        && (mode == "tcp" || report.contains("udp trial queue active"));
    let running = report.starts_with("running") && (global || trial);
    let check = active_check();
    let verified = if running { check.as_ref().and_then(|value| value.get("verifiedTransport")).and_then(Value::as_str).unwrap_or("unmeasured") } else { "unmeasured" };
    json!({
        "installed": installed,
        "running": running,
        "mode": if global { "global" } else { "canary" },
        "strategyMode": mode,
        "verifiedTransport": verified,
        "lastCheck": check,
        "device": "192.168.0.130",
        "scope": if global { "Трафик выбранных маршрутов идёт напрямую через nfqws2; остальные маршруты не меняются" }
            else { "Пробный прямой выход только для 192.168.0.130" },
    })
}

pub async fn get_settings(State(_state): State<AppState>) -> Json<Value> {
    Json(settings_json())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsRequest { source: String, custom_args: String }

fn candidate(request: &SettingsRequest) -> Result<(String, String), String> {
    if !matches!(request.source.as_str(), "preset" | "custom") {
        return Err("Неизвестный источник стратегии".into());
    }
    if request.source == "preset" { return Ok((std::fs::read_to_string(PROFILE).unwrap_or_else(|_| "tcp-quic".into()).trim().into(), String::new())); }
    let lines: Vec<&str> = request.custom_args.lines().map(str::trim)
        .filter(|line| !line.is_empty()).collect();
    if lines.is_empty() || lines.len() > 32 || request.custom_args.len() > 4096
        || !lines.iter().any(|line| *line == "--filter-tcp=443")
        || !lines.iter().any(|line| line.starts_with("--lua-desync="))
        || lines.iter().any(|line| line.len() > 1024 || line.bytes().any(|byte| byte.is_ascii_whitespace() || byte < 33 || byte > 126)
            || !matches!(*line, "--new" | "--filter-tcp=443" | "--filter-udp=443" | "--payload=tls_client_hello" | "--payload=quic_initial")
                && !line.starts_with("--lua-desync=")) {
        return Err("Укажите до 32 отдельных параметров nfqws2; нужны TCP/443 и --lua-desync, без пробелов и команд оболочки".into());
    }
    let custom = format!("{}\n", lines.join("\n"));
    let mode = if lines.contains(&"--filter-udp=443") { "tcp-quic" } else { "tcp" };
    Ok((mode.into(), custom))
}

async fn run_probe(source: &str, mode: &str, custom: &str) -> Result<Value, String> {
    if !Path::new(PROBE).exists() || !Path::new(PROBE_SCRIPT).exists() {
        return Err("Проверка TCP/HTTP3 ещё не установлена".into());
    }
    tokio::fs::write(PROBE_CANDIDATE, custom).await.map_err(|e| e.to_string())?;
    tokio::fs::set_permissions(PROBE_CANDIDATE, std::fs::Permissions::from_mode(0o600)).await.map_err(|e| e.to_string())?;
    let script_source = if custom.trim().is_empty() { "preset" } else { "custom" };
    let output = tokio::time::timeout(Duration::from_secs(105), Command::new(PROBE_SCRIPT)
        .args(["check", script_source, mode, PROBE_CANDIDATE]).kill_on_drop(true).output()).await;
    _ = tokio::fs::remove_file(PROBE_CANDIDATE).await;
    let output = match output {
        Ok(Ok(output)) => output,
        Ok(Err(error)) => return Err(format!("Не удалось запустить проверку: {error}")),
        Err(_) => {
            _ = Command::new(PROBE_SCRIPT).arg("cleanup").output().await;
            return Err("Проверка превысила 105 секунд".into());
        }
    };
    if !output.status.success() {
        return Err(format!("Проверка не запустилась: {}", String::from_utf8_lossy(&output.stderr).trim()));
    }
    let results: Vec<Value> = String::from_utf8_lossy(&output.stdout).lines()
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .filter(|item| item.get("protocol").and_then(Value::as_str).is_some_and(|protocol| matches!(protocol, "tcp" | "h3")))
        .collect();
    if results.len() < 3 { return Err("Проверка не вернула результаты сайтов".into()); }
    let tcp_working = results.iter().any(|item| item["protocol"] == "tcp" && item["ok"] == true);
    let quic_working = results.iter().any(|item| item["protocol"] == "h3" && item["ok"] == true);
    Ok(json!({
        "success": true,
        "source": source,
        "mode": mode,
        "strategyKey": strategy_key(source, mode, custom),
        "checkedAt": chrono::Utc::now().to_rfc3339(),
        "tcpWorking": tcp_working,
        "quicWorking": quic_working,
        "verifiedTransport": if tcp_working && quic_working { "tcp-quic" } else if tcp_working { "tcp" } else { "none" },
        "results": results,
    }))
}

fn healthy_report(report: &Value, mode: &str) -> bool {
    let Some(results) = report.get("results").and_then(Value::as_array) else { return false; };
    let tcp_sites = results.iter().filter(|item| item["protocol"] == "tcp" && item["ok"] == true).count();
    let youtube_h3 = results.iter().any(|item| item["protocol"] == "h3" && item["ok"] == true
        && item["url"].as_str().is_some_and(|url| url.contains("youtube.com")));
    tcp_sites >= 2 && (mode == "tcp" || youtube_h3)
}

async fn scan_preset() -> Result<(Value, String, String), String> {
    let mut best: Option<(i32, Value, String, String)> = None;
    let mut summary = Vec::new();
    for variant in 0..3 {
        for mode in ["tcp-quic", "tcp"] {
            let args = preset_args(variant, mode);
            match run_probe("preset", mode, &args).await {
                Ok(report) => {
                    let tcp = report["results"].as_array().into_iter().flatten()
                        .filter(|item| item["protocol"] == "tcp" && item["ok"] == true).count() as i32;
                    let h3 = report["results"].as_array().into_iter().flatten()
                        .filter(|item| item["protocol"] == "h3" && item["ok"] == true).count() as i32;
                    // Prefer working TCP + HTTP/3, while keeping site coverage in the score.
                    let score = tcp * 10 + h3 * 11;
                    summary.push(json!({"variant": variant, "mode": mode, "tcpSites": tcp, "http3Sites": h3}));
                    if best.as_ref().is_none_or(|(old, _, _, _)| score > *old) {
                        best = Some((score, report, mode.into(), args));
                    }
                }
                Err(error) => summary.push(json!({"variant": variant, "mode": mode, "error": error})),
            }
        }
    }
    let (_, mut report, mode, args) = best.ok_or("Ни один вариант стратегии не удалось проверить")?;
    let selected_variant = (0..3).find(|variant| preset_args(*variant, &mode) == args).unwrap_or(0);
    report["candidates"] = json!(summary);
    report["selectedVariant"] = json!(selected_variant);
    Ok((report, mode, args))
}

async fn persist_check(report: &Value) -> Result<(), String> {
    let next = format!("{LAST_CHECK}.new");
    tokio::fs::write(&next, serde_json::to_vec(report).map_err(|e| e.to_string())?).await.map_err(|e| e.to_string())?;
    tokio::fs::set_permissions(&next, std::fs::Permissions::from_mode(0o600)).await.map_err(|e| e.to_string())?;
    tokio::fs::rename(next, LAST_CHECK).await.map_err(|e| e.to_string())
}

pub async fn check_strategy(State(_state): State<AppState>, Json(request): Json<SettingsRequest>) -> Json<Value> {
    let _guard = SETTINGS_LOCK.get_or_init(|| Mutex::new(())).lock().await;
    if !Path::new(ROOT).is_dir() { return Json(json!({"success": false, "error": "nfqws2 не установлен"})); }
    let (mode, custom) = match candidate(&request) {
        Ok(value) => value,
        Err(error) => return Json(json!({"success": false, "error": error})),
    };
    let checked = if request.source == "preset" { scan_preset().await }
        else { run_probe(&request.source, &mode, &custom).await.map(|report| (report, mode, custom.clone())) };
    match checked {
        Ok((report, selected_mode, selected_args)) => {
            *PREVIEW.get_or_init(|| Mutex::new(None)).lock().await = Some(Preview {
                source: request.source,
                custom,
                checked_at: Instant::now(),
                report: report.clone(),
                mode: selected_mode,
                args: selected_args,
            });
            let active_custom = std::fs::read_to_string(CUSTOM).unwrap_or_default();
            if report["strategyKey"] == strategy_key(active_source(&active_custom), &profile(), &active_custom) {
                _ = persist_check(&report).await;
            }
            Json(report)
        },
        Err(error) => Json(json!({"success": false, "error": error})),
    }
}

async fn write_strategy(mode: &str, custom_args: &str, automatic: bool) -> Result<(), String> {
    let next_profile = format!("{PROFILE}.new");
    let next_custom = format!("{CUSTOM}.new");
    tokio::fs::write(&next_profile, format!("{mode}\n")).await.map_err(|error| error.to_string())?;
    tokio::fs::set_permissions(&next_profile, std::fs::Permissions::from_mode(0o644)).await.map_err(|error| error.to_string())?;
    tokio::fs::write(&next_custom, custom_args).await.map_err(|error| error.to_string())?;
    tokio::fs::set_permissions(&next_custom, std::fs::Permissions::from_mode(0o600)).await.map_err(|error| error.to_string())?;
    tokio::fs::rename(next_profile, PROFILE).await.map_err(|error| error.to_string())?;
    tokio::fs::rename(next_custom, CUSTOM).await.map_err(|error| error.to_string())?;
    if automatic { tokio::fs::write(AUTO_SELECTION, b"auto\n").await.map_err(|error| error.to_string())?; }
    else { _ = tokio::fs::remove_file(AUTO_SELECTION).await; }
    Ok(())
}

async fn apply_checked(next_mode: &str, next_custom: &str, automatic: bool, check: &Value) -> Result<(), String> {
    let old_mode = profile();
    let old_custom = tokio::fs::read_to_string(CUSTOM).await.unwrap_or_default();
    let old_automatic = Path::new(AUTO_SELECTION).exists();
    if old_mode == next_mode && old_custom == next_custom && old_automatic == automatic {
        _ = persist_check(check).await;
        return Ok(());
    }
    let was_running = status_json().await.get("running").and_then(Value::as_bool) == Some(true);
    if let Err(error) = write_strategy(next_mode, next_custom, automatic).await {
        _ = write_strategy(&old_mode, &old_custom, old_automatic).await;
        return Err(format!("Не удалось записать настройки: {error}"));
    }
    if let Err(error) = run_canary("dry-run").await {
        _ = write_strategy(&old_mode, &old_custom, old_automatic).await;
        return Err(format!("Новые параметры не приняты nfqws2: {error}"));
    }
    if was_running {
        if let Err(error) = run_canary("stop").await {
            _ = write_strategy(&old_mode, &old_custom, old_automatic).await;
            return Err(error);
        }
        if let Err(error) = run_canary("start").await {
            _ = write_strategy(&old_mode, &old_custom, old_automatic).await;
            _ = run_canary("start").await;
            return Err(format!("Прежняя стратегия восстановлена: {error}"));
        }
    }
    _ = persist_check(check).await;
    Ok(())
}

pub async fn save_settings(State(_state): State<AppState>, Json(request): Json<SettingsRequest>) -> Json<Value> {
    let _guard = SETTINGS_LOCK.get_or_init(|| Mutex::new(())).lock().await;
    if !Path::new(ROOT).is_dir() {
        return Json(json!({"success": false, "error": "nfqws2 не установлен или неизвестный источник стратегии"}));
    }
    let (mode, custom) = match candidate(&request) {
        Ok(value) => value,
        Err(error) => return Json(json!({"success": false, "error": error})),
    };
    let cached = PREVIEW.get_or_init(|| Mutex::new(None)).lock().await.take()
        .filter(|preview| preview.source == request.source && preview.custom == custom
            && preview.checked_at.elapsed() < Duration::from_secs(300));
    let (check, next_mode, next_custom) = if let Some(preview) = cached {
        (preview.report, preview.mode, preview.args)
    } else if request.source == "preset" {
        match scan_preset().await {
            Ok(result) => result,
            Err(error) => return Json(json!({"success": false, "error": error})),
        }
    } else {
        match run_probe("custom", &mode, &custom).await {
            Ok(report) => (report, mode, custom),
            Err(error) => return Json(json!({"success": false, "error": error})),
        }
    };
    if check["tcpWorking"] != true {
        return Json(json!({"success": false, "error": "Ни одна стратегия не дала ответа по TCP; прежняя сохранена", "check": check}));
    }
    if let Err(error) = apply_checked(&next_mode, &next_custom, request.source == "preset", &check).await {
        return Json(json!({"success": false, "error": error}));
    }
    Json(json!({"success": true, "settings": settings_json(), "status": status_json().await, "check": check}))
}

pub async fn status(State(_state): State<AppState>) -> Json<Value> {
    Json(status_json().await)
}

pub async fn latency_probe() -> Result<u32, &'static str> {
    let status = status_json().await;
    if status["running"] != true || status["mode"] != "global" {
        return Err("nfqws2 остановлен или диагностическая очередь недоступна");
    }
    if !Path::new(PROBE).exists() { return Err("HTTP-проверка nfqws2 не установлена"); }
    let started = tokio::time::Instant::now();
    let output = tokio::time::timeout(Duration::from_secs(14), Command::new(PROBE)
        .args(["-protocol", "tcp", "-mark", "832", "-url", YOUTUBE])
        .kill_on_drop(true).output()).await
        .map_err(|_| "YouTube не ответил через nfqws2")?
        .map_err(|_| "Не удалось запустить HTTP-проверку")?;
    let result: Value = serde_json::from_slice(&output.stdout).map_err(|_| "HTTP-проверка не вернула результат")?;
    if result["ok"] != true { return Err("YouTube не ответил через nfqws2"); }
    Ok(started.elapsed().as_millis().min(u32::MAX as u128) as u32)
}

#[derive(Deserialize)]
pub struct ControlRequest { action: String }

pub async fn control(State(_state): State<AppState>, Json(request): Json<ControlRequest>) -> Json<Value> {
    let _guard = SETTINGS_LOCK.get_or_init(|| Mutex::new(())).lock().await;
    if !matches!(request.action.as_str(), "start" | "stop") {
        return Json(json!({"success": false, "error": "Допустимы только start и stop"}));
    }
    if request.action == "stop" {
        if let Err(error) = tokio::fs::write(MANUAL_STOPPED, b"stopped by user\n").await {
            return Json(json!({"success": false, "error": error.to_string()}));
        }
    } else { _ = tokio::fs::remove_file(MANUAL_STOPPED).await; }
    match run_canary(&request.action).await {
        Ok(()) => Json(json!({"success": true, "status": status_json().await})),
        Err(error) => Json(json!({"success": false, "error": error})),
    }
}
