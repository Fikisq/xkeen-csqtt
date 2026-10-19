use super::*;
use std::sync::atomic::{AtomicBool, Ordering};

const SCAN_TIMEOUT: u64 = 3;
const CONFIRM_TIMEOUT: u64 = 6;

fn worth_confirmation(report: &Value) -> bool { report["tcpSites"].as_u64().unwrap_or(0) >= 1 }

#[cfg(test)]
mod timeout_tests {
    use super::*;
    #[test]
    fn partial_fast_probe_can_retry_but_cannot_pass() {
        let partial = json!({"tcpSites": 1, "http3Sites": 1});
        assert!(worth_confirmation(&partial));
        assert!(!healthy_report(&partial, "tcp-quic"));
        assert!(!worth_confirmation(&json!({"tcpSites": 0})));
    }
}

const LIBRARY: &str = "/opt/etc/xkeen/nfqws2-stage/working-strategies.json";
static JOB: OnceLock<Mutex<Value>> = OnceLock::new();
const JOB_FILE: &str = "/var/run/xkeen-ui-nfqws2-search.json";
static CANCEL: AtomicBool = AtomicBool::new(false);
pub(super) const GAMES_ARGS: &str = include_str!("../../router/nfqws2-games.args");

fn initial_job() -> Value {
    let mut job = std::fs::read(JOB_FILE).ok()
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
        .filter(Value::is_object).unwrap_or_else(|| json!({"running": false}));
    if job["running"] == true {
        job["running"] = json!(false);
        job["current"] = Value::Null;
        job["finishedAt"] = json!(chrono::Utc::now().to_rfc3339());
        job["success"] = json!(false);
        job["error"] = json!("Панель перезапущена во время подбора. Предыдущая активная стратегия сохранена; начните подбор заново.");
    }
    // Old three-site and removed-plan jobs are archived on disk, not reused as two-site evidence.
    if job["siteCount"].as_u64() != Some(2) || job["plan"] != "lists" {
        return json!({"running": false, "plan": "lists", "siteCount": 2});
    }
    job
}

fn job_store() -> &'static Mutex<Value> { JOB.get_or_init(|| Mutex::new(initial_job())) }

async fn persist_job(job: &Value) {
    // RAM-backed state: page reloads and panel restarts must not erase the report.
    let next = format!("{JOB_FILE}.new");
    if let Ok(bytes) = serde_json::to_vec(job) {
        if tokio::fs::write(&next, bytes).await.is_ok() {
            _ = tokio::fs::set_permissions(&next, std::fs::Permissions::from_mode(0o600)).await;
            _ = tokio::fs::rename(&next, JOB_FILE).await;
        }
    }
}

fn score(report: &Value) -> u64 {
    report["tcpSites"].as_u64().unwrap_or(0) * 10 + report["http3Sites"].as_u64().unwrap_or(0) * 6
}

fn strategy_name(args: &str) -> Option<String> {
    let args = args.strip_suffix(GAMES_ARGS).unwrap_or(args);
    let entries = catalog::entries();
    if let Some(name) = entries.iter().find(|item| item["args"].as_str() == Some(args)).and_then(|item| item["name"].as_str()) { return Some(name.to_string()); }
    let tcp = catalog::extract(args, "tcp").ok()?;
    let entry = entries.iter().find(|item| item["args"].as_str().and_then(|full| catalog::extract(full, "tcp").ok()).as_ref() == Some(&tcp))?;
    let name = entry["name"].as_str()?.split(" / ").next()?;
    if let Ok(quic) = catalog::extract(args, "quic") {
        let repeats = quic.lines().find(|line| line.starts_with("--lua-desync=") && line.contains("repeats="))
            .and_then(|line| line.split("repeats=").nth(1)).and_then(|value| value.split(':').next());
        Some(format!("{name} / QUIC {}", repeats.map(|value| format!("×{value}")).unwrap_or_else(|| "свой блок".into())))
    } else { Some(format!("{name} / TCP")) }

}

pub fn saved() -> Vec<Value> {
    {
        let mut entries: Vec<Value> = std::fs::read(LIBRARY).ok().and_then(|bytes| serde_json::from_slice(&bytes).ok()).unwrap_or_default();
        for entry in &mut entries { normalise_report(entry); }
        entries
    }
}

pub fn successful() -> Vec<Value> {
    saved().into_iter().filter(|entry| healthy_report(entry, entry["mode"].as_str().unwrap_or("tcp-quic"))).collect()
}

