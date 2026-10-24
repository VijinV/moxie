# Moxie — AI terminal & SSH client (prototype)

A MobaXterm-style terminal with Warp-style AI, built in Rust (Tauri 2) with an xterm.js front end.

## Run

```bash
npm install
npm run tauri dev
```

Requires Rust (MSVC toolchain on Windows), Node 18+, and WebView2 (preinstalled on Windows 11).
Release build: `npm run tauri build` → installer in `src-tauri/target/release/bundle/`.

## What's in the prototype

| Area | Feature |
| --- | --- |
| Terminal | Tabs; local shells auto-detected (PowerShell 7, Windows PowerShell, cmd, Git Bash, WSL / bash, zsh, fish); real PTY via ConPTY / `portable-pty`; Ctrl+Shift+C/V copy-paste |
| SSH | Saved sessions (host, port, user, password, key, extra args) in the sidebar, launched through the system OpenSSH client so `~/.ssh/config`, agents, jump hosts and known_hosts all work. A saved password is typed automatically at the login prompt (MobaXterm-style); "Remember" stores it in the OS credential store, never in Moxie's files |
| SFTP browser | Opens beside every SSH tab (Ctrl+Shift+F). Browse, open with default app, download/upload files and whole folders (buttons or drag & drop from Explorer) with progress, rename, mkdir, recursive delete, "cd here" in terminal. Uses russh + russh-sftp, with the same `~/.ssh/known_hosts` trust and key/password/keyboard-interactive login |
| Agent mode | In the AI panel set **Agent** to *Ask before running* or *Auto-run*: the AI runs commands in the active terminal, reads the output and keeps going until the task is done (max 25 steps, Stop button). Destructive commands (`rm -rf`, `git push --force`, `DROP TABLE`, `Remove-Item -Recurse`, reboot…) always ask, even in Auto-run |
| AI agents | Open **Claude Code** (`claude`) or **Codex** (`codex`) as full interactive tabs |
| AI chat panel | Streaming chat with recent terminal output attached; code blocks get **Copy / Insert / Run** |
| Command bar | **Ctrl+K**: describe a task in plain language, get a command; Enter inserts it, Ctrl+Enter runs it |
| Autocomplete | Ghost text at the cursor: instant matches from your shell history (PSReadLine / bash / zsh) plus AI predictions; **→** accepts, **Ctrl+Space** asks the AI on demand (on an empty line it suggests the next command) |
| Explain | "Explain output" button sends the recent output to the assistant to diagnose errors |

### AI providers (Settings ⚙)

| Provider | How it connects | Notes |
| --- | --- | --- |
| Claude API | `POST /v1/messages` (SSE streaming) | Chat `claude-opus-5-5`, autocomplete `claude-haiku-5-5`; key from Settings or `ANTHROPIC_API_KEY` |
| OpenAI API | `POST /chat/completions` | Any OpenAI-compatible base URL works (e.g. Ollama `http://localhost:11434/v1`); key from Settings or `OPENAI_API_KEY` |
| Claude Code CLI | `claude -p` (prompt on stdin) | Uses your existing Claude login/subscription, no API key |
| Codex CLI | `codex exec -` | Uses your existing Codex login |

Chat and autocomplete each pick their own provider. The CLIs are too slow for autocomplete as you type, so use them for chat and Ctrl+Space.

## Layout

```
src-tauri/src/
  main.rs     command registration
  pty.rs      PTY sessions (shells, ssh, agents), shell detection
  ai.rs       Claude / OpenAI / CLI providers, streaming → `ai-chunk` events
  config.rs   settings.json, sessions.json, shell history import (%APPDATA%\moxie)
src/
  terminal.js tabs + xterm.js ↔ PTY wiring
  ai.js       autocomplete, Ctrl+K command bar, chat panel
  main.js     sidebar, dialogs, shortcuts
```

## Known prototype limits / next steps

- AI API keys are still stored in plain JSON (SSH passwords already use the OS keychain); move them to `keyring` too.
- SFTP login doesn't use ssh-agent / Pageant yet (key files and passwords only), and doesn't read `~/.ssh/config` aliases or jump hosts.
- Agent mode detects "command finished" by the prompt returning / output going quiet; shell integration (OSC 133) would make it exact and give exit codes.
- Autocomplete tracks typed input heuristically. Shell integration (OSC 133 prompt marks) would make it exact and enable Warp-style command blocks.
- No split panes, X11 forwarding, tunnels UI, serial/RDP/VNC yet (MobaXterm parity).
