use base64::{Engine, engine::general_purpose::STANDARD};
use flate2::read::GzDecoder;
use serde_json::{Value, json};
use std::{env, fs::{self, File, OpenOptions}, io::{self, Read, Seek, SeekFrom, Write}, net::Ipv4Addr, os::unix::fs::{OpenOptionsExt, PermissionsExt, MetadataExt}, path::{Path, PathBuf}, process::Command, thread, time::{Duration, Instant}};

const MAX_LINE: usize = 256 * 1024;
const MAX_COMMAND: usize = 4000;
type Result<T> = std::result::Result<T, String>;

struct Options {
    log: PathBuf,
    fifo: PathBuf,
    dns: PathBuf,
    local: Option<PathBuf>,
    offset: Option<u64>,
}

fn options() -> Result<Options> {
    let mut args = env::args().skip(1);
    let mut log = None;
    let mut fifo = None;
    let mut dns = PathBuf::from("/opt/csqtt250/internet-dns.json");
    let mut local = None;
    let mut offset = None;
    while let Some(key) = args.next() {
        let value = args.next().ok_or_else(|| format!("missing value for {key}"))?;
        match key.as_str() {
            "--log" => log = Some(PathBuf::from(value)),
            "--fifo" => fifo = Some(PathBuf::from(value)),
            "--dns-state" => dns = PathBuf::from(value),
            "--local-routing" => local = Some(PathBuf::from(value)),
            "--start-offset" => offset = Some(value.parse().map_err(|_| "invalid start offset")?),
            _ => return Err(format!("unknown argument {key}")),
        }
    }
    Ok(Options { log: log.ok_or("--log required")?, fifo: fifo.ok_or("--fifo required")?, dns, local, offset })
}

#[derive(Clone, PartialEq)]
struct Routing {
    enabled: bool,
    ru: bool,
    template: bool,
    whitelist: bool,
    domains: Vec<String>,
    ip_enabled: bool,
    ip_whitelist: bool,
    ips: Vec<String>,
}

impl Routing {
    fn disabled() -> Self {
        Self { enabled: false, ru: false, template: false, whitelist: false, domains: vec![], ip_enabled: false, ip_whitelist: false, ips: vec![] }
    }

    fn server(v: &Value) -> Result<Self> {
        if !v.is_object() { return Err("routing must be a JSON object".into()); }
        let domains = entries(v, "domains", false)?;
        let ips = entries(v, "ips", true)?;
        let template = boolean(v, "template_domains", false)?;
        let whitelist = boolean(v, "domains_is_whitelist", v.get("mode").and_then(Value::as_str) == Some("whitelist"))?;
        let ip_whitelist = boolean(v, "ip_is_whitelist", v.get("ip_mode").and_then(Value::as_str) == Some("whitelist"))?;
        Ok(Self { enabled: template || !domains.is_empty(), ru: false, template, whitelist, domains, ip_enabled: !ips.is_empty(), ip_whitelist, ips })
    }

    fn local(v: &Value) -> Result<Self> {
        if !v.is_object() { return Err("local routing must be a JSON object".into()); }
        let domains = entries(v, "domains", false)?;
        let ips = entries(v, "ips", true)?;
        Ok(Self {
            enabled: boolean(v, "enabled", false)?, ru: boolean(v, "ru", false)?,
            template: boolean(v, "template", false)?, whitelist: boolean(v, "whitelist", false)?,
            domains, ip_enabled: boolean(v, "ip_enabled", false)?,
            ip_whitelist: boolean(v, "ip_whitelist", false)?, ips,
        })
    }

    fn command(&self) -> Result<Vec<u8>> {
        let b = |v: bool| if v { 1 } else { 0 };
        let line = format!("UPDATE_DOMAINS|enabled={};ru={};template={};whitelist={};domains={};ip_enabled={};ip_whitelist={};ips={}\n",
            b(self.enabled), b(self.ru), b(self.template), b(self.whitelist), self.domains.join(","), b(self.ip_enabled), b(self.ip_whitelist), self.ips.join(","));
        if line.len() > MAX_COMMAND { return Err("routing command exceeds atomic FIFO limit; previous routes retained".into()); }
        Ok(line.into_bytes())
    }
}

