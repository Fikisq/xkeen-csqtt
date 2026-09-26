use axum::{extract::State, Json};
use crate::types::AppState;
use serde::Deserialize;
use serde_json::{json, Value};
use std::{collections::{BTreeMap, BTreeSet}, net::Ipv4Addr, path::Path, process::Stdio};
use tokio::{fs, process::Command};

const BYPASS_FILE: &str = "/opt/etc/xkeen/client_bypass_macs.lst";
const MIHOMO_BYPASS_FILE: &str = "/opt/etc/xkeen/client_bypass_mihomo_macs.lst";
const COMMENT: &str = "xkeen_ui_bypass";
const GLOBAL_COMMENT: &str = "xkeen_ui_global_direct";
const GLOBAL_XRAY_FILE: &str = "/opt/etc/xkeen/global_direct_xray.flag";
const GLOBAL_MIHOMO_FILE: &str = "/opt/etc/xkeen/global_direct_mihomo.flag";
const CAPTURE_FILE: &str = "/opt/etc/xkeen/device_capture_xray.lst";
const CAPTURE_SET: &str = "xkeen_ui_device_capture";

async fn sync_capture(content: &str) -> Result<(), String> {
    let temporary = format!("{CAPTURE_SET}_tmp");
    for args in [vec!["create", CAPTURE_SET, "hash:ip", "-exist"], vec!["create", temporary.as_str(), "hash:ip", "-exist"], vec!["flush", temporary.as_str()]] {
        if !Command::new("/opt/sbin/ipset").args(args).output().await.map_err(|e| e.to_string())?.status.success() { return Err("Не удалось подготовить исключения устройств".into()) }
    }
    for ip in content.lines().filter(|line| !line.is_empty()) {
        ip.parse::<Ipv4Addr>().map_err(|_| "Некорректный IP исключения")?;
        if !Command::new("/opt/sbin/ipset").args(["add", &temporary, ip, "-exist"]).output().await.map_err(|e| e.to_string())?.status.success() { return Err("Не удалось добавить исключение устройства".into()) }
    }
    if !Command::new("/opt/sbin/ipset").args(["swap", &temporary, CAPTURE_SET]).output().await.map_err(|e| e.to_string())?.status.success() { return Err("Не удалось применить исключения устройств".into()) }
    let _ = Command::new("/opt/sbin/ipset").args(["destroy", &temporary]).output().await;
    fs::write(CAPTURE_FILE, content).await.map_err(|e| e.to_string())
}

fn global_direct(config: &Value) -> bool {
    config.pointer("/routing/rules").and_then(Value::as_array)
        .is_some_and(|rules| rules.iter().any(|rule| rule.get("ruleTag").and_then(Value::as_str) == Some("VPN")
            && rule.get("outboundTag").and_then(Value::as_str) == Some("direct")))
}

async fn sync_global_firewall(core: &str, enabled: bool) -> Result<(), String> {
    let mut ipv4_chains = 0;
    for (binary, table) in [("/opt/sbin/iptables", "nat"), ("/opt/sbin/iptables", "mangle"),
        ("/opt/sbin/ip6tables", "nat"), ("/opt/sbin/ip6tables", "mangle")] {
        let chain = Command::new(binary).args(["-t", table, "-S", "xkeen"])
            .stdout(Stdio::null()).stderr(Stdio::null()).status().await;
        if !chain.is_ok_and(|status| status.success()) { continue }
        if binary == "/opt/sbin/iptables" { ipv4_chains += 1; }
        // Remove both legacy and device-aware global bypasses.
        let scoped = ["-m", "set", "!", "--match-set", CAPTURE_SET, "src"];
        if binary == "/opt/sbin/iptables" {
            loop {
                let removed = Command::new(binary).args(["-t", table, "-D", "xkeen"]).args(scoped).args(["-m", "comment", "--comment", GLOBAL_COMMENT, "-j", "RETURN"]).output().await.map_err(|e| e.to_string())?;
                if !removed.status.success() { break }
            }
        }
        loop {
            let check = Command::new(binary).args(["-t", table, "-C", "xkeen", "-m", "comment", "--comment", GLOBAL_COMMENT, "-j", "RETURN"])
                .stdout(Stdio::null()).stderr(Stdio::null()).status().await.map_err(|e| e.to_string())?;
            if !check.success() { break }
            let removed = Command::new(binary).args(["-t", table, "-D", "xkeen", "-m", "comment", "--comment", GLOBAL_COMMENT, "-j", "RETURN"])
                .stdout(Stdio::null()).stderr(Stdio::piped()).output().await.map_err(|e| e.to_string())?;
            if !removed.status.success() { return Err(format!("Не удалось удалить правило {binary}/{table}")) }
        }
        if enabled {
            let mut command = Command::new(binary);
            command.args(["-t", table, "-I", "xkeen", "1"]);
            if core == "xray" && binary == "/opt/sbin/iptables" { command.args(scoped); }
            let added = command.args(["-m", "comment", "--comment", GLOBAL_COMMENT, "-j", "RETURN"])
                .stdout(Stdio::null()).stderr(Stdio::piped()).output().await.map_err(|e| e.to_string())?;
            if !added.status.success() { return Err(format!("Не удалось включить полный обход {binary}/{table}: {}", String::from_utf8_lossy(&added.stderr))) }
        }
    }
    if ipv4_chains != 2 { return Err("Не найдены цепочки перехвата IPv4 nat/mangle".into()) }
    Ok(())
}

