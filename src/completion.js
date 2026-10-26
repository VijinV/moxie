// Warp/Fig-style completion menu under the cursor: subcommands and flags for common tools,
// file and folder names (local disk, or the server via the tab's SFTP connection), and history.
// ↓/↑ select · Tab accepts · Enter accepts only an item you picked · Esc closes.
import { invoke } from "@tauri-apps/api/core";
import { writeRaw } from "./terminal.js";
import { getHistory } from "./ai.js";

const SPECS = {
  git: {
    sub: ["status", "add", "commit", "push", "pull", "fetch", "checkout", "switch", "branch", "merge", "rebase", "log", "diff", "stash", "clone", "init", "remote", "reset", "restore", "tag", "cherry-pick", "show", "blame"],
    opts: ["--help", "-m", "--amend", "--all", "-b", "--force-with-lease", "--oneline", "--graph", "--staged", "-v", "--no-verify"],
  },
  docker: {
    sub: ["ps", "images", "run", "exec", "logs", "build", "pull", "push", "stop", "start", "restart", "rm", "rmi", "compose", "inspect", "network", "volume", "system", "stats", "cp"],
    opts: ["-it", "-d", "--rm", "-p", "-v", "-e", "--name", "-f", "--tail", "-a", "--build"],
  },
  kubectl: {
    sub: ["get", "describe", "apply", "delete", "logs", "exec", "port-forward", "rollout", "scale", "config", "top", "create", "edit", "cp"],
    opts: ["-n", "--namespace", "-o", "wide", "yaml", "-f", "-A", "--all-namespaces", "-w", "-l", "--context", "-it"],
  },
  npm: { sub: ["install", "run", "start", "test", "build", "ci", "update", "uninstall", "init", "publish", "outdated", "audit", "ls", "exec"], opts: ["--save-dev", "-D", "-g", "--force"] },
  pnpm: { sub: ["install", "add", "remove", "run", "dev", "build", "test", "update", "exec", "dlx"], opts: ["-D", "-g", "--filter"] },
  yarn: { sub: ["install", "add", "remove", "run", "dev", "build", "test", "upgrade"], opts: ["-D", "--dev"] },
  cargo: { sub: ["build", "run", "test", "check", "clippy", "fmt", "add", "update", "new", "init", "doc", "bench", "publish", "install", "tree"], opts: ["--release", "--all-features", "-p", "--", "--locked"] },
  systemctl: { sub: ["status", "start", "stop", "restart", "reload", "enable", "disable", "is-active", "list-units", "daemon-reload", "cat"], opts: ["--now", "--user", "--no-pager", "--failed"] },
  journalctl: { opts: ["-u", "-f", "-n", "--since", "--no-pager", "-xe", "-b", "-p"] },
  apt: { sub: ["update", "upgrade", "install", "remove", "purge", "search", "show", "list", "autoremove"], opts: ["-y", "--no-install-recommends"] },
  dnf: { sub: ["install", "remove", "update", "search", "info", "list"], opts: ["-y"] },
  ssh: { opts: ["-p", "-i", "-L", "-R", "-D", "-J", "-v", "-N", "-o"] },
  scp: { opts: ["-r", "-P", "-i"] },
  ls: { opts: ["-la", "-lh", "-a", "-l", "-R", "-t", "-S"] },
  grep: { opts: ["-r", "-i", "-n", "-v", "-E", "-l", "-w", "--include", "--exclude-dir"] },
  tail: { opts: ["-f", "-n", "-F"] },
  ps: { opts: ["aux", "-ef"] },
  tar: { opts: ["-xzf", "-czf", "-tf", "-xvf", "-C"] },
  chmod: { opts: ["+x", "-R", "755", "644", "600"] },
  curl: { opts: ["-I", "-L", "-o", "-O", "-X", "-H", "-d", "-s", "-v", "-k"] },
  df: { opts: ["-h"] },
  du: { opts: ["-sh", "-h", "--max-depth=1"] },
  find: { opts: ["-name", "-iname", "-type", "-mtime", "-size", "-maxdepth", "-exec", "-delete"] },
  "Get-ChildItem": { opts: ["-Recurse", "-Force", "-Filter", "-File", "-Directory", "-Name", "-Include", "-Exclude"] },
  "Get-Process": { opts: ["-Name", "-Id"] },
  "Get-Service": { opts: ["-Name", "-DisplayName"] },
  "Select-String": { opts: ["-Pattern", "-Path", "-SimpleMatch", "-CaseSensitive", "-Context"] },
  "Remove-Item": { opts: ["-Recurse", "-Force", "-WhatIf"] },
  "Copy-Item": { opts: ["-Destination", "-Recurse", "-Force"] },
  "Get-Content": { opts: ["-Tail", "-Wait", "-TotalCount", "-Raw"] },
  winget: { sub: ["install", "upgrade", "uninstall", "search", "list", "show"], opts: ["--id", "-e", "--silent"] },
};
const COMMON = ["cd", "ls", "cat", "less", "head", "tail", "grep", "find", "cp", "mv", "rm", "mkdir", "touch", "chmod", "chown", "sudo", "ps", "top", "htop", "kill", "df", "du", "free", "uname", "whoami", "ping", "curl", "wget", "tar", "unzip", "nano", "vim", "code", "python", "python3", "node", "pip", "exit", "clear", "history", "echo", "export", "Get-ChildItem", "Get-Content", "Set-Location", "Select-String", "Get-Process", "Stop-Process", "Get-Service", "Remove-Item", "Copy-Item", "Move-Item", "New-Item", "Test-Path", "Invoke-WebRequest"];
const PATH_CMDS = new Set(["cd", "ls", "ll", "cat", "less", "more", "tail", "head", "vim", "vi", "nano", "code", "rm", "cp", "mv", "chmod", "chown", "source", ".", "bash", "sh", "python", "python3", "node", "du", "find", "tar", "unzip", "scp", "type", "dir", "notepad", "explorer", "sl", "gci", "Get-Content", "Set-Location", "Remove-Item", "Copy-Item", "Move-Item", "Get-ChildItem", "Get-Item", "Test-Path", "Invoke-Item"]);
const ICON = { sub: "⌘", opt: "⚑", dir: "📁", file: "📄", cmd: "›", hist: "🕘" };

