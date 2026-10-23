use super::*;

pub const UPSTREAM_COMMIT: &str = "a1adf7b868e65c8a77aab608c8bbd9ec8b30a256";
pub const TARGET: usize = 5;
pub const USER_STRATEGY: &str = include_str!("../../router/nfqws2-user-alt12.args");

pub async fn install_assets() -> Result<(), String> {
    let assets: &[(&str, &[u8])] = &[
        ("blockcheck2/blockcheck2.upstream.sh", include_bytes!("../../router/blockcheck2/blockcheck2.upstream.sh")),
        ("blockcheck2/enumerate.sh", include_bytes!("../../router/blockcheck2/enumerate.sh")),
        ("blockcheck2/LICENSE.txt", include_bytes!("../../router/blockcheck2/LICENSE.txt")),
        ("blockcheck2/standard/10-http-basic.sh", include_bytes!("../../router/blockcheck2/standard/10-http-basic.sh")),
        ("blockcheck2/standard/15-misc.sh", include_bytes!("../../router/blockcheck2/standard/15-misc.sh")),
        ("blockcheck2/standard/17-oob.sh", include_bytes!("../../router/blockcheck2/standard/17-oob.sh")),
        ("blockcheck2/standard/20-multi.sh", include_bytes!("../../router/blockcheck2/standard/20-multi.sh")),
        ("blockcheck2/standard/23-seqovl.sh", include_bytes!("../../router/blockcheck2/standard/23-seqovl.sh")),
        ("blockcheck2/standard/24-syndata.sh", include_bytes!("../../router/blockcheck2/standard/24-syndata.sh")),
        ("blockcheck2/standard/25-fake.sh", include_bytes!("../../router/blockcheck2/standard/25-fake.sh")),
        ("blockcheck2/standard/30-faked.sh", include_bytes!("../../router/blockcheck2/standard/30-faked.sh")),
        ("blockcheck2/standard/35-hostfake.sh", include_bytes!("../../router/blockcheck2/standard/35-hostfake.sh")),
        ("blockcheck2/standard/50-fake-multi.sh", include_bytes!("../../router/blockcheck2/standard/50-fake-multi.sh")),
        ("blockcheck2/standard/55-fake-faked.sh", include_bytes!("../../router/blockcheck2/standard/55-fake-faked.sh")),
        ("blockcheck2/standard/60-fake-hostfake.sh", include_bytes!("../../router/blockcheck2/standard/60-fake-hostfake.sh")),
        ("blockcheck2/standard/90-quic.sh", include_bytes!("../../router/blockcheck2/standard/90-quic.sh")),
        ("blockcheck2/standard/def.inc", include_bytes!("../../router/blockcheck2/standard/def.inc")),
        ("blockcheck2/UPSTREAM.md", include_bytes!("../../router/blockcheck2/UPSTREAM.md")),
        ("nfqws2/blobs/fs_quic_google.bin", include_bytes!("../../router/nfqws2-blobs/fs_quic_google.bin")),
        ("nfqws2/blobs/fs_tls_max.bin", include_bytes!("../../router/nfqws2-blobs/fs_tls_max.bin")),
        ("nfqws2/blobs/SOURCES.json", include_bytes!("../../router/nfqws2-blobs/SOURCES.json")),
    ];
    for (name, bytes) in assets {
        let path = format!("{ROOT}/{name}");
        let parent = Path::new(&path).parent().ok_or("Нет каталога ресурсов")?;
        tokio::fs::create_dir_all(parent).await.map_err(|e| e.to_string())?;
        tokio::fs::set_permissions(parent, std::fs::Permissions::from_mode(0o755)).await.map_err(|e| e.to_string())?;
        if tokio::fs::read(&path).await.ok().as_deref() == Some(*bytes) { continue; }
        let next = format!("{path}.new");
        tokio::fs::write(&next, bytes).await.map_err(|e| e.to_string())?;
        tokio::fs::set_permissions(&next, std::fs::Permissions::from_mode(0o644)).await.map_err(|e| e.to_string())?;
        tokio::fs::rename(next, path).await.map_err(|e| e.to_string())?;
    }
    Ok(())
}

pub async fn wan_evidence() -> Result<Value, String> {
    let output = tokio::time::timeout(Duration::from_secs(4), Command::new("ip").args(["-4", "route", "get", "1.1.1.1", "mark", "833"]).kill_on_drop(true).output()).await
        .map_err(|_| "Не удалось проверить маршрут диагностических соединений")?.map_err(|e| e.to_string())?;
    let route = String::from_utf8_lossy(&output.stdout);
    let words: Vec<_> = route.split_whitespace().collect();
    let wan = words.windows(2).find(|pair| pair[0] == "dev").map(|pair| pair[1]).ok_or("Нет WAN-маршрута для диагностической метки")?;
    let defaults = Command::new("ip").args(["-4", "route", "show", "default"]).output().await.map_err(|e| e.to_string())?;
    let default = String::from_utf8_lossy(&defaults.stdout);
    if !output.status.success() || !default.split_whitespace().collect::<Vec<_>>().windows(2).any(|pair| pair[0] == "dev" && pair[1] == wan)
        || wan.starts_with("tun") || wan.starts_with("csqtt") || wan.starts_with("wg") {
        return Err("Диагностическая метка не выходит через прямой WAN. Подбор не запущен".into());
    }
    Ok(json!({"interface": wan, "mark": 833, "queue": 331, "socketsBoundToWan": true}))
}

