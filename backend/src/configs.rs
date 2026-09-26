use crate::logger::log;
use crate::types::*;
use axum::extract::{Query, State};
use axum::response::{IntoResponse, Json};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::Path;
use std::os::unix::fs::PermissionsExt;

#[derive(Serialize)]
struct ConfigItem {
    file: String,
    content: String,
}
#[derive(Deserialize)]
pub struct ConfigReq {
    pub(crate) file: String,
    pub(crate) content: String,
}
#[derive(Deserialize)]
pub struct XraySetupReq {
    content: String,
    subscription_url: Option<String>,
    subscription_allow_lan: Option<bool>,
    subscriptions: Option<Vec<XraySubscriptionEntry>>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct XraySubscriptionEntry {
    pub(crate) id: String,
    pub(crate) url: String,
    #[serde(default)]
    pub(crate) allow_lan: bool,
}
#[derive(Deserialize)]
pub struct DeleteReq {
    file: String,
}
#[derive(Deserialize)]
pub struct RenameReq {
    file: String,
    new_file: String,
}

async fn collect_configs(paths: &[String], is_mihomo: bool) -> Vec<ConfigItem> {
    let mut results = Vec::new();
    for path_str in paths {
        let path = Path::new(path_str);
        if path.is_dir() {
            match tokio::fs::read_dir(path).await {
                Err(e) => {
                    log("ERROR", format!("Не удалось открыть директорию {}: {}", path_str, e));
                }
                Ok(mut entries) => {
                    while let Ok(Some(entry)) = entries.next_entry().await {
                        let entry_path = entry.path();
                        let matches = if is_mihomo {
                            entry_path.extension().map_or(false, |e| e == "yaml" || e == "yml")
                        } else {
                            entry_path.extension().map_or(false, |e| e == "json")
                        };
                        if matches {
                            match tokio::fs::read_to_string(&entry_path).await {
                                Ok(content) => results.push(ConfigItem {
                                    file: entry_path.to_string_lossy().into(),
                                    content,
                                }),
                                Err(e) => {
                                    log(
                                        "ERROR",
                                        format!("Не удалось прочитать файл {}: {}", entry_path.display(), e),
                                    );
                                }
                            }
                        }
                    }
                }
            }
        } else if path.exists() {
            match tokio::fs::read_to_string(path).await {
                Ok(content) => results.push(ConfigItem {
                    file: path_str.clone(),
                    content,
                }),
                Err(e) => {
                    log("ERROR", format!("Не удалось прочитать файл {}: {}", path_str, e));
                }
            }
        } else {
            log("WARN", format!("Файл не найден: {}", path_str));
        }
    }
    results.sort_by(|a, b| a.file.cmp(&b.file));
    results.dedup_by(|a, b| a.file == b.file);
    results
}

pub async fn get_configs(
    State(state): State<AppState>, Query(parameters): Query<HashMap<String, String>>,
) -> impl IntoResponse {
    let target_core = parameters
        .get("core")
        .cloned()
        .unwrap_or_else(|| state.core.read().unwrap().name.clone());
    let is_mihomo = target_core == "mihomo";

    let core_paths = {
        let settings = state.settings.read().unwrap();
        let default_path = if is_mihomo {
            MIHOMO_CONF_DIR.to_string()
        } else {
            XRAY_CONF_DIR.to_string()
        };
        let mut paths = vec![default_path];
        let extra = if is_mihomo {
            settings.append_config_paths.mihomo.clone()
        } else {
            settings.append_config_paths.xray.clone()
        };
        paths.extend(extra);
        paths
    };

    let mut core_configs = collect_configs(&core_paths, is_mihomo).await;
    let mut lst_configs = Vec::new();

    if let Ok(mut entries) = tokio::fs::read_dir(XKEEN_CONF_DIR).await {
        while let Ok(Some(entry)) = entries.next_entry().await {
            let path = entry.path();
            let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
            if path.extension().map_or(false, |e| e == "lst") || name == "xkeen.json" {
                if let Ok(content) = tokio::fs::read_to_string(&path).await {
                    lst_configs.push(ConfigItem {
                        file: path.to_string_lossy().into(),
                        content,
                    });
                }
            }
        }
    }

    lst_configs.sort_by(|a, b| a.file.cmp(&b.file));
    core_configs.append(&mut lst_configs);

    Json(serde_json::json!({ "success": true, "configs": core_configs }))
}

const XRAY_SETUP_FILE: &str = "/opt/etc/xray/configs/00_config.json";
const XRAY_SUBSCRIPTION_FILE: &str = "/opt/etc/xkeen/xray-subscription-url";
const XRAY_SUBSCRIPTION_LAN_FILE: &str = "/opt/etc/xkeen/xray-subscription-allow-lan";

pub(crate) async fn read_xray_subscriptions() -> Vec<XraySubscriptionEntry> {
    let raw = tokio::fs::read_to_string(XRAY_SUBSCRIPTION_FILE).await.unwrap_or_default();
    if raw.trim_start().starts_with('[') {
        return serde_json::from_str(&raw).unwrap_or_default();
    }
    let url = raw.trim();
    if url.is_empty() { return Vec::new() }
    vec![XraySubscriptionEntry {
        id: "legacy".into(),
        url: url.into(),
        allow_lan: tokio::fs::metadata(XRAY_SUBSCRIPTION_LAN_FILE).await.is_ok(),
    }]
}

pub async fn get_xray_setup() -> impl IntoResponse {
    let subscriptions = read_xray_subscriptions().await;
    let subscription_url = subscriptions.first().map(|entry| entry.url.as_str()).unwrap_or("");
    let subscription_allow_lan = subscriptions.first().is_some_and(|entry| entry.allow_lan);
    match tokio::fs::read_to_string(XRAY_SETUP_FILE).await {
        Ok(content) => Json(serde_json::json!({ "success": true, "exists": true, "content": content, "subscriptionUrl": subscription_url, "subscriptionAllowLan": subscription_allow_lan, "subscriptions": subscriptions })),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            Json(serde_json::json!({ "success": true, "exists": false, "content": "", "subscriptionUrl": subscription_url, "subscriptionAllowLan": subscription_allow_lan, "subscriptions": subscriptions }))
        }
        Err(e) => Json(serde_json::json!({ "success": false, "error": e.to_string() })),
    }
}

