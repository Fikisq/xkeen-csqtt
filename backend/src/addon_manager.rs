use axum::{extract::State, Json};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{io::{Cursor, Read}, os::unix::fs::PermissionsExt, path::Path, time::Duration};
use tokio::{fs, process::Command, sync::Mutex};

use crate::types::AppState;

const CONFIG: &str = "/opt/etc/xray/configs/00_config.json";
const RELEASES: &str = "https://api.github.com/repos/Fikisq/xkeen-csqtt/releases?per_page=10";
const BACKUP: &str = "/opt/etc/xkeen/addon-outbounds";
static LOCK: Mutex<()> = Mutex::const_new(());

#[derive(Deserialize)]
pub struct Request { addon: String, confirm: bool }

struct Addon {
    tag: &'static str,
    binary: &'static str,
    service: &'static str,
    asset: &'static str,
}

fn addon(name: &str) -> Option<Addon> {
    match name {
        "csqtt" => Some(Addon { tag: "csqtt", binary: "/opt/etc/csqtt/csqtt-client", service: "/opt/etc/init.d/S99csqtt", asset: "csqtt-client-arm64-v8a.tar.gz" }),
        "wdtt-plus" => Some(Addon { tag: "wdtt-plus", binary: "/opt/etc/wdtt-plus/wdtt-plus-client", service: "/opt/etc/init.d/S99wdtt-plus", asset: "wdtt-plus-client-arm64-v8a.tar.gz" }),
        "nfqws2" => Some(Addon { tag: "nfqws-direct", binary: "/opt/etc/xkeen/nfqws2-stage/engine", service: "/opt/etc/init.d/S98nfqws2-xkeen", asset: "xkeen-nfqws2-arm64-v8a.tar.gz" }),
        _ => None,
    }
}

fn references(value: &Value, tag: &str) -> bool {
    match value {
        Value::String(text) => text == tag || text.ends_with(&format!("|{tag}")),
        Value::Array(items) => items.iter().any(|item| references(item, tag)),
        Value::Object(items) => items.values().any(|item| references(item, tag)),
        _ => false,
    }
}

fn private_write(path: &str, content: &[u8]) -> Result<(), String> {
    use std::io::Write;
    let temp = format!("{path}.tmp-{}", std::process::id());
    let result = (|| -> std::io::Result<()> {
        let mut file = std::fs::OpenOptions::new().write(true).create_new(true).open(&temp)?;
        std::fs::set_permissions(&temp, std::fs::Permissions::from_mode(0o600))?;
        file.write_all(content)?;
        file.sync_all()?;
        std::fs::rename(&temp, path)
    })();
    if result.is_err() { let _ = std::fs::remove_file(&temp); }
    result.map_err(|error| error.to_string())
}

async fn control(path: &str, action: &str) -> Result<(), String> {
    if !Path::new(path).is_file() { return Err(format!("Сервис {path} не найден")); }
    let mut command = Command::new(path);
    command.arg(action);
    if path.ends_with("S05xkeen") && action == "restart" { command.arg("on"); }
    let result = tokio::time::timeout(Duration::from_secs(120),
        command.kill_on_drop(true).output()).await
        .map_err(|_| "Время ожидания сервиса истекло".to_string())?
        .map_err(|error| error.to_string())?;
    if result.status.success() { Ok(()) }
    else { Err(String::from_utf8_lossy(&result.stderr).trim().to_string()) }
}

async fn restart_xray(state: &AppState, previous: &[u8], next: &Value) -> Result<bool, String> {
    private_write(CONFIG, &serde_json::to_vec_pretty(next).map_err(|error| error.to_string())?)?;
    if !state.core.read().is_ok_and(|core| core.name == "xray") { return Ok(false); }
    if let Err(error) = control("/opt/etc/init.d/S05xkeen", "restart").await {
        private_write(CONFIG, previous)?;
        let _ = control("/opt/etc/init.d/S05xkeen", "restart").await;
        return Err(format!("Xray не запустился; конфигурация восстановлена: {error}"));
    }
    Ok(true)
}

async fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder().user_agent("XKeen-UI-CSQTT")
        .timeout(Duration::from_secs(45)).build().map_err(|error| error.to_string())
}

