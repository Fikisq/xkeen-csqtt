use axum::response::Json;
use axum::extract::State;
use crate::types::AppState;
use serde_json::{Value, json};
use std::path::Path;
use std::io::{Read, Seek, SeekFrom};
use serde::Deserialize;
use std::sync::{OnceLock, atomic::{AtomicU64, Ordering}};
use tokio::sync::Semaphore;
use tokio::io::AsyncWriteExt;
use std::time::Duration;

const CONFIG: &str = "/opt/etc/csqtt/csqtt.conf";
const VK_TOKEN: &str = "/opt/etc/csqtt/vk_token";
const SPEEDTEST: &str = "/opt/bin/csqtt-speedtest";
static CSQTT_GATE: OnceLock<Semaphore> = OnceLock::new();

fn vk_api_notice(running: bool) -> Option<&'static str> {
    if Path::new("/opt/etc/csqtt/vk_api_calls.uncertain").exists() {
        Some("Результат создания звонка VK неизвестен. Auto API заблокирован до проверки незавершённых звонков.")
    } else if Path::new("/opt/etc/csqtt/vk_api_calls.lock").exists() {
        Some("Выполняется операция VK API. Если сообщение не исчезает после остановки, требуется проверка сервиса.")
    } else if ["/opt/etc/csqtt/vk_api_calls.stale", "/opt/etc/csqtt/vk_api_calls"].iter()
        .enumerate().any(|(index, path)| (index == 0 || !running)
            && std::fs::metadata(path).is_ok_and(|m| m.len() > 0)) {
        Some("Завершение звонков VK не подтверждено. Нажмите «Остановить» для повторной очистки.")
    } else { None }
}

async fn write_private(path: &str, value: &[u8]) -> std::io::Result<()> {
    static NEXT_TEMP: AtomicU64 = AtomicU64::new(0);
    let temp = format!("{path}.tmp.{}.{}", std::process::id(), NEXT_TEMP.fetch_add(1, Ordering::Relaxed));
    let result = async {
        let mut file = tokio::fs::OpenOptions::new().write(true).create_new(true)
            .mode(0o600).open(&temp).await?;
        file.write_all(value).await?;
        file.sync_all().await?;
        drop(file);
        tokio::fs::rename(&temp, path).await
    }.await;
    if result.is_err() { let _ = tokio::fs::remove_file(&temp).await; }
    result
}

pub async fn speedtest() -> Json<Value> {
    static TEST_GATE: OnceLock<Semaphore> = OnceLock::new();
    let gate = TEST_GATE.get_or_init(|| Semaphore::new(1));
    let Ok(_permit) = gate.try_acquire() else {
        return Json(json!({"success": false, "error": "Замер CSQTT уже выполняется"}));
    };
    if !Path::new(SPEEDTEST).is_file() || !Path::new("/sys/class/net/csqtt0").exists() {
        return Json(json!({"success": false, "error": "Запустите CSQTT перед замером скорости"}));
    }
    let result = tokio::time::timeout(Duration::from_secs(120),
        tokio::process::Command::new(SPEEDTEST).kill_on_drop(true).output()).await;
    match result {
        Ok(Ok(output)) if output.status.success() => {
            match serde_json::from_slice::<Value>(&output.stdout) {
                Ok(data) if data.get("downloadMbps").and_then(Value::as_f64).is_some()
                    && data.get("uploadMbps").and_then(Value::as_f64).is_some() =>
                    Json(json!({"success": true, "result": data})),
                _ => Json(json!({"success": false, "error": "Замер вернул неверный формат данных"})),
            }
        }
        Ok(Ok(_)) => Json(json!({"success": false, "error": "Замер не завершился: проверьте состояние туннеля CSQTT"})),
        Ok(Err(_)) => Json(json!({"success": false, "error": "Не удалось запустить замер CSQTT"})),
        Err(_) => Json(json!({"success": false, "error": "Превышено время замера CSQTT"})),
    }
}

