use crate::logger::log;
use crate::types::{APP_CONFIG, ApiResponse, AppState, MIHOMO_CONF_DIR, XKEEN_CONF_DIR, XRAY_CONF_DIR};
use axum::Json;
use axum::extract::State;
use axum::response::IntoResponse;
use chrono::{DateTime, FixedOffset, Utc};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs::{self, File};
use std::io;
use std::path::{Component, Path, PathBuf};
use std::time::SystemTime;
use tar::{Archive, Builder};

fn mtime_string(time: Result<SystemTime, std::io::Error>, tz: i32) -> String {
    let secs = time
        .ok()
        .and_then(|t| t.duration_since(SystemTime::UNIX_EPOCH).ok())
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    match FixedOffset::east_opt(tz * 3600) {
        Some(offset) => DateTime::from_timestamp(secs, 0)
            .map(|dt| dt.with_timezone(&offset).format("%Y-%m-%d %H:%M:%S").to_string())
            .unwrap_or_default(),
        None => String::new(),
    }
}

const BACKUP_DIR: &str = "/opt/backups";
const BACKUP_SUFFIX: &str = "xkeen-ui.tar";
const CONTENT_ORDER: [&str; 6] = ["xkeen", "xkeen-ui", "xray", "mihomo", "csqtt", "wdtt-plus"];
const CSQTT_CONF_DIR: &str = "/opt/etc/csqtt";
const CSQTT_FILES: [&str; 2] = ["csqtt.conf", "vk_token"];
const WDTT_CONF_DIR: &str = "/opt/etc/wdtt-plus";
const WDTT_FILES: [&str; 5] = ["wdtt-plus.conf", "password", "device_id", "vk_token", "rt-masque-v1.json"];

#[derive(Serialize)]
struct BackupListData {
    backups: Vec<BackupItem>,
}

#[derive(Serialize)]
struct BackupData {
    backup: BackupItem,
}

#[derive(Serialize, Clone)]
struct BackupItem {
    name: String,
    mtime: String,
    size: u64,
    content: BackupContentFiles,
}

#[derive(Serialize, Clone, Default)]
struct BackupContentFiles {
    #[serde(skip_serializing_if = "Vec::is_empty")]
    xkeen: Vec<String>,
    #[serde(rename = "xkeen-ui", skip_serializing_if = "Vec::is_empty")]
    xkeen_ui: Vec<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    xray: Vec<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    mihomo: Vec<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    csqtt: Vec<String>,
    #[serde(rename = "wdtt-plus", skip_serializing_if = "Vec::is_empty")]
    wdtt_plus: Vec<String>,
}

impl BackupContentFiles {
    fn insert(&mut self, key: &str, file: String) {
        match key {
            "xkeen" => self.xkeen.push(file),
            "xkeen-ui" => self.xkeen_ui.push(file),
            "xray" => self.xray.push(file),
            "mihomo" => self.mihomo.push(file),
            "csqtt" => self.csqtt.push(file),
            "wdtt-plus" => self.wdtt_plus.push(file),
            _ => unreachable!("unknown backup content: {key}"),
        }
    }

    fn sort(&mut self) {
        self.xkeen.sort();
        self.xkeen_ui.sort();
        self.xray.sort();
        self.mihomo.sort();
        self.csqtt.sort();
        self.wdtt_plus.sort();
    }
}

#[derive(Deserialize)]
pub struct BackupReq {
    name: String,
    contents: Option<Vec<String>>,
}

#[derive(Deserialize)]
pub struct BackupRenameReq {
    name: String,
    new_name: String,
}

async fn run_blocking<T: Serialize>(
    task: tokio::task::JoinHandle<Result<Option<T>, String>>, err_msg: &str,
) -> impl IntoResponse {
    match task.await {
        Ok(Ok(data)) => Json(ApiResponse {
            success: true,
            error: None,
            data,
        })
        .into_response(),
        Ok(Err(e)) => api_error(format!("{err_msg}: {e}")).into_response(),
        Err(e) => api_error(format!("{err_msg}: {e}")).into_response(),
    }
}

pub async fn get_backups(State(state): State<AppState>) -> impl IntoResponse {
    let tz = state.settings.read().unwrap().log.timezone;
    run_blocking(
        tokio::task::spawn_blocking(move || list_backups_sync(tz).map(|backups| Some(BackupListData { backups }))),
        "Не удалось получить список бэкапов",
    )
    .await
}

