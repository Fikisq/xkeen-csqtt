use crate::{csqtt, logger::log};
use serde::{Deserialize, Serialize};
use std::{path::Path, sync::{LazyLock, RwLock, atomic::{AtomicBool, AtomicU64, Ordering}}, time::Duration};

const STOPPED: &str = "/opt/etc/csqtt/stopped";
const BUDGET: &str = "/var/run/xkeen-ui-csqtt-health-budget.json";
const INTERVAL: u64 = 30;
const STARTUP_GRACE: u64 = 120;
const FAILURE_LIMIT: u32 = 3;
const WINDOW: u64 = 3600;
const MAX_RESTARTS: u32 = 2;
static EPOCH: AtomicU64 = AtomicU64::new(0);
static REQUESTED: AtomicBool = AtomicBool::new(false);
static HEALTH: LazyLock<RwLock<Snapshot>> = LazyLock::new(|| RwLock::new(Snapshot::default()));

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Snapshot {
    pub state: &'static str,
    pub message: &'static str,
    pub checked_at: u64,
    pub last_ok: Option<u64>,
    pub failures: u32,
    pub restarts_in_window: u32,
    pub retry_at: Option<u64>,
}

impl Default for Snapshot {
    fn default() -> Self {
        Self { state: "not_checked", message: "Проверка туннеля ещё не выполнена",
            checked_at: 0, last_ok: None, failures: 0, restarts_in_window: 0, retry_at: None }
    }
}

pub(crate) fn snapshot() -> Snapshot { HEALTH.read().unwrap().clone() }
pub(crate) fn healthy() -> bool {
    let health = snapshot();
    health.state == "healthy" && health.last_ok.is_some_and(|time| now().saturating_sub(time) <= 90)
}

pub(crate) fn user_action(action: &str) {
    REQUESTED.store(action != "stop", Ordering::Release);
    EPOCH.fetch_add(1, Ordering::AcqRel);
    let mut state = HEALTH.write().unwrap();
    *state = Snapshot { state: if action == "stop" { "stopped" } else { "starting" },
        message: if action == "stop" { "CSQTT остановлен пользователем" } else { "Ожидаем подключения и проверяем трафик через CSQTT" },
        ..Snapshot::default() };
}

fn now() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_secs()
}

#[derive(Default, Serialize, Deserialize)]
struct Budget { window_started: u64, count: u32, last_restart: u64 }
impl Budget {
    fn refresh(&mut self, time: u64) {
        if time.saturating_sub(self.window_started) >= WINDOW { *self = Self { window_started: time, ..Self::default() }; }
    }
    fn retry_at(&self, time: u64) -> Option<u64> {
        if self.count >= MAX_RESTARTS { return Some(self.window_started.saturating_add(WINDOW).max(time)); }
        if self.count > 0 {
            let deadline = self.last_restart.saturating_add(if self.count == 1 { 30 } else { 120 });
            if time < deadline { return Some(deadline); }
        }
        None
    }
    fn reserve(&mut self, time: u64) -> bool {
        self.refresh(time);
        if self.retry_at(time).is_some() { return false; }
        self.count += 1;
        self.last_restart = time;
        true
    }
}

fn load_budget() -> Budget {
    match std::fs::read(BUDGET) {
        Ok(bytes) => serde_json::from_slice::<Budget>(&bytes).ok()
            .filter(|budget| bytes.len() <= 4096 && budget.count <= MAX_RESTARTS)
            .unwrap_or_else(|| Budget { window_started: now(), count: MAX_RESTARTS, last_restart: now() }),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Budget { window_started: now(), ..Budget::default() },
        Err(_) => Budget { window_started: now(), count: MAX_RESTARTS, last_restart: now() },
    }
}

fn save_budget(budget: &Budget) -> std::io::Result<()> {
    use std::{io::Write, os::unix::fs::OpenOptionsExt};
    let temp = format!("{BUDGET}.new");
    let mut file = std::fs::OpenOptions::new().create(true).truncate(true).write(true).mode(0o600).open(&temp)?;
    file.write_all(&serde_json::to_vec(budget)?)?;
    std::fs::rename(temp, BUDGET)
}

// Bind curl directly to the tunnel, disable proxies, and accept only the
// expected HTTPS response. No Xray proxy or direct-WAN fallback is used.
async fn probe() -> bool {
    if !Path::new("/sys/class/net/csqtt0").exists() { return false; }
    for url in ["https://www.gstatic.com/generate_204", "https://cp.cloudflare.com/generate_204"] {
        let output = tokio::time::timeout(Duration::from_secs(9), tokio::process::Command::new("/opt/bin/curl")
            .args(["--silent", "--ipv4", "--noproxy", "*", "--proxy", "", "--interface", "if!csqtt0",
                "--connect-timeout", "3", "--max-time", "7", "--output", "/dev/null", "--write-out", "%{http_code}", url])
            .kill_on_drop(true).output()).await;
        if matches!(output, Ok(Ok(ref value)) if value.status.success() && value.stdout == b"204") { return true; }
    }
    false
}

