//! SFTP file browser backend (russh + russh-sftp).
//!
//! The terminal itself uses the system `ssh` client; the file browser opens its own
//! connection with the same host/user/key/password. Host keys are checked against the same
//! ~/.ssh/known_hosts file OpenSSH uses. Errors the UI must act on are prefixed:
//!   HOSTKEY_UNKNOWN:<fingerprint>  → ask the user to trust, then retry with `trust`
//!   HOSTKEY_CHANGED:<fingerprint>  → refuse (possible MITM)
//!   AUTH_NEED_PASSWORD / AUTH_FAILED → ask for a password, then retry

use russh::client::{self, KeyboardInteractiveAuthResponse};
use russh::keys::{self, HashAlg, PrivateKeyWithHashAlg, PublicKey, PublicKeyOrCertificate};
use russh_sftp::client::SftpSession;
use russh_sftp::protocol::{FileType, OpenFlags};
use serde::Serialize;
use std::collections::HashMap;
use std::time::SystemTime;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

struct Conn {
    sftp: SftpSession,
    handle: client::Handle<Client>,
    /// The jump host connection the session is tunneled through (kept alive with it).
    _jump: Option<client::Handle<Client>>,
}

/// Maps a connect result to the UI's error codes. Host-key codes carry "fingerprint;which host".
fn finish_connect(
    result: Result<Result<client::Handle<Client>, russh::Error>, tokio::time::error::Elapsed>,
    issue: &Mutex<HostKeyIssue>,
    label: &str,
) -> Result<client::Handle<Client>, String> {
    match result {
        Err(_) => Err(format!("timed out connecting to {label}")),
        Ok(Ok(h)) => Ok(h),
        Ok(Err(e)) => Err(match std::mem::take(&mut *issue.lock().unwrap()) {
            HostKeyIssue::Unknown(fp) => format!("HOSTKEY_UNKNOWN:{fp};{label}"),
            HostKeyIssue::Changed(fp) => format!("HOSTKEY_CHANGED:{fp};{label}"),
            HostKeyIssue::None => format!("could not connect to {label}: {e}"),
        }),
    }
}

/// "user@host:port", "host:port" or "host" (only the first hop of a comma-separated chain).
fn parse_jump(spec: &str) -> Result<(Option<String>, String, u16), String> {
    let first = spec.trim();
    if first.contains(',') {
        return Err("SFTP supports a single jump host (the terminal supports chains)".into());
    }
    let (user, rest) = match first.rsplit_once('@') {
        Some((u, r)) => (Some(u.to_string()), r),
        None => (None, first),
    };
    let (host, port) = match rest.rsplit_once(':') {
        Some((h, p)) if !h.contains(':') => (h.to_string(), p.parse().map_err(|_| format!("bad jump host port in {spec}"))?),
        _ => (rest.to_string(), 22),
    };
    Ok((user, host, port))
}

#[derive(Default)]
pub struct SftpState {
    conns: Mutex<HashMap<String, Arc<Conn>>>,
    /// "connId:remotePath" of files open for edit-and-auto-upload.
    editing: Mutex<std::collections::HashSet<String>>,
}

fn conn(state: &SftpState, id: &str) -> Result<Arc<Conn>, String> {
    state.conns.lock().unwrap().get(id).cloned().ok_or_else(|| "not connected".into())
}

// ---------------------------------------------------------------- connect

#[derive(Default)]
enum HostKeyIssue {
    #[default]
    None,
    Unknown(String),
    Changed(String),
}

struct Client {
    host: String,
    port: u16,
    trust: Option<String>,
    issue: Arc<Mutex<HostKeyIssue>>,
}

impl client::Handler for Client {
    type Error = russh::Error;

    async fn check_server_key(&mut self, server_key: &PublicKeyOrCertificate) -> Result<bool, Self::Error> {
        let key = match server_key {
            PublicKeyOrCertificate::PublicKey { key, .. } => key.clone(),
            PublicKeyOrCertificate::Certificate(cert) => PublicKey::new(cert.public_key().clone(), ""),
        };
        let fp = key.fingerprint(HashAlg::Sha256).to_string();
        match keys::check_known_hosts(&self.host, self.port, &key) {
            Ok(true) => Ok(true),
            Err(keys::Error::KeyChanged { .. }) => {
                *self.issue.lock().unwrap() = HostKeyIssue::Changed(fp);
                Ok(false)
            }
            _ if self.trust.as_deref() == Some(fp.as_str()) => {
                let _ = keys::known_hosts::learn_known_hosts(&self.host, self.port, &key);
                Ok(true)
            }
            _ => {
                *self.issue.lock().unwrap() = HostKeyIssue::Unknown(fp);
                Ok(false)
            }
        }
    }
}

