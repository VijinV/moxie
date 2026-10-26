//! Azure Bastion: runs `az network bastion tunnel` to forward a local port to the VM's
//! port 22. The terminal (system ssh) and the SFTP panel both connect to 127.0.0.1:<port>.
//! One tunnel per saved session, shared by every tab opened from it (ref-counted).
//!
//! Requires the Azure CLI (`az login` done, `bastion` extension) and a Bastion Standard/Premium
//! SKU with native client support enabled.

use crate::config::load_settings;
use std::collections::HashMap;
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::State;
use tokio::io::{AsyncBufReadExt, AsyncRead, BufReader};
use tokio::process::Child;

struct Tunnel {
    child: Child,
    port: u16,
    refs: u32,
}

#[derive(Default)]
pub struct BastionState {
    tunnels: Mutex<HashMap<String, Tunnel>>,
}

/// Arguments reach `az` through `cmd /c az.cmd` on Windows, so only allow characters that
/// Azure names/IDs use and that cmd.exe can't interpret.
fn valid_arg(s: &str) -> bool {
    !s.is_empty() && s.chars().all(|c| c.is_ascii_alphanumeric() || "._()/-".contains(c))
}

fn free_port() -> Result<u16, String> {
    let l = std::net::TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
    Ok(l.local_addr().map_err(|e| e.to_string())?.port())
}

/// az is a .cmd wrapper around Python on Windows: killing only the top process would leave
/// the tunnel running, so kill the whole tree.
fn kill_tree(child: &mut Child) {
    if let Some(pid) = child.id() {
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            let _ = std::process::Command::new("taskkill")
                .args(["/PID", &pid.to_string(), "/T", "/F"])
                .creation_flags(0x0800_0000)
                .status();
        }
        #[cfg(not(windows))]
        let _ = pid;
    }
    let _ = child.start_kill();
}

fn drain<R: AsyncRead + Unpin + Send + 'static>(stream: R, log: Arc<Mutex<String>>, ready: Option<tokio::sync::oneshot::Sender<()>>) {
    tokio::spawn(async move {
        let mut ready = ready;
        let mut lines = BufReader::new(stream).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            if line.to_lowercase().contains("tunnel is ready") {
                if let Some(tx) = ready.take() {
                    let _ = tx.send(());
                }
            }
            let mut l = log.lock().unwrap();
            l.push_str(&line);
            l.push('\n');
            if l.len() > 8000 {
                let cut = l.len() - 4000;
                l.drain(..cut);
            }
        }
    });
}

/// Starts (or reuses) the tunnel for `key` and returns the local port.
#[tauri::command]
pub async fn bastion_tunnel_start(
    state: State<'_, BastionState>,
    key: String,
    name: String,
    resource_group: String,
    target_id: String,
    subscription: Option<String>,
) -> Result<u16, String> {
    {
        let mut tunnels = state.tunnels.lock().unwrap();
        if let Some(t) = tunnels.get_mut(&key) {
            if matches!(t.child.try_wait(), Ok(None)) {
                t.refs += 1;
                return Ok(t.port);
            }
            tunnels.remove(&key);
        }
    }

    let subscription = subscription.filter(|s| !s.trim().is_empty());
    for (label, v) in [("Bastion name", Some(&name)), ("Resource group", Some(&resource_group)), ("VM resource ID", Some(&target_id)), ("Subscription", subscription.as_ref())] {
        if let Some(v) = v {
            if !valid_arg(v.trim()) {
                return Err(format!("{label} contains characters that aren't allowed: {v}"));
            }
        }
    }

    let settings = load_settings();
    let custom = settings.az_cli_path.trim().to_string();
    if custom.is_empty() && which::which("az").is_err() {
        return Err("AZ_NOT_FOUND".into());
    }
    let program = if custom.is_empty() { "az".to_string() } else { custom };
    let port = free_port()?;
    let port_s = port.to_string();

    let mut args: Vec<&str> = vec![
        "network", "bastion", "tunnel",
        "--name", name.trim(),
        "--resource-group", resource_group.trim(),
        "--target-resource-id", target_id.trim(),
        "--resource-port", "22",
        "--port", &port_s,
    ];
    if let Some(s) = subscription.as_deref() {
        args.extend(["--subscription", s.trim()]);
    }

    let (exe, prefix) = crate::pty::resolve_program(&program);
    let mut cmd = tokio::process::Command::new(exe);
    cmd.args(prefix)
        .args(&args)
        .env("PYTHONUNBUFFERED", "1") // so "Tunnel is ready" isn't stuck in Python's buffer
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    let mut child = cmd.spawn().map_err(|e| format!("failed to start the Azure CLI: {e}"))?;

    let log = Arc::new(Mutex::new(String::new()));
    let (tx, mut rx) = tokio::sync::oneshot::channel();
    drain(child.stdout.take().unwrap(), log.clone(), Some(tx));
    drain(child.stderr.take().unwrap(), log.clone(), None);

    // az prints "Tunnel is ready, connect on port <n>" once the listener is up.
    let started = Instant::now();
    loop {
        if rx.try_recv().is_ok() {
            break;
        }
        if let Ok(Some(status)) = child.try_wait() {
            let out = log.lock().unwrap().trim().to_string();
            return Err(format!("Azure Bastion tunnel failed ({status}):\n{}", if out.is_empty() { "no output from az" } else { &out }));
        }
        if started.elapsed() > Duration::from_secs(90) {
            kill_tree(&mut child);
            let out = log.lock().unwrap().trim().to_string();
            return Err(format!("Timed out waiting for the Azure Bastion tunnel.\n{out}"));
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }

    state.tunnels.lock().unwrap().insert(key, Tunnel { child, port, refs: 1 });
    Ok(port)
}

/// Releases one user of the tunnel; closes it when the last tab using it is closed.
#[tauri::command]
pub fn bastion_tunnel_stop(state: State<'_, BastionState>, key: String) {
    let mut tunnels = state.tunnels.lock().unwrap();
    if let Some(t) = tunnels.get_mut(&key) {
        t.refs = t.refs.saturating_sub(1);
        if t.refs == 0 {
            let mut t = tunnels.remove(&key).unwrap();
            kill_tree(&mut t.child);
        }
    }
}

#[tauri::command]
pub fn bastion_stop_all(state: State<'_, BastionState>) {
    stop_all(&state);
}

pub fn stop_all(state: &BastionState) {
    for (_, mut t) in state.tunnels.lock().unwrap().drain() {
        kill_tree(&mut t.child);
    }
}
