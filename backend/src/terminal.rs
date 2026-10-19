use axum::{extract::ws::{Message, WebSocket, WebSocketUpgrade}, http::{HeaderMap, StatusCode}, response::{IntoResponse, Response}};
use futures_util::SinkExt;
use std::{sync::atomic::{AtomicBool, Ordering}, time::Duration};

static OPEN: AtomicBool = AtomicBool::new(false);
struct Slot;
impl Drop for Slot { fn drop(&mut self) { OPEN.store(false, Ordering::Release); } }

// The normal panel authentication middleware also protects this endpoint.
// Reject cross-origin WebSocket handshakes, including when panel auth is off.
pub async fn connect(headers: HeaderMap, ws: WebSocketUpgrade) -> Response {
    let origin = headers.get("origin").and_then(|v| v.to_str().ok()).and_then(|v| reqwest::Url::parse(v).ok());
    let host = headers.get("host").and_then(|v| v.to_str().ok());
    let valid = origin.as_ref().is_some_and(|url| {
        matches!(url.scheme(), "http" | "https") && url.host_str().is_some()
            && host.is_some_and(|host| url.origin().ascii_serialization().split_once("://").is_some_and(|(_, authority)| authority.eq_ignore_ascii_case(host)))
    });
    if !valid { return StatusCode::FORBIDDEN.into_response(); }
    if OPEN.compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire).is_err() {
        return (StatusCode::CONFLICT, "Терминал уже открыт в другой вкладке").into_response();
    }
    let slot = Slot;
    ws.max_message_size(16 * 1024).max_frame_size(16 * 1024)
        .on_upgrade(move |socket| async move { let _slot = slot; session(socket).await; }).into_response()
}

async fn session(mut socket: WebSocket) {
    if let Err(error) = crate::terminal_session::run(&mut socket).await {
        let _ = tokio::time::timeout(Duration::from_secs(3), socket.send(Message::Text(format!("\r\n\x1b[31mКонсоль: {error}\x1b[0m\r\n").into()))).await;
    }
    let _ = tokio::time::timeout(Duration::from_secs(3), socket.close()).await;
}
