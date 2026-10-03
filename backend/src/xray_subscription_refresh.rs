use axum::{extract::State, Json};
use base64::Engine;
use serde_json::{json, Value};
use std::{collections::{HashMap, HashSet}, time::Duration};

use crate::{configs, controller, logger::log, subscription::{self, SubscriptionRequest}, types::AppState};

const CONFIG: &str = "/opt/etc/xray/configs/00_config.json";
const BACKUP: &str = "/opt/etc/xkeen/xray-subscription-before-auto.json";

fn uris(content: &str) -> Result<Vec<String>, String> {
    let decoded = if content.contains("://") { content.to_string() } else {
        let raw = content.trim().replace('-', "+").replace('_', "/");
        let padded = format!("{raw}{}", "=".repeat((4 - raw.len() % 4) % 4));
        let bytes = base64::engine::general_purpose::STANDARD.decode(padded).map_err(|_| "Некорректный base64".to_string())?;
        String::from_utf8(bytes).map_err(|_| "Некорректный UTF-8".to_string())?
    };
    let links: Vec<_> = decoded.lines().map(str::trim)
        .filter(|line| ["vless://", "vmess://", "trojan://", "ss://", "hysteria2://", "hy2://"].iter().any(|prefix| line.starts_with(prefix)))
        .map(String::from).collect();
    if links.is_empty() || links.len() > 64 { return Err("Подписка не содержит 1–64 поддерживаемых узла".into()); }
    Ok(links)
}

fn add_string(object: &mut Value, key: &str, value: Option<&str>) {
    if let Some(value) = value.filter(|value| !value.is_empty()) {
        object[key] = Value::String(value.to_string());
    }
}

fn stream(params: &HashMap<String, String>) -> Value {
    let get = |key: &str| params.get(key).map(String::as_str);
    let network = get("type").unwrap_or("tcp");
    let security = get("security").unwrap_or("");
    let mut result = json!({"network": network});
    add_string(&mut result, "security", Some(security));
    if security == "tls" {
        let mut tls = json!({"fingerprint": get("fp").unwrap_or("chrome")});
        add_string(&mut tls, "serverName", get("sni"));
        if let Some(alpn) = get("alpn") { tls["alpn"] = json!(alpn.split(',').collect::<Vec<_>>()); }
        if matches!(get("allowinsecure").or(get("insecure")), Some("1" | "true")) { tls["allowInsecure"] = json!(true); }
        result["tlsSettings"] = tls;
    } else if security == "reality" {
        let mut reality = json!({"fingerprint": get("fp").unwrap_or("chrome")});
        for (key, source) in [("serverName", "sni"), ("publicKey", "pbk"), ("shortId", "sid"), ("spiderX", "spx"), ("mldsa65Verify", "pqv")] {
            add_string(&mut reality, key, get(source));
        }
        result["realitySettings"] = reality;
    }
    match network {
        "xhttp" => {
            let mut xhttp = json!({"path": get("path").unwrap_or("/"), "mode": get("mode").unwrap_or("auto")});
            add_string(&mut xhttp, "host", get("host"));
            if let Some(extra) = get("extra").and_then(|value| serde_json::from_str::<Value>(value).ok()) { xhttp["extra"] = extra; }
            result["xhttpSettings"] = xhttp;
        }
        "ws" => {
            let mut ws = json!({"path": get("path").unwrap_or("/")});
            add_string(&mut ws, "host", get("host"));
            result["wsSettings"] = ws;
        }
        "grpc" => {
            let mut grpc = json!({});
            add_string(&mut grpc, "serviceName", get("servicename").or(get("path")));
            add_string(&mut grpc, "authority", get("authority"));
            if get("mode") == Some("multi") { grpc["multiMode"] = json!(true); }
            result["grpcSettings"] = grpc;
        }
        "httpupgrade" => {
            let mut upgrade = json!({"path": get("path").unwrap_or("/")});
            add_string(&mut upgrade, "host", get("host"));
            result["httpupgradeSettings"] = upgrade;
        }
        "raw" | "tcp" => {
            if let Some(header) = get("headertype") { result[format!("{network}Settings")] = json!({"header": {"type": header}}); }
        }
        _ => {}
    }
    result
}

