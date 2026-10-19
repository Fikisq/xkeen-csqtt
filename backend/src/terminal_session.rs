use axum::extract::ws::{Message, WebSocket};
use nix::{libc, pty::{openpty, Winsize}};
use std::{collections::VecDeque, io::{self, Read, Write}, os::fd::AsRawFd, process::Stdio, sync::{Arc, LazyLock, atomic::{AtomicBool, Ordering}}, time::Duration};
use tokio::{io::unix::AsyncFd, process::{Child, Command}, sync::{Mutex, broadcast, mpsc}};

type Error = Box<dyn std::error::Error + Send + Sync>;
const HISTORY_BYTES: usize = 128 * 1024;
static SESSION: LazyLock<Mutex<Option<Arc<Session>>>> = LazyLock::new(|| Mutex::new(None));

#[derive(Clone)]
enum Event { Data(Vec<u8>), Clear, Exit }
enum Input { Bytes(Vec<u8>), Resize(u16, u16), Manage(String, String), Clear }
struct Session {
    history: Mutex<VecDeque<u8>>,
    events: broadcast::Sender<Event>,
    input: mpsc::Sender<Input>,
    finished: AtomicBool,
}

async fn snapshot(session: &Session) -> (Vec<u8>, broadcast::Receiver<Event>) {
    // The producer broadcasts while holding this same lock: no gap or duplicate
    // between the replay and the first live message after a reconnect.
    let history = session.history.lock().await;
    let receiver = session.events.subscribe();
    (history.iter().copied().collect(), receiver)
}

async fn current() -> Result<Arc<Session>, Error> {
    let mut slot = SESSION.lock().await;
    if let Some(session) = slot.as_ref().filter(|session| !session.finished.load(Ordering::Acquire)) { return Ok(session.clone()); }
    let size = Winsize { ws_row: 28, ws_col: 100, ws_xpixel: 0, ws_ypixel: 0 };
    let pty = openpty(&size, None)?;
    let master = std::fs::File::from(pty.master);
    let fd = master.as_raw_fd();
    unsafe {
        let flags = libc::fcntl(fd, libc::F_GETFL);
        if flags < 0 || libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) < 0
            || libc::fcntl(fd, libc::F_SETFD, libc::FD_CLOEXEC) < 0
            || libc::fcntl(pty.slave.as_raw_fd(), libc::F_SETFD, libc::FD_CLOEXEC) < 0 { return Err(io::Error::last_os_error().into()); }
    }
    let slave = std::fs::File::from(pty.slave);
    let shell = ["/opt/bin/bash", "/opt/bin/ash", "/bin/ash", "/bin/sh"].into_iter().find(|path| std::path::Path::new(path).exists()).unwrap_or("/bin/sh");
    let mut command = Command::new(shell);
    command.arg("-i").current_dir("/opt").env_clear()
        .env("PATH", "/opt/sbin:/opt/bin:/usr/sbin:/usr/bin:/sbin:/bin")
        .env("HOME", "/opt/root").env("TERM", "xterm-256color").env("LANG", "C.UTF-8")
        .env("PS1", "\\[\\033[1;32m\\]root@Entware\\[\\033[0m\\]:\\[\\033[1;34m\\]\\w\\[\\033[0m\\] # ")
        .env("CLICOLOR", "1")
        .stdin(Stdio::from(slave.try_clone()?)).stdout(Stdio::from(slave.try_clone()?)).stderr(Stdio::from(slave))
        .kill_on_drop(true);
    unsafe { command.pre_exec(|| {
        if libc::setsid() < 0 || libc::ioctl(0, libc::TIOCSCTTY, 0) < 0 { return Err(io::Error::last_os_error()); }
        Ok(())
    }); }
    let child = command.spawn()?;
    let master = AsyncFd::new(master)?;
    let (events, _) = broadcast::channel(32);
    let (input, receiver) = mpsc::channel(32);
    let session = Arc::new(Session { history: Mutex::new(VecDeque::with_capacity(HISTORY_BYTES)), events, input, finished: AtomicBool::new(false) });
    *slot = Some(session.clone());
    tokio::spawn(actor(session.clone(), master, child, receiver));
    Ok(session)
}

async fn read_pty(pty: &AsyncFd<std::fs::File>, buffer: &mut [u8]) -> io::Result<usize> {
    loop {
        let mut ready = pty.readable().await?;
        match ready.try_io(|fd| (&*fd.get_ref()).read(buffer)) { Ok(result) => return result, Err(_) => continue }
    }
}
async fn write_pty(pty: &AsyncFd<std::fs::File>, mut bytes: &[u8]) -> io::Result<()> {
    while !bytes.is_empty() {
        let mut ready = pty.writable().await?;
        match ready.try_io(|fd| (&*fd.get_ref()).write(bytes)) {
            Ok(Ok(0)) => return Err(io::ErrorKind::WriteZero.into()),
            Ok(Ok(count)) => bytes = &bytes[count..],
            Ok(Err(error)) => return Err(error),
            Err(_) => continue,
        }
    }
    Ok(())
}
async fn emit(session: &Session, data: Vec<u8>) {
    let mut history = session.history.lock().await;
    if history.len() + data.len() > HISTORY_BYTES {
        let mut remove = history.len() + data.len() - HISTORY_BYTES;
        if let Some(end) = history.iter().skip(remove).position(|byte| *byte == b'\n') { remove += end + 1; }
        else { while history.get(remove).is_some_and(|byte| byte & 0xc0 == 0x80) { remove += 1; } }
        history.drain(..remove);
    }
    history.extend(data.iter().copied());
    let _ = session.events.send(Event::Data(data));
}