const CONNECT_SITES: [&str; 3] = ["https://www.youtube.com/generate_204", "https://discord.com/", "https://www.instagram.com/"];

async fn connect_probe(wan: &str, url: &str, seconds: u64) -> Result<Value, String> {
    let output = tokio::time::timeout(Duration::from_secs(seconds + 2), Command::new(PROBE)
        .args(["-protocol", "connect", "-interface", wan, "-mark", "833", "-timeout", &seconds.to_string(), "-url", url])
        .kill_on_drop(true).output()).await.map_err(|_| "Истёк срок TCP-предпроверки")?.map_err(|error| error.to_string())?;
    let row: Value = serde_json::from_slice(&output.stdout).map_err(|_| "Утилита не вернула TCP-предпроверку")?;
    if !output.status.success() || row["protocol"] != "connect" || row["url"] != url || row["interface"] != wan || row["ok"].as_bool().is_none() {
        return Err("Утилита вернула некорректную TCP-предпроверку".into());
    }
    Ok(row)
}

pub async fn tcp_reachability(wan: &str) -> Result<Value, String> {
    let mut tasks = tokio::task::JoinSet::new();
    for (index, url) in CONNECT_SITES.into_iter().enumerate() {
        let wan = wan.to_string();
        tasks.spawn(async move {
            let mut row = connect_probe(&wan, url, 4).await?;
            let mut attempts = 1;
            if row["ok"] != true { row = connect_probe(&wan, url, 6).await?; attempts = 2; }
            row["attempts"] = json!(attempts);
            Ok::<_, String>((index, row))
        });
    }
    let mut rows = Vec::new();
    while let Some(result) = tasks.join_next().await { rows.push(result.map_err(|error| error.to_string())??); }
    rows.sort_by_key(|(index, _)| *index);
    let results: Vec<Value> = rows.into_iter().map(|(_, row)| row).collect();
    let ok = results.iter().all(|row| row["ok"] == true);
    Ok(json!({"ok": ok, "checkedAt": chrono::Utc::now().to_rfc3339(), "results": results, "interface": wan, "mark": 833, "tlsSent": false}))
}

pub fn connectivity_failure(report: &Value) -> Option<String> {
    if report["ok"] == true { return None; }
    let failed: Vec<String> = report["results"].as_array().into_iter().flatten().filter(|row| row["ok"] != true).map(|row| {
        let url = row["url"].as_str().unwrap_or_default();
        let site = if url.contains("youtube") { "YouTube" } else if url.contains("discord") { "Discord" } else { "Instagram" };
        let stage = if row["errorStage"] == "dns" { "DNS" } else { "TCP/443" };
        format!("{site}: {stage}{}", row["remoteIp"].as_str().filter(|ip| !ip.is_empty()).map(|ip| format!(" ({ip})")).unwrap_or_default())
    }).collect();
    Some(format!("Нет соединения до TLS после повторной проверки: {}. Перебор не начат. Проверьте доступность IP и прямой WAN; смена TLS-стратегии не исправляет отсутствие TCP-соединения. Действующая стратегия сохранена", failed.join(", ")))
}

pub struct Templates { pub tcp: Vec<(String, String)>, pub quic: Vec<String>, pub skipped: usize }

fn template_class(args: &str) -> &'static str {
    if args.contains("tcp_md5") { "md5" }
    else if args.contains("badsum") { "checksum" }
    else if args.contains("tcp_seq=") { "sequence" }
    else if args.contains("tcp_ack=") { "ack" }
    else if args.contains("tcp_ts=") { "timestamp" }
    else if args.contains("ip_ttl=") { "ttl" }
    else { "plain" }
}

// Breadth-first sampling spans the full upstream enumeration instead of taking
// its prefix (which is dominated by near-identical low-TTL variants).
fn spread<T: Clone>(items: &[T]) -> Vec<T> {
    let mut result = Vec::with_capacity(items.len());
    if items.is_empty() { return result; }
    result.push(items[0].clone());
    let mut ranges = std::collections::VecDeque::from([(1, items.len())]);
    while let Some((start, end)) = ranges.pop_front() {
        if start >= end { continue; }
        let middle = start + (end - start) / 2;
        result.push(items[middle].clone());
        ranges.push_back((start, middle)); ranges.push_back((middle + 1, end));
    }
    result
}

