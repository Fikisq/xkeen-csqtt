use axum::response::Json;
use serde_json::{json, Value};
use std::collections::HashMap;
use yaml_rust2::{Yaml, YamlLoader};

const PROVIDERS: &str = "/opt/etc/mihomo/proxy_providers";
const MAX_PROVIDER_BYTES: u64 = 256 * 1024;

fn transport(proxy: &Yaml) -> Option<String> {
    let kind = proxy["type"].as_str()?.to_ascii_lowercase();
    let text = match kind.as_str() {
        "hysteria2" | "hy2" => "Hysteria2 · TLS / QUIC".to_string(),
        "tuic" => "TUIC · TLS / QUIC".to_string(),
        "vless" => {
            let network = proxy["network"].as_str().unwrap_or("tcp").to_ascii_lowercase();
            let transport = match network.as_str() {
                "tcp" | "raw" => "TCP".to_string(),
                "xhttp" => "XHTTP".to_string(),
                other => other.to_ascii_uppercase(),
            };
            let security = if !proxy["reality-opts"].is_badvalue() { "REALITY" }
                else if proxy["tls"].as_bool() == Some(true) { "TLS" }
                else { "" };
            if security.is_empty() { format!("VLESS · {transport}") }
            else { format!("VLESS · {transport} / {security}") }
        }
        _ => return None,
    };
    Some(text)
}

pub async fn get_node_metadata() -> Json<Value> {
    let mut nodes = HashMap::<String, String>::new();
    if let Ok(mut entries) = tokio::fs::read_dir(PROVIDERS).await {
        for _ in 0..16 {
            let Ok(Some(entry)) = entries.next_entry().await else { break };
            let path = entry.path();
            if !matches!(path.extension().and_then(|ext| ext.to_str()), Some("yaml" | "yml")) { continue; }
            let Ok(meta) = entry.metadata().await else { continue };
            if !meta.is_file() || meta.len() > MAX_PROVIDER_BYTES { continue; }
            let Ok(content) = tokio::fs::read_to_string(path).await else { continue };
            let Ok(documents) = YamlLoader::load_from_str(&content) else { continue };
            for proxy in documents.first().and_then(|doc| doc["proxies"].as_vec()).into_iter().flatten() {
                let Some(name) = proxy["name"].as_str() else { continue };
                if name.len() > 120 { continue; }
                if let Some(label) = transport(proxy) { nodes.insert(name.to_string(), label); }
            }
        }
    }
    Json(json!({ "success": true, "nodes": nodes }))
}
