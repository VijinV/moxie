//! AI providers behind one interface:
//!   - "anthropic": Claude Messages API (raw HTTP, SSE streaming)
//!   - "openai":    OpenAI Chat Completions (also works with any OpenAI-compatible server, e.g. Ollama)
//!   - "claude-cli": the local `claude` CLI (Claude Code) in print mode — uses the user's own login
//!   - "codex-cli":  the local `codex` CLI via `codex exec`
//!
//! `ai_chat` streams `ai-chunk` events then one `ai-done`; `ai_oneshot` returns the full text
//! (used for autocomplete and natural-language → command).

use crate::config::{load_settings, Settings};
use anyhow::{anyhow, bail, Context, Result};
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::process::Stdio;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

const ANTHROPIC_VERSION: &str = "2026-10-21";

#[derive(Deserialize, Clone)]
pub struct Msg {
    role: String,
    content: String,
}

#[derive(Default)]
pub struct AiState {
    tasks: Mutex<HashMap<String, tauri::async_runtime::JoinHandle<()>>>,
}

#[derive(Clone, Serialize)]
struct Chunk {
    id: String,
    text: String,
}

#[derive(Clone, Serialize)]
struct Done {
    id: String,
    error: Option<String>,
}

#[tauri::command]
pub async fn ai_chat(
    app: AppHandle,
    state: State<'_, AiState>,
    request_id: String,
    provider: String,
    system: String,
    messages: Vec<Msg>,
) -> Result<(), String> {
    let settings = load_settings();
    let task_app = app.clone();
    let id = request_id.clone();
    let handle = tauri::async_runtime::spawn(async move {
        let emit = |text: &str| {
            let _ = task_app.emit("ai-chunk", Chunk { id: id.clone(), text: text.to_string() });
        };
        let result = match provider.as_str() {
            "anthropic" => anthropic_chat(&settings, &system, &messages, false, Some(&emit)).await,
            "openai" => openai_chat(&settings, &system, &messages, false, Some(&emit)).await,
            "claude-cli" | "codex-cli" => {
                cli_run(&settings, &provider, &flatten_for_cli(&system, &messages), Some(&emit)).await
            }
            other => Err(anyhow!("unknown provider: {other}")),
        };
        let _ = task_app.emit("ai-done", Done { id: id.clone(), error: result.err().map(|e| format!("{e:#}")) });
        task_app.state::<AiState>().tasks.lock().unwrap().remove(&id);
    });
    state.tasks.lock().unwrap().insert(request_id, handle);
    Ok(())
}

#[tauri::command]
pub fn ai_cancel(state: State<'_, AiState>, request_id: String) {
    if let Some(h) = state.tasks.lock().unwrap().remove(&request_id) {
        h.abort();
    }
}

/// Non-streaming single completion. `fast` picks the provider's small model (autocomplete).
#[tauri::command]
pub async fn ai_oneshot(provider: String, system: String, prompt: String, fast: bool) -> Result<String, String> {
    let settings = load_settings();
    let messages = vec![Msg { role: "user".into(), content: prompt }];
    let result = match provider.as_str() {
        "anthropic" => anthropic_chat(&settings, &system, &messages, fast, None).await,
        "openai" => openai_chat(&settings, &system, &messages, fast, None).await,
        "claude-cli" | "codex-cli" => cli_run(&settings, &provider, &flatten_for_cli(&system, &messages), None).await,
        other => Err(anyhow!("unknown provider: {other}")),
    };
    result.map(|s| s.trim().to_string()).map_err(|e| format!("{e:#}"))
}

type Emit<'a> = Option<&'a (dyn Fn(&str) + Send + Sync)>;

fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(15))
        .build()
        .expect("http client")
}

fn non_empty(s: &str) -> Option<String> {
    let s = s.trim();
    (!s.is_empty()).then(|| s.to_string())
}

/// Reads an SSE body, calling `on_data` for every `data:` payload. Return `false` to stop.
async fn read_sse(resp: reqwest::Response, mut on_data: impl FnMut(&str) -> Result<bool>) -> Result<()> {
    let mut stream = resp.bytes_stream();
    let mut buf: Vec<u8> = Vec::new();
    while let Some(chunk) = stream.next().await {
        buf.extend_from_slice(&chunk?);
        while let Some(pos) = buf.iter().position(|&b| b == b'\n') {
            let line: Vec<u8> = buf.drain(..=pos).collect();
            let line = String::from_utf8_lossy(&line);
            if let Some(data) = line.trim().strip_prefix("data:") {
                if !on_data(data.trim())? {
                    return Ok(());
                }
            }
        }
    }
    Ok(())
}