fn boolean(v: &Value, key: &str, default: bool) -> Result<bool> {
    match v.get(key) {
        None | Some(Value::Null) => Ok(default),
        Some(Value::Bool(x)) => Ok(*x),
        Some(Value::String(x)) if x.eq_ignore_ascii_case("true") => Ok(true),
        Some(Value::String(x)) if x.eq_ignore_ascii_case("false") => Ok(false),
        _ => Err(format!("invalid boolean {key}")),
    }
}

fn entries(v: &Value, key: &str, ip: bool) -> Result<Vec<String>> {
    let Some(value) = v.get(key) else { return Ok(vec![]); };
    if value.is_null() { return Ok(vec![]); }
    let list = value.as_array().ok_or_else(|| format!("{key} must be an array"))?;
    let mut result = vec![];
    for item in list {
        let s = item.as_str().ok_or_else(|| format!("{key} contains a non-string"))?.trim();
        if s.is_empty() { continue; }
        // Values share a semicolon-delimited, newline-terminated native command.
        if s.chars().any(|c| c.is_control() || matches!(c, ';' | ',' | '|')) {
            return Err(format!("unsafe delimiter in {key}"));
        }
        if ip { validate_ipv4_network(s)?; }
        result.push(s.to_owned());
    }
    Ok(result)
}

fn validate_ipv4_network(s: &str) -> Result<()> {
    let mut fields = s.split('/');
    fields.next().unwrap_or_default().parse::<Ipv4Addr>().map_err(|_| "invalid routing IPv4")?;
    if let Some(mask) = fields.next() {
        if mask.parse::<u8>().map_err(|_| "invalid IPv4 prefix")? > 32 { return Err("IPv4 prefix exceeds32".into()); }
    }
    if fields.next().is_some() { return Err("extra IPv4 prefix separator".into()); }
    Ok(())
}

fn decode_routing(encoded: &str) -> Result<Value> {
    // Android Base64.DEFAULT ignores ASCII whitespace.
    let clean: String = encoded.chars().filter(|c| !c.is_ascii_whitespace()).collect();
    let bytes = STANDARD.decode(&clean).or_else(|_| base64::engine::general_purpose::STANDARD_NO_PAD.decode(&clean)).map_err(|_| "invalid routing base64")?;
    let decoded = if bytes.starts_with(&[0x1f, 0x8b]) {
        let mut data = vec![];
        GzDecoder::new(bytes.as_slice()).take((MAX_LINE + 1) as u64).read_to_end(&mut data).map_err(|_| "invalid routing gzip")?;
        data
    } else { bytes };
    if decoded.len() > MAX_LINE { return Err("routing payload exceeds256KiB".into()); }
    serde_json::from_slice(&decoded).map_err(|_| "invalid routing JSON".into())
}

struct State {
    fifo: File,
    dns_path: PathBuf,
    local: Routing,
    applied_routing: Option<Routing>,
    last_config: Option<String>,
    last_routing: Option<String>, pending_config: Option<(String, u8, Instant)>,
}

impl State {
    fn apply_routing(&mut self, rule: Routing) -> Result<()> {
        if self.applied_routing.as_ref() == Some(&rule) { return Ok(()); }
        let command = rule.command()?;
        match self.fifo.write(&command) {
            Ok(n) if n == command.len() => { self.applied_routing = Some(rule); Ok(()) },
            Ok(_) => Err("short atomic FIFO write".into()),
            Err(e) => Err(format!("routing FIFO write failed: {e}")),
        }
    }

