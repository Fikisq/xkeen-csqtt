use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};
use yaml_rust2::{Yaml, YamlEmitter, YamlLoader};

pub const DISABLED: &str = "192.0.2.255";
pub const WHITE_TAG: &str = "custom:Whitelist";
pub fn protected(name: &str) -> bool {
    matches!(
        name.to_ascii_lowercase().as_str(),
        "block" | "blocked" | "reject" | "reject-drop" | "direct-local" | "dns" | "api"
    )
}
fn ru_resource(s: &str) -> bool {
    let s = s.to_ascii_lowercase();
    matches!(
        s.as_str(),
        "geosite:ru"
            | "geosite:category-ru"
            | "geosite:category-ru-all"
            | "geosite:category-bank-ru"
            | "geosite:mts-ru"
            | "geoip:ru"
            | "geoip:by"
            | "geosite:whitelist"
    ) || s.starts_with("ext:roscomvpn-geosite.dat:")
        && matches!(s.rsplit(':').next(), Some("category-ru" | "whitelist"))
        || s == "ext:roscomvpn-geoip.dat:direct"
        || s.starts_with("domain:") && s.ends_with(".ru")
        || s.starts_with("full:") && s.ends_with(".ru")
}
fn local_resource(s: &str) -> bool {
    matches!(
        s,
        "geoip:private"
            | "geosite:private"
            | "127.0.0.0/8"
            | "10.0.0.0/8"
            | "172.16.0.0/12"
            | "192.168.0.0/16"
            | "::1/128"
            | "fc00::/7"
            | "fe80::/10"
    )
}
pub fn xray_plan(content: &str, target: &str, fallback: bool) -> Result<String, String> {
    let mut config: Value = serde_json::from_str(content).map_err(|e| e.to_string())?;
    let nodes = config["outbounds"].as_array().ok_or("Нет подключений Xray")?;
    if !nodes.iter().any(|n| n["tag"] == target) {
        return Err(format!(
            "В Xray нет подключения {target}. Добавьте его в управлении сервисами"
        ));
    }
    let blocked: BTreeSet<String> = nodes
        .iter()
        .filter(|n| n["protocol"] == "blackhole")
        .filter_map(|n| n["tag"].as_str().map(str::to_owned))
        .collect();
    let rules = config["routing"]["rules"].as_array_mut().ok_or("Нет правил Xray")?;
    if rules
        .iter()
        .any(|r| r["ruleTag"] == WHITE_TAG && r["domain"] != json!(["ext:roscomvpn-geosite.dat:whitelist"]))
    {
        return Err("Имя Whitelist уже используется другим правилом".into());
    }
    if !rules.iter().any(|r| r["ruleTag"] == WHITE_TAG) {
        let at = rules
            .iter()
            .position(|r| {
                r["ruleTag"]
                    .as_str()
                    .is_some_and(|s| s.split('|').next() == Some("VPN"))
            })
            .unwrap_or(rules.len());
        rules.insert(at,json!({"type":"field","ruleTag":WHITE_TAG,"domain":["ext:roscomvpn-geosite.dat:whitelist"],"sourceIP":[DISABLED],"network":"tcp,udp","outboundTag":"direct"}));
    }
    {
        for rule in rules.iter_mut() {
            let node = rule["outboundTag"].as_str().unwrap_or("").to_owned();
            if protected(&node) || blocked.contains(&node) {
                continue;
            }
            let resources: Vec<&str> = ["domain", "ip"]
                .iter()
                .flat_map(|key| rule[*key].as_array().into_iter().flatten().filter_map(Value::as_str))
                .collect();
            if !resources.is_empty() && resources.iter().all(|s| local_resource(s)) {
                continue;
            }
            let ru = !resources.is_empty() && resources.iter().all(|s| ru_resource(s));
            if rule["inboundTag"]
                .as_array()
                .is_some_and(|tags| tags.iter().any(|t| t.as_str().is_some_and(|t| t.contains("api"))))
            {
                continue;
            }
            let white = rule["ruleTag"] == WHITE_TAG;
            if !fallback && !ru && !white {
                continue;
            }
            let object = rule.as_object_mut().ok_or("Неверное правило")?;
            object.remove("balancerTag");
            object.insert("outboundTag".into(), json!(if ru || white { "direct" } else { target }));
            if white {
                if fallback {
                    object.remove("sourceIP");
                } else {
                    object.insert("sourceIP".into(), json!([DISABLED]));
                }
            } else if ru {
                if fallback {
                    object.insert("sourceIP".into(), json!([DISABLED]));
                } else if object.get("sourceIP") == Some(&json!([DISABLED])) {
                    object.remove("sourceIP");
                }
            }
        }
    }
    if fallback {
        let mut first = Vec::new();
        let mut remaining = Vec::new();
        let mut whitelist = None;
        for rule in std::mem::take(rules) {
            if rule["ruleTag"] == WHITE_TAG {
                whitelist = Some(rule);
                continue;
            }
            let node = rule["outboundTag"].as_str().unwrap_or("");
            let resources: Vec<&str> = ["domain", "ip"]
                .iter()
                .flat_map(|k| rule[*k].as_array().into_iter().flatten().filter_map(Value::as_str))
                .collect();
            if protected(node)
                || blocked.contains(node)
                || !resources.is_empty() && resources.iter().all(|r| local_resource(r))
            {
                first.push(rule)
            } else {
                remaining.push(rule)
            }
        }
        first.extend(whitelist);
        first.extend(remaining);
        *rules = first;
    }
    serde_json::to_string_pretty(&config).map_err(|e| e.to_string())
}
pub fn restore_xray(current: &str, before: &str, after: &str) -> Result<String, String> {
    let mut current: Value = serde_json::from_str(current).map_err(|e| e.to_string())?;
    let before: Value = serde_json::from_str(before).map_err(|e| e.to_string())?;
    let after: Value = serde_json::from_str(after).map_err(|e| e.to_string())?;
    if current == after {
        return serde_json::to_string_pretty(&before).map_err(|e| e.to_string());
    }
    let rules = current["routing"]["rules"].as_array_mut().ok_or("Нет правил")?;
    let shape = |r: &Value| {
        let mut r = r.clone();
        if let Some(obj) = r.as_object_mut() {
            obj.remove("outboundTag");
            obj.remove("balancerTag");
            if obj.get("sourceIP") == Some(&json!([DISABLED])) {
                obj.remove("sourceIP");
            }
        }
        r
    };
    for old in before["routing"]["rules"].as_array().ok_or("Нет снимка")? {
        let Some(new) = after["routing"]["rules"]
            .as_array()
            .ok_or("Нет снимка")?
            .iter()
            .find(|new| {
                if let Some(tag) = old["ruleTag"].as_str() {
                    new["ruleTag"] == tag
                } else {
                    shape(new) == shape(old)
                }
            })
        else {
            continue;
        };
        if old == new {
            continue;
        }
        if let Some(rule) = rules.iter_mut().find(|r| **r == *new) {
            *rule = old.clone()
        }
    }
    serde_json::to_string_pretty(&current).map_err(|e| e.to_string())
}
pub fn document(text: &str) -> Result<Yaml, String> {
    YamlLoader::load_from_str(text)
        .map_err(|e| e.to_string())?
        .into_iter()
        .next()
        .ok_or("Пустой YAML".into())
}
fn emit(value: &Yaml) -> Result<String, String> {
    let mut s = String::new();
    YamlEmitter::new(&mut s).dump(value).map_err(|e| e.to_string())?;
    Ok(s.trim_start_matches("---\n").to_owned())
}
fn range(text: &str, key: &str) -> Result<(usize, usize), String> {
    let mut offset = 0;
    let mut start = None;
    for line in text.split_inclusive('\n') {
        if start.is_none() {
            if line.starts_with(&format!("{key}:")) {
                let value = line[key.len() + 1..].split('#').next().unwrap_or("").trim();
                if !matches!(value, "" | "[]" | "{}" | "null") {
                    return Err(format!(
                        "Раздел {key} должен быть записан блочно, чтобы сохранить его содержимое"
                    ));
                }
                start = Some(offset)
            }
        } else if line.chars().next().is_some_and(|c| c.is_ascii_alphabetic()) && line.contains(':') {
            return Ok((start.unwrap(), offset));
        }
        offset += line.len();
    }
    start
        .map(|s| (s, text.len()))
        .ok_or(format!("Нет блочного раздела {key}"))
}
fn add_list(text: &str, key: &str, value: &Yaml) -> Result<String, String> {
    let (start, end) = range(text, key)?;
    let section = &text[start..end];
    let first = section.find('\n').map(|n| n + 1).unwrap_or(section.len());
    let body = if section[..first].contains("[]") {
        ""
    } else {
        &section[first..]
    };
    let addition = emit(&Yaml::Array(vec![value.clone()]))?
        .lines()
        .map(|l| format!("  {l}\n"))
        .collect::<String>();
    Ok(format!("{}{key}:\n{}{addition}{}", &text[..start], body, &text[end..]))
}
fn selections(text: &str) -> BTreeMap<String, String> {
    text.lines()
        .find_map(|l| {
            l.strip_prefix("# xkeen-ui-selections ")
                .and_then(|s| urlencoding::decode(s).ok())
                .and_then(|s| serde_json::from_str(&s).ok())
        })
        .unwrap_or_default()
}
fn with_selections(text: &str, selected: &BTreeMap<String, String>) -> String {
    format!(
        "# xkeen-ui-selections {}\n{}",
        urlencoding::encode(&serde_json::to_string(selected).unwrap()),
        text.lines()
            .filter(|l| !l.starts_with("# xkeen-ui-selections "))
            .collect::<Vec<_>>()
            .join("\n")
    )
}
fn resolved(name: &str, live: &Value) -> String {
    let mut n = name.to_owned();
    let mut seen = BTreeSet::new();
    while seen.insert(n.clone()) {
        let Some(next) = live[&n]["now"].as_str() else { return n };
        n = next.into()
    }
    n
}
fn rule_target(rule: &str) -> Option<(&str, &str, &str)> {
    let (body, suffix) = rule
        .strip_suffix(",no-resolve")
        .map(|s| (s, ",no-resolve"))
        .unwrap_or((rule, ""));
    let (head, target) = body.rsplit_once(',')?;
    Some((head, target.trim(), suffix))
}
fn ru_mihomo(rule: &str) -> bool {
    let Some((head, _, _)) = rule_target(rule) else {
        return false;
    };
    (head.starts_with("AND,((GEOSITE,category-ru),") || head.starts_with("AND,((GEOIP,ru),"))
        && (head.ends_with("(NETWORK,TCP))") || head.ends_with("(NETWORK,UDP))"))
        || matches!(
            head,
            "GEOSITE,ru"
                | "GEOSITE,category-ru"
                | "GEOSITE,category-ru-all"
                | "GEOSITE,category-bank-ru"
                | "GEOSITE,mts-ru"
                | "GEOIP,ru"
                | "GEOIP,by"
        )
}
fn local_mihomo(rule: &str) -> bool {
    rule_target(rule).is_some_and(|(head, _, _)| {
        matches!(
            head,
            "GEOIP,private"
                | "GEOSITE,private"
                | "IP-CIDR,127.0.0.0/8"
                | "IP-CIDR,10.0.0.0/8"
                | "IP-CIDR,172.16.0.0/12"
                | "IP-CIDR,192.168.0.0/16"
        )
    })
}
pub fn mihomo_plan(
    content: &str, target: &str, live: &Value, fallback: bool,
) -> Result<(String, BTreeMap<String, String>), String> {
    let mut text = content.to_owned();
    let mut doc = document(&text)?;
    for key in ["proxies", "proxy-groups", "rule-providers", "rules"] {
        if doc[key].is_badvalue() {
            if !text.ends_with('\n') {
                text.push('\n');
            }
            text.push_str(&format!("{key}:\n"));
        } else {
            let (start, end) = range(&text, key)?;
            let first = text[start..end].find('\n').map(|n| start + n + 1).unwrap_or(end);
            let header = &text[start..first];
            if header.contains("[]") || header.contains("{}") {
                text.replace_range(start..first, &format!("{key}:\n"));
            }
        }
    }
    doc = document(&text)?;
    if doc["proxy-groups"]
        .as_vec()
        .into_iter()
        .flatten()
        .any(|g| g["name"].as_str() == Some("Whitelist"))
        && !text.contains("RULE-SET,xkeen-autoswitch-whitelist,Whitelist")
    {
        return Err("Имя Whitelist уже используется другой группой".into());
    }
    if !doc["proxies"]
        .as_vec()
        .is_some_and(|nodes| nodes.iter().any(|n| n["name"].as_str() == Some(target)))
    {
        let source = if target == "CSQTT" {
            "name: CSQTT\ntype: direct\ninterface-name: csqtt0\nudp: true"
        } else {
            "name: WDTT Plus\ntype: socks5\nserver: 127.0.0.1\nport: 1088\nudp: true"
        };
        text = add_list(&text, "proxies", &document(source)?)?;
    }
    doc = document(&text)?;
    if doc["rule-providers"]["xkeen-autoswitch-whitelist"].is_badvalue() {
        let (start, end) = range(&text, "rule-providers")?;
        let first = text[start..end].find('\n').map(|n| start + n + 1).unwrap_or(end);
        let provider = "  xkeen-autoswitch-whitelist:\n    type: http\n    behavior: domain\n    format: mrs\n    url: https://raw.githubusercontent.com/hydraponique/roscomvpn-geosite/release/mihomo/whitelist.mrs\n    path: ./ruleset/autoswitch-whitelist.mrs\n    interval: 86400\n";
        text = format!(
            "{}rule-providers:\n{}{}{}",
            &text[..start],
            &text[first..end],
            provider,
            &text[end..]
        );
    }
    if !doc["proxy-groups"]
        .as_vec()
        .is_some_and(|g| g.iter().any(|g| g["name"].as_str() == Some("Whitelist")))
    {
        text = add_list(
            &text,
            "proxy-groups",
            &document(&format!("name: Whitelist\ntype: select\nproxies: [DIRECT]"))?,
        )?;
    }
    if !text.contains("RULE-SET,xkeen-autoswitch-whitelist,Whitelist") {
        let (_, end) = range(&text, "rules")?;
        let start = text[..end]
            .rfind("  - MATCH,")
            .or_else(|| text[..end].rfind("  - FINAL,"))
            .unwrap_or(end);
        let meta=urlencoding::encode("{\"tag\":\"custom:Whitelist\",\"name\":\"Whitelist\",\"domains\":[\"RULE-SET,xkeen-autoswitch-whitelist\"]}").into_owned();
        text = format!(
            "{}  # xkeen-custom-route {meta}\n  # xkeen-disabled-rule RULE-SET,xkeen-autoswitch-whitelist,Whitelist\n{}",
            &text[..start],
            &text[start..]
        );
    }
    let mut chosen = live
        .as_object()
        .into_iter()
        .flatten()
        .filter(|(_, p)| p["type"] == "Selector")
        .filter_map(|(name, p)| p["now"].as_str().map(|n| (name.clone(), n.to_owned())))
        .collect::<BTreeMap<_, _>>();
    chosen.insert("Whitelist".into(), "DIRECT".into());
    let policy_source = document(&text)?;
    let mut switch_groups = BTreeSet::new();
    let mut ru_groups: BTreeMap<String, Vec<bool>> = BTreeMap::new();
    if let Some(rules) = document(&text)?["rules"].as_vec() {
        for rule in rules.iter().filter_map(Yaml::as_str) {
            if let Some((_, node, _)) = rule_target(rule) {
                if live[node]["all"].is_array() {
                    ru_groups.entry(node.into()).or_default().push(ru_mihomo(rule));
                }
            }
        }
    }
    let ru_groups: BTreeSet<String> = ru_groups
        .into_iter()
        .filter(|(_, flags)| !flags.is_empty() && flags.iter().all(|v| *v))
        .map(|(name, _)| name)
        .collect();
    for group in &ru_groups {
        if live[group]["all"]
            .as_array()
            .is_some_and(|all| all.iter().any(|n| n == "DIRECT"))
        {
            chosen.insert(group.clone(), "DIRECT".into());
        }
    }
    if !fallback {
        return Ok((with_selections(&text, &chosen), chosen));
    }
    let mut lines = Vec::new();
    let mut in_rules = false;
    for line in text.lines() {
        if line.starts_with("rules:") {
            in_rules = true;
            lines.push(line.to_owned());
            continue;
        }
        if in_rules && line.chars().next().is_some_and(|c| c.is_ascii_alphabetic()) && line.contains(':') {
            in_rules = false
        }
        if !in_rules {
            lines.push(line.to_owned());
            continue;
        }
        if let Some(rule) = line.strip_prefix("  # xkeen-disabled-rule ") {
            if rule == "RULE-SET,xkeen-autoswitch-whitelist,Whitelist" {
                lines.push(format!("  - {rule}"));
                continue;
            }
        }
        if let Some(rule) = line.strip_prefix("  - ") {
            if let Some((head, node, suffix)) = rule_target(rule) {
                let actual = resolved(node, live);
                if protected(&actual)
                    || local_mihomo(rule)
                    || live[&actual]["type"]
                        .as_str()
                        .is_some_and(|s| matches!(s.to_ascii_lowercase().as_str(), "reject" | "rejectdrop"))
                {
                    lines.push(line.into());
                    continue;
                }
                if ru_mihomo(rule) && (!live[node]["all"].is_array() || ru_groups.contains(node)) {
                    if live[node]["all"]
                        .as_array()
                        .is_some_and(|all| all.iter().any(|n| n == "DIRECT"))
                    {
                        chosen.insert(node.to_owned(), "DIRECT".into());
                    }
                    lines.push(format!("  # xkeen-disabled-rule {rule}"));
                    continue;
                }
                if node == "Whitelist" {
                    lines.push(line.into());
                    continue;
                }
                if live[node]["all"].is_array() {
                    switch_groups.insert(node.to_owned());
                    lines.push(line.into());
                    continue;
                }
                lines.push(format!("  - {head},{target}{suffix}"));
                continue;
            }
        }
        lines.push(line.into());
    }
    text = lines.join("\n") + "\n";
    // Rewrite only affected group blocks; keep managed-marker comments in place.
    let (start, end) = range(&text, "proxy-groups")?;
    let section = &text[start..end];
    let mut blocks = Vec::new();
    let mut current = String::new();
    for line in section.split_inclusive('\n') {
        if line.starts_with("  - name:") && !current.is_empty() {
            blocks.push(current);
            current = String::new()
        }
        current.push_str(line);
    }
    blocks.push(current);
    let mut output = String::new();
    for block in blocks {
        if !block.starts_with("  - name:") {
            output.push_str(&block);
            continue;
        }
        let parsed = document(&block)?;
        let mut group = parsed
            .as_vec()
            .and_then(|g| g.first())
            .cloned()
            .ok_or("Неверная группа")?;
        let name = group["name"].as_str().ok_or("Нет имени группы")?.to_owned();
        if !switch_groups.contains(&name) {
            output.push_str(&block);
            continue;
        }
        if name == target {
            return Err("Группа резерва ссылается на себя".into());
        }
        let mut nodes = group["proxies"].as_vec().cloned().unwrap_or_default();
        if !nodes.iter().any(|n| n.as_str() == Some(target)) {
            nodes.push(Yaml::String(target.into()))
        }
        group["type"] = Yaml::String("select".into());
        group["proxies"] = Yaml::Array(nodes);
        if let Some(filter) = group["filter"].as_str().map(str::to_owned) {
            group["filter"] = Yaml::String(format!("(?:{filter})|^{}$", regex_escape(target)));
        }
        output.push_str(
            &emit(&Yaml::Array(vec![group]))?
                .lines()
                .map(|l| format!("  {l}\n"))
                .collect::<String>(),
        );
        for line in block.lines().filter(|l| l.trim_start().starts_with('#')) {
            output.push_str(line);
            output.push('\n')
        }
        chosen.insert(name, target.into());
    }
    text = format!("{}{}{}", &text[..start], output, &text[end..]);
    // Device metadata contains direct node choices as well as selector names.
    let mut patched = Vec::new();
    for line in text.lines() {
        if let Some(body) = line.strip_prefix("  # xkeen-device-start ") {
            if let Some((ip, encoded)) = body.split_once(' ') {
                if let Ok(decoded) = urlencoding::decode(encoded) {
                    if let Ok(mut choices) = serde_json::from_str::<Value>(&decoded) {
                        if let Some(map) = choices.as_object_mut() {
                            for (key, value) in map.iter_mut() {
                                if key.starts_with("__") {
                                    continue;
                                }
                                if (key == "RU" || key == "RU_IP") && !ru_groups.is_empty() || key.contains("Whitelist")
                                {
                                    *value = json!("DIRECT");
                                    continue;
                                }
                                if let Some(node) = value.as_str() {
                                    let actual = resolved(node, live);
                                    if !protected(&actual) {
                                        *value = json!(target)
                                    }
                                }
                            }
                            if !ru_groups.is_empty() && map.contains_key("RU") {
                                map.insert("__disabled:RU".into(), json!("true"));
                            }
                        }
                        patched.push(format!(
                            "  # xkeen-device-start {ip} {}",
                            urlencoding::encode(&serde_json::to_string(&choices).unwrap())
                        ));
                        continue;
                    }
                }
            }
        }
        patched.push(line.to_owned());
    }
    let mut text = patched.join("\n") + "\n";
    if !policy_source["sub-rules"]["xkeen-autoswitch-policy"].is_badvalue() {
        return Err("Имя xkeen-autoswitch-policy уже занято".into());
    }
    let mut policy = Vec::new();
    for rule in policy_source["rules"]
        .as_vec()
        .into_iter()
        .flatten()
        .filter_map(Yaml::as_str)
    {
        if let Some((_, node, _)) = rule_target(rule) {
            let actual = resolved(node, live);
            if protected(&actual)
                || local_mihomo(rule)
                || live[&actual]["type"]
                    .as_str()
                    .is_some_and(|s| matches!(s.to_ascii_lowercase().as_str(), "reject" | "rejectdrop"))
            {
                policy.push(rule.to_owned())
            }
        }
    }
    policy.push("RULE-SET,xkeen-autoswitch-whitelist,DIRECT".into());
    policy.push(format!("MATCH,{target}"));
    let addition = format!(
        "  xkeen-autoswitch-policy:\n{}",
        policy.iter().map(|r| format!("    - {r}\n")).collect::<String>()
    );
    if let Ok((a, b)) = range(&text, "sub-rules") {
        let first = text[a..b].find('\n').map(|n| a + n + 1).unwrap_or(b);
        text = format!(
            "{}sub-rules:\n{}{}{}",
            &text[..a],
            &text[first..b],
            addition,
            &text[b..]
        );
    } else {
        text.push_str(&format!("\nsub-rules:\n{addition}"));
    }
    let (root_start, _) = range(&text, "rules")?;
    let start = root_start + text[root_start..].find('\n').ok_or("Нет блока правил")? + 1;
    text.insert_str(
        start,
        "  - SUB-RULE,(NETWORK,TCP),xkeen-autoswitch-policy\n  - SUB-RULE,(NETWORK,UDP),xkeen-autoswitch-policy\n",
    );
    Ok((with_selections(&text, &chosen), chosen))
}
pub fn restore_mihomo(
    current: &str, before: &str, after: &str, live: &Value, target: &str,
) -> Result<(String, BTreeMap<String, String>), String> {
    // Preserve manual edits. Only values still equal to the applied reserve are restored.
    let old = selections(before);
    let applied = selections(after);
    let mut selected = selections(current);
    for (group, value) in &old {
        if applied.get(group).is_some_and(|v| v == target)
            && live[group]["now"] == target
            && selected.get(group) == applied.get(group)
        {
            selected.insert(group.clone(), value.clone());
        }
    }
    for (group, value) in &applied {
        if value == target && !old.contains_key(group) && live[group]["now"] == target {
            selected.remove(group);
        }
    }
    let before_lines: Vec<_> = before.lines().collect();
    let after_lines: Vec<_> = after.lines().collect();
    let mut lines: Vec<String> = current.lines().map(str::to_owned).collect();
    // Rule lines and device metadata are independent of proxy-group formatting.
    let relevant = |l: &&str| {
        !l.contains("SUB-RULE,(NETWORK,")
            && (l.starts_with("  - ")
                || l.starts_with("  # xkeen-disabled-rule ")
                || l.starts_with("  # xkeen-device-start "))
    };
    let b: Vec<_> = before_lines.iter().copied().filter(relevant).collect();
    let a: Vec<_> = after_lines.iter().copied().filter(relevant).collect();
    // Match whole applied lines; never replace a user's edited domain/IP condition.
    if b.len() == a.len() {
        for (old, new) in b.iter().zip(a) {
            if *old != new {
                if let Some(line) = lines.iter_mut().find(|l| l.as_str() == new) {
                    *line = (*old).to_owned()
                } else if old.starts_with("  # xkeen-device-start ") {
                    restore_device_choices(&mut lines, old, new);
                }
            }
        }
    }
    lines.retain(|l| {
        l != "  - SUB-RULE,(NETWORK,TCP),xkeen-autoswitch-policy"
            && l != "  - SUB-RULE,(NETWORK,UDP),xkeen-autoswitch-policy"
    });
    let mut result = with_selections(&(lines.join("\n") + "\n"), &selected);
    if let Ok((a, b)) = range(&result, "sub-rules") {
        let mut kept = Vec::new();
        let mut dropping = false;
        for line in result[a..b].lines() {
            if line == "  xkeen-autoswitch-policy:" {
                dropping = true;
                continue;
            }
            if dropping && !line.starts_with("   ") && !line.trim().is_empty() {
                dropping = false
            }
            if !dropping {
                kept.push(line)
            }
        }
        let section = if kept.iter().skip(1).any(|l| !l.trim().is_empty()) {
            kept.join("\n") + "\n"
        } else {
            String::new()
        };
        result = format!("{}{}{}", &result[..a], section, &result[b..]);
    }
    let old_doc = document(before)?;
    let after_doc = document(after)?;
    if let Ok((a, b)) = range(&result, "proxy-groups") {
        let section = &result[a..b];
        let mut out = String::new();
        let mut block = String::new();
        let mut parts = Vec::new();
        for line in section.split_inclusive('\n') {
            if line.starts_with("  - name:") && !block.is_empty() {
                parts.push(block);
                block = String::new()
            }
            block.push_str(line)
        }
        parts.push(block);
        for mut block in parts {
            if block.starts_with("  - name:") {
                let parsed = document(&block)?;
                if let Some(g) = parsed.as_vec().and_then(|v| v.first()) {
                    if let Some(name) = g["name"].as_str() {
                        let old_group = old_doc["proxy-groups"]
                            .as_vec()
                            .into_iter()
                            .flatten()
                            .find(|v| v["name"].as_str() == Some(name));
                        let applied_group = after_doc["proxy-groups"]
                            .as_vec()
                            .into_iter()
                            .flatten()
                            .find(|v| v["name"].as_str() == Some(name));
                        if let (Some(old_group), Some(applied_group)) = (old_group, applied_group) {
                            let mut restored = g.clone();
                            if live[name]["now"] == target {
                                for key in ["type", "proxies", "filter"] {
                                    if old_group[key] != applied_group[key] && g[key] == applied_group[key] {
                                        if old_group[key].is_badvalue() {
                                            if let Yaml::Hash(map) = &mut restored {
                                                map.remove(&Yaml::String(key.into()));
                                            }
                                        } else {
                                            restored[key] = old_group[key].clone();
                                        }
                                    }
                                }
                            }
                            if restored != *g {
                                let comments = block
                                    .lines()
                                    .filter(|l| l.trim_start().starts_with('#'))
                                    .map(|l| format!("{l}\n"))
                                    .collect::<String>();
                                block = emit(&Yaml::Array(vec![restored]))?
                                    .lines()
                                    .map(|l| format!("  {l}\n"))
                                    .collect::<String>()
                                    + &comments;
                            }
                        }
                    }
                }
            }
            out.push_str(&block);
        }
        result = format!("{}{}{}", &result[..a], out, &result[b..]);
    }
    // When no user edits occurred, restore original policy group types and exact metadata too.
    if current == after {
        result = with_selections(before, &selected)
    }
    Ok((result, selected))
}