pub(crate) async fn xray_files_with_replacement(file: &str, content: &str) -> Vec<ConfigReq> {
    let mut files = Vec::new();
    let mut found_current = false;
    if let Ok(mut entries) = tokio::fs::read_dir(XRAY_CONF_DIR).await {
        while let Ok(Some(entry)) = entries.next_entry().await {
            let path = entry.path();
            if path.extension().map_or(false, |e| e == "json") {
                let path_str = path.to_string_lossy().into_owned();
                let file_content = if path_str == file {
                    found_current = true;
                    content.to_string()
                } else {
                    tokio::fs::read_to_string(&path).await.unwrap_or_default()
                };
                files.push(ConfigReq {
                    file: path_str,
                    content: file_content,
                });
            }
        }
    }
    if !found_current {
        files.push(ConfigReq {
            file: file.to_string(),
            content: content.to_string(),
        });
    }
    files
}

pub async fn put_xray_setup(State(state): State<AppState>, Json(req): Json<XraySetupReq>) -> impl IntoResponse {
    let _guard = state.app_config_lock.lock().await;
    if req.content.trim().is_empty() {
        return Json(serde_json::json!({ "success": false, "error": "Вставьте конфигурацию Xray" }));
    }
    if let Some(url) = &req.subscription_url {
        let trimmed = url.trim();
        if trimmed.len() > 2048 || (!trimmed.is_empty() && reqwest::Url::parse(trimmed).ok().is_none_or(|parsed| {
            parsed.scheme() != "https" || parsed.host_str().is_none() || !parsed.username().is_empty() || parsed.password().is_some()
        })) {
            return Json(serde_json::json!({ "success": false, "error": "Нужна корректная HTTPS-ссылка подписки" }));
        }
    }
    if let Some(entries) = &req.subscriptions {
        let mut ids = std::collections::HashSet::new();
        if entries.len() > 8 || entries.iter().any(|entry| {
            entry.id.is_empty() || entry.id.len() > 32
                || !entry.id.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
                || !ids.insert(entry.id.as_str())
                || entry.url.len() > 2048
                || reqwest::Url::parse(entry.url.trim()).ok().is_none_or(|url| {
                    url.scheme() != "https" || url.host_str().is_none()
                        || !url.username().is_empty() || url.password().is_some()
                })
        }) {
            return Json(serde_json::json!({ "success": false, "error": "Некорректный список подписок Xray" }));
        }
    }
    if let Err(e) = tokio::fs::create_dir_all(XRAY_CONF_DIR).await {
        return Json(serde_json::json!({ "success": false, "error": format!("Не удалось создать каталог Xray: {}", e) }));
    }
    let files = xray_files_with_replacement(XRAY_SETUP_FILE, &req.content).await;
    if let Err(e) = validate_core("xray", &files).await {
        log("ERROR", format!("Проверка Xray перед сохранением: {}", e));
        return Json(serde_json::json!({ "success": false, "error": "Конфигурация Xray не прошла проверку. Смотрите журнал панели" }));
    }

    let temp_file = format!("{}.{}.tmp", XRAY_SETUP_FILE, uuid::Uuid::new_v4());
    if let Err(e) = tokio::fs::write(&temp_file, &req.content).await {
        _ = tokio::fs::remove_file(&temp_file).await;
        return Json(serde_json::json!({ "success": false, "error": format!("Не удалось записать Xray JSON: {}", e) }));
    }
    if let Ok(metadata) = tokio::fs::metadata(XRAY_SETUP_FILE).await {
        if let Err(e) = tokio::fs::set_permissions(&temp_file, metadata.permissions()).await {
            _ = tokio::fs::remove_file(&temp_file).await;
            return Json(serde_json::json!({ "success": false, "error": format!("Не удалось сохранить права Xray JSON: {}", e) }));
        }
    }
    if let Err(e) = tokio::fs::rename(&temp_file, XRAY_SETUP_FILE).await {
        _ = tokio::fs::remove_file(&temp_file).await;
        return Json(serde_json::json!({ "success": false, "error": format!("Не удалось сохранить Xray JSON: {}", e) }));
    }
    if let Some(url) = req.subscription_url {
        let url = url.trim();
        if url.is_empty() {
            if let Err(e) = tokio::fs::remove_file(XRAY_SUBSCRIPTION_FILE).await {
                if e.kind() != std::io::ErrorKind::NotFound {
                    log("WARN", format!("Не удалось удалить ссылку подписки Xray: {}", e));
                }
            }
        } else {
            if let Err(e) = tokio::fs::create_dir_all(XKEEN_CONF_DIR).await {
                log("WARN", format!("Не удалось создать каталог подписки Xray: {}", e));
                return Json(serde_json::json!({ "success": true, "warning": "Xray JSON сохранён, но ссылку подписки сохранить не удалось" }));
            }
            let temp_url = format!("{}.{}.tmp", XRAY_SUBSCRIPTION_FILE, uuid::Uuid::new_v4());
            let result = async {
                tokio::fs::write(&temp_url, url.as_bytes()).await?;
                tokio::fs::set_permissions(&temp_url, std::fs::Permissions::from_mode(0o600)).await?;
                tokio::fs::rename(&temp_url, XRAY_SUBSCRIPTION_FILE).await
            }.await;
            if let Err(e) = result {
                _ = tokio::fs::remove_file(&temp_url).await;
                log("WARN", format!("Не удалось сохранить ссылку подписки Xray: {}", e));
                return Json(serde_json::json!({ "success": true, "warning": "Xray JSON сохранён, но ссылку подписки сохранить не удалось" }));
            }
        }
    }
    if let Some(entries) = req.subscriptions {
        if let Err(e) = tokio::fs::create_dir_all(XKEEN_CONF_DIR).await {
            return Json(serde_json::json!({ "success": true, "warning": format!("Xray JSON сохранён, но каталог подписок недоступен: {e}") }));
        }
        let temporary = format!("{}.{}.tmp", XRAY_SUBSCRIPTION_FILE, uuid::Uuid::new_v4());
        let result = async {
            let encoded = serde_json::to_vec(&entries).map_err(std::io::Error::other)?;
            tokio::fs::write(&temporary, encoded).await?;
            tokio::fs::set_permissions(&temporary, std::fs::Permissions::from_mode(0o600)).await?;
            tokio::fs::rename(&temporary, XRAY_SUBSCRIPTION_FILE).await
        }.await;
        if let Err(e) = result {
            _ = tokio::fs::remove_file(&temporary).await;
            return Json(serde_json::json!({ "success": true, "warning": format!("Xray JSON сохранён, но список подписок не сохранён: {e}") }));
        }
        _ = tokio::fs::remove_file(XRAY_SUBSCRIPTION_LAN_FILE).await;
    }
    if let Some(allow_lan) = req.subscription_allow_lan {
        if allow_lan {
            if let Err(e) = tokio::fs::write(XRAY_SUBSCRIPTION_LAN_FILE, b"1").await {
                log("WARN", format!("Не удалось сохранить настройку локальной подписки Xray: {}", e));
                return Json(serde_json::json!({ "success": true, "warning": "Xray JSON сохранён, но разрешение локальной подписки сохранить не удалось" }));
            }
            _ = tokio::fs::set_permissions(XRAY_SUBSCRIPTION_LAN_FILE, std::fs::Permissions::from_mode(0o600)).await;
        } else {
            _ = tokio::fs::remove_file(XRAY_SUBSCRIPTION_LAN_FILE).await;
        }
    }
    Json(serde_json::json!({ "success": true }))
}

