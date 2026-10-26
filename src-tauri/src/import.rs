//! Session import from ~/.ssh/config, MobaXterm (MobaXterm.ini / .mxtsessions) and PuTTY
//! (Windows registry), plus launchers for RDP and VNC sessions.

use serde::Serialize;
use std::path::{Path, PathBuf};

#[derive(Serialize, Default, Clone)]
pub struct Imported {
    name: String,
    /// "ssh" | "rdp" | "vnc"
    r#type: String,
    host: String,
    port: u16,
    user: String,
    key: String,
    jump: String,
    folder: String,
    /// Why something couldn't be carried over (e.g. a PuTTY .ppk key).
    note: String,
}

#[tauri::command]
pub fn import_sessions(source: String, path: Option<String>) -> Result<Vec<Imported>, String> {
    match source.as_str() {
        "ssh-config" => {
            let p = path.map(PathBuf::from).or_else(|| dirs::home_dir().map(|h| h.join(".ssh").join("config"))).ok_or("no home folder")?;
            let text = std::fs::read_to_string(&p).map_err(|e| format!("{}: {e}", p.display()))?;
            Ok(parse_ssh_config(&text))
        }
        "mobaxterm" => {
            let p = match path {
                Some(p) => PathBuf::from(p),
                None => mobaxterm_ini().ok_or("MobaXterm.ini not found — choose the file (or an exported .mxtsessions)")?,
            };
            let bytes = std::fs::read(&p).map_err(|e| format!("{}: {e}", p.display()))?;
            Ok(parse_mobaxterm(&String::from_utf8_lossy(&bytes)))
        }
        "putty" => read_putty(),
        other => Err(format!("unknown source {other}")),
    }
}

fn expand_home(p: &str) -> String {
    match (p.strip_prefix("~/").or_else(|| p.strip_prefix("~\\")), dirs::home_dir()) {
        (Some(rest), Some(home)) => home.join(rest).to_string_lossy().into_owned(),
        _ => p.to_string(),
    }
}

