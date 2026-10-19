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
    let state = json!({"checkedAt":chrono::Utc::now().to_rfc3339(),"message":message,"running":running});
    if let Ok(bytes) = serde_json::to_vec(&state) {
        let next = format!("{AUTO_STATE}.new");
        if tokio::fs::write(&next,bytes).await.is_ok() { let _ = tokio::fs::rename(next,AUTO_STATE).await; }
    }
}

pub fn start_scheduler() {
    tokio::spawn(async {
        loop {
            tokio::time::sleep(Duration::from_secs(60)).await;
            let settings = config();
            if !settings.auto_enabled || Path::new(MANUAL_STOPPED).exists() { continue; }
            let last = auto_state()["checkedAt"].as_str().and_then(|stamp| chrono::DateTime::parse_from_rfc3339(stamp).ok());
            if last.is_none() { write_auto("Ожидание первой проверки",false).await; continue; }
            if last.is_some_and(|stamp| chrono::Utc::now().signed_duration_since(stamp).num_seconds() < (settings.interval_hours * 3600) as i64) { continue; }
            let Ok(_guard) = SETTINGS_LOCK.get_or_init(|| Mutex::new(())).try_lock() else { continue; };
            if search::is_running().await || status_json().await["running"] != true { continue; }
            search::reset_cancel();
            search::begin_automatic().await;
            write_auto("Проверка текущей стратегии",true).await;
            let result = automatic_check().await;
            let message = result.unwrap_or_else(|error| format!("Прежняя стратегия сохранена: {error}"));
            search::end_automatic(&message).await;
            write_auto(&message,false).await;
        }
    });
}

async fn automatic_check() -> Result<String,String> {
    let mode = profile();
    let args = tokio::fs::read_to_string(CUSTOM).await.unwrap_or_default();
    let first = search::probe(active_source(&args),&mode,&args,5).await?;
    persist_check(&first).await?;
    if first["results"].as_array().into_iter().flatten().any(|row| row["protocol"] == "tcp" && row["errorStage"] == "dns" && row["ok"] == false) {
        return Err("Не удалось разрешить имя ресурса; проверьте DNS во вкладке «Ресурсы»".into());
    }
    if healthy_report(&first,&mode) { return Ok("Текущая стратегия работает".into()); }
    let baseline = search::probe(active_source(&args),&mode,&args,5).await?;
    persist_check(&baseline).await?;
    if healthy_report(&baseline,&mode) { return Ok("Работа подтверждена повторной проверкой".into()); }
    let result = if mode == "tcp-quic" { search::expanded_scan(args.contains("--filter-udp=1024-65535")).await? }
        else { search::scan(false,&mode).await? };
    let (_, next_mode, mut next_args) = result;
    if args.contains("--filter-udp=1024-65535") && !next_args.contains("--filter-udp=1024-65535") { next_args.push_str(search::GAMES_ARGS); }
    if next_mode != mode { return Err("Выбранный транспорт не подтверждён".into()); }
    let candidate = search::probe("preset",&next_mode,&next_args,5).await?;
    // Compare against the current strategy again: temporary network recovery must
    // not be mistaken for an improvement caused by the candidate.
    let current = search::probe(active_source(&args),&mode,&args,5).await?;
    let score = |report: &Value| (report["tcpSites"].as_u64().unwrap_or(0),report["http3Sites"].as_u64().unwrap_or(0));
    if !healthy_report(&candidate,&next_mode) || score(&candidate) <= score(&current) { persist_check(&current).await?; return Ok("Текущая стратегия не хуже; замена не требуется".into()); }
    if search::cancelled() { return Err("Автоподбор остановлен".into()); }
    apply_checked(&next_mode,&next_args,true,&candidate).await?;
    Ok("Применена подтверждённая стратегия с лучшим результатом".into())
}