fn outbound(uri: &str, tag: &str) -> Result<Value, String> {
    let url = reqwest::Url::parse(uri).map_err(|_| "Некорректная ссылка узла".to_string())?;
    let host = url.host_str().ok_or("В ссылке узла нет сервера")?;
    let port = url.port().unwrap_or(443);
    let params: HashMap<String, String> = url.query_pairs().map(|(key, value)| (key.to_ascii_lowercase(), value.into_owned())).collect();
    let get = |key: &str| params.get(key).map(String::as_str);
    let username = urlencoding::decode(url.username()).map_err(|_| "Некорректная кодировка логина")?.into_owned();
    let mut result = match url.scheme() {
        "vless" => {
            let mut settings = json!({"address": host, "port": port, "id": username, "encryption": get("encryption").unwrap_or("none")});
            add_string(&mut settings, "flow", get("flow"));
            json!({"tag": tag, "protocol": "vless", "settings": settings, "streamSettings": stream(&params)})
        }
        "trojan" => json!({"tag": tag, "protocol": "trojan", "settings": {"address": host, "port": port, "password": username}, "streamSettings": stream(&params)}),
        "hysteria2" | "hy2" => {
            let auth = if let Some(password) = url.password() { format!("{username}:{password}") } else { username };
            let mut params = params.clone();
            params.entry("security".into()).or_insert_with(|| "tls".into());
            let mut settings = stream(&params);
            settings["network"] = json!("hysteria");
            settings["hysteriaSettings"] = json!({"auth": auth, "version": 2});
            if settings["tlsSettings"].is_object() && settings["tlsSettings"]["alpn"].is_null() { settings["tlsSettings"]["alpn"] = json!(["h3"]); }
            settings["finalmask"] = params.get("fm").and_then(|value| serde_json::from_str::<Value>(value).ok())
                .unwrap_or_else(|| json!({"quicParams": {"congestion": "bbr", "debug": false}}));
            if let Some(obfs) = get("obfs").filter(|value| !value.is_empty()) {
                if obfs != "salamander" { return Err("Маскировка Hysteria2 не поддерживается в Xray".into()); }
                let password = get("obfs-password").filter(|value| !value.is_empty())
                    .ok_or("Для Salamander не указан пароль маскировки")?;
                let mask = settings["finalmask"].as_object_mut().ok_or("Некорректные настройки FinalMask")?;
                let udp = mask.entry("udp").or_insert_with(|| json!([])).as_array_mut()
                    .ok_or("Некорректный список маскировок FinalMask")?;
                if !udp.iter().any(|item| item["type"].as_str() == Some("salamander")) {
                    udp.push(json!({"type": "salamander", "settings": {"password": password}}));
                }
            }
            json!({"tag": tag, "protocol": "hysteria", "settings": {"address": host, "port": port, "version": 2}, "streamSettings": settings})
        }
        _ => return Err("Неподдерживаемый протокол в подписке".into()),
    };
    if let Some(fragment) = url.fragment().filter(|fragment| !fragment.is_empty()) {
        let decoded = urlencoding::decode(fragment).map(|name| name.into_owned()).unwrap_or_else(|_| fragment.to_string());
        let name: String = decoded.chars().filter(|ch| !ch.is_control()).take(100).collect();
        if !name.is_empty() { result["xkeenDisplayName"] = json!(name); }
    }
    Ok(result)
}

fn changed_paths(old: &Value, new: &Value, path: &str, output: &mut Vec<String>) {
    if old == new || output.len() >= 80 { return; }
    match (old, new) {
        (Value::Object(a), Value::Object(b)) => {
            for key in a.keys().chain(b.keys()) {
                if !a.contains_key(key) || !b.contains_key(key) || a.get(key) != b.get(key) {
                    changed_paths(a.get(key).unwrap_or(&Value::Null), b.get(key).unwrap_or(&Value::Null), &format!("{path}.{key}"), output);
                }
            }
        }
        (Value::Array(a), Value::Array(b)) => {
            for index in 0..a.len().max(b.len()) {
                changed_paths(a.get(index).unwrap_or(&Value::Null), b.get(index).unwrap_or(&Value::Null), &format!("{path}[{index}]"), output);
            }
        }
        _ => output.push(path.to_string()),
    }
}

