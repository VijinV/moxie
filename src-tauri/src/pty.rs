//! Local shells, SSH and CLI agents all run as a child process inside a pseudo-terminal.
//! Output is streamed to the frontend as `pty-output` events; exit as `pty-exit`.

use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, State};

struct Session {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    killer: Box<dyn ChildKiller + Send + Sync>,
}

#[derive(Default)]
pub struct PtyState {
    sessions: Arc<Mutex<HashMap<u32, Session>>>,
    next_id: AtomicU32,
}

#[derive(Clone, Serialize)]
struct OutputEvent {
    id: u32,
    data: String,
}

#[derive(Clone, Serialize)]
struct ExitEvent {
    id: u32,
    code: Option<u32>,
}

#[derive(Serialize)]
pub struct ShellInfo {
    name: String,
    program: String,
    args: Vec<String>,
    /// "powershell" | "bash" | "zsh" | "cmd" | "other": tells the UI how to add shell integration.
    kind: String,
}

/// Resolves a program through PATH. Windows `.cmd`/`.bat` shims (npm global installs)
/// can't be executed directly, so they are wrapped in `cmd.exe /c`.
pub fn resolve_program(program: &str) -> (String, Vec<String>) {
    resolve_program_in(program, &std::env::var("PATH").unwrap_or_default())
}

/// Like `resolve_program` but searches `path_str` instead of the process PATH.
pub fn resolve_program_in(program: &str, path_str: &str) -> (String, Vec<String>) {
    let path = which::which_in(program, Some(path_str), std::env::current_dir().unwrap_or_default())
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|_| program.to_string());
    let lower = path.to_lowercase();
    if cfg!(windows) && (lower.ends_with(".cmd") || lower.ends_with(".bat")) {
        ("cmd.exe".into(), vec!["/c".into(), path])
    } else {
        (path, vec![])
    }
}

#[tauri::command]
pub fn pty_spawn(
    app: AppHandle,
    state: State<'_, PtyState>,
    program: String,
    args: Vec<String>,
    cwd: Option<String>,
    cols: u16,
    rows: u16,
    secret_key: Option<String>,
    // Separate password for the jump host (typed first); falls back to secret_key if None.
    jump_secret_key: Option<String>,
    // How many password prompts to answer (2 through a jump host: jump + server).
    secret_uses: Option<u32>,
    env: Option<HashMap<String, String>>,
) -> Result<u32, String> {
    let size = PtySize { rows, cols, pixel_width: 0, pixel_height: 0 };
    let pair = native_pty_system().openpty(size).map_err(|e| e.to_string())?;

    let (prog, mut full_args) = resolve_program(&program);
    full_args.extend(args);
    let mut cmd = CommandBuilder::new(&prog);
    cmd.args(&full_args);
    if let Some(dir) = cwd.filter(|d| !d.is_empty()).map(PathBuf::from).or_else(dirs::home_dir) {
        cmd.cwd(dir);
    }
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    for (k, v) in env.unwrap_or_default() {
        cmd.env(k, v);
    }

    let mut child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("failed to start {program}: {e}"))?;
    drop(pair.slave);

    let killer = child.clone_killer();
    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;

    let id = state.next_id.fetch_add(1, Ordering::SeqCst) + 1;
    state
        .sessions
        .lock()
        .unwrap()
        .insert(id, Session { master: pair.master, writer, killer });

    let out_app = app.clone();
    let autofill_sessions = state.sessions.clone();
    std::thread::spawn(move || {
        let mut buf = [0u8; 16 * 1024];
        // Bytes of a multi-byte UTF-8 char split across reads wait here for the next read.
        let mut pending: Vec<u8> = Vec::new();
        // MobaXterm-style auto-login: answer password prompts with saved credentials.
        // If a jump_secret_key is provided, use it for the first prompt (jump host) and
        // secret_key for subsequent prompts (target server). Without a jump key both
        // prompts use secret_key (same password for both hops).
        let target_pw = secret_key.as_deref().and_then(crate::secrets::get);
        let jump_pw = jump_secret_key.as_deref().and_then(crate::secrets::get);
        // Queue: first entry is used for the first prompt, last entry for all remaining.
        let mut pw_queue: Vec<Option<String>> = if jump_pw.is_some() {
            vec![jump_pw, target_pw]
        } else {
            vec![target_pw]
        };
        let mut autofill = pw_queue.remove(0);
        let mut uses_left = secret_uses.unwrap_or(1).clamp(1, 3);
        let started = std::time::Instant::now();
        let mut tail = String::new();
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    pending.extend_from_slice(&buf[..n]);
                    let valid = match std::str::from_utf8(&pending) {
                        Ok(_) => pending.len(),
                        Err(e) if e.error_len().is_none() => e.valid_up_to(),
                        Err(_) => pending.len(),
                    };
                    let chunk: Vec<u8> = pending.drain(..valid).collect();
                    if chunk.is_empty() {
                        continue;
                    }
                    let data = String::from_utf8_lossy(&chunk).into_owned();
                    if autofill.is_some() {
                        tail.push_str(&data);
                        if tail.len() > 400 {
                            tail = tail.chars().rev().take(200).collect::<Vec<_>>().into_iter().rev().collect();
                        }
                        let t = tail.trim_end().to_lowercase();
                        if t.ends_with("password:") {
                            let pw = autofill.clone().unwrap();
                            if let Some(s) = autofill_sessions.lock().unwrap().get_mut(&id) {
                                let _ = s.writer.write_all(format!("{pw}\r").as_bytes());
                                let _ = s.writer.flush();
                            }
                            tail.clear(); // the next prompt must be a new one
                            uses_left -= 1;
                            // Advance to next queued password (e.g. target after jump host).
                            if !pw_queue.is_empty() {
                                autofill = pw_queue.remove(0);
                            } else if uses_left == 0 {
                                autofill = None;
                            }
                            // Exhausted all allowed prompts — stop autofill entirely.
                            if uses_left == 0 {
                                autofill = None;
                                pw_queue.clear();
                            }
                        } else if started.elapsed().as_secs() > 60 {
                            autofill = None;
                        }
                    }
                    let _ = out_app.emit("pty-output", OutputEvent { id, data });
                }
            }
        }
    });

    // On Windows the ConPTY reader doesn't reliably hit EOF when the child exits,
    // so exit is detected by waiting on the child instead.
    let sessions = state.sessions.clone();
    std::thread::spawn(move || {
        let code = child.wait().ok().map(|s| s.exit_code());
        std::thread::sleep(std::time::Duration::from_millis(150));
        sessions.lock().unwrap().remove(&id);
        let _ = app.emit("pty-exit", ExitEvent { id, code });
    });

    Ok(id)
}