async fn check_status(resp: reqwest::Response) -> Result<reqwest::Response> {
    let status = resp.status();
    if status.is_success() {
        return Ok(resp);
    }
    let body = resp.text().await.unwrap_or_default();
    let msg = serde_json::from_str::<Value>(&body)
        .ok()
        .and_then(|v| v["error"]["message"].as_str().map(String::from))
        .unwrap_or(body);
    bail!("HTTP {status}: {msg}")
}

// ---------------------------------------------------------------- Anthropic

/// Models that accept the server-side refusal fallback (`fallbacks: "default"`).
fn supports_fallbacks(model: &str) -> bool {
    matches!(model, "claude-opus-5-5" | "claude-opus-5" | "claude-sonnet-5-5" | "claude-fable-5-1")
}

async fn anthropic_chat(s: &Settings, system: &str, messages: &[Msg], fast: bool, emit: Emit<'_>) -> Result<String> {
    let key = non_empty(&s.anthropic_api_key)
        .or_else(|| std::env::var("ANTHROPIC_API_KEY").ok())
        .context("No Anthropic API key — add one in Settings or set ANTHROPIC_API_KEY")?;
    let model = if fast { &s.anthropic_fast_model } else { &s.anthropic_model };
    let effort = if fast { "low" } else { s.anthropic_effort.as_str() };
    let msgs: Vec<Value> = messages
        .iter()
        .filter(|m| m.role == "user" || m.role == "assistant")
        .map(|m| json!({ "role": m.role, "content": m.content }))
        .collect();

    let mut body = json!({
        "model": model,
        "max_tokens": if emit.is_some() { 64000 } else { 4000 },
        "messages": msgs,
        "output_config": { "effort": effort },
        "stream": emit.is_some(),
    });
    if !system.is_empty() {
        body["system"] = json!(system);
    }
    let base = s.anthropic_base_url.trim_end_matches('/');
    let mut req = client()
        .post(format!("{base}/v1/messages"))
        .header("x-api-key", key)
        .header("anthropic-version", ANTHROPIC_VERSION);
    if supports_fallbacks(model) {
        body["fallbacks"] = json!("default");
        req = req.header("anthropic-beta", "server-side-fallback-2026-07-01");
    }
    let resp = check_status(req.json(&body).send().await?).await?;

    let Some(emit) = emit else {
        let v: Value = resp.json().await?;
        if v["stop_reason"] == "refusal" {
            bail!("Claude declined this request");
        }
        let text = v["content"]
            .as_array()
            .map(|blocks| {
                blocks
                    .iter()
                    .filter(|b| b["type"] == "text")
                    .filter_map(|b| b["text"].as_str())
                    .collect::<String>()
            })
            .unwrap_or_default();
        return Ok(text);
    };

    let mut full = String::new();
    read_sse(resp, |data| {
        let v: Value = match serde_json::from_str(data) {
            Ok(v) => v,
            Err(_) => return Ok(true),
        };
        match v["type"].as_str() {
            Some("content_block_delta") if v["delta"]["type"] == "text_delta" => {
                if let Some(t) = v["delta"]["text"].as_str() {
                    full.push_str(t);
                    emit(t);
                }
            }
            Some("message_delta") if v["delta"]["stop_reason"] == "refusal" => {
                emit("\n\n_(Claude declined to continue this response.)_");
            }
            Some("error") => bail!("{}", v["error"]["message"].as_str().unwrap_or("stream error")),
            Some("message_stop") => return Ok(false),
            _ => {}
        }
        Ok(true)
    })
    .await?;
    Ok(full)
}

// ---------------------------------------------------------------- OpenAI

async fn openai_chat(s: &Settings, system: &str, messages: &[Msg], fast: bool, emit: Emit<'_>) -> Result<String> {
    let base = s.openai_base_url.trim_end_matches('/');
    let key = non_empty(&s.openai_api_key).or_else(|| std::env::var("OPENAI_API_KEY").ok());
    if key.is_none() && base.contains("api.openai.com") {
        bail!("No OpenAI API key — add one in Settings or set OPENAI_API_KEY");
    }
    let model = if fast { &s.openai_fast_model } else { &s.openai_model };
    let mut msgs = Vec::new();
    if !system.is_empty() {
        msgs.push(json!({ "role": "system", "content": system }));
    }
    msgs.extend(messages.iter().map(|m| json!({ "role": m.role, "content": m.content })));
    let body = json!({ "model": model, "messages": msgs, "stream": emit.is_some() });

    let mut req = client().post(format!("{base}/chat/completions")).json(&body);
    if let Some(k) = key {
        req = req.bearer_auth(k);
    }
    let resp = check_status(req.send().await?).await?;

    let Some(emit) = emit else {
        let v: Value = resp.json().await?;
        return Ok(v["choices"][0]["message"]["content"].as_str().unwrap_or_default().to_string());
    };

    let mut full = String::new();
    read_sse(resp, |data| {
        if data == "[DONE]" {
            return Ok(false);
        }
        if let Ok(v) = serde_json::from_str::<Value>(data) {
            if let Some(t) = v["choices"][0]["delta"]["content"].as_str() {
                full.push_str(t);
                emit(t);
            }
        }
        Ok(true)
    })
    .await?;
    Ok(full)
}