async fn refresh(state: &AppState, apply: bool, diagnostics: &mut Vec<String>) -> Result<bool, String> {
    let entries = configs::read_xray_subscriptions().await;
    if entries.is_empty() { return Ok(false); }
    let mut downloaded = Vec::new();
    for entry in &entries {
        let response = subscription::preview_subscription(Json(SubscriptionRequest { url: entry.url.clone(), allow_lan: entry.allow_lan })).await.0;
        let content = response["content"].as_str().ok_or("Не удалось загрузить подписку Xray")?;
        downloaded.push(uris(content)?);
    }
    let _guard = state.app_config_lock.lock().await;
    let original = tokio::fs::read_to_string(CONFIG).await.map_err(|_| "Конфигурация Xray не найдена")?;
    let mut config: Value = serde_json::from_str(&original).map_err(|_| "Некорректный JSON Xray")?;
    let mut outbounds = config["outbounds"].as_array().cloned().ok_or("Нет outbounds Xray")?;
    for (entry, links) in entries.into_iter().zip(downloaded) {
        let prefix = if entry.id == "legacy" { "sub-".to_string() } else { format!("sub-{}-", entry.id) };
        let generated: Vec<_> = links.iter().enumerate().map(|(index, uri)| {
            let tag = format!("{prefix}{:02}", index + 1);
            outbound(uri, &tag)
        }).collect::<Result<_, _>>()?;
        let belongs = |tag: &str| if entry.id == "legacy" {
            tag.strip_prefix("sub-").is_some_and(|suffix| suffix.chars().all(|ch| ch.is_ascii_digit()))
        } else { tag.starts_with(&prefix) };
        let old: Vec<_> = outbounds.iter().filter(|node| node["tag"].as_str().is_some_and(belongs)).collect();
        if old.is_empty() { return Err("Сохранённые узлы подписки не найдены; требуется ручное обновление".into()); }
        outbounds.retain(|node| !node["tag"].as_str().is_some_and(belongs));
        outbounds.splice(0..0, generated);
    }
    if outbounds.iter().filter(|node| node["tag"].as_str().is_some_and(|tag| tag.starts_with("sub-"))).count() > 64 {
        return Err("Превышен лимит 64 узла Xray".into());
    }
    let tags: HashSet<_> = outbounds.iter().filter_map(|node| node["tag"].as_str()).collect();
    if config["routing"]["rules"].as_array().is_some_and(|rules| rules.iter().any(|rule| {
        rule["outboundTag"].as_str().is_some_and(|tag| tag.starts_with("sub-") && !tags.contains(tag))
    })) { return Err("Новый список удаляет используемый узел; требуется ручное обновление".into()); }
    config["outbounds"] = json!(outbounds);
    let updated = serde_json::to_string_pretty(&config).map_err(|_| "Не удалось собрать JSON Xray")?;
    let previous: Value = serde_json::from_str(&original).map_err(|_| "Некорректный JSON Xray")?;
    if previous == config { return Ok(false); }
    changed_paths(&previous, &config, "root", diagnostics);
    let files = configs::xray_files_with_replacement(CONFIG, &updated).await;
    configs::validate_core("xray", &files).await.map_err(|_| "Новая подписка не прошла проверку Xray")?;
    if !apply { return Ok(true); }
    let backup = format!("{BACKUP}.tmp");
    write_private(&backup, &original).await.map_err(|_| "Не удалось сохранить резервную копию")?;
    tokio::fs::rename(&backup, BACKUP).await.map_err(|_| "Не удалось сохранить резервную копию")?;
    let temp = format!("{CONFIG}.auto.tmp");
    write_private(&temp, &updated).await.map_err(|_| "Не удалось записать новые узлы")?;
    tokio::fs::rename(&temp, CONFIG).await.map_err(|_| "Не удалось заменить узлы")?;
    if state.core.read().is_ok_and(|core| core.name == "xray") {
        if let Err(error) = controller::soft_restart("xray").await {
            let _ = write_private(CONFIG, &original).await;
            let _ = controller::soft_restart("xray").await;
            return Err(format!("Xray не запустился после обновления: {error}"));
        }
    }
    Ok(true)
}

pub async fn dry_run(State(state): State<AppState>) -> Json<Value> {
    let mut diagnostics = Vec::new();
    match refresh(&state, false, &mut diagnostics).await {
        Ok(changed) => Json(json!({"success": true, "changed": changed, "changedPaths": diagnostics})),
        Err(error) => Json(json!({"success": false, "error": error})),
    }
}

async fn write_private(path: &str, data: &str) -> std::io::Result<()> {
    let mut options = tokio::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true).mode(0o600);
    let mut file = options.open(path).await?;
    use tokio::io::AsyncWriteExt;
    file.write_all(data.as_bytes()).await?;
    file.sync_all().await
}

pub fn start(state: AppState) {
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(3600)).await;
            match refresh(&state, true, &mut Vec::new()).await {
                Ok(true) => log("INFO", "Подписки Xray обновлены автоматически".into()),
                Ok(false) => {},
                Err(error) => log("WARN", format!("Автообновление Xray пропущено: {error}")),
            }
        }
    });
}
