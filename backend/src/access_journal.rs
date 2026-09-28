use axum::{Json, extract::State, http::StatusCode, response::IntoResponse};
use serde::Serialize;
use chrono::Datelike;
use std::{collections::HashMap, fs::OpenOptions, io::Write, net::{IpAddr, SocketAddr}, os::unix::fs::OpenOptionsExt, process::Command, sync::Mutex};
use axum::extract::ConnectInfo;

use crate::types::AppState;

const JOURNAL: &str = "/opt/var/log/xkeen-ui-access.jsonl";
static WRITE_LOCK: Mutex<()> = Mutex::new(());

#[derive(Clone, Serialize, serde::Deserialize)]
pub struct AccessEvent {
    pub time: String,
    pub source: String,
    pub result: String,
    pub ip: String,
    pub external: bool,
}

pub fn is_external(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => !ip.is_private() && !ip.is_loopback() && !ip.is_link_local()
            && !ip.is_broadcast() && !ip.is_documentation() && !ip.is_multicast()
            && !ip.is_unspecified() && !(ip.octets()[0] == 100 && (64..=127).contains(&ip.octets()[1])),
        IpAddr::V6(ip) => !ip.is_loopback() && !ip.is_unique_local() && !ip.is_unicast_link_local()
            && !ip.is_multicast() && !ip.is_unspecified(),
    }
}

pub fn record(source: &str, result: &str, ip: IpAddr) {
    let _guard = WRITE_LOCK.lock().unwrap();
    if let Ok(metadata) = std::fs::metadata(JOURNAL) {
        if metadata.len() > 512 * 1024 {
            let _ = std::fs::rename(JOURNAL, format!("{JOURNAL}.1"));
        }
    }
    if let Ok(mut file) = OpenOptions::new().append(true).create(true).mode(0o600).open(JOURNAL) {
        let event = AccessEvent {
            time: chrono::Utc::now().to_rfc3339(),
            source: source.into(), result: result.into(), ip: ip.to_string(), external: is_external(ip),
        };
        if let Ok(line) = serde_json::to_string(&event) {
            let _ = writeln!(file, "{line}");
        }
    }
}

fn ssh_events() -> Vec<AccessEvent> {
    let Ok(output) = Command::new("/bin/ndmc").args(["-c", "show log"]).output() else {
        return vec![];
    };
    if !output.status.success() || output.stdout.len() > 2_000_000 { return vec![]; }
    let content = String::from_utf8_lossy(&output.stdout);
    let mut clients: HashMap<String, String> = HashMap::new();
    let mut result = Vec::new();
    for line in content.lines() {
        let Some(start) = line.find("dropbear[") else { continue };
        let rest = &line[start + 9..];
        let Some((pid, message)) = rest.split_once("]:") else { continue };
        if !pid.bytes().all(|c| c.is_ascii_digit()) { continue }
        let message = message.trim();
        let stamp = line.split(']').next().unwrap_or("").trim_start_matches(|c| c != '[').trim_start_matches('[');
        let year = chrono::Utc::now().year();
        let parsed_time = chrono::NaiveDateTime::parse_from_str(&format!("{year} {stamp}"), "%Y %b %e %H:%M:%S")
            .ok().map(|t| t.and_utc().to_rfc3339()).unwrap_or_else(|| stamp.into());
        if let Some(addr) = message.strip_prefix("Child connection from ") {
            if let Some(ip) = addr.rsplit_once(':').map(|v| v.0) {
                clients.insert(pid.into(), ip.into());
            }
            continue;
        }
        let outcome = if message.contains("auth succeeded") { "успешный вход" }
            else if message.contains("Bad password") || message.contains("auth failed") { "неудачный вход" }
            else { continue };
        let Some(ip) = clients.get(pid) else { continue };
        let Ok(parsed) = ip.parse::<IpAddr>() else { continue };
        result.push(AccessEvent {
            time: parsed_time, source: "SSH".into(), result: outcome.into(),
            ip: ip.clone(), external: is_external(parsed),
        });
    }
    result
}

pub async fn get_access_journal(State(state): State<AppState>, ConnectInfo(addr): ConnectInfo<SocketAddr>) -> impl IntoResponse {
    if !state.settings.read().unwrap().auth.enabled && is_external(addr.ip()) {
        return (StatusCode::FORBIDDEN, Json(serde_json::json!({"error": "Журнал с внешнего адреса доступен только после включения авторизации"}))).into_response();
    }
    let events = tokio::task::spawn_blocking(|| {
        let mut events: Vec<AccessEvent> = [format!("{JOURNAL}.1"), JOURNAL.into()].iter()
            .flat_map(|path| std::fs::read_to_string(path).unwrap_or_default().lines()
                .filter_map(|line| serde_json::from_str(line).ok()).collect::<Vec<_>>())
            .collect();
        events.extend(ssh_events());
        events.sort_by(|a, b| b.time.cmp(&a.time));
        events.truncate(200);
        events
    }).await.unwrap_or_default();
    Json(serde_json::json!({"events": events, "ssh_history_limited": true})).into_response()
}
