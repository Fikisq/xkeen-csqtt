// Router integration: bounded VK API activity and a pause shared by all workers.
use anyhow::{Result, bail};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{fs, io::Write, os::unix::fs::OpenOptionsExt, sync::{Mutex, OnceLock}, time::{SystemTime, UNIX_EPOCH}};

#[derive(Default, Serialize, Deserialize)]
#[serde(default)]
struct Guard {
    account: String,
    until: u64,
    manual: bool,
    reason: String,
    window: u64,
    requests: u32,
    failures: u32,
}
static GUARD: OnceLock<Mutex<Guard>> = OnceLock::new();
fn state() -> &'static Mutex<Guard> { GUARD.get_or_init(|| Mutex::new(Guard::default())) }
fn now() -> u64 { SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs() }
fn write_private(path: &std::path::Path, bytes: &[u8]) -> Result<()> {
    let temp = path.with_extension("new");
    let mut file = fs::OpenOptions::new().write(true).create(true).truncate(true).mode(0o600).open(&temp)?;
    file.write_all(bytes)?; file.sync_all()?;
    fs::rename(temp, path)?;
    Ok(())
}
fn persist(guard: &Guard) -> Result<()> {
    if let Some(path) = std::env::var_os("CSQTT_VK_GUARD_FILE") {
        write_private(std::path::Path::new(&path), &serde_json::to_vec(guard)?)?;
    }
    Ok(())
}
fn checked(guard: &Guard) -> Result<()> {
    if guard.manual { bail!("VK_ACCOUNT_PAUSED: {}. Требуется повторная авторизация VK", guard.reason); }
    if now() < guard.until { bail!("VK_ACCOUNT_PAUSED: {}. Пауза ещё {} с", guard.reason, guard.until - now()); }
    Ok(())
}
pub fn configure(token: &str) -> Result<()> {
    let account: String = Sha256::digest(token.as_bytes()).iter().map(|byte| format!("{byte:02x}")).collect();
    let mut guard = state().lock().unwrap();
    let saved = match std::env::var_os("CSQTT_VK_GUARD_FILE") {
        Some(path) => match fs::read(path) {
            Ok(bytes) => Some(serde_json::from_slice::<Guard>(&bytes)?),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Err(error) => return Err(error.into()),
        },
        None => None,
    };
    *guard = saved.filter(|saved| saved.account == account).unwrap_or_else(|| Guard { account, ..Guard::default() });
    checked(&guard)
}
pub fn check() -> Result<()> { checked(&state().lock().unwrap()) }
pub fn pause_seconds() -> u64 {
    let guard = state().lock().unwrap();
    if guard.manual { 3600 } else { guard.until.saturating_sub(now()).max(1) }
}
pub fn request() -> Result<()> {
    let mut guard = state().lock().unwrap();
    checked(&guard)?;
    if now().saturating_sub(guard.window) >= 60 { guard.window = now(); guard.requests = 0; }
    if guard.requests >= 40 {
        guard.until = now() + 300;
        guard.reason = "Достигнут локальный бюджет запросов VK".into();
        persist(&guard)?;
        return checked(&guard);
    }
    guard.requests += 1;
    // Persist the budget so repeated process restarts cannot reset it.
    persist(&guard)
}
pub fn transport_failure() -> Result<()> {
    let mut guard = state().lock().unwrap();
    guard.failures = guard.failures.saturating_add(1);
    if guard.failures >= 6 {
        guard.until = now() + 30;
        guard.reason = "Повторные ошибки соединения с VK".into();
        guard.failures = 0;
    }
    persist(&guard)?;
    checked(&guard)
}
pub fn api_error(code: i64) -> Result<()> {
    let mut guard = state().lock().unwrap();
    match code {
        5 | 14 | 17 | 18 => { guard.manual = true; guard.reason = format!("VK API {code}"); },
        6 | 9 | 29 => { guard.until = now() + 900; guard.reason = format!("Ограничение VK API {code}"); },
        _ => return Ok(()),
    }
    persist(&guard)?;
    checked(&guard)
}
pub fn retry_after(value: &str) -> Option<u64> {
    if let Ok(seconds) = value.trim().parse::<u64>() { return Some(seconds); }
    // IMF-fixdate, the standard HTTP-date form used by Retry-After.
    let fields: Vec<_> = value.split_whitespace().collect();
    if fields.len() != 6 || fields[5] != "GMT" { return None; }
    let day = fields[1].parse::<u64>().ok()?;
    let month = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"].iter().position(|name| *name == fields[2])?;
    let year = fields[3].parse::<u64>().ok()?;
    if !(1970..=9999).contains(&year) { return None; }
    let leap = |y: u64| y % 4 == 0 && (y % 100 != 0 || y % 400 == 0);
    let months = [31, if leap(year) {29} else {28}, 31,30,31,30,31,31,30,31,30,31];
    if day == 0 || day > months[month] { return None; }
    let clock: Vec<_> = fields[4].split(':').map(str::parse::<u64>).collect::<std::result::Result<_, _>>().ok()?;
    if clock.len() != 3 || clock[0] > 23 || clock[1] > 59 || clock[2] > 59 { return None; }
    let days = (1970..year).map(|y| if leap(y) {366} else {365}).sum::<u64>()
        + months[..month].iter().sum::<u64>() + day - 1;
    Some((days * 86400 + clock[0] * 3600 + clock[1] * 60 + clock[2]).saturating_sub(now()))
}
pub fn http_error(status: u16, retry_after: Option<u64>) -> Result<()> {
    let mut guard = state().lock().unwrap();
    if status == 429 {
        guard.until = now().saturating_add(retry_after.unwrap_or(900).max(60));
        guard.reason = "VK HTTP 429".into();
    } else if matches!(status, 401 | 403) {
        guard.manual = true;
        guard.reason = format!("VK HTTP {status}");
    } else { return Ok(()); }
    persist(&guard)?;
    checked(&guard)
}
pub fn success() {
    let mut guard = state().lock().unwrap();
    guard.failures = 0;
}
pub fn vk_device_id(server_id: &str) -> Result<String> {
    let Some(path) = std::env::var_os("CSQTT_VK_DEVICE_ID_FILE") else {
        return Ok(uuid::Uuid::parse_str(server_id).unwrap_or_else(|_| uuid::Uuid::new_v4()).to_string());
    };
    let path = std::path::Path::new(&path);
    match fs::read_to_string(path) {
        Ok(value) => return Ok(uuid::Uuid::parse_str(value.trim())?.to_string()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {},
        Err(error) => return Err(error.into()),
    }
    let id = uuid::Uuid::parse_str(server_id).unwrap_or_else(|_| uuid::Uuid::new_v4()).to_string();
    write_private(path, id.as_bytes())?;
    Ok(id)
}
