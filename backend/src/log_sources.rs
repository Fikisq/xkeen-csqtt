use crate::types::{access_log_path, error_log_path};
use std::path::Path;

pub(crate) fn sources() -> Vec<(&'static str, String)> {
    vec![
        ("access.log", access_log_path()),
        ("error.log", error_log_path()),
        ("mihomo.log", "/opt/var/log/mihomo/error.log".into()),
        ("csqtt.log", "/opt/etc/csqtt/csqtt.log".into()),
        ("wdtt-plus.log", "/opt/etc/wdtt-plus/wdtt-plus.log".into()),
        ("nfqws2.log", "/opt/etc/xkeen/nfqws2-stage/nfqws2.log".into()),
    ]
}

pub(crate) fn resolve(name: &str) -> Option<String> {
    sources().into_iter().find(|(id, _)| *id == name).map(|(_, path)| path)
}

pub(crate) fn available() -> Vec<&'static str> {
    sources().into_iter().filter(|(id, path)| matches!(*id, "access.log" | "error.log") || Path::new(path).is_file())
        .map(|(id, _)| id).collect()
}
