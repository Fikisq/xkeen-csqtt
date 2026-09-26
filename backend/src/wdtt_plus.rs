use axum::{extract::State, response::Json};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{path::Path, sync::{OnceLock, atomic::{AtomicU64, Ordering}}, time::Duration};
use tokio::{io::AsyncWriteExt, sync::Semaphore};

use crate::types::AppState;

const DIR: &str = "/opt/etc/wdtt-plus";
const CONFIG: &str = "/opt/etc/wdtt-plus/wdtt-plus.conf";
const PASSWORD: &str = "/opt/etc/wdtt-plus/password";
const TOKEN: &str = "/opt/etc/wdtt-plus/vk_token";
const SERVICE: &str = "/opt/etc/init.d/S99wdtt-plus";

fn value(content: &str, key: &str) -> Option<String> {
    content.lines().find_map(|line| {
        let raw = line.strip_prefix(&format!("{key}="))?.trim();
        Some(raw.trim_matches(['\'', '"']).to_string())
    })
}

fn quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

fn secret_exists(path: &str) -> bool {
    std::fs::metadata(path).is_ok_and(|meta| meta.len() > 0)
}

async fn write_private(path: &str, value: &str) -> std::io::Result<()> {
    static NEXT_TEMP: AtomicU64 = AtomicU64::new(0);
    let temp = format!("{path}.tmp.{}.{}", std::process::id(), NEXT_TEMP.fetch_add(1, Ordering::Relaxed));
    let result = async {
        let mut file = tokio::fs::OpenOptions::new().write(true).create_new(true)
            .mode(0o600).open(&temp).await?;
        file.write_all(value.as_bytes()).await?;
        file.sync_all().await?;
        drop(file);
        tokio::fs::rename(&temp, path).await
    }.await;
    if result.is_err() { let _ = tokio::fs::remove_file(&temp).await; }
    result
}

pub async fn settings() -> Json<Value> {
    let content = tokio::fs::read_to_string(CONFIG).await.unwrap_or_default();
    let peer = value(&content, "PEER").unwrap_or_default();
    let (server, dtls_port) = peer.rsplit_once(':').unwrap_or(("", ""));
    Json(json!({
        "success": true,
        "server": server,
        "dtlsPort": dtls_port.parse::<u16>().ok(),
        "wgPort": value(&content, "WG_PORT").and_then(|v| v.parse::<u16>().ok()),
        "workers": value(&content, "WORKERS").and_then(|v| v.parse::<u32>().ok()).unwrap_or(27),
        "tokenSource": value(&content, "VK_TOKEN_SOURCE").unwrap_or_else(|| "own".into()),
        "hashMode": value(&content, "VK_HASH_MODE").unwrap_or_else(|| "auto".into()),
        "hashesCount": value(&content, "VK_HASHES_COUNT").and_then(|v| v.parse::<u32>().ok()).unwrap_or(4),
        "hasManualHashes": value(&content, "VK_HASHES").is_some_and(|v| !v.is_empty()),
        "hasPassword": secret_exists(PASSWORD),
        "hasOwnToken": secret_exists(TOKEN),
        "hasCsqttToken": secret_exists("/opt/etc/csqtt/vk_token"),
        "rtNetwork": value(&content, "RT_NETWORK").as_deref() == Some("1"),
        "turnSni": value(&content, "TURN_SNI").unwrap_or_default(),
        "rtMasque": value(&content, "RT_MASQUE").as_deref() == Some("1"),
        "rtMasqueAcceptTos": value(&content, "RT_MASQUE_ACCEPT_TOS").as_deref() == Some("1"),
    }))
}

#[derive(Deserialize)]
pub struct SettingsRequest {
    server: String,
    #[serde(rename = "dtlsPort")]
    dtls_port: u16,
    #[serde(rename = "wgPort")]
    wg_port: u16,
    workers: u32,
    #[serde(rename = "tokenSource")]
    token_source: String,
    #[serde(rename = "hashMode")]
    hash_mode: Option<String>,
    #[serde(rename = "hashesCount")]
    hashes_count: Option<u32>,
    #[serde(rename = "manualHashes")]
    manual_hashes: Option<String>,
    password: Option<String>,
    #[serde(rename = "vkToken")]
    vk_token: Option<String>,
    #[serde(rename = "rtNetwork")]
    rt_network: Option<bool>,
    #[serde(rename = "turnSni")]
    turn_sni: Option<String>,
    #[serde(rename = "rtMasque")]
    rt_masque: Option<bool>,
    #[serde(rename = "rtMasqueAcceptTos")]
    rt_masque_accept_tos: Option<bool>,
}

