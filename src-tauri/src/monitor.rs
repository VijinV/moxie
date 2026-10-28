//! Activity monitor: CPU (per core), memory, swap, network, disks, uptime and top processes,
//! for this machine (sysinfo) or for an SSH server (one `sh` probe per poll).

use crate::ssh_conn;
use russh::client;
use serde::Serialize;
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Instant;
use sysinfo::{Disks, Networks, ProcessesToUpdate, System};
use tauri::State;
use tokio::sync::Mutex as AsyncMutex;

// ---------------------------------------------------------------- local stats

pub struct MonitorState(Mutex<LocalInner>, AsyncMutex<RemoteCache>);

struct LocalInner {
    sys: System,
    nets: Networks,
    disks: Disks,
    prev_net: Option<(u64, u64, Instant)>,
    services: Vec<ServiceInfo>,
    services_last: Option<Instant>,
}

impl Default for MonitorState {
    fn default() -> Self {
        Self(
            Mutex::new(LocalInner {
                sys: System::new(),
                nets: Networks::new_with_refreshed_list(),
                disks: Disks::new_with_refreshed_list(),
                prev_net: None,
                services: Vec::new(),
                services_last: None,
            }),
            AsyncMutex::new(RemoteCache::default()),
        )
    }
}

#[derive(Serialize)]
pub struct Stats {
    cpu: f32,
    cores: Vec<f32>,
    mem_used: u64,
    mem_total: u64,
    swap_used: u64,
    swap_total: u64,
    net_rx: u64,
    net_tx: u64,
    procs: Vec<Proc>,
    load: [f64; 3],
    disks: Vec<Disk>,
    /// Seconds since boot.
    uptime: u64,
    host: String,
    os: String,
    services: Vec<ServiceInfo>,
}

#[derive(Serialize, Clone)]
pub struct ServiceInfo {
    name: String,
    version: String,
}

#[derive(Serialize)]
pub struct Proc {
    name: String,
    cpu: f32,
    mem_mb: u64,
}

#[derive(Serialize)]
pub struct Disk {
    mount: String,
    used: u64,
    total: u64,
}

// Shell snippet that probes installed service versions; outputs "name%version_line" per line.
// Used both for remote (embedded in PROBE) and local detection.
const SVC_PROBE: &str = "\
  command -v nginx >/dev/null 2>&1 && { v=$(nginx -v 2>&1 | head -1); echo \"nginx%$v\"; }; \
  command -v php >/dev/null 2>&1 && { v=$(php --version 2>/dev/null | head -1); echo \"php%$v\"; }; \
  command -v node >/dev/null 2>&1 && { v=$(node --version 2>/dev/null); echo \"node%$v\"; }; \
  command -v npm >/dev/null 2>&1 && { v=$(npm --version 2>/dev/null); echo \"npm%$v\"; }; \
  command -v python3 >/dev/null 2>&1 && { v=$(python3 --version 2>/dev/null); echo \"python%$v\"; }; \
  command -v ruby >/dev/null 2>&1 && { v=$(ruby --version 2>/dev/null | head -1); echo \"ruby%$v\"; }; \
  command -v mysql >/dev/null 2>&1 && { v=$(mysql --version 2>/dev/null | head -1); echo \"mysql%$v\"; }; \
  command -v psql >/dev/null 2>&1 && { v=$(psql --version 2>/dev/null); echo \"postgres%$v\"; }; \
  command -v redis-server >/dev/null 2>&1 && { v=$(redis-server --version 2>/dev/null); echo \"redis%$v\"; }; \
  command -v docker >/dev/null 2>&1 && { v=$(docker --version 2>/dev/null); echo \"docker%$v\"; }; \
  command -v java >/dev/null 2>&1 && { v=$(java -version 2>&1 | head -1); echo \"java%$v\"; }; \
  command -v go >/dev/null 2>&1 && { v=$(go version 2>/dev/null); echo \"go%$v\"; }; \
  command -v pm2 >/dev/null 2>&1 && { v=$(pm2 --version 2>/dev/null | head -1); echo \"pm2%$v\"; }; \
  : ";

