use super::*;
pub async fn install_assets() -> Result<(), String> {
    let assets: &[(&str, &[u8])] = &[
        ("fs_quic_google.bin", include_bytes!("../../router/nfqws2-blobs/fs_quic_google.bin")),
        ("fs_tls_max.bin", include_bytes!("../../router/nfqws2-blobs/fs_tls_max.bin")),
    ];
    let folder = format!("{ROOT}/nfqws2/blobs");
    tokio::fs::create_dir_all(&folder).await.map_err(|e| e.to_string())?;
    for (name, bytes) in assets {
        let path = format!("{folder}/{name}");
        if tokio::fs::read(&path).await.ok().as_deref() == Some(*bytes) { continue; }
        let next = format!("{path}.new");
        tokio::fs::write(&next, bytes).await.map_err(|e| e.to_string())?;
        tokio::fs::set_permissions(&next, std::fs::Permissions::from_mode(0o644)).await.map_err(|e| e.to_string())?;
        tokio::fs::rename(next, path).await.map_err(|e| e.to_string())?;
    }
    Ok(())
}
