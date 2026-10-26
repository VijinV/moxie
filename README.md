# Moxie: AI terminal & SSH client

A MobaXterm-style terminal and SSH/SFTP client with Warp-style AI, built in Rust (Tauri 2) with an xterm.js front end.

> **Status: prototype.** Built and tested on Windows 11. The code is cross-platform (Tauri), but macOS and Linux builds haven't been tried yet.

## Download

Get the latest Windows build from **[Releases](https://github.com/VijinV/term/releases/latest)**:

| File | Use it when |
| --- | --- |
| [`Moxie_0.2.0_x64-setup.exe`](https://github.com/VijinV/term/releases/latest/download/Moxie_0.2.0_x64-setup.exe) | Normal install (Start menu entry, uninstaller). Recommended |
| [`Moxie_0.2.0_x64_en-US.msi`](https://github.com/VijinV/term/releases/latest/download/Moxie_0.2.0_x64_en-US.msi) | Managed / IT deployment |

From 0.2.0 on, Moxie updates itself (⬆ Update in the status bar). The installers aren't code-signed yet, so Windows SmartScreen warns on first run; choose **More info → Run anyway**.
Moxie needs the WebView2 runtime, which Windows 10/11 already include.

## Features

### Terminal

| Feature | What it does |
| --- | --- |
| Tabs & shells | Real PTYs (ConPTY via `portable-pty`). Detects PowerShell 7, Windows PowerShell, cmd, Git Bash and WSL (bash/zsh/fish on macOS/Linux) |
| Split panes | Toolbar icons or **Ctrl+Shift+D** (right) / **Ctrl+Shift+E** (down); up to 4 panes per tab, nested freely, dividers draggable, **Alt+arrows** to move between them |
| Command blocks | Shell integration marks every command: a green/red bar with its exit code; click it to copy the command or output, fold the output, explain it, save it as a snippet or run it again. **Ctrl+Shift+↑/↓** jumps between commands. Works in PowerShell, Git Bash, WSL and on SSH servers with bash or zsh (added invisibly at login; can be turned off per session) |
| Error detection | When a command fails, a chip offers **✦ Explain & fix** for exactly that command and its output |
| Find | **Ctrl+F**: highlights every match, with match count, case and regex toggles |
| Links & paths | **Ctrl+click** a URL to open it in the browser, or a file path to open it (locally in Explorer; on SSH tabs in the SFTP panel) |
| Broadcast typing | Multi-exec: type once into every pane of the tab, or into every open terminal (toolbar 📡 / **Ctrl+Shift+B**, cycles off → this tab → all tabs) |
| Themes & fonts | 8 colour schemes, font, size (**Ctrl+= / Ctrl+-**), line height, cursor style |
| Workspace restore | Tabs, splits and SSH sessions reopen when Moxie starts (can be turned off in Settings) |
| Autocomplete | A menu under the cursor: subcommands and flags for common tools, file and folder names (local, or on the server via SFTP) and history; plus grey inline suggestions from history and AI |

### Sessions & servers

| Feature | What it does |
| --- | --- |
| SSH sessions | Saved sessions in folders (host, port, user, password, key, jump host, port forwards). Uses your system OpenSSH, so `~/.ssh/config`, agents and `known_hosts` work. Saved passwords are typed at the login prompt (also both prompts through a jump host) and kept in Windows Credential Manager |
| Import | **⇩** in the sidebar imports from `~/.ssh/config`, MobaXterm (`MobaXterm.ini` or an exported `.mxtsessions`, with folders) and PuTTY, with a preview before anything is added |
| Jump hosts | Terminal and SFTP both go through the jump host, with separate host-key checks for each |
| RDP & VNC | Session types that open Windows Remote Desktop or an installed VNC viewer (TigerVNC, RealVNC, TightVNC, UltraVNC) |
| Azure Bastion | Connects through `az network bastion tunnel` (see below); terminal and SFTP share one tunnel |
| Port forwarding | Per session: `L 5432:localhost:5432`, `R 8080:localhost:3000`, `D 1080`. **🔌** starts just the forwards, without a shell |
| SFTP panel | Next to every SSH tab (**Ctrl+Shift+F**): browse, upload/download files and folders (drag & drop from Explorer), rename, delete, **Edit** (opens your editor; every save uploads back) |
| Server dashboard | The panel's **Server** tab: CPU, load, memory, swap, disks, uptime and top processes, refreshed every 4 s over the panel's own connection |
| Snippets & workflows | Saved commands in the sidebar (**Ctrl+Shift+S**) with `{{name:default}}` placeholders. Workflows run line by line, wait for each command and stop at the first failure |

### AI

| Feature | What it does |
| --- | --- |
| Chat panel | Streaming answers rendered as Markdown; code blocks get **Copy / Insert / Run** |
| Agent with tools | With the Claude or OpenAI API the assistant uses real tool calls: run a command, read a file, list a folder (on the server for SSH tabs), then keeps going until the task is done. *Auto-run* by default; *Ask before running* or *Off* in the panel. Destructive commands (`rm -rf`, `git push --force`, `DROP TABLE`, reboot, …) always ask first. The Claude Code / Codex CLIs do the same through a text protocol |
| Server-aware | The assistant is told the active terminal's OS, distribution, shell, user, host and folder |
| One chat per SSH session | Each SSH session keeps its own chat; reopening that session brings it back. Local shells share one chat |
| Chat history & search | Chats are saved automatically; 🕘 History lists them and searches their full text |
| 📝 Summarize session | A handoff summary built from the session's commands and output: what was done, current state, problems, next steps |
| 🔎 Search logs | Describe what you're looking for; the assistant searches the logs read-only and reports matches with timestamps |
| Ask bar | **Ctrl+K**: ask in plain language; Moxie runs what it needs and shows the answer. **Shift+Enter** just types a command |
| CLI agent tabs | Open **Claude Code** or **Codex** as full interactive tabs |

### AI providers

Pick them in **Settings ⚙**; chat and autocomplete can use different ones. API keys are stored in **Windows Credential Manager**, not in Moxie's settings file.

| Provider | How it connects | Notes |
| --- | --- | --- |
| Claude API | Messages API, streaming, tool calling | Defaults: `claude-opus-5-5` for chat, `claude-haiku-5-5` for autocomplete. Or set `ANTHROPIC_API_KEY` |
| OpenAI API | Chat Completions, streaming, tool calling | Any OpenAI-compatible server works (e.g. Ollama at `http://localhost:11434/v1`). Or set `OPENAI_API_KEY` |
| Claude Code CLI | `claude -p` | Uses your existing Claude login; no API key |
| Codex CLI | `codex exec` | Uses your existing Codex login |

### Azure Bastion requirements

- Azure CLI installed and logged in: `az login`, then `az extension add -n bastion`
- A Bastion **Standard or Premium** SKU with **Native client support** enabled
- The VM's resource ID, from the VM's **Properties** page in the Azure portal

Bastion *shareable links* (`https://bst-….bastion.azure.com/…`) only work in a browser and can't be used here.

### Keyboard shortcuts

Press **Ctrl+/** (or **⌨ Shortcuts** in the status bar) for the full list in the app.

| Keys | Action |
| --- | --- |
| Ctrl+K | Ask bar |
| Ctrl+F | Find in terminal |
| Ctrl+Shift+D / E | Split right / down |
| Alt+arrows | Move between panes |
| Ctrl+Shift+B | Broadcast typing |
| Ctrl+Shift+↑ / ↓ | Previous / next command |
| Tab · ↓/↑ · Esc | Autocomplete menu: accept · choose · close |
| → or End | Accept the grey inline suggestion |
| Ctrl+Space | Ask the AI to complete the line |
| Ctrl+Shift+A / F / S | AI panel / files & server panel / snippets |
| Ctrl+Shift+T / W | New tab / close pane |
| Ctrl+Shift+C / V | Copy / paste |
| Ctrl+= / Ctrl+- | Font size |

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

## Releasing

Bump the version in `package.json`, `src-tauri/Cargo.toml` and `src-tauri/tauri.conf.json`, update the two download links above, then:

```bash
npm run release -- --publish --notes notes.md
```

This builds the installers, signs them for the auto-updater, writes `latest.json` and creates the GitHub release (needs `gh auth login`). Without `--publish` it only builds.

**Update signing key:** `~/.tauri/moxie-updater.key` (or `TAURI_SIGNING_PRIVATE_KEY`). Back it up: installed copies only accept updates signed with it. Never commit it.

**Windows code signing** (removes the SmartScreen warning) is applied automatically when one of these is set:

| Option | Environment variables |
| --- | --- |
| Code-signing certificate in the Windows certificate store | `WINDOWS_CERT_THUMBPRINT` |
| Azure Trusted Signing (`trusted-signing-cli` on PATH, logged in to Azure) | `AZURE_SIGNING_ENDPOINT`, `AZURE_SIGNING_ACCOUNT`, `AZURE_SIGNING_PROFILE` |

## Project layout

```
src-tauri/src/
  main.rs       app setup and command registration
  pty.rs        PTY sessions (shells, ssh, CLI agents), shell detection, password auto-login
  ai.rs         one-shot completions (autocomplete, Ask bar), CLI providers
  ai_tools.rs   streaming chat turns with tool calling (Claude / OpenAI)
  sftp.rs       SFTP over russh: jump hosts, host keys, transfers, edit & upload, remote exec
  bastion.rs    Azure Bastion tunnels (az CLI)
  import.rs     session import (ssh config, MobaXterm, PuTTY), RDP / VNC launchers
  secrets.rs    SSH passwords in the OS credential store
  chats.rs      chat history and search
  config.rs     settings, sessions, snippets, workspace, API keys in the keychain
src/
  terminal.js   tabs, split panes, find/links/broadcast, workspace layout
  shell.js      shell integration: hooks, command blocks, exit codes, folding, SSH injection
  completion.js autocomplete menu
  ai.js         inline suggestions, Ask bar, chat panel, agent & tools, per-session chats
  files.js      SFTP panel          dashboard.js  server dashboard
  snippets.js   snippets & workflows  find.js     find bar
  themes.js     colour schemes        shortcuts.js  shortcut reference
  updater.js    auto-update           layout.js     resizable side panels
  main.js       sidebar, dialogs, settings, keyboard shortcuts
```

## Known limitations

- SFTP doesn't use ssh-agent / Pageant or `~/.ssh/config` host aliases yet (key files and passwords only), and supports a single jump host (the terminal supports chains).
- Shell integration needs PowerShell, bash or zsh. In cmd.exe, fish or unusual remote shells, agent mode and autocomplete fall back to reading the screen, without exit codes.
- Folding output hides it behind a bar but can't remove the rows (xterm.js limitation).
- RDP and VNC open external apps; they aren't embedded in a Moxie tab. No X11 forwarding or serial yet.
- Code signing needs a certificate or an Azure Trusted Signing account (see Releasing).