fn regex_escape(value: &str) -> String {
    let mut escaped = String::new();
    for ch in value.chars() {
        if ".*+?^${}()|[]\\".contains(ch) {
            escaped.push('\\');
        }
        escaped.push(ch);
    }
    escaped
}

fn restore_device_choices(lines: &mut [String], before: &str, applied: &str) {
    let parse = |line: &str| -> Option<(String, Value)> {
        let (ip, encoded) = line.strip_prefix("  # xkeen-device-start ")?.split_once(' ')?;
        Some((
            ip.to_owned(),
            serde_json::from_str(&urlencoding::decode(encoded).ok()?).ok()?,
        ))
    };
    let (Some((ip, old)), Some((_, new))) = (parse(before), parse(applied)) else {
        return;
    };
    for line in lines {
        let Some((current_ip, mut current)) = parse(line) else {
            continue;
        };
        if current_ip != ip {
            continue;
        }
        let (Some(old), Some(new), Some(current_map)) = (old.as_object(), new.as_object(), current.as_object_mut())
        else {
            return;
        };
        for key in old.keys().chain(new.keys()) {
            if old.get(key) != new.get(key) && current_map.get(key) == new.get(key) {
                if let Some(value) = old.get(key) {
                    current_map.insert(key.clone(), value.clone());
                } else {
                    current_map.remove(key);
                }
            }
        }
        *line = format!(
            "  # xkeen-device-start {ip} {}",
            urlencoding::encode(&serde_json::to_string(&current).unwrap())
        );
        return;
    }
}

