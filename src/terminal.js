// Tabs and split panes. A tab ("group") holds 1–4 panes laid out in a row or a column; each pane
// is an xterm.js instance bound to a backend PTY (local shell, ssh, or CLI agent).
// The rest of the app works with panes: activeTab() returns the focused pane of the active tab.
import { Terminal } from "@xterm/xterm";
import { highlight } from "./highlight.js";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { setupShellIntegration, filterOutput, initShellIntegration } from "./shell.js";

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
const MAX_PANES = 4;

const panes = new Map(); // paneId -> pane
const groups = new Map(); // groupId -> { id, panes: [], dir: "row" | "column", active: pane, el }
const byPty = new Map(); // ptyId -> pane
let activeGroupId = null;
let seq = 0;
let hooks = {};
let fontSize = 14;
// Appearance, set from Settings (theme, font, line height, cursor).
let look = { theme: THEME, fontFamily: FONT_FAMILY, lineHeight: 1, cursorStyle: "block" };

const $terminals = () => document.getElementById("terminals");
const $tabs = () => document.getElementById("tabs");

export function initTerminals(h) {
  hooks = h;
  initShellIntegration({ ...h, write: (pane, data) => writeRaw(pane, data) });
  listen("pty-output", (e) => {
    const pane = byPty.get(e.payload.id);
    if (!pane) return;
    pane.lastOutput = Date.now();
    const data = highlight(pane, filterOutput(pane, e.payload.data));
    if (data) pane.term.write(data, () => hooks.onOutput?.(pane));
  });
  listen("pty-exit", (e) => {
    const pane = byPty.get(e.payload.id);
    if (!pane) return;
    byPty.delete(e.payload.id);
    pane.exited = true;
    const code = e.payload.code ?? "?";
    // Like Windows Terminal: a clean exit (you typed `exit`) closes the pane; a failure stays
    // open so the error can be read.
    if (code === 0 && !pane.spec.keepOnExit) return closeTab(pane.id);
    pane.term.write(`\r\n\x1b[90m[process exited (${code}) — Enter closes the pane, R restarts]\x1b[0m\r\n`);
    renderTabs();
  });
}

export function setFontSize(size) {
  fontSize = size;
  for (const p of panes.values()) p.term.options.fontSize = size;
  for (const p of panes.values()) fitPane(p);
}

export const getFontSize = () => fontSize;

/** Applies theme / font / line height / cursor style to every open terminal (and new ones). */
export function setAppearance(next) {
  look = { ...look, ...next };
  for (const p of panes.values()) {
    Object.assign(p.term.options, { theme: look.theme, fontFamily: look.fontFamily, lineHeight: look.lineHeight, cursorStyle: look.cursorStyle });
    fitPane(p);
  }
  document.documentElement.style.setProperty("--term-bg", look.theme.background);
}

/**
 * spec: { title, program, args, kind: "shell" | "ssh" | "agent", shellName, integration }
 * opts.splitOf: put the new pane next to this pane (same tab); opts.dir: "row" | "column".
 */
