use crate::types::{AppState, S99XKEEN_UI, VERSION};
use axum::{extract::State, http::HeaderMap, Json};
use futures_util::StreamExt;
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{os::unix::fs::PermissionsExt, path::{Path, PathBuf}, process::Stdio, sync::atomic::{AtomicU16, Ordering}, time::Duration};
use tokio::{fs, io::AsyncWriteExt, process::Command};

const LOCK: &str = "/var/run/xkeen-ui-update.lock";
const STATUS: &str = "/var/run/xkeen-ui-update.json";
static PORT: AtomicU16 = AtomicU16::new(1000);
pub(crate) fn set_port(port: u16) { PORT.store(port, Ordering::Relaxed); }

pub(crate) fn asset_name() -> Option<&'static str> {
    match std::env::consts::ARCH { "aarch64" => Some("xkeen-ui-arm64-v8a"), _ => None }
}

#[derive(Deserialize)]
pub struct InstallRequest { tag: String }

struct Preparation { work: PathBuf, handed_over: bool }
impl Drop for Preparation {
    fn drop(&mut self) {
        if !self.handed_over {
            let _ = std::fs::remove_dir_all(&self.work);
            let _ = std::fs::remove_dir(LOCK);
        }
    }
}

fn same_origin(headers: &HeaderMap) -> bool {
    if headers.get("sec-fetch-site").and_then(|h| h.to_str().ok()) == Some("cross-site") { return false; }
    let Some(origin) = headers.get("origin") else { return true; };
    let Some(origin) = origin.to_str().ok().and_then(|o| reqwest::Url::parse(o).ok()) else { return false; };
    let Some(host) = headers.get("host").and_then(|h| h.to_str().ok()) else { return false; };
    reqwest::Url::parse(&format!("{}://{}", origin.scheme(), host)).is_ok_and(|host| host.origin() == origin.origin())
}

pub async fn status() -> Json<Value> {
    let mut state = fs::read(STATUS).await.ok().filter(|b| b.len() < 8192)
        .and_then(|b| serde_json::from_slice::<Value>(&b).ok());
    if let Some(state) = state.as_mut() {
        if matches!(state["phase"].as_str(), Some("downloading" | "restarting")) && !Path::new(LOCK).exists() {
            state["phase"] = json!("error");
            state["message"] = json!("Предыдущая установка прервана; повторите попытку");
        }
    }
    Json(json!({"success":true,"update":state}))
}

pub async fn post(State(state): State<AppState>, headers: HeaderMap, Json(request): Json<InstallRequest>) -> Json<Value> {
    Json(start(&state, &headers, &request.tag).await)
}

pub(crate) async fn start(state: &AppState, headers: &HeaderMap, tag: &str) -> Value {
    if !same_origin(headers) { return json!({"success":false,"error":"Запустите установку из самой панели"}); }
    match prepare(state, tag).await {
        Ok(id) => json!({"success":true,"jobId":id,"targetVersion":tag.trim_start_matches('v')}),
        Err(error) => json!({"success":false,"error":error}),
    }
}

async fn write_state(id: &str, tag: &str, phase: &str, message: &str) -> Result<(), String> {
    let tmp = format!("{STATUS}.{id}.tmp");
    let bytes = serde_json::to_vec(&json!({"id":id,"fromVersion":VERSION.trim_start_matches('v'),
        "targetVersion":tag.trim_start_matches('v'),"phase":phase,"message":message})).map_err(|e| e.to_string())?;
    let mut file = fs::OpenOptions::new().write(true).create_new(true).mode(0o600).open(&tmp).await.map_err(|e| e.to_string())?;
    file.write_all(&bytes).await.map_err(|e| e.to_string())?;
    file.sync_all().await.map_err(|e| e.to_string())?;
    fs::rename(&tmp, STATUS).await.map_err(|e| e.to_string())
}

