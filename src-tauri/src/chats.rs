//! AI chat history: one JSON file per conversation in <config>/moxie/chats/<id>.json.
//! The frontend owns the shape of a chat; the backend only stores, lists and deletes them.

use serde::Serialize;
use serde_json::Value;
use std::path::PathBuf;

fn chats_dir() -> PathBuf {
    let dir = crate::config::config_dir().join("chats");
    let _ = std::fs::create_dir_all(&dir);
    dir
}

/// Chat ids become file names, so allow only UUID-like characters (no path tricks).
fn chat_path(id: &str) -> Result<PathBuf, String> {
    if id.is_empty() || id.len() > 64 || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        return Err(format!("invalid chat id: {id}"));
    }
    Ok(chats_dir().join(format!("{id}.json")))
}

#[derive(Serialize)]
pub struct ChatSummary {
    id: String,
    title: String,
    /// "session:<id>" for chats bound to an SSH session, "local" otherwise.
    session: String,
    updated: u64,
    messages: usize,
}

/// Newest first.
#[tauri::command]
pub fn chats_list() -> Vec<ChatSummary> {
    let mut out = Vec::new();
    let Ok(rd) = std::fs::read_dir(chats_dir()) else { return out };
    for entry in rd.flatten() {
        let Ok(text) = std::fs::read_to_string(entry.path()) else { continue };
        let Ok(v) = serde_json::from_str::<Value>(&text) else { continue };
        let Some(id) = v["id"].as_str() else { continue };
        out.push(ChatSummary {
            id: id.to_string(),
            title: v["title"].as_str().unwrap_or("Untitled chat").to_string(),
            session: v["session"].as_str().unwrap_or("local").to_string(),
            updated: v["updated"].as_u64().unwrap_or(0),
            messages: v["messages"].as_array().map_or(0, |m| m.len()),
        });
    }
    out.sort_by(|a, b| b.updated.cmp(&a.updated));
    out
}

#[tauri::command]
pub fn chat_load(id: String) -> Result<Value, String> {
    let text = std::fs::read_to_string(chat_path(&id)?).map_err(|e| e.to_string())?;
    serde_json::from_str(&text).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn chat_save(chat: Value) -> Result<(), String> {
    let id = chat["id"].as_str().ok_or("chat has no id")?;
    let path = chat_path(id)?;
    // Write then rename, so a crash mid-save can't leave a truncated chat behind.
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_vec(&chat).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn chat_delete(id: String) -> Result<(), String> {
    let path = chat_path(&id)?;
    if path.exists() {
        std::fs::remove_file(path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[derive(Serialize)]
pub struct ChatHit {
    id: String,
    title: String,
    updated: u64,
    snippet: String,
}

/// Full-text search over saved chats (titles and message text), newest first.
#[tauri::command]
pub fn chats_search(query: String) -> Vec<ChatHit> {
    let q = query.trim().to_lowercase();
    let mut hits = Vec::new();
    if q.is_empty() {
        return hits;
    }
    let Ok(rd) = std::fs::read_dir(chats_dir()) else { return hits };
    for entry in rd.flatten() {
        let Ok(text) = std::fs::read_to_string(entry.path()) else { continue };
        let Ok(v) = serde_json::from_str::<Value>(&text) else { continue };
        let title = v["title"].as_str().unwrap_or("Untitled chat").to_string();
        let mut snippet = String::new();
        let found = title.to_lowercase().contains(&q)
            || v["messages"].as_array().into_iter().flatten().any(|m| {
                let body = m["display"].as_str().or_else(|| m["content"].as_str()).unwrap_or_default();
                let lower = body.to_lowercase();
                match lower.find(&q) {
                    Some(pos) => {
                        let chars: Vec<char> = body.chars().collect();
                        let at = lower[..pos].chars().count();
                        let from = at.saturating_sub(40);
                        let to = (at + q.chars().count() + 60).min(chars.len());
                        let from = from.min(to); // lowercasing can change lengths for some letters
                        snippet = chars[from..to].iter().collect::<String>().replace('\n', " ");
                        true
                    }
                    None => false,
                }
            });
        if found {
            hits.push(ChatHit { id: v["id"].as_str().unwrap_or_default().to_string(), title, updated: v["updated"].as_u64().unwrap_or(0), snippet });
        }
    }
    hits.sort_by(|a, b| b.updated.cmp(&a.updated));
    hits
}
