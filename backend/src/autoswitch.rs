use crate::types::AppState;
use axum::{Json, extract::State};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    path::Path,
    sync::OnceLock,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::sync::Mutex;
#[path = "autoswitch_probe.rs"]
mod probe;
#[path = "autoswitch_routes.rs"]
mod routes;
const SETTINGS: &str = "/opt/etc/xkeen/autoswitch.json";
const XRAY: &str = "/opt/etc/xray/configs/00_config.json";
const MIHOMO: &str = "/opt/etc/mihomo/config.yaml";
static REVISION: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
static STATUS: OnceLock<Mutex<Value>> = OnceLock::new();
fn gate() -> &'static Mutex<()> {
    LOCK.get_or_init(|| Mutex::new(()))
}
fn status_cell() -> &'static Mutex<Value> {
    STATUS.get_or_init(|| {
        Mutex::new(json!({"phase":"disabled","failures":0,"recoveries":0,"lastChecked":0,"foreign":[],"whitelist":[]}))
    })
}
fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct Settings {
    enabled: bool,
    target: String,
    interval_seconds: u64,
    foreign_urls: Vec<String>,
    whitelist_urls: Vec<String>,
}
impl Default for Settings {
    fn default() -> Self {
        Self {
            enabled: false,
            target: "csqtt".into(),
            interval_seconds: 60,
            foreign_urls: vec![
                "https://cp.cloudflare.com/".into(),
                "https://www.wikipedia.org/".into(),
                "https://github.com/".into(),
                "https://www.google.com/".into(),
                "https://www.microsoft.com/".into(),
            ],
            whitelist_urls: vec![
                "https://ya.ru/".into(),
                "https://vk.ru/".into(),
                "https://mail.ru/".into(),
                "https://www.rbc.ru/".into(),
                "https://www.gosuslugi.ru/".into(),
            ],
        }
    }
}
fn read_settings() -> Settings {
    let mut settings: Settings = std::fs::read(SETTINGS)
        .ok()
        .and_then(|v| serde_json::from_slice(&v).ok())
        .unwrap_or_default();
    for url in &mut settings.whitelist_urls {
        if matches!(url.as_str(), "https://vk.com" | "https://vk.com/") {
            *url = "https://vk.ru/".into();
        }
    }
    if settings.foreign_urls.len() == 3 {
        for candidate in ["https://www.google.com/", "https://www.microsoft.com/"] {
            let host = reqwest::Url::parse(candidate)
                .ok()
                .and_then(|u| u.host_str().map(str::to_owned));
            if !settings.foreign_urls.iter().any(|url| {
                reqwest::Url::parse(url)
                    .ok()
                    .and_then(|u| u.host_str().map(str::to_owned))
                    == host
            }) {
                settings.foreign_urls.push(candidate.into());
            }
        }
        for candidate in Settings::default().foreign_urls {
            if settings.foreign_urls.len() >= 5 {
                break;
            }
            let host = reqwest::Url::parse(&candidate)
                .ok()
                .and_then(|u| u.host_str().map(str::to_owned));
            if !settings.foreign_urls.iter().any(|url| {
                reqwest::Url::parse(url)
                    .ok()
                    .and_then(|u| u.host_str().map(str::to_owned))
                    == host
            }) {
                settings.foreign_urls.push(candidate);
            }
        }
    }
    if settings.whitelist_urls == ["https://ya.ru/", "https://vk.ru/", "https://www.gosuslugi.ru/"] {
        settings.whitelist_urls = Settings::default().whitelist_urls;
    }
    settings
}
fn validate(settings: &Settings) -> Result<(), String> {
    if !matches!(settings.target.as_str(), "csqtt" | "wdtt-plus") {
        return Err("Выберите CSQTT или WDTT Plus".into());
    }
    if !(30..=31 * 24 * 3600).contains(&settings.interval_seconds) {
        return Err("Интервал: от 30 секунд до 744 часов".into());
    }
    if settings.foreign_urls.len() != 5 || !(1..=6).contains(&settings.whitelist_urls.len()) {
        return Err("Нужно пять зарубежных адресов и от одного до шести адресов белого списка".into());
    }
    let mut hosts = std::collections::BTreeSet::new();
    for url in settings.foreign_urls.iter().chain(&settings.whitelist_urls) {
        let parsed = reqwest::Url::parse(url).map_err(|_| "Некорректный HTTPS-адрес")?;
        let host = parsed.host_str().ok_or("Укажите домен")?;
        if parsed.scheme() != "https"
            || !parsed.username().is_empty()
            || parsed.password().is_some()
            || parsed.port().is_some_and(|p| p != 443)
            || url.len() > 512
            || host.parse::<std::net::IpAddr>().is_ok()
            || !host.contains('.')
            || host.ends_with(".local")
            || host.ends_with(".localhost")
            || host.ends_with(".lan")
            || !hosts.insert(host.to_ascii_lowercase())
        {
            return Err("Нужны разные публичные HTTPS-домены без пароля, IP-адреса и нестандартного порта".into());
        }
    }
    Ok(())
}
pub(crate) fn atomic(path: &str, content: &[u8]) -> Result<(), String> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    let temp = format!("{path}.{}.tmp", uuid::Uuid::new_v4());
    let result = (|| {
        let mut f = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&temp)
            .map_err(|e| e.to_string())?;
        f.write_all(content).map_err(|e| e.to_string())?;
        f.sync_all().map_err(|e| e.to_string())?;
        std::fs::rename(&temp, path).map_err(|e| e.to_string())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(temp);
    }
    result
}
#[derive(Serialize, Deserialize)]
struct Journal {
    core: String,
    target: String,
    before: String,
    after: String,
    choices: BTreeMap<String, String>,
    global_bypass: bool,
    at: u64,
}
fn journal_path(core: &str) -> String {
    format!("/opt/etc/xkeen/autoswitch-{core}.json")
}
fn journal(core: &str) -> Result<Option<Journal>, String> {
    let path = journal_path(core);
    match std::fs::read(path) {
        Ok(v) => serde_json::from_slice(&v)
            .map(Some)
            .map_err(|_| "Повреждён снимок автопереключения; правила не изменены".into()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}
fn reserve_name(core: &str, target: &str) -> &'static str {
    if target == "csqtt" {
        if core == "xray" { "csqtt" } else { "CSQTT" }
    } else if core == "xray" {
        "wdtt-plus"
    } else {
        "WDTT Plus"
    }
}
fn file(core: &str) -> &'static str {
    if core == "xray" { XRAY } else { MIHOMO }
}
async fn live(session: &crate::geodata_update::MihomoReload) -> Result<Value, String> {
    let response: Value = session
        .client
        .get(format!("{}/proxies", session.base))
        .send()
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?
        .json()
        .await
        .map_err(|e| e.to_string())?;
    Ok(response["proxies"].clone())
}
async fn whitelist_file(state: &AppState) -> Result<(), String> {
    let path = "/opt/etc/mihomo/ruleset/autoswitch-whitelist.mrs";
    if std::fs::metadata(path).is_ok_and(|m| m.len() > 4) {
        return Ok(());
    }
    let mut response = state
        .http_client
        .get("https://raw.githubusercontent.com/hydraponique/roscomvpn-geosite/release/mihomo/whitelist.mrs")
        .timeout(Duration::from_secs(20))
        .send()
        .await
        .map_err(|_| "Не удалось скачать Whitelist для Mihomo")?
        .error_for_status()
        .map_err(|_| "Источник Whitelist недоступен")?;
    if response.content_length().is_some_and(|n| n > 2_000_000) {
        return Err("Слишком большой Whitelist".into());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| "Не удалось прочитать Whitelist")? {
        if bytes.len() + chunk.len() > 2_000_000 {
            return Err("Слишком большой Whitelist".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    if !bytes.starts_with(&[0x28, 0xb5, 0x2f, 0xfd]) {
        return Err("Источник вернул неверный MRS Whitelist".into());
    }
    std::fs::create_dir_all("/opt/etc/mihomo/ruleset").map_err(|e| e.to_string())?;
    atomic(path, &bytes)
}
async fn apply(
    state: &AppState, core: &str, before: &str, after: &str, choices: &BTreeMap<String, String>,
) -> Result<(), String> {
    if core == "xray" {
        let Json(result) = crate::xray_routes::apply_routes(
            State(state.clone()),
            Json(crate::xray_routes::ApplyRoutesRequest {
                file: XRAY.into(),
                previous_content: before.into(),
                content: after.into(),
            }),
        )
        .await;
        if result["success"] != true {
            return Err(result["error"].as_str().unwrap_or("Xray не применил маршруты").into());
        }
    } else {
        let _guard = state.app_config_lock.lock().await;
        if state.core.read().unwrap().name != core {
            return Err("Активное ядро изменилось".into());
        }
        if std::fs::read_to_string(MIHOMO).map_err(|e| e.to_string())? != before {
            return Err("Маршруты уже изменились, повторите проверку".into());
        }
        whitelist_file(state).await?;
        crate::configs::validate_core(
            "mihomo",
            &[crate::configs::ConfigReq {
                file: MIHOMO.into(),
                content: after.into(),
            }],
        )
        .await?;
        let mut session = crate::geodata_update::MihomoReload::prepare().await?;
        let original = session.selectors.clone();
        atomic(MIHOMO, after.as_bytes())?;
        let doc = routes::document(after)?;
        let selectable: std::collections::BTreeSet<String> = doc["proxy-groups"]
            .as_vec()
            .into_iter()
            .flatten()
            .filter(|g| g["type"].as_str() == Some("select"))
            .filter_map(|g| g["name"].as_str().map(str::to_owned))
            .collect();
        session.selectors = choices
            .iter()
            .filter(|(g, _)| selectable.contains(*g))
            .map(|(g, n)| (g.clone(), n.clone()))
            .collect();
        if let Err(error) = session.reload().await {
            atomic(MIHOMO, before.as_bytes())?;
            session.selectors = original;
            let rollback = session.reload().await;
            return Err(format!(
                "Не удалось применить Mihomo: {error}; откат: {}",
                if rollback.is_ok() {
                    "выполнен"
                } else {
                    "не подтверждён"
                }
            ));
        }
    }
    REVISION.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    Ok(())
}
async fn seed(state: &AppState, settings: &Settings) -> Result<(), String> {
    let core = state.core.read().unwrap().name.clone();
    if journal(&core)?.is_some() {
        return Ok(());
    }
    let before = std::fs::read_to_string(file(&core)).map_err(|e| e.to_string())?;
    let (after, choices) = if core == "xray" {
        if !Path::new("/opt/etc/xray/dat/roscomvpn-geosite.dat").exists() {
            return Err("Нужен roscomvpn-geosite.dat с категорией whitelist".into());
        }
        (
            routes::xray_plan(&before, reserve_name(&core, &settings.target), false)?,
            BTreeMap::new(),
        )
    } else {
        let session = crate::geodata_update::MihomoReload::prepare().await?;
        routes::mihomo_plan(
            &before,
            reserve_name(&core, &settings.target),
            &live(&session).await?,
            false,
        )?
    };
    if after != before {
        apply(state, &core, &before, &after, &choices).await?
    }
    Ok(())
}
async fn reserve_ready(target: &str) -> Result<(), String> {
    let ready = if target == "csqtt" {
        Path::new("/sys/class/net/csqtt0").exists()
    } else {
        tokio::net::TcpStream::connect("127.0.0.1:1088").await.is_ok()
    };
    if ready {
        return Ok(());
    }
    let Json(result) = if target == "csqtt" {
        crate::csqtt::control(Json(crate::csqtt::ControlRequest { action: "start".into() })).await
    } else {
        crate::wdtt_plus::control(Json(crate::wdtt_plus::ControlRequest { action: "start".into() })).await
    };
    if result["success"] != true {
        return Err(result["error"]
            .as_str()
            .unwrap_or("Резервный сервис не запустился")
            .into());
    }
    Ok(())
}
async fn switch(state: &AppState, settings: &Settings) -> Result<(), String> {
    let core = state.core.read().unwrap().name.clone();
    if journal(&core)?.is_some() {
        return Ok(());
    }
    let before = std::fs::read_to_string(file(&core)).map_err(|e| e.to_string())?;
    let target = reserve_name(&core, &settings.target);
    let (after, choices) = if core == "xray" {
        (routes::xray_plan(&before, target, true)?, BTreeMap::new())
    } else {
        let session = crate::geodata_update::MihomoReload::prepare().await?;
        routes::mihomo_plan(&before, target, &live(&session).await?, true)?
    };
    let saved = Journal {
        core: core.clone(),
        target: target.into(),
        before: before.clone(),
        after: after.clone(),
        choices: choices.clone(),
        global_bypass: Path::new("/opt/etc/xkeen/global_direct_mihomo.flag").exists(),
        at: now(),
    };
    atomic(
        &journal_path(&core),
        &serde_json::to_vec(&saved).map_err(|e| e.to_string())?,
    )?;
    if let Err(error) = apply(state, &core, &before, &after, &choices).await {
        return Err(format!("{error}. Снимок сохранён для возврата"));
    }
    if core == "mihomo" {
        let Json(result) = crate::device_bypass::mihomo_devices(
            State(state.clone()),
            Json(crate::device_bypass::MihomoDevicesRequest { ips: vec![] }),
        )
        .await;
        let global = crate::device_bypass::set_global_direct("mihomo", false).await;
        if result["success"] != true || global.is_err() {
            let rollback = restore_inner(state).await;
            return Err(format!(
                "Не удалось синхронизировать полный обход; откат {}",
                if rollback.is_ok() {
                    "выполнен"
                } else {
                    "не подтверждён, снимок сохранён"
                }
            ));
        }
    }
    crate::logger::log(
        "INFO",
        format!("Автопереключение {core}: включён резерв {target}; RU выключено, Whitelist DIRECT включён"),
    );
    Ok(())
}
async fn restore_inner(state: &AppState) -> Result<(), String> {
    let core = state.core.read().unwrap().name.clone();
    let saved = journal(&core)?.ok_or("Нет активного резервного режима для этого ядра")?;
    let current = std::fs::read_to_string(file(&core)).map_err(|e| e.to_string())?;
    let (content, choices) = if core == "xray" {
        (
            routes::restore_xray(&current, &saved.before, &saved.after)?,
            BTreeMap::new(),
        )
    } else {
        let session = crate::geodata_update::MihomoReload::prepare().await?;
        routes::restore_mihomo(
            &current,
            &saved.before,
            &saved.after,
            &live(&session).await?,
            &saved.target,
        )?
    };
    apply(state, &core, &current, &content, &choices).await?;
    if core == "mihomo" {
        let mut ips = Vec::new();
        for line in content.lines() {
            if let Some(marker) = line.strip_prefix("  # xkeen-device-start ") {
                if let Some((ip, value)) = marker.split_once(' ') {
                    if let Ok(raw) = urlencoding::decode(value) {
                        if let Ok(choices) = serde_json::from_str::<Value>(&raw) {
                            if choices["VPN"] == "DIRECT" {
                                if let Ok(ip) = ip.parse() {
                                    ips.push(ip)
                                }
                            }
                        }
                    }
                }
            }
        }
        let Json(result) = crate::device_bypass::mihomo_devices(
            State(state.clone()),
            Json(crate::device_bypass::MihomoDevicesRequest { ips }),
        )
        .await;
        if result["success"] != true {
            return Err("Прежние маршруты возвращены; обход устройств не синхронизирован, снимок сохранён".into());
        }
        crate::device_bypass::set_global_direct("mihomo", saved.global_bypass).await?;
    }
    std::fs::remove_file(journal_path(&core)).map_err(|e| e.to_string())?;
    crate::logger::log(
        "INFO",
        format!("Автопереключение {core}: прежние маршруты восстановлены"),
    );
    Ok(())
}
pub async fn get_settings(State(state): State<AppState>) -> Json<Value> {
    let core = state.core.read().unwrap().name.clone();
    let saved = journal(&core);
    let status = status_cell().lock().await.clone();
    Json(
        json!({"success":true,"settings":read_settings(),"status":status,"core":core,"revision":REVISION.load(std::sync::atomic::Ordering::Relaxed),"fallbackActive":saved.as_ref().ok().is_some_and(|j|j.is_some()),"snapshotError":saved.err()}),
    )
}
pub async fn save_settings(State(state): State<AppState>, Json(settings): Json<Settings>) -> Json<Value> {
    let Ok(_guard) = gate().try_lock() else {
        return Json(json!({"success":false,"error":"Проверка ещё идёт"}));
    };
    let result=async{validate(&settings)?;
  if settings.target!=read_settings().target && ["xray","mihomo"].iter().any(|c|Path::new(&journal_path(c)).exists()){return Err("Сначала верните прежние маршруты в обоих ядрах, затем меняйте резерв".into())}
  if settings.enabled{seed(&state,&settings).await?}
  atomic(SETTINGS,&serde_json::to_vec_pretty(&settings).map_err(|e|e.to_string())?)?;
  *status_cell().lock().await=json!({"phase":if settings.enabled{"monitoring"}else{"disabled"},"failures":0,"recoveries":0,"lastChecked":0,"foreign":[],"whitelist":[]});Ok::<_,String>(())
 }.await;
    match result {
        Ok(()) => Json(json!({"success":true})),
        Err(e) => Json(json!({"success":false,"error":e})),
    }
}

async fn round(state: &AppState, apply_changes: bool) -> Result<(), String> {
    let _guard = gate().try_lock().map_err(|_| "Проверка уже идёт")?;
    let settings = read_settings();
    validate(&settings)?;
    let core = state.core.read().unwrap().name.clone();
    if apply_changes && settings.enabled {
        seed(state, &settings).await?
    }
    let tester = probe::Prober::start(&settings.target).await?;
    let (foreign, whitelist) = tokio::join!(
        tester.check(&settings.foreign_urls, false),
        tester.check(&settings.whitelist_urls, false)
    );
    let (blocked, healthy) = routes::classification(&foreign, &whitelist);
    let active = journal(&core)?.is_some();
    let previous = status_cell().lock().await.clone();
    let failures = if blocked {
        previous["failures"].as_u64().unwrap_or(0) + 1
    } else {
        0
    };
    let recoveries = if healthy {
        previous["recoveries"].as_u64().unwrap_or(0) + 1
    } else {
        0
    };
    *status_cell().lock().await = json!({"phase":if active{"fallback"}else if blocked{"suspected"}else if healthy{"monitoring"}else{"uncertain"},"lastChecked":now(),"foreign":foreign,"whitelist":whitelist,"failures":if apply_changes{failures}else{0},"recoveries":if apply_changes{recoveries}else{0},"dryRun":!apply_changes});
    if !apply_changes || !settings.enabled {
        return Ok(());
    }
    if read_settings() != settings || state.core.read().unwrap().name != core {
        return Err("Настройки или активное ядро изменились во время проверки".into());
    }
    if !active && blocked && failures >= 2 {
        reserve_ready(&settings.target).await?;
        let reserve = tester.check(&settings.foreign_urls, true).await;
        status_cell().lock().await["reserve"] = json!(reserve);
        if !reserve.iter().any(|r| r["ok"] == true) {
            return Err("Резерв не открыл ни один тестовый зарубежный сайт. Правила не изменены".into());
        }
        // Recheck the WAN signature after a potentially slow reserve startup.
        let (f, w) = tokio::join!(
            tester.check(&settings.foreign_urls, false),
            tester.check(&settings.whitelist_urls, false)
        );
        if !routes::classification(&f, &w).0 {
            return Err("Пока запускался резерв, доступ изменился. Переключение отменено".into());
        }
        if read_settings() != settings || state.core.read().unwrap().name != core {
            return Err("Настройки изменились; переключение отменено".into());
        }
        switch(state, &settings).await?;
        status_cell().lock().await["phase"] = json!("fallback");
    } else if active && healthy && recoveries >= 2 {
        restore_inner(state).await?;
        status_cell().lock().await["phase"] = json!("monitoring")
    }
    Ok(())
}
pub async fn check(State(state): State<AppState>) -> Json<Value> {
    match round(&state, false).await {
        Ok(()) => get_settings(State(state)).await,
        Err(e) => Json(json!({"success":false,"error":e})),
    }
}
pub async fn restore(State(state): State<AppState>) -> Json<Value> {
    let Ok(_guard) = gate().try_lock() else {
        return Json(json!({"success":false,"error":"Дождитесь окончания проверки"}));
    };
    match restore_inner(&state).await {
        Ok(()) => {
            let mut status = status_cell().lock().await;
            status["phase"] = json!(if read_settings().enabled {
                "monitoring"
            } else {
                "disabled"
            });
            status["failures"] = json!(0);
            status["recoveries"] = json!(0);
            status.as_object_mut().unwrap().remove("error");
            Json(json!({"success":true}))
        }
        Err(e) => Json(json!({"success":false,"error":e})),
    }
}
pub fn start(state: AppState) {
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(5)).await;
            let settings = read_settings();
            if !settings.enabled {
                continue;
            }
            let last = status_cell().lock().await["lastChecked"].as_u64().unwrap_or(0);
            if now().saturating_sub(last) < settings.interval_seconds {
                continue;
            }
            if let Err(error) = round(&state, true).await {
                if error == "Проверка уже идёт" {
                    continue;
                }
                let mut status = status_cell().lock().await;
                status["phase"] = json!("error");
                status["error"] = json!(error);
                status["lastChecked"] = json!(now());
                status["failures"] = json!(0);
                status["recoveries"] = json!(0)
            }
        }
    });
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn signature_requires_all_foreign_and_any_white() {
        let fail = vec![json!({"ok":false}); 5];
        let mut partial = fail.clone();
        partial[0] = json!({"ok":true});
        assert_eq!(routes::classification(&fail, &[json!({"ok":true})]), (true, false));
        assert_eq!(routes::classification(&fail, &[]), (false, false));
        assert_eq!(routes::classification(&partial, &[json!({"ok":true})]), (false, false));
    }
    #[test]
    fn recovery_needs_three_foreign() {
        assert!(routes::classification(&vec![json!({"ok":true}); 5], &[]).1);
        assert!(!routes::classification(&vec![json!({"ok":false}); 5], &[]).1);
    }
    #[test]
    fn accepts_presets_and_whole_hour_intervals() {
        let mut settings = Settings::default();
        for seconds in [60, 300, 900, 1800, 3600, 24 * 3600, 744 * 3600] {
            settings.interval_seconds = seconds;
            assert!(validate(&settings).is_ok(), "interval {seconds}");
        }
        for seconds in [0, 29, 744 * 3600 + 1, u64::MAX] {
            settings.interval_seconds = seconds;
            assert!(validate(&settings).is_err(), "interval {seconds}");
        }
    }
    #[test]
    fn reject_unsafe_settings() {
        let mut s = Settings::default();
        assert!(validate(&s).is_ok());
        s.foreign_urls[0] = "https://127.0.0.1/".into();
        assert!(validate(&s).is_err());
    }
}
