use axum::Json;
use serde::Deserialize;
use serde_json::{Value, json};
use std::os::unix::fs::OpenOptionsExt;
use std::path::Path;
use std::process::Stdio;
use std::sync::OnceLock;
use std::time::Duration;
use tokio::process::Command;
use tokio::sync::Semaphore;

const XRAY_CONFIG: &str = "/opt/etc/xray/configs/00_config.json";
const TEST_URL: &str = "https://cp.cloudflare.com/";
static PROBE_LOCK: OnceLock<Semaphore> = OnceLock::new();

#[derive(Deserialize)]
pub struct LatencyRequest {
    tag: String,
}

fn free_memory_kib() -> usize {
    std::fs::read_to_string("/proc/meminfo").ok()
        .and_then(|content| content.lines().find_map(|line| {
            line.strip_prefix("MemAvailable:")?.split_whitespace().next()?.parse().ok()
        })).unwrap_or(0)
}

pub(crate) async fn curl_latency(interface_or_proxy: &[&str]) -> Result<u32, &'static str> {
    let mut command = Command::new("/opt/bin/curl");
    command.args(interface_or_proxy)
        .args(["--silent", "--output", "/dev/null", "--write-out", "%{http_code} %{time_total}",
            "--connect-timeout", "5", "--max-time", "9", TEST_URL])
        .stdout(Stdio::piped()).stderr(Stdio::null()).kill_on_drop(true);
    let output = tokio::time::timeout(Duration::from_secs(11), command.output()).await
        .map_err(|_| "Время проверки истекло")?
        .map_err(|_| "Не удалось запустить проверку")?;
    if !output.status.success() {
        return Err(if output.status.code() == Some(28) {
            "Тайм-аут HTTP GET через выбранный узел"
        } else {
            "HTTP GET через выбранный узел не прошёл"
        });
    }
    let result = String::from_utf8_lossy(&output.stdout);
    let mut parts = result.split_whitespace();
    let status: u16 = parts.next().and_then(|part| part.parse().ok()).unwrap_or(0);
    let seconds: f64 = parts.next().and_then(|part| part.parse().ok()).unwrap_or(0.0);
    if !(200..400).contains(&status) || !seconds.is_finite() || seconds <= 0.0 {
        return Err("Узел не вернул успешный HTTP-ответ");
    }
    Ok((seconds * 1000.0).round() as u32)
}

async fn xray_latency(outbound: Value) -> Result<u32, &'static str> {
    if free_memory_kib() < 140_000 { return Err("Недостаточно свободной RAM для проверки Xray"); }
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.map_err(|_| "Не удалось выделить локальный порт")?;
    let port = listener.local_addr().map_err(|_| "Не удалось определить локальный порт")?.port();
    drop(listener);
    let path = format!("/tmp/xkeen-xray-probe-{}.json", uuid::Uuid::new_v4());
    let config = json!({
        "log": { "loglevel": "none" },
        "inbounds": [{ "tag": "probe", "listen": "127.0.0.1", "port": port, "protocol": "http", "settings": {} }],
        "outbounds": [outbound]
    });
    let mut file = std::fs::OpenOptions::new().write(true).create_new(true).mode(0o600)
        .open(&path).map_err(|_| "Не удалось создать временную конфигурацию")?;
    if serde_json::to_writer(&mut file, &config).is_err() {
        _ = std::fs::remove_file(&path);
        return Err("Не удалось записать временную конфигурацию");
    }
    drop(file);
    let mut command = Command::new("/opt/sbin/xray");
    command.args(["run", "-c", &path]).stdout(Stdio::null()).stderr(Stdio::null()).kill_on_drop(true);
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(_) => { _ = std::fs::remove_file(&path); return Err("Не удалось запустить проверочный Xray"); }
    };
    let result = async {
        let mut ready = false;
        for _ in 0..25 {
            if tokio::net::TcpStream::connect(("127.0.0.1", port)).await.is_ok() { ready = true; break; }
            if child.try_wait().ok().flatten().is_some() { break; }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        if !ready { return Err("Проверочный Xray не запустился"); }
        let proxy = format!("http://127.0.0.1:{port}");
        curl_latency(&["--proxy", &proxy]).await
    }.await;
    _ = child.kill().await;
    _ = std::fs::remove_file(&path);
    result
}

pub async fn test_latency(Json(request): Json<LatencyRequest>) -> Json<Value> {
    let guard = PROBE_LOCK.get_or_init(|| Semaphore::new(1));
    let Ok(_permit) = guard.try_acquire() else {
        return Json(json!({"success": false, "error": "Проверка другого узла уже идёт"}));
    };
    if request.tag.len() > 128 || request.tag.is_empty() {
        return Json(json!({"success": false, "error": "Неизвестный узел"}));
    }
    let result = if request.tag.eq_ignore_ascii_case("csqtt") {
        if !Path::new("/sys/class/net/csqtt0").exists() {
            return Json(json!({"success": false, "error": "CSQTT остановлен: интерфейс csqtt0 отсутствует"}));
        }
        curl_latency(&["--ipv4", "--noproxy", "*", "--interface", "csqtt0"]).await
    } else if request.tag == "wdtt-plus" {
        if tokio::net::TcpStream::connect("127.0.0.1:1088").await.is_err() {
            return Json(json!({"success": false, "error": "WDTT Plus остановлен: SOCKS5 недоступен"}));
        }
        curl_latency(&["--ipv4", "--socks5-hostname", "127.0.0.1:1088"]).await
    } else if request.tag == "direct" {
        curl_latency(&["--noproxy", "*"]).await
    } else {
        let content = match tokio::fs::read_to_string(XRAY_CONFIG).await {
            Ok(content) => content,
            Err(_) => return Json(json!({"success": false, "error": "Конфигурация Xray не найдена"})),
        };
        let parsed: Value = match serde_json::from_str(&content) {
            Ok(value) => value,
            Err(_) => return Json(json!({"success": false, "error": "Конфигурация Xray не читается"})),
        };
        let outbound = parsed.get("outbounds").and_then(Value::as_array)
            .and_then(|outbounds| outbounds.iter().find(|item| item.get("tag").and_then(Value::as_str) == Some(request.tag.as_str())))
            .cloned();
        match outbound {
            Some(outbound) if matches!(outbound.get("protocol").and_then(Value::as_str), Some("vless" | "hysteria" | "hysteria2" | "tuic")) => xray_latency(outbound).await,
            _ => Err("Узел не найден в конфигурации Xray"),
        }
    };
    match result {
        Ok(latency) => Json(json!({"success": true, "latencyMs": latency})),
        Err(error) => {
            crate::logger::log("WARN", format!("Пинг Xray {:?}: HTTP GET через выбранный узел не прошёл: {error}", request.tag));
            Json(json!({"success": false, "error": error}))
        },
    }
}