fn candidate_keys(key_path: &str) -> Vec<PathBuf> {
    if !key_path.trim().is_empty() {
        return vec![PathBuf::from(key_path.trim())];
    }
    let Some(ssh) = dirs::home_dir().map(|h| h.join(".ssh")) else { return vec![] };
    ["id_ed25519", "id_ecdsa", "id_rsa"].iter().map(|n| ssh.join(n)).filter(|p| p.exists()).collect()
}

async fn authenticate(
    handle: &mut client::Handle<Client>,
    user: &str,
    key_path: &str,
    password: Option<&str>,
) -> Result<bool, russh::Error> {
    for path in candidate_keys(key_path) {
        // Encrypted keys: the saved password doubles as the key passphrase.
        let key = keys::load_secret_key(&path, None).or_else(|_| match password {
            Some(p) => keys::load_secret_key(&path, Some(p)),
            None => Err(keys::Error::CouldNotReadKey),
        });
        let Ok(key) = key else { continue };
        let hash = handle.best_supported_rsa_hash().await?.flatten();
        let res = handle
            .authenticate_publickey(user, PrivateKeyWithHashAlg::new(Arc::new(key), hash))
            .await?;
        if res.success() {
            return Ok(true);
        }
    }

    let Some(password) = password else { return Ok(false) };
    if handle.authenticate_password(user, password).await?.success() {
        return Ok(true);
    }
    // Many servers only allow passwords via keyboard-interactive.
    let mut resp = handle.authenticate_keyboard_interactive_start(user, None).await?;
    for _ in 0..5 {
        match resp {
            KeyboardInteractiveAuthResponse::Success => return Ok(true),
            KeyboardInteractiveAuthResponse::Failure { .. } => return Ok(false),
            KeyboardInteractiveAuthResponse::InfoRequest { prompts, .. } => {
                let answers = prompts.iter().map(|_| password.to_string()).collect();
                resp = handle.authenticate_keyboard_interactive_respond(answers).await?;
            }
        }
    }
    Ok(false)
}

/// Connects and returns the remote home directory.
#[tauri::command]
pub async fn sftp_connect(
    state: State<'_, SftpState>,
    conn_id: String,
    host: String,
    port: u16,
    user: String,
    key_path: String,
    secret_key: Option<String>,
    trust: Option<String>,
    known_host_alias: Option<String>,
    jump: Option<String>,
) -> Result<String, String> {
    let issue = Arc::new(Mutex::new(HostKeyIssue::None));
    // Tunneled connections (Azure Bastion) land on 127.0.0.1:<random port>; check the host key
    // under a stable alias instead — the same one passed to OpenSSH as HostKeyAlias.
    let (kh_host, kh_port) = match known_host_alias.filter(|a| !a.is_empty()) {
        Some(alias) => (alias, 22),
        None => (host.clone(), port),
    };
    let handler = Client { host: kh_host.clone(), port: kh_port, trust: trust.clone(), issue: issue.clone() };
    let config = Arc::new(client::Config {
        keepalive_interval: Some(Duration::from_secs(30)),
        ..Default::default()
    });
    let user = if user.trim().is_empty() { std::env::var("USERNAME").unwrap_or_else(|_| "root".into()) } else { user };
    let password = secret_key.as_deref().and_then(crate::secrets::get);

    // Through a jump host (ProxyJump): log in there, then tunnel the real connection through it.
    let mut jump_handle = None;
    let mut handle = if let Some(spec) = jump.filter(|j| !j.trim().is_empty()) {
        let (juser, jhost, jport) = parse_jump(&spec)?;
        let jissue = Arc::new(Mutex::new(HostKeyIssue::None));
        let jhandler = Client { host: jhost.clone(), port: jport, trust: trust.clone(), issue: jissue.clone() };
        let connect = client::connect(config.clone(), (jhost.as_str(), jport), jhandler);
        let mut jh = finish_connect(tokio::time::timeout(Duration::from_secs(20), connect).await, &jissue, &format!("jump host {jhost}"))?;
        let ok = authenticate(&mut jh, juser.as_deref().unwrap_or(&user), &key_path, password.as_deref())
            .await
            .map_err(|e| format!("jump host authentication error: {e}"))?;
        if !ok {
            return Err(if password.is_some() { "AUTH_FAILED".into() } else { "AUTH_NEED_PASSWORD".into() });
        }
        let channel = jh
            .channel_open_direct_tcpip(host.clone(), port as u32, "127.0.0.1", 0)
            .await
            .map_err(|e| format!("jump host {jhost} couldn't reach {host}:{port}: {e}"))?;
        let connect = client::connect_stream(config, channel.into_stream(), handler);
        let h = finish_connect(tokio::time::timeout(Duration::from_secs(20), connect).await, &issue, &format!("{host}:{port}"))?;
        jump_handle = Some(jh);
        h
    } else {
        let connect = client::connect(config, (host.as_str(), port), handler);
        finish_connect(tokio::time::timeout(Duration::from_secs(20), connect).await, &issue, &format!("{host}:{port}"))?
    };

    let ok = authenticate(&mut handle, &user, &key_path, password.as_deref())
        .await
        .map_err(|e| format!("authentication error: {e}"))?;
    if !ok {
        return Err(if password.is_some() { "AUTH_FAILED".into() } else { "AUTH_NEED_PASSWORD".into() });
    }

    let channel = handle.channel_open_session().await.map_err(|e| e.to_string())?;
    channel.request_subsystem(true, "sftp").await.map_err(|e| e.to_string())?;
    let sftp = SftpSession::new(channel.into_stream()).await.map_err(|e| format!("SFTP not available: {e}"))?;
    let home = sftp.canonicalize(".").await.unwrap_or_else(|_| "/".into());

    let old = state.conns.lock().unwrap().insert(conn_id, Arc::new(Conn { sftp, handle, _jump: jump_handle }));
    if let Some(old) = old {
        let _ = old.handle.disconnect(russh::Disconnect::ByApplication, "", "en").await;
    }
    Ok(home)
}