fn value(content: &str, key: &str) -> Option<String> {
    content.lines().find_map(|line| {
        let raw = line.strip_prefix(&format!("{key}="))?.trim();
        Some(raw.trim_matches('"').trim_matches('\'').to_string())
    })
}

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

fn number(content: &str, key: &str) -> Option<u32> {
    content.lines().find_map(|line| {
        let value = line.strip_prefix(&format!("{key}="))?;
        value.trim().trim_matches('"').parse().ok()
    })
}

pub async fn settings() -> Json<Value> {
    match tokio::fs::read_to_string(CONFIG).await {
        Ok(content) => Json(json!({
            "success": true,
            "hashes": number(&content, "HASHES"),
            "workers": number(&content, "WORKERS"),
            "peer": value(&content, "PEER"),
            "hashMode": value(&content, "VK_HASH_MODE").unwrap_or_else(|| "auto_js".into()),
            "obfs": value(&content, "OBFS").unwrap_or_else(|| "audio".into()),
            "turnTransport": value(&content, "TURN_TRANSPORT").unwrap_or_else(|| "udp".into()),
            "hasPassword": value(&content, "PASSWORD").is_some_and(|v| !v.is_empty()),
            "hasVkToken": tokio::fs::metadata(VK_TOKEN).await.is_ok_and(|m| m.len() > 0),
            "hasManualHashes": value(&content, "VK_HASHES").is_some_and(|v| !v.is_empty()),
            "clientVersion": tokio::fs::read_to_string("/opt/etc/csqtt/client-version").await.ok().map(|v| v.trim().to_string()).unwrap_or_else(|| "2.0".into()),
        })),
        Err(_) => Json(json!({ "success": false, "error": "Конфигурация CSQTT не найдена" })),
    }
}

#[derive(Deserialize)]
pub struct SettingsRequest {
    hashes: u32,
    workers: u32,
    peer: Option<String>,
    password: Option<String>,
    #[serde(rename = "vkToken")]
    vk_token: Option<String>,
    #[serde(rename = "hashMode")]
    hash_mode: Option<String>,
    obfs: Option<String>,
    #[serde(rename = "turnTransport")]
    turn_transport: Option<String>,
    #[serde(rename = "manualHashes")]
    manual_hashes: Option<String>,
}

