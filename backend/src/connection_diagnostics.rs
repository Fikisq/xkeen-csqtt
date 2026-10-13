use axum::{extract::Query, Json};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{collections::HashMap, fs::File, io::{Read, Seek, SeekFrom}, net::{IpAddr, Ipv4Addr}, time::Duration};
use crate::types::{access_log_path, error_log_path};

#[derive(Deserialize)]
pub struct Request { device: Ipv4Addr, resource: String }

fn tail(path: &str) -> String {
    let Ok(mut file) = File::open(path) else { return String::new(); };
    let start = file.metadata().map(|m| m.len().saturating_sub(1024 * 1024)).unwrap_or(0);
    let _ = file.seek(SeekFrom::Start(start));
    let mut bytes = Vec::new();
    let _ = file.take(1024 * 1024).read_to_end(&mut bytes);
    let text = String::from_utf8_lossy(&bytes).into_owned();
    if start > 0 { text.split_once('\n').map(|(_, rest)| rest.to_owned()).unwrap_or_default() } else { text }
}

fn in_cidr(value: &str, address: IpAddr) -> Option<bool> {
    let (base, bits) = value.split_once('/').map(|(a, b)| (a, b.parse::<u32>().ok())).unwrap_or((value, None));
    let base = base.parse::<IpAddr>().ok()?;
    match (base, address) {
        (IpAddr::V4(a), IpAddr::V4(b)) => {
            let bits = bits.unwrap_or(32); if bits > 32 { return None; }
            let mask = if bits == 0 { 0 } else { u32::MAX << (32 - bits) };
            Some(u32::from(a) & mask == u32::from(b) & mask)
        }
        (IpAddr::V6(a), IpAddr::V6(b)) => {
            let bits = bits.unwrap_or(128); if bits > 128 { return None; }
            let mask = if bits == 0 { 0 } else { u128::MAX << (128 - bits) };
            Some(u128::from(a) & mask == u128::from(b) & mask)
        }
        _ => Some(false),
    }
}

fn geo_match(value: &str, target: &str, is_ip: bool, cache: &mut HashMap<String, Option<Vec<String>>>) -> Option<bool> {
    let (file, category) = if let Some(ext) = value.strip_prefix("ext:") { ext.split_once(':')? }
        else { (if is_ip { "geoip.dat" } else { "geosite.dat" }, value.split_once(':')?.1) };
    if category.contains('@') { return None; }
    let inverted = category.starts_with('!');
    let category = category.trim_start_matches('!');
    let key = format!("{file}:{is_ip}:{target}");
    let categories = cache.entry(key).or_insert_with(|| crate::geo::matching_categories(file, target, is_ip).ok());
    categories.as_ref().map(|items| items.iter().any(|item| item.eq_ignore_ascii_case(category)) != inverted)
}

fn any_match(values: &[Value], mut matches: impl FnMut(&str) -> Option<bool>) -> Option<bool> {
    let mut unknown = false;
    for value in values { match value.as_str().and_then(&mut matches) { Some(true) => return Some(true), None => unknown = true, _ => {} } }
    if unknown { None } else { Some(false) }
}

fn prediction(config: &Value, device: Ipv4Addr, host: &str, ip: IpAddr, port: u16, protocol: &str, cache: &mut HashMap<String, Option<Vec<String>>>) -> Value {
    for rule in config.pointer("/routing/rules").and_then(Value::as_array).into_iter().flatten() {
        let mut unknown = false;
        if let Some(values) = rule["sourceIP"].as_array() {
            if any_match(values, |value| in_cidr(value, device.into())) != Some(true) { continue; }
        }
        if let Some(network) = rule["network"].as_str() { if !network.split(',').any(|s| s.trim() == protocol) { continue; } }
        if let Some(values) = rule["inboundTag"].as_array() {
            let ingress = if protocol == "tcp" { "redirect" } else { "tproxy" };
            if !values.iter().any(|value| value == ingress) { continue; }
        }
        if let Some(ports) = rule["port"].as_str() {
            if !ports.split(',').any(|part| { let range: Vec<_> = part.trim().split('-').collect(); let first = range[0].parse::<u16>().ok(); let last = range.last().and_then(|v| v.parse::<u16>().ok()); first.zip(last).is_some_and(|(a,b)| a <= port && port <= b) }) { continue; }
        }
        if let Some(values) = rule["domain"].as_array() {
            let matched = any_match(values, |value| {
                if value.starts_with("geosite:") || value.starts_with("ext:") { return geo_match(value, host, false, cache); }
                if let Some(domain) = value.strip_prefix("domain:") { return Some(host == domain || host.ends_with(&format!(".{domain}"))); }
                if let Some(domain) = value.strip_prefix("full:") { return Some(host == domain); }
                if let Some(pattern) = value.strip_prefix("regexp:") { return regex_lite::Regex::new(pattern).ok().map(|r| r.is_match(host)); }
                Some(host.contains(value))
            });
            if matched == Some(false) { continue; } unknown |= matched.is_none();
        }
        if let Some(values) = rule["ip"].as_array() {
            let matched = any_match(values, |value| if value.starts_with("geoip:") || value.starts_with("ext:") { geo_match(value, &ip.to_string(), true, cache) } else { in_cidr(value, ip) });
            if matched == Some(false) { continue; } unknown |= matched.is_none();
        }
        if rule.as_object().is_some_and(|object| object.keys().any(|key| !["type","ruleTag","sourceIP","network","inboundTag","port","domain","ip","outboundTag","balancerTag","xkeenRouteGroup"].contains(&key.as_str()))) { unknown = true; }
        return json!({"ip": ip, "protocol": protocol, "rule": rule["ruleTag"].as_str().unwrap_or("Служебное правило"), "outbound": rule["outboundTag"], "balancer": rule["balancerTag"], "uncertain": unknown});
    }
    json!({"ip": ip, "protocol": protocol, "rule": "Нет совпадения", "outbound": config.pointer("/outbounds/0/tag"), "uncertain": true})
}

