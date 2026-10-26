import "./styles.css";
import { invoke } from "@tauri-apps/api/core";
import {
  initTerminals, openTab, closeTab, activeTab, allTabs, setFontSize, getFontSize, canSplit, focusNeighbour,
  setAppearance, cycleBroadcast, getBroadcast, jumpBlock, serializeWorkspace, openTabTree, activateIndex,
} from "./terminal.js";
import {
  setSettings, loadHistory, trackInput, onSent, positionGhost, hideSuggestion, acceptSuggestion,
  requestAiCompletion, initCommandBar, openCommandBar, initChat, sendChat, renderMarkdown,
  onTermOutput, onCommandDone, onCommandStart, onBlockMenu, setAiHooks, onPaneActivated,
} from "./ai.js";
import { powershellIntegrationArgs, bashIntegrationEnv } from "./shell.js";
import { updateCompletion, completionKey, positionCompletion, closeCompletion } from "./completion.js";
import { initFiles, toggleFiles, showFilesFor, filesOnClose, openRemotePath } from "./files.js";
import { initLayout } from "./layout.js";
import { openShortcuts } from "./shortcuts.js";
import { initFind, openFind } from "./find.js";
import { THEMES, FONTS } from "./themes.js";
import { initSnippets, openSnippetEditor, focusSnippets } from "./snippets.js";
import { initUpdater, checkForUpdate, getPending } from "./updater.js";
import { initMonitor, setMonitorTab } from "./monitor.js";
import { initEditor, toggleEditor, openInEditor } from "./editor.js";

initLayout(); // before boot(): it doesn't need the backend

let settings = {};
let shells = [];
let sessions = [];
const agents = [
  { name: "Claude Code", bin: "claude", settingsKey: "claude_cli_path", install: "npm install -g @anthropic-ai/claude-code" },
  { name: "Codex", bin: "codex", settingsKey: "codex_cli_path", install: "npm install -g @openai/codex" },
];

const $ = (id) => document.getElementById(id);
const PROVIDER_LABEL = { anthropic: "Claude API", openai: "OpenAI API", "claude-cli": "Claude Code CLI", "codex-cli": "Codex CLI" };

// ------------------------------------------------------------------ keyboard

function onKey(tab, ev) {
  if (ev.type !== "keydown") return true;
  const key = ev.key.toLowerCase();
  const plain = !ev.ctrlKey && !ev.altKey && !ev.shiftKey && !ev.metaKey;

  if (completionKey(tab, ev)) return ev.preventDefault(), false;
  if (ev.ctrlKey && !ev.shiftKey && key === "k") return openCommandBar(), false;
  if (ev.ctrlKey && ev.code === "Space") return requestAiCompletion(tab, true), false;
  if (ev.ctrlKey && !ev.shiftKey && !ev.altKey && key === "f") return openFind(), false;
  if (ev.ctrlKey && (ev.key === "/" || ev.code === "Slash")) return openShortcuts(), false;
  if (ev.ctrlKey && !ev.shiftKey && (ev.key === "=" || ev.key === "+")) return zoom(1), false;
  if (ev.ctrlKey && !ev.shiftKey && ev.key === "-") return zoom(-1), false;
  if (ev.ctrlKey && ev.shiftKey && (ev.key === "ArrowUp" || ev.key === "ArrowDown")) {
    jumpBlock(tab, ev.key === "ArrowUp" ? -1 : 1);
    return false;
  }
  if (ev.ctrlKey && ev.shiftKey) {
    if (key === "b") return toggleBroadcast(), false;
    if (key === "s") return focusSnippets(), false;
    if (key === "a") return toggleAiPanel(), false;
    if (key === "m") return toggleChatFull(), false;
    if (key === "o") return toggleEditor(), false;
    if (key === "l") return toggleSidebar(), false;
    if (key === "t") return newDefaultTab(), false;
    if (key === "f") return toggleFiles(), false;
    if (key === "w") return closeTab(tab.id), false;
    if (key === "d") return splitActive("row"), false;
    if (key === "e") return splitActive("column"), false;
    if (key === "c") {
      const sel = tab.term.getSelection();
      if (sel) navigator.clipboard.writeText(sel);
      return false;
    }
    if (key === "v") {
      navigator.clipboard.readText().then((t) => t && tab.term.paste(t));
      ev.preventDefault();
      return false;
    }
  }
  if (ev.altKey && !ev.ctrlKey && !ev.shiftKey && ev.key.startsWith("Arrow")) {
    const delta = ev.key === "ArrowLeft" || ev.key === "ArrowUp" ? -1 : 1;
    if (focusNeighbour(delta)) return false;
  }
  if (tab.suggestion && plain && (ev.key === "ArrowRight" || ev.key === "End")) {
    acceptSuggestion(tab);
    return false;
  }
  if (tab.suggestion && plain && ev.key === "Escape") {
    hideSuggestion(tab);
    return false;
  }
  return true;
}

document.addEventListener("keydown", (ev) => {
  // Global shortcuts when focus is outside a terminal.
  if (ev.target.closest?.(".xterm")) return;
  const key = ev.key.toLowerCase();
  if (ev.ctrlKey && ev.shiftKey && key === "a") (ev.preventDefault(), toggleAiPanel());
  else if (ev.ctrlKey && ev.shiftKey && key === "m") (ev.preventDefault(), toggleChatFull());
  else if (ev.ctrlKey && ev.shiftKey && key === "o") (ev.preventDefault(), toggleEditor());
  else if (ev.ctrlKey && ev.shiftKey && key === "l") (ev.preventDefault(), toggleSidebar());
  else if (ev.ctrlKey && ev.shiftKey && key === "t") (ev.preventDefault(), newDefaultTab());
  else if (ev.ctrlKey && ev.shiftKey && key === "f") (ev.preventDefault(), toggleFiles());
  else if (ev.ctrlKey && !ev.shiftKey && key === "k" && activeTab()) (ev.preventDefault(), openCommandBar());
  else if (ev.ctrlKey && (ev.key === "/" || ev.code === "Slash")) (ev.preventDefault(), openShortcuts());
  else if (ev.ctrlKey && ev.shiftKey && key === "s") (ev.preventDefault(), focusSnippets());
});