export async function openTab(spec, opts = {}) {
  const id = ++seq;
  const el = document.createElement("div");
  el.className = "term-pane";

  const term = new Terminal({
    fontFamily: look.fontFamily,
    fontSize,
    lineHeight: look.lineHeight,
    cursorStyle: look.cursorStyle,
    cursorBlink: true,
    scrollback: 10000,
    allowProposedApi: true,
    theme: look.theme,
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  const search = new SearchAddon();
  term.loadAddon(search);
  // Ctrl+click opens links (a plain click is for selecting text).
  term.loadAddon(new WebLinksAddon((ev, uri) => (ev.ctrlKey || ev.metaKey) && hooks.onOpenLink?.(uri)));

  const ghost = document.createElement("div");
  ghost.className = "ghost hidden";

  const pane = { id, spec, el, term, fit, search, ghost, ptyId: null, exited: false, line: "", suggestion: "", lastOutput: 0, lastKey: 0 };
  panes.set(id, pane);

  let group = opts.splitOf ? groups.get(opts.splitOf.groupId) : null;
  if (group && group.panes.length >= MAX_PANES) group = null;
  if (group) {
    insertSplit(group, opts.splitOf, pane, opts.dir ?? "row");
  } else {
    const gid = ++seq;
    const gel = document.createElement("div");
    gel.className = "pane-group";
    $terminals().appendChild(gel);
    pane.node = { type: "pane", pane, size: 1 };
    group = { id: gid, root: pane.node, panes: [pane], active: pane, el: gel };
    groups.set(gid, group);
  }
  pane.groupId = group.id;
  layoutGroup(group);
  term.open(el);
  el.appendChild(ghost);
  const closeBtn = document.createElement("button");
  closeBtn.className = "pane-close";
  closeBtn.title = "Close this pane (Ctrl+Shift+W)";
  closeBtn.textContent = "×";
  closeBtn.addEventListener("mousedown", (e) => e.stopPropagation());
  closeBtn.addEventListener("click", (e) => (e.stopPropagation(), closeTab(id)));
  el.appendChild(closeBtn);
  setupShellIntegration(pane, spec.integration ?? "none");
  registerPathLinks(pane);

  el.addEventListener("mousedown", () => focusPane(pane), true);
  term.textarea?.addEventListener("focus", () => focusPane(pane, false));
  new ResizeObserver(() => fitPane(pane)).observe(el);

  term.onData((data) => {
    if (pane.exited) {
      if (data === "\r") closeTab(id);
      else if (data.toLowerCase() === "r") restart(pane);
      return;
    }
    // Escape sequences here are usually xterm's own replies (focus in/out, device queries), not typing.
    if (!data.startsWith("\x1b")) pane.lastKey = Date.now();
    hooks.onInput?.(pane, data);
    if (pane.ptyId != null) invoke("pty_write", { id: pane.ptyId, data });
    // Multi-exec: mirror keystrokes to every other live pane of the tab (or of all tabs).
    const targets = broadcastTargets(pane);
    for (const p of targets) invoke("pty_write", { id: p.ptyId, data });
  });
  term.onResize(({ cols, rows }) => {
    if (pane.ptyId != null && !pane.exited) invoke("pty_resize", { id: pane.ptyId, cols, rows });
  });
  term.onCursorMove(() => hooks.onCursor?.(pane));
  term.onScroll(() => hooks.onCursor?.(pane));
  term.attachCustomKeyEventHandler((ev) => hooks.onKey?.(pane, ev) ?? true);

  activate(group.id, pane);
  // Size the terminal before starting the shell: a ConPTY that starts at 80×24 and misses the
  // first resize draws for the wrong screen height (output lands mid-screen).
  for (const p of group.panes) fitPane(p);
  await spawn(pane);
  return pane;
}

async function spawn(pane) {
  const { program, args = [] } = pane.spec;
  try {
    pane.ptyId = await invoke("pty_spawn", {
      program,
      args,
      cwd: null,
      cols: pane.term.cols,
      rows: pane.term.rows,
      secretKey: pane.spec.secretKey ?? null,
      jumpSecretKey: pane.spec.ssh?.jumpSecretKey ?? null,
      secretUses: pane.spec.ssh?.jump ? 2 : 1,
      env: pane.spec.env ?? null,
    });
    pane.exited = false;
    pane.line = "";
    byPty.set(pane.ptyId, pane);
    // Resizes that happened while the process was starting were dropped (no ptyId yet).
    fitPane(pane);
    invoke("pty_resize", { id: pane.ptyId, cols: pane.term.cols, rows: pane.term.rows });
  } catch (err) {
    pane.exited = true;
    pane.term.write(`\x1b[31mFailed to start ${program}: ${err}\x1b[0m\r\n\x1b[90m[Enter closes the pane, R retries]\x1b[0m\r\n`);
  }
  renderTabs();
}

function restart(pane) {
  pane.term.reset();
  setupShellIntegration(pane, pane.spec.integration ?? "none");
  spawn(pane);
}

/** Closes one pane; the tab goes away with its last pane. */
export function closeTab(paneId) {
  const pane = panes.get(paneId);
  if (!pane) return;
  if (pane.ptyId != null && !pane.exited) invoke("pty_kill", { id: pane.ptyId });
  byPty.delete(pane.ptyId);
  hooks.onClose?.(pane);
  pane.term.dispose();
  pane.el.remove();
  panes.delete(paneId);

  const group = groups.get(pane.groupId);
  const i = group.panes.indexOf(pane);
  removeFromTree(group, pane);
  group.panes = group.root ? leaves(group.root) : []; // root is null once the last pane is gone
  if (group.panes.length) {
    if (group.active === pane) group.active = group.panes[Math.max(0, i - 1)];
    layoutGroup(group);
    if (activeGroupId === group.id) activate(group.id);
    else renderTabs();
    return;
  }
  group.el.remove();
  groups.delete(group.id);
  if (activeGroupId === group.id) {
    activeGroupId = null;
    const last = [...groups.keys()].pop();
    if (last) activate(last);
    else hooks.onActivate?.(null);
  }
  renderTabs();
  document.getElementById("empty-state").classList.toggle("hidden", groups.size > 0);
}

function closeGroup(group) {
  for (const p of [...group.panes]) closeTab(p.id);
}

export function activate(groupId, pane = null) {
  const group = groups.get(groupId);
  if (!group) return;
  activeGroupId = groupId;
  if (pane) group.active = pane;
  for (const g of groups.values()) g.el.classList.toggle("active", g.id === groupId);
  document.getElementById("empty-state").classList.toggle("hidden", groups.size > 0);
  markFocused(group);
  markBroadcast();
  renderTabs();
  const p = group.active;
  requestAnimationFrame(() => {
    for (const x of group.panes) fitPane(x);
    p.term.focus();
  });
  hooks.onActivate?.(p);
}

/** Makes a pane the focused one in its tab (click / Alt+arrow). */
export function focusPane(pane, focusTerm = true) {
  const group = groups.get(pane.groupId);
  if (!group) return;
  if (group.active === pane && activeGroupId === group.id) return;
  group.active = pane;
  if (activeGroupId !== group.id) return activate(group.id, pane);
  markFocused(group);
  renderTabs();
  if (focusTerm) pane.term.focus();
  hooks.onActivate?.(pane);
}

/** Alt+Left/Right/Up/Down: move focus to the neighbouring pane. */
export function focusNeighbour(delta) {
  const group = groups.get(activeGroupId);
  if (!group || group.panes.length < 2) return false;
  const i = group.panes.indexOf(group.active);
  const next = group.panes[(i + delta + group.panes.length) % group.panes.length];
  focusPane(next);
  return true;
}

function markFocused(group) {
  for (const p of group.panes) p.el.classList.toggle("focused", p === group.active);
}

export function activeTab() {
  return groups.get(activeGroupId)?.active ?? null;
}

export function allTabs() {
  return [...panes.values()];
}

export const paneCount = (pane) => groups.get(pane?.groupId)?.panes.length ?? 0;
export const canSplit = (pane) => paneCount(pane) < MAX_PANES;

function fitPane(pane) {
  if (!pane.el.isConnected || pane.el.offsetParent === null) return;
  try {
    pane.fit.fit();
  } catch {}
  hooks.onCursor?.(pane);
}

// ------------------------------------------------------------------ split tree
// group.root is a node: { type: "pane", pane } or { type: "split", dir: "row" | "column", children }.
// Splitting in the parent's direction adds a sibling; a different direction nests a new split.

const leaves = (node) => (node.type === "pane" ? [node.pane] : node.children.flatMap(leaves));

function parentOf(node, target) {
  if (node.type !== "split") return null;
  for (const c of node.children) {
    if (c === target) return node;
    const p = parentOf(c, target);
    if (p) return p;
  }
  return null;
}

function replaceNode(group, oldNode, newNode) {
  const parent = parentOf(group.root, oldNode);
  if (!parent) group.root = newNode;
  else parent.children[parent.children.indexOf(oldNode)] = newNode;
}

function insertSplit(group, target, pane, dir) {
  const leaf = { type: "pane", pane, size: 1 };
  pane.node = leaf;
  const tnode = target.node;
  const parent = parentOf(group.root, tnode);
  if (parent && parent.dir === dir) {
    parent.children.splice(parent.children.indexOf(tnode) + 1, 0, leaf);
  } else {
    const split = { type: "split", dir, children: [tnode, leaf], size: tnode.size ?? 1 };
    tnode.size = 1;
    replaceNode(group, tnode, split);
  }
  group.panes = leaves(group.root);
}

function removeFromTree(group, pane) {
  const node = pane.node;
  const parent = parentOf(group.root, node);
  if (!parent) {
    group.root = null;
    return;
  }
  parent.children.splice(parent.children.indexOf(node), 1);
  if (parent.children.length === 1) {
    const only = parent.children[0];
    only.size = parent.size;
    replaceNode(group, parent, only);
  }
}

/** Rebuilds a tab's layout from its split tree, with draggable dividers. */
function layoutGroup(group) {
  group.el.classList.toggle("multi", group.panes.length > 1);
  group.el.replaceChildren(group.root ? buildNode(group.root) : "");
}

function buildNode(node) {
  if (node.type === "pane") {
    node.pane.el.style.flex = `${node.size ?? 1} 1 0`;
    return node.pane.el;
  }
  const el = document.createElement("div");
  el.className = `pane-split ${node.dir}`;
  el.style.flex = `${node.size ?? 1} 1 0`;
  node.children.forEach((child, i) => {
    if (i > 0) el.appendChild(divider(node, i));
    const cel = buildNode(child);
    child.el = cel;
    el.appendChild(cel);
  });
  return el;
}

function divider(split, index) {
  const d = document.createElement("div");
  d.className = "pane-divider";
  d.title = "Drag to resize";
  d.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    d.setPointerCapture(e.pointerId);
    const a = split.children[index - 1];
    const b = split.children[index];
    const horizontal = split.dir !== "column";
    const ra = a.el.getBoundingClientRect();
    const rb = b.el.getBoundingClientRect();
    const total = horizontal ? ra.width + rb.width : ra.height + rb.height;
    const start = horizontal ? ra.left : ra.top;
    const weight = (a.size ?? 1) + (b.size ?? 1);
    document.body.classList.add("resizing", horizontal ? "resizing-x" : "resizing-y");
    const move = (ev) => {
      const pos = (horizontal ? ev.clientX : ev.clientY) - start;
      const frac = Math.min(0.85, Math.max(0.15, pos / total));
      a.size = weight * frac;
      b.size = weight * (1 - frac);
      a.el.style.flex = `${a.size} 1 0`;
      b.el.style.flex = `${b.size} 1 0`;
    };
    const up = () => {
      d.removeEventListener("pointermove", move);
      document.body.classList.remove("resizing", "resizing-x", "resizing-y");
      hooks.onTabsChanged?.(); // remember the new split sizes
    };
    d.addEventListener("pointermove", move);
    d.addEventListener("pointerup", up, { once: true });
  });
  return d;
}

