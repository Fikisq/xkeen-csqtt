use super::*;



const LISTS: &str = "/opt/etc/xkeen/nfqws2-stage/strategy-lists.json";

#[derive(Clone, Deserialize, serde::Serialize)]
pub struct Strategy { pub id: String, pub name: String, pub args: String }
#[derive(Clone, Deserialize, serde::Serialize)]
pub struct StrategyList { pub id: String, pub name: String, pub enabled: bool, pub entries: Vec<Strategy> }

fn read_lists() -> Result<Vec<StrategyList>, String> {
    match std::fs::read(LISTS) {
        Ok(bytes) => {
            let mut lists: Vec<StrategyList> = serde_json::from_slice(&bytes).map_err(|_| "Не удалось прочитать списки стратегий. Файл сохранён без изменений")?;
            // Clarify only unchanged stock names; never replace user parameters or renamed entries.
            let seed: Value = serde_json::from_str(include_str!("../../router/nfqws2-flowseal.json")).map_err(|e| e.to_string())?;
            for list in &mut lists {
                for entry in &mut list.entries {
                    if !matches!(entry.name.as_str(), "Flowseal 1.10.3 · general (ALT7) · Общий TLS" | "Flowseal 1.10.3 · general (ALT9) · Общий TLS") { continue; }
                    if let Some(stock) = seed["entries"].as_array().into_iter().flatten().find(|stock| stock["args"].as_str() == Some(entry.args.as_str())
                        && stock["name"].as_str().is_some_and(|name| name.strip_prefix(&entry.name).is_some_and(|suffix| suffix.starts_with(" · ")))) {
                        entry.name = stock["name"].as_str().unwrap_or(&entry.name).to_string();
                    }
                }
            }
            Ok(lists)
        },
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            let seed: Value = serde_json::from_str(include_str!("../../router/nfqws2-flowseal.json")).map_err(|e| e.to_string())?;
            let entries = seed["entries"].as_array().into_iter().flatten().enumerate().map(|(index, entry)| Strategy {
                id: entry["id"].as_str().map(str::to_string).unwrap_or_else(|| format!("flowseal-{index}")), name: entry["name"].as_str().unwrap_or("Стратегия").into(), args: entry["args"].as_str().unwrap_or_default().into()
            }).collect();
            Ok(vec![StrategyList { id: "flowseal".into(), name: "Flowseal · адаптации для nfqws2".into(), enabled: true, entries }])
        }
        Err(error) => Err(error.to_string()),
    }
}

pub fn entries() -> Vec<Value> {
    let mut seen = std::collections::HashSet::new();
    read_lists().unwrap_or_default().into_iter().filter(|list| list.enabled).flat_map(|list| list.entries.into_iter().map(move |entry|
        json!({"id": entry.id, "name": format!("{} · {}", list.name, entry.name), "args": entry.args})))
        .filter(|entry| {
            let args = entry["args"].as_str().unwrap_or_default().lines().map(str::trim).filter(|line| !line.is_empty()).collect::<Vec<_>>().join("\n");
            seen.insert(strategy_key("lists", "args", &args))
        }).collect()
}

fn revision(lists: &[StrategyList]) -> String {
    // Stock title clarification is cosmetic: drafts opened before this update remain saveable.
    let mut canonical = lists.to_vec();
    for list in &mut canonical {
        for entry in &mut list.entries {
            for legacy in ["Flowseal 1.10.3 · general (ALT7) · Общий TLS", "Flowseal 1.10.3 · general (ALT9) · Общий TLS"] {
                if entry.name.strip_prefix(legacy).is_some_and(|suffix| matches!(suffix, " · multisplit" | " · syndata" | " · с TCP MD5" | " · без TCP MD5")) {
                    entry.name = legacy.to_string();
                    break;
                }
            }
        }
    }
    strategy_key("lists", "v1", &serde_json::to_string(&canonical).unwrap_or_default())
}

pub async fn get() -> Json<Value> {
    match read_lists() {
        Ok(lists) => Json(json!({"success": true, "revision": revision(&lists), "lists": lists, "requiredTcpSites": REQUIRED_TCP_SITES})),
        Err(error) => Json(json!({"success": false, "error": error})),
    }
}

#[derive(Deserialize)]
pub struct ListsRequest { revision: String, lists: Vec<StrategyList> }