#[tauri::command]
pub async fn sftp_disconnect(state: State<'_, SftpState>, conn_id: String) -> Result<(), String> {
    let c = state.conns.lock().unwrap().remove(&conn_id);
    if let Some(c) = c {
        let _ = c.sftp.close().await;
        let _ = c.handle.disconnect(russh::Disconnect::ByApplication, "", "en").await;
    }
    Ok(())
}

#[tauri::command]
pub async fn sftp_disconnect_all(state: State<'_, SftpState>) -> Result<(), String> {
    let all: Vec<Arc<Conn>> = state.conns.lock().unwrap().drain().map(|(_, c)| c).collect();
    for c in all {
        let _ = c.handle.disconnect(russh::Disconnect::ByApplication, "", "en").await;
    }
    Ok(())
}

// ---------------------------------------------------------------- browse

#[derive(Serialize)]
pub struct Entry {
    name: String,
    path: String,
    is_dir: bool,
    is_link: bool,
    size: u64,
    mtime: u32,
    perms: String,
}

fn join(dir: &str, name: &str) -> String {
    if dir.ends_with('/') { format!("{dir}{name}") } else { format!("{dir}/{name}") }
}

fn perm_string(mode: Option<u32>, is_dir: bool) -> String {
    let Some(m) = mode else { return String::new() };
    let mut s = String::from(if is_dir { "d" } else { "-" });
    for shift in [6, 3, 0] {
        let bits = (m >> shift) & 7;
        s.push(if bits & 4 != 0 { 'r' } else { '-' });
        s.push(if bits & 2 != 0 { 'w' } else { '-' });
        s.push(if bits & 1 != 0 { 'x' } else { '-' });
    }
    s
}

#[tauri::command]
pub async fn sftp_list(state: State<'_, SftpState>, conn_id: String, path: String) -> Result<Vec<Entry>, String> {
    let c = conn(&state, &conn_id)?;
    let path = c.sftp.canonicalize(path).await.map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for e in c.sftp.read_dir(path.clone()).await.map_err(|e| e.to_string())? {
        let name = e.file_name();
        if name == "." || name == ".." {
            continue;
        }
        let full = join(&path, &name);
        let mut meta = e.metadata();
        let is_link = matches!(e.file_type(), FileType::Symlink);
        if is_link {
            if let Ok(target) = c.sftp.metadata(full.clone()).await {
                meta = target;
            }
        }
        let is_dir = matches!(meta.file_type(), FileType::Dir);
        out.push(Entry {
            perms: perm_string(meta.permissions, is_dir),
            size: meta.size.unwrap_or(0),
            mtime: meta.mtime.unwrap_or(0),
            name,
            path: full,
            is_dir,
            is_link,
        });
    }
    out.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase())));
    Ok(out)
}

