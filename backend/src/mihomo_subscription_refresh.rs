use axum::{Json, extract::State};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{path::Path, process::Stdio, time::Duration};
use yaml_rust2::{Yaml, YamlLoader};

use crate::{logger::log, subscription::{self, SubscriptionRequest}, types::AppState};

const CONFIG: &str = "/opt/etc/mihomo/config.yaml";
const PROVIDER_DIR: &str = "/opt/etc/mihomo/proxy_providers";

fn provider_entries(content: &str) -> Vec<(String, String, String)> {
    let Ok(documents) = YamlLoader::load_from_str(content) else { return Vec::new(); };
    let Some(entries) = documents.first().map(|doc| &doc["proxy-providers"]).and_then(Yaml::as_hash) else { return Vec::new(); };
    entries.iter().filter_map(|(key, value)| {
        if value["type"].as_str() != Some("http") { return None; }
        let url = value["url"].as_str()?;
        let path = value["path"].as_str()?;
        let name = path.strip_prefix("./proxy_providers/")?;
        if name.is_empty() || name.len() > 80 || !name.ends_with(".yaml")
            || !name.chars().all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.'))
            || name.contains("..") { return None; }
        Some((key.as_str()?.to_string(), url.to_string(), format!("{PROVIDER_DIR}/{name}")))
    }).take(8).collect()
}

async fn write_private(path: &str, data: &str) -> std::io::Result<()> {
    let mut options = tokio::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true).mode(0o600);
    let mut file = options.open(path).await?;
    use tokio::io::AsyncWriteExt;
    file.write_all(data.as_bytes()).await?;
    file.sync_all().await
}

async fn refresh(state: &AppState, requested: Option<&str>) -> Result<usize, String> {
    if requested.is_none() && state.core.read().is_ok_and(|core| core.name == "mihomo") { return Ok(0); }
    let config = tokio::fs::read_to_string(CONFIG).await.map_err(|_| "Mihomo YAML не найден")?;
    let providers = provider_entries(&config);
    let mut updated = 0;
    if requested.is_some_and(|name| !providers.iter().any(|(key, _, _)| key == name)) { return Err("Подписка не найдена".into()); }
    for (name, url, path) in providers {
        if requested.is_some_and(|key| key != name) { continue; }
        let response = subscription::download_subscription(SubscriptionRequest { url, allow_lan: true }, "Clash.Meta").await.0;
        let Some(content) = response["content"].as_str() else { return Err(response["error"].as_str().unwrap_or("Не удалось загрузить подписку Mihomo").to_string()); };
        let Ok(documents) = YamlLoader::load_from_str(content) else { return Err("Сервер вернул некорректный YAML Mihomo".into()); };
        let Some(proxies) = documents.first().and_then(|doc| doc["proxies"].as_vec()) else { return Err("Сервер подписки не вернул список proxies для Mihomo".into()); };
        if proxies.is_empty() || proxies.len() > 256 || proxies.iter().any(|proxy| proxy["name"].as_str().is_none() || proxy["type"].as_str().is_none()) { return Err("Некорректный список узлов в подписке".into()); }
        let old = tokio::fs::read_to_string(&path).await.ok();
        if old.as_deref() == Some(content) { continue; }
        if Path::new(&path).parent() != Some(Path::new(PROVIDER_DIR)) { continue; }
        let temp = format!("{path}.auto.tmp");
        write_private(&temp, content).await.map_err(|_| "Не удалось сохранить подписку")?;
        if let Some(ref previous) = old {
            write_private(&format!("{path}.auto-backup"), previous).await.map_err(|_| "Не удалось сохранить предыдущую подписку")?;
        }
        tokio::fs::rename(&temp, &path).await.map_err(|_| "Не удалось заменить кеш подписки")?;
        let mut command = tokio::process::Command::new("/opt/sbin/mihomo");
        command.args(["-t", "-d", "/opt/etc/mihomo", "-f", CONFIG])
            .stdout(Stdio::null()).stderr(Stdio::null()).kill_on_drop(true);
        let valid = tokio::time::timeout(Duration::from_secs(15), command.status()).await
            .ok().and_then(Result::ok).is_some_and(|status| status.success());
        if valid { updated += 1; }
        else {
            if let Some(previous) = old { let _ = write_private(&path, &previous).await; }
            else { let _ = tokio::fs::remove_file(&path).await; }
            return Err("Mihomo отклонил обновлённые узлы; предыдущая подписка восстановлена".into());
        }
    }
    Ok(updated)
}

pub fn start(state: AppState) {
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(3600)).await;
            match refresh(&state, None).await {
                Ok(0) => {},
                Ok(count) => log("INFO", format!("Кеш подписок Mihomo обновлён: {count}")),
                Err(error) => log("WARN", format!("Автообновление Mihomo пропущено: {error}")),
            }
        }
    });
}

#[derive(Deserialize)]
pub struct RefreshRequest { name: String }
pub async fn refresh_provider(State(state): State<AppState>, Json(request): Json<RefreshRequest>) -> Json<Value> {
    match refresh(&state, Some(&request.name)).await {
        Ok(changed) => Json(json!({"success": true, "changed": changed})),
        Err(error) => Json(json!({"success": false, "error": error})),
    }
}
