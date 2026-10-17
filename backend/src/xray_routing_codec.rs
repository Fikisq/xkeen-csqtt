// SPDX-License-Identifier: MPL-2.0
// Routing semantics adapted from XTLS/Xray-core 52a412d9e2f5; see LICENSE-Xray.
//! Native compiler matching Xray 26.9.9 infra/conf/router.go and geodata/rule_parser.go.
use crate::xray_wire::*;
use prost::Message;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, net::IpAddr, path::Path};

fn string(v: &Value) -> Result<String, String> {
    if v.is_null() {
        Ok(String::new())
    } else {
        v.as_str().map(str::to_owned).ok_or_else(|| "Ожидается строка".into())
    }
}
fn strings(v: &Value) -> Result<Vec<String>, String> {
    match v {
        Value::Null => Ok(Vec::new()),
        Value::String(s) => Ok(s.split(',').map(str::to_owned).collect()),
        Value::Array(a) => a.iter().map(string).collect(),
        _ => Err("Ожидается строка или список строк".into()),
    }
}
fn list(v: &Value) -> Result<&[Value], String> {
    if v.is_null() {
        Ok(&[])
    } else {
        v.as_array().map(Vec::as_slice).ok_or_else(|| "Ожидается список".into())
    }
}
fn uint(v: &Value) -> Result<u32, String> {
    if v.is_null() {
        return Ok(0);
    }
    v.as_u64()
        .and_then(|n| u32::try_from(n).ok())
        .ok_or_else(|| "Ожидается uint32".into())
}
fn boolean(v: &Value) -> Result<bool, String> {
    if v.is_null() {
        Ok(false)
    } else {
        v.as_bool().ok_or_else(|| "Ожидается boolean".into())
    }
}
fn float(v: &Value) -> Result<f64, String> {
    if v.is_null() {
        Ok(0.)
    } else {
        v.as_f64().ok_or_else(|| "Ожидается число".into())
    }
}
fn map(v: &Value) -> Result<BTreeMap<String, String>, String> {
    if v.is_null() {
        return Ok(BTreeMap::new());
    }
    v.as_object()
        .ok_or("Ожидается объект")?
        .iter()
        .map(|(k, v)| Ok((k.clone(), string(v)?)))
        .collect()
}
fn reverse(mut s: &str) -> (&str, bool) {
    let mut reversed = false;
    while let Some(rest) = s.strip_prefix('!') {
        reversed = !reversed;
        s = rest
    }
    (s, reversed)
}
fn geo_reference(s: &str) -> Result<(String, String), String> {
    let (f, c) = s.split_once(':').ok_or("Неверная ссылка на геобазу")?;
    if f.is_empty() || c.is_empty() {
        return Err("Пустое имя файла или категории".into());
    }
    Ok((f.into(), c.into()))
}