#[derive(Deserialize)]
pub struct DownloadBackup {
    name: String,
}

pub async fn download_backup(
    axum::extract::Query(req): axum::extract::Query<DownloadBackup>,
) -> axum::response::Response {
    let result = tokio::task::spawn_blocking(move || -> Result<Vec<u8>, String> {
        let path = resolve_backup_path(&req.name)?;
        if fs::metadata(&path).map_err(io_error)?.len() > 16 * 1024 * 1024 {
            return Err("Архив больше 16 МБ".into());
        }
        fs::read(path).map_err(io_error)
    })
    .await;
    match result {
        Ok(Ok(bytes)) => (
            [("content-type", "application/x-tar"), ("cache-control", "no-store")],
            bytes,
        )
            .into_response(),
        Ok(Err(error)) => (axum::http::StatusCode::BAD_REQUEST, error).into_response(),
        Err(_) => axum::http::StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
}

pub async fn upload_backup(body: axum::body::Bytes) -> impl IntoResponse {
    run_blocking(
        tokio::task::spawn_blocking(move || {
            use std::io::Write;
            use std::os::unix::fs::OpenOptionsExt;
            if body.is_empty() || body.len() > 16 * 1024 * 1024 {
                return Err("Допустим архив до 16 МБ".into());
            }
            ensure_backup_dir().map_err(io_error)?;
            let name = format!("import-{}_{}", uuid::Uuid::new_v4(), BACKUP_SUFFIX);
            let path = Path::new(BACKUP_DIR).join(name);
            let temporary = path.with_extension("upload");
            let result = (|| {
                let mut file = fs::OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .mode(0o600)
                    .open(&temporary)
                    .map_err(io_error)?;
                file.write_all(&body).map_err(io_error)?;
                file.sync_all().map_err(io_error)?;
                validate_backup_entries(&temporary)?;
                fs::rename(&temporary, &path).map_err(io_error)?;
                Ok(None::<()>)
            })();
            if result.is_err() {
                let _ = fs::remove_file(&temporary);
            }
            result
        }),
        "Не удалось загрузить архив",
    )
    .await
}

pub async fn put_backup(State(state): State<AppState>) -> impl IntoResponse {
    let tz = state.settings.read().unwrap().log.timezone;
    run_blocking(
        tokio::task::spawn_blocking(move || create_backup_sync(tz).map(|backup| Some(BackupData { backup }))),
        "Не удалось создать бэкап",
    )
    .await
}

pub async fn post_backup(Json(req): Json<BackupReq>) -> impl IntoResponse {
    run_blocking(
        tokio::task::spawn_blocking(move || restore_backup_sync(&req.name, req.contents).map(|_| None::<()>)),
        "Не удалось восстановить бэкап",
    )
    .await
}

pub async fn delete_backup(Json(req): Json<BackupReq>) -> impl IntoResponse {
    run_blocking(
        tokio::task::spawn_blocking(move || delete_backup_sync(&req.name).map(|_| None::<()>)),
        "Не удалось удалить бэкап",
    )
    .await
}

pub async fn patch_backup(Json(req): Json<BackupRenameReq>) -> impl IntoResponse {
    run_blocking(
        tokio::task::spawn_blocking(move || rename_backup_sync(&req.name, &req.new_name).map(|_| None::<()>)),
        "Не удалось переименовать бэкап",
    )
    .await
}

fn api_error(message: String) -> Json<ApiResponse<()>> {
    Json(ApiResponse {
        success: false,
        error: Some(message),
        data: None,
    })
}

fn list_backups_sync(tz: i32) -> Result<Vec<BackupItem>, String> {
    ensure_backup_dir().map_err(io_error)?;
    let entries = fs::read_dir(BACKUP_DIR).map_err(io_error)?;
    let mut backups = Vec::new();

    for entry in entries.flatten() {
        let path = entry.path();
        if !is_tar_file(&path) {
            continue;
        }

        let metadata = match entry.metadata() {
            Ok(md) => md,
            Err(e) => {
                log(
                    "WARN",
                    format!("Не удалось прочитать метаданные {}: {}", path.display(), e),
                );
                continue;
            }
        };

        let content = match inspect_backup_content(&path) {
            Ok(res) => res,
            Err(e) => {
                log(
                    "WARN",
                    format!("Не удалось прочитать содержимое бэкапа {}: {}", path.display(), e),
                );
                BackupContentFiles::default()
            }
        };

        let Some(name) = path.file_name().and_then(|v| v.to_str()) else {
            continue;
        };

        backups.push(BackupItem {
            name: name.to_string(),
            mtime: mtime_string(metadata.modified(), tz),
            size: metadata.len(),
            content,
        });
    }

    Ok(backups)
}

fn create_backup_sync(tz: i32) -> Result<BackupItem, String> {
    ensure_backup_dir().map_err(io_error)?;
    let files = collect_backup_files().map_err(io_error)?;
    if files.is_empty() {
        return Err("не найдено ни одного файла для архивации".into());
    }

    let name = next_backup_name(tz);
    let final_path = Path::new(BACKUP_DIR).join(&name);
    let temp_path = final_path.with_extension(format!("{}.tar.tmp", uuid::Uuid::new_v4()));
    let content = collect_backup_content(files.iter().map(|(_, rel)| rel.as_str()));

    let write_result = (|| -> io::Result<()> {
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let file = options.open(&temp_path)?;
        let mut builder = Builder::new(file);
        builder.follow_symlinks(true);
        for (source, relative) in &files {
            builder.append_path_with_name(source, relative)?;
        }
        builder.finish()?;
        let file = builder.into_inner()?;
        file.sync_all()?;
        fs::rename(&temp_path, &final_path)?;
        Ok(())
    })();

    if let Err(error) = write_result {
        let _ = fs::remove_file(&temp_path);
        return Err(io_error(error));
    }

    let metadata = fs::metadata(&final_path).map_err(io_error)?;
    log("INFO", format!("Бэкап конфигураций создан: {}", final_path.display()));

    Ok(BackupItem {
        name: name.clone(),
        mtime: mtime_string(metadata.modified(), tz),
        size: metadata.len(),
        content,
    })
}

fn restore_backup_sync(name: &str, requested_contents: Option<Vec<String>>) -> Result<(), String> {
    let backup_path = resolve_backup_path(name)?;
    let requested_contents = normalize_requested_contents(requested_contents)?;
    validate_backup_entries(&backup_path)?;

    let file = File::open(&backup_path).map_err(io_error)?;
    let mut archive = Archive::new(file);
    let entries = archive.entries().map_err(io_error)?;
    let mut restored_contents = HashSet::new();

    for entry in entries {
        let mut entry = entry.map_err(io_error)?;
        if !entry.header().entry_type().is_file() {
            continue;
        }

        let entry_path = entry.path().map_err(io_error)?;
        let relative =
            normalize_entry_path(entry_path.as_ref()).map_err(|e| format!("невалидный путь в архиве: {e}"))?;
        let content = detect_content_key(&relative).ok_or_else(|| format!("недопустимый путь в архиве: {relative}"))?;

        if requested_contents
            .as_ref()
            .is_some_and(|contents| !contents.contains(content))
        {
            continue;
        }
        let target =
            archive_relative_to_target(&relative).ok_or_else(|| format!("недопустимый путь в архиве: {relative}"))?;

        restore_entry(&mut entry, &target, content)?;

        restored_contents.insert(content);
    }

    validate_restored_contents(&requested_contents, &restored_contents)?;
    log("INFO", restore_log_message(&backup_path, &requested_contents));
    Ok(())
}

fn restore_entry<R: io::Read>(entry: &mut tar::Entry<'_, R>, target: &Path, content: &str) -> Result<(), String> {
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(io_error)?;
    }
    let mut options = fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut output = options.open(target).map_err(io_error)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = if matches!(content, "csqtt" | "wdtt-plus") {
            0o600
        } else {
            entry.header().mode().map_err(io_error)? & 0o777
        };
        fs::set_permissions(target, fs::Permissions::from_mode(mode)).map_err(io_error)?;
    }
    io::copy(entry, &mut output).map_err(io_error)?;
    Ok(())
}

