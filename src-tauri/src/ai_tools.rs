//! Chat turns with tool calling (Claude Messages API / OpenAI Chat Completions).
//!
//! Messages come from the UI in a provider-neutral shape:
//!   { role: "user", content }                        typed message (or command output)
//!   { role: "assistant", content, tool_calls?, raw? } a reply; `raw` = Claude's content blocks
//!   { role: "tool", tool_call_id, name, content }     the result of one tool call
//! Claude replies are replayed from `raw` unchanged (thinking blocks included) so tool use keeps
//! working across turns. One call = one model turn; the UI runs the tools and calls again.

use crate::config::{load_settings, Settings};
use anyhow::{anyhow, bail, Context, Result};
use futures_util::StreamExt;
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::BTreeMap;
use tauri::{AppHandle, Emitter, Manager, State};

const ANTHROPIC_VERSION: &str = "2026-10-21";

#[derive(Clone, Serialize)]
struct Chunk {
    id: String,
    text: String,
}

#[derive(Clone, Serialize, Default)]
struct Done {
    id: String,
    error: Option<String>,
    /// [{ id, name, input, invalid? }]
    tool_calls: Vec<Value>,
    /// Claude's raw content blocks for this reply (replayed on the next request).
    raw: Option<Value>,
}

#[derive(Default)]
struct Turn {
    tool_calls: Vec<Value>,
    raw: Option<Value>,
}

/// Streams one assistant turn as `ai-chunk` events, then `ai-done` (with any tool calls).
/// `tools`: offer run_command / read_file / list_directory (API providers only).
#[tauri::command]
pub async fn ai_chat(
    app: AppHandle,
    state: State<'_, crate::ai::AiState>,
    request_id: String,
    provider: String,
    system: String,
    messages: Vec<Value>,
    tools: Option<bool>,
) -> Result<(), String> {
    let settings = load_settings();
    let task_app = app.clone();
    let id = request_id.clone();
    let tools = tools.unwrap_or(false);
    let handle = tauri::async_runtime::spawn(async move {
        let emit = |text: &str| {
            let _ = task_app.emit("ai-chunk", Chunk { id: id.clone(), text: text.to_string() });
        };
        let result = match provider.as_str() {
            "anthropic" => anthropic_turn(&settings, &system, &messages, tools, &emit).await,
            "openai" => openai_turn(&settings, &system, &messages, tools, &emit).await,
            "claude-cli" | "codex-cli" => crate::ai::cli_text(&settings, &provider, &flatten(&system, &messages), &emit)
                .await
                .map(|_| Turn::default()),
            other => Err(anyhow!("unknown provider: {other}")),
        };
        let done = match result {
            Ok(t) => Done { id: id.clone(), tool_calls: t.tool_calls, raw: t.raw, ..Default::default() },
            Err(e) => Done { id: id.clone(), error: Some(format!("{e:#}")), ..Default::default() },
        };
        let _ = task_app.emit("ai-done", done);
        task_app.state::<crate::ai::AiState>().forget(&id);
    });
    state.track(request_id, handle);
    Ok(())
}

fn tool_specs() -> Vec<(&'static str, &'static str, Value)> {
    vec![
        (
            "run_command",
            "Run one shell command in the user's active terminal (the shell and OS described in the system prompt) and get back its output and exit code. Use non-interactive commands only.",
            json!({ "type": "object", "properties": {
                "command": { "type": "string", "description": "The exact command line to run" }
            }, "required": ["command"], "additionalProperties": false }),
        ),
        (
            "read_file",
            "Read a text file. On an SSH terminal this reads from the server; otherwise from this computer. Large files are truncated to their last part.",
            json!({ "type": "object", "properties": {
                "path": { "type": "string", "description": "Absolute path, or relative to the terminal's current folder" }
            }, "required": ["path"], "additionalProperties": false }),
        ),
        (
            "list_directory",
            "List the files and folders in a directory (on the server for SSH terminals).",
            json!({ "type": "object", "properties": {
                "path": { "type": "string", "description": "Absolute path, or relative to the terminal's current folder" }
            }, "required": ["path"], "additionalProperties": false }),
        ),
    ]
}

fn flatten(system: &str, messages: &[Value]) -> String {
    let mut out = String::new();
    if !system.is_empty() {
        out.push_str(system);
        out.push_str("\n\n");
    }
    if messages.len() == 1 {
        out.push_str(messages[0]["content"].as_str().unwrap_or_default());
        return out;
    }
    out.push_str("Conversation so far:\n\n");
    for m in messages {
        let who = match m["role"].as_str() {
            Some("assistant") => "Assistant",
            Some("tool") => "Tool result",
            _ => "User",
        };
        out.push_str(&format!("{who}: {}\n\n", m["content"].as_str().unwrap_or_default()));
    }
    out.push_str("Reply to the last User message.");
    out
}

fn non_empty(s: &str) -> Option<String> {
    let s = s.trim();
    (!s.is_empty()).then(|| s.to_string())
}

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

// ---------------------------------------------------------------- Claude