fn get_allowed_prefixes(state: &AppState, is_lst: bool) -> Vec<String> {
    if is_lst {
        return vec![XKEEN_CONF_DIR.to_string()];
    }
    let settings = state.settings.read().unwrap();
    let core = state.core.read().unwrap();
    let default_path = if core.name == "mihomo" {
        MIHOMO_CONF_DIR.to_string()
    } else {
        XRAY_CONF_DIR.to_string()
    };
    let extra = if core.name == "mihomo" {
        settings.append_config_paths.mihomo.clone()
    } else {
        settings.append_config_paths.xray.clone()
    };
    let mut paths = vec![default_path];
    paths.extend(extra);
    paths
}

fn is_path_allowed(file: &str, prefixes: &[String]) -> bool {
    prefixes.iter().any(|prefix| {
        let prefix_path = Path::new(prefix.as_str());
        let file_path = Path::new(file);
        if prefix_path.is_dir() {
            file_path.starts_with(prefix_path)
        } else {
            file == prefix
        }
    })
}

fn check_access(file: &str, state: &AppState) -> Result<bool, &'static str> {
    if file.contains("..") {
        return Err("Invalid path");
    }
    let is_xkeen = file.ends_with(".lst") || (file.ends_with(".json") && file.starts_with(XKEEN_CONF_DIR));
    let prefixes = get_allowed_prefixes(state, is_xkeen);
    if !is_path_allowed(file, &prefixes) {
        return Err("Path not allowed");
    }
    Ok(file.ends_with(".lst"))
}