/// Find the first `X.Y[.Z…]` version string in a raw version output line.
fn extract_version(s: &str) -> String {
    let b = s.as_bytes();
    for i in 0..b.len().saturating_sub(2) {
        if b[i].is_ascii_digit() && b[i + 1] == b'.' && b[i + 2].is_ascii_digit() {
            let end = b[i..]
                .iter()
                .position(|c| !c.is_ascii_alphanumeric() && *c != b'.' && *c != b'-')
                .map(|p| i + p)
                .unwrap_or(b.len());
            return s[i..end].to_string();
        }
    }
    s.trim().to_string()
}

fn parse_services(block: &str) -> Vec<ServiceInfo> {
    block
        .lines()
        .filter_map(|line| {
            let mut parts = line.splitn(2, '%');
            let name = parts.next()?.trim().to_string();
            if name.is_empty() { return None; }
            let raw = parts.next().unwrap_or("").trim().to_string();
            let version = extract_version(&raw);
            if version.is_empty() { return None; }
            Some(ServiceInfo { name, version })
        })
        .collect()
}

fn detect_local_services() -> Vec<ServiceInfo> {
    let out = std::process::Command::new("sh")
        .arg("-c")
        .arg(SVC_PROBE)
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).into_owned())
        .unwrap_or_default();
    parse_services(&out)
}

#[tauri::command]
pub fn get_stats(state: State<'_, MonitorState>) -> Stats {
    let mut g = state.0.lock().unwrap();
    let now = Instant::now();

    g.sys.refresh_cpu_usage();
    g.sys.refresh_memory();
    g.sys.refresh_processes(ProcessesToUpdate::All, true);
    g.nets.refresh(false);
    g.disks.refresh(false);

    let cpu = g.sys.global_cpu_usage();
    let cores: Vec<f32> = g.sys.cpus().iter().map(|c| c.cpu_usage()).collect();

    let (total_rx, total_tx): (u64, u64) = g
        .nets
        .iter()
        .fold((0, 0), |(rx, tx), (_, d)| (rx + d.received(), tx + d.transmitted()));

    let (net_rx, net_tx) = if let Some((prev_rx, prev_tx, prev_t)) = g.prev_net {
        let secs = now.duration_since(prev_t).as_secs_f64().max(0.1);
        (
            ((total_rx.saturating_sub(prev_rx)) as f64 / secs) as u64,
            ((total_tx.saturating_sub(prev_tx)) as f64 / secs) as u64,
        )
    } else {
        (0, 0)
    };
    g.prev_net = Some((total_rx, total_tx, now));

    let mut procs: Vec<Proc> = g
        .sys
        .processes()
        .values()
        .map(|p| Proc { name: p.name().to_string_lossy().to_string(), cpu: p.cpu_usage(), mem_mb: p.memory() / 1_048_576 })
        .collect();
    procs.sort_by(|a, b| b.cpu.partial_cmp(&a.cpu).unwrap_or(std::cmp::Ordering::Equal));
    procs.truncate(10);

    let disks = g
        .disks
        .iter()
        .filter(|d| d.total_space() > 0)
        .map(|d| Disk {
            mount: d.mount_point().to_string_lossy().trim_end_matches('\\').to_string(),
            used: d.total_space().saturating_sub(d.available_space()),
            total: d.total_space(),
        })
        .collect();

    // Refresh service versions at most once every 30 seconds (slow external commands).
    if g.services_last.map_or(true, |t| t.elapsed().as_secs() > 30) {
        g.services = detect_local_services();
        g.services_last = Some(Instant::now());
    }
    let services = g.services.clone();

    let la = System::load_average();
    Stats {
        cpu,
        cores,
        mem_used: g.sys.used_memory(),
        mem_total: g.sys.total_memory(),
        swap_used: g.sys.used_swap(),
        swap_total: g.sys.total_swap(),
        net_rx,
        net_tx,
        procs,
        load: [la.one, la.five, la.fifteen],
        disks,
        uptime: System::uptime(),
        host: System::host_name().unwrap_or_default(),
        os: System::long_os_version().unwrap_or_default(),
        services,
    }
}