fn to_anthropic(messages: &[Value]) -> Vec<Value> {
    let mut out: Vec<Value> = Vec::new();
    // Appends content to the previous user message (consecutive user turns are merged).
    fn push_user(out: &mut Vec<Value>, block: Value) {
        if let Some(last) = out.last_mut().filter(|m| m["role"] == "user") {
            let mut content = match last["content"].take() {
                Value::String(s) => vec![json!({ "type": "text", "text": s })],
                Value::Array(a) => a,
                _ => vec![],
            };
            content.push(block);
            last["content"] = Value::Array(content);
        } else {
            out.push(json!({ "role": "user", "content": [block] }));
        }
    }
    for m in messages {
        match m["role"].as_str() {
            Some("user") => push_user(&mut out, json!({ "type": "text", "text": m["content"].as_str().unwrap_or_default() })),
            Some("tool") => push_user(
                &mut out,
                json!({ "type": "tool_result", "tool_use_id": m["tool_call_id"], "content": m["content"].as_str().unwrap_or_default(), "is_error": m["is_error"].as_bool().unwrap_or(false) }),
            ),
            Some("assistant") => {
                if let Some(raw) = m["raw"].as_array().filter(|r| !r.is_empty()) {
                    out.push(json!({ "role": "assistant", "content": raw }));
                    continue;
                }
                let mut blocks = Vec::new();
                if let Some(t) = m["content"].as_str().filter(|t| !t.is_empty()) {
                    blocks.push(json!({ "type": "text", "text": t }));
                }
                for c in m["tool_calls"].as_array().into_iter().flatten() {
                    blocks.push(json!({ "type": "tool_use", "id": c["id"], "name": c["name"], "input": c["input"] }));
                }
                if !blocks.is_empty() {
                    out.push(json!({ "role": "assistant", "content": blocks }));
                }
            }
            _ => {}
        }
    }
    out
}

fn supports_fallbacks(model: &str) -> bool {
    matches!(model, "claude-opus-5-5" | "claude-opus-5" | "claude-sonnet-5-5" | "claude-fable-5-1")
}

async fn anthropic_turn(s: &Settings, system: &str, messages: &[Value], tools: bool, emit: &(dyn Fn(&str) + Send + Sync)) -> Result<Turn> {
    let key = crate::config::api_key("anthropic", &s.anthropic_api_key)
        .or_else(|| std::env::var("ANTHROPIC_API_KEY").ok())
        .context("No Anthropic API key — add one in Settings or set ANTHROPIC_API_KEY")?;
    let model = &s.anthropic_model;
    let mut body = json!({
        "model": model,
        "max_tokens": 64000,
        "messages": to_anthropic(messages),
        "output_config": { "effort": s.anthropic_effort },
        "stream": true,
    });
    if !system.is_empty() {
        body["system"] = json!(system);
    }
    if tools {
        body["tools"] = Value::Array(
            tool_specs()
                .into_iter()
                .map(|(name, description, schema)| json!({ "name": name, "description": description, "input_schema": schema, "eager_input_streaming": true }))
                .collect(),
        );
    }
    let base = s.anthropic_base_url.trim_end_matches('/');
    let mut req = reqwest::Client::new()
        .post(format!("{base}/v1/messages"))
        .header("x-api-key", key)
        .header("anthropic-version", ANTHROPIC_VERSION);
    if supports_fallbacks(model) {
        body["fallbacks"] = json!("default");
        req = req.header("anthropic-beta", "server-side-fallback-2026-07-01");
    }
    let resp = check_status(req.json(&body).send().await?).await?;

    // Rebuild every content block exactly as streamed (text, thinking + signature, tool_use).
    let mut blocks: BTreeMap<u64, Value> = BTreeMap::new();
    let mut partial: BTreeMap<u64, String> = BTreeMap::new();
    let mut invalid: Vec<String> = Vec::new();
    read_sse(resp, |data| {
        let v: Value = match serde_json::from_str(data) {
            Ok(v) => v,
            Err(_) => return Ok(true),
        };
        let idx = v["index"].as_u64().unwrap_or(0);
        match v["type"].as_str() {
            Some("content_block_start") => {
                blocks.insert(idx, v["content_block"].clone());
            }
            Some("content_block_delta") => {
                let d = &v["delta"];
                let Some(b) = blocks.get_mut(&idx) else { return Ok(true) };
                match d["type"].as_str() {
                    Some("text_delta") => {
                        let t = d["text"].as_str().unwrap_or_default();
                        let cur = b["text"].as_str().unwrap_or_default().to_string();
                        b["text"] = json!(cur + t);
                        emit(t);
                    }
                    Some("thinking_delta") => {
                        let cur = b["thinking"].as_str().unwrap_or_default().to_string();
                        b["thinking"] = json!(cur + d["thinking"].as_str().unwrap_or_default());
                    }
                    Some("signature_delta") => b["signature"] = d["signature"].clone(),
                    Some("input_json_delta") => partial.entry(idx).or_default().push_str(d["partial_json"].as_str().unwrap_or_default()),
                    _ => {}
                }
            }
            Some("content_block_stop") => {
                if let Some(b) = blocks.get_mut(&idx).filter(|b| b["type"] == "tool_use") {
                    let src = partial.remove(&idx).unwrap_or_default();
                    // Streamed tool input isn't validated by the API: parse defensively.
                    match serde_json::from_str::<Value>(if src.trim().is_empty() { "{}" } else { &src }) {
                        Ok(input) if input.is_object() => b["input"] = input,
                        _ => {
                            b["input"] = json!({});
                            invalid.push(b["id"].as_str().unwrap_or_default().to_string());
                        }
                    }
                }
            }
            Some("message_delta") if v["delta"]["stop_reason"] == "refusal" => emit("\n\n_(Claude declined to continue this response.)_"),
            Some("error") => bail!("{}", v["error"]["message"].as_str().unwrap_or("stream error")),
            Some("message_stop") => return Ok(false),
            _ => {}
        }
        Ok(true)
    })
    .await?;

    let raw: Vec<Value> = blocks.into_values().collect();
    let tool_calls = raw
        .iter()
        .filter(|b| b["type"] == "tool_use")
        .map(|b| {
            let id = b["id"].as_str().unwrap_or_default();
            json!({ "id": id, "name": b["name"], "input": b["input"], "invalid": invalid.iter().any(|x| x == id) })
        })
        .collect();
    Ok(Turn { tool_calls, raw: Some(Value::Array(raw)) })
}