#[tauri::command]
pub fn pty_write(state: State<'_, PtyState>, id: u32, data: String) -> Result<(), String> {
    let mut sessions = state.sessions.lock().unwrap();
    let s = sessions.get_mut(&id).ok_or("session not found")?;
    s.writer.write_all(data.as_bytes()).map_err(|e| e.to_string())?;
    s.writer.flush().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn pty_resize(state: State<'_, PtyState>, id: u32, cols: u16, rows: u16) -> Result<(), String> {
    let sessions = state.sessions.lock().unwrap();
    let s = sessions.get(&id).ok_or("session not found")?;
    s.master
        .resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn pty_kill(state: State<'_, PtyState>, id: u32) -> Result<(), String> {
    if let Some(mut s) = state.sessions.lock().unwrap().remove(&id) {
        let _ = s.killer.kill();
    }
    Ok(())
}

/// Called when the UI (re)loads: any PTYs from a previous page load have no tab anymore.
#[tauri::command]
pub fn pty_kill_all(state: State<'_, PtyState>) {
    for (_, mut s) in state.sessions.lock().unwrap().drain() {
        let _ = s.killer.kill();
    }
}

#[tauri::command]
pub fn find_program(name: String) -> Option<String> {
    which::which(name).ok().map(|p| p.to_string_lossy().to_string())
}

fn shell(name: &str, program: &str, args: &[&str], kind: &str) -> ShellInfo {
    ShellInfo {
        name: name.into(),
        program: program.into(),
        args: args.iter().map(|a| a.to_string()).collect(),
        kind: kind.into(),
    }
}

fn kind_of(program: &str) -> &'static str {
    if program.ends_with("zsh") {
        "zsh"
    } else if program.ends_with("bash") {
        "bash"
    } else {
        "other"
    }
}

#[tauri::command]
pub fn list_shells() -> Vec<ShellInfo> {
    let mut shells = Vec::new();
    if cfg!(windows) {
        // The UI appends -EncodedCommand with Moxie's shell integration script.
        let ps_args = ["-NoLogo", "-NoExit"];
        if which::which("pwsh").is_ok() {
            shells.push(shell("PowerShell 7", "pwsh", &ps_args, "powershell"));
        }
        shells.push(shell("Windows PowerShell", "powershell.exe", &ps_args, "powershell"));
        shells.push(shell("Command Prompt", "cmd.exe", &[], "cmd"));
        let git_bash = r"C:\Program Files\Git\bin\bash.exe";
        if std::path::Path::new(git_bash).exists() {
            shells.push(shell("Git Bash", git_bash, &["--login", "-i"], "bash"));
        }
        if which::which("wsl").is_ok() {
            shells.push(shell("WSL", "wsl.exe", &[], "bash"));
        }
    } else {
        let default = std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".into());
        shells.push(shell("Default shell", &default, &["-l"], kind_of(&default)));
        for s in ["zsh", "bash", "fish"] {
            if let Ok(p) = which::which(s) {
                let p = p.to_string_lossy().to_string();
                if p != default {
                    shells.push(shell(s, &p, &["-l"], kind_of(s)));
                }
            }
        }
    }
    shells
}