pub async fn save_settings(State(_state): State<AppState>, Json(request): Json<SettingsRequest>) -> Json<Value> {
    static SAVE_GATE: OnceLock<Semaphore> = OnceLock::new();
    let gate = SAVE_GATE.get_or_init(|| Semaphore::new(1));
    let Ok(_permit) = gate.try_acquire() else {
        return Json(json!({"success": false, "error": "Сохранение WDTT Plus уже выполняется"}));
    };
    let server = request.server.trim();
    if server.is_empty() || server.len() > 253
        || !server.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '[' | ']' | ':'))
        || request.dtls_port == 0 || request.wg_port == 0 {
        return Json(json!({"success": false, "error": "Укажите допустимый сервер и порты WDTT Plus"}));
    }
    if !(9..=108).contains(&request.workers) || request.workers % 9 != 0 {
        return Json(json!({"success": false, "error": "Потоки WDTT Plus: от 9 до 108, шаг 9"}));
    }
    if !matches!(request.token_source.as_str(), "own" | "csqtt") {
        return Json(json!({"success": false, "error": "Недопустимый источник VK-токена"}));
    }
    let hash_mode = request.hash_mode.as_deref().unwrap_or("auto");
    let hashes_count = request.hashes_count.unwrap_or(4);
    if !matches!(hash_mode, "auto" | "manual") || !(1..=4).contains(&hashes_count) {
        return Json(json!({"success": false, "error": "Недопустимый режим или число хешей WDTT Plus"}));
    }
    let existing = tokio::fs::read_to_string(CONFIG).await.unwrap_or_default();
    let input_hashes = request.manual_hashes.as_deref().unwrap_or("").trim();
    if input_hashes.len() > 4096 {
        return Json(json!({"success": false, "error": "Слишком длинный список хешей VK"}));
    }
    let parsed: Vec<_> = input_hashes.split([',', '\n', '\r']).map(str::trim).filter(|item| !item.is_empty()).collect();
    if parsed.len() > 4 || parsed.iter().any(|item| item.chars().any(|c| c.is_whitespace() || c == '\'' || c == '\0')) {
        return Json(json!({"success": false, "error": "Укажите до 4 ссылок или хешей VK"}));
    }
    let manual_hashes = if parsed.is_empty() { value(&existing, "VK_HASHES").unwrap_or_default() } else { parsed.join(",") };
    if hash_mode == "manual" && manual_hashes.split(',').count() != hashes_count as usize {
        return Json(json!({"success": false, "error": "Число ручных хешей должно совпадать с выбранным количеством"}));
    }
    let password = request.password.as_deref().unwrap_or("");
    if password.len() > 512 || password.chars().any(|c| matches!(c, '\0' | '\r' | '\n')) {
        return Json(json!({"success": false, "error": "Недопустимый пароль WDTT Plus"}));
    }
    let token = request.vk_token.as_deref().unwrap_or("").trim();
    if token.len() > 4096 || (!token.is_empty() && !token.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))) {
        return Json(json!({"success": false, "error": "Вставьте только значение VK access_token"}));
    }
    let rt_network = request.rt_network.unwrap_or(false);
    let normalized_sni = request.turn_sni.as_deref().unwrap_or("").trim().to_ascii_lowercase();
    let turn_sni = normalized_sni.as_str();
    let rt_masque = request.rt_masque.unwrap_or(false);
    let rt_masque_accept_tos = request.rt_masque_accept_tos.unwrap_or(false);
    // The client exits instead of falling back when the SNI is an IP address or
    // has fewer than two labels, so those values must be refused here.
    if !turn_sni.is_empty() && (turn_sni.len() > 253
        || turn_sni.split('.').count() < 2
        || turn_sni.split('.').all(|part| !part.is_empty() && part.chars().all(|c| c.is_ascii_digit()))
        || turn_sni.split('.').any(|part| part.is_empty() || part.len() > 63 || part.starts_with('-') || part.ends_with('-'))
        || !turn_sni.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '.' | '-'))) {
        return Json(json!({"success": false, "error": "Укажите доменное имя SNI для Сети РТ, например example.com"}));
    }
    if rt_masque && (!rt_network || !rt_masque_accept_tos) {
        return Json(json!({"success": false, "error": "Для MASQUE включите Сеть РТ и подтвердите условия Cloudflare WARP"}));
    }
    if let Err(error) = tokio::fs::create_dir_all(DIR).await {
        return Json(json!({"success": false, "error": format!("Не удалось создать каталог WDTT Plus: {error}")}));
    }
    let config = format!(
        "PEER={}\nWG_PORT={}\nWORKERS={}\nVK_TOKEN_SOURCE={}\nVK_HASH_MODE={}\nVK_HASHES_COUNT={}\nVK_HASHES={}\nRT_NETWORK={}\nTURN_SNI={}\nRT_MASQUE={}\nRT_MASQUE_ACCEPT_TOS={}\n",
        quote(&format!("{server}:{}", request.dtls_port)),
        quote(&request.wg_port.to_string()),
        quote(&request.workers.to_string()),
        quote(&request.token_source),
        quote(hash_mode),
        quote(&hashes_count.to_string()),
        quote(&manual_hashes),
        quote(if rt_network { "1" } else { "0" }),
        quote(turn_sni),
        quote(if rt_masque { "1" } else { "0" }),
        quote(if rt_masque_accept_tos { "1" } else { "0" }),
    );
    if let Err(error) = write_private(CONFIG, &config).await {
        return Json(json!({"success": false, "error": format!("Не удалось сохранить WDTT Plus: {error}")}));
    }
    if !password.is_empty() {
        if let Err(error) = write_private(PASSWORD, password).await {
            return Json(json!({"success": false, "error": format!("Не удалось сохранить пароль WDTT Plus: {error}")}));
        }
    }
    if !token.is_empty() {
        if let Err(error) = write_private(TOKEN, token).await {
            return Json(json!({"success": false, "error": format!("Не удалось сохранить VK-токен: {error}")}));
        }
    }
    Json(json!({"success": true, "restartRequired": true}))
}