pub async fn save(Json(mut request): Json<ListsRequest>) -> Json<Value> {
    let result: Result<(), String> = async {
        let _guard = SETTINGS_LOCK.get_or_init(|| Mutex::new(())).try_lock().map_err(|_| "Дождитесь завершения проверки")?;
        if search::is_running().await { return Err("Остановите подбор перед изменением списков".into()); }
        if revision(&read_lists()?) != request.revision { return Err("Списки изменены в другой вкладке. Закройте редактор и откройте снова".into()); }
        if request.lists.len() > 16 { return Err("Можно сохранить до 16 списков".into()); }
        let mut ids = std::collections::HashSet::new();
        let mut count = 0;
        for list in &mut request.lists {
            list.name = list.name.trim().to_string();
            if list.name.is_empty() || list.name.chars().count() > 120 || list.id.len() > 100 || !ids.insert(list.id.clone()) { return Err("Укажите уникальный список с названием до 120 символов".into()); }
            let mut entry_ids = std::collections::HashSet::new();
            for entry in &mut list.entries {
                count += 1;
                entry.name = entry.name.trim().to_string();
                if entry.name.is_empty() || entry.name.chars().count() > 180 || entry.id.len() > 100 || !entry_ids.insert(entry.id.clone()) { return Err(format!("{}: проверьте названия стратегий", list.name)); }
                let (_, args) = candidate(&SettingsRequest { source: "custom".into(), custom_args: entry.args.clone(), allow_tcp_only: false })
                    .map_err(|error| format!("{} / {}: {error}", list.name, entry.name))?;
                entry.args = args;
            }
        }
        if count > 256 { return Err("Можно сохранить до 256 стратегий".into()); }
        let bytes = serde_json::to_vec(&request.lists).map_err(|e| e.to_string())?;
        if bytes.len() > 1024 * 1024 { return Err("Списки превышают 1 МБ".into()); }
        tokio::fs::create_dir_all(ROOT).await.map_err(|e| e.to_string())?;
        let next = format!("{LISTS}.new");
        tokio::fs::write(&next, bytes).await.map_err(|e| e.to_string())?;
        tokio::fs::set_permissions(&next, std::fs::Permissions::from_mode(0o600)).await.map_err(|e| e.to_string())?;
        tokio::fs::rename(next, LISTS).await.map_err(|e| e.to_string())?;
        Ok(())
    }.await;
    match result { Ok(()) => get().await, Err(error) => Json(json!({"success": false, "error": error})) }
}

/// Retain all 443 sections for the requested transport, preserving their order.
/// Other ports and game rules must never leak into a composed profile.
pub fn extract(args: &str, transport: &str) -> Result<String, String> {
    if args.len() > 32768 { return Err("Слишком длинная стратегия".into()); }
    let wanted = match transport { "tcp" => "--filter-tcp=443", "quic" => "--filter-udp=443", _ => return Err("Неизвестный транспорт".into()) };
    let mut sections: Vec<Vec<&str>> = vec![Vec::new()];
    for line in args.lines().map(str::trim).filter(|line| !line.is_empty()) {
        if line == "--new" { sections.push(Vec::new()); }
        else { sections.last_mut().unwrap().push(line); }
    }
    let mut selected = Vec::new();
    for block in sections.into_iter().filter(|block| block.contains(&wanted)) {
        if block.iter().filter(|line| line.starts_with("--filter-tcp=") || line.starts_with("--filter-udp=")).count() != 1
            || !block.iter().any(|line| line.starts_with("--lua-desync="))
            || block.iter().any(|line| line.len() > 8192 || !line.is_ascii()
                || line.bytes().any(|byte| byte.is_ascii_whitespace() || byte < 33 || byte > 126)
                || !(line == &wanted || line.starts_with("--lua-desync=")
                    || (transport == "tcp" && *line == "--filter-l7=tls") || (transport == "quic" && *line == "--filter-l7=quic")
                    || (transport == "tcp" && matches!(*line, "--payload=tls_client_hello" | "--payload=empty,tls_client_hello" | "--payload=empty"))
                    || (transport == "quic" && *line == "--payload=quic_initial")
                    || matches!(*line, "--out-range=-n2" | "--out-range=<s1" | "--out-range=s1<d1"))) {
            return Err("Блок 443 содержит несовместимые параметры. Нужны отдельные TCP и QUIC, параметры — по одному в строке".into());
        }
        selected.push(block.join("\n"));
    }
    if selected.is_empty() { return Err(format!("В источнике нет блока {} с --lua-desync", if transport == "tcp" { "TCP/443" } else { "QUIC/443" })); }
    Ok(selected.join("\n--new\n") + "\n")
}