pub fn classification(foreign: &[Value], white: &[Value]) -> (bool, bool) {
    let reachable = foreign.iter().filter(|r| r["ok"] == true).count();
    (
        foreign.len() == 5 && reachable == 0 && white.iter().any(|r| r["ok"] == true),
        foreign.len() == 5 && reachable >= 3,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    fn xray() -> String {
        json!({"outbounds":[{"tag":"direct","protocol":"freedom"},{"tag":"csqtt","protocol":"freedom"},{"tag":"block","protocol":"blackhole"}],"routing":{"rules":[
            {"type":"field","ruleTag":"device:192.168.0.130:VPN","sourceIP":["192.168.0.130"],"outboundTag":"direct"},
            {"type":"field","ruleTag":"Ads","domain":["geosite:category-ads-all"],"outboundTag":"block"},
            {"type":"field","ruleTag":"RU","domain":["ext:roscomvpn-geosite.dat:category-ru","ext:roscomvpn-geosite.dat:whitelist","geosite:category-bank-ru","geosite:mts-ru"],"outboundTag":"direct"},
            {"type":"field","ruleTag":"Mixed","domain":["domain:site.ru","domain:github.com"],"outboundTag":"direct"},
            {"type":"field","ruleTag":"LAN","ip":["192.168.0.0/16"],"outboundTag":"direct"},
            {"type":"field","ruleTag":"VPN","outboundTag":"direct"}
        ]}}).to_string()
    }
    #[test]
    fn xray_narrow_whitelist_and_blocked_precede_device_catchall() {
        let normal = xray_plan(&xray(), "csqtt", false).unwrap();
        let after = xray_plan(&normal, "csqtt", true).unwrap();
        let v: Value = serde_json::from_str(&after).unwrap();
        let rules = v["routing"]["rules"].as_array().unwrap();
        let find = |name: &str| rules.iter().find(|r| r["ruleTag"] == name).unwrap();
        assert_eq!(find("RU")["outboundTag"], "direct");
        assert_eq!(find("RU")["sourceIP"], json!([DISABLED]));
        assert_eq!(find(WHITE_TAG)["outboundTag"], "direct");
        assert!(find(WHITE_TAG)["sourceIP"].is_null());
        assert_eq!(find("Ads")["outboundTag"], "block");
        assert_eq!(find("Mixed")["outboundTag"], "csqtt");
        assert_eq!(find("LAN")["outboundTag"], "direct");
        assert_eq!(find("VPN")["outboundTag"], "csqtt");
        assert_eq!(find("device:192.168.0.130:VPN")["outboundTag"], "csqtt");
        let index = |name: &str| rules.iter().position(|r| r["ruleTag"] == name).unwrap();
        assert!(index("Ads") < index(WHITE_TAG));
        assert!(index(WHITE_TAG) < index("device:192.168.0.130:VPN"));
        let restored = restore_xray(&after, &normal, &after).unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&restored).unwrap(),
            serde_json::from_str::<Value>(&normal).unwrap()
        );
    }
    #[test]
    fn xray_return_keeps_manual_changes_and_new_rules() {
        let normal = xray_plan(&xray(), "csqtt", false).unwrap();
        let after = xray_plan(&normal, "csqtt", true).unwrap();
        let mut edited: Value = serde_json::from_str(&after).unwrap();
        let rules = edited["routing"]["rules"].as_array_mut().unwrap();
        rules.iter_mut().find(|r| r["ruleTag"] == "Mixed").unwrap()["outboundTag"] = json!("block");
        rules.push(json!({"type":"field","ruleTag":"Owner","domain":["domain:owner.example"],"outboundTag":"direct"}));
        let restored: Value =
            serde_json::from_str(&restore_xray(&edited.to_string(), &normal, &after).unwrap()).unwrap();
        let rules = restored["routing"]["rules"].as_array().unwrap();
        assert_eq!(
            rules.iter().find(|r| r["ruleTag"] == "Mixed").unwrap()["outboundTag"],
            "block"
        );
        assert!(rules.iter().any(|r| r["ruleTag"] == "Owner"));
        assert_eq!(
            rules.iter().find(|r| r["ruleTag"] == "VPN").unwrap()["outboundTag"],
            "direct"
        );
    }
    const YAML: &str = "mixed-port: 0\nmode: rule\nrouting-mark: 255\nproxies:\n  - name: CSQTT\n    type: direct\n    interface-name: csqtt0\nproxy-providers:\nrule-providers:\nproxy-groups:\n  - name: VPN\n    type: select\n    proxies: [DIRECT, CSQTT]\n  - name: RU\n    type: select\n    proxies: [DIRECT, CSQTT]\n  - name: Ads\n    type: select\n    proxies: [REJECT, DIRECT]\nrules:\n  # xkeen-device-start 192.168.0.130 %7B%22VPN%22%3A%22DIRECT%22%2C%22RU%22%3A%22RU%22%7D\n  - SRC-IP-CIDR,192.168.0.130/32,DIRECT\n  # xkeen-device-end 192.168.0.130\n  - IP-CIDR,192.168.0.0/16,DIRECT,no-resolve\n  - GEOSITE,category-ads-all,Ads\n  - GEOSITE,category-ru,RU\n  - DOMAIN-SUFFIX,github.com,DIRECT\n  - MATCH,VPN\n";
    fn live() -> Value {
        json!({"VPN":{"type":"Selector","now":"DIRECT","all":["DIRECT","CSQTT"]},"RU":{"type":"Selector","now":"DIRECT","all":["DIRECT","CSQTT"]},"Ads":{"type":"Selector","now":"REJECT","all":["REJECT","DIRECT"]},"Whitelist":{"type":"Selector","now":"DIRECT","all":["DIRECT"]},"DIRECT":{"type":"Direct"},"REJECT":{"type":"Reject"},"CSQTT":{"type":"Direct"}})
    }
    #[test]
    fn mihomo_whitelist_direct_and_temporary_policy_cover_devices() {
        let normal = mihomo_plan(YAML, "CSQTT", &live(), false).unwrap().0;
        assert!(normal.contains("# xkeen-disabled-rule RULE-SET,xkeen-autoswitch-whitelist,Whitelist"));
        let (after, choices) = mihomo_plan(&normal, "CSQTT", &live(), true).unwrap();
        let doc = document(&after).unwrap();
        assert_eq!(choices["VPN"], "CSQTT");
        assert_eq!(choices["RU"], "DIRECT");
        assert_eq!(choices["Ads"], "REJECT");
        assert_eq!(choices["Whitelist"], "DIRECT");
        assert!(after.contains("# xkeen-disabled-rule GEOSITE,category-ru,RU"));
        let policy = doc["sub-rules"]["xkeen-autoswitch-policy"].as_vec().unwrap();
        assert!(policy.contains(&Yaml::String("RULE-SET,xkeen-autoswitch-whitelist,DIRECT".into())));
        assert_eq!(policy.last().unwrap().as_str(), Some("MATCH,CSQTT"));
        assert!(policy.contains(&Yaml::String("GEOSITE,category-ads-all,Ads".into())));
        assert_eq!(
            doc["rules"].as_vec().unwrap()[0].as_str(),
            Some("SUB-RULE,(NETWORK,TCP),xkeen-autoswitch-policy")
        );
        let mut running = live();
        running["VPN"]["now"] = json!("CSQTT");
        let restored = restore_mihomo(&after, &normal, &after, &running, "CSQTT").unwrap().0;
        assert!(document(&restored).unwrap()["sub-rules"]["xkeen-autoswitch-policy"].is_badvalue());
        assert!(restored.contains("# xkeen-disabled-rule RULE-SET,xkeen-autoswitch-whitelist,Whitelist"));
        assert!(restored.contains("  - GEOSITE,category-ru,RU"));
        assert_eq!(selections(&restored)["VPN"], "DIRECT");
    }
    #[test]
    fn mihomo_return_keeps_user_conditions() {
        let normal = mihomo_plan(YAML, "CSQTT", &live(), false).unwrap().0;
        let after = mihomo_plan(&normal, "CSQTT", &live(), true).unwrap().0;
        let edited = after.replace("DOMAIN-SUFFIX,github.com,CSQTT", "DOMAIN-SUFFIX,owner.example,REJECT");
        let mut running = live();
        running["VPN"]["now"] = json!("CSQTT");
        let restored = restore_mihomo(&edited, &normal, &after, &running, "CSQTT").unwrap().0;
        assert!(restored.contains("DOMAIN-SUFFIX,owner.example,REJECT"));
        assert!(!restored.contains("SUB-RULE,(NETWORK,TCP),xkeen-autoswitch-policy"));
        assert!(restored.contains("  - GEOSITE,category-ru,RU"));
    }
    #[test]
    fn all_foreign_must_fail_and_any_whitelist_must_work() {
        let fail = vec![json!({"ok":false}); 5];
        assert_eq!(classification(&fail, &[json!({"ok":true})]), (true, false));
        assert_eq!(classification(&fail, &[json!({"ok":false})]), (false, false));
        let mut mixed = fail;
        mixed[0] = json!({"ok":true});
        assert_eq!(classification(&mixed, &[json!({"ok":true})]), (false, false));
        mixed[1] = json!({"ok":true});
        assert_eq!(classification(&mixed, &[]), (false, false));
        mixed[2] = json!({"ok":true});
        assert_eq!(classification(&mixed, &[]), (false, true));
        assert_eq!(classification(&[], &[json!({"ok":true})]), (false, false));
        assert_eq!(
            classification(&vec![json!({"ok":false}); 4], &[json!({"ok":true})]),
            (false, false)
        );
    }
    #[test]
    fn mixed_ru_group_is_not_disabled() {
        let input = YAML.replace(
            "  - GEOSITE,category-ru,RU",
            "  - GEOSITE,category-ru,RU\n  - DOMAIN-SUFFIX,github.com,RU",
        );
        let normal = mihomo_plan(&input, "CSQTT", &live(), false).unwrap().0;
        let (after, chosen) = mihomo_plan(&normal, "CSQTT", &live(), true).unwrap();
        assert!(!after.contains("# xkeen-disabled-rule GEOSITE,category-ru,RU"));
        assert_eq!(chosen["RU"], "CSQTT");
    }
    #[test]
    fn device_return_restores_only_unedited_choices() {
        let line = |v: &Value| {
            format!(
                "  # xkeen-device-start 192.168.0.130 {}",
                urlencoding::encode(&v.to_string())
            )
        };
        let before = line(&json!({"VPN":"DIRECT","RU":"RU","custom:Owner":"Old"}));
        let after = line(&json!({"VPN":"CSQTT","RU":"DIRECT","__disabled:RU":"true","custom:Owner":"CSQTT"}));
        let mut lines = vec![line(
            &json!({"VPN":"CSQTT","RU":"DIRECT","__disabled:RU":"true","custom:Owner":"REJECT"}),
        )];
        restore_device_choices(&mut lines, &before, &after);
        let raw = lines[0].split_whitespace().last().unwrap();
        let value: Value = serde_json::from_str(&urlencoding::decode(raw).unwrap()).unwrap();
        assert_eq!(value["VPN"], "DIRECT");
        assert_eq!(value["RU"], "RU");
        assert_eq!(value["custom:Owner"], "REJECT");
        assert!(value["__disabled:RU"].is_null());
    }
    #[test]
    fn policy_group_type_returns_after_unrelated_manual_edit() {
        let input = YAML.replacen("type: select", "type: url-test", 1);
        let mut active = live();
        active["VPN"]["type"] = json!("URLTest");
        let normal = mihomo_plan(&input, "CSQTT", &active, false).unwrap().0;
        let after = mihomo_plan(&normal, "CSQTT", &active, true).unwrap().0;
        active["VPN"]["now"] = json!("CSQTT");
        let current = after.clone() + "\n# Owner comment\n";
        let (restored, choices) = restore_mihomo(&current, &normal, &after, &active, "CSQTT").unwrap();
        let doc = document(&restored).unwrap();
        assert_eq!(
            doc["proxy-groups"]
                .as_vec()
                .unwrap()
                .iter()
                .find(|g| g["name"].as_str() == Some("VPN"))
                .unwrap()["type"]
                .as_str(),
            Some("url-test")
        );
        assert!(!choices.contains_key("VPN"));
        assert!(restored.contains("# Owner comment"));
    }
}
