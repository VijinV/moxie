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
| Split panes | **Ctrl+Shift+D** splits right, **Ctrl+Shift+E** splits down (up to 4 panes per tab, nest freely); drag the dividers to resize, **Alt+arrows** move between panes. Splitting an SSH pane opens another session to the same server |
| Command blocks | Shell integration marks every command: a green/red bar beside each one (click it: copy command, copy output, explain, run again), real exit codes and the current folder. PowerShell, Git Bash and WSL get it automatically; on SSH servers with bash or zsh it is added silently at login (turn off per session for routers and other non-bash shells). cmd.exe isn't supported |
| Error detection | When a command fails, a chip shows **✦ Explain & fix**, which sends that command and its output to the assistant |
| SSH sessions | Saved sessions in the sidebar (host, port, user, password, key, port forwards, extra args). Runs your system OpenSSH client, so `~/.ssh/config`, agents, jump hosts and `known_hosts` all work. A saved password is typed automatically at the login prompt, as in MobaXterm. **Remember** stores it in Windows Credential Manager (OS keychain), never in Moxie's files |
| Azure Bastion | Session type for VMs reachable only through Azure Bastion: enter the bastion name, resource group and VM resource ID. Moxie opens `az network bastion tunnel` on a free local port and connects the terminal and SFTP through it. Tabs from the same session share one tunnel, which closes with the last tab |
| Port forwarding | Per session, one per line: `L 5432:localhost:5432` (your port → through the server), `R 8080:localhost:3000` (server port → back to you), `D 1080` (SOCKS proxy). The 🔌 button on a session starts just the forwards, without a shell; active forwards show in the status bar |
| SFTP browser | Opens next to every SSH tab (Ctrl+Shift+F). Browse, open files with their default app, **Edit** files (opens your editor; every save uploads back to the server), upload/download files and whole folders (buttons or drag & drop from Explorer) with progress, rename, new folder, recursive delete, "cd here" in the terminal. Uses the same `known_hosts` trust and key / password / keyboard-interactive login |
| AI chat panel | Streaming chat that attaches recent terminal output. Chats are saved automatically: Moxie reopens your last chat on start, and 🕘 History lets you pick up any earlier one (＋ starts a new chat). Code blocks in replies get **Copy / Insert / Run** buttons. **Explain output** diagnoses the last error |
| Server-aware AI | The assistant is told the real OS, distribution, shell, user, host and folder of the active terminal (e.g. *bash 5.3 on Ubuntu 24.04, root@web-01*), so it writes commands that fit |
| Agent mode | On by default (**Auto-run**; switch to *Ask before running* or *Off* in the AI panel): the AI runs commands in the active terminal, waits for each to finish, reads the output and exit code, and keeps going until the task is done (up to 25 commands; Stop button). Destructive commands (`rm -rf`, `git push --force`, `DROP TABLE`, `Remove-Item -Recurse`, reboot, …) always ask, even in Auto-run |
| Ask bar | **Ctrl+K**: ask a question in plain language. Moxie runs the commands it needs and shows the answer in the bar. **Shift+Enter** instead just types a command at the prompt |
| Autocomplete | A menu under the cursor as you type: subcommands and flags for common tools (git, docker, kubectl, npm, cargo, systemctl, apt, PowerShell cmdlets…), file and folder names (local, or on the server through SFTP) and history. **↓/↑** choose, **Tab** accepts, **Esc** closes. Plus grey inline text from history and AI (→ accepts) |
| Auto-update | Moxie checks GitHub Releases and shows **⬆ Update** in the status bar; one click downloads the signed installer, installs it and restarts (also *Settings → Check for updates*) |
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
| Tab · ↓/↑ · Esc | Autocomplete menu: accept · choose · close (Enter runs the line unless you picked an item) |
| → or End | Accept the grey inline suggestion |
| Ctrl+Space | Ask the AI to complete the line (on an empty line: suggest the next command) |
| Esc | Dismiss the suggestion |
| Ctrl+Shift+A | Toggle the AI panel |
| Ctrl+Shift+F | Toggle the SFTP panel |
| Ctrl+Shift+T / Ctrl+Shift+W | New tab / close pane |
| Ctrl+Shift+D / Ctrl+Shift+E | Split right / split down |
| Alt+arrows | Move between panes |
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

## Releasing

Bump the version in `package.json`, `src-tauri/Cargo.toml` and `src-tauri/tauri.conf.json`, update the two download links above, then:

```bash
npm run release -- --publish --notes notes.md
```

This builds the installers, **signs** them for the auto-updater, writes `latest.json` and creates the GitHub release with all three files (needs `gh auth login`). Without `--publish` it only builds.

The signing key lives at `~/.tauri/moxie-updater.key` (or `TAURI_SIGNING_PRIVATE_KEY`). Back it up: installed copies only accept updates signed with it, and it must never be committed. Versions before the first auto-update release have to be updated by hand once.

## Project layout

```
src-tauri/src/
  main.rs      app setup and command registration
  pty.rs       PTY sessions (shells, ssh, CLI agents), shell detection, password auto-login
  ai.rs        Claude / OpenAI / CLI providers, streaming
  sftp.rs      SFTP over russh: connect, host-key checks, browse, transfers
  bastion.rs   Azure Bastion tunnels (az CLI), shared per session
  secrets.rs   SSH passwords in the OS credential store
  chats.rs     AI chat history (%APPDATA%\moxie\chats)
  config.rs    settings.json and sessions.json (%APPDATA%\moxie), shell history import
src/
  terminal.js  tabs, split panes, xterm.js ↔ PTY wiring
  shell.js     shell integration: hook scripts, command blocks, exit codes, SSH injection
  completion.js  autocomplete menu (commands, flags, paths, history)
  ai.js        inline suggestions, Ctrl+K bar, chat panel, agent mode, error chip
  updater.js   auto-update
  layout.js    resizable side panels
  files.js     SFTP side panel
  main.js      sidebar, dialogs, settings, shortcuts
  styles.css   UI styles
```

## Known limitations

- AI API keys are stored in plain text in `settings.json`; SSH passwords already use the OS keychain.
- SFTP doesn't use ssh-agent / Pageant or `~/.ssh/config` host aliases yet. It supports key files and passwords.
- Shell integration needs PowerShell, bash or zsh. In cmd.exe, fish or unusual remote shells, agent mode and autocomplete fall back to reading the screen, without exit codes.
- Autocomplete knows a fixed set of common tools; there is no plugin system for completion specs yet.
- Not yet at MobaXterm parity: no X11 forwarding, serial, RDP or VNC.
