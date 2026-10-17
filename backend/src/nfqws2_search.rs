use super::*;
use std::sync::atomic::{AtomicBool, Ordering};

const LIBRARY: &str = "/opt/etc/xkeen/nfqws2-stage/working-strategies.json";
static JOB: OnceLock<Mutex<Value>> = OnceLock::new();
static CANCEL: AtomicBool = AtomicBool::new(false);
pub(super) const GAMES_ARGS: &str = include_str!("../../router/nfqws2-games.args");

fn flowseal() -> Vec<Value> {
    serde_json::from_str::<Value>(include_str!("../../router/nfqws2-flowseal.json")).ok()
        .and_then(|value| value["entries"].as_array().cloned()).unwrap_or_default()
}

fn strategy_name(args: &str) -> Option<String> {
    let args = args.strip_suffix(GAMES_ARGS).unwrap_or(args);
    let entries = flowseal();
    entries.iter().find(|item| item["args"].as_str() == Some(args))
        .or_else(|| entries.iter().find(|item| item["args"].as_str().is_some_and(|full| full.split("--new").next() == args.split("--new").next())))
        .and_then(|item| item["name"].as_str().map(str::to_string))
}

pub fn saved() -> Vec<Value> {
    std::fs::read(LIBRARY).ok().and_then(|bytes| serde_json::from_slice(&bytes).ok()).unwrap_or_default()
}

pub(super) async fn remember(mode: &str, args: &str, report: &Value) -> Result<(), String> {
    if !healthy_report(report, mode) { return Ok(()); }
    let id = strategy_key("preset", mode, args);
    let mut entries = saved();
    entries.retain(|item| item["id"] != id);
    entries.insert(0, json!({"id": id, "name": strategy_name(args), "games": args.contains("--filter-udp=1024-65535"), "mode": mode, "args": args, "checkedAt": report["checkedAt"], "tcpSites": report["tcpSites"], "http3Sites": report["http3Sites"], "results": report["results"]}));
    entries.truncate(16);
    let temp = format!("{LIBRARY}.new");
    tokio::fs::write(&temp, serde_json::to_vec(&entries).map_err(|e| e.to_string())?).await.map_err(|e| e.to_string())?;
    tokio::fs::set_permissions(&temp, std::fs::Permissions::from_mode(0o600)).await.map_err(|e| e.to_string())?;
    tokio::fs::rename(temp, LIBRARY).await.map_err(|e| e.to_string())
}

fn generated_tcp() -> Vec<String> {
    let mut pool = Vec::new();
    if let Ok(args) = std::fs::read_to_string(CUSTOM) {
        if !args.trim().is_empty() { pool.push(args.split("--new").next().unwrap_or(&args).trim().to_string() + "\n"); }
    }
    let mut working = saved();
    working.sort_by_key(|entry| std::cmp::Reverse(entry["tcpSites"].as_u64().unwrap_or(0) * 10 + entry["http3Sites"].as_u64().unwrap_or(0) * 6));
    for entry in working {
        if let Some(args) = entry["args"].as_str() { pool.push(args.split("--new").next().unwrap_or(args).trim().to_string() + "\n"); }
    }
    for entry in flowseal() {
        if let Some(args) = entry["args"].as_str() { pool.push(args.split("--new").next().unwrap_or(args).to_string()); }
    }
    for variant in 0..4 { pool.push(preset_args(variant, "tcp", 0)); }
    for seq in [10000, -10000, 1] {
        for pos in ["1,midsld", "1", "2,midsld"] {
            pool.push(format!("--filter-tcp=443\n--payload=tls_client_hello\n--lua-desync=fake:blob=tls_clienthello:tls_mod=rnd,dupsid,sni=fonts.google.com:tcp_seq={seq}:strategy=1\n--lua-desync=multisplit:pos={pos}:seqovl=1:seqovl_pattern=tls_clienthello:tcp_ts_up:strategy=1\n"));
        }
    }
    for pos in ["1", "1,midsld", "2,midsld"] {
        pool.push(format!("--filter-tcp=443\n--payload=tls_client_hello\n--lua-desync=multidisorder:pos={pos}\n"));
    }
    let mut unique = Vec::new();
    for args in pool {
        if !unique.contains(&args) && candidate(&SettingsRequest { source: "custom".into(), custom_args: args.clone(), allow_tcp_only: false }).is_ok() { unique.push(args); }
    }
    unique.truncate(64);
    unique
}