// ---------------------------------------------------------------- remote stats

/// Per-server state between polls. `handle` is the monitor's own connection, used only when the
/// SFTP panel has no connection to share (that one already handles jump hosts and Bastion).
#[derive(Default)]
struct RemoteConn {
    handle: Option<client::Handle<ssh_conn::Client>>,
    // prev /proc/stat values (idle, total) for CPU% deltas: [0] = all CPUs, then one per core
    prev_cpu: Vec<(u64, u64)>,
    prev_net: Option<(u64, u64, Instant)>, // (rx, tx, time)
}

#[derive(Default)]
struct RemoteCache {
    conns: HashMap<String, RemoteConn>,
}

/// One-shot exec on an open russh handle. Returns stdout as a String.
async fn exec(handle: &mut client::Handle<ssh_conn::Client>, cmd: &str) -> Result<String, String> {
    let mut ch = handle.channel_open_session().await.map_err(|e| e.to_string())?;
    ch.exec(true, cmd).await.map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    loop {
        match ch.wait().await {
            None => break,
            Some(russh::ChannelMsg::Data { data }) => out.extend_from_slice(&data),
            Some(russh::ChannelMsg::Eof) => break,
            _ => {}
        }
    }
    Ok(String::from_utf8_lossy(&out).into_owned())
}

/// Sections separated by SPLIT lines, so a missing tool only leaves its section empty.
/// Sections: 0=cpu 1=mem 2=load 3=ps 4=net 5=df 6=uptime 7=host 8=os 9=services
const PROBE: &str = "{ grep '^cpu' /proc/stat; echo SPLIT; free -b 2>/dev/null; echo SPLIT; cat /proc/loadavg; \
echo SPLIT; ps --no-headers -eo comm,pcpu,rss --sort=-pcpu 2>/dev/null | head -10; echo SPLIT; cat /proc/net/dev 2>/dev/null; \
echo SPLIT; df -Pk 2>/dev/null | tail -n +2; echo SPLIT; cat /proc/uptime; echo SPLIT; hostname 2>/dev/null; \
echo SPLIT; (. /etc/os-release 2>/dev/null && echo \"$PRETTY_NAME\") || uname -sr; echo SPLIT; \
{ command -v nginx >/dev/null 2>&1 && { v=$(nginx -v 2>&1 | head -1); echo \"nginx%$v\"; }; \
  command -v php >/dev/null 2>&1 && { v=$(php --version 2>/dev/null | head -1); echo \"php%$v\"; }; \
  command -v node >/dev/null 2>&1 && { v=$(node --version 2>/dev/null); echo \"node%$v\"; }; \
  command -v npm >/dev/null 2>&1 && { v=$(npm --version 2>/dev/null); echo \"npm%$v\"; }; \
  command -v python3 >/dev/null 2>&1 && { v=$(python3 --version 2>/dev/null); echo \"python%$v\"; }; \
  command -v ruby >/dev/null 2>&1 && { v=$(ruby --version 2>/dev/null | head -1); echo \"ruby%$v\"; }; \
  command -v mysql >/dev/null 2>&1 && { v=$(mysql --version 2>/dev/null | head -1); echo \"mysql%$v\"; }; \
  command -v psql >/dev/null 2>&1 && { v=$(psql --version 2>/dev/null); echo \"postgres%$v\"; }; \
  command -v redis-server >/dev/null 2>&1 && { v=$(redis-server --version 2>/dev/null); echo \"redis%$v\"; }; \
  command -v docker >/dev/null 2>&1 && { v=$(docker --version 2>/dev/null); echo \"docker%$v\"; }; \
  command -v java >/dev/null 2>&1 && { v=$(java -version 2>&1 | head -1); echo \"java%$v\"; }; \
  command -v go >/dev/null 2>&1 && { v=$(go version 2>/dev/null); echo \"go%$v\"; }; \
  command -v pm2 >/dev/null 2>&1 && { v=$(pm2 --version 2>/dev/null | head -1); echo \"pm2%$v\"; }; \
  : ; }; }";