pub async fn save_settings(State(_state): State<AppState>, Json(request): Json<SettingsRequest>) -> Json<Value> {
    let gate = CSQTT_GATE.get_or_init(|| Semaphore::new(1));
    let Ok(_permit) = gate.try_acquire() else {
        return Json(json!({ "success": false, "error": "Сохранение CSQTT уже выполняется" }));
    };
    if !(1..=6).contains(&request.hashes) || !(9..=126).contains(&request.workers) || request.workers % 9 != 0 {
        return Json(json!({ "success": false, "error": "Допустимо 1–6 хешей и 9–126 потоков с шагом 9" }));
    }
    let hash_mode = request.hash_mode.as_deref().unwrap_or("auto_js");
    let obfs = request.obfs.as_deref().unwrap_or("audio");
    let turn_transport = request.turn_transport.as_deref().unwrap_or("udp");
    if !matches!(hash_mode, "manual" | "auto_api" | "auto_js")
        || !matches!(obfs, "audio" | "video")
        || !matches!(turn_transport, "udp" | "tcp_tls") {
        return Json(json!({ "success": false, "error": "Недопустимый режим CSQTT" }));
    }
    let Ok(content) = tokio::fs::read_to_string(CONFIG).await else {
        return Json(json!({ "success": false, "error": "Конфигурация CSQTT не найдена" }));
    };
    if number(&content, "HASHES").is_none() || number(&content, "WORKERS").is_none() {
        return Json(json!({ "success": false, "error": "В конфигурации CSQTT нет параметров HASHES/WORKERS" }));
    }
    let peer = request.peer.as_deref().unwrap_or("").trim();
    if !peer.is_empty() {
        let Some((host, port)) = peer.rsplit_once(':') else {
            return Json(json!({ "success": false, "error": "Адрес CSQTT должен иметь вид сервер:порт" }));
        };
        if host.is_empty() || host.len() > 253 || !host.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '[' | ']' | ':'))
            || port.parse::<u16>().ok().filter(|p| *p > 0).is_none() {
            return Json(json!({ "success": false, "error": "Недопустимый адрес или порт CSQTT" }));
        }
    }
    let password = request.password.as_deref().unwrap_or("");
    if password.len() > 512 || password.chars().any(|c| c == '\n' || c == '\r' || c == '\0') {
        return Json(json!({ "success": false, "error": "Недопустимый пароль CSQTT" }));
    }
    let token = request.vk_token.as_deref().unwrap_or("").trim();
    if !token.is_empty() && (starter_running() || vk_api_notice(false).is_some()) {
        return Json(json!({ "success": false, "error": "Сначала остановите CSQTT и завершите звонки со старым токеном. Замена токена сейчас заблокирована." }));
    }
    if token.len() > 4096 || (!token.is_empty() && !token.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))) {
        return Json(json!({ "success": false, "error": "Вставьте только значение access_token" }));
    }
    if hash_mode != "manual" && token.is_empty() && !tokio::fs::metadata(VK_TOKEN).await.is_ok_and(|m| m.len() > 0) {
        return Json(json!({ "success": false, "error": "Для автоматического режима нужен VK access_token" }));
    }
    let input_hashes = request.manual_hashes.as_deref().unwrap_or("").trim();
    if input_hashes.len() > 4096 { return Json(json!({ "success": false, "error": "Слишком длинный список хешей VK" })); }
    let parsed_hashes: Vec<_> = input_hashes.split([',', '\n', '\r']).map(str::trim).filter(|part| !part.is_empty()).collect();
    if parsed_hashes.len() > 6 || parsed_hashes.iter().any(|hash| hash.chars().any(|c| c.is_whitespace() || c == '\'' || c == '\0')) {
        return Json(json!({ "success": false, "error": "Укажите не более 6 ссылок или хешей VK" }));
    }
    let manual_hashes = if parsed_hashes.is_empty() { value(&content, "VK_HASHES").unwrap_or_default() }
        else { parsed_hashes.join(",") };
    if hash_mode == "manual" && manual_hashes.is_empty() {
        return Json(json!({ "success": false, "error": "Для ручного режима добавьте ссылку или хеш VK" }));
    }
    if (value(&content, "PEER").is_none() && !peer.is_empty()) || (value(&content, "PASSWORD").is_none() && !password.is_empty()) {
        return Json(json!({ "success": false, "error": "В конфигурации CSQTT отсутствуют поля PEER/PASSWORD" }));
    }
    let mut updated = content.lines().map(|line| {
        if line.starts_with("HASHES=") { format!("HASHES=\"{}\"", request.hashes) }
        else if line.starts_with("WORKERS=") { format!("WORKERS=\"{}\"", request.workers) }
        else if line.starts_with("PEER=") && !peer.is_empty() { format!("PEER={}", shell_quote(peer)) }
        else if line.starts_with("PASSWORD=") && !password.is_empty() { format!("PASSWORD={}", shell_quote(password)) }
        else if line.starts_with("VK_MODE=") { format!("VK_MODE=\"{hash_mode}\"") }
        else if line.starts_with("VK_HASH_MODE=") { format!("VK_HASH_MODE=\"{hash_mode}\"") }
        else if line.starts_with("VK_AUTH_MODE=") { format!("VK_AUTH_MODE=\"{}\"", if hash_mode == "auto_js" { "auto_js" } else { "vkcalls" }) }
        else if line.starts_with("OBFS=") { format!("OBFS=\"{obfs}\"") }
        else if line.starts_with("TURN_TRANSPORT=") { format!("TURN_TRANSPORT=\"{turn_transport}\"") }
        else if line.starts_with("VK_HASHES=") { format!("VK_HASHES={}", shell_quote(&manual_hashes)) }
        else { line.to_string() }
    }).collect::<Vec<_>>().join("\n") + "\n";
    if !content.lines().any(|line| line.starts_with("VK_HASHES=")) {
        updated.push_str(&format!("VK_HASHES={}\n", shell_quote(&manual_hashes)));
    }
    let backup = format!("{CONFIG}.codex-prev");
    if write_private(&backup, content.as_bytes()).await.is_err() {
        return Json(json!({ "success": false, "error": "Не удалось создать резервную копию CSQTT" }));
    }
    if let Err(error) = write_private(CONFIG, updated.as_bytes()).await {
        return Json(json!({ "success": false, "error": format!("Не удалось сохранить CSQTT: {error}") }));
    }
    if !token.is_empty() {
        let token_backup = format!("{VK_TOKEN}.codex-prev");
        if let Ok(previous) = tokio::fs::read(VK_TOKEN).await {
            if write_private(&token_backup, &previous).await.is_err() {
                _ = write_private(CONFIG, content.as_bytes()).await;
                return Json(json!({ "success": false, "error": "Не удалось сохранить резервную копию VK-токена" }));
            }
        }
        if write_private(VK_TOKEN, token.as_bytes()).await.is_err() {
            _ = write_private(CONFIG, content.as_bytes()).await;
            return Json(json!({ "success": false, "error": "Не удалось сохранить VK-токен" }));
        }
    }
    Json(json!({ "success": true, "restartRequired": true }))
}