const dirCache = new Map();
let timer;

/** Called whenever the prompt line changes (after the shell echoed it). */
export function updateCompletion(tab) {
  if (tab.comp && tab.comp.line === tab.line) return; // unchanged: keep the menu as it is
  clearTimeout(timer);
  if (!tab.comp?.picking) closeCompletion(tab);
  timer = setTimeout(() => compute(tab), 110);
}

async function compute(tab) {
  const line = tab.line;
  if (line == null || !line.trim() || tab.exited || tab.spec.kind === "agent" || tab.term.buffer.active.type !== "normal") {
    return closeCompletion(tab);
  }
  const words = splitWords(line);
  const endsWithSpace = /\s$/.test(line);
  const token = endsWithSpace ? "" : words.at(-1) ?? "";
  const argIndex = endsWithSpace ? words.length : words.length - 1;
  const cmd = words[0] ?? "";
  const spec = SPECS[cmd];
  let items = [];

  if (argIndex === 0) {
    const seen = new Set();
    for (const c of [...Object.keys(SPECS), ...COMMON, ...getHistory().map((h) => h.split(/\s+/)[0]).reverse()]) {
      if (c.length > token.length && c.toLowerCase().startsWith(token.toLowerCase()) && !seen.has(c)) {
        seen.add(c);
        items.push({ label: c, insert: c, kind: "cmd" });
      }
    }
  } else {
    if (spec?.sub && argIndex === 1 && !token.startsWith("-")) {
      items.push(...spec.sub.filter((s) => s.startsWith(token) && s !== token).map((s) => ({ label: s, insert: s, kind: "sub" })));
    }
    if (spec?.opts && (token.startsWith("-") || (!spec.sub && token === "" && endsWithSpace))) {
      items.push(...spec.opts.filter((o) => o.startsWith(token) && o !== token).map((o) => ({ label: o, insert: o, kind: "opt" })));
    }
    const wantsPath = PATH_CMDS.has(cmd) || /[\\/~.]/.test(token) || (cmd === "git" && ["add", "diff", "checkout", "restore", "rm"].includes(words[1]));
    if (wantsPath && !token.startsWith("-")) items.push(...(await pathItems(tab, token)));
  }
  // Whole-line history matches, after the specific suggestions.
  if (line.trim().length >= 2) {
    const seen = new Set(items.map((i) => i.label));
    const hist = getHistory();
    for (let i = hist.length - 1; i >= 0 && items.filter((x) => x.kind === "hist").length < 3; i--) {
      const h = hist[i];
      if (h.length > line.length && h.startsWith(line) && !seen.has(h)) {
        seen.add(h);
        items.push({ label: h, insert: h.slice(line.length - token.length), kind: "hist", whole: true });
      }
    }
  }
  if (tab.line !== line) return; // typed on while we were listing folders
  items = items.slice(0, 40);
  if (!items.length) return closeCompletion(tab);
  showMenu(tab, items, token, line);
}