async fn small_download(client: &reqwest::Client, url: &str, limit: usize) -> Result<Vec<u8>, String> {
    let response = client.get(url).header("Accept", "application/vnd.github+json").timeout(Duration::from_secs(30))
        .send().await.map_err(|_| "Не удалось связаться с GitHub")?
        .error_for_status().map_err(|_| "Файл выбранного релиза недоступен")?;
    let mut stream = response.bytes_stream();
    let mut data = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| "Загрузка прервана")?;
        if data.len().saturating_add(chunk.len()) > limit { return Err("Ответ GitHub слишком большой".into()); }
        data.extend_from_slice(&chunk);
    }
    Ok(data)
}

async fn prepare(state: &AppState, tag: &str) -> Result<String, String> {
    // Tags are identifiers from our published releases, never URLs or shell text.
    if tag.is_empty() || tag.len() > 80 || !tag.bytes().all(|b| b.is_ascii_alphanumeric() || b".-+".contains(&b))
        || !tag.trim_start_matches('v').starts_with(|c: char| c.is_ascii_digit()) {
        return Err("Некорректная версия панели".into());
    }
    let asset = asset_name().ok_or("Для этой архитектуры нет поддерживаемой сборки панели")?;
    if !Path::new(S99XKEEN_UI).is_file() { return Err("Служба панели не установлена: обновите панель командой из README".into()); }
    // Keep the lock across the panel's own restart. The independent helper owns
    // cleanup after spawn; a reboot clears /var/run. Recover abandoned old locks.
    if let Ok(meta) = fs::metadata(LOCK).await {
        if meta.modified().ok().and_then(|m| m.elapsed().ok()).is_some_and(|d| d.as_secs() > 900) {
            let _ = fs::remove_dir(LOCK).await;
        }
    }
    fs::create_dir(LOCK).await.map_err(|_| "Установка панели уже выполняется")?;
    let id = uuid::Uuid::new_v4().to_string();
    let work = PathBuf::from(format!("/opt/sbin/.xkeen-ui-update-{id}"));
    let mut cleanup = Preparation { work: work.clone(), handed_over: false };
    let result = prepare_locked(state, tag, asset, &id, &work).await;
    if let Err(error) = &result {
        let _ = write_state(&id, tag, "error", error).await;
    } else {
        cleanup.handed_over = true;
    }
    result.map(|_| id)
}