const SERVER_SVG = '<svg class="server-ico" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><rect x="2.5" y="2.5" width="11" height="4.5" rx="1.2"/><rect x="2.5" y="9" width="11" height="4.5" rx="1.2"/><circle cx="5" cy="4.75" r=".8" fill="currentColor" stroke="none"/><circle cx="5" cy="11.25" r=".8" fill="currentColor" stroke="none"/></svg>';

function renderTabs() {
  const root = $tabs();
  root.innerHTML = "";
  for (const g of groups.values()) {
    const p = g.active;
    const b = document.createElement("div");
    b.className = "tab" + (g.id === activeGroupId ? " active" : "") + (g.panes.every((x) => x.exited) ? " exited" : "");
    const icon = { shell: "›_", ssh: "", agent: "✦" }[p.spec.kind] ?? "›_";
    b.innerHTML = `<span class="tab-icon kind-${p.spec.kind}"></span><span class="tab-title"></span>${
      g.panes.length > 1 ? `<span class="tab-split" title="${g.panes.length} panes">⊞${g.panes.length}</span>` : ""
    }<button class="tab-close" title="Close tab">×</button>`;
    b.querySelector(".tab-title").textContent = p.spec.title;
    if (p.spec.icon || icon) b.querySelector(".tab-icon").textContent = p.spec.icon || icon;
    else b.querySelector(".tab-icon").innerHTML = SERVER_SVG;
    if (p.spec.color) b.style.setProperty("--session-color", p.spec.color), b.classList.add("colored");
    b.title = g.panes.map((x) => x.spec.title).join(" | ");
    b.addEventListener("mousedown", (e) => {
      if (e.button === 1) return closeGroup(g);
      if (!e.target.classList.contains("tab-close")) activate(g.id);
    });
    b.querySelector(".tab-close").addEventListener("click", () => closeGroup(g));
    root.appendChild(b);
  }
  hooks.onTabsChanged?.();
}

