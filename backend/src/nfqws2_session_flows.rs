use std::net::Ipv4Addr;

#[derive(Clone, Debug)]
pub(crate) struct Flow {
    pub key: String, pub protocol: String, pub remote: String, pub port: u16,
    pub tx: Option<u64>, pub rx: Option<u64>, pub replied: bool,
}

pub(crate) fn parse(line: &str, device: &str) -> Option<Flow> {
    if !line.contains(&format!("src={device} ")) { return None }
    let parts: Vec<_> = line.split_whitespace().collect();
    let protocol = if parts.contains(&"udp") { "UDP" } else if parts.contains(&"tcp") { "TCP" } else { return None };
    let values = |prefix: &str| parts.iter().filter_map(|part| part.strip_prefix(prefix)).collect::<Vec<_>>();
    if values("src=").first().copied() != Some(device) { return None }
    let destinations = values("dst=");
    let remote = destinations.first()?.parse::<Ipv4Addr>().ok()?;
    if remote.is_private() || remote.is_loopback() || remote.is_multicast() || remote.is_broadcast() || remote.is_unspecified() { return None }
    let dports = values("dport=");
    let port = dports.first()?.parse::<u16>().ok()?;
    if protocol == "UDP" {
        if port < 1024 || [1900, 5353, 5355].contains(&port) { return None }
    } else if ![2053, 2083, 2087, 2096, 8443].contains(&port) { return None }
    let counters = values("packets=");
    let tx = counters.first().and_then(|value| value.parse().ok());
    let rx = counters.get(1).and_then(|value| value.parse().ok());
    let replied = if protocol == "UDP" { !parts.contains(&"[UNREPLIED]") } else { parts.contains(&"ESTABLISHED") || parts.contains(&"[ASSURED]") };
    let sports = values("sport=");
    let sport = sports.first()?;
    sport.parse::<u16>().ok()?;
    Some(Flow { key: format!("{protocol}:{sport}:{remote}:{port}"), protocol: protocol.into(), remote: remote.to_string(), port, tx, rx, replied })
}

pub(crate) struct Activity { pub tx: Option<u64>, pub rx: Option<u64>, pub replied: bool, pub active: bool }
pub(crate) fn activity(flow: &Flow, baseline: Option<&Flow>) -> Activity {
    let tx = flow.tx.zip(baseline.and_then(|old| old.tx)).map(|(now, before)| now.saturating_sub(before)).or(if baseline.is_none() { flow.tx } else { None });
    let rx = flow.rx.zip(baseline.and_then(|old| old.rx)).map(|(now, before)| now.saturating_sub(before)).or(if baseline.is_none() { flow.rx } else { None });
    let replied = rx.is_some_and(|value| value > 0) || (flow.rx.is_none() && flow.replied && baseline.is_none_or(|old| !old.replied));
    Activity { tx, rx, replied, active: baseline.is_none() || tx.is_some_and(|value| value > 0) || replied }
}

pub(crate) fn expired(elapsed_seconds: u64) -> bool { elapsed_seconds >= 90 }
pub(crate) fn same_strategy(previous: &str, current: &str) -> bool { previous == current }

#[cfg(test)]
mod tests {
    use super::*;
    const DEVICE: &str = "192.168.0.130";
    fn udp(extra: &str) -> String { format!("ipv4 2 udp 17 100 src={DEVICE} dst=203.0.113.42 sport=12345 dport=50000 {extra} src=203.0.113.42 dst={DEVICE} sport=50000 dport=12345") }
    #[test] fn unanswered_udp() { let f = parse(&udp("[UNREPLIED]"), DEVICE).unwrap(); assert!(!f.replied); assert_eq!(f.port, 50000); }
    #[test] fn replied_udp() { assert!(parse(&udp("[ASSURED]"), DEVICE).unwrap().replied); }
    #[test] fn ignores_other_device_and_reply_tuple() { assert!(parse(&udp(""), "192.168.0.13").is_none()); assert!(parse(&udp(""), "203.0.113.42").is_none()); }
    #[test] fn filters_lan_and_discovery() { assert!(parse(&udp("").replace("203.0.113.42", "192.168.0.1"), DEVICE).is_none()); assert!(parse(&udp("").replace("dport=50000", "dport=5353"), DEVICE).is_none()); }
    #[test] fn tcp_and_malformed_rows() { assert!(parse("garbage", DEVICE).is_none()); let s=udp("").replace("udp 17", "tcp 6 ESTABLISHED").replace("dport=50000", "dport=8443"); assert!(parse(&s, DEVICE).unwrap().replied); assert!(parse(&s.replace("dport=8443", "dport=443"), DEVICE).is_none()); }
    #[test] fn packet_counters_use_both_directions() { let s=format!("ipv4 2 udp 17 30 src={DEVICE} dst=203.0.113.42 sport=5 dport=50000 packets=8 bytes=400 src=203.0.113.42 dst={DEVICE} sport=50000 dport=5 packets=3 bytes=90 [ASSURED]"); let f=parse(&s, DEVICE).unwrap(); assert_eq!((f.tx,f.rx),(Some(8),Some(3))); }
    #[test] fn old_replied_connection_is_not_new_success() { let f=parse(&udp("[ASSURED]"),DEVICE).unwrap(); let a=activity(&f,Some(&f)); assert!(!a.active); assert!(!a.replied); }
    #[test] fn newly_replied_connection_is_observed() { let old=parse(&udp("[UNREPLIED]"),DEVICE).unwrap(); let new=parse(&udp("[ASSURED]"),DEVICE).unwrap(); let a=activity(&new,Some(&old)); assert!(a.active && a.replied); }
    #[test] fn tx_only_does_not_claim_reply() { let mut old=parse(&udp("[ASSURED]"),DEVICE).unwrap(); old.tx=Some(20);old.rx=Some(10);let mut new=old.clone();new.tx=Some(25);let a=activity(&new,Some(&old));assert!(a.active);assert!(!a.replied);assert_eq!(a.tx,Some(5));assert_eq!(a.rx,Some(0)); }
    #[test] fn new_rx_and_reset_counters() { let mut old=parse(&udp(""),DEVICE).unwrap();old.tx=Some(20);old.rx=Some(10);let mut new=old.clone();new.rx=Some(12);assert!(activity(&new,Some(&old)).replied);new.tx=Some(1);new.rx=Some(0);let a=activity(&new,Some(&old));assert_eq!((a.tx,a.rx),(Some(0),Some(0)));assert!(!a.replied); }
    #[test] fn new_flow_and_stable_keys() { let old=parse(&udp("[ASSURED]"),DEVICE).unwrap();assert!(activity(&old,None).replied);let other=parse(&udp("").replace("sport=12345", "sport=12346"),DEVICE).unwrap();assert_ne!(old.key,other.key); }
    #[test] fn timeout_and_strategy_invalidation() { assert!(!expired(89));assert!(expired(90));assert!(same_strategy("a","a"));assert!(!same_strategy("a","b")); }
}
