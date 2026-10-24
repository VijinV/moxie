// Tabs + xterm.js instances, each bound to a backend PTY (local shell, ssh, or CLI agent).
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

const THEME = {
  background: "#0d0f15",
  foreground: "#d6dae4",
  cursor: "#a78bfa",
  cursorAccent: "#0d0f15",
  selectionBackground: "#3b3363",
  black: "#1b1e28", red: "#f7768e", green: "#9ece6a", yellow: "#e0af68",
  blue: "#7aa2f7", magenta: "#bb9af7", cyan: "#7dcfff", white: "#c0caf5",
  brightBlack: "#565f89", brightRed: "#ff8fa3", brightGreen: "#b9f27c", brightYellow: "#ffc777",
  brightBlue: "#8db0ff", brightMagenta: "#c7a9ff", brightCyan: "#a4daff", brightWhite: "#e5e9f5",
};
export const FONT_FAMILY = '"Cascadia Mono", "Cascadia Code", Consolas, "JetBrains Mono", monospace';

const tabs = new Map(); // tabId -> tab
const byPty = new Map(); // ptyId -> tab
let activeId = null;
let seq = 0;
let hooks = {};
let fontSize = 14;

const $terminals = () => document.getElementById("terminals");
const $tabs = () => document.getElementById("tabs");

export function initTerminals(h) {
  hooks = h;
  listen("pty-output", (e) => {
    const tab = byPty.get(e.payload.id);
    if (!tab) return;
    tab.lastOutput = Date.now();
    tab.term.write(e.payload.data);
  });
  listen("pty-exit", (e) => {
    const tab = byPty.get(e.payload.id);
    if (!tab) return;
    byPty.delete(e.payload.id);
    tab.exited = true;
    const code = e.payload.code ?? "?";
    tab.term.write(`\r\n\x1b[90m[process exited (${code}) — Enter closes the tab, R restarts]\x1b[0m\r\n`);
    renderTabs();
  });
  new ResizeObserver(() => fitActive()).observe($terminals());
}

export function setFontSize(size) {
  fontSize = size;
  for (const t of tabs.values()) t.term.options.fontSize = size;
  fitActive();
}