fn delete_backup_sync(name: &str) -> Result<(), String> {
    let backup_path = resolve_backup_path(name)?;
    fs::remove_file(&backup_path).map_err(io_error)?;
    log("INFO", format!("Бэкап конфигураций удалён: {}", backup_path.display()));
    Ok(())
}

fn rename_backup_sync(name: &str, new_name: &str) -> Result<(), String> {
    let backup_path = resolve_backup_path(name)?;
    let new_name = new_name.trim();
    if new_name.is_empty()
        || new_name.contains('/')
        || new_name.contains('\\')
        || new_name.contains("..")
        || !is_backup_name(Some(new_name))
    {
        return Err("некорректное имя файла".into());
    }
    let new_path = Path::new(BACKUP_DIR).join(new_name);
    if new_path.exists() {
        return Err("файл с таким именем уже существует".into());
    }
    fs::rename(&backup_path, &new_path).map_err(io_error)?;
    log(
        "INFO",
        format!(
            "Бэкап конфигураций переименован: {} -> {}",
            backup_path.display(),
            new_path.display()
        ),
    );
    Ok(())
}

fn ensure_backup_dir() -> io::Result<()> {
    fs::create_dir_all(BACKUP_DIR)
}

fn is_tar_file(path: &Path) -> bool {
    path.is_file() && is_backup_name(path.file_name().and_then(|v| v.to_str()))
}