async fn input_loop(session: Arc<Session>, master: Arc<AsyncFd<std::fs::File>>, pid: i32, mut input: mpsc::Receiver<Input>) -> Result<(), ()> {
    let fd = master.get_ref().as_raw_fd();
    while let Some(request) = input.recv().await {
        let bytes = match request {
            Input::Bytes(bytes) => bytes,
            Input::Resize(rows, cols) => {
                let size = Winsize { ws_row: rows, ws_col: cols, ws_xpixel: 0, ws_ypixel: 0 };
                unsafe { libc::ioctl(fd, libc::TIOCSWINSZ, &size); }
                continue;
            },
            Input::Clear => {
                { let mut history = session.history.lock().await; history.clear(); let _ = session.events.send(Event::Clear); }
                if unsafe { libc::tcgetpgrp(fd) } != pid { continue; }
                vec![12]
            },
            Input::Manage(action, component) => {
                if unsafe { libc::tcgetpgrp(fd) } != pid {
                    emit(&session, "\r\n\x1b[33mКонсоль занята. Сначала завершите текущую команду: «Прервать» или Ctrl+C.\x1b[0m\r\n".as_bytes().to_vec()).await;
                    continue;
                }
                if matches!(action.as_str(), "status" | "update") { format!("\x15xkeen-manager {action}\r").into_bytes() }
                else { format!("\x15xkeen-manager {action} {component}\r").into_bytes() }
            },
        };
        if !matches!(tokio::time::timeout(Duration::from_secs(10), write_pty(&master, &bytes)).await, Ok(Ok(()))) { return Err(()); }
    }
    Ok(())
}

async fn actor(session: Arc<Session>, master: AsyncFd<std::fs::File>, mut child: Child, input: mpsc::Receiver<Input>) {
    let pid = child.id().unwrap_or(0) as i32;
    let master = Arc::new(master);
    let writer_session = session.clone();
    let writer_master = master.clone();
    // Input and output progress independently: a large paste cannot block the
    // reader from draining PTY echo and create a full-duplex buffer deadlock.
    let writer = tokio::spawn(async move {
        if input_loop(writer_session, writer_master, pid, input).await.is_err() && pid > 0 {
            unsafe { libc::kill(-pid, libc::SIGHUP); }
        }
    });
    let mut buffer = [0u8; 4096];
    loop {
        let count = match read_pty(&master, &mut buffer).await { Ok(0) | Err(_) => break, Ok(count) => count };
        emit(&session, buffer[..count].to_vec()).await;
    }
    writer.abort();
    if pid > 0 { unsafe { libc::kill(-pid, libc::SIGHUP); } }
    let _ = child.start_kill();
    let _ = tokio::time::timeout(Duration::from_secs(3), child.wait()).await;
    session.finished.store(true, Ordering::Release);
    let _ = session.events.send(Event::Exit);
}

async fn send(socket: &mut WebSocket, message: Message) -> Result<(), Error> {
    tokio::time::timeout(Duration::from_secs(10), socket.send(message)).await??;
    Ok(())
}

pub async fn run(socket: &mut WebSocket) -> Result<(), Error> {
    let session = current().await?;
    let (history, mut receiver) = snapshot(&session).await;
    if !history.is_empty() { send(socket, Message::Binary(history.into())).await?; }
    if session.finished.load(Ordering::Acquire) { return Ok(()); }
    loop {
        tokio::select! {
            event = receiver.recv() => match event {
                Ok(Event::Data(bytes)) => send(socket, Message::Binary(bytes.into())).await?,
                Ok(Event::Clear) => send(socket, Message::Text("{\"type\":\"clear\"}".into())).await?,
                Ok(Event::Exit) | Err(broadcast::error::RecvError::Closed) => break,
                Err(broadcast::error::RecvError::Lagged(_)) => {
                    let (history, next) = snapshot(&session).await;
                    receiver = next;
                    send(socket, Message::Text("{\"type\":\"clear\"}".into())).await?;
                    send(socket, Message::Binary(history.into())).await?;
                },
            },
            message = socket.recv() => {
                let value = match message {
                    Some(Ok(Message::Text(text))) => match serde_json::from_str::<serde_json::Value>(&text) { Ok(value) => value, Err(_) => continue },
                    None | Some(Err(_)) | Some(Ok(Message::Close(_))) => break,
                    _ => continue,
                };
                let input = match value["type"].as_str() {
                    Some("input") => match value["data"].as_str() { Some(data) => Input::Bytes(data.as_bytes().to_vec()), None => continue },
                    Some("clear") => Input::Clear,
                    Some("resize") => Input::Resize(value["rows"].as_u64().unwrap_or(28).clamp(2, 200) as u16, value["cols"].as_u64().unwrap_or(100).clamp(10, 400) as u16),
                    Some("manage") => {
                        let action = value["action"].as_str().unwrap_or("");
                        let component = value["component"].as_str().unwrap_or("panel");
                        if !matches!(action, "status" | "start" | "stop" | "restart" | "log" | "update")
                            || !matches!(component, "panel" | "xray" | "csqtt" | "wdtt-plus" | "nfqws2") { continue; }
                        Input::Manage(action.into(), component.into())
                    },
                    _ => continue,
                };
                if session.input.send(input).await.is_err() { break; }
            }
        }
    }
    // Only the WebSocket detaches. The PTY actor, shell and bounded history live on.
    Ok(())
}
