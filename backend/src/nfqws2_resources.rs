use super::*;
use serde::Serialize;

const CONFIG: &str = "/opt/etc/xkeen/nfqws2-stage/resources.json";
const AUTO_STATE: &str = "/var/run/xkeen-ui-nfqws2-auto.json";
const SITES: [(&str, &str, &str); 3] = [
    ("youtube", "YouTube", "https://www.youtube.com/generate_204"),
    ("discord", "Discord", "https://discord.com/"),
    ("instagram", "Instagram", "https://www.instagram.com/"),
];

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Resource { pub id: String, pub name: String, pub url: String }

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Config {
    pub selected: Vec<String>,
    #[serde(default)] pub custom: Vec<Resource>,
    pub auto_enabled: bool,
    pub interval_hours: u64,
}

impl Default for Config {
    fn default() -> Self { Self { selected: SITES.iter().map(|site| site.0.into()).collect(), custom: vec![], auto_enabled: false, interval_hours: 12 } }
}

fn sites_for(settings: &Config) -> Vec<Resource> {
    SITES.iter().map(|site| Resource {id:site.0.into(),name:site.1.into(),url:site.2.into()}).chain(settings.custom.iter().cloned()).collect()
}

fn validate(settings: &mut Config) -> Result<(),String> {
    if settings.custom.len()>5 || settings.selected.is_empty() || settings.selected.len()>8 || !(1..=168).contains(&settings.interval_hours) {
        return Err("Выберите 1–8 ресурсов, до 5 своих сайтов и интервал 1–168 часов".into());
    }
    let mut ids: std::collections::HashSet<String> = SITES.iter().map(|site|site.0.to_owned()).collect();
    let mut urls: std::collections::HashSet<String> = SITES.iter().map(|site|site.2.to_owned()).collect();
    for site in &mut settings.custom {
        site.name=site.name.trim().to_owned();
        if site.name.is_empty() || site.name.chars().count()>60 || site.id.is_empty() || site.id.len()>80
            || !site.id.bytes().all(|c|c.is_ascii_alphanumeric() || matches!(c,b'-'|b'_')) || !ids.insert(site.id.clone()) { return Err("Проверьте названия и уникальность ресурсов".into()); }
        let input=site.url.trim();
        let address=if input.contains("://") { input.to_owned() } else { format!("https://{input}") };
        let parsed=reqwest::Url::parse(&address).map_err(|_|"Укажите домен или HTTPS-ссылку")?;
        if parsed.scheme()!="https" || parsed.host_str().is_none() || parsed.port().is_some() || !parsed.username().is_empty() || parsed.password().is_some() || parsed.fragment().is_some()
            || parsed.as_str().len()>2048 || parsed.as_str().bytes().any(|c|c.is_ascii_whitespace()) { return Err("Нужна HTTPS-ссылка без логина, пароля, порта и #фрагмента".into()); }
        site.url=parsed.to_string();
        if !urls.insert(site.url.clone()) { return Err("Такой адрес уже есть в таблице".into()); }
    }
    if settings.selected.iter().any(|id| !ids.contains(id)) { return Err("Выбран неизвестный ресурс".into()); }
    settings.selected=sites_for(settings).iter().filter(|site|settings.selected.contains(&site.id)).map(|site|site.id.clone()).collect();
    Ok(())
}

pub fn config() -> Config {
    std::fs::read(CONFIG).ok().and_then(|bytes|serde_json::from_slice::<Config>(&bytes).ok())
        .and_then(|mut settings|validate(&mut settings).ok().map(|_|settings)).unwrap_or_default()
}

pub fn sites() -> Vec<Resource> { sites_for(&config()) }
pub fn urls() -> Vec<String> {
    let settings=config();
    sites_for(&settings).into_iter().filter(|site|settings.selected.contains(&site.id)).map(|site|site.url).collect()
}
pub fn key() -> String { strategy_key("resources","v2",&urls().join("\n")) }