function zoom(delta) {
  const size = Math.max(9, Math.min(28, getFontSize() + delta));
  saveSettings({ ...settings, font_size: size });
}

function toggleBroadcast() {
  const mode = cycleBroadcast();
  const btn = $("broadcast-btn");
  btn.classList.toggle("on", mode !== "off");
  btn.dataset.mode = mode;
  btn.title = { off: "Broadcast typing to all panes in this tab (Ctrl+Shift+B)", tab: "Broadcasting to all panes in this tab · click: all tabs", all: "Broadcasting to ALL tabs · click: turn off" }[mode];
  setStatus({ off: "Broadcast off", tab: "📡 Typing goes to every pane in this tab", all: "📡 Typing goes to every open terminal" }[mode]);
}

/** Appearance from settings → every terminal. */
function applyAppearance() {
  setAppearance({
    theme: THEMES[settings.terminal_theme] ?? THEMES.moxie,
    fontFamily: settings.font_family ? `${settings.font_family}, "Cascadia Mono", Consolas, monospace` : `"Cascadia Mono", "Cascadia Code", Consolas, "JetBrains Mono", monospace`,
    lineHeight: Number(settings.line_height) || 1,
    cursorStyle: settings.cursor_style || "block",
  });
}

/** Ctrl+click on a URL in the terminal. */
function openLink(uri) {
  invoke("open_url", { url: uri }).catch((e) => setStatus(String(e)));
}