pub async fn put_config(
    State(state): State<AppState>, Query(params): Query<HashMap<String, String>>, Json(req): Json<ConfigReq>,
) -> impl IntoResponse {
    let inactive_mihomo_config = params.get("core").is_some_and(|core| core == "mihomo")
        && params.get("validate").is_some_and(|core| core == "mihomo")
        && req.file == "/opt/etc/mihomo/config.yaml";
    let inactive_xray_config = params.get("core").is_some_and(|core| core == "xray")
        && params.get("validate").is_some_and(|core| core == "xray")
        && req.file == "/opt/etc/xray/configs/00_config.json";
    let is_lst = match if inactive_mihomo_config || inactive_xray_config { Ok(false) } else { check_access(&req.file, &state) } {
        Ok(val) => val,
        Err(e) => {
            return Json(ApiResponse::<()> {
                success: false,
                error: Some(e.into()),
                data: None,
            });
        }
    };
    let content = if is_lst {
        req.content.replace("\r\n", "\n")
    } else {
        req.content
    };

    if let Some(core_type) = params.get("validate") {
        let mut validate_files = Vec::new();
        if core_type == "mihomo" {
            validate_files.push(ConfigReq {
                file: req.file.clone(),
                content: content.clone(),
            });
        } else if core_type == "xray" {
            validate_files = xray_files_with_replacement(&req.file, &content).await;
        }

        if let Err(err_msg) = validate_core(core_type, &validate_files).await {
            log("ERROR", err_msg);
            return Json(ApiResponse::<()> {
                success: false,
                error: Some("Validation failed".into()),
                data: None,
            });
        }
    }

    if fs::write(&req.file, &content).is_err() {
        return Json(ApiResponse::<()> {
            success: false,
            error: Some("Write error".into()),
            data: None,
        });
    }
    Json(ApiResponse::<()> {
        success: true,
        error: None,
        data: None,
    })
}