fn auto_state() -> Value {
    std::fs::read(AUTO_STATE).ok().and_then(|bytes| serde_json::from_slice(&bytes).ok()).unwrap_or_else(|| json!({}))
}

pub fn configuration() -> Value {
    json!({"success":true, "config":config(), "sites": sites(), "automatic":auto_state()})
}

pub async fn get() -> Json<Value> { Json(configuration()) }

pub async fn save(Json(mut request): Json<Config>) -> Json<Value> {
    let result: Result<(), String> = async {
        let _guard = SETTINGS_LOCK.get_or_init(|| Mutex::new(())).try_lock().map_err(|_| "Дождитесь завершения проверки или подбора")?;
        if search::is_running().await { return Err("Дождитесь завершения подбора".into()); }
        validate(&mut request)?;
        tokio::fs::create_dir_all(ROOT).await.map_err(|e| e.to_string())?;
        let next = format!("{CONFIG}.new");
        tokio::fs::write(&next, serde_json::to_vec(&request).map_err(|e| e.to_string())?).await.map_err(|e| e.to_string())?;
        tokio::fs::set_permissions(&next, std::fs::Permissions::from_mode(0o600)).await.map_err(|e| e.to_string())?;
        tokio::fs::rename(next, CONFIG).await.map_err(|e| e.to_string())?;
        *PREVIEW.get_or_init(|| Mutex::new(None)).lock().await = None;
        // A new schedule starts a full interval from this save, including after a restart.
        search::clear_history().await;
        write_auto("Настройки сохранены", false).await;
        Ok(())
    }.await;
    match result { Ok(()) => get().await, Err(error) => Json(json!({"success":false,"error":error})) }
}

pub async fn dns() -> Json<Value> {
    let Ok(_guard) = SETTINGS_LOCK.get_or_init(|| Mutex::new(())).try_lock() else { return Json(json!({"success":false,"error":"Дождитесь завершения подбора или проверки"})); };
    let client = match reqwest::Client::builder().no_proxy().timeout(Duration::from_secs(5))
        .resolve("cloudflare-dns.com", "1.1.1.1:443".parse().unwrap()).build() {
        Ok(client) => client, Err(error) => return Json(json!({"success":false,"error":error.to_string()})),
    };
    let rows = futures_util::future::join_all(sites().into_iter().map(|site| {
        let client = &client;
        async move {
            let host = reqwest::Url::parse(&site.url).unwrap().host_str().unwrap().to_owned();
            let local = async {
                match tokio::time::timeout(Duration::from_secs(5), tokio::net::lookup_host((host.as_str(),443))).await {
                    Ok(Ok(addresses)) => (addresses.filter(|address| address.is_ipv4()).map(|address| address.ip().to_string()).collect::<std::collections::BTreeSet<_>>().into_iter().collect::<Vec<_>>(), None),
                    Ok(Err(error)) => (vec![], Some(error.to_string())), Err(_) => (vec![], Some("Тайм-аут DNS".into())),
                }
            };
            let trusted = async {
                let response = client.get("https://cloudflare-dns.com/dns-query").query(&[("name",host.as_str()),("type","A")]).header("accept","application/dns-json").send().await;
                match response {
                    Ok(response) => match response.error_for_status() {
                        Ok(response) => match response.json::<Value>().await {
                            Ok(value) if value["Status"] == 0 => (value["Answer"].as_array().into_iter().flatten().filter(|answer| answer["type"] == 1).filter_map(|answer| answer["data"].as_str().map(str::to_string)).collect::<Vec<_>>(), None),
                            Ok(value) => (vec![],Some(format!("DNS-код {}",value["Status"]))), Err(error) => (vec![],Some(error.to_string())),
                        }, Err(error) => (vec![],Some(error.to_string())),
                    }, Err(error) => (vec![],Some(error.to_string())),
                }
            };
            let ((local, local_error),(encrypted, encrypted_error)) = tokio::join!(local,trusted);
            let status = if local.is_empty() && !encrypted.is_empty() { "local-failure" }
                else if local.is_empty() || encrypted.is_empty() { "incomplete" }
                else if !local.iter().any(|ip| encrypted.contains(ip)) { "different" } else { "resolved" };
            json!({"id":site.id,"name":site.name,"local":local,"encrypted":encrypted,"status":status,"localError":local_error,"encryptedError":encrypted_error})
        }
    })).await;
    Json(json!({"success":true,"checkedAt":chrono::Utc::now().to_rfc3339(),"results":rows}))
}