/** Ctrl+click on a path: local files open (folders in Explorer); remote ones go to the SFTP panel. */
async function openPath(pane, raw) {
  const path = raw.replace(/:\d+(:\d+)?$/, ""); // drop :line:col
  const cwd = pane.si?.cwd;
  if (pane.spec.kind === "ssh") {
    const f = pane.files;
    if (f?.status !== "ready") return setStatus("Open the Files panel to browse the server (Ctrl+Shift+F).");
    const abs = path.startsWith("/") ? path : path.startsWith("~") ? f.home + path.slice(1) : `${cwd ?? f.cwd}/${path.replace(/^\.\//, "")}`;
    toggleFiles(true);
    return openRemotePath(pane, abs);
  }
  let local = path;
  if (/^\/[a-zA-Z]\//.test(local)) local = `${local[1]}:${local.slice(2)}`; // Git Bash /c/…
  else if (!/^[A-Za-z]:/.test(local) && cwd && !cwd.startsWith("/")) local = `${cwd}\\${local.replace(/^\.[\\/]/, "")}`;
  local = local.replace(/\//g, "\\");
  // Text files open in the editor; folders and everything else in Explorer.
  const r = await openInEditor(null, local).catch(() => null);
  if (!r?.ok) invoke("reveal_local", { path: local }).catch((e) => setStatus(String(e)));
}

// ------------------------------------------------------------------ sidebar

function renderShells() {
  const ul = $("shell-list");
  ul.innerHTML = "";
  for (const s of shells) {
    const li = item(s.name, "›_", () => openTab(shellSpec(s)));
    ul.appendChild(li);
  }
}

const SESSION_ICON = { ssh: "⇄", bastion: "☁", rdp: "🖥", vnc: "🖵" };
// Per-session look: colour (icon, stripe and tab accent), icon, and tags.
const SESSION_COLORS = ["#f7768e", "#ff9e64", "#e0af68", "#9ece6a", "#2ac3de", "#7aa2f7", "#bb9af7", "#ff79c6", "#737aa2"];
const ICON_PICKS = ["🖥", "🗄", "🌐", "☁", "🐳", "🔒", "🚀", "🧪", "⚙", "📦", "🔥", "⭐"];
const parseTags = (text) => [...new Set(String(text ?? "").split(/[,\n]/).map((t) => t.trim().replace(/^#/, "")).filter(Boolean))];

/** The colour + icon pickers in the session dialog. */
function renderLookPickers(s) {
  const form = $("ssh-form");
  const setColor = (c) => {
    form.elements.color.value = c;
    for (const b of $("ssh-colors").children) b.classList.toggle("on", (b.dataset.color ?? "") === c);
    const custom = $("ssh-colors").querySelector("input[type=color]");
    custom.parentElement.classList.toggle("on", !!c && !SESSION_COLORS.includes(c));
  };
  $("ssh-colors").innerHTML =
    `<button type="button" class="swatch none" data-color="" title="No colour">∅</button>` +
    SESSION_COLORS.map((c) => `<button type="button" class="swatch" data-color="${c}" style="background:${c}" title="${c}"></button>`).join("") +
    `<label class="swatch custom" title="Custom colour">+<input type="color" /></label>`;
  $("ssh-colors").onclick = (e) => {
    const b = e.target.closest("button[data-color]");
    if (b) setColor(b.dataset.color);
  };
  $("ssh-colors").querySelector("input[type=color]").oninput = (e) => setColor(e.target.value);
  setColor(s.color ?? "");

  const icons = $("ssh-icons");
  icons.innerHTML =
    `<button type="button" class="icon-pick" data-icon="" title="Default for the connection type">${SESSION_ICON[s.type ?? "ssh"]}</button>` +
    ICON_PICKS.map((i) => `<button type="button" class="icon-pick" data-icon="${i}">${i}</button>`).join("") +
    `<input name="icon" maxlength="4" placeholder="or type" title="Any emoji or 1–2 characters" />`;
  const setIcon = (v) => {
    form.elements.icon.value = v;
    for (const b of icons.querySelectorAll(".icon-pick")) b.classList.toggle("on", b.dataset.icon === v);
  };
  icons.onclick = (e) => {
    const b = e.target.closest(".icon-pick");
    if (b) setIcon(b.dataset.icon);
  };
  form.elements.icon.oninput = (e) => setIcon(e.target.value.trim());
  setIcon(s.icon ?? "");

  form.elements.tags.value = (s.tags ?? []).join(", ");
  const preview = () => renderTagChips($("ssh-tag-preview"), parseTags(form.elements.tags.value));
  form.elements.tags.oninput = preview;
  preview();
}

function renderTagChips(box, tags, max = Infinity) {
  box.innerHTML = "";
  for (const t of tags.slice(0, max)) {
    const c = document.createElement("span");
    c.className = "tag-chip";
    c.textContent = t;
    box.append(c);
  }
  if (tags.length > max) {
    const more = document.createElement("span");
    more.className = "tag-chip more";
    more.textContent = `+${tags.length - max}`;
    more.title = tags.slice(max).join(", ");
    box.append(more);
  }
}
const DEFAULT_PORT = { ssh: 22, bastion: 22, rdp: 3389, vnc: 5900 };

/** Sidebar sessions, grouped by folder (folders collapse; state remembered per viewer). */
function renderSessions() {
  const ul = $("ssh-list");
  const q = $("session-filter").value.toLowerCase();
  ul.innerHTML = "";
  // "#tag" words must match a tag exactly; other words match anywhere (name, host, user, folder, tags).
  const words = q.split(/\s+/).filter(Boolean);
  const list = sessions.filter((s) => {
    const tags = (s.tags ?? []).map((t) => t.toLowerCase());
    const hay = `${s.name} ${s.host} ${s.user} ${s.vm ?? ""} ${s.folder ?? ""} ${tags.join(" ")}`.toLowerCase();
    return words.every((w) => (w.startsWith("#") && w.length > 1 ? tags.includes(w.slice(1)) : hay.includes(w)));
  });
  if (!list.length) {
    ul.innerHTML = `<li class="muted small">${sessions.length ? "No matches" : "No saved sessions yet · ⇩ to import"}</li>`;
    return;
  }
  let collapsed = {};
  try {
    collapsed = JSON.parse(localStorage.getItem("moxie.folders") ?? "{}");
  } catch {}
  const folders = new Map();
  for (const s of list) {
    const f = s.folder?.trim() || "";
    if (!folders.has(f)) folders.set(f, []);
    folders.get(f).push(s);
  }
  const names = [...folders.keys()].sort((a, b) => (a === "") - (b === "") || a.localeCompare(b));
  for (const name of names) {
    const items = folders.get(name).sort((a, b) => sessionTitle(a).localeCompare(sessionTitle(b)));
    const nested = name !== "";
    if (nested) {
      const head = document.createElement("li");
      head.className = "folder-row" + (collapsed[name] && !q ? " collapsed" : "");
      head.innerHTML = `<span class="item-icon">▾</span><span class="item-label"></span><span class="folder-count">${items.length}</span>`;
      head.querySelector(".item-label").textContent = name;
      head.addEventListener("click", () => {
        collapsed[name] = !collapsed[name];
        try {
          localStorage.setItem("moxie.folders", JSON.stringify(collapsed));
        } catch {}
        renderSessions();
      });
      ul.appendChild(head);
      if (collapsed[name] && !q) continue;
    }
    for (const s of items) {
      const li = sessionItem(s);
      if (nested) li.classList.add("in-folder");
      ul.appendChild(li);
    }
  }
  $("folder-list").innerHTML = [...new Set(sessions.map((s) => s.folder).filter(Boolean))]
    .map((f) => `<option value="${f.replace(/"/g, "&quot;")}">`)
    .join("");
}

function sessionItem(s) {
  const type = s.type ?? "ssh";
  const li = item(sessionTitle(s), s.icon || SESSION_ICON[type] || "⇄", () => connectSession(s));
  if (s.color) li.style.setProperty("--session-color", s.color), li.classList.add("colored");
  if (s.tags?.length) {
    const chips = document.createElement("span");
    chips.className = "tag-chips";
    renderTagChips(chips, s.tags, 2);
    li.querySelector(".item-label").after(chips);
  }
  li.title =
    type === "bastion"
      ? `${s.user ? s.user + "@" : ""}${vmName(s.vm)} via Azure Bastion ${s.bastion}`
      : `${{ rdp: "RDP ", vnc: "VNC " }[type] ?? ""}${s.user ? s.user + "@" : ""}${s.host}:${s.port || DEFAULT_PORT[type]}${s.jump ? " via " + s.jump : ""}`;
  const actions = document.createElement("span");
  actions.className = "item-actions";
  actions.innerHTML = `${s.forwards?.trim() ? '<button title="Start port forwards only (no shell)">🔌</button>' : ""}<button title="Edit">✎</button><button title="Delete">×</button>`;
  const buttons = [...actions.querySelectorAll("button")];
  if (s.forwards?.trim()) buttons.shift().addEventListener("click", (e) => (e.stopPropagation(), connectSession(s, { tunnelsOnly: true })));
  const [edit, del] = buttons;
  edit.addEventListener("click", (e) => (e.stopPropagation(), openSshDialog(s)));
  del.addEventListener("click", async (e) => {
    e.stopPropagation();
    if (!confirm(`Delete session "${sessionTitle(s)}"?`)) return;
    sessions = sessions.filter((x) => x.id !== s.id);
    await invoke("save_sessions", { sessions });
    invoke("secret_delete", { key: secretKeyFor(s) });
    renderSessions();
  });
  li.appendChild(actions);
  return li;
}

async function renderAgents() {
  const ul = $("agent-list");
  ul.innerHTML = "";
  for (const a of agents) {
    const custom = settings[a.settingsKey];
    const path = custom || (await invoke("find_program", { name: a.bin }));
    const li = item(a.name, "✦", () => {
      if (!path) {
        setStatus(`${a.name} not found. Install with: ${a.install}`);
        return;
      }
      openTab({ title: a.name, program: custom || a.bin, args: [], kind: "agent" });
    });
    if (!path) {
      li.classList.add("disabled");
      li.title = `Not installed — ${a.install}`;
    } else {
      li.title = path;
    }
    ul.appendChild(li);
  }
}

function item(label, icon, onClick) {
  const li = document.createElement("li");
  li.innerHTML = `<span class="item-icon"></span><span class="item-label"></span>`;
  li.querySelector(".item-icon").textContent = icon;
  li.querySelector(".item-label").textContent = label;
  li.addEventListener("click", onClick);
  return li;
}

/** opts: { splitOf, dir } to open in a split pane; { tunnelsOnly } for port forwards without a shell. */
function connectSession(s, opts = {}) {
  if (s.type === "bastion") connectBastion(s, opts);
  else if (s.type === "rdp") launchDesktop("launch_rdp", { name: sessionTitle(s), host: s.host, port: Number(s.port) || 3389, user: s.user ?? "" });
  else if (s.type === "vnc") launchDesktop("launch_vnc", { host: s.host, port: Number(s.port) || 5900 });
  else connectSsh(s, opts);
}

async function launchDesktop(cmd, args) {
  try {
    await invoke(cmd, args);
    setStatus(`Opening ${cmd === "launch_rdp" ? "Remote Desktop" : "VNC viewer"} for ${args.host}…`);
  } catch (err) {
    alert(String(err));
  }
}

// ------------------------------------------------------------------ session import

let importRows = [];

function openImport() {
  importRows = [];
  $("import-list").innerHTML = '<p class="hint">Choose where to import from. Nothing is added until you click Import.</p>';
  $("import-go").disabled = true;
  $("import-dialog").showModal();
}

async function loadImport(src) {
  let source = src;
  let path = null;
  if (src === "mobaxterm-file") {
    const { open } = await import("@tauri-apps/plugin-dialog");
    path = await open({ title: "MobaXterm.ini or exported .mxtsessions", filters: [{ name: "MobaXterm", extensions: ["ini", "mxtsessions"] }] });
    if (!path) return;
    source = "mobaxterm";
  }
  $("import-list").innerHTML = '<p class="hint">Reading…</p>';
  try {
    const found = await invoke("import_sessions", { source, path });
    const key = (s) => `${s.type}|${s.user}@${s.host}:${s.port}`;
    const existing = new Set(
      sessions.map((s) => key({ type: s.type ?? "ssh", user: s.user ?? "", host: s.host, port: Number(s.port) || DEFAULT_PORT[s.type ?? "ssh"] })),
    );
    importRows = found.map((s) => ({ ...s, dup: existing.has(key(s)) }));
  } catch (err) {
    $("import-list").innerHTML = `<p class="hint error">${String(err).replace(/</g, "&lt;")}</p>`;
    return;
  }
  if (!importRows.length) {
    $("import-list").innerHTML = '<p class="hint">No sessions found there.</p>';
    return;
  }
  $("import-list").innerHTML = importRows
    .map(
      (s, i) => `<label class="import-row${s.dup ? " dup" : ""}"><input type="checkbox" data-i="${i}" ${s.dup ? "" : "checked"} />
        <span class="ir-icon">${SESSION_ICON[s.type]}</span><span class="ir-name"></span><span class="ir-target"></span><span class="ir-folder"></span>
        ${s.dup ? '<span class="ir-note">already saved</span>' : s.note ? '<span class="ir-note warn"></span>' : ""}</label>`,
    )
    .join("");
  [...$("import-list").querySelectorAll(".import-row")].forEach((row, i) => {
    const s = importRows[i];
    row.querySelector(".ir-name").textContent = s.name;
    row.querySelector(".ir-target").textContent = `${s.user ? s.user + "@" : ""}${s.host}:${s.port}${s.jump ? " via " + s.jump : ""}`;
    row.querySelector(".ir-folder").textContent = s.folder;
    const note = row.querySelector(".ir-note.warn");
    if (note) {
      note.textContent = "⚠ key not imported";
      note.title = s.note;
    }
  });
  $("import-go").disabled = false;
}

$("import-sessions").addEventListener("click", openImport);
document.querySelectorAll("#import-dialog [data-src]").forEach((b) => b.addEventListener("click", () => loadImport(b.dataset.src)));
$("import-all").addEventListener("change", (e) =>
  $("import-list").querySelectorAll("input[data-i]").forEach((c) => (c.checked = e.target.checked)),
);
$("import-dialog").addEventListener("close", async () => {
  if ($("import-dialog").returnValue !== "import") return;
  const picked = [...$("import-list").querySelectorAll("input[data-i]:checked")].map((c) => importRows[Number(c.dataset.i)]);
  for (const s of picked) {
    sessions.push({
      id: crypto.randomUUID(), type: s.type, name: s.name, host: s.host, port: s.port, user: s.user,
      key: s.key, jump: s.jump, folder: s.folder, extra: "", forwards: "", integrate: true,
    });
  }
  await invoke("save_sessions", { sessions });
  renderSessions();
  setStatus(`Imported ${picked.length} session${picked.length === 1 ? "" : "s"}`);
});

function connectSsh(s, opts = {}) {
  const problem = hostProblem(s.host);
  if (problem) {
    setStatus(problem);
    if (sessions.some((x) => x.id === s.id)) openSshDialog(s); // let them fix the saved host
    return;
  }
  openSshTab(s, { host: s.host, port: s.port, ...opts });
}

/** Opens `az network bastion tunnel` to the VM, then SSH/SFTP over 127.0.0.1:<port>. */
async function connectBastion(s, opts = {}) {
  const tunnelKey = `bastion:${s.id}`;
  setStatus(`Opening Azure Bastion tunnel to ${vmName(s.vm)}…`);
  let port;
  try {
    port = await invoke("bastion_tunnel_start", {
      key: tunnelKey,
      name: s.bastion,
      resourceGroup: s.rg,
      targetId: s.vm,
      subscription: s.sub || null,
    });
  } catch (err) {
    const msg = String(err);
    setStatus("Azure Bastion tunnel failed");
    alert(
      msg === "AZ_NOT_FOUND"
        ? "Azure Bastion needs the Azure CLI, which wasn't found.\n\n1. Install it: https://aka.ms/installazurecliwindows\n2. Run: az login\n3. Run: az extension add -n bastion\n\nOr set its path in Settings → CLI agents → az path."
        : msg,
    );
    return;
  }
  setStatus(`Bastion tunnel ready on 127.0.0.1:${port}`);
  // The local port changes every time, so key the host's identity on the VM, not on 127.0.0.1:<port>.
  openSshTab(s, { host: "127.0.0.1", port, hostKeyAlias: `${vmName(s.vm)}.bastion`, tunnelKey, ...opts });
}

function openSshTab(s, { splitOf = null, dir, ...target }) {
  openTab(sshSpec(s, target), { splitOf, dir });
  if (!target.tunnelsOnly) toggleFiles(true); // MobaXterm opens the SFTP browser alongside every SSH session
}

/** The terminal spec for an SSH session (also used to restore the workspace). */
function sshSpec(s, { host, port, hostKeyAlias = null, tunnelKey = null, tunnelsOnly = false }) {
  const args = [];
  if (port && String(port) !== "22") args.push("-p", String(port));
  if (hostKeyAlias) args.push("-o", `HostKeyAlias=${hostKeyAlias}`);
  if (s.key) args.push("-i", s.key);
  if (s.jump) args.push("-J", s.jump);
  const fwd = parseForwards(s.forwards);
  args.push(...fwd.args);
  if (tunnelsOnly) args.push("-N");
  if (s.extra) args.push(...s.extra.split(/\s+/).filter(Boolean));
  args.push(s.user ? `${s.user}@${host}` : host);
  const secretKey = secretKeyFor(s);
  return {
    title: tunnelsOnly ? `🔌 ${sessionTitle(s)}` : sessionTitle(s),
    program: "ssh",
    args,
    kind: "ssh",
    sessionId: s.id,
    color: s.color || "",
    icon: s.icon || "",
    tunnelsOnly,
    secretKey,
    tunnelKey,
    forwards: fwd.labels,
    // Silently add shell integration on the server's bash/zsh prompt (unless turned off).
    integration: tunnelsOnly || s.integrate === false ? "none" : "inject",
    ssh: { host, port, user: s.user, key: s.key, jump: s.jump || null, secretKey, hostKeyAlias, label: hostKeyAlias ?? host },
  };
}

// ------------------------------------------------------------------ workspace restore

let restoring = true;
let saveTimer;

/** How to reopen a pane next time (null: don't restore it). */
function describePane(pane) {
  const s = pane.spec;
  if (s.kind === "shell") return { kind: "shell", shellName: s.shellName };
  if (s.kind === "ssh" && s.sessionId) return { kind: "session", sessionId: s.sessionId, tunnelsOnly: !!s.tunnelsOnly };
  if (s.kind === "agent") return { kind: "agent", title: s.title, program: s.program };
  return null;
}

function saveWorkspaceSoon() {
  if (restoring) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => invoke("workspace_save", { workspace: serializeWorkspace(describePane) }).catch(() => {}), 600);
}

async function specFor(d) {
  if (d.kind === "shell") {
    const sh = shells.find((x) => x.name === d.shellName);
    return sh ? shellSpec(sh) : null;
  }
  if (d.kind === "agent") return { title: d.title, program: d.program, args: [], kind: "agent" };
  const s = sessions.find((x) => x.id === d.sessionId);
  if (!s) return null;
  if (s.type !== "bastion") return sshSpec(s, { host: s.host, port: s.port, tunnelsOnly: d.tunnelsOnly });
  const tunnelKey = `bastion:${s.id}`;
  try {
    const port = await invoke("bastion_tunnel_start", { key: tunnelKey, name: s.bastion, resourceGroup: s.rg, targetId: s.vm, subscription: s.sub || null });
    return sshSpec(s, { host: "127.0.0.1", port, hostKeyAlias: `${vmName(s.vm)}.bastion`, tunnelKey, tunnelsOnly: d.tunnelsOnly });
  } catch {
    return null;
  }
}

/** Reopens last session's tabs, splits and connections. Returns how many tabs came back. */
async function restoreWorkspace() {
  const ws = settings.restore_workspace === false ? null : await invoke("workspace_get").catch(() => null);
  let restored = 0;
  for (const tree of ws?.tabs ?? []) {
    const withSpecs = async (n) => {
      if (n.type === "pane") {
        const spec = await specFor(n.pane);
        return spec ? { ...n, spec } : null;
      }
      const children = (await Promise.all(n.children.map(withSpecs))).filter(Boolean);
      return children.length ? { ...n, children } : null;
    };
    const t = await withSpecs(tree);
    if (!t) continue;
    await openTabTree(t);
    restored++;
  }
  if (restored) activateIndex(Math.min(ws.active ?? 0, restored - 1));
  if (allTabs().some((p) => p.spec.kind === "ssh" && !p.spec.tunnelsOnly)) toggleFiles(true);
  return restored;
}

/**
 * Port forwards, one per line:  L [bind:]localPort:host:remotePort   (local → through the server)
 *                                R [bind:]remotePort:host:localPort  (server → back to you)
 *                                D [bind:]port                       (SOCKS proxy)
 */
function parseForwards(text = "") {
  const args = [];
  const labels = [];
  let error = null;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = line.match(/^([LRD])\s+(\S+)$/i);
    const kind = m?.[1].toUpperCase();
    const spec = m?.[2];
    const ok =
      kind === "D" ? /^([\w.-]+:)?\d{1,5}$/.test(spec) : !!kind && /^([\w.-]+:)?\d{1,5}:[\w.\-[\]]+:\d{1,5}$/.test(spec);
    if (!ok) {
      error ??= `Bad forward "${line}". Use e.g. "L 5432:localhost:5432", "R 8080:localhost:3000" or "D 1080".`;
      continue;
    }
    args.push(`-${kind}`, spec);
    const parts = spec.split(":");
    labels.push(
      kind === "D" ? `SOCKS :${parts.pop()}` : kind === "L" ? `:${parts.at(-3)} → ${parts.at(-2)}:${parts.at(-1)}` : `remote :${parts.at(-3)} → ${parts.at(-2)}:${parts.at(-1)}`,
    );
  }
  return { args, labels, error };
}

/** Ctrl+Shift+D / Ctrl+Shift+E: open the same shell or session next to the focused pane. */
function splitActive(dir) {
  const pane = activeTab();
  if (!pane) return newDefaultTab();
  if (!canSplit(pane)) return setStatus("A tab holds up to 4 panes.");
  const session = pane.spec.sessionId && sessions.find((x) => x.id === pane.spec.sessionId);
  if (session && !pane.spec.title.startsWith("🔌")) connectSession(session, { splitOf: pane, dir });
  else openTab({ ...pane.spec }, { splitOf: pane, dir });
}

/** Spec for a local shell, with shell integration where the shell supports it. */
function shellSpec(s) {
  // PowerShell: script via -EncodedCommand. bash: hook via environment. zsh/others: typed at the prompt.
  const integration = s.kind === "powershell" || s.kind === "bash" ? "native" : s.kind === "zsh" ? "inject" : "none";
  const args = s.kind === "powershell" ? [...s.args, ...powershellIntegrationArgs()] : s.args;
  const env = s.kind === "bash" ? bashIntegrationEnv(/wsl/i.test(s.program)) : null;
  return { title: s.name, program: s.program, args, env, kind: "shell", shellName: s.name, integration };
}

const secretKeyFor = (s) => `ssh:${s.id}`;
const vmName = (id = "") => id.replace(/\/+$/, "").split("/").pop() || "vm";
const sessionTitle = (s) => s.name || (s.type === "bastion" ? vmName(s.vm) : s.host);

/** Asks for an SSH password (used when SFTP login needs one). Resolves true if one was given. */
function promptPassword(ssh, reason) {
  const dlg = $("password-dialog");
  const form = $("password-form");
  form.reset();
  $("password-title").textContent = `Password for ${ssh.user ? ssh.user + "@" : ""}${ssh.label ?? ssh.host}`;
  $("password-hint").textContent = reason;
  dlg.showModal();
  return new Promise((resolve) => {
    dlg.addEventListener(
      "close",
      async () => {
        const pw = form.elements.password.value;
        if (dlg.returnValue !== "ok" || !pw) return resolve(false);
        await invoke("secret_set", { key: ssh.secretKey, value: pw, persist: form.elements.remember.checked });
        resolve(true);
      },
      { once: true },
    );
  });
}

function newDefaultTab() {
  const s = shells[0];
  return s ? openTab(shellSpec(s)) : null;
}

// ------------------------------------------------------------------ dialogs

/** Explains why a value can't be an SSH host (e.g. a pasted web URL), or "" if it looks fine. */
function hostProblem(value) {
  const v = value.trim();
  if (/bastion\.azure\.com/i.test(v)) {
    return "This is an Azure Bastion web link, not an SSH host. Bastion links only open in the browser. Use the VM's IP/DNS name (if reachable), or tunnel through Bastion with the Azure CLI (az network bastion tunnel).";
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(v) || v.includes("/")) {
    return "Enter just the host name or IP address (e.g. example.com or 10.0.0.5), not a URL.";
  }
  if (/\s/.test(v)) return "The host can't contain spaces.";
  return "";
}

const VM_ID = /^\/subscriptions\/[^/]+\/resourceGroups\/[^/]+\/providers\/[^/]+\/[^/]+\/[^/]+$/i;

/** Shows the fields for the chosen connection type and sets their validity messages. */
function validateSshForm() {
  const f = $("ssh-form").elements;
  const bastion = f.type.value === "bastion";
  for (const el of document.querySelectorAll("#ssh-form [data-for]")) el.hidden = !el.dataset.for.split(" ").includes(f.type.value);
  // Switching type: move the port to that type's default unless the user changed it.
  const prev = f.type.dataset.prev ?? "ssh";
  if (prev !== f.type.value && Number(f.port.value) === DEFAULT_PORT[prev]) f.port.value = DEFAULT_PORT[f.type.value];
  f.type.dataset.prev = f.type.value;
  f.host.required = !bastion;
  f.host.setCustomValidity("");
  f.host.setCustomValidity(bastion ? "" : hostProblem(f.host.value));
  for (const k of ["bastion", "rg", "vm"]) f[k].required = bastion;
  const vm = f.vm.value.trim();
  f.vm.setCustomValidity(
    bastion && vm && !VM_ID.test(vm)
      ? "Paste the VM's full resource ID: /subscriptions/<id>/resourceGroups/<rg>/providers/Microsoft.Compute/virtualMachines/<vm>"
      : "",
  );
  f.forwards.setCustomValidity(parseForwards(f.forwards.value).error ?? "");
}
$("ssh-form").addEventListener("input", validateSshForm);

function openSshDialog(session = null) {
  const dlg = $("ssh-dialog");
  const form = $("ssh-form");
  form.reset();
  const s = session ?? { port: 22 };
  for (const k of ["id", "name", "host", "port", "user", "key", "extra", "bastion", "rg", "vm", "sub", "forwards", "folder", "jump"]) form.elements[k].value = s[k] ?? "";
  form.elements.integrate.checked = s.integrate !== false;
  form.elements.type.value = s.type ?? "ssh";
  form.elements.type.dataset.prev = form.elements.type.value;
  renderLookPickers(s);
  if (!s.port) form.elements.port.value = 22;
  validateSshForm();
  form.elements.password.placeholder = "optional";
  if (session) {
    invoke("secret_exists", { key: secretKeyFor(session) }).then((saved) => {
      if (saved) form.elements.password.placeholder = "•••••••• saved — leave blank to keep";
    });
  }
  dlg.showModal();
}

$("ssh-dialog").addEventListener("close", async () => {
  const dlg = $("ssh-dialog");
  if (dlg.returnValue !== "save" && dlg.returnValue !== "connect") return;
  const f = $("ssh-form").elements;
  const type = f.type.value;
  if (type === "bastion" ? !f.vm.value.trim() : !f.host.value.trim()) return;
  const s = {
    id: f.id.value || crypto.randomUUID(),
    type,
    name: f.name.value.trim(),
    host: type === "bastion" ? "" : f.host.value.trim(),
    port: Number(f.port.value) || DEFAULT_PORT[type],
    folder: f.folder.value.trim(),
    jump: type === "ssh" ? f.jump.value.trim() : "",
    user: f.user.value.trim(),
    key: f.key.value.trim(),
    extra: f.extra.value.trim(),
    forwards: f.forwards.value.trim(),
    integrate: f.integrate.checked,
    color: f.color.value,
    icon: f.icon.value.trim(),
    tags: parseTags(f.tags.value),
    ...(type === "bastion" && {
      bastion: f.bastion.value.trim(),
      rg: f.rg.value.trim(),
      vm: f.vm.value.trim(),
      sub: f.sub.value.trim(),
    }),
  };
  const i = sessions.findIndex((x) => x.id === s.id);
  if (i >= 0) sessions[i] = s;
  else sessions.push(s);
  await invoke("save_sessions", { sessions });

  // Blank password keeps whatever is saved; unticking "Remember" with a blank field forgets it.
  const password = f.password.value;
  f.password.value = "";
  try {
    if (password) await invoke("secret_set", { key: secretKeyFor(s), value: password, persist: f.remember.checked });
    else if (!f.remember.checked) await invoke("secret_delete", { key: secretKeyFor(s) });
  } catch (err) {
    setStatus(String(err));
  }
  renderSessions();
  if (dlg.returnValue === "connect") connectSession(s);
});

function openSettings() {
  const form = $("settings-form");
  // Keys live in the OS keychain: show whether one is saved, never the key itself.
  invoke("api_keys_status").then((st) => {
    for (const el of document.querySelectorAll(".key-state")) {
      const saved = st[el.dataset.key];
      el.innerHTML = saved ? '· 🔒 saved in Credential Manager <a href="#" class="key-remove">Remove</a>' : "";
      el.querySelector(".key-remove")?.addEventListener("click", async (e) => {
        e.preventDefault();
        await invoke("api_key_delete", { provider: el.dataset.key });
        el.textContent = "· removed";
      });
    }
  });
  for (const el of form.elements) {
    if (!el.name || !(el.name in settings)) continue;
    if (el.type === "checkbox") el.checked = !!settings[el.name];
    else el.value = settings[el.name];
  }
  $("settings-dialog").showModal();
}

$("settings-dialog").addEventListener("close", async () => {
  if ($("settings-dialog").returnValue !== "save") return;
  const next = { ...settings };
  for (const el of $("settings-form").elements) {
    if (!el.name) continue;
    if (el.type === "checkbox") next[el.name] = el.checked;
    else if (el.type === "number") next[el.name] = Number(el.value);
    else if (el.name === "line_height") next[el.name] = Number(el.value) || 1;
    else next[el.name] = el.value;
  }
  await saveSettings(next);
  renderAgents();
});

async function saveSettings(next) {
  settings = next;
  setSettings(settings);
  setFontSize(settings.font_size || 14);
  applyAppearance();
  $("chat-provider").value = settings.chat_provider;
  updateStatus();
  try {
    await invoke("save_settings", { settings });
  } catch (err) {
    setStatus(`Could not save settings: ${err}`);
  }
}

// ------------------------------------------------------------------ chrome

function toggleAiPanel(force) {
  const open = document.body.classList.toggle("ai-open", force);
  if (!open) document.body.classList.remove("chat-full");
  if (open) $("chat-input").focus();
  else activeTab()?.term.focus();
}

/** Hides the sidebar (sessions, shells, snippets); the terminal takes the space. Remembered. */
function toggleSidebar(force) {
  const collapsed = document.body.classList.toggle("side-collapsed", force === undefined ? undefined : !force);
  closeSidePeek();
  try { localStorage.setItem("moxie-side-collapsed", collapsed ? "1" : ""); } catch {}
}

// Collapsed sidebar: the rail's section icons slide the full sidebar out over the terminal
// ("peek"); it closes again on a click outside, Esc, or once something in it is opened.
function openSidePeek(section) {
  document.body.classList.add("side-peek");
  const target = { shells: "shell-list", sessions: "session-filter", snippets: "snippet-filter", agents: "agent-list" }[section];
  const el = target && $(target);
  el?.closest("section")?.scrollIntoView({ block: "nearest" });
  if (el?.tagName === "INPUT") el.focus();
}
function closeSidePeek() {
  document.body.classList.remove("side-peek");
}
$("side-rail").addEventListener("click", (e) => {
  const what = e.target.closest("[data-rail]")?.dataset.rail;
  if (!what) return;
  if (what === "expand") return toggleSidebar(true);
  if (what === "new-ssh") return $("add-ssh").click();
  if (what === "settings") return $("open-settings").click();
  if (what === "changelog") return $("open-changelog").click();
  const same = document.body.classList.contains("side-peek") && $("side-rail").dataset.open === what;
  $("side-rail").dataset.open = what;
  if (same) closeSidePeek();
  else openSidePeek(what);
});
document.addEventListener("mousedown", (e) => {
  if (document.body.classList.contains("side-peek") && !e.target.closest("#sidebar, #side-rail, dialog")) closeSidePeek();
});
document.addEventListener("keydown", (e) => e.key === "Escape" && closeSidePeek());
// Opening a shell, session or agent from the peeked sidebar closes it.
$("sidebar").addEventListener("click", (e) => {
  if (document.body.classList.contains("side-peek") && e.target.closest(".list li:not(.muted)") && !e.target.closest(".item-actions")) setTimeout(closeSidePeek, 0);
});

/** Chat only: the AI panel covers the terminal area (the terminals keep running underneath). */
function toggleChatFull(force) {
  const full = document.body.classList.toggle("chat-full", force);
  if (full) document.body.classList.add("ai-open"), toggleEditor(false);
  try { localStorage.setItem("moxie-chat-full", full ? "1" : ""); } catch {}
  if (full) $("chat-input").focus();
  else activeTab()?.term.focus();
}

let statusTimer;
function setStatus(text) {
  $("status-left").textContent = text;
  clearTimeout(statusTimer);
  statusTimer = setTimeout(updateStatus, 6000);
}

function updateStatus() {
  const tab = activeTab();
  const info = tab?.si?.info;
  $("status-left").textContent = tab
    ? [
        tab.spec.title,
        info && `${info.user}@${info.host} · ${info.os}`,
        tab.spec.forwards?.length && `🔌 ${tab.spec.forwards.join(", ")}`,
        `${tab.term.cols}×${tab.term.rows}`,
      ]
        .filter(Boolean)
        .join(" · ")
    : "";
  const ac = settings.autocomplete_ai ? `autocomplete: ${PROVIDER_LABEL[settings.complete_provider]}` : "AI autocomplete off";
  if (!$("status-ai").classList.contains("busy") && !$("status-ai").classList.contains("error")) {
    $("status-ai").textContent = `✦ ${PROVIDER_LABEL[settings.chat_provider]} · ${ac}`;
  }
}

function openChangelog() {
  const dlg = $("changelog-dialog");
  const update = getPending();
  const banner = $("changelog-update-banner");
  if (update) {
    $("changelog-update-text").textContent = `v${update.version} is available`;
    $("changelog-update-notes").innerHTML = renderMarkdown(update.body ?? "");
    $("changelog-update-notes").classList.toggle("hidden", !update.body);
    banner.classList.remove("hidden");
    $("changelog-update-btn").onclick = () => { dlg.close(); checkForUpdate(true); };
  } else {
    banner.classList.add("hidden");
    $("changelog-update-notes").classList.add("hidden");
  }
  dlg.showModal();
}

$("changelog-close").addEventListener("click", () => $("changelog-dialog").close());
$("changelog-done").addEventListener("click", () => $("changelog-dialog").close());
$("changelog-check-updates").addEventListener("click", () => { $("changelog-dialog").close(); checkForUpdate(true); });
$("open-changelog").addEventListener("click", openChangelog);

$("add-ssh").addEventListener("click", () => openSshDialog());
$("session-filter").addEventListener("input", renderSessions);
$("open-settings").addEventListener("click", openSettings);
$("new-tab").addEventListener("click", newDefaultTab);
$("toggle-ai").addEventListener("click", () => toggleAiPanel());
$("chat-full").addEventListener("click", () => toggleChatFull());
$("side-toggle").addEventListener("click", () => toggleSidebar());
try { if (localStorage.getItem("moxie-side-collapsed")) toggleSidebar(false); } catch {}
try { if (localStorage.getItem("moxie-chat-full")) toggleChatFull(true); } catch {}
$("cmdbar-btn").addEventListener("click", () => openCommandBar());
$("files-btn").addEventListener("click", () => toggleFiles());
$("explain-btn").addEventListener("click", () => {
  if (!activeTab()) return;
  toggleAiPanel(true);
  sendChat("Explain the recent terminal output. If something failed, say why and how to fix it.", true);
});
$("chat-provider").addEventListener("change", (e) => saveSettings({ ...settings, chat_provider: e.target.value }));

//------------------------------------------------------------------ boot

async function boot() {
  initTerminals({
    onKey,
    onInput: trackInput,
    onCursor: (tab) => (positionGhost(tab), positionCompletion(tab)),
    onSent,
    onActivate: (tab) => (updateStatus(), showFilesFor(tab), setMonitorTab(tab), onPaneActivated(tab)),
    onTabsChanged: () => (updateStatus(), saveWorkspaceSoon()),
    onOpenLink: openLink,
    onOpenPath: openPath,
    onOutput: onTermOutput,
    onCommandStart,
    onCommandDone,
    onBlockMenu,
    onInfo: (tab) => tab === activeTab() && updateStatus(),
    onClose: (tab) => {
      closeCompletion(tab);
      filesOnClose(tab);
      if (tab.spec.tunnelKey) invoke("bastion_tunnel_stop", { key: tab.spec.tunnelKey });
    },
  });
  initFiles({ promptPassword });
  setAiHooks({
    onLineChanged: updateCompletion,
    onSaveSnippet: openSnippetEditor,
    sessionName: (id) => {
      const s = sessions.find((x) => x.id === id);
      return s ? sessionTitle(s) : "SSH session";
    },
  });
  initMonitor();
  initEditor({
    flash: setStatus,
    // The editor and chat full view both cover the terminal area: one at a time.
    onChange: (on) => {
      if (!on || !document.body.classList.contains("chat-full")) return;
      document.body.classList.remove("chat-full");
      try { localStorage.setItem("moxie-chat-full", ""); } catch {}
    },
  });
  // Picking a terminal tab (or opening one) brings the terminal back in front of the editor.
  $("tabs").addEventListener("mousedown", () => toggleEditor(false));
  $("new-tab").addEventListener("click", () => toggleEditor(false));
  initUpdater();
  $("check-updates").addEventListener("click", () => checkForUpdate(true));
  initCommandBar();
  initChat();
  initFind();
  $("split-right").addEventListener("click", () => splitActive("row"));
  $("split-down").addEventListener("click", () => splitActive("column"));
  $("broadcast-btn").addEventListener("click", toggleBroadcast);
  $("find-btn").addEventListener("click", openFind);
  $("shortcuts-btn").addEventListener("click", openShortcuts);
  fillAppearanceOptions();

  // A webview reload leaves the previous page's shells and SFTP connections running.
  await Promise.all([invoke("pty_kill_all"), invoke("sftp_disconnect_all"), invoke("bastion_stop_all")]);
  [settings, shells, sessions] = await Promise.all([
    invoke("get_settings"),
    invoke("list_shells"),
    invoke("get_sessions"),
  ]);
  setSettings(settings);
  setFontSize(settings.font_size || 14);
  applyAppearance();
  $("chat-provider").value = settings.chat_provider;
  renderShells();
  renderSessions();
  renderAgents();
  initSnippets({ setStatus });
  updateStatus();
  loadHistory();
  document.body.classList.add("ai-open");
  const restored = await restoreWorkspace();
  if (!restored) await newDefaultTab();
  restoring = false;
  saveWorkspaceSoon();
}

function fillAppearanceOptions() {
  const form = $("settings-form").elements;
  form.terminal_theme.innerHTML = Object.entries(THEMES).map(([k, t]) => `<option value="${k}">${t.name}</option>`).join("");
  form.font_family.innerHTML = FONTS.map(([v, label]) => `<option value='${v}'>${label}</option>`).join("");
}

boot();
if (import.meta.env.DEV) window.__moxie = { activeTab, allTabs, renderMarkdown }; // for automated UI tests
window.addEventListener("resize", () => allTabs().forEach(positionGhost));
