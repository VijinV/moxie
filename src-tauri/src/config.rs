//! Settings and saved SSH sessions live as JSON in the OS config dir (e.g. %APPDATA%\moxie).

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Serialize, Deserialize, Clone)]
#[serde(default)]
pub struct Settings {
    /// "anthropic" | "openai" | "claude-cli" | "codex-cli"
    pub chat_provider: String,
    pub complete_provider: String,
    pub autocomplete_ai: bool,
    pub font_size: u16,

    // Prototype: keys are stored in plain JSON. Move to the OS keychain before shipping.
    pub anthropic_api_key: String,
    pub anthropic_base_url: String,
    pub anthropic_model: String,
    pub anthropic_fast_model: String,
    pub anthropic_effort: String,

    pub openai_api_key: String,
    pub openai_base_url: String,
    pub openai_model: String,
    pub openai_fast_model: String,

    pub claude_cli_path: String,
    pub codex_cli_path: String,
    pub az_cli_path: String,
    /// Editor for SFTP "Edit" (e.g. "code"); empty = the file type's default app.
    pub editor_cmd: String,

    pub terminal_theme: String,
    pub font_family: String,
    pub line_height: f32,
    pub cursor_style: String,
    /// Reopen the previous tabs, splits and sessions on start.
    pub restore_workspace: bool,
    /// Colour file names, paths, IPs, errors… in plain terminal output.
    pub highlight_output: bool,
    /// VNC viewer executable; empty = auto-detect.
    pub vnc_viewer: String,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            chat_provider: "anthropic".into(),
            complete_provider: "anthropic".into(),
            autocomplete_ai: true,
            font_size: 14,
            anthropic_api_key: String::new(),
            anthropic_base_url: "https://api.anthropic.com".into(),
            anthropic_model: "claude-opus-5-5".into(),
            anthropic_fast_model: "claude-haiku-5-5".into(),
            anthropic_effort: "medium".into(),
            openai_api_key: String::new(),
            openai_base_url: "https://api.openai.com/v1".into(),
            openai_model: "gpt-5".into(),
            openai_fast_model: "gpt-5-mini".into(),
            claude_cli_path: String::new(),
            codex_cli_path: String::new(),
            az_cli_path: String::new(),
            editor_cmd: String::new(),
            terminal_theme: "moxie".into(),
            font_family: String::new(),
            line_height: 1.0,
            cursor_style: "block".into(),
            restore_workspace: true,
            highlight_output: true,
            vnc_viewer: String::new(),
        }
    }
}

pub fn config_dir() -> PathBuf {
    let dir = dirs::config_dir().unwrap_or_else(std::env::temp_dir).join("moxie");
    let _ = std::fs::create_dir_all(&dir);
    dir
}