async fn write_auto(message: &str, running: bool) {
    let stamp = chrono::Utc::now().to_rfc3339();
    let last_attempt = if running { json!(stamp) } else { auto_state()["lastAttemptAt"].clone() };
    let state = json!({"checkedAt":stamp,"lastAttemptAt":last_attempt,"message":message,"running":running});
    if let Ok(bytes) = serde_json::to_vec(&state) {
        let next = format!("{AUTO_STATE}.new");
        if tokio::fs::write(&next,bytes).await.is_ok() { let _ = tokio::fs::rename(next,AUTO_STATE).await; }
    }
}

fn verification_due(now: i64, checked: Option<i64>, attempted: Option<i64>, interval_seconds: i64) -> bool {
    let age = |stamp: i64| if stamp <= now { now.saturating_sub(stamp) } else { i64::MAX };
    checked.is_none_or(|stamp| age(stamp) >= interval_seconds)
        && attempted.is_none_or(|stamp| age(stamp) >= 300)
}

pub fn start_scheduler() {
    tokio::spawn(async {
        loop {
            tokio::time::sleep(Duration::from_secs(60)).await;
            let settings = config();
            if !settings.auto_enabled || Path::new(MANUAL_STOPPED).exists() { continue; }
            // The reconciler ticks every 15 seconds and can collide with every
            // 60-second poll. Queue briefly instead of starving on try_lock.
            let Ok(_guard) = tokio::time::timeout(Duration::from_secs(5),
                SETTINGS_LOCK.get_or_init(|| Mutex::new(())).lock()).await else { continue; };
            let settings = config();
            if !settings.auto_enabled || Path::new(MANUAL_STOPPED).exists() { continue; }
            let timestamp = |value: &Value| value.as_str().and_then(|stamp| chrono::DateTime::parse_from_rfc3339(stamp).ok()).map(|stamp| stamp.timestamp());
            let checked = matching_check().as_ref().and_then(|report| timestamp(&report["checkedAt"]));
            let attempted = timestamp(&auto_state()["lastAttemptAt"]);
            if !verification_due(chrono::Utc::now().timestamp(), checked, attempted, (settings.interval_hours * 3600) as i64) { continue; }
            if search::is_running().await || status_json().await["running"] != true { continue; }
            search::reset_cancel();
            search::begin_automatic().await;
            write_auto("Проверка текущей стратегии",true).await;
            let result = automatic_check().await;
            let message = result.unwrap_or_else(|error| format!("Автопроверка: {error}"));
            search::end_automatic(&message).await;
            write_auto(&message,false).await;

        }
    });
}

fn coverage(report: &Value) -> (u64,u64) {
    (report["tcpSites"].as_u64().unwrap_or(0),report["http3Sites"].as_u64().unwrap_or(0))
}

fn full_coverage(report: &Value, mode: &str) -> bool {
    full_counts(coverage(report),required_tcp_sites(),mode)
}

fn full_counts((tcp,quic): (u64,u64), required: u64, mode: &str) -> bool {
    required > 0 && tcp == required && (mode == "tcp" || quic == required)
}

