use crate::configs::{validate_core, xray_files_with_replacement};
use crate::controller;
use crate::device_bypass;
use crate::nfqws2;
use crate::types::AppState;
use axum::{extract::State, Json};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{process::Stdio, sync::OnceLock, time::Duration};
use tokio::{io::AsyncWriteExt, process::Command, sync::Mutex};

const CONFIG_FILE: &str = "/opt/etc/xray/configs/00_config.json";
const API_LISTEN: &str = "127.0.0.1:18085";
static ROUTE_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

#[derive(Deserialize)]
pub struct ApplyRoutesRequest {
    pub(crate) file: String,
    pub(crate) previous_content: String,
    pub(crate) content: String,
}

fn routing_api_enabled(config: &Value) -> bool {
    config.pointer("/api/listen").and_then(Value::as_str) == Some(API_LISTEN)
        && config.pointer("/api/services").and_then(Value::as_array)
            .is_some_and(|services| services.iter().any(|service| service.as_str() == Some("RoutingService")))
}

async fn replace_live_rules(config: &Value) -> Result<(), String> {
    let routing = config.get("routing").ok_or("В JSON нет маршрутизации")?;
    let input = serde_json::to_vec(&json!({ "routing": routing })).map_err(|e| e.to_string())?;
    let mut command = Command::new("/opt/sbin/xray");
    command.args(["api", "adrules", "-s", API_LISTEN, "-t", "12", "stdin:"])
        .env("XRAY_LOCATION_ASSET", "/opt/etc/xray/dat")
        .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
    let mut child = command.spawn().map_err(|e| format!("Не удалось вызвать API Xray: {e}"))?;
    let Some(mut stdin) = child.stdin.take() else { return Err("Не удалось передать правила Xray".into()) };
    stdin.write_all(&input).await.map_err(|e| format!("Не удалось передать правила Xray: {e}"))?;
    drop(stdin);
    let output = tokio::time::timeout(Duration::from_secs(18), child.wait_with_output()).await
        .map_err(|_| "API Xray не ответил за 18 секунд".to_string())?
        .map_err(|e| format!("Ошибка API Xray: {e}"))?;
    if output.status.success() { return Ok(()) }
    let error = String::from_utf8_lossy(&output.stderr);
    Err(format!("Xray не принял правила: {}", error.trim().chars().take(300).collect::<String>()))
}

pub async fn apply_routes(State(state): State<AppState>, Json(request): Json<ApplyRoutesRequest>) -> Json<Value> {
    let _guard = ROUTE_LOCK.get_or_init(|| Mutex::new(())).lock().await;
    if state.core.read().unwrap().name != "xray" || request.file != CONFIG_FILE {
        return Json(json!({ "success": false, "error": "Доступен только активный Xray 00_config.json" }));
    }
    if request.content.len() > 2_000_000 || request.previous_content.len() > 2_000_000 {
        return Json(json!({ "success": false, "error": "Слишком большой JSON" }));
    }
    let Ok(current) = tokio::fs::read_to_string(CONFIG_FILE).await else {
        return Json(json!({ "success": false, "error": "Не удалось прочитать текущий JSON" }));
    };
    if current != request.previous_content {
        return Json(json!({ "success": false, "error": "Конфигурация уже изменилась. Обновите страницу" }));
    }
    let Ok(old_config) = serde_json::from_str::<Value>(&current) else {
        return Json(json!({ "success": false, "error": "Текущий JSON повреждён" }));
    };
    let Ok(new_config) = serde_json::from_str::<Value>(&request.content) else {
        return Json(json!({ "success": false, "error": "Новый JSON повреждён" }));
    };
    if !routing_api_enabled(&old_config) || !routing_api_enabled(&new_config) {
        return Json(json!({ "success": false, "error": "Локальный API маршрутизации Xray не включён" }));
    }
    let mut old_without_routes = old_config.clone();
    let mut new_without_routes = new_config.clone();
    old_without_routes.as_object_mut().unwrap().remove("routing");
    new_without_routes.as_object_mut().unwrap().remove("routing");
    if old_without_routes != new_without_routes {
        return Json(json!({ "success": false, "error": "Без перезапуска можно менять только маршрутизацию" }));
    }
    let files = xray_files_with_replacement(CONFIG_FILE, &request.content).await;
    if files.iter().any(|item| item.file != CONFIG_FILE && serde_json::from_str::<Value>(&item.content).ok()
        .and_then(|value| value.get("routing").cloned()).is_some()) {
        return Json(json!({ "success": false, "error": "Маршрутизация разделена между файлами; требуется обычное применение" }));
    }
    if let Err(error) = validate_core("xray", &files).await {
        return Json(json!({ "success": false, "error": format!("Проверка Xray не пройдена: {}", error.chars().take(200).collect::<String>()) }));
    }
    if let Err(error) = replace_live_rules(&new_config).await {
        // AddRule can time out after Xray has accepted some rules. Restart from
        // the still-saved config so the live rules cannot diverge from disk.
        let recovery = controller::run_init_command(&state, &["restart", "on"]).await;
        let detail = match recovery {
            Ok(()) => format!("{error}. Прежняя маршрутизация восстановлена; повторите сохранение"),
            Err(recovery_error) => format!("{error}. Восстановление Xray не удалось: {recovery_error}"),
        };
        return Json(json!({ "success": false, "error": detail }));
    }
    let previous_bypass = match device_bypass::apply_for_config(&new_config).await {
        Ok(previous) => previous,
        Err(error) => {
            _ = replace_live_rules(&old_config).await;
            return Json(json!({ "success": false, "error": error }));
        }
    };
    if let Err(error) = nfqws2::sync_transition(&old_config, &new_config).await {
        device_bypass::restore(&previous_bypass).await;
        _ = replace_live_rules(&old_config).await;
        return Json(json!({ "success": false, "error": error }));
    }
    let temporary = format!("{CONFIG_FILE}.{}.tmp", uuid::Uuid::new_v4());
    let write_result = async {
        tokio::fs::write(&temporary, &request.content).await.map_err(|e| e.to_string())?;
        let permissions = tokio::fs::metadata(CONFIG_FILE).await.map_err(|e| e.to_string())?.permissions();
        tokio::fs::set_permissions(&temporary, permissions).await.map_err(|e| e.to_string())?;
        tokio::fs::rename(&temporary, CONFIG_FILE).await.map_err(|e| e.to_string())
    }.await;
    if let Err(error) = write_result {
        _ = tokio::fs::remove_file(&temporary).await;
        _ = nfqws2::sync_transition(&new_config, &old_config).await;
        device_bypass::restore(&previous_bypass).await;
        _ = replace_live_rules(&old_config).await;
        return Json(json!({ "success": false, "error": format!("Не удалось сохранить JSON: {error}") }));
    }
    Json(json!({ "success": true }))
}
