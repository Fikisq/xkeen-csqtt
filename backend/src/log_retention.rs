use crate::{logger::log, log_sources};
use std::{fs::OpenOptions, time::Duration};

const LOG_LIMIT: u64 = 5 * 1024 * 1024;

fn limit_log(path: &str, label: &str) -> std::io::Result<()> {
    let file = OpenOptions::new().write(true).open(path)?;
    let metadata = file.metadata()?;
    if metadata.is_file() && metadata.len() >= LOG_LIMIT {
        // Preserve the inode: running services retain their open descriptors.
        file.set_len(0)?;
        log("INFO", format!("{label} очищен: достигнут лимит 5 МиБ"));
    }
    Ok(())
}

pub fn start() {
    tokio::spawn(async {
        let mut timer = tokio::time::interval(Duration::from_secs(5));
        loop {
            timer.tick().await;
            let result = tokio::task::spawn_blocking(|| {
                for (label, path) in log_sources::sources() {
                    match limit_log(&path, label) {
                        Err(error) if error.kind() != std::io::ErrorKind::NotFound =>
                            log("WARN", format!("Не удалось ограничить {label}: {error}")),
                        _ => {}
                    }
                }
            }).await;
            if let Err(error) = result {
                log("WARN", format!("Ошибка обслуживания логов: {error}"));
            }
        }
    });
}