fn collect_backup_files() -> io::Result<Vec<(PathBuf, String)>> {
    let mut files = Vec::new();
    let device_id = Path::new(crate::router_device_id::ID_FILE);
    if device_id.is_file() {
        files.push((device_id.to_path_buf(), to_archive_relative(device_id)));
    }
    files.extend(collect_dir_files(XKEEN_CONF_DIR, &["lst", "json"])?);
    for name in ["xray-subscription-url", "global_direct_xray.flag", "global_direct_mihomo.flag"] {
        let path = Path::new(XKEEN_CONF_DIR).join(name);
        if path.is_file() {
            files.push((path.clone(), to_archive_relative(&path)));
        }
    }
    files.extend(collect_dir_files(XRAY_CONF_DIR, &["json"])?);
    files.extend(collect_dir_files(MIHOMO_CONF_DIR, &["yaml", "yml"])?);
    files.extend(collect_dir_files(
        &format!("{MIHOMO_CONF_DIR}/proxy_providers"),
        &["yaml", "yml"],
    )?);
    for name in CSQTT_FILES {
        let path = Path::new(CSQTT_CONF_DIR).join(name);
        if path.is_file() {
            files.push((path.clone(), to_archive_relative(&path)));
        }
    }
    for name in WDTT_FILES {
        let path = Path::new(WDTT_CONF_DIR).join(name);
        if path.is_file() {
            files.push((path.clone(), to_archive_relative(&path)));
        }
    }
    files.sort_by(|a, b| a.1.cmp(&b.1));
    Ok(files)
}

fn collect_dir_files(dir: &str, exts: &[&str]) -> io::Result<Vec<(PathBuf, String)>> {
    let mut files = Vec::new();
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(files),
        Err(e) => return Err(e),
    };

    for entry in entries {
        let entry = entry?;
        let path = entry.path();
        if !path.is_file() || !matches_extension(&path, exts) {
            continue;
        }
        files.push((path.clone(), to_archive_relative(&path)));
    }

    Ok(files)
}

fn matches_extension(path: &Path, exts: &[&str]) -> bool {
    path.extension()
        .and_then(|v| v.to_str())
        .is_some_and(|v| exts.iter().any(|ext| v.eq_ignore_ascii_case(ext)))
}

fn to_archive_relative(path: &Path) -> String {
    path.to_string_lossy()
        .replace('\\', "/")
        .trim_start_matches('/')
        .to_string()
}

fn resolve_backup_path(name: &str) -> Result<PathBuf, String> {
    let name = name.trim();
    if name.is_empty()
        || name.contains('/')
        || name.contains('\\')
        || name.contains("..")
        || !is_backup_name(Some(name))
    {
        return Err("некорректное имя файла".into());
    }

    let path = Path::new(BACKUP_DIR).join(name);
    if !path.is_file() {
        return Err("файл не найден".into());
    }
    Ok(path)
}

