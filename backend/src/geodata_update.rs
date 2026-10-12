use crate::{logger::log, types::AppState};
use axum::{extract::State, Json};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{path::{Path, PathBuf}, time::{Duration, SystemTime, UNIX_EPOCH}};

const DIRECTORY: &str = "/opt/etc/xray/dat";
const SETTINGS: &str = "/opt/etc/xkeen-ui/geodata.json";
const STATUS: &str = "/opt/etc/xkeen-ui/geodata-state.json";
const REQUEST: &str = "/opt/etc/xkeen-ui/geodata.refresh";
const CONFIG: &str = "/opt/etc/xray/configs/00_config.json";
const SOURCES: [(&str, &str, &str); 3] = [
    ("hydraponique/roscomvpn-geosite", "geosite.dat", "roscomvpn-geosite.dat"),
    ("hydraponique/roscomvpn-geoip", "geoip.dat", "roscomvpn-geoip.dat"),
    ("Loyalsoldier/v2ray-rules-dat", "geosite.dat", "geosite.dat"),
];

#[derive(Default, Deserialize, Serialize)]
struct UpdateState { last_check: u64, pending_reload: bool, versions: Vec<Value> }
fn now() -> u64 { SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs() }
fn interval() -> u64 {
    let hours = std::fs::read(SETTINGS).ok().and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
        .and_then(|value| value["intervalHours"].as_u64()).unwrap_or(12);
    hours.min(720) * 3600
}
fn status() -> UpdateState {
    std::fs::read(STATUS).ok().and_then(|bytes| serde_json::from_slice(&bytes).ok()).unwrap_or_default()
}
fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path.parent().ok_or("Нет каталога файла")?;
    std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let temporary = parent.join(format!(".geodata-{}", uuid::Uuid::new_v4()));
    let result = (|| {
        use std::io::Write;
        let mut file = std::fs::OpenOptions::new().write(true).create_new(true).open(&temporary).map_err(|e| e.to_string())?;
        file.write_all(bytes).and_then(|_| file.sync_all()).map_err(|e| e.to_string())?;
        if let Ok(metadata) = std::fs::metadata(path) { std::fs::set_permissions(&temporary, metadata.permissions()).map_err(|e| e.to_string())?; }
        std::fs::rename(&temporary, path).map_err(|e| e.to_string())
    })();
    if result.is_err() { let _ = std::fs::remove_file(temporary); }
    result
}

struct ProcessLock;
impl ProcessLock {
    fn acquire() -> Result<Self, String> {
        let directory = Path::new("/opt/var/lock/xkeen-geodata");
        std::fs::create_dir_all(directory.parent().unwrap()).map_err(|e| e.to_string())?;
        if directory.exists() {
            let dead = std::fs::read_to_string(directory.join("pid")).ok().and_then(|pid| pid.trim().parse::<u32>().ok())
                .is_some_and(|pid| !Path::new(&format!("/proc/{pid}")).exists());
            if dead { let _ = std::fs::remove_file(directory.join("pid")); let _ = std::fs::remove_dir(directory); }
        }
        std::fs::create_dir(directory).map_err(|_| "Обновление баз уже выполняется".to_string())?;
        let guard = Self;
        std::fs::write(directory.join("pid"), std::process::id().to_string()).map_err(|e| e.to_string())?;
        Ok(guard)
    }
}
impl Drop for ProcessLock {
    fn drop(&mut self) { let _ = std::fs::remove_file("/opt/var/lock/xkeen-geodata/pid"); let _ = std::fs::remove_dir("/opt/var/lock/xkeen-geodata"); }
}

fn canonical_refs(config: &mut Value) {
    if let Some(rules) = config.pointer_mut("/routing/rules").and_then(Value::as_array_mut) {
        for rule in rules { for key in ["domain", "ip"] {
            if let Some(values) = rule[key].as_array_mut() { for value in values {
                if let Some(text) = value.as_str() {
                    if let Some((file, category)) = text.strip_prefix("ext:").and_then(|s| s.split_once(':')) {
                        let canonical = if file.starts_with("roscomvpn-geosite") { Some("roscomvpn-geosite.dat") }
                            else if file.starts_with("roscomvpn-geoip") { Some("roscomvpn-geoip.dat") } else { None };
                        if let Some(file) = canonical { *value = Value::String(format!("ext:{file}:{category}")); }
                    }
                }
            }}
        }}
    }
}

