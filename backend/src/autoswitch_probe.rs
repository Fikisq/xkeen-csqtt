use serde_json::{Value, json};
use std::{path::Path, process::Stdio, time::Duration};
use tokio::process::{Child, Command};

pub struct Prober {
    child: Child,
    directory: String,
    pub direct: String,
    pub reserve: String,
}
impl Prober {
    pub async fn start(target: &str) -> Result<Self, String> {
        let memory = std::fs::read_to_string("/proc/meminfo").unwrap_or_default();
        if memory
            .lines()
            .find_map(|l| {
                l.strip_prefix("MemAvailable:")?
                    .split_whitespace()
                    .next()?
                    .parse::<u64>()
                    .ok()
            })
            .unwrap_or(0)
            < 70000
        {
            return Err("Недостаточно свободной RAM для проверки".into());
        }
        let a = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .map_err(|e| e.to_string())?;
        let b = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .map_err(|e| e.to_string())?;
        let pa = a.local_addr().map_err(|e| e.to_string())?.port();
        let pb = b.local_addr().map_err(|e| e.to_string())?.port();
        let directory = format!("/tmp/xkeen-autoswitch-{}", uuid::Uuid::new_v4());
        std::fs::create_dir(&directory).map_err(|e| e.to_string())?;
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&directory, std::fs::Permissions::from_mode(0o700)).map_err(|e| e.to_string())?;
        let binary = if Path::new("/opt/sbin/xray").exists() {
            "xray"
        } else {
            "mihomo"
        };
        let config = if binary == "xray" {
            let reserve = if target == "csqtt" {
                json!({"tag":"reserve","protocol":"freedom","streamSettings":{"sockopt":{"mark":255,"interface":"csqtt0"}}})
            } else {
                json!({"tag":"reserve","protocol":"socks","settings":{"servers":[{"address":"127.0.0.1","port":1088}]},"streamSettings":{"sockopt":{"mark":255}}})
            };
            serde_json::to_string(&json!({"log":{"loglevel":"none"},"inbounds":[{"tag":"wan","listen":"127.0.0.1","port":pa,"protocol":"http"},{"tag":"backup","listen":"127.0.0.1","port":pb,"protocol":"http"}],"outbounds":[{"tag":"wan","protocol":"freedom","streamSettings":{"sockopt":{"mark":255}}},reserve],"routing":{"rules":[{"type":"field","inboundTag":["backup"],"outboundTag":"reserve"}]}})).map_err(|e| e.to_string())?
        } else {
            let reserve = if target == "csqtt" {
                "type: direct\n    interface-name: csqtt0"
            } else {
                "type: socks5\n    server: 127.0.0.1\n    port: 1088"
            };
            format!(
                "mixed-port: 0\nallow-lan: false\nbind-address: 127.0.0.1\nrouting-mark: 255\nlog-level: silent\nmode: rule\nlisteners:\n  - name: wan\n    type: http\n    listen: 127.0.0.1\n    port: {pa}\n    proxy: DIRECT\n  - name: backup\n    type: http\n    listen: 127.0.0.1\n    port: {pb}\n    proxy: reserve\nproxies:\n  - name: reserve\n    {reserve}\nrules:\n  - MATCH,DIRECT\n"
            )
        };
        let path = format!("{directory}/config.{}", if binary == "xray" { "json" } else { "yaml" });
        std::fs::write(&path, config).map_err(|e| e.to_string())?;
        drop((a, b));
        let mut command = Command::new(format!("/opt/sbin/{binary}"));
        if binary == "xray" {
            command.args(["run", "-c", &path]);
        } else {
            command.args(["-d", &directory, "-f", &path]);
        }
        let child = match command
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .stdin(Stdio::null())
            .kill_on_drop(true)
            .spawn()
        {
            Ok(child) => child,
            Err(e) => {
                let _ = std::fs::remove_dir_all(&directory);
                return Err(e.to_string());
            }
        };
        let mut this = Self {
            child,
            directory,
            direct: format!("http://127.0.0.1:{pa}"),
            reserve: format!("http://127.0.0.1:{pb}"),
        };
        for _ in 0..30 {
            if tokio::net::TcpStream::connect(("127.0.0.1", pa)).await.is_ok() {
                return Ok(this);
            }
            if this.child.try_wait().ok().flatten().is_some() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        Err("Проверочный прокси не запустился".into())
    }
    pub async fn check(&self, urls: &[String], backup: bool) -> Vec<Value> {
        let proxy = if backup { &self.reserve } else { &self.direct };
        let mut tasks = tokio::task::JoinSet::new();
        for url in urls {
            let url = url.clone();
            let proxy = proxy.clone();
            tasks.spawn(async move {
                let started = std::time::Instant::now();
                let output = tokio::time::timeout(
                    Duration::from_secs(9),
                    Command::new("/opt/bin/curl")
                        .args([
                            "--silent",
                            "--location",
                            "--max-redirs",
                            "4",
                            "--proto-redir",
                            "=https",
                            "--range",
                            "0-65535",
                            "--max-filesize",
                            "65536",
                            "--output",
                            "/dev/null",
                            "--write-out",
                            "%{http_code}",
                            "--connect-timeout",
                            "4",
                            "--max-time",
                            "7",
                            "--proxy",
                            &proxy,
                            "--noproxy",
                            "",
                            &url,
                        ])
                        .kill_on_drop(true)
                        .output(),
                )
                .await;
                let (ok, code) = match output {
                    Ok(Ok(out)) => {
                        let code = String::from_utf8_lossy(&out.stdout).trim().parse::<u16>().unwrap_or(0);
                        // A size-limited GET can stop at the final response headers (curl 63).
                        // This proves HTTPS reachability without downloading the whole page.
                        let reached = out.status.success() || out.status.code() == Some(63);
                        (reached && (200..300).contains(&code), code)
                    }
                    _ => (false, 0),
                };
                json!({"url":url,"ok":ok,"code":code,"ms":started.elapsed().as_millis()})
            });
        }
        let mut rows = Vec::new();
        while let Some(row) = tasks.join_next().await {
            if let Ok(row) = row {
                rows.push(row)
            }
        }
        rows.sort_by_key(|r| r["url"].as_str().unwrap_or("").to_owned());
        rows
    }
}
impl Drop for Prober {
    fn drop(&mut self) {
        let _ = self.child.start_kill();
        let _ = std::fs::remove_dir_all(&self.directory);
    }
}