    fn config(&mut self, text: &str) -> Result<()> {
        if self.last_config.as_deref() == Some(text) { return Ok(()); }
        let value = text.strip_prefix("TUNCONF:").ok_or("unknown config prefix")?;
        let fields: Vec<&str> = value.splitn(5, ':').collect();
        let ip = fields.first().ok_or("missing TUN IP")?.trim().parse::<Ipv4Addr>().map_err(|_| "invalid TUN IPv4")?;
        let dns_input = fields.get(1).ok_or("missing TUN DNS")?.trim();
        if dns_input.is_empty() { return Err("empty TUN DNS".into()); }
        let mut dns: Vec<String> = dns_input.split(',').filter_map(|s| s.trim().parse::<Ipv4Addr>().ok()).map(|v| v.to_string()).collect();
        if dns.is_empty() { dns.push("77.88.8.8".into()); }
        let route = match fields.get(4).map(|s| s.trim()).filter(|s| !s.is_empty()) {
            Some(encoded) => Routing::server(&decode_routing(encoded)?)?,
            None => self.local.clone(),
        };
        // Validate size before making any platform mutation.
        route.command()?;
        let status = Command::new("/opt/sbin/ip").args(["addr", "replace", &format!("{ip}/32"), "dev", "csqtt0"]).status().map_err(|e| format!("ip invocation failed: {e}"))?;
        if !status.success() { return Err(format!("ip address assignment failed: {status}")); }
        persist_dns(&self.dns_path, &json!({"version":1,"client_ip":ip.to_string(),"ip":ip.to_string(),"dns":dns,"dns_csv":dns.join(","),"source":"server"}))?;
        self.apply_routing(route)?;
        self.last_config = Some(text.to_owned()); self.pending_config = None;
        self.last_routing = None;
        eprintln!("native-events: server IP/DNS and routing applied");
        Ok(())
    }

    fn event(&mut self, line: &[u8]) -> Result<()> {
        let line = std::str::from_utf8(line).map_err(|_| "non-UTF8 log line")?.trim_end_matches('\r');
        let Some(event) = line.strip_prefix("__CSQTT_EVENT__|") else { return Ok(()); };
        let (kind, payload) = event.split_once('|').ok_or("missing event payload")?;
        if kind != "CONFIG" && kind != "ROUTING" { return Ok(()); }
        let value: Value = serde_json::from_str(payload).map_err(|_| "malformed native event JSON")?;
        match kind {
            "CONFIG" => {
                let text = value.get("config").and_then(Value::as_str).ok_or("missing CONFIG string")?;
                self.pending_config = None;
                match self.config(text) {
                    Err(e) if e.starts_with("ip ") || e.starts_with("DNS ") || e.starts_with("routing FIFO") => {
                        self.pending_config = Some((text.to_owned(), 20, Instant::now() + Duration::from_millis(500)));
                        Err(e)
                    }
                    result => result,
                }
            },
            "ROUTING" => {
                let raw = value.get("routing").and_then(Value::as_str).ok_or("missing ROUTING string")?;
                if self.last_routing.as_deref() == Some(raw) { return Ok(()); }
                let rule: Value = serde_json::from_str(raw).map_err(|_| "invalid ROUTING JSON")?;
                self.apply_routing(Routing::server(&rule)?)?;
                self.last_routing = Some(raw.to_owned());
                Ok(())
            }
            "CAPTCHA_REQUEST" => persist_dns(&self.dns_path.with_file_name("captcha.json"), &value),
            "CAPTCHA_DONE" | "STOPPED" => {
                let _ = fs::remove_file(self.dns_path.with_file_name("captcha.json"));
                Ok(())
            }
            _ => Ok(()),
        }
    }
}