async fn release_assets(http: &reqwest::Client, wanted: &str) -> Result<(String, String), String> {
    let releases: Value = http.get(RELEASES).send().await.map_err(|error| error.to_string())?
        .error_for_status().map_err(|error| error.to_string())?
        .json().await.map_err(|error| error.to_string())?;
    for release in releases.as_array().into_iter().flatten() {
        let assets = release.get("assets").and_then(Value::as_array);
        let get = |name: &str| assets?.iter().find(|item| item.get("name").and_then(Value::as_str) == Some(name))?
            .get("browser_download_url")?.as_str().map(str::to_owned);
        if let (Some(asset), Some(sums)) = (get(wanted), get("SHA256SUMS")) { return Ok((asset, sums)); }
    }
    Err("Совместимый пакет ещё не опубликован в релизе GitHub; удаление недоступно".into())
}

async fn download(http: &reqwest::Client, url: &str, max: usize) -> Result<Vec<u8>, String> {
    let bytes = http.get(url).send().await.map_err(|error| error.to_string())?
        .error_for_status().map_err(|error| error.to_string())?
        .bytes().await.map_err(|error| error.to_string())?;
    if bytes.len() > max { return Err("Файл релиза слишком большой".into()); }
    Ok(bytes.to_vec())
}

async fn verified_bundle(def: &Addon) -> Result<Vec<u8>, String> {
    let http = client().await?;
    let (asset_url, sums_url) = release_assets(&http, def.asset).await?;
    let sums = String::from_utf8(download(&http, &sums_url, 128 * 1024).await?)
        .map_err(|error| error.to_string())?;
    let expected = sums.lines().find_map(|line| {
        let mut fields = line.split_whitespace();
        let hash = fields.next()?;
        (fields.next()? == def.asset && hash.len() == 64).then(|| hash.to_ascii_lowercase())
    }).ok_or("В релизе нет контрольной суммы пакета")?;
    let bytes = download(&http, &asset_url, 32 * 1024 * 1024).await?;
    let actual = format!("{:x}", Sha256::digest(&bytes));
    if actual != expected { return Err("Контрольная сумма пакета не совпадает".into()); }
    Ok(bytes)
}

fn unpack(bundle: &[u8], wanted: &[&str]) -> Result<std::collections::HashMap<String, Vec<u8>>, String> {
    let mut archive = tar::Archive::new(flate2::read::GzDecoder::new(Cursor::new(bundle)));
    let mut files = std::collections::HashMap::new();
    for entry in archive.entries().map_err(|error| error.to_string())? {
        let mut entry = entry.map_err(|error| error.to_string())?;
        if !entry.header().entry_type().is_file() { continue; }
        let path = entry.path().map_err(|error| error.to_string())?;
        let name = path.to_string_lossy().trim_start_matches("./").to_string();
        if !wanted.iter().any(|wanted| *wanted == name) { return Err("Неожиданный файл в пакете".into()); }
        if entry.size() > 30 * 1024 * 1024 { return Err("Файл пакета слишком большой".into()); }
        let mut content = Vec::new();
        entry.read_to_end(&mut content).map_err(|error| error.to_string())?;
        files.insert(name.to_string(), content);
    }
    if wanted.iter().any(|name| !files.contains_key(*name)) { return Err("Пакет неполный".into()); }
    Ok(files)
}

fn install_file(path: &str, content: &[u8]) -> Result<(), String> {
    if let Some(parent) = Path::new(path).parent() { std::fs::create_dir_all(parent).map_err(|error| error.to_string())?; }
    private_write(path, content)?;
    let mode = if path.ends_with(".gz") || path.ends_with(".bin") || path.ends_with("client-version") { 0o644 } else { 0o755 };
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode)).map_err(|error| error.to_string())
}