// ---------------------------------------------------------------- OpenAI

fn to_openai(system: &str, messages: &[Value]) -> Vec<Value> {
    let mut out = Vec::new();
    if !system.is_empty() {
        out.push(json!({ "role": "system", "content": system }));
    }
    for m in messages {
        match m["role"].as_str() {
            Some("user") => out.push(json!({ "role": "user", "content": m["content"] })),
            Some("tool") => out.push(json!({ "role": "tool", "tool_call_id": m["tool_call_id"], "content": m["content"] })),
            Some("assistant") => {
                let calls: Vec<Value> = m["tool_calls"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .map(|c| json!({ "id": c["id"], "type": "function", "function": { "name": c["name"], "arguments": c["input"].to_string() } }))
                    .collect();
                let text = m["content"].as_str().filter(|t| !t.is_empty());
                let mut msg = json!({ "role": "assistant", "content": text });
                if !calls.is_empty() {
                    msg["tool_calls"] = Value::Array(calls);
                }
                out.push(msg);
            }
            _ => {}
        }
    }
    out
}

async fn openai_turn(s: &Settings, system: &str, messages: &[Value], tools: bool, emit: &(dyn Fn(&str) + Send + Sync)) -> Result<Turn> {
    let base = s.openai_base_url.trim_end_matches('/');
    let key = crate::config::api_key("openai", &s.openai_api_key).or_else(|| std::env::var("OPENAI_API_KEY").ok());
    if key.is_none() && base.contains("api.openai.com") {
        bail!("No OpenAI API key — add one in Settings or set OPENAI_API_KEY");
    }
    let mut body = json!({ "model": s.openai_model, "messages": to_openai(system, messages), "stream": true });
    if tools {
        body["tools"] = Value::Array(
            tool_specs()
                .into_iter()
                .map(|(name, description, schema)| json!({ "type": "function", "function": { "name": name, "description": description, "parameters": schema } }))
                .collect(),
        );
    }
    let mut req = reqwest::Client::new().post(format!("{base}/chat/completions")).json(&body);
    if let Some(k) = non_empty(&key.unwrap_or_default()) {
        req = req.bearer_auth(k);
    }
    let resp = check_status(req.send().await?).await?;

    // Tool calls stream in pieces keyed by index: id/name once, arguments in fragments.
    let mut calls: BTreeMap<u64, (String, String, String)> = BTreeMap::new();
    read_sse(resp, |data| {
        if data == "[DONE]" {
            return Ok(false);
        }
        let Ok(v) = serde_json::from_str::<Value>(data) else { return Ok(true) };
        let delta = &v["choices"][0]["delta"];
        if let Some(t) = delta["content"].as_str() {
            emit(t);
        }
        for tc in delta["tool_calls"].as_array().into_iter().flatten() {
            let e = calls.entry(tc["index"].as_u64().unwrap_or(0)).or_default();
            if let Some(id) = tc["id"].as_str() {
                e.0 = id.to_string();
            }
            if let Some(n) = tc["function"]["name"].as_str() {
                e.1.push_str(n);
            }
            if let Some(a) = tc["function"]["arguments"].as_str() {
                e.2.push_str(a);
            }
        }
        Ok(true)
    })
    .await?;
    let tool_calls = calls
        .into_values()
        .map(|(id, name, args)| match serde_json::from_str::<Value>(if args.trim().is_empty() { "{}" } else { &args }) {
            Ok(input) if input.is_object() => json!({ "id": id, "name": name, "input": input, "invalid": false }),
            _ => json!({ "id": id, "name": name, "input": {}, "invalid": true }),
        })
        .collect();
    Ok(Turn { tool_calls, raw: None })
}