pub async fn restart() -> Json<Value> {
    control(Json(ControlRequest { action: "restart".into() })).await
}

#[derive(Deserialize)]
pub struct ControlRequest {
    action: String,
}

pub async fn control(Json(request): Json<ControlRequest>) -> Json<Value> {
    let gate = CSQTT_GATE.get_or_init(|| Semaphore::new(1));
    let Ok(_permit) = gate.try_acquire() else {
        return Json(json!({ "success": false, "error": "Управление CSQTT уже выполняется" }));
    };
    if !matches!(request.action.as_str(), "start" | "stop" | "restart") {
        return Json(json!({ "success": false, "error": "Недопустимое действие CSQTT" }));
    }
    if !Path::new("/opt/etc/init.d/S99csqtt").is_file() {
        return Json(json!({ "success": false, "error": "Сервис CSQTT не установлен" }));
    }
    let mut hash_mode = String::from("auto_js");
    if request.action != "stop" {
        if let Ok(content) = tokio::fs::read_to_string(CONFIG).await {
            hash_mode = value(&content, "VK_HASH_MODE").unwrap_or_else(|| "auto_js".into());
            if hash_mode == "manual" && value(&content, "VK_HASHES").is_none_or(|v| v.is_empty()) {
                return Json(json!({ "success": false, "error": "Для ручного режима не сохранены хеши VK" }));
            }
            if hash_mode != "manual" && !tokio::fs::metadata(VK_TOKEN).await.is_ok_and(|m| m.len() > 0) {
                return Json(json!({ "success": false, "error": "Для автоматического режима не сохранён VK-токен" }));
            }
        }
    }
    let result = tokio::time::timeout(Duration::from_secs(420),
        tokio::process::Command::new("/opt/etc/init.d/S99csqtt")
            .arg(&request.action).kill_on_drop(true).output()).await;
    match result {
        Ok(Ok(result)) if result.status.success() => {
            if request.action != "stop" {
                let attempts = if hash_mode == "auto_api" { 2 } else { 8 };
                for _ in 0..attempts {
                    if client_running() { break }
                    tokio::time::sleep(std::time::Duration::from_millis(800)).await;
                }
                if hash_mode == "auto_api" && !client_running() && starter_running() {
                    return Json(json!({ "success": true, "starting": true }));
                }
                if !client_running() {
                    return Json(json!({ "success": false, "error": last_diagnostic().unwrap_or_else(|| "CSQTT завершился сразу после запуска. Проверьте журнал клиента.".into()) }));
                }
            }
            Json(json!({ "success": true }))
        },
        Ok(Ok(result)) => Json(json!({ "success": false, "error": String::from_utf8_lossy(&result.stderr).trim() })),
        Ok(Err(error)) => Json(json!({ "success": false, "error": format!("Ошибка управления CSQTT: {error}") })),
        Err(_) => Json(json!({ "success": false, "error": "Управление CSQTT превысило 7 минут; проверьте состояние сервиса" })),
    }
}

