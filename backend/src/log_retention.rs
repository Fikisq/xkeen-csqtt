use crate::{logger::log, types::access_log_path};
use std::{fs::OpenOptions, time::Duration};

const ACCESS_LOG_LIMIT: u64 = 5 * 1024 * 1024;

pub fn start() {
    tokio::spawn(async {
        let mut timer = tokio::time::interval(Duration::from_secs(5));
        loop {
            timer.tick().await;
            let result = tokio::task::spawn_blocking(|| {
                let path = access_log_path();
                let file = OpenOptions::new().write(true).open(&path)?;
                if file.metadata()?.len() >= ACCESS_LOG_LIMIT {
                    // Preserve the inode: Xray keeps writing through its open descriptor.
                    file.set_len(0)?;
                    log("INFO", "access.log очищен: достигнут лимит 5 МБ".into());
                }
                Ok::<(), std::io::Error>(())
            }).await;
            match result {
                Ok(Err(error)) if error.kind() != std::io::ErrorKind::NotFound =>
                    log("WARN", format!("Не удалось ограничить access.log: {error}")),
                Err(error) => log("WARN", format!("Ошибка обслуживания access.log: {error}")),
                _ => {}
            }
        }
    });
}
