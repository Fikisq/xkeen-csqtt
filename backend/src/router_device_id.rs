use sha2::{Digest, Sha256};
use std::{fs, io::Write, os::unix::fs::OpenOptionsExt, path::Path};

pub(crate) const ID_FILE: &str = "/opt/etc/xkeen-ui/device-id";

fn valid_id(value: &str) -> bool {
    !value.is_empty() && value.len() <= 128
        && value.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

fn from_mac(value: &str) -> Option<String> {
    let parts: Vec<_> = value.trim().split(':').collect();
    if parts.len() != 6 || parts.iter().any(|part| part.len() != 2) { return None; }
    let bytes = parts.iter().map(|part| u8::from_str_radix(part, 16)).collect::<Result<Vec<_>, _>>().ok()?;
    if bytes.iter().all(|byte| *byte == 0) || bytes[0] & 1 != 0 { return None; }
    let mut hash = Sha256::new();
    hash.update(b"xkeen-ui/router-device/v1:");
    hash.update(&bytes);
    let digest = format!("{:x}", hash.finalize());
    Some(format!("Keenetic-{:02X}{:02X}-{}", bytes[4], bytes[5], &digest[..8]))
}

fn read_saved() -> Result<String, String> {
    let value = fs::read_to_string(ID_FILE).map_err(|error| error.to_string())?;
    let value = value.trim();
    if !valid_id(value) { return Err("Сохранённый ID роутера повреждён; автоматическая замена запрещена".into()); }
    Ok(value.to_string())
}

/// Only for initializing a missing client configuration. Existing client IDs
/// are never migrated: server registrations can be bound to those values.
pub(crate) fn for_new_client() -> Result<String, String> {
    match fs::metadata(ID_FILE) {
        Ok(_) => return read_saved(),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {},
        Err(error) => return Err(error.to_string()),
    }
    // Prefer the LAN bridge. Never derive identity from a temporary VPN/TUN
    // interface or a changing WAN address.
    let id = ["br0", "br-lan", "eth0", "eth2", "eth1"].into_iter()
        .find_map(|interface| fs::read_to_string(format!("/sys/class/net/{interface}/address")).ok().and_then(|mac| from_mac(&mac)))
        .unwrap_or_else(|| format!("Keenetic-{}", uuid::Uuid::new_v4().simple()));
    fs::create_dir_all(Path::new(ID_FILE).parent().unwrap()).map_err(|error| error.to_string())?;
    match fs::OpenOptions::new().write(true).create_new(true).mode(0o600).open(ID_FILE) {
        Ok(mut file) => {
            file.write_all(id.as_bytes()).and_then(|_| file.sync_all()).map_err(|error| error.to_string())?;
            Ok(id)
        },
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => read_saved(),
        Err(error) => Err(error.to_string()),
    }
}