pub(super) async fn remember(mode: &str, args: &str, report: &Value) -> Result<(), String> {

    if !healthy_report(report, mode) { return Ok(()); }
    let id = strategy_key("preset", mode, args);
    let mut entries = saved();
    entries.retain(|item| item["id"] != id);
    entries.insert(0, json!({"id": id, "name": report["strategyName"].as_str().map(str::to_string).or_else(|| strategy_name(args)), "games": args.contains("--filter-udp=1024-65535"), "mode": mode, "args": args, "checkedAt": report["checkedAt"], "tcpSites": report["tcpSites"], "http3Sites": report["http3Sites"], "results": report["results"]}));
    // Keep useful QUIC profiles while TCP scanning adds many similar candidates.
    entries.sort_by(|a, b| score(b).cmp(&score(a)).then_with(|| b["checkedAt"].as_str().cmp(&a["checkedAt"].as_str())));
    entries.truncate(64);
    let temp = format!("{LIBRARY}.new");
    tokio::fs::write(&temp, serde_json::to_vec(&entries).map_err(|e| e.to_string())?).await.map_err(|e| e.to_string())?;
    tokio::fs::set_permissions(&temp, std::fs::Permissions::from_mode(0o600)).await.map_err(|e| e.to_string())?;
    tokio::fs::rename(temp, LIBRARY).await.map_err(|e| e.to_string())
}

async fn progress(user: bool, phase: &str, total: usize, candidates: &[Value], current: Value) {
    if !user { return; }
    let mut job = job_store().lock().await;
    job["phase"] = json!(phase);
    job["completed"] = json!(candidates.len());
    job["total"] = json!(total);
    job["candidates"] = json!(candidates);
    job["current"] = current;
    persist_job(&job).await;
}

pub async fn scan(user: bool, requested_mode: &str) -> Result<(Value, String, String), String> {
    scan_with_plan(user, requested_mode).await
}

