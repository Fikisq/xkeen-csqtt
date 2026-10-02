use crate::logger::log;
use crate::types::*;
use axum::extract::State;
use axum::response::{IntoResponse, Json};
use nix::sys::resource::{Resource, setrlimit};
use nix::sys::signal::{Signal, kill};
use nix::unistd::{Gid, Pid, setgid, setsid};
use serde::Deserialize;
use std::path::Path;
use tokio::fs;
use tokio::process::Command;

#[derive(Deserialize)]
pub struct ControlReq {
    action: String,
    #[serde(default)]
    core: String,
}

pub fn find_init_file(log_enabled: bool) -> Option<String> {
    let (mut path, mut source) = (None, "fallback");

    if let Ok(content) = std::fs::read_to_string("/opt/sbin/.xkeen/01_info/01_info_variable.sh") {
        let (mut dir, mut file) = (None, None);
        for line in content.lines() {
            let clean = line.split('#').next().unwrap_or("").trim();
            if let Some(v) = clean.strip_prefix("initd_dir=") {
                dir = Some(v.trim_matches(&['"', '\''][..]));
            } else if let Some(v) = clean.strip_prefix("initd_file=") {
                file = Some(v.trim_matches(&['"', '\''][..]));
            }
        }
        if let (Some(d), Some(f)) = (dir, file) {
            path = Some(f.replace("$initd_dir", d));
            source = "var";
        }
    }

    let final_path = path.or_else(|| {
        [S99XKEEN, S24XRAY]
            .into_iter()
            .find(|p| Path::new(p).exists())
            .map(String::from)
    });

    if log_enabled {
        if let Some(p) = &final_path {
            println!("{} [INFO] Defined initd_file ({}): {}", crate::logger::ts(), source, p);
        }
    }

    final_path
}

async fn resolve_init_file(state: &AppState) -> Result<String, String> {
    if let Some(path) = state.init_file.read().unwrap().clone() {
        if Path::new(&path).exists() {
            return Ok(path);
        }
    }
    let new_path = tokio::task::spawn_blocking(|| find_init_file(false))
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "Не найден init файл XKeen".to_string())?;
    println!("{} [INFO] Updated initd_file: {}", crate::logger::ts(), new_path);
    *state.init_file.write().unwrap() = Some(new_path.clone());
    Ok(new_path)
}