async fn set_global_direct(core: &str, enabled: bool) -> Result<bool, String> {
    let init = fs::read_to_string("/opt/etc/init.d/S05xkeen").await.map_err(|e| e.to_string())?;
    if !init.contains("global_direct_${name_client}.flag") {
        return Err("Скрипт XKeen не поддерживает постоянный полный обход; настройка не применена".into())
    }
    let file = if core == "xray" { GLOBAL_XRAY_FILE } else { GLOBAL_MIHOMO_FILE };
    let previous = Path::new(file).exists();
    if let Err(error) = sync_global_firewall(core, enabled).await {
        _ = sync_global_firewall(core, previous).await;
        return Err(error)
    }
    let saved = if enabled { fs::write(file, b"1\n").await } else if previous { fs::remove_file(file).await } else { Ok(()) };
    if let Err(error) = saved {
        _ = sync_global_firewall(core, previous).await;
        return Err(format!("Не удалось сохранить режим «Без VPN»: {error}"))
    }
    Ok(previous)
}

#[derive(Deserialize)]
pub struct GlobalDirectRequest { enabled: bool }

pub async fn mihomo_global_direct(State(state): State<AppState>, Json(request): Json<GlobalDirectRequest>) -> Json<Value> {
    if state.core.read().unwrap().name != "mihomo" {
        return Json(json!({"success": false, "error": "Активное ядро — не Mihomo"}))
    }
    match set_global_direct("mihomo", request.enabled).await {
        Ok(_) => Json(json!({"success": true, "enabled": request.enabled})),
        Err(error) => Json(json!({"success": false, "error": error})),
    }
}

#[derive(Deserialize)]
pub struct MihomoDevicesRequest { ips: Vec<Ipv4Addr> }

pub async fn mihomo_devices(State(state): State<AppState>, Json(request): Json<MihomoDevicesRequest>) -> Json<Value> {
    if state.core.read().unwrap().name != "mihomo" {
        return Json(json!({"success": false, "error": "Активное ядро — не Mihomo"}))
    }
    if request.ips.len() > 64 { return Json(json!({"success": false, "error": "Слишком много устройств"})) }
    let init = match fs::read_to_string("/opt/etc/init.d/S05xkeen").await {
        Ok(value) => value,
        Err(error) => return Json(json!({"success": false, "error": error.to_string()})),
    };
    if !init.contains("client_bypass_mihomo_macs.lst") {
        return Json(json!({"success": false, "error": "Скрипт XKeen не поддерживает обход Mihomo для устройств"}))
    }
    let previous = fs::read_to_string(MIHOMO_BYPASS_FILE).await.unwrap_or_default();
    let old = read_macs(&previous);
    let saved = read_ip_macs(&previous);
    let mut entries = BTreeMap::new();
    for ip in request.ips {
        let mac = match resolve_mac(ip).await.or_else(|error| saved.get(&ip).cloned().ok_or(error)) {
            Ok(mac) => mac,
            Err(error) => return Json(json!({"success": false, "error": error})),
        };
        entries.insert(ip, mac);
    }
    let new = entries.values().cloned().collect();
    if let Err(error) = sync_firewall(&old, &new).await {
        _ = sync_firewall(&new, &old).await;
        return Json(json!({"success": false, "error": error}))
    }
    let content = format_bypass(&entries);
    if let Err(error) = fs::write(MIHOMO_BYPASS_FILE, content).await {
        _ = sync_firewall(&new, &old).await;
        return Json(json!({"success": false, "error": error.to_string()}))
    }
    Json(json!({"success": true}))
}

