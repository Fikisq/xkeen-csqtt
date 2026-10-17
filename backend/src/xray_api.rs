//! Persistent native gRPC/HTTP2 connection. No helper process or tmpfs binary.
use crate::{xray_routing_codec, xray_wire};
use prost::{Message, bytes::Bytes};
use serde_json::{Value, json};
use std::{
    sync::OnceLock,
    time::{Duration, Instant},
};
use tokio::{net::TcpStream, sync::Mutex, task::JoinHandle};
struct Connection {
    sender: h2::client::SendRequest<Bytes>,
    driver: JoinHandle<()>,
}
impl Drop for Connection {
    fn drop(&mut self) {
        self.driver.abort();
    }
}
static CLIENT: OnceLock<Mutex<Option<Connection>>> = OnceLock::new();
static LAST: OnceLock<std::sync::Mutex<Value>> = OnceLock::new();
#[cfg(not(test))]
const ENDPOINT: &str = "127.0.0.1:18085";
#[cfg(test)]
const ENDPOINT: &str = "127.0.0.1:18086";
fn status(headers: &http::HeaderMap) -> Result<bool, String> {
    let Some(code) = headers.get("grpc-status") else {
        return Ok(false);
    };
    if code != "0" {
        let text = headers
            .get("grpc-message")
            .and_then(|h| h.to_str().ok())
            .unwrap_or("Ошибка Xray API");
        let text = urlencoding::decode(text)
            .map(|v| v.into_owned())
            .unwrap_or_else(|_| text.to_owned());
        return Err(format!(
            "Xray API ({}): {}",
            code.to_str().unwrap_or("?"),
            text.chars().take(500).collect::<String>()
        ));
    }
    Ok(true)
}
async fn rpc(method: &str, message: Vec<u8>) -> Result<(), String> {
    let mut guard = CLIENT.get_or_init(|| Mutex::new(None)).lock().await;
    let result = tokio::time::timeout(Duration::from_secs(18), async {
        if guard.as_ref().is_some_and(|c| c.driver.is_finished()) {
            *guard = None;
        }
        if guard.is_none() {
            let socket = TcpStream::connect(ENDPOINT).await.map_err(|e| e.to_string())?;
            socket.set_nodelay(true).map_err(|e| e.to_string())?;
            let (sender, connection) = h2::client::handshake(socket).await.map_err(|e| e.to_string())?;
            let driver = tokio::spawn(async move {
                let _ = connection.await;
            });
            *guard = Some(Connection { sender, driver });
        }
        let connection = guard.as_mut().unwrap();
        let mut sender = connection.sender.clone().ready().await.map_err(|e| e.to_string())?;
        let request = http::Request::post(format!(
            "http://{ENDPOINT}/xray.app.router.command.RoutingService/{method}"
        ))
        .version(http::Version::HTTP_2)
        .header("content-type", "application/grpc")
        .header("te", "trailers")
        .header("grpc-timeout", "12S")
        .body(())
        .map_err(|e| e.to_string())?;
        let (response, mut stream) = sender.send_request(request, false).map_err(|e| e.to_string())?;
        let mut framed = Vec::with_capacity(message.len() + 5);
        framed.push(0);
        framed.extend_from_slice(&(message.len() as u32).to_be_bytes());
        framed.extend(message);
        let mut remaining = Bytes::from(framed);
        while !remaining.is_empty() {
            stream.reserve_capacity(remaining.len());
            let capacity = std::future::poll_fn(|cx| stream.poll_capacity(cx))
                .await
                .ok_or("Xray закрыл поток API")?
                .map_err(|e| e.to_string())?;
            if capacity == 0 {
                continue;
            }
            let chunk = remaining.split_to(capacity.min(remaining.len()));
            stream
                .send_data(chunk, remaining.is_empty())
                .map_err(|e| e.to_string())?;
        }
        let response = response.await.map_err(|e| e.to_string())?;
        if response.status() != http::StatusCode::OK {
            return Err(format!("Xray API HTTP {}", response.status()));
        }
        let mut complete = status(response.headers())?;
        let mut body = response.into_body();
        let mut bytes = Vec::new();
        while let Some(chunk) = body.data().await {
            let chunk = chunk.map_err(|e| e.to_string())?;
            body.flow_control()
                .release_capacity(chunk.len())
                .map_err(|e| e.to_string())?;
            if bytes.len() + chunk.len() > 1024 * 1024 {
                return Err("Слишком большой ответ Xray API".into());
            }
            bytes.extend_from_slice(&chunk);
        }
        if let Some(trailers) = body.trailers().await.map_err(|e| e.to_string())? {
            complete |= status(&trailers)?;
        }
        if !complete {
            return Err("Xray API не вернул статус gRPC".into());
        }
        // Both methods return one empty protobuf. Reject malformed framing.
        if bytes.as_slice() != [0, 0, 0, 0, 0] {
            return Err("Некорректный ответ Xray API".into());
        }
        Ok(())
    })
    .await;
    match result {
        Ok(Ok(())) => Ok(()),
        Ok(Err(e)) => {
            *guard = None;
            Err(e)
        }
        Err(_) => {
            *guard = None;
            Err("Тайм-аут Xray API".into())
        }
    }
}
pub(crate) async fn apply_routing(routing: &Value, _assets_version: &Value) -> Result<(), String> {
    let started = Instant::now();
    let routing = routing.clone();
    let config = tokio::task::spawn_blocking(move || {
        let mut config = xray_routing_codec::build(&routing)?;
        xray_routing_codec::optimize_ips(
            &mut config,
            std::path::Path::new("/opt/etc/xray/dat/.xkeen-ui-source-cache.dat"),
        )?;
        Ok::<_, String>(config.encode_to_vec())
    })
    .await
    .map_err(|e| e.to_string())??;
    let build_ms = started.elapsed().as_millis();
    let request = xray_wire::AddRule {
        config: Some(xray_wire::TypedMessage {
            r#type: "xray.app.router.Config".into(),
            value: config,
        }),
        should_append: false,
    };
    let rpc_started = Instant::now();
    let result = rpc("AddRule", request.encode_to_vec()).await;
    *LAST.get_or_init(|| std::sync::Mutex::new(Value::Null)).lock().unwrap() = json!({"success":result.is_ok(),"operation":"routing","buildMs":build_ms,"rpcMs":rpc_started.elapsed().as_millis(),"elapsedMs":started.elapsed().as_millis()});
    result
}
pub(crate) async fn override_target(balancer: &str, target: &str) -> Result<(), String> {
    let started = Instant::now();
    let request = xray_wire::Override {
        balancer_tag: balancer.into(),
        target: target.into(),
    };
    let result = rpc("OverrideBalancerTarget", request.encode_to_vec()).await;
    *LAST.get_or_init(|| std::sync::Mutex::new(Value::Null)).lock().unwrap() =
        json!({"success":result.is_ok(),"operation":"override","elapsedMs":started.elapsed().as_millis()});
    result
}
pub(crate) fn last_routing_timings() -> Value {
    LAST.get_or_init(|| std::sync::Mutex::new(Value::Null))
        .lock()
        .unwrap()
        .clone()
}
#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn validates_grpc_and_reconnects_after_errors() {
        let listener = tokio::net::TcpListener::bind(ENDPOINT).await.unwrap();
        let server = tokio::spawn(async move {
            loop {
                let (socket, _) = listener.accept().await.unwrap();
                tokio::spawn(async move {
                    let mut connection = h2::server::handshake(socket).await.unwrap();
                    while let Some(request) = connection.accept().await {
                        let (request, mut respond) = request.unwrap();
                        tokio::spawn(async move {
                            let method = request.uri().path().rsplit('/').next().unwrap().to_owned();
                            let mut body = request.into_body();
                            let mut received = 0;
                            while let Some(chunk) = body.data().await {
                                let chunk = chunk.unwrap();
                                received += chunk.len();
                                body.flow_control().release_capacity(chunk.len()).unwrap();
                            }
                            if method == "Large" {
                                assert_eq!(received, 1024 * 1024 + 5);
                            }
                            let response = http::Response::builder()
                                .status(if method == "HttpError" { 503 } else { 200 })
                                .header("content-type", "application/grpc")
                                .body(())
                                .unwrap();
                            let mut stream = respond.send_response(response, false).unwrap();
                            stream
                                .send_data(
                                    Bytes::from_static(if method == "Truncated" {
                                        &[0, 0, 0]
                                    } else {
                                        &[0, 0, 0, 0, 0]
                                    }),
                                    false,
                                )
                                .unwrap();
                            let mut trailers = http::HeaderMap::new();
                            if method != "MissingStatus" {
                                trailers.insert(
                                    "grpc-status",
                                    if method == "Rejected" { "3" } else { "0" }.parse().unwrap(),
                                );
                            }
                            trailers.insert("grpc-message", "invalid%20rule".parse().unwrap());
                            stream.send_trailers(trailers).unwrap();
                        });
                    }
                });
            }
        });
        rpc("Large", vec![0; 1024 * 1024]).await.unwrap();
        rpc("OverrideBalancerTarget", vec![]).await.unwrap();
        assert!(rpc("Rejected", vec![]).await.unwrap_err().contains("invalid rule"));
        rpc("OverrideBalancerTarget", vec![]).await.unwrap();
        assert!(rpc("MissingStatus", vec![]).await.unwrap_err().contains("статус"));
        assert!(rpc("Truncated", vec![]).await.unwrap_err().contains("ответ"));
        assert!(rpc("HttpError", vec![]).await.unwrap_err().contains("503"));
        rpc("OverrideBalancerTarget", vec![]).await.unwrap();
        *CLIENT.get().unwrap().lock().await = None;
        server.abort();
    }
}