async fn progress(user: bool, phase: &str, completed: usize, total: usize, candidates: &[Value]) {
    if !user { return; }
    let mut job = JOB.get_or_init(|| Mutex::new(json!({"running": false}))).lock().await;
    job["phase"] = json!(phase); job["completed"] = json!(completed); job["total"] = json!(total);
    job["candidates"] = json!(candidates);
}

pub async fn scan(user: bool, requested_mode: &str) -> Result<(Value, String, String), String> {
    let started = Instant::now();
    let pool = generated_tcp();
    let total = pool.len() + if requested_mode == "tcp-quic" { 6 } else { 0 };
    let mut candidates = Vec::new();
    let mut best: Option<(Value, String, String)> = None;
    for (index, args) in pool.iter().enumerate() {
        if CANCEL.load(Ordering::Relaxed) { return Err("Подбор отменён; активная стратегия сохранена".into()); }
        if started.elapsed() >= Duration::from_secs(60) { break; }
        progress(user, "TCP", index, total, &candidates).await;
        match run_probe_timeout("preset", "tcp", args, 4).await {
            Ok(report) => {
                let score = report["tcpSites"].as_u64().unwrap_or(0);
                candidates.push(json!({"name": strategy_name(args).unwrap_or_else(|| format!("TCP {}", index + 1)), "mode": "tcp", "tcpSites": score, "http3Sites": 0}));
                remember("tcp", args, &report).await?;
                if best.as_ref().is_none_or(|(old, _, _)| score > old["tcpSites"].as_u64().unwrap_or(0)) { best = Some((report, "tcp".into(), args.clone())); }
                if score == 3 { break; }
            }
            Err(error) => candidates.push(json!({"name": format!("TCP {}", index + 1), "mode": "tcp", "error": error})),
        }
    }
    let (tcp_report, _, tcp_args) = best.ok_or_else(|| {
        let cause = candidates.iter().rev().find_map(|item| item["error"].as_str());
        match cause {
            Some(error) => format!("Не удалось проверить ни одного варианта: {error}"),
            None => "Не удалось проверить ни одного варианта".to_string(),
        }
    })?;
    if !healthy_report(&tcp_report, "tcp") { return Err("Не найден вариант с ответом хотя бы от двух сайтов по TCP; активная стратегия сохранена".into()); }
    let mut selected = (tcp_report, "tcp".to_string(), tcp_args.clone());
    if requested_mode == "tcp-quic" {
        let mut quic_args = Vec::new();
        for entry in saved().into_iter().filter(|entry| entry["mode"] == "tcp-quic") {
            if let Some(args) = entry["args"].as_str().and_then(|args| args.strip_suffix(GAMES_ARGS).unwrap_or(args).split_once("--new").map(|(_, udp)| format!("{tcp_args}--new{udp}"))) {
                if !quic_args.contains(&args) { quic_args.push(args); }
            }
        }
        for repeats in [11, 6, 2, 4, 8, 16] {
            let args = format!("{tcp_args}--new\n--filter-udp=443\n--payload=quic_initial\n--lua-desync=fake:blob=quic_initial:repeats={repeats}\n");
            if !quic_args.contains(&args) { quic_args.push(args); }
        }
        for (index, args) in quic_args.iter().take(8).enumerate() {
            if CANCEL.load(Ordering::Relaxed) { return Err("Подбор отменён; активная стратегия сохранена".into()); }
            if started.elapsed() >= Duration::from_secs(90) { break; }
            progress(user, "TCP + QUIC", candidates.len(), total, &candidates).await;
            match run_probe_timeout("preset", "tcp-quic", args, 4).await {
                Ok(report) => {
                    let tcp = report["tcpSites"].as_u64().unwrap_or(0);
                    let h3 = report["http3Sites"].as_u64().unwrap_or(0);
                    candidates.push(json!({"name": format!("QUIC {}", index + 1), "mode": "tcp-quic", "tcpSites": tcp, "http3Sites": h3}));
                    remember("tcp-quic", args, &report).await?;
                    let score = |r: &Value| r["tcpSites"].as_u64().unwrap_or(0) * 10 + r["http3Sites"].as_u64().unwrap_or(0) * 6;
                    if healthy_report(&report, "tcp-quic") && score(&report) > score(&selected.0) { selected = (report, "tcp-quic".into(), args.clone()); }
                    if tcp == 3 && h3 == 3 { break; }
                }
                Err(error) => candidates.push(json!({"name": format!("QUIC {}", index + 1), "mode": "tcp-quic", "error": error})),
            }
        }
    }
    if CANCEL.load(Ordering::Relaxed) { return Err("Подбор отменён; активная стратегия сохранена".into()); }
    progress(user, "Подтверждение результата", candidates.len(), total, &candidates).await;
    let mut report = run_probe_timeout("preset", &selected.1, &selected.2, 8).await?;
    if CANCEL.load(Ordering::Relaxed) { return Err("Подбор отменён; активная стратегия сохранена".into()); }
    if !healthy_report(&report, &selected.1) { return Err("Повторная проверка не подтвердила выбранный вариант; активная стратегия сохранена".into()); }
    report["candidates"] = json!(candidates);
    report["durationSeconds"] = json!(started.elapsed().as_secs());
    remember(&selected.1, &selected.2, &report).await?;
    Ok((report, selected.1, selected.2))
}