fn inspect_backup_content(path: &Path) -> io::Result<BackupContentFiles> {
    let file = File::open(path)?;
    let mut archive = Archive::new(file);
    let mut content = BackupContentFiles::default();

    for entry in archive.entries()? {
        let entry = entry?;
        if !entry.header().entry_type().is_file() {
            continue;
        }
        let Ok(relative) = normalize_entry_path(&entry.path()?) else {
            continue;
        };
        if let Some(key) = detect_content_key(&relative) {
            content.insert(key, content_file_name(key, &relative));
        }
    }

    content.sort();
    Ok(content)
}

fn validate_backup_entries(path: &Path) -> Result<(), String> {
    let file = File::open(path).map_err(io_error)?;
    let mut archive = Archive::new(file);
    let entries = archive.entries().map_err(io_error)?;
    let mut seen = HashSet::new();
    let mut has_files = false;

    for entry in entries {
        let entry = entry.map_err(io_error)?;
        if !entry.header().entry_type().is_file() {
            return Err("архив содержит неподдерживаемые записи".into());
        }

        let entry_path = entry.path().map_err(io_error)?;
        let relative =
            normalize_entry_path(entry_path.as_ref()).map_err(|e| format!("невалидный путь в архиве: {e}"))?;
        if archive_relative_to_target(&relative).is_none() {
            return Err(format!("недопустимый путь в архиве: {relative}"));
        }
        if !seen.insert(relative) {
            return Err("архив содержит дубликаты файлов".into());
        }
        has_files = true;
    }

    if !has_files {
        return Err("архив пустой".into());
    }

    Ok(())
}

fn normalize_entry_path(path: &Path) -> Result<String, &'static str> {
    let mut parts = Vec::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::Normal(value) => parts.push(value.to_string_lossy().to_string()),
            _ => return Err("обнаружен запрещённый компонент пути"),
        }
    }
    if parts.is_empty() {
        return Err("путь пустой");
    }
    Ok(parts.join("/"))
}

fn archive_relative_to_target(relative: &str) -> Option<PathBuf> {
    detect_content_key(relative).map(|_| PathBuf::from(format!("/{relative}")))
}

fn detect_content_key(relative: &str) -> Option<&'static str> {
    if relative == APP_CONFIG.trim_start_matches('/')
        || relative == crate::router_device_id::ID_FILE.trim_start_matches('/')
    {
        return Some("xkeen-ui");
    }

    let check_prefix = |prefix: &str, exts: &[&str]| {
        relative
            .strip_prefix(&format!("{}/", prefix.trim_start_matches('/')))
            .filter(|name| !name.contains('/') && matches_file_name(name, exts))
    };

    if CSQTT_FILES
        .iter()
        .any(|name| relative == format!("{}/{name}", CSQTT_CONF_DIR.trim_start_matches('/')))
    {
        return Some("csqtt");
    }
    if WDTT_FILES
        .iter()
        .any(|name| relative == format!("{}/{name}", WDTT_CONF_DIR.trim_start_matches('/')))
    {
        return Some("wdtt-plus");
    }
    if check_prefix(XKEEN_CONF_DIR, &["lst", "json"]).is_some()
        || ["xray-subscription-url", "global_direct_xray.flag", "global_direct_mihomo.flag"]
            .iter()
            .any(|name| relative == format!("{}/{}", XKEEN_CONF_DIR.trim_start_matches('/'), name))
    {
        return Some("xkeen");
    }
    if check_prefix(XRAY_CONF_DIR, &["json"]).is_some() {
        return Some("xray");
    }
    if check_prefix(MIHOMO_CONF_DIR, &["yaml", "yml"]).is_some()
        || relative
            .strip_prefix(&format!("{}/proxy_providers/", MIHOMO_CONF_DIR.trim_start_matches('/')))
            .is_some_and(|name| !name.contains('/') && matches_file_name(name, &["yaml", "yml"]))
    {
        return Some("mihomo");
    }

    None
}

fn matches_file_name(name: &str, exts: &[&str]) -> bool {
    Path::new(name)
        .extension()
        .and_then(|v| v.to_str())
        .is_some_and(|v| exts.iter().any(|ext| v.eq_ignore_ascii_case(ext)))
}