async fn scan_with_plan(user: bool, requested_mode: &str) -> Result<(Value, String, String), String> {
    let started = Instant::now();
    let pool: Vec<String> = catalog::entries().iter().filter_map(|item| item["args"].as_str().and_then(|args| catalog::extract(args, "tcp").ok())).collect();
    if pool.is_empty() { return Err("Во включённых списках нет TCP-стратегий".into()); }
    let mut previous_quic: Vec<String> = saved().into_iter().filter(|entry| entry["mode"] == "tcp-quic")
        .filter_map(|entry| entry["args"].as_str().map(str::to_owned)).collect();
    if let Ok(args) = std::fs::read_to_string(CUSTOM) {
        if args.lines().any(|line| line.trim() == "--filter-udp=443") { previous_quic.insert(0, args); }
    }
    let total = pool.len() + if requested_mode == "tcp-quic" { 8 + 3 } else { 1 };
    let mut finalists: Vec<(Value, String)> = Vec::new();
    let mut candidates = Vec::new();
    let mut best: Option<(Value, String, String)> = None;
    for (index, args) in pool.iter().enumerate() {
        if CANCEL.load(Ordering::Relaxed) { return Err("Подбор отменён; активная стратегия сохранена".into()); }
        let name = strategy_name(args).unwrap_or_else(|| format!("TCP {}", index + 1));
        progress(user, "TCP", total, &candidates, json!({"name": name, "mode": "tcp", "args": args})).await;
        match run_probe_timeout("preset", "tcp", args, SCAN_TIMEOUT).await {
            Ok(report) => {
                let score = report["tcpSites"].as_u64().unwrap_or(0);
                candidates.push(json!({"name": name, "args": args, "mode": "tcp", "tcpSites": score, "http3Sites": 0, "results": report["results"]}));
                remember("tcp", args, &report).await?;
                if best.as_ref().is_none_or(|(old, _, _)| score > old["tcpSites"].as_u64().unwrap_or(0)) { best = Some((report, "tcp".into(), args.clone())); }
                if score == REQUIRED_TCP_SITES { break; }
            }
            Err(error) => candidates.push(json!({"name": name, "args": args, "mode": "tcp", "error": error})),
        }
    }
    progress(user, "TCP завершён", total, &candidates, Value::Null).await;
    let (mut tcp_report, _, tcp_args) = best.ok_or_else(|| {
        let cause = candidates.iter().rev().find_map(|item| item["error"].as_str());
        match cause {
            Some(error) => format!("Не удалось проверить ни одного варианта: {error}"),
            None => "Не удалось проверить ни одного варианта".to_string(),
        }
    })?;
    if !healthy_report(&tcp_report, "tcp") && worth_confirmation(&tcp_report) {
        progress(user, "Повтор TCP с увеличенным тайм-аутом", candidates.len() + 1, &candidates, json!({"name": "Повтор TCP · 6 секунд", "mode": "tcp", "args": tcp_args})).await;
        tcp_report = run_probe_timeout("preset", "tcp", &tcp_args, CONFIRM_TIMEOUT).await?;
        candidates.push(json!({"name": "Повтор TCP · 6 секунд", "args": tcp_args, "mode": "tcp", "tcpSites": tcp_report["tcpSites"], "http3Sites": 0, "results": tcp_report["results"]}));
        progress(user, "Повтор TCP завершён", candidates.len(), &candidates, Value::Null).await;
    }
    if !healthy_report(&tcp_report, "tcp") { return Err("Не найден вариант с ответами обоих сайтов по TCP (2/2); активная стратегия сохранена".into()); }
    let mut selected = (tcp_report, "tcp".to_string(), tcp_args.clone());
    if requested_mode == "tcp-quic" {
        let mut quic_args = Vec::new();
        for previous in &previous_quic {
            if let Some(args) = previous.strip_suffix(GAMES_ARGS).unwrap_or(previous).split_once("--new").map(|(_, udp)| format!("{tcp_args}--new{udp}")) {
                if !quic_args.contains(&args) { quic_args.push(args); }
            }
        }
        for repeats in [11, 6, 2, 4, 8, 16] {
            let args = format!("{tcp_args}--new\n--filter-udp=443\n--payload=quic_initial\n--lua-desync=fake:blob=quic_initial:repeats={repeats}\n");
            if !quic_args.contains(&args) { quic_args.push(args); }
        }
        for args in quic_args.iter().take(8) {
            if CANCEL.load(Ordering::Relaxed) { return Err("Подбор отменён; активная стратегия сохранена".into()); }
            if started.elapsed() >= Duration::from_secs(110) { break; }
            let repeats = args.lines().find(|line| line.contains("blob=quic_initial")).and_then(|line| line.split("repeats=").nth(1)).and_then(|part| part.split(':').next()).unwrap_or("?");
            let name = format!("QUIC · {repeats} повторов");
            progress(user, "TCP + QUIC", total, &candidates, json!({"name": name, "mode": "tcp-quic", "args": args})).await;
            match run_probe_timeout("preset", "tcp-quic", args, SCAN_TIMEOUT).await {
                Ok(report) => {
                    let tcp = report["tcpSites"].as_u64().unwrap_or(0);
                    let h3 = report["http3Sites"].as_u64().unwrap_or(0);
                    candidates.push(json!({"name": name, "args": args, "mode": "tcp-quic", "tcpSites": tcp, "http3Sites": h3, "results": report["results"]}));
                    remember("tcp-quic", args, &report).await?;
                    if healthy_report(&report, "tcp-quic") { finalists.push((report.clone(), args.clone())); }
                    if tcp == REQUIRED_TCP_SITES && h3 == REQUIRED_TCP_SITES { break; }
                }
                Err(error) => candidates.push(json!({"name": name, "args": args, "mode": "tcp-quic", "error": error})),
            }
        }
    }
    if CANCEL.load(Ordering::Relaxed) { return Err("Подбор отменён; активная стратегия сохранена".into()); }
    progress(user, "Подтверждение результата", candidates.len() + 3, &candidates, Value::Null).await;
    finalists.sort_by_key(|(report, _)| std::cmp::Reverse(score(report)));
    finalists.truncate(3);
    let mut confirmed: Option<(Value, String)> = None;
    let confirmation_total = candidates.len() + finalists.len().max(1);
    for (index, (initial, args)) in finalists.into_iter().enumerate() {
        if CANCEL.load(Ordering::Relaxed) { return Err("Подбор отменён; активная стратегия сохранена".into()); }
        let name = format!("Подтверждение {}", index + 1);
        progress(user, "Подтверждение TCP + QUIC", confirmation_total, &candidates, json!({"name": name, "mode": "tcp-quic", "args": args})).await;
        match run_probe_timeout("preset", "tcp-quic", &args, CONFIRM_TIMEOUT).await {
            Ok(mut report) => {
                report["initialHttp3Sites"] = initial["http3Sites"].clone();
                report["confirmationChanged"] = json!(initial["http3Sites"] != report["http3Sites"] || initial["tcpSites"] != report["tcpSites"]);
                candidates.push(json!({"name": name, "mode": "tcp-quic", "args": args, "tcpSites": report["tcpSites"], "http3Sites": report["http3Sites"], "results": report["results"]}));
                if healthy_report(&report, "tcp-quic") && confirmed.as_ref().is_none_or(|(old, _)| score(&report) > score(old)) { confirmed = Some((report, args)); }
            }
            Err(error) => candidates.push(json!({"name": name, "mode": "tcp-quic", "args": args, "error": error})),
        }
    }
    let mut report = if let Some((report, args)) = confirmed {
        selected = (report.clone(), "tcp-quic".into(), args);
        report
    } else {
        progress(user, "Подтверждение TCP", candidates.len() + 1, &candidates, json!({"name": "Подтверждение TCP", "mode": "tcp", "args": selected.2})).await;
        let report = run_probe_timeout("preset", "tcp", &selected.2, CONFIRM_TIMEOUT).await?;
        candidates.push(json!({"name": "Подтверждение TCP", "mode": "tcp", "args": selected.2, "tcpSites": report["tcpSites"], "http3Sites": 0, "results": report["results"]}));
        report
    };
    if CANCEL.load(Ordering::Relaxed) { return Err("Подбор отменён; активная стратегия сохранена".into()); }
    if !healthy_report(&report, &selected.1) { return Err("Повторная проверка не подтвердила выбранный вариант; активная стратегия сохранена".into()); }
    report["candidates"] = json!(candidates);
    report["durationSeconds"] = json!(started.elapsed().as_secs());
    remember(&selected.1, &selected.2, &report).await?;
    Ok((report, selected.1, selected.2))
}


