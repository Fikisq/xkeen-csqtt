use crate::types::{AppState, VERSION};
use crate::updater::get_repo;
use axum::extract::State;
use axum::response::{IntoResponse, Json};
use serde_json::json;
use std::time::{Duration, Instant};
use tokio::process::Command;
use tokio::time::timeout;

const GITHUB_RELEASE: &str = "https://github.com";

pub async fn get_local_core_version(core: &str) -> Option<String> {
    let arg = if core == "mihomo" { "-v" } else { "version" };
    let mut cmd = Command::new(format!("/opt/sbin/{}", core));
    cmd.arg(arg);
    let out = timeout(Duration::from_secs(5), cmd.output())
        .await
        .ok()?
        .ok()?;

    let s = String::from_utf8_lossy(&out.stdout);
    let p: Vec<&str> = s.split_whitespace().collect();

    let ver = match core {
        "xray" => p.get(1).copied(),
        "mihomo" => p.get(if p.first() == Some(&"mihomo") { 1 } else { 2 }).copied(),
        _ => None,
    }?;

    Some(if ver.starts_with('v') || ver.starts_with("alpha") {
        ver.to_string()
    } else {
        format!("v{}", ver)
    })
}

pub async fn version_handler(State(state): State<AppState>) -> impl IntoResponse {
    let check = |outdated, last: &std::sync::RwLock<Option<Instant>>| {
        outdated && {
            let mut l = last.write().unwrap();
            if l.map_or(true, |t| t.elapsed().as_secs() > 86400) {
                *l = Some(Instant::now());
                true
            } else {
                false
            }
        }
    };

    let core_outdated = *state.update_checker.core_outdated.read().unwrap();

    let current_core = state.core.read().unwrap().name.clone();

    let (xray_version, mihomo_version) = tokio::join!(get_local_core_version("xray"), get_local_core_version("mihomo"));

    let mut res = serde_json::Map::new();

    let core_tag = state.update_checker.core_latest_tag.read().unwrap().clone();

    let make_link = |repo: &str, tag: Option<&str>| -> Option<String> {
        tag.map(|t| format!("{}/{}/releases/tag/{}", GITHUB_RELEASE, repo, t))
    };

    {
        res.insert("xkeen-ui".into(), json!({
            "version": VERSION.trim_start_matches('v'),
            "outdated": false,
            "show_toast": false,
        }));
    }

    let make_core_obj = |v: String, repo: &str, tag: Option<&str>| -> serde_json::Value {
        let mut obj = json!({ "version": v, "outdated": core_outdated, "show_toast": check(core_outdated, &state.update_checker.last_core_toast) });
        if let Some(link) = make_link(repo, tag) {
            obj["link"] = json!(link);
        }
        obj
    };

    if current_core == "mihomo" {
        if let Some(v) = mihomo_version {
            if let Some(repo) = get_repo("mihomo") {
                res.insert("mihomo".into(), make_core_obj(v, repo, core_tag.as_deref()));
            }
        }
        if let Some(v) = xray_version {
            res.insert("xray".into(), json!({ "version": v }));
        }
    } else {
        if let Some(v) = xray_version {
            if let Some(repo) = get_repo("xray") {
                res.insert("xray".into(), make_core_obj(v, repo, core_tag.as_deref()));
            }
        }
        if let Some(v) = mihomo_version {
            res.insert("mihomo".into(), json!({ "version": v }));
        }
    }

    res.insert("success".into(), json!(true));

    Json(res)
}