fn normalize_requested_contents(
    requested_contents: Option<Vec<String>>,
) -> Result<Option<HashSet<&'static str>>, String> {
    let Some(requested_contents) = requested_contents else {
        return Ok(None);
    };
    if requested_contents.is_empty() {
        return Err("не указаны категории для восстановления".into());
    }

    let mut contents = HashSet::new();
    for content in requested_contents {
        let Some(content) = parse_content_key(&content) else {
            return Err(format!("неизвестная категория: {content}"));
        };
        contents.insert(content);
    }

    Ok(Some(contents))
}

fn parse_content_key(value: &str) -> Option<&'static str> {
    CONTENT_ORDER.iter().copied().find(|&content| content == value)
}

fn validate_restored_contents(
    requested_contents: &Option<HashSet<&'static str>>, restored_contents: &HashSet<&'static str>,
) -> Result<(), String> {
    let Some(requested_contents) = requested_contents else {
        return Ok(());
    };

    let missing = CONTENT_ORDER
        .iter()
        .copied()
        .filter(|&content| requested_contents.contains(content) && !restored_contents.contains(content))
        .map(content_label)
        .collect::<Vec<_>>();

    if missing.is_empty() {
        return Ok(());
    }

    Err(format!("в архиве не найдены категории: {}", missing.join(", ")))
}

fn collect_backup_content<'a>(paths: impl Iterator<Item = &'a str>) -> BackupContentFiles {
    let mut content = BackupContentFiles::default();
    for path in paths {
        if let Some(key) = detect_content_key(path) {
            content.insert(key, content_file_name(key, path));
        }
    }
    content.sort();
    content
}

fn content_label(content: &str) -> &'static str {
    match content {
        "xkeen" => "XKeen",
        "xkeen-ui" => "XKeen UI",
        "xray" => "Xray",
        "mihomo" => "Mihomo",
        "csqtt" => "CSQTT",
        "wdtt-plus" => "WDTT Plus",
        _ => unreachable!("unknown backup content: {content}"),
    }
}

fn content_file_name(key: &str, relative: &str) -> String {
    match key {
        "xkeen" => strip_content_prefix(relative, XKEEN_CONF_DIR),
        "xray" => strip_content_prefix(relative, XRAY_CONF_DIR),
        "mihomo" => strip_content_prefix(relative, MIHOMO_CONF_DIR),
        "csqtt" => strip_content_prefix(relative, CSQTT_CONF_DIR),
        "wdtt-plus" => strip_content_prefix(relative, WDTT_CONF_DIR),
        "xkeen-ui" => Path::new(relative)
            .file_name()
            .and_then(|v| v.to_str())
            .unwrap_or(relative)
            .to_string(),
        _ => relative.to_string(),
    }
}

fn strip_content_prefix(relative: &str, root: &str) -> String {
    relative
        .strip_prefix(root.trim_start_matches('/'))
        .map(|rest| rest.trim_start_matches('/'))
        .unwrap_or(relative)
        .to_string()
}

fn restore_log_message(backup_path: &Path, requested_contents: &Option<HashSet<&'static str>>) -> String {
    let Some(requested_contents) = requested_contents else {
        return format!("Конфигурации восстановлены из {}", backup_path.display());
    };

    let contents = CONTENT_ORDER
        .iter()
        .copied()
        .filter(|&content| requested_contents.contains(content))
        .map(content_label)
        .collect::<Vec<_>>()
        .join(", ");

    format!("Конфигурации {} восстановлены из {}", contents, backup_path.display())
}

fn next_backup_name(tz: i32) -> String {
    let base = backup_now(tz).format("%Y-%m-%d_%H-%M-%S").to_string();
    let mut name = format!("{base}_{BACKUP_SUFFIX}");
    let mut index = 2;
    while Path::new(BACKUP_DIR).join(&name).exists() {
        name = format!("{base}_{index}_{BACKUP_SUFFIX}");
        index += 1;
    }
    name
}

fn io_error(error: io::Error) -> String {
    error.to_string()
}

fn is_backup_name(name: Option<&str>) -> bool {
    name.is_some_and(|v| v.ends_with(BACKUP_SUFFIX))
}

fn backup_now(tz: i32) -> DateTime<FixedOffset> {
    Utc::now().with_timezone(&backup_offset(tz))
}