pub async fn run_init_command(state: &AppState, args: &[&str]) -> Result<(), String> {
    let path = resolve_init_file(state).await?;
    let result = if let Ok(f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(error_log_path())
    {
        Command::new(&path)
            .args(args)
            .stdout(f.try_clone().unwrap())
            .stderr(f)
            .status()
            .await
    } else {
        Command::new(&path).args(args).status().await
    };
    match result {
        Ok(status) if status.success() => Ok(()),
        Ok(status) => Err(format!("{} завершился с ошибкой: {}", path, status)),
        Err(e) => {
            *state.init_file.write().unwrap() = None;
            Err(format!("{}: {}", path, e))
        }
    }
}

fn get_core_info(name: &str) -> CoreInfo {
    match name {
        "mihomo" => CoreInfo {
            name: "mihomo".into(),
            conf_dir: MIHOMO_CONF_DIR.into(),
            is_json: false,
        },
        _ => CoreInfo {
            name: "xray".into(),
            conf_dir: XRAY_CONF_DIR.into(),
            is_json: true,
        },
    }
}

pub fn get_pid(name: &str) -> Vec<i32> {
    let Ok(entries) = std::fs::read_dir("/proc") else {
        return vec![];
    };
    entries
        .filter_map(|entry| {
            let path = entry.ok()?.path();
            let pid = path.file_name()?.to_str()?.parse::<i32>().ok()?;
            let comm = std::fs::read_to_string(path.join("comm")).ok()?;
            (comm.trim_end_matches('\n') == name).then_some(pid)
        })
        .collect()
}

pub async fn soft_restart(core: &str) -> Result<(), String> {
    for pid in get_pid(core) {
        _ = kill(Pid::from_raw(pid), Signal::SIGKILL);
    }

    let mut cmd = Command::new(core);
    match core {
        "mihomo" => {
            cmd.env("CLASH_HOME_DIR", MIHOMO_CONF_DIR);
        }
        _ => {
            cmd.envs([("XRAY_LOCATION_CONFDIR", XRAY_CONF_DIR), ("XRAY_LOCATION_ASSET", XRAY_ASSET_DIR)]);
        }
    }

    let lim = if cfg!(target_arch = "aarch64") { 40000 } else { 10000 };
    unsafe {
        cmd.pre_exec(move || {
            setsid()?;
            setgid(Gid::from_raw(11111))?;
            setrlimit(Resource::RLIMIT_NOFILE, lim, lim)?;
            Ok(())
        });
    }

    if let Ok(f) = std::fs::File::options()
        .append(true)
        .create(true)
        .open(error_log_path())
    {
        cmd.stdout(f.try_clone().unwrap()).stderr(f);
    }

    let mut child = cmd.spawn().map_err(|e| e.to_string())?;
    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    match child.try_wait() {
        Ok(Some(status)) if !status.success() => {
            return Err(format!("Не удалось перезапустить {}: {}", core, status));
        }
        _ => {
            tokio::spawn(async move {
                _ = child.wait().await;
            });
        }
    }

    Ok(())
}

pub async fn get_control(State(state): State<AppState>) -> impl IntoResponse {
    let mut current_core = state.core.read().unwrap().clone();
    let core_name = current_core.name.clone();

    if tokio::task::spawn_blocking(move || get_pid(&core_name))
        .await
        .unwrap_or_default()
        .is_empty()
    {
        let alt_core = if current_core.name == "mihomo" {
            "xray"
        } else {
            "mihomo"
        };
        let alt_string = alt_core.to_string();

        current_core = if !tokio::task::spawn_blocking(move || get_pid(&alt_string))
            .await
            .unwrap_or_default()
            .is_empty()
        {
            get_core_info(alt_core)
        } else {
            let configuration = {
                let path = state.init_file.read().unwrap().clone();
                if let Some(p) = path {
                    tokio::fs::read_to_string(p).await.unwrap_or_default()
                } else {
                    String::new()
                }
            };
            get_core_info(if configuration.contains("name_client=\"mihomo\"") {
                "mihomo"
            } else {
                "xray"
            })
        };
        *state.core.write().unwrap() = current_core.clone();
    }

    let ((xray_exists, xray_running), (mihomo_exists, mihomo_running)) = tokio::join!(
        async {
            let exists = tokio::fs::metadata("/opt/sbin/xray").await.is_ok();
            let running = exists
                && tokio::task::spawn_blocking(|| !get_pid("xray").is_empty())
                    .await
                    .unwrap_or(false);
            (exists, running)
        },
        async {
            let exists = tokio::fs::metadata("/opt/sbin/mihomo").await.is_ok();
            let running = exists
                && tokio::task::spawn_blocking(|| !get_pid("mihomo").is_empty())
                    .await
                    .unwrap_or(false);
            (exists, running)
        }
    );

    let mut available_cores = Vec::new();
    if xray_exists {
        available_cores.push("xray".to_string());
    }
    if mihomo_exists {
        available_cores.push("mihomo".to_string());
    }
    let running_status = xray_running || mihomo_running;

    Json(
        serde_json::json!({ "success": true, "cores": available_cores, "currentCore": current_core.name, "running": running_status }),
    )
}

async fn check_core_config(core: &str) -> Result<(), String> {
    if core == "xray" {
        fs::create_dir_all(XRAY_CONF_DIR).await.map_err(|e| e.to_string())?;
        let has_json = std::fs::read_dir(XRAY_CONF_DIR)
            .map(|dir| {
                dir.flatten()
                    .any(|e| e.path().extension().map_or(false, |x| x == "json"))
            })
            .unwrap_or(false);
        if !has_json {
            return Err(
                "Не найдены конфигурационные файлы. Настройте их в /opt/etc/xray/configs перед запуском".into(),
            );
        }

        let mut has_proxy_outbound = false;
        let mut has_outbound_array = false;
        if let Ok(entries) = std::fs::read_dir(XRAY_CONF_DIR) {
            for entry in entries.flatten() {
                if entry.path().extension().is_none_or(|ext| ext != "json") { continue; }
                if let Ok(content) = std::fs::read_to_string(entry.path()) {
                    if let Ok(json) = serde_json::from_str::<serde_json::Value>(&content) {
                        if let Some(outbounds) = json.get("outbounds").and_then(|value| value.as_array()) {
                            has_outbound_array = true;
                            has_proxy_outbound |= outbounds.iter().any(|outbound| {
                                outbound.get("protocol").and_then(|value| value.as_str())
                                    .is_some_and(|protocol| !["freedom", "blackhole", "dns"].contains(&protocol))
                            });
                        }
                    }
                }
            }
        }
        if has_outbound_array && !has_proxy_outbound {
            return Err("В Xray пока нет прокси-узла. Импортируйте подписку перед переключением".into());
        }

        let output = Command::new("/opt/sbin/xray")
            .args(["-test", "-confdir", XRAY_CONF_DIR])
            .env("XRAY_LOCATION_ASSET", XRAY_ASSET_DIR)
            .output()
            .await
            .map_err(|e| format!("Не удалось проверить конфигурацию Xray: {}", e))?;
        if !output.status.success() {
            let mut details = String::from_utf8_lossy(&output.stdout).into_owned();
            details.push_str(&String::from_utf8_lossy(&output.stderr));
            log("ERROR", format!("Проверка конфигурации Xray: {}", details.trim()));
            return Err("Конфигурация Xray не прошла проверку. Смотрите журнал панели".into());
        }
    }
    Ok(())
}

// Serialize core control requests so two restarts cannot overlap.
static CONTROL_LOCK: std::sync::OnceLock<tokio::sync::Mutex<()>> = std::sync::OnceLock::new();

async fn repair_routing(state: &AppState, requested: &str) -> Result<(), String> {
    let core = state.core.read().unwrap().name.clone();
    if core != requested { return Err("Активное ядро изменилось. Обновите страницу".into()) }
    let binary = ["/opt/sbin/conntrack", "/opt/bin/conntrack"].into_iter()
        .find(|path| Path::new(path).is_file()).ok_or("Для очистки соединений требуется пакет conntrack")?;
    let init = fs::read_to_string(resolve_init_file(state).await?).await.map_err(|e| e.to_string())?;
    let mark = init.lines().find_map(|line| line.trim().strip_prefix("table_mark="))
        .map(|value| value.trim_matches(&['"', '\''][..]).to_string())
        .filter(|value| value.strip_prefix("0x").is_some_and(|hex| !hex.is_empty() && hex.bytes().all(|b| b.is_ascii_hexdigit()))
            || (!value.is_empty() && value.bytes().all(|b| b.is_ascii_digit())))
        .ok_or("Не удалось определить метку перехвата XKeen")?;
    let numeric_mark = if let Some(hex) = mark.strip_prefix("0x") { u32::from_str_radix(hex, 16).ok() } else { mark.parse::<u32>().ok() };
    if numeric_mark.is_none_or(|value| value == 0) { return Err("Недопустимая метка перехвата XKeen".into()) }
    let mut files = Vec::new();
    let mut ports = std::collections::BTreeSet::new();
    let directory = if core == "xray" { XRAY_CONF_DIR } else { MIHOMO_CONF_DIR };
    let mut entries = fs::read_dir(directory).await.map_err(|e| e.to_string())?;
    while let Some(entry) = entries.next_entry().await.map_err(|e| e.to_string())? {
        let path = entry.path();
        if (core == "xray" && path.extension().is_some_and(|ext| ext == "json"))
            || (core == "mihomo" && path.file_name().is_some_and(|name| name == "config.yaml")) {
            let content = fs::read_to_string(&path).await.map_err(|e| e.to_string())?;
            if core == "xray" {
                let config: serde_json::Value = serde_json::from_str(&content).map_err(|e| e.to_string())?;
                if let Some(inbounds) = config.get("inbounds").and_then(serde_json::Value::as_array) {
                    for inbound in inbounds {
                        if inbound.get("protocol").and_then(serde_json::Value::as_str) == Some("dokodemo-door")
                            && inbound.pointer("/settings/followRedirect").and_then(serde_json::Value::as_bool) == Some(true) {
                            if let Some(port) = inbound.get("port").and_then(serde_json::Value::as_u64).filter(|port| *port > 0 && *port <= 65535) { ports.insert(port.to_string()); }
                        }
                    }
                }
            } else {
                let documents = yaml_rust2::YamlLoader::load_from_str(&content).map_err(|e| e.to_string())?;
                let config = documents.first().ok_or("Пустая конфигурация Mihomo")?;
                for key in ["redir-port", "tproxy-port"] {
                    if let Some(port) = config[key].as_i64().filter(|port| *port > 0 && *port <= 65535) { ports.insert(port.to_string()); }
                }
            }
            files.push(crate::configs::ConfigReq { file: path.to_string_lossy().into(), content });
        }
    }
    if files.is_empty() { return Err("Не найдена сохранённая конфигурация ядра".into()) }
    crate::configs::validate_core(&core, &files).await.map_err(|_| "Проверка конфигурации не пройдена. Перезапуск отменён".to_string())?;
    let stopped = run_init_command(state, &["stop"]).await;
    let mut cleanup_error = stopped.err();
    if cleanup_error.is_none() {
        for family in ["ipv4", "ipv6"] {
            let mut filters = vec![vec!["--mark".to_string(), mark.clone()]];
            for port in &ports { filters.push(vec!["-p".into(), "tcp".into(), "--dst-nat".into(), "--reply-port-src".into(), port.clone()]); }
            for filter in filters {
                let result = tokio::time::timeout(std::time::Duration::from_secs(5), Command::new(binary)
                    .args(["-D", "-f", family]).args(filter).kill_on_drop(true).output()).await;
                match result {
                    Ok(Ok(output)) if output.status.success() || String::from_utf8_lossy(&output.stderr).contains("0 flow entries") => {},
                    _ => { cleanup_error = Some("Не удалось полностью очистить соединения перехвата".into()); }
                }
            }
        }
    }
    // Always attempt to bring the saved configuration back, even after cleanup errors.
    run_init_command(state, &["start", "on"]).await.map_err(|e| format!("Не удалось запустить ядро: {e}"))?;
    tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    if get_pid(&core).is_empty() { return Err("После перезапуска ядро не запущено. Проверьте журнал".into()) }
    if let Some(error) = cleanup_error { return Err(format!("Ядро запущено, но очистка выполнена не полностью: {error}")) }
    Ok(())
}

pub async fn post_control(State(state): State<AppState>, Json(req): Json<ControlReq>) -> impl IntoResponse {
    let _guard = CONTROL_LOCK.get_or_init(|| tokio::sync::Mutex::new(())).lock().await;
    match req.action.as_str() {
        "repairRouting" => {
            if let Err(error) = repair_routing(&state, &req.core).await {
                return Json(ApiResponse { success: false, error: Some(error), data: None });
            }
        }
        "switchCore" => {
            let old = state.core.read().unwrap().name.clone();
            if old == req.core {
                return Json(ApiResponse {
                    success: true,
                    error: None,
                    data: None,
                });
            }

            if !["mihomo", "xray"].contains(&req.core.as_str()) {
                return Json(ApiResponse {
                    success: false,
                    error: Some("Неизвестное ядро".into()),
                    data: None,
                });
            }

            if let Err(e) = check_core_config(&req.core).await {
                log("ERROR", e.clone());
                return Json(ApiResponse {
                    success: false,
                    error: Some(e),
                    data: None,
                });
            }

            let init_file = match resolve_init_file(&state).await {
                Ok(p) => p,
                Err(e) => {
                    return Json(ApiResponse {
                        success: false,
                        error: Some(e),
                        data: None,
                    });
                }
            };
            let content = match fs::read_to_string(&init_file).await {
                Ok(content) => content,
                Err(e) => {
                    return Json(ApiResponse {
                        success: false,
                        error: Some(format!("Не удалось прочитать init-скрипт: {}", e)),
                        data: None,
                    });
                }
            };
            let old_marker = format!("name_client=\"{}\"", old);
            if !content.contains(&old_marker) {
                return Json(ApiResponse {
                    success: false,
                    error: Some("Не удалось найти текущее ядро в init-скрипте".into()),
                    data: None,
                });
            }
            let new_content = content.replace(&old_marker, &format!("name_client=\"{}\"", req.core));

            if let Err(e) = run_init_command(&state, &["stop"]).await {
                return Json(ApiResponse {
                    success: false,
                    error: Some(e),
                    data: None,
                });
            }

            if let Err(e) = fs::write(&init_file, new_content).await {
                if let Err(restore_error) = fs::write(&init_file, &content).await {
                    log("ERROR", format!("Не удалось восстановить init-скрипт: {}", restore_error));
                } else if let Err(start_error) = run_init_command(&state, &["start", "on"]).await {
                    log("ERROR", format!("Не удалось запустить прежнее ядро: {}", start_error));
                }
                return Json(ApiResponse {
                    success: false,
                    error: Some(format!("Не удалось изменить init-скрипт: {}", e)),
                    data: None,
                });
            }

            *state.core.write().unwrap() = get_core_info(&req.core);

            if req.core != "xray" {
                _ = fs::write(error_log_path(), b"").await;
            }

            if let Err(e) = run_init_command(&state, &["start", "on"]).await {
                let restore_result = fs::write(&init_file, content).await;
                *state.core.write().unwrap() = get_core_info(&old);
                if let Err(restore_error) = restore_result {
                    log("ERROR", format!("Не удалось восстановить init-скрипт: {}", restore_error));
                } else if let Err(start_error) = run_init_command(&state, &["start", "on"]).await {
                    log("ERROR", format!("Не удалось запустить прежнее ядро: {}", start_error));
                }
                return Json(ApiResponse {
                    success: false,
                    error: Some(e),
                    data: None,
                });
            }
        }
        "softRestart" => {
            if let Err(e) = soft_restart(&req.core).await {
                return Json(ApiResponse {
                    success: false,
                    error: Some(e),
                    data: None,
                });
            }
        }
        a if ["start", "stop", "hardRestart"].contains(&a) => {
            let arg = match a {
                "start" => "start",
                "stop" => "stop",
                _ => "restart",
            };

            let cur_name = state.core.read().unwrap().name.clone();
            if a == "start" || a == "hardRestart" {
                if let Err(e) = check_core_config(&cur_name).await {
                    log("ERROR", e);
                    return Json(ApiResponse {
                        success: false,
                        error: Some(format!(
                            "Не удалось запустить {}{}",
                            &cur_name[..1].to_uppercase(),
                            &cur_name[1..]
                        )),
                        data: None,
                    });
                }
            }
            if cur_name == "mihomo" && (a == "start" || a == "hardRestart") {
                _ = fs::write(error_log_path(), b"").await;
            }

            let args: &[&str] = match a {
                "start" => &["start", "on"],
                "hardRestart" => &["restart", "on"],
                _ => &[arg],
            };

            if let Err(e) = run_init_command(&state, args).await {
                return Json(ApiResponse {
                    success: false,
                    error: Some(e),
                    data: None,
                });
            }
        }
        _ => {
            return Json(ApiResponse {
                success: false,
                error: Some("Bad action".into()),
                data: None,
            });
        }
    }
    Json(ApiResponse::<()> {
        success: true,
        error: None,
        data: None,
    })
}