pub(crate) fn start() {
    tokio::spawn(async {
        let mut timer = tokio::time::interval(Duration::from_secs(INTERVAL));
        timer.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        let mut budget = load_budget();
        let mut identity = None;
        let mut armed = false;
        let mut began = now();
        let mut ever_healthy = false;
        let mut failures = 0;
        let mut epoch = EPOCH.load(Ordering::Acquire);
        loop {
            timer.tick().await;
            let time = now();
            budget.refresh(time);
            let current = csqtt::client_identity();
            let current_epoch = EPOCH.load(Ordering::Acquire);
            if epoch != current_epoch || (current.is_some() && current != identity) {
                began = time;
                failures = 0;
                ever_healthy = false;
                epoch = current_epoch;
            }
            identity = current.clone();
            if Path::new(STOPPED).exists() {
                armed = false;
                REQUESTED.store(false, Ordering::Release);
                failures = 0;
                publish("stopped", "CSQTT остановлен пользователем", failures, &budget, None, false);
                continue;
            }
            armed |= REQUESTED.load(Ordering::Acquire) || current.is_some() || csqtt::starter_running();
            if !armed {
                publish("stopped", "CSQTT не запущен; автоматический запуск не требуется", 0, &budget, None, false);
                continue;
            }
            let ok = current.is_some() && probe().await;
            // A manual stop/restart may complete while curl is in flight.
            if EPOCH.load(Ordering::Acquire) != epoch || Path::new(STOPPED).exists()
                || csqtt::client_identity() != current { continue; }
            if ok {
                ever_healthy = true;
                failures = 0;
                publish("healthy", "Трафик через CSQTT проходит", 0, &budget, None, true);
                continue;
            }
            if let Some(reason) = csqtt::recovery_blocker() {
                failures = 0;
                publish("blocked", reason, 0, &budget, None, false);
                continue;
            }
            if !ever_healthy && time.saturating_sub(began) < STARTUP_GRACE {
                publish("starting", "Ожидаем подключения; трафик через CSQTT пока не подтверждён", 0, &budget, None, false);
                continue;
            }
            failures = failures.saturating_add(1);
            if failures < FAILURE_LIMIT {
                publish("degraded", "Проверка CSQTT не прошла; ожидаем повторной проверки", failures, &budget, None, false);
                continue;
            }
            if let Some(deadline) = budget.retry_at(time) {
                publish("cooldown", "Достигнут предел восстановления CSQTT; продолжаем проверять связь", failures, &budget, Some(deadline), false);
                continue;
            }
            let Ok(_permit) = csqtt::CSQTT_GATE.get_or_init(|| tokio::sync::Semaphore::new(1)).try_acquire() else { continue; };
            if Path::new(STOPPED).exists() || EPOCH.load(Ordering::Acquire) != epoch
                || csqtt::client_identity() != current || csqtt::recovery_blocker().is_some() { continue; }
            let time = now();
            if !budget.reserve(time) { continue; }
            if save_budget(&budget).is_err() {
                publish("blocked", "Не удалось сохранить ограничитель перезапусков; автоматический перезапуск отменён", failures, &budget, None, false);
                continue;
            }
            publish("restarting", "Туннель не отвечает; выполняется ограниченный перезапуск CSQTT", failures, &budget, None, false);
            health_log("WARN", format!("CSQTT: три проверки не прошли, восстановление {}/{} за час", budget.count, MAX_RESTARTS));
            let result = tokio::time::timeout(Duration::from_secs(420), tokio::process::Command::new("/opt/etc/init.d/S99csqtt")
                .arg("restart").kill_on_drop(true).output()).await;
            if !matches!(result, Ok(Ok(ref value)) if value.status.success()) {
                health_log("WARN", "CSQTT: служебный перезапуск не завершился успешно; повтор ограничен общим бюджетом".into());
            }
            identity = csqtt::client_identity();
            began = now();
            ever_healthy = false;
            failures = 0;
            publish("starting", "CSQTT перезапущен; проверяем прохождение трафика", 0, &budget, None, false);
        }
    });
}

fn publish(state: &'static str, message: &'static str, failures: u32, budget: &Budget, retry_at: Option<u64>, ok: bool) {
    let mut value = HEALTH.write().unwrap();
    if value.state != state {
        health_log(if state == "healthy" { "INFO" } else { "WARN" }, format!("CSQTT health: {message}"));
    }
    value.state = state;
    value.message = message;
    value.checked_at = now();
    if ok { value.last_ok = Some(value.checked_at); }
    value.failures = failures;
    value.restarts_in_window = budget.count;
    value.retry_at = retry_at;
}

fn health_log(level: &str, message: String) {
    use std::io::Write;
    log(level, message.clone());
    if let Ok(mut file) = std::fs::OpenOptions::new().append(true).open("/opt/etc/csqtt/csqtt.log") {
        let _ = file.write_all(crate::logger::format_plain_log(level, &message).as_bytes());
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn restart_budget_is_bounded_and_survives_serialization() {
        let mut budget = Budget { window_started: 1000, ..Budget::default() };
        assert!(budget.reserve(1000));
        assert!(!budget.reserve(1029));
        assert!(budget.reserve(1030));
        let bytes = serde_json::to_vec(&budget).unwrap();
        let mut restored: Budget = serde_json::from_slice(&bytes).unwrap();
        assert!(!restored.reserve(2000));
        assert_eq!(restored.retry_at(2000), Some(4600));
        assert!(restored.reserve(4600));
        assert_eq!(restored.count, 1);
    }
    #[test]
    fn backwards_clock_does_not_reset_the_budget() {
        let mut budget = Budget { window_started: 1000, count: 2, last_restart: 1100 };
        assert!(!budget.reserve(500));
        assert_eq!(budget.count, 2);
    }
}