#[tauri::command]
pub async fn sftp_canonicalize(state: State<'_, SftpState>, conn_id: String, path: String) -> Result<String, String> {
    conn(&state, &conn_id)?.sftp.canonicalize(path).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn sftp_mkdir(state: State<'_, SftpState>, conn_id: String, path: String) -> Result<(), String> {
    conn(&state, &conn_id)?.sftp.create_dir(path).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn sftp_rename(state: State<'_, SftpState>, conn_id: String, from: String, to: String) -> Result<(), String> {
    conn(&state, &conn_id)?.sftp.rename(from, to).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn sftp_remove(state: State<'_, SftpState>, conn_id: String, path: String, is_dir: bool) -> Result<(), String> {
    let c = conn(&state, &conn_id)?;
    remove_recursive(&c.sftp, path, is_dir).await.map_err(|e| e.to_string())
}

async fn remove_recursive(sftp: &SftpSession, path: String, is_dir: bool) -> anyhow::Result<()> {
    if !is_dir {
        sftp.remove_file(path).await?;
        return Ok(());
    }
    for e in sftp.read_dir(path.clone()).await? {
        let name = e.file_name();
        if name == "." || name == ".." {
            continue;
        }
        let child_is_dir = matches!(e.file_type(), FileType::Dir);
        Box::pin(remove_recursive(sftp, join(&path, &name), child_is_dir)).await?;
    }
    sftp.remove_dir(path).await?;
    Ok(())
}

// ---------------------------------------------------------------- transfers

#[derive(Clone, Serialize)]
struct Progress {
    transfer_id: String,
    name: String,
    done: u64,
    total: u64,
}

struct Transfer<'a> {
    app: &'a AppHandle,
    id: String,
    last_emit: std::time::Instant,
}

impl Transfer<'_> {
    fn report(&mut self, name: &str, done: u64, total: u64, force: bool) {
        if force || self.last_emit.elapsed() > Duration::from_millis(120) {
            self.last_emit = std::time::Instant::now();
            let _ = self.app.emit(
                "sftp-progress",
                Progress { transfer_id: self.id.clone(), name: name.into(), done, total },
            );
        }
    }
}

const CHUNK: usize = 256 * 1024;

#[tauri::command]
pub async fn sftp_download(
    app: AppHandle,
    state: State<'_, SftpState>,
    conn_id: String,
    transfer_id: String,
    remote: String,
    is_dir: bool,
    local_dir: String,
) -> Result<String, String> {
    let c = conn(&state, &conn_id)?;
    let name = remote.trim_end_matches('/').rsplit('/').next().unwrap_or("download").to_string();
    let target = Path::new(&local_dir).join(&name);
    let mut t = Transfer { app: &app, id: transfer_id, last_emit: std::time::Instant::now() };
    download(&c.sftp, &remote, &target, is_dir, &mut t).await.map_err(|e| format!("{e:#}"))?;
    Ok(target.to_string_lossy().into_owned())
}

async fn download(sftp: &SftpSession, remote: &str, local: &Path, is_dir: bool, t: &mut Transfer<'_>) -> anyhow::Result<()> {
    if is_dir {
        tokio::fs::create_dir_all(local).await?;
        for e in sftp.read_dir(remote.to_string()).await? {
            let name = e.file_name();
            if name == "." || name == ".." {
                continue;
            }
            let child_dir = matches!(e.file_type(), FileType::Dir);
            Box::pin(download(sftp, &join(remote, &name), &local.join(&name), child_dir, t)).await?;
        }
        return Ok(());
    }
    let name = local.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let total = sftp.metadata(remote.to_string()).await.ok().and_then(|m| m.size).unwrap_or(0);
    let mut src = sftp.open(remote.to_string()).await?;
    let mut dst = tokio::fs::File::create(local).await?;
    let mut buf = vec![0u8; CHUNK];
    let mut done = 0u64;
    loop {
        let n = src.read(&mut buf).await?;
        if n == 0 {
            break;
        }
        dst.write_all(&buf[..n]).await?;
        done += n as u64;
        t.report(&name, done, total, false);
    }
    dst.flush().await?;
    t.report(&name, done, total, true);
    Ok(())
}

#[tauri::command]
pub async fn sftp_upload(
    app: AppHandle,
    state: State<'_, SftpState>,
    conn_id: String,
    transfer_id: String,
    local: String,
    remote_dir: String,
) -> Result<(), String> {
    let c = conn(&state, &conn_id)?;
    let local = PathBuf::from(local);
    let name = local.file_name().map(|n| n.to_string_lossy().into_owned()).ok_or("bad path")?;
    let mut t = Transfer { app: &app, id: transfer_id, last_emit: std::time::Instant::now() };
    upload(&c.sftp, &local, &join(&remote_dir, &name), &mut t).await.map_err(|e| format!("{e:#}"))
}

async fn upload(sftp: &SftpSession, local: &Path, remote: &str, t: &mut Transfer<'_>) -> anyhow::Result<()> {
    let meta = tokio::fs::metadata(local).await?;
    if meta.is_dir() {
        if !sftp.try_exists(remote.to_string()).await.unwrap_or(false) {
            sftp.create_dir(remote.to_string()).await?;
        }
        let mut rd = tokio::fs::read_dir(local).await?;
        while let Some(e) = rd.next_entry().await? {
            let name = e.file_name().to_string_lossy().into_owned();
            Box::pin(upload(sftp, &e.path(), &join(remote, &name), t)).await?;
        }
        return Ok(());
    }
    let name = local.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let total = meta.len();
    let mut src = tokio::fs::File::open(local).await?;
    let mut dst = sftp
        .open_with_flags(remote.to_string(), OpenFlags::CREATE | OpenFlags::TRUNCATE | OpenFlags::WRITE)
        .await?;
    let mut buf = vec![0u8; CHUNK];
    let mut done = 0u64;
    loop {
        let n = src.read(&mut buf).await?;
        if n == 0 {
            break;
        }
        dst.write_all(&buf[..n]).await?;
        done += n as u64;
        t.report(&name, done, total, false);
    }
    dst.shutdown().await?;
    t.report(&name, done, total, true);
    Ok(())
}

/// Downloads a file to a temp folder and opens it with the default app.
#[tauri::command]
pub async fn sftp_open(app: AppHandle, state: State<'_, SftpState>, conn_id: String, remote: String) -> Result<(), String> {
    let c = conn(&state, &conn_id)?;
    let dir = std::env::temp_dir().join("moxie-sftp").join(&conn_id);
    tokio::fs::create_dir_all(&dir).await.map_err(|e| e.to_string())?;
    let name = remote.rsplit('/').next().unwrap_or("file").to_string();
    let local = dir.join(&name);
    let mut t = Transfer { app: &app, id: format!("open-{name}"), last_emit: std::time::Instant::now() };
    download(&c.sftp, &remote, &local, false, &mut t).await.map_err(|e| format!("{e:#}"))?;
    open_path(&local)
}

pub fn open_path(path: &Path) -> Result<(), String> {
    let program = if cfg!(windows) { "explorer" } else if cfg!(target_os = "macos") { "open" } else { "xdg-open" };
    std::process::Command::new(program).arg(path).spawn().map(|_| ()).map_err(|e| e.to_string())
}

/// Opens an http(s) link from an AI answer in the default browser.
#[tauri::command]
pub fn open_url(url: String) -> Result<(), String> {
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err("only http(s) links can be opened".into());
    }
    open_path(Path::new(&url))
}