fn parse_ssh_config(text: &str) -> Vec<Imported> {
    let mut out: Vec<Imported> = Vec::new();
    let mut current: Vec<Imported> = Vec::new();
    let flush = |current: &mut Vec<Imported>, out: &mut Vec<Imported>| {
        for mut s in current.drain(..) {
            if s.host.is_empty() {
                s.host = s.name.clone();
            }
            out.push(s);
        }
    };
    for raw in text.lines() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let (key, value) = match line.split_once(|c: char| c.is_whitespace() || c == '=') {
            Some((k, v)) => (k.to_lowercase(), v.trim().trim_start_matches('=').trim().trim_matches('"').to_string()),
            None => continue,
        };
        match key.as_str() {
            "host" => {
                flush(&mut current, &mut out);
                for alias in value.split_whitespace().filter(|a| !a.contains(['*', '?', '!'])) {
                    current.push(Imported { name: alias.into(), r#type: "ssh".into(), port: 22, folder: "ssh config".into(), ..Default::default() });
                }
            }
            "match" => flush(&mut current, &mut out),
            "hostname" => current.iter_mut().for_each(|s| s.host = value.clone()),
            "user" => current.iter_mut().for_each(|s| s.user = value.clone()),
            "port" => current.iter_mut().for_each(|s| s.port = value.parse().unwrap_or(22)),
            "identityfile" => current.iter_mut().for_each(|s| s.key = expand_home(&value)),
            "proxyjump" if value != "none" => current.iter_mut().for_each(|s| s.jump = value.clone()),
            _ => {}
        }
    }
    flush(&mut current, &mut out);
    out
}

fn mobaxterm_ini() -> Option<PathBuf> {
    let mut candidates = Vec::new();
    if let Some(d) = dirs::config_dir() {
        candidates.push(d.join("MobaXterm").join("MobaXterm.ini"));
    }
    if let Some(d) = dirs::document_dir() {
        candidates.push(d.join("MobaXterm").join("MobaXterm.ini"));
    }
    candidates.into_iter().find(|p| p.exists())
}

/// MobaXterm bookmark lines look like `Name=#109#0%host%22%user%…` (109 SSH, 91 RDP, 128 VNC)
/// inside [Bookmarks] / [Bookmarks_N] sections whose `SubRep=` is the folder.
fn parse_mobaxterm(text: &str) -> Vec<Imported> {
    let mut out = Vec::new();
    let mut folder = String::new();
    let mut in_bookmarks = false;
    for raw in text.lines() {
        let line = raw.trim();
        if line.starts_with('[') {
            in_bookmarks = line.to_lowercase().starts_with("[bookmarks");
            folder.clear();
            continue;
        }
        if !in_bookmarks {
            continue;
        }
        let Some((name, value)) = line.split_once('=') else { continue };
        if name.eq_ignore_ascii_case("SubRep") {
            folder = value.replace('\\', " / ");
            continue;
        }
        // "#<type>#<flag>%host%port%user%…#<font settings>#…": fields sit between the 2nd and 3rd '#'.
        let Some(rest) = value.strip_prefix('#') else { continue };
        let mut parts = rest.splitn(3, '#');
        let (Some(kind), Some(fields)) = (parts.next(), parts.next()) else { continue };
        let f: Vec<&str> = fields.split('%').skip(1).collect(); // skip the flag before the host
        let get = |i: usize| f.get(i).copied().unwrap_or("").trim().to_string();
        let (r#type, default_port) = match kind {
            "109" => ("ssh", 22),
            "91" => ("rdp", 3389),
            "128" => ("vnc", 5900),
            _ => continue,
        };
        let key = f.iter().find(|x| x.ends_with(".ppk") || x.ends_with(".pem") || x.contains("id_rsa") || x.contains("id_ed25519")).map(|x| x.replace("_CurrentDrive_", "C").replace("_ProfileDir_", &dirs::home_dir().unwrap_or_default().to_string_lossy()));
        let mut s = Imported {
            name: name.trim().to_string(),
            r#type: r#type.into(),
            host: get(0),
            port: get(1).parse().unwrap_or(default_port),
            user: get(2),
            folder: folder.clone(),
            ..Default::default()
        };
        if let Some(k) = key {
            if k.ends_with(".ppk") {
                s.note = format!("PuTTY key {k} must be converted to OpenSSH format (PuTTYgen → Export OpenSSH key)");
            } else {
                s.key = k;
            }
        }
        if !s.host.is_empty() {
            out.push(s);
        }
    }
    out
}

#[cfg(windows)]
fn read_putty() -> Result<Vec<Imported>, String> {
    use std::os::windows::process::CommandExt;
    let output = std::process::Command::new("reg")
        .args(["query", r"HKCU\Software\SimonTatham\PuTTY\Sessions", "/s"])
        .creation_flags(0x0800_0000)
        .output()
        .map_err(|e| e.to_string())?;
    if !output.status.success() {
        return Ok(Vec::new()); // PuTTY never used on this machine
    }
    let text = String::from_utf8_lossy(&output.stdout);
    let mut out: Vec<Imported> = Vec::new();
    let mut cur: Option<Imported> = None;
    let mut protocol = String::new();
    let finish = |cur: &mut Option<Imported>, protocol: &str, out: &mut Vec<Imported>| {
        if let Some(s) = cur.take() {
            if !s.host.is_empty() && (protocol.is_empty() || protocol == "ssh") {
                out.push(s);
            }
        }
    };
    for line in text.lines() {
        if let Some(key) = line.strip_prefix(r"HKEY_CURRENT_USER\Software\SimonTatham\PuTTY\Sessions\") {
            finish(&mut cur, &protocol, &mut out);
            protocol.clear();
            let name = percent_decode(key.trim());
            if name == "Default Settings" {
                continue;
            }
            cur = Some(Imported { name, r#type: "ssh".into(), port: 22, folder: "PuTTY".into(), ..Default::default() });
            continue;
        }
        let Some(s) = cur.as_mut() else { continue };
        let cols: Vec<&str> = line.split_whitespace().collect();
        if cols.len() < 3 {
            continue;
        }
        let value = cols[2..].join(" ");
        match cols[0] {
            "HostName" => s.host = value,
            "UserName" => s.user = value,
            "PortNumber" => s.port = u16::from_str_radix(value.trim_start_matches("0x"), 16).unwrap_or(22),
            "Protocol" => protocol = value,
            "PublicKeyFile" if !value.is_empty() => s.note = format!("PuTTY key {value} must be converted to OpenSSH format (PuTTYgen → Export OpenSSH key)"),
            _ => {}
        }
    }
    finish(&mut cur, &protocol, &mut out);
    Ok(out)
}

#[cfg(not(windows))]
fn read_putty() -> Result<Vec<Imported>, String> {
    Ok(Vec::new())
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(b) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(b);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

// ---------------------------------------------------------------- RDP / VNC

/// Opens Windows' Remote Desktop client (it asks for the password itself).
#[tauri::command]
pub fn launch_rdp(name: String, host: String, port: u16, user: String) -> Result<(), String> {
    let dir = std::env::temp_dir().join("moxie-rdp");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let safe: String = name.chars().map(|c| if c.is_ascii_alphanumeric() || c == '-' { c } else { '_' }).collect();
    let file = dir.join(format!("{safe}.rdp"));
    let mut rdp = format!("full address:s:{host}:{port}\r\nprompt for credentials:i:1\r\nscreen mode id:i:1\r\n");
    if !user.is_empty() {
        rdp.push_str(&format!("username:s:{user}\r\n"));
    }
    std::fs::write(&file, rdp).map_err(|e| e.to_string())?;
    std::process::Command::new("mstsc").arg(&file).spawn().map(|_| ()).map_err(|e| format!("couldn't start Remote Desktop: {e}"))
}

fn find_vnc_viewer(custom: &str) -> Option<PathBuf> {
    if !custom.trim().is_empty() {
        return Some(PathBuf::from(custom.trim()));
    }
    for name in ["vncviewer", "tvnviewer"] {
        if let Ok(p) = which::which(name) {
            return Some(p);
        }
    }
    [
        r"C:\Program Files\RealVNC\VNC Viewer\vncviewer.exe",
        r"C:\Program Files\TightVNC\tvnviewer.exe",
        r"C:\Program Files\uvnc bvba\UltraVNC\vncviewer.exe",
        r"C:\Program Files\TigerVNC\vncviewer.exe",
    ]
    .iter()
    .map(Path::new)
    .find(|p| p.exists())
    .map(Path::to_path_buf)
}

/// Starts an installed VNC viewer (RealVNC, TightVNC, UltraVNC, TigerVNC or the Settings path).
#[tauri::command]
pub fn launch_vnc(host: String, port: u16) -> Result<(), String> {
    let viewer = find_vnc_viewer(&crate::config::load_settings().vnc_viewer)
        .ok_or("No VNC viewer found. Install one (e.g. TigerVNC, RealVNC Viewer, TightVNC) or set its path in Settings.")?;
    std::process::Command::new(viewer)
        .arg(format!("{host}::{port}"))
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("couldn't start the VNC viewer: {e}"))
}