pub fn load_settings() -> Settings {
    std::fs::read_to_string(config_dir().join("settings.json"))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

#[tauri::command]
pub fn get_settings() -> Settings {
    let mut s = load_settings();
    // Keys found in settings.json (older versions) move to the OS credential store.
    if store_keys(&mut s) {
        let _ = write_settings(&s);
    }
    s
}

#[tauri::command]
pub fn save_settings(settings: Settings) -> Result<(), String> {
    let mut s = settings;
    store_keys(&mut s);
    write_settings(&s)
}

fn write_settings(s: &Settings) -> Result<(), String> {
    let json = serde_json::to_string_pretty(s).map_err(|e| e.to_string())?;
    std::fs::write(config_dir().join("settings.json"), json).map_err(|e| e.to_string())
}

// ---------------------------------------------------------------- AI API keys (OS keychain)

const KEY_SERVICE: &str = "moxie-ai";

/// Moves any API key typed into Settings into the OS credential store and blanks it in the
/// settings file. Returns true if something moved. If the store isn't available, the key stays.
fn store_keys(s: &mut Settings) -> bool {
    let mut moved = false;
    for (provider, field) in [("anthropic", &mut s.anthropic_api_key), ("openai", &mut s.openai_api_key)] {
        let key = field.trim().to_string();
        if key.is_empty() {
            continue;
        }
        if let Ok(entry) = keyring::Entry::new(KEY_SERVICE, provider) {
            if entry.set_password(&key).is_ok() {
                field.clear();
                moved = true;
            }
        }
    }
    moved
}

/// The API key for a provider: from Settings if one is there, else from the OS credential store.
pub fn api_key(provider: &str, from_settings: &str) -> Option<String> {
    let s = from_settings.trim();
    if !s.is_empty() {
        return Some(s.to_string());
    }
    keyring::Entry::new(KEY_SERVICE, provider).ok()?.get_password().ok().filter(|k| !k.is_empty())
}

#[derive(Serialize)]
pub struct KeyStatus {
    anthropic: bool,
    openai: bool,
}

/// Which providers have a key saved (the keys themselves never go back to the UI).
#[tauri::command]
pub fn api_keys_status() -> KeyStatus {
    KeyStatus { anthropic: api_key("anthropic", "").is_some(), openai: api_key("openai", "").is_some() }
}

#[tauri::command]
pub fn api_key_delete(provider: String) -> Result<(), String> {
    if !matches!(provider.as_str(), "anthropic" | "openai") {
        return Err("unknown provider".into());
    }
    if let Ok(entry) = keyring::Entry::new(KEY_SERVICE, &provider) {
        let _ = entry.delete_credential();
    }
    Ok(())
}

#[tauri::command]
pub fn get_sessions() -> serde_json::Value {
    std::fs::read_to_string(config_dir().join("sessions.json"))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_else(|| serde_json::json!([]))
}

#[tauri::command]
pub fn save_sessions(sessions: serde_json::Value) -> Result<(), String> {
    let json = serde_json::to_string_pretty(&sessions).map_err(|e| e.to_string())?;
    std::fs::write(config_dir().join("sessions.json"), json).map_err(|e| e.to_string())
}

/// Seeds autocomplete with the user's existing PowerShell / bash / zsh history.
#[tauri::command]
pub fn load_shell_history() -> Vec<String> {
    let mut files = Vec::new();
    if let Some(appdata) = dirs::data_dir() {
        files.push(appdata.join(r"Microsoft\Windows\PowerShell\PSReadLine\ConsoleHost_history.txt"));
    }
    if let Some(home) = dirs::home_dir() {
        files.push(home.join(".bash_history"));
        files.push(home.join(".zsh_history"));
    }
    let mut lines: Vec<String> = Vec::new();
    for f in files {
        if let Ok(bytes) = std::fs::read(&f) {
            for line in String::from_utf8_lossy(&bytes).lines() {
                // zsh extended history: ": 1700000000:0;command"
                let cmd = match line.strip_prefix(": ").and_then(|l| l.split_once(';')) {
                    Some((_, c)) => c,
                    None => line,
                };
                let cmd = cmd.trim();
                if !cmd.is_empty() && cmd.len() < 500 {
                    lines.push(cmd.to_string());
                }
            }
        }
    }
    // Keep the most recent occurrence of each command, newest last.
    let mut seen = std::collections::HashSet::new();
    let mut out: Vec<String> = lines.into_iter().rev().filter(|l| seen.insert(l.clone())).take(3000).collect();
    out.reverse();
    out
}

#[derive(Serialize)]
pub struct DirEntry {
    name: String,
    is_dir: bool,
}

/// Local directory listing for path autocompletion (capped; unreadable entries skipped).
#[tauri::command]
pub fn fs_list(dir: String) -> Result<Vec<DirEntry>, String> {
    let dir = if dir.is_empty() { ".".to_string() } else { dir };
    let rd = std::fs::read_dir(&dir).map_err(|e| e.to_string())?;
    Ok(rd
        .flatten()
        .take(2000)
        .map(|e| DirEntry {
            name: e.file_name().to_string_lossy().into_owned(),
            is_dir: e.file_type().map(|t| t.is_dir()).unwrap_or(false),
        })
        .collect())
}

/// Open tabs / splits / sessions, saved continuously so they can be restored on the next start.
#[tauri::command]
pub fn workspace_get() -> serde_json::Value {
    std::fs::read_to_string(config_dir().join("workspace.json"))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or(serde_json::Value::Null)
}

#[tauri::command]
pub fn workspace_save(workspace: serde_json::Value) -> Result<(), String> {
    let json = serde_json::to_string(&workspace).map_err(|e| e.to_string())?;
    std::fs::write(config_dir().join("workspace.json"), json).map_err(|e| e.to_string())
}

/// Saved snippets / workflows (snippets.json).
#[tauri::command]
pub fn snippets_get() -> serde_json::Value {
    std::fs::read_to_string(config_dir().join("snippets.json"))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_else(|| serde_json::json!([]))
}

#[tauri::command]
pub fn snippets_save(snippets: serde_json::Value) -> Result<(), String> {
    let json = serde_json::to_string_pretty(&snippets).map_err(|e| e.to_string())?;
    std::fs::write(config_dir().join("snippets.json"), json).map_err(|e| e.to_string())
}

/// Reads a local text file for the AI's read_file tool (the last `max` bytes if it's large).
#[tauri::command]
pub fn fs_read(path: String, max: Option<usize>) -> Result<String, String> {
    let bytes = std::fs::read(&path).map_err(|e| format!("{path}: {e}"))?;
    let max = max.unwrap_or(64 * 1024);
    let slice = if bytes.len() > max { &bytes[bytes.len() - max..] } else { &bytes[..] };
    let mut text = String::from_utf8_lossy(slice).into_owned();
    if bytes.len() > max {
        text = format!("…(showing the last {max} of {} bytes)\n{text}", bytes.len());
    }
    Ok(text)
}
