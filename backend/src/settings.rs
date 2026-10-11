use crate::types::*;
use axum::extract::State;
use axum::response::{IntoResponse, Json};

pub async fn get_settings(State(state): State<AppState>) -> impl IntoResponse {
    let s = state.settings.read().unwrap();
    Json(
        serde_json::json!({ "success": true, "log": s.log, "auth": { "enabled": s.auth.enabled } }),
    )
}

pub async fn patch_settings(State(state): State<AppState>, Json(patch): Json<serde_json::Value>) -> impl IntoResponse {
    let _guard = state.app_config_lock.lock().await;
    let mut file_json = tokio::fs::read_to_string(APP_CONFIG)
        .await
        .ok()
        .and_then(|c| serde_json::from_str(&c).ok())
        .unwrap_or(serde_json::json!({}));

    let patch_sets_tz = patch.get("log").and_then(|l| l.get("timezone")).is_some();

    if !patch.as_object().is_some_and(|object| object.keys().all(|key| ["auth", "log"].contains(&key.as_str()))) { return Json(serde_json::json!({"success": false, "error": "Неизвестная настройка"})); }
    for (section, field) in [("auth", "enabled"), ("log", "timezone")] {
        if patch.get(section).is_some_and(|value| !value.as_object().is_some_and(|object| object.keys().all(|key| key == field))) {
            return Json(serde_json::json!({"success": false, "error": "Неизвестная настройка"}));
        }
    }
    json_merge(&mut file_json, patch);
    if let Some(object) = file_json.as_object_mut() { for key in ["gui", "clash_api", "updater"] { object.remove(key); } }

    if let serde_json::Value::Object(ref mut map) = file_json {
        if let Some(legacy) = map.remove("timezoneOffset") {
            if !patch_sets_tz {
                if let Some(log) = map.entry("log").or_insert(serde_json::json!({})).as_object_mut() {
                    log.insert("timezone".into(), legacy);
                }
            }
        }
    }

    let settings: AppSettings = match serde_json::from_value(file_json.clone()) {
        Ok(s) => s,
        Err(e) => return Json(serde_json::json!({"success": false, "error": e.to_string()})),
    };

    if settings.log.timezone < -12 || settings.log.timezone > 14 {
        return Json(serde_json::json!({"success": false, "error": "Неверный часовой пояс"}));
    }



    if let Err(e) = tokio::fs::create_dir_all(XKEEN_CONF_DIR).await {
        return Json(serde_json::json!({"success": false, "error": e.to_string()}));
    }

    let serialized = serde_json::to_string_pretty(&file_json).unwrap();
    let tmp = format!("{}.tmp", APP_CONFIG);
    match tokio::fs::write(&tmp, &serialized).await {
        Ok(_) => match tokio::fs::rename(&tmp, APP_CONFIG).await {
            Ok(_) => { *state.settings.write().unwrap() = settings; Json(serde_json::json!({"success": true})) },
            Err(e) => Json(serde_json::json!({"success": false, "error": e.to_string()})),
        },
        Err(e) => Json(serde_json::json!({"success": false, "error": e.to_string()})),
    }
}

fn json_merge(a: &mut serde_json::Value, b: serde_json::Value) {
    match (a, b) {
        (serde_json::Value::Object(a), serde_json::Value::Object(b)) => {
            for (k, v) in b {
                json_merge(a.entry(k).or_insert(serde_json::Value::Null), v);
            }
        }
        (a, b) => *a = b,
    }
}
