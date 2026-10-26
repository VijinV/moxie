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
}

impl Default for MonitorState {
    fn default() -> Self {
        Self(
            Mutex::new(LocalInner {
                sys: System::new(),
                nets: Networks::new_with_refreshed_list(),
                disks: Disks::new_with_refreshed_list(),
                prev_net: None,
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
const PROBE: &str = "{ grep '^cpu' /proc/stat; echo SPLIT; free -b 2>/dev/null; echo SPLIT; cat /proc/loadavg; \
echo SPLIT; ps --no-headers -eo comm,pcpu,rss --sort=-pcpu 2>/dev/null | head -10; echo SPLIT; cat /proc/net/dev 2>/dev/null; \
echo SPLIT; df -Pk 2>/dev/null | tail -n +2; echo SPLIT; cat /proc/uptime; echo SPLIT; hostname 2>/dev/null; \
echo SPLIT; (. /etc/os-release 2>/dev/null && echo \"$PRETTY_NAME\") || uname -sr; }";

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
