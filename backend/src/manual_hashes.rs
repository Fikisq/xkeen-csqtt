use axum::{extract::Json, response::Json as ResponseJson};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{sync::OnceLock, time::Duration};
use tokio::sync::Semaphore;

#[derive(Deserialize)]
pub struct GenerateRequest { count: u32 }

static CSQTT_GATE: OnceLock<Semaphore> = OnceLock::new();
static WDTT_GATE: OnceLock<Semaphore> = OnceLock::new();

async fn generate(service: &'static str, count: u32, max: u32, gate: &OnceLock<Semaphore>) -> ResponseJson<Value> {
    if !(1..=max).contains(&count) {
        return ResponseJson(json!({"success": false, "error": format!("Укажите от 1 до {max} хешей")}));
    }
    let Ok(_permit) = gate.get_or_init(|| Semaphore::new(1)).try_acquire() else {
        return ResponseJson(json!({"success": false, "error": "Создание звонков уже выполняется"}));
    };
    let output = tokio::time::timeout(Duration::from_secs(180),
        tokio::process::Command::new("/opt/bin/vk-manual-hashes.sh")
            .args(["generate", service, &count.to_string()])
            .kill_on_drop(true).output()).await;
    match output {
        Ok(Ok(result)) if result.status.success() => {
            let hashes = String::from_utf8_lossy(&result.stdout).trim().to_string();
            if hashes.split(',').count() == count as usize && !hashes.is_empty() {
                ResponseJson(json!({"success": true, "hashes": hashes}))
            } else {
                ResponseJson(json!({"success": false, "error": "VK вернул неполный список хешей"}))
            }
        }
        Ok(Ok(_)) => ResponseJson(json!({"success": false, "error": "VK не создал звонки. Проверьте токен и повторите."})),
        Ok(Err(_)) => ResponseJson(json!({"success": false, "error": "Скрипт создания хешей не установлен"})),
        Err(_) => ResponseJson(json!({"success": false, "error": "Время создания звонков VK истекло"})),
    }
}

pub async fn csqtt(Json(request): Json<GenerateRequest>) -> ResponseJson<Value> {
    generate("csqtt", request.count, 6, &CSQTT_GATE).await
}

pub async fn wdtt_plus(Json(request): Json<GenerateRequest>) -> ResponseJson<Value> {
    generate("wdtt-plus", request.count, 4, &WDTT_GATE).await
}