fn parse_remote(raw: &str, conn: &mut RemoteConn) -> Stats {
    let parts: Vec<&str> = raw.split("SPLIT\n").collect();
    let part = |i: usize| parts.get(i).copied().unwrap_or("");

    let (cpu, cores) = parse_proc_stat(part(0), conn);
    let (mem_used, mem_total, swap_used, swap_total) = parse_free(part(1));
    let load = parse_load(part(2).trim());
    let procs = parse_ps(part(3));
    let (net_rx, net_tx) = parse_net_dev(part(4), conn);
    let disks = parse_df(part(5));
    let uptime = part(6).split_whitespace().next().and_then(|s| s.parse::<f64>().ok()).unwrap_or(0.0) as u64;
    let services = parse_services(part(9));

    Stats {
        cpu,
        cores,
        mem_used,
        mem_total,
        swap_used,
        swap_total,
        net_rx,
        net_tx,
        procs,
        load,
        disks,
        uptime,
        host: part(7).trim().to_string(),
        os: part(8).trim().to_string(),
        services,
    }
}

/// `cpu  user nice system idle iowait irq softirq steal …`, then `cpu0 …`, `cpu1 …`.
fn parse_proc_stat(block: &str, conn: &mut RemoteConn) -> (f32, Vec<f32>) {
    let mut now = Vec::new();
    for line in block.lines() {
        let nums: Vec<u64> = line.split_whitespace().skip(1).filter_map(|n| n.parse().ok()).collect();
        if nums.len() < 4 {
            continue;
        }
        now.push((nums[3] + nums.get(4).copied().unwrap_or(0), nums.iter().sum::<u64>()));
    }
    let pct = |i: usize| -> f32 {
        let (Some(&(idle, total)), Some(&(prev_idle, prev_total))) = (now.get(i), conn.prev_cpu.get(i)) else { return 0.0 };
        let d_total = total.saturating_sub(prev_total) as f32;
        let d_idle = idle.saturating_sub(prev_idle) as f32;
        if d_total > 0.0 { ((1.0 - d_idle / d_total) * 100.0).clamp(0.0, 100.0) } else { 0.0 }
    };
    let cpu = pct(0);
    let cores = (1..now.len()).map(pct).collect();
    conn.prev_cpu = now;
    (cpu, cores)
}

fn parse_free(block: &str) -> (u64, u64, u64, u64) {
    let mut mem_total = 0u64;
    let mut mem_used = 0u64;
    let mut swap_total = 0u64;
    let mut swap_used = 0u64;
    for line in block.lines() {
        let parts: Vec<&str> = line.split_whitespace().collect();
        if parts.first() == Some(&"Mem:") {
            mem_total = parts.get(1).and_then(|n| n.parse().ok()).unwrap_or(0);
            mem_used  = parts.get(2).and_then(|n| n.parse().ok()).unwrap_or(0);
        } else if parts.first() == Some(&"Swap:") {
            swap_total = parts.get(1).and_then(|n| n.parse().ok()).unwrap_or(0);
            swap_used  = parts.get(2).and_then(|n| n.parse().ok()).unwrap_or(0);
        }
    }
    (mem_used, mem_total, swap_used, swap_total)
}

fn parse_load(line: &str) -> [f64; 3] {
    let ns: Vec<f64> = line.split_whitespace().take(3).filter_map(|n| n.parse().ok()).collect();
    [ns.first().copied().unwrap_or(0.0), ns.get(1).copied().unwrap_or(0.0), ns.get(2).copied().unwrap_or(0.0)]
}