async fn automatic_check() -> Result<String,String> {
    let mode = profile();
    let args = tokio::fs::read_to_string(CUSTOM).await.unwrap_or_default();
    let first = run_active_probe(active_source(&args),&mode,&args).await?;
    persist_check(&first).await?;
    if first["results"].as_array().into_iter().flatten().any(|row| row["protocol"] == "tcp" && row["errorStage"] == "dns" && row["ok"] == false) {
        return Err("Не удалось разрешить имя ресурса; проверьте DNS во вкладке «Ресурсы»".into());
    }
    if full_coverage(&first,&mode) { return Ok("Все выбранные ресурсы работают в выбранном режиме; замена не требуется".into()); }
    let baseline = run_active_probe(active_source(&args),&mode,&args).await?;
    persist_check(&baseline).await?;
    if full_coverage(&baseline,&mode) { return Ok("Полный результат подтверждён повторной проверкой".into()); }
    let result = if mode == "tcp-quic" { search::expanded_scan(args.contains("--filter-udp=1024-65535")).await? }
        else { search::scan(false,&mode).await? };
    let (_, next_mode, mut next_args) = result;
    if args.contains("--filter-udp=1024-65535") && !next_args.contains("--filter-udp=1024-65535") { next_args.push_str(search::GAMES_ARGS); }
    if next_mode != mode { return Err("Выбранный транспорт не подтверждён".into()); }
    let candidate = search::probe("preset",&next_mode,&next_args,5).await?;
    // Compare against the current strategy again: temporary network recovery must
    // not be mistaken for an improvement caused by the candidate.
    let current = run_active_probe(active_source(&args),&mode,&args).await?;
    if !full_coverage(&candidate,&next_mode) { persist_check(&current).await?; return Ok("Стратегия с полным результатом TCP и QUIC не найдена; прежняя сохранена".into()); }
    if coverage(&candidate) <= coverage(&current) { persist_check(&current).await?; return Ok("Текущая стратегия не хуже; замена не требуется".into()); }
    if search::cancelled() { return Err("Автоподбор остановлен".into()); }
    let old_automatic = Path::new(AUTO_SELECTION).exists();
    apply_checked(&next_mode,&next_args,true,&candidate).await?;
    // Complete this verification even after cancellation: a failed candidate
    // must not remain installed merely because the user stopped the search.
    let verified = run_active_probe("preset",&next_mode,&next_args).await;
    match verified {
        Ok(report) if full_coverage(&report,&next_mode) && coverage(&report) > coverage(&current) => {
            persist_check(&report).await?;
            search::remember(&next_mode,&next_args,&report).await?;
            Ok("Лучшая стратегия применена и повторно проверена".into())
        }
        _ => {
            apply_checked(&mode,&args,old_automatic,&current).await
                .map_err(|error| format!("Повторная проверка не прошла; ошибка отката: {error}"))?;
            if status_json().await["running"] != true { run_canary("start").await?; }
            if status_json().await["running"] != true { return Err("Прежние параметры восстановлены, но nfqws2 не запустился".into()); }
            Err("Повторная проверка не подтвердила улучшение; прежняя стратегия восстановлена".into())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn verification_tracks_measurement_not_settings_save_or_search_completion() {
        assert!(verification_due(7200, Some(0), None, 3600));
        assert!(!verification_due(7200, Some(7000), Some(7000), 3600));
        assert!(verification_due(7200, Some(3000), Some(6000), 3600));
        assert!(!verification_due(7200, Some(3000), Some(7100), 3600));
        assert!(verification_due(7200, None, None, 3600));
        assert!(verification_due(7200, Some(8000), None, 3600));
    }
    #[test]
    fn improvement_requires_more_coverage_without_sacrificing_tcp() {
        let current = json!({"tcpSites":3,"http3Sites":1});
        assert!(!full_counts((3,2),3,"tcp-quic"));
        assert!(full_counts((3,3),3,"tcp-quic"));
        assert!(!full_counts((2,3),3,"tcp-quic"));
        assert!(full_counts((3,0),3,"tcp"));
        assert!(!full_counts((0,0),0,"tcp-quic"));
        assert!(coverage(&json!({"tcpSites":2,"http3Sites":3})) < coverage(&current));
        assert_eq!(coverage(&current),coverage(&json!({"tcpSites":3,"http3Sites":1})));
    }
}