#[derive(Deserialize)]
pub struct SearchRequest { mode: String, #[serde(default)] games: bool }

pub async fn start(Json(request): Json<SearchRequest>) -> Json<Value> {
    if !matches!(request.mode.as_str(), "tcp" | "tcp-quic") || !Path::new(ROOT).is_dir() { return Json(json!({"success": false, "error": "Выберите TCP или TCP + QUIC; nfqws2 должен быть установлен"})); }
    let Ok(guard) = SETTINGS_LOCK.get_or_init(|| Mutex::new(())).try_lock() else { return Json(json!({"success": false, "error": "Проверка или управление nfqws2 уже выполняется"})); };
    if let Err(error) = probe_ready().await { return Json(json!({"success": false, "error": error})); }
    CANCEL.store(false, Ordering::Relaxed);
    *JOB.get_or_init(|| Mutex::new(json!({}))).lock().await = json!({"running": true, "phase": "Подготовка", "completed": 0, "total": 0});
    tokio::spawn(async move {
        let _guard = guard;
        let started = Instant::now();
        let result = scan(true, &request.mode).await;
        let result = match result {
            Ok((previous_report, mode, args)) if request.games => {
                let args = args.strip_suffix(GAMES_ARGS).unwrap_or(&args).to_string() + GAMES_ARGS;
                match run_probe_timeout("preset", &mode, &args, 8).await {
                    Ok(mut report) if healthy_report(&report, &mode) && !CANCEL.load(Ordering::Relaxed) => {
                        report["gamesVerified"] = json!(false);
                        report["candidates"] = previous_report["candidates"].clone();
                        report["durationSeconds"] = json!(started.elapsed().as_secs());
                        match remember(&mode, &args, &report).await {
                            Ok(()) => Ok((report, mode, args)), Err(error) => Err(error),
                        }
                    }
                    Ok(_) => Err("Проверка профиля с игровыми правилами не подтверждена; активная стратегия сохранена".into()),
                    Err(error) => Err(error),
                }
            }
            result => result,
        };
        let mut job = JOB.get().unwrap().lock().await;
        job["running"] = json!(false);
        match result {
            Ok((report, mode, args)) => {
                *PREVIEW.get_or_init(|| Mutex::new(None)).lock().await = Some(Preview { source: "preset".into(), custom: args.clone(), checked_at: Instant::now(), report: report.clone(), mode, args });
                job["result"] = report; job["success"] = json!(true);
            }
            Err(error) => { job["success"] = json!(false); job["error"] = json!(error); }
        }
    });
    Json(json!({"success": true}))
}

pub async fn status() -> Json<Value> {
    let mut job = JOB.get_or_init(|| Mutex::new(json!({"running": false}))).lock().await.clone();
    job["library"] = json!(saved());
    job["gamesArgs"] = json!(GAMES_ARGS);
    job["flowsealCount"] = json!(flowseal().len());
    Json(job)
}

pub fn cancel_current() { CANCEL.store(true, Ordering::Relaxed); }
pub(super) fn reset_cancel() { CANCEL.store(false, Ordering::Relaxed); }
pub async fn cancel() -> Json<Value> { cancel_current(); Json(json!({"success": true})) }