fn persist_dns(path: &Path, value: &Value) -> Result<()> {
    let parent = path.parent().ok_or("DNS state needs parent directory")?;
    let temporary = parent.join(format!(".internet-dns.{}.tmp", std::process::id()));
    let bytes = serde_json::to_vec(value).map_err(|_| "cannot encode DNS state")?;
    let mut file = OpenOptions::new().write(true).create_new(true).mode(0o600).open(&temporary).map_err(|e| format!("DNS temporary file: {e}"))?;
    let operation = (|| -> io::Result<()> {
        file.write_all(&bytes)?;
        file.write_all(b"\n")?;
        file.sync_all()?;
        fs::set_permissions(&temporary, fs::Permissions::from_mode(0o600))?;
        fs::rename(&temporary, path)?;
        File::open(parent)?.sync_all()?;
        Ok(())
    })();
    if operation.is_err() { let _ = fs::remove_file(&temporary); }
    operation.map_err(|e| format!("DNS state persistence failed: {e}"))
}

fn run() -> Result<()> {
    let options = options()?;
    use std::os::unix::fs::FileTypeExt;
    let meta = fs::symlink_metadata(&options.fifo).map_err(|e| format!("FIFO metadata: {e}"))?;
    if !meta.file_type().is_fifo() { return Err("--fifo must name an existing FIFO, not a symlink/file".into()); }
    // RDWR prevents EOF between native restarts; NONBLOCK prevents a stalled core
    // from wedging this adapter. Commands fit Linux PIPE_BUF for atomic writes.
    let fifo = OpenOptions::new().read(true).write(true).custom_flags(libc::O_NONBLOCK | libc::O_NOFOLLOW).open(&options.fifo).map_err(|e| format!("FIFO open: {e}"))?;
    let local = if let Some(path) = options.local {
        let mut bytes = vec![];
        File::open(path).map_err(|e| format!("local config: {e}"))?.take((MAX_LINE + 1) as u64).read_to_end(&mut bytes).map_err(|e| e.to_string())?;
        if bytes.len() > MAX_LINE { return Err("local config exceeds256KiB".into()); }
        Routing::local(&serde_json::from_slice(&bytes).map_err(|_| "invalid local routing JSON")?)?
    } else { Routing::disabled() };
    local.command()?;
    let mut state = State { fifo, dns_path: options.dns, local, applied_routing: None, last_config: None, last_routing: None, pending_config: None };
    let mut offset = options.offset.unwrap_or_else(|| fs::metadata(&options.log).map(|m| m.len()).unwrap_or(0));
    let mut pending = vec![];
    let mut log_identity = None;
    let mut discard = false;
    let mut buffer = [0u8; 8192];
    loop {
        if let Ok(mut file) = File::open(&options.log) {
            let metadata = file.metadata().map_err(|e| e.to_string())?;
            let identity = (metadata.dev(), metadata.ino());
            if log_identity.is_some_and(|old| old != identity) { offset = 0; pending.clear(); discard = false; }
            log_identity = Some(identity);
            let len = metadata.len();
            if len < offset { offset = 0; pending.clear(); discard = false; }
            file.seek(SeekFrom::Start(offset)).map_err(|e| e.to_string())?;
            loop {
                let n = file.read(&mut buffer).map_err(|e| e.to_string())?;
                if n == 0 { break; }
                offset += n as u64;
                for byte in &buffer[..n] {
                    if *byte == b'\n' {
                        if !discard { if let Err(e) = state.event(&pending) { eprintln!("native-events: {e}"); } }
                        pending.clear(); discard = false;
                    } else if !discard {
                        if pending.len() == MAX_LINE {
                            eprintln!("native-events: oversized log line discarded");
                            pending.clear(); discard = true;
                        } else { pending.push(*byte); }
                    }
                }
            }
        }
        if let Some((text, retries, due)) = state.pending_config.clone() {
            if Instant::now() >= due {
                if let Err(error) = state.config(&text) {
                    if retries > 1 {
                        state.pending_config = Some((text, retries - 1, Instant::now() + Duration::from_millis(500)));
                    } else {
                        state.pending_config = None;
                        eprintln!("native-events: CONFIG retries exhausted: {error}");
                    }
                }
            }
        }
        thread::sleep(Duration::from_millis(200));
    }
}

fn main() {
    if let Err(error) = run() { eprintln!("native-events: {error}"); std::process::exit(1); }
}
