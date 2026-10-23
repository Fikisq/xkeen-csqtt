use std::{fs, io, os::unix::fs::PermissionsExt};
use axum::Json;
use serde::Deserialize;
use serde_json::{Value, json};
use std::time::Duration;

pub fn install() -> io::Result<()> {
    const SCRIPT: &[u8] = include_bytes!("../../router/xkeen-manager");
    const PATH: &str = "/opt/sbin/xkeen-manager";
    if fs::read(PATH).ok().as_deref() != Some(SCRIPT) {
        let temporary = "/opt/sbin/xkeen-manager.install-new";
        fs::write(temporary, SCRIPT)?;
        fs::set_permissions(temporary, fs::Permissions::from_mode(0o755))?;
        fs::rename(temporary, PATH)?;
    }
    Ok(())
}

#[derive(Deserialize)]
pub struct Action {
    action: String,
    component: Option<String>,
}

pub async fn control(Json(request): Json<Action>) -> Json<Value> {
    let action = request.action.as_str();
    let component = request.component.as_deref().unwrap_or("panel");
    if !matches!(action, "status" | "start" | "stop" | "restart" | "log" | "update")
        || !matches!(component, "panel" | "xray" | "mihomo" | "csqtt" | "wdtt-plus" | "nfqws2") {
        return Json(json!({"success":false,"error":"Неизвестное действие или компонент"}));
    }
    // Let the HTTP response arrive before an action stops its own web server.
    if component == "panel" && matches!(action, "start" | "stop" | "restart") {
        let action = action.to_owned();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_secs(1)).await;
            let _ = execute(&action, "panel").await;
        });
        return Json(json!({"success":true,"accepted":true,"output":"Действие запланировано. При остановке панели соединение с консолью закроется."}));
    }
    match execute(action, component).await {
        Ok(output) => Json(json!({"success":true,"output":output})),
        Err(error) => Json(json!({"success":false,"error":error})),
    }
}

async fn execute(action: &str, component: &str) -> Result<String, String> {
    let mut command = tokio::process::Command::new("/opt/sbin/xkeen-manager");
    command.arg(if action == "log" { "log-once" } else { action });
    if action != "update" { command.arg(component); }
    command.stdin(std::process::Stdio::null()).kill_on_drop(true);
    let result = tokio::time::timeout(Duration::from_secs(45), command.output()).await
        .map_err(|_| "Действие не завершилось за 45 секунд. Проверьте статус компонента.".to_string())?
        .map_err(|e| format!("Не удалось запустить управление: {e}"))?;
    let mut output = String::from_utf8_lossy(&result.stdout).into_owned();
    output.push_str(&String::from_utf8_lossy(&result.stderr));
    if output.len() > 32_000 {
        let mut boundary = output.len() - 32_000;
        while !output.is_char_boundary(boundary) { boundary += 1; }
        output = format!("…\n{}", &output[boundary..]);
    }
    if result.status.success() { Ok(output) } else { Err(if output.trim().is_empty() { "Команда завершилась с ошибкой".into() } else { output }) }
}