async fn prepare_locked(state: &AppState, tag: &str, asset: &str, id: &str, work: &Path) -> Result<(), String> {
    fs::create_dir(work).await.map_err(|_| "Не удалось создать каталог обновления")?;
    fs::set_permissions(work, std::fs::Permissions::from_mode(0o700)).await.map_err(|e| e.to_string())?;
    write_state(id, tag, "downloading", "Загрузка и проверка выбранной версии").await?;
    let metadata = small_download(&state.http_client,
        &format!("https://api.github.com/repos/Fikisq/xkeen-csqtt/releases/tags/{tag}?xkeen_update={id}"), 2 * 1024 * 1024).await?;
    let release: Value = serde_json::from_slice(&metadata).map_err(|_| "Некорректный ответ GitHub")?;
    if release["draft"] != false || release["tag_name"].as_str() != Some(tag) { return Err("Релиз не опубликован".into()); }
    let assets = release["assets"].as_array().ok_or("В релизе нет файлов")?;
    if ![asset, "SHA256SUMS"].iter().all(|name| assets.iter().any(|a| a["name"].as_str() == Some(name))) {
        return Err("В релизе нет файла панели или контрольных сумм для этой архитектуры".into());
    }
    let base = format!("https://github.com/Fikisq/xkeen-csqtt/releases/download/{tag}");
    let checksums = small_download(&state.http_client, &format!("{base}/SHA256SUMS?xkeen_update={id}"), 1024 * 1024).await?;
    let text = std::str::from_utf8(&checksums).map_err(|_| "Некорректный файл контрольных сумм")?;
    let matching: Vec<_> = text.lines().filter_map(|line| {
        let mut parts = line.split_whitespace();
        let hash = parts.next()?; let name = parts.next()?.trim_start_matches('*');
        (name == asset && parts.next().is_none() && hash.len() == 64 && hash.bytes().all(|b| b.is_ascii_hexdigit()))
            .then(|| hash.to_ascii_lowercase())
    }).collect();
    if matching.len() != 1 { return Err("Нет однозначной SHA-256 суммы файла панели".into()); }
    let expected = &matching[0];
    if let Some(published) = assets.iter().find(|a| a["name"].as_str() == Some(asset))
        .and_then(|a| a["digest"].as_str()).and_then(|value| value.strip_prefix("sha256:")) {
        if !published.eq_ignore_ascii_case(expected) {
            return Err("Контрольные суммы релиза обновились; повторите загрузку позже".into());
        }
    }
    let response = state.http_client.get(format!("{base}/{asset}?xkeen_update={id}")).timeout(Duration::from_secs(180))
        .send().await.map_err(|_| "Не удалось загрузить панель")?
        .error_for_status().map_err(|_| "Файл панели недоступен")?;
    let candidate = work.join("candidate");
    let mut file = fs::OpenOptions::new().create_new(true).write(true).mode(0o711).open(&candidate).await.map_err(|_| "Не удалось сохранить панель")?;
    let mut stream = response.bytes_stream(); let mut hash = Sha256::new(); let mut bytes = 0usize; let mut header = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| "Загрузка панели прервана")?;
        bytes = bytes.saturating_add(chunk.len());
        if bytes > 64 * 1024 * 1024 { return Err("Файл панели слишком большой".into()); }
        if header.len() < 20 { header.extend_from_slice(&chunk[..chunk.len().min(20 - header.len())]); }
        hash.update(&chunk); file.write_all(&chunk).await.map_err(|_| "Недостаточно места для панели")?;
    }
    file.sync_all().await.map_err(|_| "Не удалось сохранить панель на диск")?;
    drop(file);
    if format!("{:x}", hash.finalize()) != *expected { return Err("Контрольная сумма панели не совпала: установка отменена".into()); }
    if bytes < 1024 * 1024 || header.len() < 20 || &header[..6] != b"\x7fELF\x02\x01" || u16::from_le_bytes([header[18],header[19]]) != 183 {
        return Err("Файл не является поддерживаемой ARM64-панелью".into());
    }
    let output = tokio::time::timeout(Duration::from_secs(10), Command::new(&candidate).arg("--version").output())
        .await.map_err(|_| "Новая панель не отвечает на проверку версии")?.map_err(|_| "Новая панель не запускается на этом устройстве")?;
    let version = format!("v{}", tag.trim_start_matches('v'));
    if !output.status.success() || !String::from_utf8_lossy(&output.stdout).split_whitespace().any(|word| word == version) {
        return Err("Версия скачанного файла не соответствует выбранному релизу".into());
    }
    // Binary-only update: configurations and other clients are never rewritten.
    fs::copy("/opt/sbin/xkeen-ui", work.join("previous")).await.map_err(|_| "Не удалось сохранить прежнюю панель")?;
    fs::set_permissions(work.join("previous"), std::fs::Permissions::from_mode(0o711)).await.map_err(|e| e.to_string())?;
    fs::write(work.join("install.sh"), include_bytes!("panel-update.sh")).await.map_err(|e| e.to_string())?;
    write_state(id, tag, "restarting", "Установка и перезапуск панели").await?;
    let mut command = Command::new("/bin/sh");
    command.arg(work.join("install.sh"))
        .arg(work).arg(id).arg(tag.trim_start_matches('v')).arg(expected)
        .arg(PORT.load(Ordering::Relaxed).to_string())
        .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    // setsid is not shipped as a shell applet on every Entware installation.
    // The child must survive termination of the old panel process/session.
    unsafe {
        command.pre_exec(|| nix::unistd::setsid().map(|_| ())
            .map_err(|e| std::io::Error::from_raw_os_error(e as i32)));
    }
    command.spawn().map_err(|_| "Не удалось запустить установку панели")?;
    crate::logger::log("INFO", format!("Установка панели {tag}: файл проверен, подготовлен откат"));
    Ok(())
}
