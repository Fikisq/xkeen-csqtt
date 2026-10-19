use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{collections::HashMap, io::{BufRead, BufReader}, net::Ipv4Addr, sync::OnceLock, time::{Duration, Instant}};
use tokio::sync::Mutex;

const ROOT: &str = "/opt/etc/xkeen/nfqws2-stage";
const SECONDS: u64 = 90;
static SESSION: OnceLock<Mutex<Option<Session>>> = OnceLock::new();

#[path = "nfqws2_session_flows.rs"]
mod flows;
use flows::Flow;
struct Observation { flow: Flow, first: Instant, last: Instant, tx: Option<u64>, rx: Option<u64>, replied: bool }
struct Session {
    id: String, device: String, service: String, started_at: String, started: Instant,
    stamp: String, running: bool, reason: String, error: Option<String>,
    confirmation: Option<bool>, rows: HashMap<String, Observation>, accounting: bool,
}

fn store() -> &'static Mutex<Option<Session>> { SESSION.get_or_init(|| Mutex::new(None)) }
fn stamp() -> String {
    let mut hash = Sha256::new();
    for name in ["custom-strategy.args", "profile", "nfqws2.pid"] {
        hash.update(name.as_bytes());
        hash.update(std::fs::read(format!("{ROOT}/{name}")).unwrap_or_default());
    }
    format!("{:x}", hash.finalize())
}

fn snapshot(device: &str) -> Result<Vec<Flow>, String> {
    let path = ["/proc/net/nf_conntrack", "/proc/net/ip_conntrack"].into_iter()
        .find(|path| std::path::Path::new(path).exists()).ok_or("На роутере недоступна таблица conntrack")?;
    let file = std::fs::File::open(path).map_err(|_| "Не удалось прочитать conntrack")?;
    let mut flows = Vec::new();
    let source_token = format!("src={device} ");
    for line in BufReader::new(file).lines().take(25000) {
        let line = line.map_err(|_| "Ошибка чтения conntrack")?;
        if !line.contains(&source_token) { continue }
        if let Some(flow) = flows::parse(&line, device) { flows.push(flow); }
        if flows.len() >= 512 { break }
    }
    Ok(flows)
}

fn view(session: &Session) -> Value {
    let changed = !flows::same_strategy(&session.stamp, &stamp());
    let mut rows = session.rows.values().map(|row| json!({
        "id": row.flow.key, "protocol": row.flow.protocol, "remoteIp": row.flow.remote, "port": row.flow.port,
        "sentPackets": row.tx, "receivedPackets": row.rx, "replyObserved": row.replied,
        "waitingSeconds": row.first.elapsed().as_secs(), "lastSeenSecondsAgo": row.last.elapsed().as_secs(),
    })).collect::<Vec<_>>();
    rows.sort_by_key(|row| (row["remoteIp"].as_str().unwrap_or("").to_string(), row["port"].as_u64().unwrap_or(0)));
    let replies = session.rows.values().filter(|row| row.replied).count();
    json!({"success": true, "available": true, "id": session.id, "running": session.running,
        "deviceIp": session.device, "service": session.service, "startedAt": session.started_at,
        "remainingSeconds": if session.running { SECONDS.saturating_sub(session.started.elapsed().as_secs()) } else { 0 },
        "reason": if changed { "strategy-changed" } else { &session.reason }, "error": session.error, "accounting": session.accounting,
        "connectionCount": rows.len(), "connectionsWithReplies": replies, "rows": rows,
        "confirmation": if changed { None } else { session.confirmation }, "strategyStamp": session.stamp,
        "gamesRulesEnabled": std::fs::read_to_string(format!("{ROOT}/custom-strategy.args")).unwrap_or_default().contains("--filter-udp=1024-65535")})
}