/** Last `n` lines of the pane's buffer as plain text (for AI context). */
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

/** Types text into the pane as if pasted; `run` presses Enter afterwards. */
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

// ------------------------------------------------------------------ file paths (Ctrl+click)

// C:\path\file, /abs/path, ~/x, ./rel, ../rel — optionally with :line[:col].
const PATH_RE = /(?:[A-Za-z]:\\[^\s"'<>|*?]+|(?:~|\.{1,2})?\/[\w.@%+~-]+(?:\/[\w.@%+~-]*)+|(?:~|\.{1,2})\/[\w.@%+~-]+)(?::\d+(?::\d+)?)?/g;

function registerPathLinks(pane) {
  pane.term.registerLinkProvider({
    provideLinks(y, callback) {
      const text = pane.term.buffer.active.getLine(y - 1)?.translateToString(true) ?? "";
      const links = [];
      for (const m of text.matchAll(PATH_RE)) {
        const before = text.slice(0, m.index);
        if (/[\w-]+:\/*$/.test(before) || before.endsWith("/")) continue; // part of a URL
        const value = m[0].replace(/[.,;:)\]]+$/, "");
        if (value.length < 3) continue;
        links.push({
          range: { start: { x: m.index + 1, y }, end: { x: m.index + value.length, y } },
          text: value,
          decorations: { underline: true, pointerCursor: true },
          activate: (ev, t) => (ev.ctrlKey || ev.metaKey) && hooks.onOpenPath?.(pane, t),
        });
      }
      callback(links);
    },
  });
}

// ------------------------------------------------------------------ multi-exec (broadcast)

let broadcastMode = "off"; // "off" | "tab" | "all"

/** Cycles Off → this tab's panes → all tabs → Off. Returns the new mode. */
export function cycleBroadcast() {
  broadcastMode = { off: "tab", tab: "all", all: "off" }[broadcastMode];
  markBroadcast();
  return broadcastMode;
}
export const getBroadcast = () => broadcastMode;

function broadcastTargets(pane) {
  if (broadcastMode === "off") return [];
  const pool = broadcastMode === "tab" ? groups.get(pane.groupId)?.panes ?? [] : [...panes.values()];
  return pool.filter((p) => p !== pane && !p.exited && p.ptyId != null && p.spec.kind !== "agent");
}

function markBroadcast() {
  for (const g of groups.values()) {
    const on = broadcastMode === "all" || (broadcastMode === "tab" && g.id === activeGroupId);
    g.el.classList.toggle("broadcast", on && (broadcastMode === "all" ? panes.size > 1 : g.panes.length > 1));
  }
}

// ------------------------------------------------------------------ jump between commands

/** Ctrl+Shift+↑/↓: scroll to the previous / next command block. */
export function jumpBlock(pane, dir) {
  const blocks = pane?.si?.blocks ?? [];
  if (!blocks.length) return false;
  const top = pane.term.buffer.active.viewportY;
  const starts = blocks.map((b) => (b.promptMarker ?? b.outMarker).line).filter((l) => l >= 0);
  const target = dir < 0 ? starts.filter((l) => l < top).pop() : starts.find((l) => l > top);
  if (target == null) return dir > 0 ? (pane.term.scrollToBottom(), true) : false;
  pane.term.scrollToLine(target);
  return true;
}

// ------------------------------------------------------------------ workspace save / restore

/** Layout of every tab: split trees whose leaves are described by `describe(pane)` (or skipped). */
export function serializeWorkspace(describe) {
  const node = (n) => {
    if (n.type === "pane") {
      const d = describe(n.pane);
      return d ? { type: "pane", size: n.size ?? 1, pane: d } : null;
    }
    const children = n.children.map(node).filter(Boolean);
    if (!children.length) return null;
    return children.length === 1 ? { ...children[0], size: n.size ?? 1 } : { type: "split", dir: n.dir, size: n.size ?? 1, children };
  };
  const tabs = [];
  let active = 0;
  for (const g of groups.values()) {
    const t = g.root && node(g.root);
    if (!t) continue;
    if (g.id === activeGroupId) active = tabs.length;
    tabs.push(t);
  }
  return { tabs, active };
}

/** Recreates one tab from a saved tree whose leaves already carry their spec. */
export async function openTabTree(tree) {
  const specs = [];
  const collect = (n) => (n.type === "pane" ? specs.push(n.spec) : n.children.forEach(collect));
  collect(tree);
  if (!specs.length) return;
  const first = await openTab(specs[0]);
  const all = [first];
  for (const s of specs.slice(1, MAX_PANES)) all.push(await openTab(s, { splitOf: first, dir: "row" }));
  const group = groups.get(first.groupId);
  let i = 0;
  const build = (n) => {
    if (n.type === "pane") {
      const p = all[i++];
      if (!p) return null;
      p.node.size = n.size ?? 1;
      return p.node;
    }
    const children = n.children.map(build).filter(Boolean);
    if (children.length === 1) return Object.assign(children[0], { size: n.size ?? 1 });
    return { type: "split", dir: n.dir, size: n.size ?? 1, children };
  };
  group.root = build(tree);
  group.panes = leaves(group.root);
  layoutGroup(group);
  for (const p of group.panes) fitPane(p);
}

export function activateIndex(i) {
  const g = [...groups.values()][i];
  if (g) activate(g.id);
}