function splitWords(line) {
  const out = [];
  for (const m of line.matchAll(/"[^"]*"?|'[^']*'?|\S+/g)) out.push(m[0]);
  return out;
}

async function pathItems(tab, token) {
  const unquoted = token.replace(/^["']/, "");
  const sepIdx = Math.max(unquoted.lastIndexOf("/"), unquoted.lastIndexOf("\\"));
  const dirPart = sepIdx >= 0 ? unquoted.slice(0, sepIdx + 1) : "";
  const partial = sepIdx >= 0 ? unquoted.slice(sepIdx + 1) : unquoted;
  const remote = tab.spec.kind === "ssh";
  let cwd = tab.si?.cwd ?? (remote ? tab.files?.cwd : null);
  const posix = remote || /bash|wsl/i.test(tab.spec.shellName ?? "");
  if (!remote && cwd?.startsWith("/")) {
    // Git Bash reports /c/Users/…; WSL's Linux paths aren't readable from here.
    if (!/^\/[a-zA-Z]\//.test(cwd)) return [];
    cwd = `${cwd[1].toUpperCase()}:${cwd.slice(2).replace(/\//g, "\\")}`;
  }
  let base;
  if (remote) {
    if (tab.files?.status !== "ready") return [];
    const home = tab.files.home ?? "~";
    base = dirPart.startsWith("/") ? dirPart : dirPart.startsWith("~") ? home + dirPart.slice(1) : `${cwd ?? home}/${dirPart}`;
  } else {
    if (/^[A-Za-z]:/.test(dirPart) || dirPart.startsWith("\\\\")) base = dirPart;
    else if (dirPart.startsWith("~")) base = (tab.si?.info?.home ?? "") + dirPart.slice(1);
    else if (!cwd) return [];
    else base = `${cwd}\\${dirPart}`;
    base ||= ".";
  }
  const key = `${tab.id}:${remote}:${base}`;
  let entries = dirCache.get(key);
  if (!entries || Date.now() - entries.at > 4000) {
    try {
      const list = remote
        ? (await invoke("sftp_list", { connId: tab.files.connId, path: base || "." })).map((e) => ({ name: e.name, is_dir: e.is_dir }))
        : await invoke("fs_list", { dir: base });
      entries = { at: Date.now(), list };
      dirCache.set(key, entries);
    } catch {
      return [];
    }
  }
  const lower = partial.toLowerCase();
  return entries.list
    .filter((e) => e.name.toLowerCase().startsWith(lower) && e.name !== partial && (!e.name.startsWith(".") || partial.startsWith(".")))
    .sort((a, b) => b.is_dir - a.is_dir || a.name.localeCompare(b.name))
    .slice(0, 30)
    .map((e) => {
      const full = dirPart + e.name + (e.is_dir ? (posix ? "/" : "\\") : "");
      const needsQuote = /\s/.test(full);
      return { label: e.name + (e.is_dir ? "/" : ""), insert: needsQuote ? `"${full}"` : full, kind: e.is_dir ? "dir" : "file", replace: true };
    });
}

// ------------------------------------------------------------------ menu UI

function showMenu(tab, items, token, line) {
  let el = tab.comp?.el;
  if (!el) {
    el = document.createElement("div");
    el.className = "completion-menu";
    el.addEventListener("mousedown", (e) => {
      const row = e.target.closest("[data-i]");
      if (!row) return;
      e.preventDefault();
      accept(tab, Number(row.dataset.i));
    });
    tab.el.appendChild(el);
  }
  tab.comp = { el, items, token, line, sel: -1, picking: false };
  render(tab);
  position(tab);
}

function render(tab) {
  const { el, items, sel } = tab.comp;
  el.innerHTML = items
    .map(
      (it, i) =>
        `<div class="cm-item${i === sel ? " sel" : ""}" data-i="${i}"><span class="cm-icon">${ICON[it.kind]}</span><span class="cm-label"></span><span class="cm-kind">${
          { sub: "subcommand", opt: "option", dir: "folder", file: "file", cmd: "command", hist: "history" }[it.kind]
        }</span></div>`,
    )
    .join("");
  el.querySelectorAll(".cm-label").forEach((s, i) => (s.textContent = items[i].label));
  el.querySelector(".sel")?.scrollIntoView({ block: "nearest" });
}

export function positionCompletion(tab) {
  if (tab.comp?.el) position(tab);
}

function position(tab) {
  const { el, token } = tab.comp;
  const screen = tab.el.querySelector(".xterm-screen");
  if (!screen) return;
  const buf = tab.term.buffer.active;
  const cellW = screen.clientWidth / tab.term.cols;
  const cellH = screen.clientHeight / tab.term.rows;
  const paneRect = tab.el.getBoundingClientRect();
  const scr = screen.getBoundingClientRect();
  const x = Math.max(0, buf.cursorX - token.length) * cellW;
  const yBelow = (buf.cursorY + 1) * cellH;
  el.style.left = `${Math.min(scr.left - paneRect.left + x, paneRect.width - 340)}px`;
  // Flip above the cursor when there isn't room below.
  const below = scr.top - paneRect.top + yBelow;
  const height = Math.min(el.scrollHeight, 240);
  el.style.top = below + height > paneRect.height ? `${below - cellH - height - 4}px` : `${below + 2}px`;
}

export function closeCompletion(tab) {
  tab.comp?.el?.remove();
  tab.comp = null;
}

/** Key handling while the menu is open. Returns true if the key was used. */
export function completionKey(tab, ev) {
  const c = tab.comp;
  if (!c) return false;
  const plain = !ev.ctrlKey && !ev.altKey && !ev.metaKey;
  if (!plain) return false;
  if (ev.key === "ArrowDown") {
    c.picking = true;
    c.sel = (c.sel + 1) % c.items.length;
    render(tab);
    return true;
  }
  if (ev.key === "ArrowUp") {
    if (c.sel < 0) {
      closeCompletion(tab); // let the shell's own history take ↑
      return false;
    }
    c.sel -= 1;
    render(tab);
    return true;
  }
  if (ev.key === "Tab" && !ev.shiftKey) {
    accept(tab, Math.max(0, c.sel));
    return true;
  }
  if (ev.key === "Enter" && c.sel >= 0) {
    accept(tab, c.sel);
    return true;
  }
  if (ev.key === "Escape") {
    closeCompletion(tab);
    return true;
  }
  return false;
}

function accept(tab, i) {
  const { items, token } = tab.comp;
  const it = items[i];
  closeCompletion(tab);
  if (!it) return;
  let data;
  if (!it.replace && it.insert.startsWith(token)) data = it.insert.slice(token.length);
  else data = "\x7f".repeat(token.length) + it.insert; // replace the partial word
  if (!it.whole && !/[\\/]$/.test(it.insert)) data += " ";
  writeRaw(tab, data);
  if (!tab.si?.active) tab.line = (tab.line ?? "").slice(0, (tab.line ?? "").length - token.length) + it.insert + (data.endsWith(" ") ? " " : "");
  tab.refreshUntil = Date.now() + 400;
}