fn parse_ps(block: &str) -> Vec<Proc> {
    block.lines()
        .filter_map(|line| {
            let mut p = line.split_whitespace();
            let name = p.next()?.to_string();
            let cpu: f32 = p.next()?.parse().ok()?;
            let rss_kb: u64 = p.next()?.parse().ok()?;
            Some(Proc { name, cpu, mem_mb: rss_kb / 1024 })
        })
        .collect()
}

fn parse_net_dev(block: &str, conn: &mut RemoteConn) -> (u64, u64) {
    let (mut rx, mut tx) = (0u64, 0u64);
    for line in block.lines().skip(2) {
        let line = line.trim();
        if line.starts_with("lo") { continue; }
        let rest = line.splitn(2, ':').nth(1).unwrap_or("").split_whitespace().collect::<Vec<_>>();
        rx += rest.first().and_then(|n| n.parse::<u64>().ok()).unwrap_or(0);
        tx += rest.get(8).and_then(|n| n.parse::<u64>().ok()).unwrap_or(0);
    }
    let now = Instant::now();
    let (out_rx, out_tx) = if let Some((prev_rx, prev_tx, prev_t)) = conn.prev_net {
        let secs = now.duration_since(prev_t).as_secs_f64().max(0.1);
        (((rx.saturating_sub(prev_rx)) as f64 / secs) as u64, ((tx.saturating_sub(prev_tx)) as f64 / secs) as u64)
    } else { (0, 0) };
    conn.prev_net = Some((rx, tx, now));
    (out_rx, out_tx)
}

/// `df -Pk`: filesystem 1024-blocks used available capacity mountpoint (pseudo filesystems skipped).
fn parse_df(block: &str) -> Vec<Disk> {
    block
        .lines()
        .filter_map(|line| {
            let c: Vec<&str> = line.split_whitespace().collect();
            if c.len() < 6 {
                return None;
            }
            let mount = c[5..].join(" ");
            let total: u64 = c[1].parse().ok()?;
            let skip = ["/proc", "/sys", "/dev", "/run", "/snap", "/boot/efi"];
            if total == 0 || !mount.starts_with('/') || skip.iter().any(|s| mount == *s || mount.starts_with(&format!("{s}/"))) {
                return None;
            }
            Some(Disk { mount, used: c[2].parse::<u64>().ok()? * 1024, total: total * 1024 })
        })
        .collect()
}

/// `conn_id`: the SFTP panel's connection for this tab, if it has one. Without it the monitor
/// opens its own (direct connections only).
#[tauri::command]
pub async fn get_remote_stats(
    state: State<'_, MonitorState>,
    sftp: State<'_, crate::sftp::SftpState>,
    host: String,
    port: u16,
    user: String,
    key_path: String,
    secret_key: Option<String>,
    conn_id: Option<String>,
) -> Result<Stats, String> {
    let key = format!("{user}@{host}:{port}");
    let mut cache = state.1.lock().await;
    let conn = cache.conns.entry(key.clone()).or_default();

    if let Some(id) = conn_id.as_deref().filter(|id| crate::sftp::is_connected(&sftp, id)) {
        let raw = crate::sftp::exec_on(&sftp, id, PROBE).await?;
        return Ok(parse_remote(&raw, conn));
    }

    if conn.handle.is_none() {
        let password = secret_key.as_deref().and_then(crate::secrets::get);
        conn.handle = Some(ssh_conn::connect(&host, port, &user, &key_path, password.as_deref(), None, None).await?);
    }
    let raw = match exec(conn.handle.as_mut().unwrap(), PROBE).await {
        Ok(r) => r,
        Err(_) => {
            cache.conns.remove(&key);
            return Err("connection lost".into());
        }
    };
    Ok(parse_remote(&raw, conn))
}
