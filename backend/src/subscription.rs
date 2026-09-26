use axum::response::Json;
use serde::Deserialize;
use serde_json::json;
use std::net::{IpAddr, SocketAddr};
use std::time::Duration;

const MAX_SUBSCRIPTION_BYTES: usize = 256 * 1024;

fn is_public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => {
            let octets = ip.octets();
            !ip.is_private() && !ip.is_loopback() && !ip.is_link_local()
                && !ip.is_multicast() && !ip.is_unspecified() && !ip.is_broadcast()
                && octets[0] != 0 && octets[0] < 224
                && !(octets[0] == 100 && (64..=127).contains(&octets[1]))
                && !(octets[0] == 198 && (octets[1] == 18 || octets[1] == 19))
        }
        IpAddr::V6(ip) => {
            !ip.is_loopback() && !ip.is_unique_local() && !ip.is_unicast_link_local()
                && !ip.is_multicast() && !ip.is_unspecified()
        }
    }
}

fn is_lan_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => ip.is_private() && !ip.is_loopback() && !ip.is_link_local(),
        IpAddr::V6(ip) => ip.is_unique_local(),
    }
}

// BusyBox resolves A records independently. This is a bounded fallback for
// libc resolvers that reject a valid A answer when the paired AAAA query fails.
async fn resolve_addresses(host: &str, port: u16) -> Vec<SocketAddr> {
    if let Ok(Ok(addresses)) = tokio::time::timeout(Duration::from_secs(5), tokio::net::lookup_host((host, port))).await {
        let addresses: Vec<_> = addresses.collect();
        if !addresses.is_empty() { return addresses; }
    }
    let mut command = tokio::process::Command::new("/opt/bin/nslookup");
    command.arg(host).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::null()).kill_on_drop(true);
    let Ok(Ok(output)) = tokio::time::timeout(Duration::from_secs(5), command.output()).await else { return Vec::new(); };
    let text = String::from_utf8_lossy(&output.stdout);
    let Some((_, answers)) = text.split_once("Name:") else { return Vec::new(); };
    answers.lines().filter(|line| line.trim_start().starts_with("Address"))
        .filter_map(|line| line.split_whitespace().find_map(|word| word.parse::<IpAddr>().ok()))
        .map(|ip| SocketAddr::new(ip, port)).collect()
}

#[derive(Deserialize)]
pub struct SubscriptionRequest {
    pub(crate) url: String,
    #[serde(default)]
    pub(crate) allow_lan: bool,
}

pub async fn preview_subscription(Json(req): Json<SubscriptionRequest>) -> Json<serde_json::Value> {
    download_subscription(req, "v2rayN/7.24.8").await
}
pub(crate) async fn download_subscription(req: SubscriptionRequest, agent: &str) -> Json<serde_json::Value> {
    if req.url.len() > 2048 {
        return Json(json!({ "success": false, "error": "Ссылка подписки слишком длинная" }));
    }
    let url = match reqwest::Url::parse(req.url.trim()) {
        Ok(url)
            if url.scheme() == "https"
                && url.username().is_empty()
                && url.password().is_none()
                && url.host_str().is_some_and(|host| {
                    host.contains('.') && host.parse::<std::net::IpAddr>().is_err()
                        && !host.ends_with(".local") && !host.ends_with(".internal")
                }) => url,
        _ => return Json(json!({ "success": false, "error": "Нужна HTTPS-ссылка с публичным доменным именем" })),
    };

    let host = url.host_str().unwrap();
    let port = url.port_or_known_default().unwrap_or(443);
    let resolved = resolve_addresses(host, port).await;
    if resolved.is_empty() {
        return Json(json!({ "success": false, "error": "Не удалось определить адрес подписки через DNS роутера" }));
    }
    // Some DNS servers return both public and private answers. Pin the request
    // to a public answer instead of rejecting the whole subscription.
    let public = resolved.iter()
        .filter(|address| is_public_ip(address.ip()))
        .find(|address| address.is_ipv4())
        .or_else(|| resolved.iter().find(|address| is_public_ip(address.ip())));
    let lan = resolved.iter()
        .filter(|address| is_lan_ip(address.ip()))
        .find(|address| address.is_ipv4())
        .or_else(|| resolved.iter().find(|address| is_lan_ip(address.ip())));
    let selected = if req.allow_lan { lan.or(public) } else { public };
    let Some(selected) = selected else {
        if lan.is_some() {
            return Json(json!({ "success": false, "requiresLanAccess": true, "error": "Домен подписки ведёт на локальный сервер. Разрешите локальную сеть и повторите загрузку" }));
        }
        return Json(json!({ "success": false, "error": "Адрес подписки недоступен для безопасной загрузки" }));
    };

    let client = match reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(15))
        .resolve(host, SocketAddr::new(selected.ip(), port))
        .build()
    {
        Ok(client) => client,
        Err(_) => return Json(json!({ "success": false, "error": "Не удалось подготовить загрузку" })),
    };
    let mut response = match client.get(url).header("User-Agent", agent).send().await {
        Ok(response) if response.status().is_success() => response,
        Ok(response) => return Json(json!({ "success": false, "error": format!("Сервер подписки вернул HTTP {}", response.status()) })),
        Err(_) => return Json(json!({ "success": false, "error": "Не удалось загрузить подписку" })),
    };
    if response.content_length().is_some_and(|n| n > MAX_SUBSCRIPTION_BYTES as u64) {
        return Json(json!({ "success": false, "error": "Подписка превышает лимит 256 КБ" }));
    }
    let mut data = Vec::new();
    loop {
        match response.chunk().await {
            Ok(Some(chunk)) => {
                if data.len() + chunk.len() > MAX_SUBSCRIPTION_BYTES {
                    return Json(json!({ "success": false, "error": "Подписка превышает лимит 256 КБ" }));
                }
                data.extend_from_slice(&chunk);
            }
            Ok(None) => break,
            Err(_) => return Json(json!({ "success": false, "error": "Ошибка чтения подписки" })),
        }
    }
    let content = match String::from_utf8(data) {
        Ok(content) => content,
        Err(_) => return Json(json!({ "success": false, "error": "Подписка не является UTF-8 текстом" })),
    };
    Json(json!({ "success": true, "content": content }))
}
