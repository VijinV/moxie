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
    load_settings()
}

#[tauri::command]
pub fn save_settings(settings: Settings) -> Result<(), String> {
    let json = serde_json::to_string_pretty(&settings).map_err(|e| e.to_string())?;
    std::fs::write(config_dir().join("settings.json"), json).map_err(|e| e.to_string())
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