// Rank TCP first: the mandatory TCP 2/2 must not lose to a QUIC-rich partial attempt.
fn retain_best_measurement(job: &mut Value, report: &Value) {
    let (Some(tcp), Some(quic)) = (report["tcpSites"].as_u64(), report["http3Sites"].as_u64()) else { return; };
    if tcp > REQUIRED_TCP_SITES || quic > REQUIRED_TCP_SITES || report.get("error").is_some_and(|error| !error.is_null()) { return; }
    let previous = (job["best"]["tcpSites"].as_u64().unwrap_or(0), job["best"]["http3Sites"].as_u64().unwrap_or(0));
    if job["best"].is_null() || (tcp, quic) > previous {
        job["best"] = json!({"tcpSites": tcp, "http3Sites": quic});
    }
}

fn recover_best_measurement(job: &mut Value) {
    let best = job["candidates"].as_array().into_iter().flatten().filter(|report| report.get("error").is_none_or(Value::is_null))
        .filter_map(|report| Some((report["tcpSites"].as_u64()?, report["http3Sites"].as_u64()?)))
        .filter(|(tcp, quic)| *tcp <= REQUIRED_TCP_SITES && *quic <= REQUIRED_TCP_SITES).max();
    if let Some((tcp, quic)) = best { retain_best_measurement(job, &json!({"tcpSites": tcp, "http3Sites": quic})); }
}

async fn expanded_progress(phase: &str, attempts: usize, total: Option<usize>, history: &[Value], current: Value, best: Option<&Value>) {
    let mut job = job_store().lock().await;
    job["phase"] = json!(phase);
    job["completed"] = json!(attempts);
    job["total"] = json!(total);
    job["candidates"] = json!(history);
    job["historyLimit"] = json!(120);
    job["current"] = current;
    recover_best_measurement(&mut job);
    if let Some(report) = best { retain_best_measurement(&mut job, report); }
    persist_job(&job).await;
}

async fn expanded_probe(args: &str, seconds: u64) -> Result<Value, String> {
    let mode = if args.lines().any(|line| line.trim() == "--filter-udp=443") { "tcp-quic" } else { "tcp" };
    let report = run_probe_timeout("preset", mode, args, seconds).await?;

    Ok(report)
}