fn target(addon: &str, file: &str) -> Option<&'static str> {
    match (addon, file) {
        ("csqtt", "client") => Some("/opt/etc/csqtt/csqtt-client"),
        ("csqtt", "client-version") => Some("/opt/etc/csqtt/client-version"),
        ("csqtt", "csqtt-tun-fd") => Some("/opt/etc/csqtt/csqtt-tun-fd"),
        ("csqtt", "csqtt-run-219.sh") => Some("/opt/etc/csqtt/csqtt-run-219.sh"),
        ("csqtt", "csqtt-js-calls.sh") => Some("/opt/etc/csqtt/csqtt-js-calls.sh"),
        ("csqtt", "csqtt-api-calls.sh") => Some("/opt/etc/csqtt/csqtt-api-calls.sh"),
        ("csqtt", "csqtt-speedtest.sh") => Some("/opt/bin/csqtt-speedtest"),
        ("csqtt", "vk-manual-hashes.sh") | ("wdtt-plus", "vk-manual-hashes.sh") => Some("/opt/bin/vk-manual-hashes.sh"),
        ("csqtt", "S99csqtt") => Some("/opt/etc/init.d/S99csqtt"),
        ("wdtt-plus", "client") => Some("/opt/etc/wdtt-plus/wdtt-plus-client"),
        ("wdtt-plus", "wdtt-plus-run.sh") => Some("/opt/etc/wdtt-plus/wdtt-plus-run.sh"),
        ("wdtt-plus", "wdtt-plus-watchdog.sh") => Some("/opt/etc/wdtt-plus/wdtt-plus-watchdog.sh"),
        ("wdtt-plus", "wdtt-plus-calls.sh") => Some("/opt/etc/wdtt-plus/wdtt-plus-calls.sh"),
        ("wdtt-plus", "S99wdtt-plus") => Some("/opt/etc/init.d/S99wdtt-plus"),
        ("nfqws2", "engine") => Some("/opt/etc/xkeen/nfqws2-stage/engine"),
        ("nfqws2", "probe") => Some("/opt/etc/xkeen/nfqws2-stage/probe"),
        ("nfqws2", "canary.sh") => Some("/opt/etc/xkeen/nfqws2-stage/canary.sh"),
        ("nfqws2", "probe-check.sh") => Some("/opt/etc/xkeen/nfqws2-stage/probe-check.sh"),
        ("nfqws2", "activate.sh") => Some("/opt/etc/xkeen/nfqws2-stage/activate.sh"),
        ("nfqws2", "nfqws2/lua/zapret-lib.lua.gz") => Some("/opt/etc/xkeen/nfqws2-stage/nfqws2/lua/zapret-lib.lua.gz"),
        ("nfqws2", "nfqws2/lua/zapret-antidpi.lua.gz") => Some("/opt/etc/xkeen/nfqws2-stage/nfqws2/lua/zapret-antidpi.lua.gz"),
        ("nfqws2", "nfqws2/blobs/quic_initial.bin") => Some("/opt/etc/xkeen/nfqws2-stage/nfqws2/blobs/quic_initial.bin"),
        ("nfqws2", "nfqws2/blobs/tls_clienthello.bin") => Some("/opt/etc/xkeen/nfqws2-stage/nfqws2/blobs/tls_clienthello.bin"),
        ("nfqws2", "S98nfqws2-xkeen") => Some("/opt/etc/init.d/S98nfqws2-xkeen"),
        _ => None,
    }
}

fn bundle_files(name: &str) -> &'static [&'static str] {
    match name {
        "csqtt" => &["client", "client-version", "csqtt-tun-fd", "csqtt-run-219.sh", "csqtt-js-calls.sh", "csqtt-api-calls.sh", "vk-manual-hashes.sh", "csqtt-speedtest.sh", "S99csqtt"],
        "wdtt-plus" => &["client", "wdtt-plus-run.sh", "wdtt-plus-watchdog.sh", "wdtt-plus-calls.sh", "vk-manual-hashes.sh", "S99wdtt-plus"],
        _ => &["engine", "probe", "canary.sh", "probe-check.sh", "activate.sh", "nfqws2/lua/zapret-lib.lua.gz", "nfqws2/lua/zapret-antidpi.lua.gz", "nfqws2/blobs/quic_initial.bin", "nfqws2/blobs/tls_clienthello.bin", "S98nfqws2-xkeen"],
    }
}