fn domain(text: String) -> Result<DomainRule, String> {
    let converted;
    let text = if let Some(code) = text.strip_prefix("geosite:") {
        converted = format!("ext:geosite.dat:{code}");
        converted.as_str()
    } else {
        &text
    };
    let value = if let Some(ext) = ["ext:", "ext-domain:", "ext-site:"]
        .iter()
        .find_map(|p| text.strip_prefix(p))
    {
        let (file, code_attrs) = geo_reference(ext)?;
        if code_attrs.ends_with('@') || code_attrs.contains("@@") {
            return Err("Пустой атрибут GeoSite".into());
        }
        let (code, attrs) = code_attrs.split_once('@').unwrap_or((&code_attrs, ""));
        if code.is_empty() {
            return Err("Пустая категория GeoSite".into());
        }
        DomainValue::Geosite(GeoSiteRule {
            file,
            code: code.to_uppercase(),
            attrs: attrs.to_lowercase(),
        })
    } else {
        let (kind, value) = if let Some(v) = text.strip_prefix("regexp:") {
            (1, v.to_owned())
        } else if let Some(v) = text.strip_prefix("domain:") {
            (2, v.to_owned())
        } else if let Some(v) = text.strip_prefix("full:") {
            (3, v.to_owned())
        } else if let Some(v) = text.strip_prefix("keyword:") {
            (0, v.to_owned())
        } else if let Some(v) = text.strip_prefix("dotless:") {
            if v.contains('.') {
                return Err("dotless не должен содержать точку".into());
            }
            (
                1,
                if v.is_empty() {
                    "^[^.]*$".into()
                } else {
                    format!("^[^.]*{v}[^.]*$")
                },
            )
        } else {
            (0, text.to_owned())
        };
        DomainValue::Custom(Domain { r#type: kind, value })
    };
    Ok(DomainRule { value: Some(value) })
}
fn ip(text: String) -> Result<IpRule, String> {
    let (text, reversed) = reverse(&text);
    let converted;
    let text = if let Some(code) = text.strip_prefix("geoip:") {
        converted = format!("ext:geoip.dat:{code}");
        converted.as_str()
    } else {
        text
    };
    let value = if let Some(ext) = ["ext:", "ext-ip:"].iter().find_map(|p| text.strip_prefix(p)) {
        let (file, code) = geo_reference(ext)?;
        let (code, code_reverse) = reverse(&code);
        if code.is_empty() {
            return Err("Пустая категория GeoIP".into());
        }
        IpValue::Geoip(GeoIpRule {
            file,
            code: code.to_uppercase(),
            reverse_match: reversed != code_reverse,
        })
    } else {
        let (address, prefix) = text.split_once('/').unwrap_or((text, ""));
        let address = address
            .parse::<IpAddr>()
            .map_err(|_| format!("Неверный IP: {address}"))?;
        let (bytes, max) = match address {
            IpAddr::V4(v) => (v.octets().to_vec(), 32),
            IpAddr::V6(v) => match v.to_ipv4_mapped() {
                Some(v) => (v.octets().to_vec(), 32),
                None => (v.octets().to_vec(), 128),
            },
        };
        let prefix = if prefix.is_empty() {
            max
        } else {
            prefix.parse::<u32>().map_err(|_| "Неверная маска CIDR")?
        };
        if prefix > max {
            return Err("Слишком длинная маска CIDR".into());
        }
        IpValue::Custom(CidrRule {
            cidr: Some(Cidr { ip: bytes, prefix }),
            reverse_match: reversed,
        })
    };
    Ok(IpRule { value: Some(value) })
}
fn ports(v: &Value) -> Result<Option<PortList>, String> {
    if v.is_null() {
        return Ok(None);
    }
    let mut ranges = Vec::new();
    if v.is_number() {
        let p = uint(v)?;
        if p != 0 {
            ranges.push(PortRange { from: p, to: p })
        }
    } else {
        for item in v
            .as_str()
            .ok_or("Неверный формат портов")?
            .split(',')
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            let expanded;
            let item = if let Some(name) = item.strip_prefix("env:") {
                expanded = std::env::var(name).unwrap_or_default();
                expanded.as_str()
            } else {
                item
            };
            let (a, b) = item.split_once('-').unwrap_or((item, item));
            let from = a.parse::<u16>().map_err(|_| "Неверный порт")?;
            let to = b.parse::<u16>().map_err(|_| "Неверный порт")?;
            ranges.push(PortRange {
                from: from.into(),
                to: to.into(),
            });
        }
    }
    Ok(Some(PortList { range: ranges }))
}
fn duration(v: &Value) -> Result<i64, String> {
    if v.is_null() {
        return Ok(0);
    }
    let text = v.as_str().ok_or("Длительность должна быть строкой")?;
    let (negative, mut rest) = if let Some(s) = text.strip_prefix('-') {
        (true, s)
    } else {
        (false, text.strip_prefix('+').unwrap_or(text))
    };
    if rest == "0" {
        return Ok(0);
    }
    if rest.is_empty() {
        return Err("Пустая длительность".into());
    }
    let mut total = 0f64;
    while !rest.is_empty() {
        let end = rest
            .find(|c: char| !c.is_ascii_digit() && c != '.')
            .unwrap_or(rest.len());
        let amount = rest[..end].parse::<f64>().map_err(|_| "Неверная длительность")?;
        rest = &rest[end..];
        let (unit, scale) = [
            ("ns", 1.),
            ("us", 1e3),
            ("µs", 1e3),
            ("μs", 1e3),
            ("ms", 1e6),
            ("s", 1e9),
            ("m", 60e9),
            ("h", 3600e9),
        ]
        .into_iter()
        .find(|(u, _)| rest.starts_with(u))
        .ok_or("Неизвестная единица длительности")?;
        total += (amount * scale).trunc();
        rest = &rest[unit.len()..];
    }
    if negative {
        total = -total
    }
    if !total.is_finite() || total < i64::MIN as f64 || total >= -(i64::MIN as f64) {
        return Err("Слишком большая длительность".into());
    }
    Ok(total as i64)
}
fn balancer(raw: &Value) -> Result<Balancer, String> {
    if !raw.is_object() {
        return Err("Неверный балансировщик".into());
    }
    let tag = string(&raw["tag"])?;
    let outbound_selector = strings(&raw["selector"])?;
    if tag.is_empty() || outbound_selector.is_empty() {
        return Err("Пустой тег или selector балансировщика".into());
    }
    let strategy_config = &raw["strategy"];
    if !strategy_config.is_null() && !strategy_config.is_object() {
        return Err("Неверная стратегия балансировщика".into());
    }
    let mut strategy = string(&strategy_config["type"])?.to_lowercase();
    if strategy.is_empty() {
        strategy = "random".into()
    }
    if !["random", "leastping", "roundrobin", "leastload"].contains(&strategy.as_str()) {
        return Err("Неизвестная стратегия балансировщика".into());
    }
    let settings = &strategy_config["settings"];
    if !settings.is_null() && !settings.is_object() {
        return Err("Неверные настройки балансировщика".into());
    }
    let strategy_settings = if strategy == "leastload" {
        let mut costs = Vec::new();
        for cost in list(&settings["costs"])? {
            if !cost.is_object() {
                return Err("Неверный вес балансировщика".into());
            }
            costs.push(Weight {
                regexp: boolean(&cost["regexp"])?,
                r#match: string(&cost["match"])?,
                value: float(&cost["value"])? as f32,
            });
        }
        let mut baselines = Vec::new();
        for v in list(&settings["baselines"])? {
            let ns = duration(v)?;
            if ns > 0 {
                baselines.push(ns)
            }
        }
        let expected = if settings["expected"].is_null() {
            0
        } else {
            settings["expected"]
                .as_i64()
                .and_then(|v| i32::try_from(v).ok())
                .ok_or("Неверный expected")?
        };
        let value = LeastLoad {
            costs,
            baselines,
            expected: expected.max(0),
            max_rtt: duration(&settings["maxRTT"])?.max(0),
            tolerance: (float(&settings["tolerance"])? as f32).clamp(0., 1.),
        };
        Some(TypedMessage {
            r#type: "xray.app.router.StrategyLeastLoadConfig".into(),
            value: value.encode_to_vec(),
        })
    } else {
        None
    };
    Ok(Balancer {
        tag,
        outbound_selector,
        strategy,
        strategy_settings,
        fallback_tag: string(&raw["fallbackTag"])?,
    })
}
fn rule(raw: &Value) -> Result<RoutingRule, String> {
    if !raw.is_object() {
        return Err("Неверное правило маршрутизации".into());
    }
    // Xray's JSON decoder validates even fields shadowed by aliases/targets.
    let balancing_tag = string(&raw["balancerTag"])?;
    for name in ["domain", "domains", "source", "sourceIP"] {
        strings(&raw[name])?;
    }
    let outbound = string(&raw["outboundTag"])?;
    let target = if !outbound.is_empty() {
        Target::Tag(outbound)
    } else {
        if balancing_tag.is_empty() {
            return Err("Не задан outboundTag или balancerTag".into());
        }
        Target::BalancingTag(balancing_tag)
    };
    let domains = if !raw["domains"].is_null() {
        &raw["domains"]
    } else {
        &raw["domain"]
    };
    let source = if !raw["sourceIP"].is_null() {
        &raw["sourceIP"]
    } else {
        &raw["source"]
    };
    let webhook = &raw["webhook"];
    let webhook = if webhook.is_null() {
        None
    } else {
        if !webhook.is_object() {
            return Err("Неверный webhook".into());
        }
        let url = string(&webhook["url"])?;
        let deduplication = uint(&webhook["deduplication"])?;
        let headers = map(&webhook["headers"])?;
        if url.is_empty() {
            None
        } else {
            Some(Webhook {
                url,
                deduplication,
                headers,
            })
        }
    };
    Ok(RoutingRule {
        target: Some(target),
        rule_tag: string(&raw["ruleTag"])?,
        domain: strings(domains)?.into_iter().map(domain).collect::<Result<_, _>>()?,
        ip: strings(&raw["ip"])?.into_iter().map(ip).collect::<Result<_, _>>()?,
        source_ip: strings(source)?.into_iter().map(ip).collect::<Result<_, _>>()?,
        local_ip: strings(&raw["localIP"])?
            .into_iter()
            .map(ip)
            .collect::<Result<_, _>>()?,
        networks: strings(&raw["network"])?
            .iter()
            .map(|n| match n.to_lowercase().as_str() {
                "tcp" => 2,
                "udp" => 3,
                "unix" => 4,
                _ => 0,
            })
            .collect(),
        port_list: ports(&raw["port"])?,
        source_port_list: ports(&raw["sourcePort"])?,
        local_port_list: ports(&raw["localPort"])?,
        vless_route_list: ports(&raw["vlessRoute"])?,
        user_email: strings(&raw["user"])?,
        inbound_tag: strings(&raw["inboundTag"])?,
        protocol: strings(&raw["protocol"])?,
        attributes: map(&raw["attrs"])?,
        process: strings(&raw["process"])?,
        local_os: strings(&raw["localOS"])?,
        webhook,
    })
}
pub fn build(raw: &Value) -> Result<Config, String> {
    if !raw.is_object() {
        return Err("Неверный объект routing".into());
    }
    let domain_strategy = match string(&raw["domainStrategy"])?.to_lowercase().as_str() {
        "ipifnonmatch" => 2,
        "ipondemand" => 3,
        _ => 0,
    };
    Ok(Config {
        domain_strategy,
        rule: list(&raw["rules"])?.iter().map(rule).collect::<Result<_, _>>()?,
        balancing_rule: list(&raw["balancers"])?
            .iter()
            .map(balancer)
            .collect::<Result<_, _>>()?,
    })
}
// Reuse named CIDR sets in Xray, avoiding its whole-core GC per inline set.
pub fn optimize_ips(config: &mut Config, path: &Path) -> Result<(), String> {
    let mut groups = match std::fs::read(path) {
        Ok(bytes) => {
            GeoIpList::decode(bytes.as_slice())
                .map_err(|e| format!("Повреждён IP-кэш: {e}"))?
                .entry
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Vec::new(),
        Err(e) => return Err(e.to_string()),
    };
    let mut dirty = false;
    for rule in &mut config.rule {
        for ips in [&mut rule.source_ip, &mut rule.ip, &mut rule.local_ip] {
            if ips.is_empty() {
                continue;
            }
            let mut cidr = Vec::new();
            for ip in ips.iter() {
                match &ip.value {
                    Some(IpValue::Custom(c)) if !c.reverse_match => match &c.cidr {
                        Some(c) => cidr.push(c.clone()),
                        None => break,
                    },
                    _ => break,
                }
            }
            if cidr.len() != ips.len() {
                continue;
            }
            let hash = Sha256::digest(
                GeoIp {
                    cidr: cidr.clone(),
                    ..Default::default()
                }
                .encode_to_vec(),
            );
            let code = format!("XKEEN{hash:X}");
            if !groups.iter().any(|g| g.code == code) {
                groups.push(GeoIp {
                    code: code.clone(),
                    cidr,
                    ..Default::default()
                });
                dirty = true
            }
            *ips = vec![IpRule {
                value: Some(IpValue::Geoip(GeoIpRule {
                    file: path
                        .file_name()
                        .and_then(|v| v.to_str())
                        .ok_or("Неверный путь IP-кэша")?
                        .into(),
                    code,
                    reverse_match: false,
                })),
            }];
        }
    }
    if dirty {
        groups.sort_by(|a, b| a.code.cmp(&b.code));
        let temporary = path.with_file_name(format!("sources-{}.tmp", uuid::Uuid::new_v4()));
        let data = GeoIpList { entry: groups }.encode_to_vec();
        let result = (|| -> std::io::Result<()> {
            use std::io::Write;
            let mut options = std::fs::OpenOptions::new();
            options.write(true).create_new(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600);
            }
            let mut file = options.open(&temporary)?;
            file.write_all(&data)?;
            drop(file);
            std::fs::rename(&temporary, path)
        })();
        if result.is_err() {
            let _ = std::fs::remove_file(&temporary);
        }
        result.map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine;
    #[test]
    fn matches_upstream_reference() {
        let cases: Vec<Value> = serde_json::from_str(include_str!("xray_routing_fixtures.json")).unwrap();
        for (i, case) in cases.iter().enumerate() {
            let actual = build(&case["routing"]);
            if case["valid"] == true {
                let bytes = base64::engine::general_purpose::STANDARD
                    .decode(case["protobuf"].as_str().unwrap())
                    .unwrap();
                let expected = Config::decode(bytes.as_slice()).unwrap();
                assert_eq!(
                    actual.unwrap_or_else(|e| panic!("case {i}: {e}")),
                    expected,
                    "case {i}: {}",
                    case["routing"]
                );
            } else {
                assert!(
                    actual.is_err(),
                    "accepted invalid reference case {i}: {}",
                    case["routing"]
                );
            }
        }
    }
    #[test]
    fn private_ip_groups_preserve_matches_and_reuse_cache() {
        let dir = std::env::temp_dir().join(format!("xkeen-ip-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&dir).unwrap();
        let path = dir.join(".xkeen-ui-source-cache.dat");
        let mut config=build(&serde_json::json!({"rules":[{"outboundTag":"direct","sourceIP":["192.0.2.1","192.0.2.2"],"ip":["!203.0.113.1"]}]})).unwrap();
        let original = config.rule[0].source_ip.clone();
        let reversed = config.rule[0].ip.clone();
        optimize_ips(&mut config, &path).unwrap();
        let saved = std::fs::read(&path).unwrap();
        let IpValue::Geoip(reference) = config.rule[0].source_ip[0].value.as_ref().unwrap() else {
            panic!("not grouped")
        };
        let cache = GeoIpList::decode(saved.as_slice()).unwrap();
        let group = cache.entry.iter().find(|g| g.code == reference.code).unwrap();
        assert_eq!(
            group.cidr,
            original
                .iter()
                .map(|r| {
                    let Some(IpValue::Custom(c)) = &r.value else { panic!() };
                    c.cidr.clone().unwrap()
                })
                .collect::<Vec<_>>()
        );
        assert_eq!(config.rule[0].ip, reversed);
        optimize_ips(&mut config, &path).unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), saved);
        std::fs::remove_file(path).unwrap();
        std::fs::remove_dir(dir).unwrap();
    }
}
