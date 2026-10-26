# Moxie: AI terminal & SSH client

A MobaXterm-style terminal and SSH/SFTP client with Warp-style AI, built in Rust (Tauri 2) with an xterm.js front end.

> **Status: prototype.** Built and tested on Windows 11. The code is cross-platform (Tauri), but macOS and Linux builds haven't been tried yet.

## Download

Get the latest Windows build from **[Releases](https://github.com/VijinV/term/releases/latest)**:

| File | Use it when |
| --- | --- |
| [`Moxie_0.1.2_x64-setup.exe`](https://github.com/VijinV/term/releases/latest/download/Moxie_0.1.2_x64-setup.exe) | Normal install (Start menu entry, uninstaller). Recommended |
| [`Moxie_0.1.2_x64_en-US.msi`](https://github.com/VijinV/term/releases/latest/download/Moxie_0.1.2_x64_en-US.msi) | Managed / IT deployment |

The installers aren't code-signed yet. Windows SmartScreen will warn on first run; choose **More info → Run anyway**.
Moxie needs the WebView2 runtime, which Windows 10/11 already include.

## Features

| Area | What it does |
| --- | --- |
| Terminal | Tabs over a real PTY (ConPTY via `portable-pty`). Detects local shells: PowerShell 7, Windows PowerShell, cmd, Git Bash, WSL (bash/zsh/fish on macOS/Linux) |
| SSH sessions | Saved sessions in the sidebar (host, port, user, password, key, extra args). Runs your system OpenSSH client, so `~/.ssh/config`, agents, jump hosts and `known_hosts` all work. A saved password is typed automatically at the login prompt, as in MobaXterm. **Remember** stores it in Windows Credential Manager (OS keychain), never in Moxie's files |
| Azure Bastion | Session type for VMs reachable only through Azure Bastion: enter the bastion name, resource group and VM resource ID. Moxie opens `az network bastion tunnel` on a free local port and connects the terminal and SFTP through it. Tabs from the same session share one tunnel, which closes with the last tab |
| SFTP browser | Opens next to every SSH tab (Ctrl+Shift+F). Browse, open files with their default app, upload/download files and whole folders (buttons or drag & drop from Explorer) with progress, rename, new folder, recursive delete, "cd here" in the terminal. Uses the same `known_hosts` trust and key / password / keyboard-interactive login |
| AI chat panel | Streaming chat that attaches recent terminal output. Code blocks in replies get **Copy / Insert / Run** buttons. **Explain output** diagnoses the last error |
| Agent mode | On by default (**Auto-run**; switch to *Ask before running* or *Off* in the AI panel): the AI runs commands in the active terminal, reads the output and keeps going until the task is done (up to 25 commands; Stop button). Destructive commands (`rm -rf`, `git push --force`, `DROP TABLE`, `Remove-Item -Recurse`, reboot, …) always ask, even in Auto-run |
| Ask bar | **Ctrl+K**: ask a question in plain language. Moxie runs the commands it needs and shows the answer in the bar. **Shift+Enter** instead just types a command at the prompt |
| Autocomplete | Grey suggestion text at the cursor, from your shell history (PSReadLine / bash / zsh) and from AI |
| CLI agent tabs | Open **Claude Code** (`claude`) or **Codex** (`codex`) as full interactive tabs from the sidebar |

### AI providers

Pick them in **Settings ⚙**. Chat and autocomplete can use different providers.

| Provider | How it connects | Notes |
| --- | --- | --- |
| Claude API | Messages API, streaming | Defaults: `claude-opus-5-5` for chat, `claude-haiku-5-5` for autocomplete. Key from Settings or `ANTHROPIC_API_KEY` |
| OpenAI API | Chat Completions, streaming | Any OpenAI-compatible server works (e.g. Ollama at `http://localhost:11434/v1`). Key from Settings or `OPENAI_API_KEY` |
| Claude Code CLI | `claude -p` | Uses your existing Claude login; no API key needed |
| Codex CLI | `codex exec` | Uses your existing Codex login |

The CLIs are too slow for autocomplete while typing. Use them for chat, the command bar and Ctrl+Space.

### Azure Bastion requirements

- Azure CLI installed and logged in: `az login`, then `az extension add -n bastion`
- A Bastion **Standard or Premium** SKU with **Native client support** enabled
- The VM's resource ID, from the VM's **Properties** page in the Azure portal

Bastion *shareable links* (`https://bst-….bastion.azure.com/…`) only work in a browser and can't be used here.

### Keyboard shortcuts

| Keys | Action |
| --- | --- |
| Ctrl+K | Ask bar (Enter: run commands and show the answer · Shift+Enter: just type the command) |
| → or End | Accept the autocomplete suggestion |
| Ctrl+Space | Ask the AI to complete the line (on an empty line: suggest the next command) |
| Esc | Dismiss the suggestion |
| Ctrl+Shift+A | Toggle the AI panel |
| Ctrl+Shift+F | Toggle the SFTP panel |
| Ctrl+Shift+T / Ctrl+Shift+W | New tab / close tab |
| Ctrl+Shift+C / Ctrl+Shift+V | Copy / paste |

## Build from source

Requires Node 18+, Rust (on Windows: the MSVC toolchain and Visual Studio Build Tools), and WebView2.

```bash
npm install
npm run tauri dev
```

To build the app and installers:

```bash
npm run tauri build
```

The output goes to `src-tauri/target/release/`: `moxie.exe`, plus the installers under `bundle/nsis/` and `bundle/msi/`.

## Project layout

```
src-tauri/src/
  main.rs      app setup and command registration
  pty.rs       PTY sessions (shells, ssh, CLI agents), shell detection, password auto-login
  ai.rs        Claude / OpenAI / CLI providers, streaming
  sftp.rs      SFTP over russh: connect, host-key checks, browse, transfers
  bastion.rs   Azure Bastion tunnels (az CLI), shared per session
  secrets.rs   SSH passwords in the OS credential store
  config.rs    settings.json and sessions.json (%APPDATA%\moxie), shell history import
src/
  terminal.js  tabs, xterm.js ↔ PTY wiring
  ai.js        autocomplete, Ctrl+K command bar, chat panel, agent mode
  files.js     SFTP side panel
  main.js      sidebar, dialogs, settings, shortcuts
  styles.css   UI styles
```

## Known limitations

- AI API keys are stored in plain text in `settings.json`; SSH passwords already use the OS keychain.
- SFTP doesn't use ssh-agent / Pageant or `~/.ssh/config` host aliases yet. It supports key files and passwords.
- Agent mode and autocomplete infer the command line and "command finished" from terminal output. Shell integration (OSC 133) would make this exact and add exit codes.
- Not yet at MobaXterm parity: no split panes, X11 forwarding, port-forwarding UI, serial, RDP or VNC.
