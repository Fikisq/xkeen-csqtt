use axum::extract::{Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde::Deserialize;
use std::sync::{Arc, LazyLock, RwLock};
use std::time::SystemTime;
use tokio::process::Command;
use yaml_rust2::{Yaml, YamlLoader};

use crate::types::{ApiResponse, AppState, MIHOMO_CONF_DIR};

const MIHOMO_CONF_DIRIG_PATH: &str = "/opt/etc/mihomo/config.yaml";

static MIHOMO_YAML_CACHE: LazyLock<RwLock<Option<(SystemTime, Arc<Vec<Yaml>>)>>> = LazyLock::new(|| RwLock::new(None));

async fn load_mihomo_yaml() -> Result<Arc<Vec<Yaml>>, String> {
    let mtime = tokio::fs::metadata(MIHOMO_CONF_DIRIG_PATH)
        .await
        .map_err(|e| format!("Ошибка чтения конфига: {e}"))?
        .modified()
        .map_err(|e| format!("Ошибка чтения mtime: {e}"))?;

    if let Some(cached) = {
        let guard = MIHOMO_YAML_CACHE.read().unwrap();
        guard
            .as_ref()
            .filter(|(ts, _)| *ts == mtime)
            .map(|(_, docs)| docs.clone())
    } {
        return Ok(cached);
    }

    let content = tokio::fs::read_to_string(MIHOMO_CONF_DIRIG_PATH)
        .await
        .map_err(|e| format!("Ошибка чтения конфига: {e}"))?;
    let docs = YamlLoader::load_from_str(&content).map_err(|e| format!("Ошибка парсинга YAML: {e}"))?;
    let arc = Arc::new(docs);
    *MIHOMO_YAML_CACHE.write().unwrap() = Some((mtime, arc.clone()));
    Ok(arc)
}

#[derive(Deserialize)]
pub struct RuleContentQuery {
    pub name: String,
    pub format: Option<String>,
    pub behavior: Option<String>,
    #[serde(rename = "vehicleType")]
    pub vehicle_type: Option<String>,
}

// Read the saved configuration even while Xray is active. Listing and decoding
// providers never starts Mihomo or changes routing.
pub async fn get_ruleset_files() -> Response {
    let result = async {
        let docs = load_mihomo_yaml().await?;
        let parsed = docs.first().ok_or("YAML пуст")?;
        let mut files = Vec::new();
        if let Some(providers) = parsed["rule-providers"].as_hash() {
            for (name, provider) in providers {
                let Some(name) = name.as_str() else { continue };
                let path = provider["path"].as_str().map(resolve_provider_path)
                    .or_else(|| provider["url"].as_str().map(|url| format!("{}/rules/{:x}", MIHOMO_CONF_DIR, md5::compute(url))));
                let metadata = match path { Some(path) => tokio::fs::metadata(path).await.ok(), None => None };
                let url = provider["url"].as_str().unwrap_or("");
                let source = if url.contains("/hydraponique/roscomvpn-") { "RoscomVPN" }
                    else if url.contains("/MetaCubeX/meta-rules-dat/") { "MetaCubeX" } else { "Пользовательский rule-set" };
                files.push(serde_json::json!({"name": name, "behavior": provider["behavior"].as_str().unwrap_or("classical"),
                    "format": provider["format"].as_str().unwrap_or("yaml"), "source": source,
                    "installed": metadata.as_ref().is_some_and(|m| m.is_file()), "size": metadata.map(|m| m.len()).unwrap_or(0)}));
            }
        }
        let mut geofiles = Vec::new();
        for (name, kind, format) in [("geosite.dat", "domain", "dat"), ("geoip.dat", "ip", "dat"),
            ("country.mmdb", "ip", "mmdb"), ("geoip.metadb", "ip", "mmdb"), ("ASN.mmdb", "asn", "mmdb")] {
            let metadata = tokio::fs::metadata(format!("{MIHOMO_CONF_DIR}/{name}")).await.ok();
            geofiles.push(serde_json::json!({"name":name, "kind":kind, "format":format,
                "installed":metadata.as_ref().is_some_and(|m| m.is_file()), "size":metadata.map(|m| m.len()).unwrap_or(0)}));
        }
        Ok::<_, String>((files, geofiles, parsed["geodata-mode"].as_bool().unwrap_or(false)))
    }.await;
    match result {
        Ok((files, geofiles, geodata_mode)) => (StatusCode::OK, axum::Json(serde_json::json!({"success": true, "files": files, "geofiles": geofiles, "geodataMode":geodata_mode}))).into_response(),
        Err(error) => error_response(error),
    }
}

pub async fn get_ruleset_content(State(_state): State<AppState>, Query(params): Query<RuleContentQuery>) -> Response {
    let docs = match load_mihomo_yaml().await {
        Ok(d) => d,
        Err(e) => return error_response(e),
    };
    let Some(parsed) = docs.first() else {
        return error_response("YAML пуст".into());
    };

    let provider = &parsed["rule-providers"][params.name.as_str()];
    if provider.is_badvalue() {
        return error_response(format!("Провайдер '{}' не найден", params.name));
    }

    if params
        .vehicle_type
        .as_deref()
        .is_some_and(|v| v.eq_ignore_ascii_case("inline"))
    {
        let items: Vec<&str> = provider["payload"]
            .as_vec()
            .map(|seq| seq.iter().filter_map(|v| v.as_str()).collect())
            .unwrap_or_default();

        if items.is_empty() {
            return error_response("Payload пуст или не найден".into());
        }
        return ok_response(items.join("\n"));
    }

    let url = provider["url"].as_str();
    let path = provider["path"].as_str();

    let final_path = match path {
        Some(p) => resolve_provider_path(p),
        None => match url {
            Some(u) => format!("{}/rules/{:x}", MIHOMO_CONF_DIR, md5::compute(u)),
            None => return error_response("В провайдере нет ни path, ни url".into()),
        },
    };

    let is_mrs = provider["format"].as_str().or(params.format.as_deref())
        .is_some_and(|f| f.eq_ignore_ascii_case("mrs") || f.eq_ignore_ascii_case("mrsrule"));

    let content = if is_mrs {
        let behavior = provider["behavior"].as_str().or(params.behavior.as_deref()).unwrap_or("domain");
        match convert_mrs(&final_path, behavior).await {
            Ok(c) => c,
            Err(e) => return error_response(e),
        }
    } else {
        match tokio::fs::read_to_string(&final_path).await {
            Ok(c) => c,
            Err(e) => {
                return error_response(format!("Не удалось прочитать файл {final_path}: {e}"));
            }
        }
    };

    ok_response(content)
}

async fn convert_mrs(mrs_path: &str, behavior: &str) -> Result<String, String> {
    if tokio::fs::metadata(mrs_path).await.is_err() {
        return Err(format!("MRS файл не найден: {mrs_path}"));
    }

    let behavior = behavior.to_ascii_lowercase();
    let tmp_path = format!("/opt/tmp/convert_{}", random_suffix());

    let output = tokio::time::timeout(std::time::Duration::from_secs(20), Command::new("/opt/sbin/mihomo")
        .args(["convert-ruleset", behavior.as_str(), "mrs", mrs_path, &tmp_path])
        .kill_on_drop(true).output()).await;
    let output = match output {
        Ok(Ok(output)) => output,
        error => {
            let _ = tokio::fs::remove_file(&tmp_path).await;
            return Err(format!("Не удалось прочитать MRS: {error:?}"));
        }
    };

    if !output.status.success() {
        let _ = tokio::fs::remove_file(&tmp_path).await;
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(format!(
            "mihomo convert-ruleset упал с кодом {}: {}",
            output.status, stderr
        ));
    }

    let content = tokio::fs::read_to_string(&tmp_path)
        .await
        .map_err(|e| format!("Ошибка чтения результата конвертации: {e}"));

    let _ = tokio::fs::remove_file(&tmp_path).await;
    content
}

fn random_suffix() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .subsec_nanos();
    format!("{:08x}", nanos ^ std::process::id().wrapping_shl(8))
}

fn resolve_provider_path(path: &str) -> String {
    if path.starts_with('/') {
        path.to_string()
    } else {
        format!("{}/{}", MIHOMO_CONF_DIR, path.trim_start_matches("./"))
    }
}

fn ok_response(content: String) -> Response {
    (
        StatusCode::OK,
        axum::Json(ApiResponse {
            success: true,
            error: None,
            data: Some(serde_json::json!({ "content": content })),
        }),
    )
        .into_response()
}

fn error_response(msg: String) -> Response {
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        axum::Json(ApiResponse::<()> {
            success: false,
            error: Some(msg),
            data: None,
        }),
    )
        .into_response()
}