pub async fn sync_xray_routing(State(state): State<AppState>) -> Json<Value> {
    if state.core.read().unwrap().name != "xray" {
        return Json(json!({"success": false, "error": "Активное ядро — не Xray"}))
    }
    let content = match fs::read_to_string("/opt/etc/xray/configs/00_config.json").await {
        Ok(content) => content,
        Err(error) => return Json(json!({"success": false, "error": error.to_string()})),
    };
    let config: Value = match serde_json::from_str(&content) {
        Ok(config) => config,
        Err(error) => return Json(json!({"success": false, "error": error.to_string()})),
    };
    match apply_for_config(&config).await {
        Ok(_) => Json(json!({"success": true})),
        Err(error) => Json(json!({"success": false, "error": error})),
    }
}

fn direct_device_ips(config: &Value) -> Result<BTreeSet<Ipv4Addr>, String> {
    let mut ips = BTreeSet::new();
    let rules = config.pointer("/routing/rules").and_then(Value::as_array)
        .ok_or("В JSON нет правил маршрутизации")?;
    for rule in rules {
        let Some(tag) = rule.get("ruleTag").and_then(Value::as_str) else { continue };
        let Some(ip) = tag.trim_end_matches("|selector").strip_prefix("device:").and_then(|tag| tag.strip_suffix(":VPN")) else { continue };
        if rule.get("outboundTag").and_then(Value::as_str) != Some("direct") { continue }
        let parsed = ip.parse::<Ipv4Addr>().map_err(|_| format!("Некорректный IP устройства: {ip}"))?;
        ips.insert(parsed);
    }
    Ok(ips)
}

fn read_macs(content: &str) -> BTreeSet<String> {
    content.lines().filter_map(|line| {
        let mac = line.split('#').next()?.trim().to_ascii_lowercase();
        let valid = mac.split(':').count() == 6 && mac.split(':').all(|part| part.len() == 2 && part.bytes().all(|c| c.is_ascii_hexdigit()));
        valid.then_some(mac)
    }).collect()
}

fn read_ip_macs(content: &str) -> BTreeMap<Ipv4Addr, String> {
    content.lines().filter_map(|line| {
        let (mac, ip) = line.split_once('#')?;
        let parsed = ip.trim().parse::<Ipv4Addr>().ok()?;
        let mac = read_macs(mac).into_iter().next()?;
        Some((parsed, mac))
    }).collect()
}

fn format_bypass(entries: &BTreeMap<Ipv4Addr, String>) -> String {
    if entries.is_empty() { return "# No devices currently bypass XKeen interception.\n".into() }
    entries.iter().map(|(ip, mac)| format!("{mac} # {ip}\n")).collect()
}

async fn resolve_mac(ip: Ipv4Addr) -> Result<String, String> {
    let arp = fs::read_to_string("/proc/net/arp").await.map_err(|e| e.to_string())?;
    for line in arp.lines().skip(1) {
        let columns: Vec<_> = line.split_whitespace().collect();
        if columns.len() >= 6 && columns[0] == ip.to_string() && columns[2] == "0x2" {
            if let Some(mac) = read_macs(columns[3]).into_iter().next() { return Ok(mac) }
        }
    }
    Err(format!("Устройство {ip} не найдено в сети. Подключите его к роутеру и повторите выбор «Без VPN»"))
}

async fn iptables(binary: &str, table: &str, operation: &str, mac: &str, comment: &str) -> Result<bool, String> {
    let result = Command::new(binary).args([
        "-t", table, operation, "xkeen", "-m", "mac", "--mac-source", mac,
        "-m", "comment", "--comment", comment, "-j", "RETURN",
    ]).stdout(Stdio::null()).stderr(Stdio::piped()).output().await
        .map_err(|e| format!("Не удалось вызвать {binary}: {e}"))?;
    Ok(result.status.success())
}