pub async fn templates() -> Result<Templates, String> {
    install_assets().await?;
    let output = tokio::time::timeout(Duration::from_secs(15), Command::new("/bin/sh").arg(format!("{ROOT}/blockcheck2/enumerate.sh"))
        .env_clear().env("PATH", "/opt/sbin:/opt/bin:/usr/sbin:/usr/bin:/sbin:/bin").kill_on_drop(true).output()).await
        .map_err(|_| "Генератор шаблонов blockcheck2 не завершился")?.map_err(|e| e.to_string())?;
    if !output.status.success() || output.stdout.len() > 8 * 1024 * 1024 { return Err("Не удалось получить шаблоны blockcheck2".into()); }
    parse_templates(&output.stdout)
}

fn parse_templates(output: &[u8]) -> Result<Templates, String> {
    let mut groups: std::collections::BTreeMap<String, Vec<(String, String)>> = std::collections::BTreeMap::new();
    let mut quic = vec![catalog::extract(USER_STRATEGY, "quic")?];
    let mut seen = std::collections::HashSet::new();
    let mut skipped = 0;
    for record in output.split(|byte| *byte == 30).skip(1) {
        let Ok(text) = std::str::from_utf8(record) else { skipped += 1; continue; };
        let Some((label, body)) = text.split_once('\n') else { continue; };
        let body = body.split(char::from(31)).next().unwrap_or_default();
        if body.contains("--lua-init=") || body.contains("autottl") || body.contains("luaexec:") { skipped += 1; continue; }
        let body = body.replace("fake_default_tls", "tls_clienthello").replace("fake_default_quic", "quic_initial");
        let transport = if label.starts_with("90-quic/") { "quic" } else { "tcp" };
        let args = format!("--filter-{}=443\n{}\n", if transport == "tcp" { "tcp" } else { "udp" }, body.trim());
        let full = if transport == "tcp" { args.clone() } else { preset_args(0, "tcp", 0) + "--new\n" + &args };
        if candidate(&SettingsRequest { source: "custom".into(), custom_args: full, allow_tcp_only: false }).is_err() { skipped += 1; continue; }
        if !seen.insert(strategy_key("blockcheck2", transport, &args)) { continue; }
        if transport == "quic" { quic.push(args); }
        else {
            let family = label.split('/').next().unwrap_or(label);
            groups.entry(format!("{family}/{}", template_class(&args))).or_default().push((format!("Blockcheck2 · {label}"), args));
        }
    }
    let groups: Vec<_> = groups.values().map(|group| spread(group)).collect();
    // Balance both strategy families and fooling methods before limiting network attempts.
    let mut tcp = Vec::new();
    let mut index = 0;
    loop {
        let before = tcp.len();
        for group in &groups { if let Some(entry) = group.get(index) { tcp.push(entry.clone()); } }
        if tcp.len() == before || tcp.len() >= 180 { break; }
        index += 1;
    }
    tcp.truncate(180); quic.truncate(12);
    if tcp.is_empty() { return Err("Шаблоны blockcheck2 не совместимы с установленным nfqws2".into()); }
    Ok(Templates { tcp, quic, skipped })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn spread_keeps_all_values_and_reaches_beyond_the_prefix() {
        let values: Vec<_> = (0..200).collect();
        let sampled = spread(&values);
        assert_eq!(sampled.len(), values.len());
        assert!(sampled[..8].iter().any(|value| *value >= 150));
        let mut sorted = sampled; sorted.sort(); assert_eq!(sorted, values);
        assert!(spread::<usize>(&[]).is_empty());
    }
    #[test]
    fn separate_fooling_from_ttl_variants() {
        assert_eq!(template_class("--lua-desync=fake:ip_ttl=2"), "ttl");
        assert_eq!(template_class("--lua-desync=fake:tcp_ts=-600000"), "timestamp");
        assert_eq!(template_class("--lua-desync=fake:tcp_md5"), "md5");
    }
    #[test]
    fn sample_real_upstream_templates() {
        let Some(path) = std::env::var_os("NFQWS_AUDIT_ENUMERATION") else { return; };
        let templates = parse_templates(&std::fs::read(path).unwrap()).unwrap();
        assert_eq!(templates.tcp.len(), 180);
        for class in ["md5", "checksum", "sequence", "ack", "timestamp", "ttl", "plain"] {
            assert!(templates.tcp.iter().any(|(_, args)| template_class(args) == class), "Missing {class}");
        }
        if let Some(path) = std::env::var_os("NFQWS_AUDIT_EXPORT") {
            std::fs::write(path, serde_json::to_vec(&templates.tcp).unwrap()).unwrap();
        }
    }
    #[test]
    fn unreachable_tcp_is_not_a_failed_tls_strategy() {
        let report = json!({"ok": false, "tlsSent": false, "results": [
            {"url": CONNECT_SITES[0], "ok": true},
            {"url": CONNECT_SITES[1], "ok": true},
            {"url": CONNECT_SITES[2], "ok": false, "errorStage": "tcp-connect", "remoteIp": "192.0.2.1", "attempts": 2}
        ]});
        let failure = connectivity_failure(&report).unwrap();
        assert!(failure.contains("Instagram: TCP/443 (192.0.2.1)"));
        assert!(failure.contains("Перебор не начат"));
        assert!(connectivity_failure(&json!({"ok": true})).is_none());
    }
}