async fn expanded_scan(games: bool) -> Result<(Value, String, String), String> {
    let started = Instant::now();
    let mut history: Vec<Value> = Vec::new();
    let mut shortlist: Vec<(Value, String, String)> = Vec::new();
    let listed = catalog::entries();
    if listed.is_empty() { return Err("Добавьте стратегии или включите список в «Списках стратегий»".into()); }
    let total = Some(listed.len() + 3);
    let mut attempts = 0;
    let mut failures = 0;
    for entry in &listed {
        if CANCEL.load(Ordering::Relaxed) { break; }
        let mut args = entry["args"].as_str().unwrap_or_default().to_string();
        if games && !args.contains("--filter-udp=1024-65535") { args.push_str(GAMES_ARGS); }
        let name = entry["name"].as_str().unwrap_or("Стратегия из списка").to_string();
        let phase = "Проверка списков стратегий";
        expanded_progress(phase, attempts, total, &history, json!({"name": name, "mode": "tcp-quic", "args": args}), shortlist.first().map(|item| &item.0)).await;
        attempts += 1;
        match expanded_probe(&args, SCAN_TIMEOUT).await {
            Ok(report) => {
                failures = 0;
                history.push(json!({"name": name, "args": args, "mode": report["mode"], "tcpSites": report["tcpSites"], "http3Sites": report["http3Sites"], "results": report["results"]}));
                if worth_confirmation(&report) {
                    shortlist.retain(|(_, _, previous)| previous != &args);
                    shortlist.push((report, name, args));
                    shortlist.sort_by_key(|item| std::cmp::Reverse(score(&item.0)));
                    shortlist.truncate(3);
                }
            }
            Err(error) => {
                failures += 1;
                history.push(json!({"name": name, "args": args, "mode": "tcp-quic", "error": error}));
            }
        }
        if history.len() > 120 { history.remove(0); }
        expanded_progress(phase, attempts, total, &history, Value::Null, shortlist.first().map(|item| &item.0)).await;
        if failures >= 8 { return Err("Восемь проверок подряд не запустились. Проверьте утилиты nfqws2; активная стратегия сохранена".into()); }

    }
    let stopped = CANCEL.load(Ordering::Relaxed);
    if shortlist.is_empty() {
        return Err(if stopped { "Подбор остановлен: подтверждённых сочетаний TCP + QUIC пока нет. Активная стратегия сохранена" } else { "Не найдено сочетание с TCP 2/2 и QUIC ≥ 1/2. Активная стратегия не менялась" }.into());
    }
    let mut selected: Option<Value> = None;
    let confirmations = if stopped { 1 } else { shortlist.len() };
    for (initial, name, args) in shortlist.into_iter().take(confirmations) {
        expanded_progress("Подтверждение TCP + QUIC", attempts, Some(attempts + 1), &history, json!({"name": format!("Подтверждение · {name}"), "mode": "tcp-quic", "args": args}), selected.as_ref()).await;
        attempts += 1;
        match expanded_probe(&args, CONFIRM_TIMEOUT).await {
            Ok(mut report) => {
                history.push(json!({"name": format!("Подтверждение · {name}"), "mode": "tcp-quic", "args": args, "tcpSites": report["tcpSites"], "http3Sites": report["http3Sites"], "results": report["results"]}));
                report["initialHttp3Sites"] = initial["http3Sites"].clone();
                report["confirmationChanged"] = json!(initial["http3Sites"] != report["http3Sites"] || initial["tcpSites"] != report["tcpSites"]);
                if healthy_report(&report, "tcp-quic") && selected.as_ref().is_none_or(|old| score(&report) > score(old)) { selected = Some(report); }
            }
            Err(error) => history.push(json!({"name": format!("Подтверждение · {name}"), "mode": "tcp-quic", "args": args, "error": error})),
        }
        if history.len() > 120 { history.remove(0); }
        expanded_progress("Подтверждение TCP + QUIC", attempts, Some(attempts), &history, Value::Null, selected.as_ref()).await;
        if CANCEL.load(Ordering::Relaxed) { break; }
    }
    let mut report = selected.ok_or("Повторная проверка не подтвердила TCP + QUIC. Активная стратегия не менялась")?;
    let args = report["args"].as_str().unwrap_or_default().to_string();
    report["candidates"] = json!(history);
    report["attempts"] = json!(attempts);
    report["stopped"] = json!(stopped);
    report["gamesIncluded"] = json!(games);
    report["durationSeconds"] = json!(started.elapsed().as_secs());
    remember("tcp-quic", &args, &report).await?;
    Ok((report, "tcp-quic".into(), args))
}

pub async fn is_running() -> bool { job_store().lock().await["running"] == true }

