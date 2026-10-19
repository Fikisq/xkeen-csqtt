use axum::{extract::{Query, State}, Json};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{sync::OnceLock, time::{Duration, Instant}};
use tokio::sync::Mutex;

use crate::types::{AppState, VERSION};

const URL: &str = "https://api.github.com/repos/Fikisq/xkeen-csqtt/releases?per_page=20";
const CHECK_INTERVAL: Duration = Duration::from_secs(12 * 60 * 60);
type CachedReleases = Option<(Instant, Vec<Value>)>;
static CACHE: OnceLock<Mutex<CachedReleases>> = OnceLock::new();

#[derive(Default, Deserialize)]
pub struct ReleaseQuery { #[serde(default)] refresh: bool }

async fn download(state: &AppState) -> Result<Vec<Value>, String> {
    let mut response = state.http_client.get(URL)
        .header("Accept", "application/vnd.github+json")
        .timeout(Duration::from_secs(15)).send().await
        .map_err(|_| "Не удалось связаться с GitHub")?
        .error_for_status().map_err(|_| "GitHub временно не отдаёт список релизов")?;
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| "Загрузка списка релизов прервана")? {
        if bytes.len() + chunk.len() > 2 * 1024 * 1024 { return Err("Список релизов слишком большой".into()); }
        bytes.extend_from_slice(&chunk);
    }
    let releases: Vec<Value> = serde_json::from_slice(&bytes).map_err(|_| "GitHub вернул некорректный список релизов")?;
    Ok(releases.into_iter().filter(|release| release["draft"] != true)
        .filter_map(|release| {
            let tag = release["tag_name"].as_str()?;
            let url = release["html_url"].as_str()?;
            if !url.starts_with("https://github.com/Fikisq/xkeen-csqtt/releases/tag/") { return None; }
            let installable = crate::panel_update::asset_name().is_some_and(|name| {
                release["assets"].as_array().is_some_and(|assets| {
                    [name, "SHA256SUMS"].iter().all(|required| assets.iter().any(|a| a["name"].as_str() == Some(*required)))
                })
            });
            Some(json!({
                "installable": installable,
                "tag": tag, "name": release["name"].as_str().unwrap_or(tag),
                "prerelease": release["prerelease"].as_bool().unwrap_or(true),
                "publishedAt": release["published_at"].as_str().unwrap_or(""),
                "body": release["body"].as_str().unwrap_or(""), "url": url,
            }))
        }).collect())
}

pub async fn list(State(state): State<AppState>, Query(query): Query<ReleaseQuery>) -> Json<Value> {
    let mut cache = CACHE.get_or_init(|| Mutex::new(None)).lock().await;
    if let Some((checked, releases)) = cache.as_ref() {
        if checked.elapsed() < CHECK_INTERVAL
            && (!query.refresh || checked.elapsed() < Duration::from_secs(60)) {
            return Json(json!({"success":true,"currentVersion":VERSION,"releases":releases,"stale":false}));
        }
    }
    match download(&state).await {
        Ok(releases) => {
            let result = json!({"success":true,"currentVersion":VERSION,"releases":releases,"stale":false});
            *cache = Some((Instant::now(), releases));
            Json(result)
        },
        Err(error) => match cache.as_ref() {
            Some((_, releases)) => Json(json!({"success":true,"currentVersion":VERSION,"releases":releases,"stale":true,"error":error})),
            None => Json(json!({"success":false,"currentVersion":VERSION,"releases":[],"error":error})),
        },
    }
}

/// Refresh independently of whether anyone has the panel open in a browser.
pub fn start(state: AppState) {
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(CHECK_INTERVAL);
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            interval.tick().await;
            let _ = list(State(state.clone()), Query(ReleaseQuery::default())).await;
        }
    });
}
