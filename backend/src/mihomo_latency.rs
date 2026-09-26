use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};
use std::{process::Stdio, sync::OnceLock, time::Duration};
use tokio::sync::Semaphore;
use yaml_rust2::{Yaml, YamlLoader, YamlEmitter};

pub async fn node_mapping() -> Json<Value> {
    let xray = tokio::fs::read_to_string("/opt/etc/xray/configs/00_config.json").await.unwrap_or_default();
    let xray: Value = serde_json::from_str(&xray).unwrap_or(Value::Null);
    let mut nodes: Vec<(String, String, String, String)> = Vec::new();
    let mut files = vec![std::path::PathBuf::from("/opt/etc/mihomo/config.yaml")];
    if let Ok(mut entries) = tokio::fs::read_dir("/opt/etc/mihomo/proxy_providers").await {
        while let Ok(Some(entry)) = entries.next_entry().await {
            if files.len() > 32 { break; }
            if matches!(entry.path().extension().and_then(|s| s.to_str()), Some("yaml" | "yml")) { files.push(entry.path()); }
        }
    }
    for path in files {
        if !tokio::fs::metadata(&path).await.ok().is_some_and(|m| m.is_file() && m.len() <= 1024 * 1024) { continue; }
        let Ok(text) = tokio::fs::read_to_string(path).await else { continue };
        let Ok(docs) = YamlLoader::load_from_str(&text) else { continue };
        if let Some(proxies) = docs.first().and_then(|d| d["proxies"].as_vec()) {
            for proxy in proxies {
                let (Some(name), Some(server), Some(kind)) = (proxy["name"].as_str(), proxy["server"].as_str(), proxy["type"].as_str()) else { continue };
                let port = proxy["port"].as_i64().map(|p| p.to_string()).or_else(|| proxy["port"].as_str().map(str::to_owned));
                if let Some(port) = port { nodes.push((name.into(), server.to_ascii_lowercase(), port, kind.into())); }
            }
        }
    }
    let mut to_mihomo = serde_json::Map::new();
    let mut to_xray = serde_json::Map::new();
    if let Some(outbounds) = xray["outbounds"].as_array() {
        for outbound in outbounds {
            let (Some(tag), Some(server), Some(port), Some(protocol)) = (
                outbound["tag"].as_str(), outbound["settings"]["address"].as_str(),
                outbound["settings"]["port"].as_u64().map(|p| p.to_string()).or_else(|| outbound["settings"]["port"].as_str().map(str::to_owned)),
                outbound["protocol"].as_str(),
            ) else { continue };
            let kind = if protocol == "hysteria" && outbound["settings"]["version"].as_u64() == Some(2) { "hysteria2" } else { protocol };
            if let Some((name, _, _, _)) = nodes.iter().find(|(_, host, node_port, node_kind)| host == &server.to_ascii_lowercase() && node_port == &port && node_kind == kind) {
                to_mihomo.insert(tag.into(), Value::String(name.clone()));
                to_xray.entry(name.clone()).or_insert_with(|| Value::String(tag.into()));
            }
        }
    }
    Json(json!({"success": true, "xrayToMihomo": to_mihomo, "mihomoToXray": to_xray}))
}