async fn remove_inner(state: AppState, name: &str) -> Result<Value, String> {
    let def = addon(name).ok_or("Неизвестный компонент")?;
    if !Path::new(def.binary).is_file() { return Err("Компонент уже удалён".into()); }
    if std::env::consts::ARCH != "aarch64" { return Err("Для этой архитектуры пакет пока не опубликован".into()); }
    let bundle = verified_bundle(&def).await?;
    unpack(&bundle, bundle_files(name))?; // Refuse removal without a complete replacement.
    let previous = fs::read(CONFIG).await.map_err(|error| error.to_string())?;
    let mut config: Value = serde_json::from_slice(&previous).map_err(|error| error.to_string())?;
    if config.get("routing").is_some_and(|routing| references(routing, def.tag) ||
        (name == "nfqws2" && references(routing, "nfqws2"))) {
        return Err("Компонент выбран в маршрутизации. Сначала переключите эти маршруты.".into());
    }
    if name != "nfqws2" {
        if let Ok(mihomo) = fs::read_to_string("/opt/etc/mihomo/config.yaml").await {
            if mihomo.contains(def.tag) { return Err("Компонент упоминается в конфигурации Mihomo".into()); }
        }
    }
    control(def.service, "stop").await?;
    let outbound = config.get_mut("outbounds").and_then(Value::as_array_mut).and_then(|items| {
        let index = items.iter().position(|item| item.get("tag").and_then(Value::as_str) == Some(def.tag))?;
        Some(items.remove(index))
    });
    let restarted = if let Some(outbound) = outbound {
        fs::create_dir_all(BACKUP).await.map_err(|error| error.to_string())?;
        private_write(&format!("{BACKUP}/{name}.json"), &serde_json::to_vec(&outbound).map_err(|error| error.to_string())?)?;
        restart_xray(&state, &previous, &config).await?
    } else { false };
    fs::remove_file(def.binary).await.map_err(|error| error.to_string())?;
    if name == "nfqws2" {
        let _ = fs::remove_file("/opt/etc/xkeen/nfqws2-stage/probe").await;
        let _ = fs::remove_file("/opt/etc/xkeen/nfqws2-stage/global-enabled").await;
    }
    let _ = fs::remove_file(def.service).await;
    Ok(json!({"success": true, "restarted": restarted}))
}

async fn install_inner(state: AppState, name: &str) -> Result<Value, String> {
    let def = addon(name).ok_or("Неизвестный компонент")?;
    if Path::new(def.binary).exists() { return Err("Компонент уже установлен".into()); }
    if std::env::consts::ARCH != "aarch64" { return Err("Для этой архитектуры пакет пока не опубликован".into()); }
    let bundle = verified_bundle(&def).await?;
    let names = bundle_files(name);
    let files = unpack(&bundle, names)?;
    for name_in_bundle in names {
        let path = target(name, name_in_bundle).ok_or("Неизвестный файл пакета")?;
        install_file(path, &files[*name_in_bundle])?;
    }
    let backup = format!("{BACKUP}/{name}.json");
    let mut restarted = false;
    if let Ok(outbound) = fs::read(&backup).await {
        let previous = fs::read(CONFIG).await.map_err(|error| error.to_string())?;
        let mut config: Value = serde_json::from_slice(&previous).map_err(|error| error.to_string())?;
        let restored: Value = serde_json::from_slice(&outbound).map_err(|error| error.to_string())?;
        let outbounds = config.get_mut("outbounds").and_then(Value::as_array_mut).ok_or("У Xray нет списка выходов")?;
        if !outbounds.iter().any(|item| item.get("tag").and_then(Value::as_str) == Some(def.tag)) {
            outbounds.push(restored);
            restarted = restart_xray(&state, &previous, &config).await?;
        }
        let _ = fs::remove_file(&backup).await;
    }
    Ok(json!({"success": true, "restarted": restarted}))
}

pub async fn remove(State(state): State<AppState>, Json(request): Json<Request>) -> Json<Value> {
    if !request.confirm { return Json(json!({"success": false, "error": "Подтвердите удаление"})); }
    let _lock = LOCK.lock().await;
    match remove_inner(state, &request.addon).await { Ok(value) => Json(value), Err(error) => Json(json!({"success": false, "error": error})) }
}

pub async fn install(State(state): State<AppState>, Json(request): Json<Request>) -> Json<Value> {
    if !request.confirm { return Json(json!({"success": false, "error": "Подтвердите установку"})); }
    let _lock = LOCK.lock().await;
    match install_inner(state, &request.addon).await { Ok(value) => Json(value), Err(error) => Json(json!({"success": false, "error": error})) }
}
