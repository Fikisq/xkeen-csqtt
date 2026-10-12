use crate::{controller, csqtt, nfqws2, types::AppState, wdtt_plus};
use axum::{extract::State, Json};
use serde_json::{json, Value};
use std::{os::unix::fs::PermissionsExt, path::Path, sync::OnceLock};
use tokio::{fs, sync::Semaphore};

const RESUME: &str = "/opt/etc/xkeen-ui/stopped-services.json";
static GATE: OnceLock<Semaphore> = OnceLock::new();

async fn addon(state: &AppState, name: &str, action: &str) -> Result<(), String> {
    let result = match name {
        "csqtt" => csqtt::control(Json(csqtt::ControlRequest { action: action.into() })).await.0,
        "wdtt-plus" => wdtt_plus::control(Json(wdtt_plus::ControlRequest { action: action.into() })).await.0,
        "nfqws2" => nfqws2::control(State(state.clone()), Json(nfqws2::ControlRequest { action: action.into() })).await.0,
        _ => return Err("Неизвестный сервис".into()),
    };
    if result["success"] == true { Ok(()) }
    else { Err(format!("{name}: {}", result["error"].as_str().unwrap_or("ошибка управления"))) }
}

// Older XKeen init scripts skip firewall cleanup when the core has already crashed.
async fn ensure_stop_cleanup(state: &AppState) -> Result<(), String> {
    let path = controller::resolve_init_file(state).await?;
    let content = fs::read_to_string(&path).await.map_err(|e| e.to_string())?;
    if !content.contains("proxy_stop() {") { return Ok(()); }
    let old = "    rm -f \"/tmp/xkeen_ready\"\n    if ! proxy_status; then";
    if !content.contains(old) { return Ok(()); }
    let updated = content.replacen(old, "    rm -f \"/tmp/xkeen_ready\"\n    clean_firewall\n    if ! proxy_status; then", 1);
    let permissions = fs::metadata(&path).await.map_err(|e| e.to_string())?.permissions();
    let temp = format!("{path}.ui-stop-new");
    fs::write(&temp, updated).await.map_err(|e| e.to_string())?;
    fs::set_permissions(&temp, permissions).await.map_err(|e| e.to_string())?;
    fs::rename(&temp, &path).await.map_err(|e| e.to_string())
}

pub async fn control(state: &AppState, start: bool) -> Result<(), String> {
    let _permit = GATE.get_or_init(|| Semaphore::new(1)).try_acquire()
        .map_err(|_| "Общее управление сервисами уже выполняется")?;
    if start {
        let core = state.core.read().unwrap().name.clone();
        controller::check_core_config(&core).await?;
        let saved: Vec<String> = match fs::read(&RESUME).await {
            Ok(bytes) => serde_json::from_slice(&bytes).map_err(|_| "Не удалось прочитать список остановленных сервисов")?,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Vec::new(),
            Err(e) => return Err(e.to_string()),
        };
        for name in &saved { addon(state, name, "start").await?; }
        controller::run_init_command(state, &["start", "on"]).await?;
        if Path::new(RESUME).exists() { fs::remove_file(RESUME).await.map_err(|e| e.to_string())?; }
        return Ok(());
    }

    let services = [("csqtt", "/opt/etc/init.d/S99csqtt"),
        ("wdtt-plus", "/opt/etc/init.d/S99wdtt-plus"),
        ("nfqws2", "/opt/etc/init.d/S98nfqws2-xkeen")];
    let mut saved: Vec<String> = if Path::new(RESUME).exists() {
        serde_json::from_slice(&fs::read(RESUME).await.map_err(|e| e.to_string())?)
            .map_err(|_| "Не удалось прочитать список остановленных сервисов")?
    } else { Vec::new() };
    for (name, path) in services {
        if !Path::new(path).is_file() { continue; }
        let status: Value = match name {
            "csqtt" => csqtt::status().await.0,
            "wdtt-plus" => wdtt_plus::status().await.0,
            _ => nfqws2::status(State(state.clone())).await.0,
        };
        if (status["running"] == true || (name == "csqtt" && csqtt::starter_running()))
            && !saved.iter().any(|item| item == name) { saved.push(name.into()); }
    }
    fs::create_dir_all("/opt/etc/xkeen-ui").await.map_err(|e| e.to_string())?;
    let temp = format!("{RESUME}.new");
    fs::write(&temp, serde_json::to_vec(&json!(saved)).unwrap()).await.map_err(|e| e.to_string())?;
    fs::set_permissions(&temp, std::fs::Permissions::from_mode(0o600)).await.map_err(|e| e.to_string())?;
    fs::rename(&temp, RESUME).await.map_err(|e| e.to_string())?;
    let mut errors = Vec::new();
    if let Err(e) = ensure_stop_cleanup(state).await { errors.push(e); }
    // Restore ordinary forwarding first, then close tunnels and VK calls gracefully.
    if let Err(e) = controller::run_init_command(state, &["stop"]).await { errors.push(e); }
    for (name, path) in services {
        if Path::new(path).is_file() {
            if let Err(e) = addon(state, name, "stop").await { errors.push(e); }
        }
    }
    let core = state.core.read().unwrap().name.clone();
    if !controller::get_pid(&core).is_empty() { errors.push(format!("{core} продолжает работать")); }
    if csqtt::status().await.0["running"] == true || csqtt::starter_running() {
        errors.push("CSQTT продолжает работать".into());
    }
    if wdtt_plus::status().await.0["running"] == true { errors.push("WDTT Plus продолжает работать".into()); }
    if nfqws2::status(State(state.clone())).await.0["running"] == true { errors.push("nfqws2 продолжает работать".into()); }
    if errors.is_empty() { Ok(()) } else { Err(errors.join("; ")) }
}
