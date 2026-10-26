//! Built-in editor backend: reads and writes whole text files, on the server (over the SFTP
//! panel's connection, `conn_id`) or on this machine (`conn_id` = None).
//! Errors the UI acts on: TOO_LARGE:<bytes>, BINARY, CHANGED (modified since it was opened).

use crate::sftp::{self, SftpState};
use serde::Serialize;
use tauri::State;

const MAX: u64 = 5 * 1024 * 1024;

#[derive(Serialize)]
pub struct TextFile {
    text: String,
    /// Seconds; sent back on save to detect changes made elsewhere.
    mtime: u64,
    /// The file used CRLF line endings / started with a UTF-8 BOM: restored on save.
    crlf: bool,
    bom: bool,
}

fn decode(bytes: Vec<u8>, mtime: u64) -> Result<TextFile, String> {
    if bytes.iter().take(8192).any(|&b| b == 0) {
        return Err("BINARY".into());
    }
    let mut text = String::from_utf8(bytes).map_err(|_| "BINARY".to_string())?;
    let bom = text.starts_with('\u{feff}');
    if bom {
        text.remove(0);
    }
    let crlf = text.contains("\r\n");
    Ok(TextFile { text, mtime, crlf, bom })
}

fn encode(text: &str, crlf: bool, bom: bool) -> Vec<u8> {
    let body = if crlf { text.replace("\r\n", "\n").replace('\n', "\r\n") } else { text.to_string() };
    let mut out = Vec::with_capacity(body.len() + 3);
    if bom {
        out.extend_from_slice("\u{feff}".as_bytes());
    }
    out.extend_from_slice(body.as_bytes());
    out
}

fn local_mtime(path: &str) -> Option<u64> {
    let m = std::fs::metadata(path).ok()?.modified().ok()?;
    Some(m.duration_since(std::time::UNIX_EPOCH).ok()?.as_secs())
}

#[tauri::command]
pub async fn editor_read(state: State<'_, SftpState>, conn_id: Option<String>, path: String) -> Result<TextFile, String> {
    match conn_id {
        Some(id) => {
            let (bytes, mtime) = sftp::read_whole(&state, &id, &path, MAX).await?;
            decode(bytes, mtime)
        }
        None => {
            let meta = std::fs::metadata(&path).map_err(|e| format!("{path}: {e}"))?;
            if meta.is_dir() {
                return Err(format!("{path} is a folder"));
            }
            if meta.len() > MAX {
                return Err(format!("TOO_LARGE:{}", meta.len()));
            }
            let bytes = std::fs::read(&path).map_err(|e| format!("{path}: {e}"))?;
            decode(bytes, local_mtime(&path).unwrap_or(0))
        }
    }
}

/// `expect_mtime`: the mtime from when the file was opened (or last saved); if the file has
/// changed since, nothing is written and CHANGED is returned (pass None to overwrite anyway).
/// Returns the new mtime.
#[tauri::command]
pub async fn editor_write(
    state: State<'_, SftpState>,
    conn_id: Option<String>,
    path: String,
    text: String,
    crlf: bool,
    bom: bool,
    expect_mtime: Option<u64>,
) -> Result<u64, String> {
    let bytes = encode(&text, crlf, bom);
    match conn_id {
        Some(id) => {
            if let (Some(want), Some(now)) = (expect_mtime, sftp::mtime_of(&state, &id, &path).await?) {
                if now != want {
                    return Err("CHANGED".into());
                }
            }
            sftp::write_whole(&state, &id, &path, &bytes).await
        }
        None => {
            if let (Some(want), Some(now)) = (expect_mtime, local_mtime(&path)) {
                if now != want {
                    return Err("CHANGED".into());
                }
            }
            std::fs::write(&path, &bytes).map_err(|e| format!("{path}: {e}"))?;
            Ok(local_mtime(&path).unwrap_or(0))
        }
    }
}