async fn sync_firewall(old: &BTreeSet<String>, new: &BTreeSet<String>) -> Result<(), String> {
    if old == new { return Ok(()) }
    let mut ipv4_chains = 0;
    for (binary, table) in [("/opt/sbin/iptables", "nat"), ("/opt/sbin/iptables", "mangle"),
        ("/opt/sbin/ip6tables", "nat"), ("/opt/sbin/ip6tables", "mangle")] {
        let chain = Command::new(binary).args(["-t", table, "-S", "xkeen"])
            .stdout(Stdio::null()).stderr(Stdio::null()).status().await;
        if !chain.is_ok_and(|status| status.success()) { continue }
        if binary == "/opt/sbin/iptables" { ipv4_chains += 1; }
        for mac in old.difference(new) {
            for comment in [COMMENT, "xkeen_rule"] {
                while iptables(binary, table, "-C", mac, comment).await? {
                    if !iptables(binary, table, "-D", mac, comment).await? {
                        return Err(format!("Не удалось удалить старое исключение {mac} из {binary}/{table}"));
                    }
                }
            }
        }
        for mac in new.difference(old) {
            let result = Command::new(binary).args(["-t", table, "-I", "xkeen", "1", "-m", "mac", "--mac-source", mac,
                "-m", "comment", "--comment", COMMENT, "-j", "RETURN"])
                .stdout(Stdio::null()).stderr(Stdio::piped()).output().await
                .map_err(|e| format!("Не удалось вызвать {binary}: {e}"))?;
            if !result.status.success() {
                return Err(format!("Не удалось включить «Без VPN» в {binary}/{table}: {}", String::from_utf8_lossy(&result.stderr)));
            }
        }
    }
    if ipv4_chains != 2 {
        return Err("Правила перехвата Xray не найдены в IPv4 nat/mangle; режим «Без VPN» не применён".into());
    }
    Ok(())
}

pub struct PreviousBypass { macs: BTreeSet<String>, content: String, global: bool, capture: String }

pub async fn apply_for_config(config: &Value) -> Result<PreviousBypass, String> {
    if !Path::new(BYPASS_FILE).exists() {
        return Err("На роутере не установлен обработчик режима «Без VPN»".into());
    }
    let init = fs::read_to_string("/opt/etc/init.d/S05xkeen").await.map_err(|e| e.to_string())?;
    if !init.contains("file_client_bypass_macs") || !init.contains("--mac-source") {
        return Err("XKeen обновил скрипт перехвата и удалил поддержку полного «Без VPN». Обновите интеграцию перед изменением маршрута".into());
    }
    let previous = fs::read_to_string(BYPASS_FILE).await.map_err(|e| e.to_string())?;
    let old = read_macs(&previous);
    let saved = read_ip_macs(&previous);
    let mut entries = BTreeMap::new();
    for ip in direct_device_ips(config)? {
        entries.insert(ip, resolve_mac(ip).await.or_else(|error| saved.get(&ip).cloned().ok_or(error))?);
    }
    let new: BTreeSet<String> = entries.values().cloned().collect();
    if let Err(error) = sync_firewall(&old, &new).await {
        _ = sync_firewall(&new, &old).await;
        return Err(error);
    }
    let content = format_bypass(&entries);
    if let Err(error) = fs::write(BYPASS_FILE, content).await {
        _ = sync_firewall(&new, &old).await;
        return Err(format!("Не удалось сохранить исключения: {error}"));
    }
    let capture = fs::read_to_string(CAPTURE_FILE).await.unwrap_or_default();
    let direct = direct_device_ips(config)?;
    let mut capture_ips = BTreeSet::new();
    for rule in config.pointer("/routing/rules").and_then(Value::as_array).into_iter().flatten() {
        let tag = rule.get("ruleTag").and_then(Value::as_str).unwrap_or("");
        if let Some(ip) = tag.strip_prefix("device:").and_then(|s| s.split(':').next()).and_then(|s| s.parse::<Ipv4Addr>().ok()) {
            if !direct.contains(&ip) && (rule.get("balancerTag").is_some() || rule.get("outboundTag").and_then(Value::as_str).is_some_and(|s| s != "direct")) { capture_ips.insert(ip); }
        }
    }
    let next_capture = capture_ips.iter().map(|ip| format!("{ip}\n")).collect::<String>();
    if let Err(error) = sync_capture(&next_capture).await {
        _ = sync_capture(&capture).await;
        _ = sync_firewall(&new, &old).await;
        _ = fs::write(BYPASS_FILE, &previous).await;
        return Err(error)
    }
    let global = match set_global_direct("xray", global_direct(config)).await {
        Ok(previous) => previous,
        Err(error) => {
            _ = sync_capture(&capture).await;
            _ = sync_firewall(&new, &old).await;
            _ = fs::write(BYPASS_FILE, previous).await;
            return Err(error)
        }
    };
    Ok(PreviousBypass { macs: old, content: previous, global, capture })
}

pub async fn restore(previous: &PreviousBypass) {
    _ = sync_capture(&previous.capture).await;
    let current = fs::read_to_string(BYPASS_FILE).await.unwrap_or_default();
    let now = read_macs(&current);
    _ = sync_firewall(&now, &previous.macs).await;
    _ = fs::write(BYPASS_FILE, &previous.content).await;
    _ = set_global_direct("xray", previous.global).await;
}