/** spec: { title, program, args, kind: "shell" | "ssh" | "agent", shellName } */
export async function openTab(spec) {
  const id = ++seq;
  const el = document.createElement("div");
  el.className = "term-pane";
  $terminals().appendChild(el);

  const term = new Terminal({
    fontFamily: FONT_FAMILY,
    fontSize,
    cursorBlink: true,
    scrollback: 10000,
    allowProposedApi: true,
    theme: THEME,
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(el);

  const ghost = document.createElement("div");
  ghost.className = "ghost hidden";
  el.appendChild(ghost);

  const tab = { id, spec, el, term, fit, ghost, ptyId: null, exited: false, line: "", suggestion: "", lastOutput: 0 };
  tabs.set(id, tab);
  activate(id);

  term.onData((data) => {
    if (tab.exited) {
      if (data === "\r") closeTab(id);
      else if (data.toLowerCase() === "r") restart(tab);
      return;
    }
    hooks.onInput?.(tab, data);
    if (tab.ptyId != null) invoke("pty_write", { id: tab.ptyId, data });
  });
  term.onResize(({ cols, rows }) => {
    if (tab.ptyId != null && !tab.exited) invoke("pty_resize", { id: tab.ptyId, cols, rows });
  });
  term.onCursorMove(() => hooks.onCursor?.(tab));
  term.onScroll(() => hooks.onCursor?.(tab));
  term.attachCustomKeyEventHandler((ev) => hooks.onKey?.(tab, ev) ?? true);

  await spawn(tab);
  return tab;
}

async function spawn(tab) {
  const { program, args = [] } = tab.spec;
  try {
    tab.ptyId = await invoke("pty_spawn", {
      program,
      args,
      cwd: null,
      cols: tab.term.cols,
      rows: tab.term.rows,
      secretKey: tab.spec.secretKey ?? null,
    });
    tab.exited = false;
    tab.line = "";
    byPty.set(tab.ptyId, tab);
  } catch (err) {
    tab.exited = true;
    tab.term.write(`\x1b[31mFailed to start ${program}: ${err}\x1b[0m\r\n\x1b[90m[Enter closes the tab, R retries]\x1b[0m\r\n`);
  }
  renderTabs();
}

function restart(tab) {
  tab.term.reset();
  spawn(tab);
}

export function closeTab(id) {
  const tab = tabs.get(id);
  if (!tab) return;
  if (tab.ptyId != null && !tab.exited) invoke("pty_kill", { id: tab.ptyId });
  byPty.delete(tab.ptyId);
  hooks.onClose?.(tab);
  tab.term.dispose();
  tab.el.remove();
  tabs.delete(id);
  if (activeId === id) {
    const last = [...tabs.keys()].pop();
    activeId = null;
    if (last) activate(last);
  }
  renderTabs();
}

export function activate(id) {
  activeId = id;
  for (const t of tabs.values()) t.el.classList.toggle("active", t.id === id);
  document.getElementById("empty-state").classList.toggle("hidden", tabs.size > 0);
  renderTabs();
  const tab = tabs.get(id);
  if (tab) {
    requestAnimationFrame(() => {
      fitActive();
      tab.term.focus();
    });
  }
  hooks.onActivate?.(tab);
}

export function activeTab() {
  return tabs.get(activeId) ?? null;
}

export function allTabs() {
  return [...tabs.values()];
}

function fitActive() {
  const tab = tabs.get(activeId);
  if (!tab) return;
  try {
    tab.fit.fit();
  } catch {}
  hooks.onCursor?.(tab);
}

function renderTabs() {
  const root = $tabs();
  root.innerHTML = "";
  for (const t of tabs.values()) {
    const b = document.createElement("div");
    b.className = "tab" + (t.id === activeId ? " active" : "") + (t.exited ? " exited" : "");
    const icon = { shell: "›_", ssh: "⇄", agent: "✦" }[t.spec.kind] ?? "›_";
    b.innerHTML = `<span class="tab-icon kind-${t.spec.kind}">${icon}</span><span class="tab-title"></span><button class="tab-close" title="Close (Ctrl+Shift+W)">×</button>`;
    b.querySelector(".tab-title").textContent = t.spec.title;
    b.addEventListener("mousedown", (e) => {
      if (e.button === 1) return closeTab(t.id);
      if (!e.target.classList.contains("tab-close")) activate(t.id);
    });
    b.querySelector(".tab-close").addEventListener("click", () => closeTab(t.id));
    root.appendChild(b);
  }
  hooks.onTabsChanged?.();
}

/** Last `n` lines of the tab's buffer as plain text (for AI context). */
export function getContext(tab, n = 80) {
  if (!tab) return "";
  const buf = tab.term.buffer.active;
  const end = buf.baseY + buf.cursorY + 1;
  const start = Math.max(0, end - n);
  const lines = [];
  for (let i = start; i < end; i++) lines.push(buf.getLine(i)?.translateToString(true) ?? "");
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** Absolute buffer line of the cursor — a marker for capturing a command's output. */
export function cursorLine(tab) {
  const buf = tab.term.buffer.active;
  return buf.baseY + buf.cursorY;
}

/** Text from buffer line `from` to the cursor. */
export function linesFrom(tab, from) {
  const buf = tab.term.buffer.active;
  const end = buf.baseY + buf.cursorY;
  const out = [];
  for (let i = Math.max(0, from); i <= end; i++) out.push(buf.getLine(i)?.translateToString(true) ?? "");
  return out.join("\n").trim();
}

/** Types text into the tab as if pasted; `run` presses Enter afterwards. */
export function sendText(tab, text, run = false) {
  if (!tab || tab.exited || tab.ptyId == null) return;
  tab.term.paste(text);
  if (run) invoke("pty_write", { id: tab.ptyId, data: "\r" });
  hooks.onSent?.(tab, text, run);
  tab.term.focus();
}

export function writeRaw(tab, data) {
  if (tab?.ptyId != null && !tab.exited) invoke("pty_write", { id: tab.ptyId, data });
}