static LOCK: OnceLock<Semaphore> = OnceLock::new();
#[derive(Deserialize)]
pub struct Request { name: String }
async fn find_proxy(name: &str) -> Option<Yaml> {
    let mut files = vec![std::path::PathBuf::from("/opt/etc/mihomo/config.yaml")];
    if let Ok(mut entries) = tokio::fs::read_dir("/opt/etc/mihomo/proxy_providers").await {
        while let Ok(Some(entry)) = entries.next_entry().await {
            if files.len() > 32 { break; }
            if matches!(entry.path().extension().and_then(|s| s.to_str()), Some("yaml" | "yml")) { files.push(entry.path()); }
        }
    }
    for path in files {
        if !tokio::fs::metadata(&path).await.ok().is_some_and(|m| m.is_file() && m.len() <= 1024 * 1024) { continue; }
        let Ok(text) = tokio::fs::read_to_string(path).await else { continue; };
        let Ok(docs) = YamlLoader::load_from_str(&text) else { continue; };
        if let Some(proxies) = docs.first().and_then(|d| d["proxies"].as_vec()) {
            if let Some(proxy) = proxies.iter().find(|p| p["name"].as_str() == Some(name)) { return Some(proxy.clone()); }
        }
    }
    None
}
async fn probe_node(name: &str) -> Result<u32, &'static str> {
    if name == "DIRECT" { return crate::latency::curl_latency(&["--ipv4", "--noproxy", "*"]).await; }
    let proxy = find_proxy(name).await.ok_or("Узел не найден в конфигурации или кеше подписки Mihomo")?;
    if proxy["dialer-proxy"].as_str().is_some() { return Err("Проверка узла с dialer-proxy требует проверки всей цепочки"); }
    let available = std::fs::read_to_string("/proc/meminfo").ok().and_then(|s| s.lines().find_map(|l| l.strip_prefix("MemAvailable:")?.split_whitespace().next()?.parse::<usize>().ok())).unwrap_or(0);
    if available < 100_000 { return Err("Недостаточно свободной RAM для проверки Mihomo"); }
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.map_err(|_| "Не удалось выделить порт проверки")?;
    let port = listener.local_addr().map_err(|_| "Не удалось определить порт")?.port();
    drop(listener);
    let dir = format!("/tmp/xkeen-mihomo-probe-{}", uuid::Uuid::new_v4());
    tokio::fs::create_dir(&dir).await.map_err(|_| "Не удалось создать каталог проверки")?;
    use std::os::unix::fs::PermissionsExt;
    let _ = tokio::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700)).await;
    let result = async {
        let mut document = YamlLoader::load_from_str(&format!("mixed-port: {port}\nbind-address: 127.0.0.1\nallow-lan: false\nlog-level: silent\nmode: rule\nproxies: []\nrules: []\n")).map_err(|_| "Не удалось собрать конфигурацию проверки")?.remove(0);
        document["proxies"] = Yaml::Array(vec![proxy]);
        document["rules"] = Yaml::Array(vec![Yaml::String(format!("MATCH,{name}"))]);
        let mut text = String::new();
        YamlEmitter::new(&mut text).dump(&document).map_err(|_| "Не удалось записать конфигурацию проверки")?;
        let path = format!("{dir}/config.yaml");
        tokio::fs::write(&path, text).await.map_err(|_| "Не удалось записать файл проверки")?;
        let mut cmd = tokio::process::Command::new("/opt/sbin/mihomo");
        cmd.args(["-d", &dir, "-f", &path]).stdout(Stdio::null()).stderr(Stdio::null()).kill_on_drop(true);
        let mut child = cmd.spawn().map_err(|_| "Не удалось запустить проверочный Mihomo")?;
        let result = async {
            let mut ready = false;
            for _ in 0..40 {
                if tokio::net::TcpStream::connect(("127.0.0.1", port)).await.is_ok() { ready = true; break; }
                if child.try_wait().ok().flatten().is_some() { break; }
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
            if !ready { return Err("Mihomo не запустил этот узел: проверьте поддержку протокола и его параметры"); }
            crate::latency::curl_latency(&["--ipv4", "--proxy", &format!("http://127.0.0.1:{port}")]).await
        }.await;
        let _ = child.kill().await;
        let _ = child.wait().await;
        result
    }.await;
    let _ = tokio::fs::remove_dir_all(&dir).await;
    result
}
pub async fn probe(Json(request): Json<Request>) -> Json<Value> {
    if request.name.is_empty() || request.name.len() > 256 { return Json(json!({"success": false, "error": "Недопустимое имя узла"})); }
    let Ok(_guard) = LOCK.get_or_init(|| Semaphore::new(1)).try_acquire() else { return Json(json!({"success": false, "error": "Проверка другого узла уже идёт"})); };
    match probe_node(&request.name).await {
        Ok(delay) => Json(json!({"success": true, "delay": delay, "kind": "HTTP GET via proxy"})),
        Err(error) => {
            crate::logger::log("WARN", format!("Пинг Mihomo {:?}: HTTP GET через выбранный узел не прошёл: {error}", request.name));
            Json(json!({"success": false, "error": error}))
        },
    }
}