#[tauri::command]
pub fn reveal_local(path: String) -> Result<(), String> {
    if cfg!(windows) {
        std::process::Command::new("explorer").arg(format!("/select,{path}")).spawn().map(|_| ()).map_err(|e| e.to_string())
    } else {
        open_path(Path::new(&path).parent().unwrap_or(Path::new("/")))
    }
}

// ---------------------------------------------------------------- edit & auto-upload

#[derive(Clone, Serialize)]
struct EditEvent {
    remote: String,
    status: &'static str, // "opened" | "uploaded" | "error" | "stopped"
    error: Option<String>,
}

fn stamp(path: &Path) -> Option<(SystemTime, u64)> {
    let m = std::fs::metadata(path).ok()?;
    Some((m.modified().ok()?, m.len()))
}

/// Downloads a remote file, opens it in the user's editor, and uploads it back every time it's
/// saved, for as long as the SFTP connection is open.
#[tauri::command]
pub async fn sftp_edit(app: AppHandle, state: State<'_, SftpState>, conn_id: String, remote: String) -> Result<String, String> {
    let c = conn(&state, &conn_id)?;
    // Mirror the remote folder in the temp dir so same-named files from different folders don't clash.
    let parent: String = remote
        .rsplit_once('/')
        .map(|(d, _)| d)
        .unwrap_or("")
        .chars()
        .map(|ch| if ch.is_ascii_alphanumeric() || ch == '-' || ch == '.' { ch } else { '_' })
        .collect();
    let dir = std::env::temp_dir().join("moxie-edit").join(&conn_id).join(parent.trim_start_matches('_'));
    tokio::fs::create_dir_all(&dir).await.map_err(|e| e.to_string())?;
    let name = remote.rsplit('/').next().unwrap_or("file").to_string();
    let local = dir.join(&name);
    let mut t = Transfer { app: &app, id: format!("edit-{name}"), last_emit: std::time::Instant::now() };
    download(&c.sftp, &remote, &local, false, &mut t).await.map_err(|e| format!("{e:#}"))?;

    let editor = crate::config::load_settings().editor_cmd.trim().to_string();
    if editor.is_empty() {
        open_path(&local)?;
    } else {
        let (exe, prefix) = crate::pty::resolve_program(&editor);
        std::process::Command::new(exe)
            .args(prefix)
            .arg(&local)
            .spawn()
            .map_err(|e| format!("couldn't start editor \"{editor}\": {e}"))?;
    }

    let key = format!("{conn_id}:{remote}");
    let first = state.editing.lock().unwrap().insert(key.clone());
    let _ = app.emit("sftp-edit", EditEvent { remote: remote.clone(), status: "opened", error: None });
    if !first {
        return Ok(local.to_string_lossy().into_owned()); // already being watched
    }

    let local_w = local.clone();
    tauri::async_runtime::spawn(async move {
        let mut last = stamp(&local_w);
        loop {
            tokio::time::sleep(Duration::from_millis(800)).await;
            let state = app.state::<SftpState>();
            let Some(c) = state.conns.lock().unwrap().get(&conn_id).cloned() else { break };
            let now = stamp(&local_w);
            if now.is_none() || now == last {
                continue;
            }
            // Editors often write in several steps; wait until the file stops changing.
            tokio::time::sleep(Duration::from_millis(400)).await;
            let settled = stamp(&local_w);
            if settled != now {
                continue;
            }
            last = settled;
            let mut t = Transfer { app: &app, id: format!("edit-{}", remote), last_emit: std::time::Instant::now() };
            let result = upload(&c.sftp, &local_w, &remote, &mut t).await;
            let _ = app.emit(
                "sftp-edit",
                match result {
                    Ok(()) => EditEvent { remote: remote.clone(), status: "uploaded", error: None },
                    Err(e) => EditEvent { remote: remote.clone(), status: "error", error: Some(format!("{e:#}")) },
                },
            );
        }
        app.state::<SftpState>().editing.lock().unwrap().remove(&key);
        let _ = app.emit("sftp-edit", EditEvent { remote, status: "stopped", error: None });
    });
    Ok(local.to_string_lossy().into_owned())
}

/// Runs a command on the server over the panel's SSH connection (not in the terminal) and
/// returns its output. Used by the server dashboard.
#[tauri::command]
pub async fn sftp_exec(state: State<'_, SftpState>, conn_id: String, command: String) -> Result<String, String> {
    let c = conn(&state, &conn_id)?;
    let run = async {
        let mut channel = c.handle.channel_open_session().await.map_err(|e| e.to_string())?;
        channel.exec(true, command).await.map_err(|e| e.to_string())?;
        let mut out = Vec::new();
        while let Some(msg) = channel.wait().await {
            match msg {
                russh::ChannelMsg::Data { ref data } => out.extend_from_slice(data),
                russh::ChannelMsg::ExtendedData { ref data, .. } => out.extend_from_slice(data),
                russh::ChannelMsg::Eof | russh::ChannelMsg::Close => break,
                _ => {}
            }
            if out.len() > 512 * 1024 {
                break;
            }
        }
        Ok::<_, String>(String::from_utf8_lossy(&out).into_owned())
    };
    tokio::time::timeout(Duration::from_secs(10), run).await.map_err(|_| "timed out".to_string())?
}
