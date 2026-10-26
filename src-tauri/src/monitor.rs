use crate::ssh_conn;
use russh::client;
use serde::Serialize;
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Instant;
use sysinfo::{Networks, ProcessesToUpdate, System};
use tauri::State;
use tokio::sync::Mutex as AsyncMutex;

// ---------------------------------------------------------------- local stats

pub struct MonitorState(Mutex<LocalInner>, AsyncMutex<RemoteCache>);

struct LocalInner {
    sys: System,
    nets: Networks,
    prev_net: Option<(u64, u64, Instant)>,
}

impl Default for MonitorState {
    fn default() -> Self {
        Self(
            Mutex::new(LocalInner { sys: System::new(), nets: Networks::new_with_refreshed_list(), prev_net: None }),
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
}

#[derive(Serialize)]
pub struct Proc {
    name: String,
    cpu: f32,
    mem_mb: u64,
}

#[tauri::command]
pub fn get_stats(state: State<'_, MonitorState>) -> Stats {
    let mut g = state.0.lock().unwrap();
    let now = Instant::now();

    g.sys.refresh_cpu_usage();
    g.sys.refresh_memory();
    g.sys.refresh_processes(ProcessesToUpdate::All, true);
    g.nets.refresh(false);

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

    let la = System::load_average();
    Stats { cpu, cores, mem_used: g.sys.used_memory(), mem_total: g.sys.total_memory(), swap_used: g.sys.used_swap(), swap_total: g.sys.total_swap(), net_rx, net_tx, procs, load: [la.one, la.five, la.fifteen] }
}

// ---------------------------------------------------------------- remote stats

struct RemoteConn {
    handle: client::Handle<ssh_conn::Client>,
    _jump: Option<client::Handle<ssh_conn::Client>>,
    prev_cpu: Option<(u64, u64)>,
    prev_net: Option<(u64, u64, Instant)>,
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
    String::from_utf8_lossy(&out).into_owned().pipe(Ok)
}

trait Pipe: Sized { fn pipe<F: FnOnce(Self) -> R, R>(self, f: F) -> R { f(self) } }
impl<T> Pipe for T {}

fn parse_remote(raw: &str, conn: &mut RemoteConn) -> Stats {
    let parts: Vec<&str> = raw.split("SPLIT\n").collect();
    let cpu_line  = parts.first().map(|s| s.trim()).unwrap_or("");
    let mem_block = parts.get(1).copied().unwrap_or("");
    let load_line = parts.get(2).map(|s| s.trim()).unwrap_or("");
    let ps_block  = parts.get(3).copied().unwrap_or("");
    let net_block = parts.get(4).copied().unwrap_or("");

    // CPU from /proc/stat: cpu user nice system idle iowait irq softirq ...
    let (cpu, cores) = parse_proc_stat(cpu_line, conn);

    // Memory from `free -b`
    let (mem_used, mem_total, swap_used, swap_total) = parse_free(mem_block);

    // Load average
    let load = parse_load(load_line);

    // Processes from `ps`
    let procs = parse_ps(ps_block);

    // Network from /proc/net/dev
    let (net_rx, net_tx) = parse_net_dev(net_block, conn);

    Stats { cpu, cores, mem_used, mem_total, swap_used, swap_total, net_rx, net_tx, procs, load }
}

fn parse_proc_stat(line: &str, conn: &mut RemoteConn) -> (f32, Vec<f32>) {
    // `cpu  user nice system idle iowait irq softirq steal guest guest_nice`
    let nums: Vec<u64> = line.split_whitespace().skip(1).filter_map(|n| n.parse().ok()).collect();
    if nums.len() < 4 { return (0.0, vec![]); }
    let idle = nums.get(3).copied().unwrap_or(0) + nums.get(4).copied().unwrap_or(0);
    let total: u64 = nums.iter().sum();
    let cpu = if let Some((prev_idle, prev_total)) = conn.prev_cpu {
        let d_total = total.saturating_sub(prev_total) as f32;
        let d_idle = idle.saturating_sub(prev_idle) as f32;
        if d_total > 0.0 { (1.0 - d_idle / d_total) * 100.0 } else { 0.0 }
    } else { 0.0 };
    conn.prev_cpu = Some((idle, total));
    (cpu, vec![]) // individual cores need separate lines; skip for now
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

#[tauri::command]
pub async fn get_remote_stats(
    state: State<'_, MonitorState>,
    host: String,
    port: u16,
    user: String,
    key_path: String,
    secret_key: Option<String>,
    jump: Option<String>,
    jump_key_path: Option<String>,
    jump_secret_key: Option<String>,
) -> Result<Stats, String> {
    let key = format!("{user}@{host}:{port}{}", jump.as_deref().map(|j| format!(" via {j}")).unwrap_or_default());
    let password = secret_key.as_deref().and_then(crate::secrets::get);
    let target_port = port;

    let mut cache = state.1.lock().await;

    if !cache.conns.contains_key(&key) {
        let jump_key = jump_key_path.as_deref().filter(|k| !k.is_empty());
        let jump_password = jump_secret_key.as_deref().and_then(crate::secrets::get);

        let (handle, _jump) = if let Some(ref spec) = jump.filter(|j| !j.trim().is_empty()) {
            let (mut h, jh) = ssh_conn::connect_via_jump(
                spec,
                &host,
                target_port,
                &host,
                target_port,
                None,
                &user,
                &key_path,
                password.as_deref(),
                jump_key,
                jump_password.as_deref(),
            )
            .await?;
            let ok = ssh_conn::authenticate(&mut h, &user, &key_path, password.as_deref())
                .await
                .map_err(|e| format!("authentication error: {e}"))?;
            if !ok {
                return Err(if password.is_some() { "AUTH_FAILED".into() } else { "AUTH_NEED_PASSWORD".into() });
            }
            (h, Some(jh))
        } else {
            let h = ssh_conn::connect(&host, target_port, &user, &key_path, password.as_deref(), None, None).await?;
            (h, None)
        };

        cache.conns.insert(key.clone(), RemoteConn { handle, _jump, prev_cpu: None, prev_net: None });
    }

    let cmd = "{ cat /proc/stat | head -1; echo SPLIT; free -b 2>/dev/null; echo SPLIT; cat /proc/loadavg; echo SPLIT; ps --no-headers -eo comm,pcpu,rss --sort=-pcpu 2>/dev/null | head -10; echo SPLIT; cat /proc/net/dev 2>/dev/null; }";

    let conn = cache.conns.get_mut(&key).ok_or("lost connection")?;
    let raw = match exec(&mut conn.handle, cmd).await {
        Ok(r) => r,
        Err(_) => {
            cache.conns.remove(&key);
            return Err("connection lost".into());
        }
    };
    Ok(parse_remote(&raw, conn))
}