pub async fn update(state: Option<&AppState>) -> Result<Value, String> {
    let _process_lock = ProcessLock::acquire()?;
    use std::os::unix::fs::PermissionsExt;
    atomic_write(Path::new("/opt/bin/xkeen-geodata"), include_bytes!("xkeen-geodata.sh"))?;
    std::fs::set_permissions("/opt/bin/xkeen-geodata", std::fs::Permissions::from_mode(0o755)).map_err(|e| e.to_string())?;
    let http = reqwest::Client::builder().user_agent("XKeen-geodata-updater").timeout(Duration::from_secs(90))
        .build().map_err(|e| e.to_string())?;
    let mut downloads = Vec::<(String, Vec<u8>)>::new();
    let mut versions = Vec::new();
    for (repository, asset_name, destination) in SOURCES {
        let release: Value = http.get(format!("https://api.github.com/repos/{repository}/releases/latest"))
            .send().await.map_err(|e| e.to_string())?.error_for_status().map_err(|e| e.to_string())?
            .json().await.map_err(|e| e.to_string())?;
        let asset = release["assets"].as_array().and_then(|assets| assets.iter().find(|asset| asset["name"] == asset_name))
            .ok_or_else(|| format!("{repository}: нет {asset_name}"))?;
        let digest = asset["digest"].as_str().and_then(|s| s.strip_prefix("sha256:"))
            .filter(|s| s.len() == 64 && s.bytes().all(|b| b.is_ascii_hexdigit()))
            .ok_or_else(|| format!("{repository}: нет проверяемой SHA-256"))?;
        versions.push(json!({"file":destination,"release":release["tag_name"],"sha256":digest}));
        let current = std::fs::read(Path::new(DIRECTORY).join(destination)).ok()
            .map(|bytes| format!("{:x}", Sha256::digest(bytes)));
        if current.as_deref() == Some(digest) { continue; }
        if asset["size"].as_u64().unwrap_or(u64::MAX) > 32 * 1024 * 1024 { return Err("База превышает 32 МБ".into()); }
        let url = asset["browser_download_url"].as_str().filter(|s| s.starts_with("https://github.com/"))
            .ok_or("Неверная ссылка релиза")?;
        let bytes = http.get(url).send().await.map_err(|e| e.to_string())?.error_for_status().map_err(|e| e.to_string())?
            .bytes().await.map_err(|e| e.to_string())?;
        if bytes.len() > 32 * 1024 * 1024 || format!("{:x}", Sha256::digest(&bytes)) != digest { return Err(format!("SHA-256 не совпала: {destination}")); }
        crate::geo::validate_uploaded_geo(&bytes, asset_name == "geoip.dat")?;
        downloads.push((destination.into(), bytes.to_vec()));
    }
    let _route_guard = match state { Some(_) => Some(crate::xray_routes::routing_lock().lock().await), None => None };
    let _config_guard = match state { Some(state) => Some(state.app_config_lock.lock().await), None => None };
    let old_text = std::fs::read_to_string(CONFIG).ok();
    let old_config = old_text.as_deref().and_then(|text| serde_json::from_str::<Value>(text).ok());
    if state.is_some() && old_text.is_some() && old_config.is_none() { return Err("Текущая конфигурация Xray повреждена; базы не заменены".into()); }
    let mut new_config = old_config.clone();
    if state.is_some() { if let Some(config) = &mut new_config { canonical_refs(config); } }
    let changed_rules = old_config != new_config;
    let active = state.is_some_and(|state| state.core.read().unwrap().name == "xray")
        && old_config.as_ref().is_some_and(|config| config.pointer("/api/listen").and_then(Value::as_str) == Some("127.0.0.1:18085"));
    if state.is_some() && old_config.is_some() && !active && (!downloads.is_empty() || changed_rules) {
        return Err("Обновление отложено: для работающего Xray нужен локальный API маршрутизации".into());
    }
    let mut backups = Vec::<(PathBuf, Option<PathBuf>)>::new();
    let changed_count = downloads.len();
    let result = async {
        for (name, bytes) in &downloads {
            let path = Path::new(DIRECTORY).join(name);
            let backup = if path.exists() {
                let backup = Path::new(DIRECTORY).join(format!(".geodata-backup-{}", uuid::Uuid::new_v4()));
                std::fs::copy(&path, &backup).map_err(|e| e.to_string())?;
                Some(backup)
            } else { None };
            backups.push((path.clone(), backup));
            atomic_write(&path, bytes)?;
        }
        if active && (changed_count > 0 || changed_rules || status().pending_reload) {
            crate::xray_routes::replace_live_rules(new_config.as_ref().unwrap()).await?;
            if changed_rules { atomic_write(Path::new(CONFIG), &serde_json::to_vec_pretty(new_config.as_ref().unwrap()).map_err(|e| e.to_string())?)?; }
        }
        atomic_write(Path::new(STATUS), &serde_json::to_vec(&UpdateState { last_check: now(), pending_reload: state.is_none(), versions }).map_err(|e| e.to_string())?)?;
        Ok::<(), String>(())
    }.await;
    if let Err(error) = result {
        for (path, backup) in backups.iter().rev() { if let Some(backup) = backup { let _ = std::fs::rename(backup, path); } else { let _ = std::fs::remove_file(path); } }
        if changed_rules { if let Some(text) = &old_text { let _ = atomic_write(Path::new(CONFIG), text.as_bytes()); } }
        if active { if let Some(config) = &old_config { let _ = crate::xray_routes::replace_live_rules(config).await; } }
        return Err(error);
    }
    for (_, backup) in backups { if let Some(backup) = backup { let _ = std::fs::remove_file(backup); } }
    let _ = std::fs::remove_file(REQUEST);
    if changed_count > 0 || changed_rules { log("INFO", format!("Геобазы обновлены: {changed_count}; правила применены без перезапуска")); }
    Ok(json!({"success":true,"updated":changed_count,"status":status()}))
}