fn backup_offset(tz: i32) -> FixedOffset {
    FixedOffset::east_opt(tz.clamp(-12, 14) * 3600).unwrap()
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!("xkeen-backup-test-{}", uuid::Uuid::new_v4()));
            fs::create_dir(&path).unwrap();
            Self(path)
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn addons_and_mihomo_round_trip_without_touching_live_settings() {
        let fixture = Fixture::new();
        let path = fixture.0.join("fixture.tar");
        let samples = [
            ("opt/etc/csqtt/csqtt.conf", "SERVER=example.invalid\n"),
            ("opt/etc/csqtt/vk_token", "synthetic-test-token"),
            ("opt/etc/wdtt-plus/wdtt-plus.conf", "PEER=example.invalid:57000\n"),
            ("opt/etc/wdtt-plus/password", "synthetic-test-password"),
            ("opt/etc/wdtt-plus/device_id", "synthetic-device-id"),
            ("opt/etc/mihomo/config.yaml", "mode: rule\n"),
            ("opt/etc/mihomo/proxy_providers/test.yaml", "proxies: []\n"),
        ];
        let mut builder = Builder::new(File::create(&path).unwrap());
        for (name, contents) in samples {
            let mut header = tar::Header::new_gnu();
            header.set_size(contents.len() as u64);
            header.set_mode(0o644);
            header.set_cksum();
            builder.append_data(&mut header, name, contents.as_bytes()).unwrap();
        }
        builder.finish().unwrap();
        drop(builder);
        validate_backup_entries(&path).unwrap();
        let content = inspect_backup_content(&path).unwrap();
        assert_eq!(content.csqtt.len(), 2);
        assert_eq!(content.wdtt_plus.len(), 3);
        assert_eq!(content.mihomo.len(), 2);
        let mut archive = Archive::new(File::open(&path).unwrap());
        for entry in archive.entries().unwrap() {
            let mut entry = entry.unwrap();
            let relative = normalize_entry_path(&entry.path().unwrap()).unwrap();
            let category = detect_content_key(&relative).unwrap();
            let target = fixture.0.join("restored").join(&relative);
            restore_entry(&mut entry, &target, category).unwrap();
            let expected = samples.iter().find(|(name, _)| *name == relative).unwrap().1;
            assert_eq!(fs::read_to_string(&target).unwrap(), expected);
            #[cfg(unix)]
            if matches!(category, "csqtt" | "wdtt-plus") {
                use std::os::unix::fs::PermissionsExt;
                assert_eq!(fs::metadata(&target).unwrap().permissions().mode() & 0o777, 0o600);
            }
        }
    }

    #[test]
    fn backup_paths_reject_runtime_files_and_neighbor_directories() {
        for path in [
            "opt/etc/csqtt/csqtt-client",
            "opt/etc/csqtt/csqtt.log",
            "opt/etc/csqtt/vk_api_calls.lock",
            "opt/etc/wdtt-plus/wdtt-plus-client",
            "opt/etc/wdtt-plus/client-version",
            "opt/etc/csqtt-other/csqtt.conf",
            "opt/etc/mihomo-other/config.yaml",
            "opt/etc/xkeen-other/settings.json",
            "opt/etc/xray/configs-other/config.json",
        ] {
            assert!(detect_content_key(path).is_none(), "{path}");
        }
        assert!(normalize_entry_path(Path::new("../etc/shadow")).is_err());
        assert!(normalize_entry_path(Path::new("/etc/shadow")).is_err());
        assert!(detect_content_key("opt/etc/wdtt-plus/rt-masque-v1.json").is_some());
    }

    #[test]
    fn selection_supports_new_categories_and_legacy_archives() {
        let requested = normalize_requested_contents(Some(vec!["csqtt".into(), "wdtt-plus".into()]))
            .unwrap()
            .unwrap();
        assert!(requested.contains("csqtt") && requested.contains("wdtt-plus"));
        let legacy = collect_backup_content(
            [
                "opt/etc/xkeen/xkeen.json",
                "opt/etc/xray/configs/00_config.json",
                "opt/etc/mihomo/config.yaml",
            ]
            .into_iter(),
        );
        assert!(legacy.csqtt.is_empty() && legacy.wdtt_plus.is_empty());
        assert!(!legacy.xkeen.is_empty() && !legacy.xray.is_empty() && !legacy.mihomo.is_empty());
        let json = serde_json::to_value(legacy).unwrap();
        assert!(json.get("csqtt").is_none() && json.get("wdtt-plus").is_none());
    }
}