fn service_pid() -> Option<u32> {
    std::fs::read_to_string("/var/run/wdtt-plus.pid").ok()?.trim().parse().ok()
}

fn running() -> bool {
    service_pid().is_some_and(|pid| {
        std::fs::read(format!("/proc/{pid}/cmdline")).is_ok_and(|command| {
            command.split(|byte| *byte == 0).any(|arg| {
                arg.ends_with(b"/wdtt-plus-client") || arg.ends_with(b"/wdtt-plus-run.sh")
            })
        })
    })
}

fn health_age_seconds() -> Option<u64> {
    let checked = std::fs::read_to_string("/var/run/wdtt-plus-health").ok()?.trim().parse::<u64>().ok()?;
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).ok()?.as_secs();
    Some(now.saturating_sub(checked))
}

pub async fn status() -> Json<Value> {
    let installed = Path::new("/opt/etc/wdtt-plus/wdtt-plus-client").is_file() && Path::new(SERVICE).is_file();
    let running = running();
    let health_age = health_age_seconds();
    let ready = running && health_age.is_some_and(|age| age <= 90);
    let attached = std::fs::read_to_string("/opt/etc/xray/configs/00_config.json").ok()
        .and_then(|content| serde_json::from_str::<Value>(&content).ok())
        .and_then(|config| config.get("outbounds")?.as_array().cloned())
        .is_some_and(|outbounds| outbounds.iter().any(|item| item.get("tag").and_then(Value::as_str) == Some("wdtt-plus")));
    Json(json!({"installed": installed, "running": running, "ready": ready, "attached": attached, "healthAgeSeconds": health_age, "proxy": "127.0.0.1:1088", "clientVersion": "v18"}))
}

#[derive(Deserialize)]
pub struct ControlRequest { action: String }