pub async fn status() -> Json<Value> {
    let guard = store().lock().await;
    Json(match guard.as_ref() {
        Some(session) => view(session),
        None => json!({"success": true, "running": false, "available": (["/proc/net/nf_conntrack", "/proc/net/ip_conntrack"].iter().any(|path| std::path::Path::new(path).exists()))}),
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartRequest { device_ip: String, service: String }

pub async fn start(Json(request): Json<StartRequest>) -> Json<Value> {
    let Ok(ip) = request.device_ip.parse::<Ipv4Addr>() else { return Json(json!({"success": false, "error": "Укажите локальный IPv4-адрес устройства"})) };
    if !ip.is_private() || ip.octets()[3] == 0 || ip.octets()[3] == 255 || !["roblox", "discord"].contains(&request.service.as_str()) {
        return Json(json!({"success": false, "error": "Нужен адрес устройства локальной сети и сервис Roblox или Discord"}));
    }
    let mut guard = store().lock().await;
    if guard.as_ref().is_some_and(|session| session.running) { return Json(json!({"success": false, "error": "Уже идёт наблюдение сеанса"})); }
    let device = ip.to_string();
    let device_copy = device.clone();
    let baseline = match tokio::task::spawn_blocking(move || snapshot(&device_copy)).await {
        Ok(Ok(flows)) => flows,
        _ => return Json(json!({"success": false, "error": "Не удалось прочитать conntrack; наблюдение недоступно"})),
    };
    let initial: HashMap<_, _> = baseline.into_iter().map(|flow| (flow.key.clone(), flow)).collect();
    let id = uuid::Uuid::new_v4().to_string();
    *guard = Some(Session { id: id.clone(), device: device.clone(), service: request.service,
        started_at: chrono::Utc::now().to_rfc3339(), started: Instant::now(), stamp: stamp(), running: true,
        reason: String::new(), error: None, confirmation: None, rows: HashMap::new(), accounting: false });
    drop(guard);
    let response_id = id.clone();
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(2)).await;
            {
                let mut guard = store().lock().await;
                let Some(session) = guard.as_mut().filter(|session| session.id == id && session.running) else { break };
                if !flows::same_strategy(&session.stamp, &stamp()) { session.running = false; session.reason = "strategy-changed".into(); session.confirmation = None; break }
                if flows::expired(session.started.elapsed().as_secs()) { session.running = false; session.reason = "finished".into(); break }
            }
            let device_copy = device.clone();
            let snapshot = tokio::task::spawn_blocking(move || snapshot(&device_copy)).await;
            let mut guard = store().lock().await;
            let Some(session) = guard.as_mut().filter(|session| session.id == id && session.running) else { break };
            let flows = match snapshot { Ok(Ok(flows)) => flows, _ => { session.running = false; session.error = Some("Не удалось прочитать conntrack".into()); break } };
            for flow in flows {
                let base = initial.get(&flow.key);
                let measurement = flows::activity(&flow, base);
                let (tx, rx, fresh_reply) = (measurement.tx, measurement.rx, measurement.replied);
                if !measurement.active && !session.rows.contains_key(&flow.key) { continue }
                session.accounting |= flow.tx.is_some() && flow.rx.is_some();
                if session.rows.len() >= 128 && !session.rows.contains_key(&flow.key) { continue }
                let row = session.rows.entry(flow.key.clone()).or_insert_with(|| Observation {
                    flow: flow.clone(), first: Instant::now(), last: Instant::now(), tx, rx, replied: false,
                });
                row.last = Instant::now(); row.tx = tx; row.rx = rx; row.replied |= fresh_reply;
            }
        }
    });
    Json(json!({"success": true, "id": response_id}))
}

#[derive(Deserialize)]
pub struct UpdateRequest { id: String, action: String, works: Option<bool> }

pub async fn update(Json(request): Json<UpdateRequest>) -> Json<Value> {
    let mut guard = store().lock().await;
    let Some(session) = guard.as_mut().filter(|session| session.id == request.id) else { return Json(json!({"success": false, "error": "Сеанс уже изменился; обновите окно"})) };
    match request.action.as_str() {
        "stop" => { session.running = false; session.reason = "stopped".into(); },
        "confirm" if !session.running && session.error.is_none() && session.reason != "strategy-changed" && flows::same_strategy(&session.stamp, &stamp()) && request.works.is_some() => session.confirmation = request.works,
        _ => return Json(json!({"success": false, "error": "Сначала завершите наблюдение. После смены стратегии начните новую проверку"})),
    }
    Json(view(session))
}