pub fn start(state: AppState) {
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_secs(10)).await;
        let mut retry_after = 0;
        loop {
            let saved = status(); let period = interval();
            let due = Path::new(REQUEST).exists() || saved.pending_reload || (period > 0 && now().saturating_sub(saved.last_check) >= period);
            if due && now() >= retry_after {
                match update(Some(&state)).await {
                    Ok(_) => retry_after = 0,
                    Err(error) => { log("ERROR", format!("Обновление геобаз: {error}")); retry_after = now() + 900; }
                }
            }
            tokio::time::sleep(Duration::from_secs(60)).await;
        }
    });
}

pub async fn apply_template(State(state): State<AppState>) -> Json<Value> {
    let previous = match tokio::fs::read_to_string(CONFIG).await { Ok(value) => value, Err(e) => return Json(json!({"success":false,"error":e.to_string()})) };
    let mut config: Value = match serde_json::from_str(&previous) { Ok(value) => value, Err(e) => return Json(json!({"success":false,"error":e.to_string()})) };
    let old_rules = config.pointer("/routing/rules").and_then(Value::as_array).cloned().unwrap_or_default();
    if !config["outbounds"].as_array().is_some_and(|items| items.iter().any(|item| item["tag"] == "block" && item["protocol"] == "blackhole")) {
        return Json(json!({"success":false,"error":"Для блокировки рекламы нужен существующий выход block (blackhole)"}));
    }
    let global = old_rules.iter().find(|rule| rule["ruleTag"].as_str().is_some_and(|tag| tag.split('|').next() == Some("VPN"))).cloned()
        .unwrap_or(json!({"type":"field","ruleTag":"VPN|split","network":"tcp,udp","outboundTag":"direct"}));
    let mut rules: Vec<Value> = old_rules.iter().filter(|rule| rule["ruleTag"].as_str().unwrap_or("").is_empty()).cloned().collect();
    let device_defaults: Vec<Value> = old_rules.iter().filter(|rule| rule["ruleTag"].as_str().is_some_and(|tag| {
        let base = tag.split('|').next().unwrap_or(""); base.starts_with("device:") && base.ends_with(":VPN")
    })).cloned().collect();
    for default in &device_defaults { rules.extend(template_rules(default)); }
    rules.extend(template_rules(&global));
    config["routing"]["rules"] = Value::Array(rules);
    let content = match serde_json::to_string_pretty(&config) { Ok(value) => value, Err(e) => return Json(json!({"success":false,"error":e.to_string()})) };
    crate::xray_routes::apply_routes(State(state), Json(crate::xray_routes::ApplyRoutesRequest { file:CONFIG.into(), previous_content:previous, content })).await
}

fn template_rules(default: &Value) -> Vec<Value> {
    let mut rules: Vec<Value> = serde_json::from_str(include_str!("routing-template.json")).unwrap();
    let tag = default["ruleTag"].as_str().unwrap_or("VPN");
    let prefix = tag.split('|').next().unwrap_or("VPN").strip_suffix("VPN").unwrap_or("");
    for rule in &mut rules {
        let base = rule["ruleTag"].as_str().unwrap().to_string();
        rule["ruleTag"] = Value::String(format!("{prefix}{base}"));
        if !prefix.is_empty() { rule["sourceIP"] = default["sourceIP"].clone(); }
        if rule["outboundTag"].is_null() {
            if let Some(value) = default.get("outboundTag") { rule["outboundTag"] = value.clone(); }
            if let Some(value) = default.get("balancerTag") { rule["balancerTag"] = value.clone(); }
        }
    }
    *rules.last_mut().unwrap() = default.clone();
    let bypass = default["outboundTag"] == "direct" && !tag.ends_with("|split") && !tag.ends_with("|selector");
    if bypass { let fallback = rules.pop().unwrap(); rules.insert(0, fallback); }
    rules
}