fn starter_running() -> bool {
    let pid = std::fs::read_to_string("/var/run/csqtt.pid").ok()
        .and_then(|text| text.trim().parse::<u32>().ok());
    pid.is_some_and(|pid| {
        std::fs::read(format!("/proc/{pid}/cmdline")).is_ok_and(|command| {
            command.split(|byte| *byte == 0).any(|arg| {
                arg.ends_with(b"/csqtt-client") || arg.ends_with(b"/csqtt-run.sh")
                    || arg.ends_with(b"/csqtt-run-219.sh")
            })
        })
    })
}

fn client_running() -> bool {
    std::fs::read_dir("/proc")
        .ok()
        .into_iter()
        .flatten()
        .filter_map(Result::ok)
        .filter(|entry| entry.file_name().to_string_lossy().parse::<u32>().is_ok())
        .any(|entry| std::fs::read_to_string(entry.path().join("comm"))
            .is_ok_and(|name| name.trim() == "csqtt-client"))
}

fn last_diagnostic() -> Option<String> {
    let mut file = std::fs::File::open("/opt/etc/csqtt/csqtt.log").ok()?;
    let len = file.metadata().ok()?.len();
    file.seek(SeekFrom::Start(len.saturating_sub(16384))).ok()?;
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes).ok()?;
    let log = String::from_utf8_lossy(&bytes);
    if log.contains("API 5: User authorization failed") {
        Some("VK отклонил авторизацию дополнительной сессии (код 5). Токен может быть действительным; уменьшите число хешей или потоков и проверьте снова.".into())
    } else if log.contains("API 18: User was deleted or banned") {
        Some("VK сообщил о заблокированном или удалённом аккаунте (код 18).".into())
    } else if log.contains("Нужны -peer и хеши VK") {
        Some("Клиент не получил адрес сервера или хеши VK.".into())
    } else if log.contains("Call not found (error_code=951)") {
        Some("VK не нашёл звонок (код 951).".into())
    } else if log.contains("Flood control") {
        Some("VK ограничил частые запросы (код 9).".into())
    } else {
        None
    }
}

pub async fn status() -> Json<Value> {
    let installed = Path::new("/opt/etc/csqtt/csqtt-client").is_file();
    let running = client_running();
    let interface = Path::new("/sys/class/net/csqtt0").exists();
    let ready = if running && interface {
        tokio::process::Command::new("/opt/sbin/ip")
            .args(["-4", "addr", "show", "dev", "csqtt0"])
            .output().await.ok().is_some_and(|output| output.status.success() && String::from_utf8_lossy(&output.stdout).contains("inet "))
    } else { false };
    let log_recent = std::fs::metadata("/opt/etc/csqtt/csqtt.log")
        .and_then(|meta| meta.modified())
        .ok()
        .and_then(|time| time.elapsed().ok())
        .is_some_and(|age| age < std::time::Duration::from_secs(900));
    let diagnostic = if !ready && log_recent { last_diagnostic() } else { None };
    let client_version = std::fs::read_to_string("/opt/etc/csqtt/client-version").ok().map(|v| v.trim().to_string()).unwrap_or_else(|| "2.0".into());
    Json(json!({ "installed": installed, "running": running, "interface": interface, "ready": ready, "diagnostic": diagnostic, "clientVersion": client_version, "vkApiNotice": vk_api_notice(running) }))
}