pub async fn post_config(State(state): State<AppState>, Json(req): Json<ConfigReq>) -> impl IntoResponse {
    let is_lst = match check_access(&req.file, &state) {
        Ok(val) => val,
        Err(e) => {
            return Json(ApiResponse::<()> {
                success: false,
                error: Some(e.into()),
                data: None,
            });
        }
    };
    if Path::new(&req.file).exists() {
        return Json(ApiResponse::<()> {
            success: false,
            error: Some("File already exists".into()),
            data: None,
        });
    }
    let content = if is_lst {
        req.content.replace("\r\n", "\n")
    } else {
        req.content
    };
    if fs::write(&req.file, content).is_err() {
        return Json(ApiResponse::<()> {
            success: false,
            error: Some("Write error".into()),
            data: None,
        });
    }
    Json(ApiResponse::<()> {
        success: true,
        error: None,
        data: None,
    })
}

pub async fn delete_config(State(state): State<AppState>, Json(req): Json<DeleteReq>) -> impl IntoResponse {
    if let Err(e) = check_access(&req.file, &state) {
        return Json(ApiResponse::<()> {
            success: false,
            error: Some(e.into()),
            data: None,
        });
    }
    if fs::remove_file(&req.file).is_err() {
        return Json(ApiResponse::<()> {
            success: false,
            error: Some("Delete error".into()),
            data: None,
        });
    }
    Json(ApiResponse::<()> {
        success: true,
        error: None,
        data: None,
    })
}

pub async fn patch_config(State(state): State<AppState>, Json(req): Json<RenameReq>) -> impl IntoResponse {
    if let Err(e) = check_access(&req.file, &state) {
        return Json(ApiResponse::<()> {
            success: false,
            error: Some(e.into()),
            data: None,
        });
    }
    if let Err(e) = check_access(&req.new_file, &state) {
        return Json(ApiResponse::<()> {
            success: false,
            error: Some(e.into()),
            data: None,
        });
    }
    if Path::new(&req.new_file).exists() {
        return Json(ApiResponse::<()> {
            success: false,
            error: Some("File already exists".into()),
            data: None,
        });
    }
    if fs::rename(&req.file, &req.new_file).is_err() {
        return Json(ApiResponse::<()> {
            success: false,
            error: Some("Rename error".into()),
            data: None,
        });
    }
    Json(ApiResponse::<()> {
        success: true,
        error: None,
        data: None,
    })
}

pub(crate) async fn validate_core(core: &str, files: &[ConfigReq]) -> Result<(), String> {
    let temp_dir = std::env::temp_dir().join(format!(
        "xkeen-validate-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or_default()
    ));
    tokio::fs::create_dir_all(&temp_dir).await.map_err(|e| e.to_string())?;

    for item in files {
        let Some(name) = Path::new(&item.file).file_name() else {
            continue;
        };
        if let Err(e) = tokio::fs::write(temp_dir.join(name), &item.content).await {
            _ = tokio::fs::remove_dir_all(&temp_dir).await;
            return Err(e.to_string());
        }
    }

    let mut command = match core {
        "mihomo" => {
            let mut cmd = tokio::process::Command::new("mihomo");
            cmd.args(["-t", "-d", MIHOMO_CONF_DIR, "-f"]).arg(temp_dir.join("config.yaml"));
            cmd.env("CLASH_HOME_DIR", MIHOMO_CONF_DIR);
            cmd
        }
        _ => {
            let mut cmd = tokio::process::Command::new("/opt/sbin/xray");
            cmd.args(["-test", "-confdir"]).arg(&temp_dir);
            cmd.env("XRAY_LOCATION_ASSET", XRAY_ASSET_DIR);
            cmd
        }
    };

    let output = command.output().await;
    _ = tokio::fs::remove_dir_all(&temp_dir).await;

    let output = output.map_err(|e| e.to_string())?;
    if output.status.success() {
        return Ok(());
    }

    let mut combined = String::from_utf8_lossy(&output.stdout).into_owned();
    combined.push_str(&String::from_utf8_lossy(&output.stderr));
    Err(combined)
}