pub async fn inspect(Query(request): Query<Request>) -> Json<Value> {
    if request.resource.is_empty() || request.resource.len() > 512 { return Json(json!({"success": false, "error": "Укажите домен, IP или URL"})); }
    let raw = request.resource.trim();
    let parsed = reqwest::Url::parse(&if raw.contains("://") { raw.to_owned() } else { format!("https://{raw}") });
    let Ok(url) = parsed else { return Json(json!({"success": false, "error": "Некорректный ресурс"})); };
    if !matches!(url.scheme(), "http" | "https") || !url.username().is_empty() || url.password().is_some() {
        return Json(json!({"success": false, "error": "Укажите HTTP/HTTPS URL без логина и пароля либо домен/IP"}));
    }
    let Some(host) = url.host_str().map(|s| s.trim_matches(['[', ']']).to_ascii_lowercase()) else { return Json(json!({"success": false, "error": "Не найден адрес ресурса"})); };
    let port = url.port_or_known_default().unwrap_or(443);
    let (ips, dns_error): (Vec<IpAddr>, Option<String>) = if let Ok(ip) = host.parse() { (vec![ip], None) }
    else {
        match tokio::time::timeout(Duration::from_secs(4), tokio::net::lookup_host((host.as_str(), port))).await {
            Ok(Ok(found)) => { let mut ips = Vec::new(); for addr in found { if !ips.contains(&addr.ip()) { ips.push(addr.ip()); } } ips.truncate(16); (ips, None) }
            Ok(Err(error)) => (Vec::new(), Some(error.to_string())),
            Err(_) => (Vec::new(), Some("DNS роутера не ответил за 4 секунды".into())),
        }
    };
    let host_copy = host.clone(); let ips_copy = ips.clone();
    let work = tokio::task::spawn_blocking(move || {
        let config: Value = std::fs::read_to_string("/opt/etc/xray/configs/00_config.json").ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or(Value::Null);
        let mut cache = HashMap::new();
        let mut predictions = Vec::new();
        for ip in ips_copy.iter().take(4) { for protocol in ["tcp", "udp"] { predictions.push(prediction(&config, request.device, &host_copy, *ip, port, protocol, &mut cache)); } }
        let marker = format!("from {}:", request.device);
        let mut observations = Vec::new();
        for line in tail(&access_log_path()).lines().rev() {
            if !line.contains(&marker) { continue; }
            let Some((_, rest)) = line.split_once(" accepted ") else { continue; };
            let Some((destination, route)) = rest.split_once(" [") else { continue; };
            let Some((protocol, address)) = destination.split_once(':') else { continue; };
            let Some((target, destination_port)) = address.rsplit_once(':') else { continue; };
            let target = target.trim_matches(['[', ']']);
            let by_domain = target.eq_ignore_ascii_case(&host_copy);
            let by_ip = target.parse::<IpAddr>().ok().is_some_and(|ip| ips_copy.contains(&ip));
            if !by_domain && !by_ip { continue; }
            if destination_port.parse::<u16>().ok() != Some(port) { continue; }
            let Some((inbound, outbound)) = route.trim_end_matches(']').split_once(" -> ") else { continue; };
            observations.push(json!({"timestamp": line.split(" from ").next(), "protocol": protocol, "destination": address, "inbound": inbound, "outbound": outbound, "matchedBy": if by_domain { "domain" } else { "ip" }}));
            if observations.len() >= 100 { break; }
        }
        let errors: Vec<_> = tail(&error_log_path()).lines().rev().filter(|line| line.contains(&request.device.to_string()) || line.contains(&host_copy) || ips_copy.iter().any(|ip| line.contains(&ip.to_string()))).take(20).map(str::to_owned).collect();
        json!({"predictions": predictions, "observations": observations, "errors": errors, "coreRunning": !crate::controller::get_pid("xray").is_empty()})
    }).await;
    match work {
        Ok(mut data) => { data["success"] = json!(true); data["device"] = json!(request.device); data["host"] = json!(host); data["port"] = json!(port); data["dnsAddresses"] = json!(ips); data["dnsError"] = json!(dns_error); data["checkedAt"] = json!(chrono::Utc::now().to_rfc3339()); Json(data) }
        Err(error) => Json(json!({"success": false, "error": error.to_string()})),
    }
}