pub async fn control(Json(request): Json<ControlRequest>) -> Json<Value> {
    static CONTROL_GATE: OnceLock<Semaphore> = OnceLock::new();
    let gate = CONTROL_GATE.get_or_init(|| Semaphore::new(1));
    let Ok(_permit) = gate.try_acquire() else {
        return Json(json!({"success": false, "error": "Управление WDTT Plus уже выполняется"}));
    };
    if !matches!(request.action.as_str(), "start" | "stop" | "restart") {
        return Json(json!({"success": false, "error": "Недопустимое действие WDTT Plus"}));
    }
    if !Path::new(SERVICE).is_file() {
        return Json(json!({"success": false, "error": "WDTT Plus не установлен"}));
    }
    if request.action != "stop" {
        let content = tokio::fs::read_to_string(CONFIG).await.unwrap_or_default();
        let source = value(&content, "VK_TOKEN_SOURCE").unwrap_or_else(|| "own".into());
        let token_path = if source == "csqtt" { "/opt/etc/csqtt/vk_token" } else { TOKEN };
        let hash_mode = value(&content, "VK_HASH_MODE").unwrap_or_else(|| "auto".into());
        let has_hashes = value(&content, "VK_HASHES").is_some_and(|v| !v.is_empty());
        if !secret_exists(PASSWORD) || (hash_mode == "auto" && !secret_exists(token_path))
            || (hash_mode == "manual" && !has_hashes) || value(&content, "PEER").is_none() {
            return Json(json!({"success": false, "error": "Сохраните сервер, пароль и VK-токен перед запуском WDTT Plus"}));
        }
    }
    let result = tokio::time::timeout(Duration::from_secs(420),
        tokio::process::Command::new(SERVICE).arg(&request.action)
            .kill_on_drop(true).output()).await;
    match result {
        Ok(Ok(result)) if result.status.success() => Json(json!({"success": true})),
        Ok(Ok(result)) => Json(json!({"success": false, "error": String::from_utf8_lossy(&result.stderr).trim()})),
        Ok(Err(error)) => Json(json!({"success": false, "error": format!("Ошибка WDTT Plus: {error}")})),
        Err(_) => Json(json!({"success": false, "error": "Управление WDTT Plus превысило 7 минут; проверьте состояние сервиса"})),
    }
}

pub async fn attach_xray(State(state): State<AppState>) -> Json<Value> {
    const XRAY_CONFIG: &str = "/opt/etc/xray/configs/00_config.json";
    if !running() {
        return Json(json!({"success": false, "error": "Сначала запустите WDTT Plus"}));
    }
    let Ok(content) = tokio::fs::read_to_string(XRAY_CONFIG).await else {
        return Json(json!({"success": false, "error": "Конфигурация Xray не найдена"}));
    };
    let Ok(mut config) = serde_json::from_str::<Value>(&content) else {
        return Json(json!({"success": false, "error": "Конфигурация Xray не является JSON"}));
    };
    let Some(outbounds) = config.get_mut("outbounds").and_then(Value::as_array_mut) else {
        return Json(json!({"success": false, "error": "В конфигурации Xray нет массива outbounds"}));
    };
    if let Some(existing) = outbounds.iter().find(|item| item.get("tag").and_then(Value::as_str) == Some("wdtt-plus")) {
        let expected = json!({"tag":"wdtt-plus","protocol":"socks","settings":{"servers":[{"address":"127.0.0.1","port":1088}]}});
        if *existing == expected { return Json(json!({"success": true, "alreadyAttached": true})); }
        return Json(json!({"success": false, "error": "Тег wdtt-plus уже занят другим outbound"}));
    }
    outbounds.push(json!({"tag":"wdtt-plus","protocol":"socks","settings":{"servers":[{"address":"127.0.0.1","port":1088}]}}));
    let Ok(updated) = serde_json::to_string_pretty(&config) else {
        return Json(json!({"success": false, "error": "Не удалось записать конфигурацию Xray"}));
    };
    let backup = format!("{XRAY_CONFIG}.before-wdtt-plus");
    if write_private(&backup, &content).await.is_err() {
        return Json(json!({"success": false, "error": "Не удалось создать резервную копию Xray"}));
    }
    let temp = format!("{XRAY_CONFIG}.wdtt.tmp");
    if write_private(&temp, &updated).await.is_err() || tokio::fs::rename(&temp, XRAY_CONFIG).await.is_err() {
        return Json(json!({"success": false, "error": "Не удалось добавить WDTT Plus в Xray"}));
    }
    let xray_active = state.core.read().is_ok_and(|core| core.name == "xray");
    if xray_active {
        let restarted = tokio::time::timeout(
            std::time::Duration::from_secs(90),
            tokio::process::Command::new("/opt/etc/init.d/S05xkeen").args(["restart", "on"]).output(),
        ).await;
        if !matches!(restarted, Ok(Ok(ref output)) if output.status.success()) {
            let _ = write_private(XRAY_CONFIG, &content).await;
            let _ = tokio::process::Command::new("/opt/etc/init.d/S05xkeen").args(["restart", "on"]).output().await;
            return Json(json!({"success": false, "error": "Xray не запустился с WDTT Plus; исходная конфигурация восстановлена"}));
        }
    }
    Json(json!({"success": true, "restarted": xray_active}))
}