#[derive(Deserialize)]
pub struct SearchRequest { mode: String, #[serde(default)] games: bool, #[serde(default)] plan: String }

pub async fn start(Json(mut request): Json<SearchRequest>) -> Json<Value> {
    if !matches!(request.mode.as_str(), "tcp" | "tcp-quic") || !Path::new(ROOT).is_dir() { return Json(json!({"success": false, "error": "Выберите TCP или TCP + QUIC; nfqws2 должен быть установлен"})); }
    if matches!(request.plan.as_str(), "" | "fixed") { request.plan = "lists".into(); }
    if !matches!(request.plan.as_str(), "lists") { return Json(json!({"success": false, "error": "Неизвестный режим подбора"})); }
    let Ok(guard) = SETTINGS_LOCK.get_or_init(|| Mutex::new(())).try_lock() else { return Json(json!({"success": false, "error": "Проверка или управление nfqws2 уже выполняется"})); };
    if is_running().await { return Json(json!({"success": false, "error": "Подбор уже выполняется. Откройте его ход или остановите задание"})); }
    if let Err(error) = probe_ready().await { return Json(json!({"success": false, "error": error})); }
    CANCEL.store(false, Ordering::Relaxed);
    {
        let mut job = job_store().lock().await;
        *job = json!({"id": uuid::Uuid::new_v4().to_string(), "running": true, "mode": request.mode, "games": request.games, "plan": request.plan, "siteCount": 2, "startedAt": chrono::Utc::now().to_rfc3339(), "phase": "Подготовка", "completed": 0, "total": 0, "candidates": []});
        persist_job(&job).await;
    }
    tokio::spawn(async move {
        let _guard = guard;
        let started = Instant::now();
        let result = if request.mode == "tcp-quic" {
            expanded_scan(request.games).await
        } else { scan_with_plan(true, &request.mode).await };
        let result = match result {
            Ok((previous_report, mode, args)) if request.games && previous_report["gamesIncluded"] != true => {
                let args = args.strip_suffix(GAMES_ARGS).unwrap_or(&args).to_string() + GAMES_ARGS;
                match run_probe_timeout("preset", &mode, &args, CONFIRM_TIMEOUT).await {
                    Ok(mut report) if healthy_report(&report, &mode) && !CANCEL.load(Ordering::Relaxed) => {
                        report["initialHttp3Sites"] = previous_report["http3Sites"].clone();
                        report["confirmationChanged"] = json!(previous_report["http3Sites"] != report["http3Sites"] || previous_report["tcpSites"] != report["tcpSites"]);
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
        let mut job = job_store().lock().await;
        job["running"] = json!(false);
        job["current"] = Value::Null;
        job["finishedAt"] = json!(chrono::Utc::now().to_rfc3339());
        match result {
            Ok((report, mode, args)) => {
                *PREVIEW.get_or_init(|| Mutex::new(None)).lock().await = Some(Preview { source: "preset".into(), custom: args.clone(), checked_at: Instant::now(), report: report.clone(), mode, args });
                job["completed"] = report.get("attempts").cloned().unwrap_or_else(|| json!(report["candidates"].as_array().map_or(0, Vec::len)));
                job["total"] = job["completed"].clone();
                job["phase"] = json!("Завершено");
                job["candidates"] = report["candidates"].clone();
                job["result"] = report; job["success"] = json!(true);
            }
            Err(error) => { job["success"] = json!(false); job["error"] = json!(error); }
        }
        persist_job(&job).await;
    });
    Json(json!({"success": true}))
}

pub async fn summary() -> Value {
    let job = job_store().lock().await;
    json!({"running": job["running"] == true, "plan": job["plan"], "phase": job["phase"], "completed": job["completed"], "total": job["total"]})
}

pub async fn status() -> Json<Value> {
    let mut job = job_store().lock().await.clone();
    recover_best_measurement(&mut job);
    job["library"] = json!(successful());
    job["requiredTcpSites"] = json!(REQUIRED_TCP_SITES);
    job["gamesArgs"] = json!(GAMES_ARGS);
    job["listStrategyCount"] = json!(catalog::entries().len());
    Json(job)
}

pub fn cancel_current() { CANCEL.store(true, Ordering::Relaxed); }
pub(super) fn reset_cancel() { CANCEL.store(false, Ordering::Relaxed); }
pub async fn cancel() -> Json<Value> { cancel_current(); Json(json!({"success": true})) }