// ---------------------------------------------------------------- CLI agents

fn flatten_for_cli(system: &str, messages: &[Msg]) -> String {
    let mut out = String::new();
    if !system.is_empty() {
        out.push_str(system);
        out.push_str("\n\n");
    }
    if messages.len() == 1 {
        out.push_str(&messages[0].content);
        return out;
    }
    out.push_str("Conversation so far:\n\n");
    for m in messages {
        let who = if m.role == "assistant" { "Assistant" } else { "User" };
        out.push_str(&format!("{who}: {}\n\n", m.content));
    }
    out.push_str("Reply to the last User message.");
    out
}

/// Returns a PATH string that includes common macOS CLI install locations missing from
/// the stripped environment that .app bundles receive when launched from Finder/Dock.
fn mac_augmented_path() -> String {
    let current = std::env::var("PATH").unwrap_or_default();
    let home = dirs::home_dir().unwrap_or_default();
    let extra: &[&str] = &[
        "/usr/local/bin",
        "/opt/homebrew/bin",
        "/opt/homebrew/sbin",
        "/usr/local/sbin",
    ];
    let home_extras = [
        home.join(".npm-global/bin"),
        home.join(".local/bin"),
        home.join(".cargo/bin"),
        home.join(".volta/bin"),
        home.join(".nvm/versions/node").join("current").join("bin"),
    ];
    let mut parts: Vec<String> = current.split(':').map(str::to_string).collect();
    for e in extra {
        if !parts.iter().any(|p| p == *e) {
            parts.push(e.to_string());
        }
    }
    for e in &home_extras {
        let s = e.to_string_lossy().to_string();
        if !parts.iter().any(|p| p == &s) {
            parts.push(s);
        }
    }
    parts.join(":")
}

/// Runs `claude -p` / `codex exec -` with the prompt on stdin (avoids shell-quoting the prompt)
/// and streams stdout back.
async fn cli_run(s: &Settings, provider: &str, prompt: &str, emit: Emit<'_>) -> Result<String> {
    let (name, custom, args): (&str, &str, &[&str]) = match provider {
        "claude-cli" => ("claude", &s.claude_cli_path, &["-p", "--output-format", "text"]),
        _ => ("codex", &s.codex_cli_path, &["exec", "--skip-git-repo-check", "-"]),
    };
    let program = non_empty(custom).unwrap_or_else(|| name.to_string());

    // macOS .app bundles launch with a stripped PATH. Augment it with the locations
    // where npm/Homebrew/nvm/volta typically install global CLIs so which::which works.
    let mac_path = mac_augmented_path();

    if non_empty(custom).is_none() {
        let found = which::which_in(name, Some(&mac_path), std::env::current_dir().unwrap_or_default()).is_ok();
        if !found {
            bail!("`{name}` CLI not found on PATH — install it or set its path in Settings");
        }
    }
    let (exe, prefix) = crate::pty::resolve_program_in(&program, &mac_path);

    let mut cmd = tokio::process::Command::new(exe);
    cmd.args(prefix)
        .args(args)
        .env("PATH", &mac_path)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    if let Some(home) = dirs::home_dir() {
        cmd.current_dir(home);
    }
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW

    let mut child = cmd.spawn().with_context(|| format!("failed to start {name}"))?;
    let mut stdin = child.stdin.take().unwrap();
    stdin.write_all(prompt.as_bytes()).await?;
    drop(stdin);

    let mut stderr = child.stderr.take().unwrap();
    let err_task = tokio::spawn(async move {
        let mut s = String::new();
        let _ = stderr.read_to_string(&mut s).await;
        s
    });

    let mut stdout = child.stdout.take().unwrap();
    let mut full = String::new();
    let mut pending: Vec<u8> = Vec::new();
    let mut buf = [0u8; 4096];
    loop {
        let n = stdout.read(&mut buf).await?;
        if n == 0 {
            break;
        }
        pending.extend_from_slice(&buf[..n]);
        let valid = match std::str::from_utf8(&pending) {
            Ok(_) => pending.len(),
            Err(e) if e.error_len().is_none() => e.valid_up_to(),
            Err(_) => pending.len(),
        };
        let text = String::from_utf8_lossy(&pending.drain(..valid).collect::<Vec<u8>>()).into_owned();
        full.push_str(&text);
        if let Some(emit) = emit {
            emit(&text);
        }
    }
    let status = child.wait().await?;
    let stderr = err_task.await.unwrap_or_default();
    if !status.success() && full.trim().is_empty() {
        bail!("{name} exited with {status}: {}", stderr.trim());
    }
    Ok(full)
}
