import "./styles.css";
import { invoke } from "@tauri-apps/api/core";
import { initTerminals, openTab, closeTab, activeTab, allTabs, setFontSize } from "./terminal.js";
import {
  setSettings, loadHistory, trackInput, onSent, positionGhost, hideSuggestion, acceptSuggestion,
  requestAiCompletion, initCommandBar, openCommandBar, initChat, sendChat, renderMarkdown,
} from "./ai.js";
import { initFiles, toggleFiles, showFilesFor, filesOnClose } from "./files.js";

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

  if (ev.ctrlKey && !ev.shiftKey && key === "k") return openCommandBar(), false;
  if (ev.ctrlKey && ev.code === "Space") return requestAiCompletion(tab, true), false;
  if (ev.ctrlKey && ev.shiftKey) {
    if (key === "a") return toggleAiPanel(), false;
    if (key === "t") return newDefaultTab(), false;
    if (key === "f") return toggleFiles(), false;
    if (key === "w") return closeTab(tab.id), false;
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
  else if (ev.ctrlKey && ev.shiftKey && key === "t") (ev.preventDefault(), newDefaultTab());
  else if (ev.ctrlKey && ev.shiftKey && key === "f") (ev.preventDefault(), toggleFiles());
  else if (ev.ctrlKey && !ev.shiftKey && key === "k" && activeTab()) (ev.preventDefault(), openCommandBar());
});

// ------------------------------------------------------------------ sidebar

function renderShells() {
  const ul = $("shell-list");
  ul.innerHTML = "";
  for (const s of shells) {
    const li = item(s.name, "›_", () =>
      openTab({ title: s.name, program: s.program, args: s.args, kind: "shell", shellName: s.name }),
    );
    ul.appendChild(li);
  }
}

function renderSessions() {
  const ul = $("ssh-list");
  const q = $("session-filter").value.toLowerCase();
  ul.innerHTML = "";
  const list = sessions.filter((s) => `${s.name} ${s.host} ${s.user} ${s.vm ?? ""}`.toLowerCase().includes(q));
  if (!list.length) {
    ul.innerHTML = `<li class="muted small">${sessions.length ? "No matches" : "No saved sessions yet"}</li>`;
    return;
  }
  for (const s of list) {
    const bastion = s.type === "bastion";
    const li = item(sessionTitle(s), bastion ? "☁" : "⇄", () => connectSession(s));
    li.title = bastion
      ? `${s.user ? s.user + "@" : ""}${vmName(s.vm)} via Azure Bastion ${s.bastion}`
      : `${s.user ? s.user + "@" : ""}${s.host}:${s.port || 22}`;
    const actions = document.createElement("span");
    actions.className = "item-actions";
    actions.innerHTML = `<button title="Edit">✎</button><button title="Delete">×</button>`;
    const [edit, del] = actions.querySelectorAll("button");
    edit.addEventListener("click", (e) => (e.stopPropagation(), openSshDialog(s)));
    del.addEventListener("click", async (e) => {
      e.stopPropagation();
      if (!confirm(`Delete session "${s.name || s.host}"?`)) return;
      sessions = sessions.filter((x) => x.id !== s.id);
      await invoke("save_sessions", { sessions });
      invoke("secret_delete", { key: secretKeyFor(s) });
      renderSessions();
    });
    li.appendChild(actions);
    ul.appendChild(li);
  }
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

function connectSession(s) {
  if (s.type === "bastion") connectBastion(s);
  else connectSsh(s);
}

function connectSsh(s) {
  const problem = hostProblem(s.host);
  if (problem) {
    setStatus(problem);
    if (sessions.some((x) => x.id === s.id)) openSshDialog(s); // let them fix the saved host
    return;
  }
  openSshTab(s, { host: s.host, port: s.port });
}

/** Opens `az network bastion tunnel` to the VM, then SSH/SFTP over 127.0.0.1:<port>. */
async function connectBastion(s) {
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
  openSshTab(s, { host: "127.0.0.1", port, hostKeyAlias: `${vmName(s.vm)}.bastion`, tunnelKey });
}

function openSshTab(s, { host, port, hostKeyAlias = null, tunnelKey = null }) {
  const args = [];
  if (port && String(port) !== "22") args.push("-p", String(port));
  if (hostKeyAlias) args.push("-o", `HostKeyAlias=${hostKeyAlias}`);
  if (s.key) args.push("-i", s.key);
  if (s.extra) args.push(...s.extra.split(/\s+/).filter(Boolean));
  args.push(s.user ? `${s.user}@${host}` : host);
  const secretKey = secretKeyFor(s);
  openTab({
    title: sessionTitle(s),
    program: "ssh",
    args,
    kind: "ssh",
    secretKey,
    tunnelKey,
    ssh: { host, port, user: s.user, key: s.key, secretKey, hostKeyAlias, label: hostKeyAlias ?? host },
  });
  toggleFiles(true); // MobaXterm opens the SFTP browser alongside every SSH session
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
  if (s) openTab({ title: s.name, program: s.program, args: s.args, kind: "shell", shellName: s.name });
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
  for (const el of document.querySelectorAll("#ssh-form [data-for]")) el.hidden = el.dataset.for !== f.type.value;
  f.host.required = !bastion;
  f.host.setCustomValidity(bastion ? "" : hostProblem(f.host.value));
  for (const k of ["bastion", "rg", "vm"]) f[k].required = bastion;
  const vm = f.vm.value.trim();
  f.vm.setCustomValidity(
    bastion && vm && !VM_ID.test(vm)
      ? "Paste the VM's full resource ID: /subscriptions/<id>/resourceGroups/<rg>/providers/Microsoft.Compute/virtualMachines/<vm>"
      : "",
  );
}
$("ssh-form").addEventListener("input", validateSshForm);

function openSshDialog(session = null) {
  const dlg = $("ssh-dialog");
  const form = $("ssh-form");
  form.reset();
  const s = session ?? { port: 22 };
  for (const k of ["id", "name", "host", "port", "user", "key", "extra", "bastion", "rg", "vm", "sub"]) form.elements[k].value = s[k] ?? "";
  form.elements.type.value = s.type ?? "ssh";
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
  if (type === "ssh" ? !f.host.value.trim() : !f.vm.value.trim()) return;
  const s = {
    id: f.id.value || crypto.randomUUID(),
    type,
    name: f.name.value.trim(),
    host: type === "ssh" ? f.host.value.trim() : "",
    port: Number(f.port.value) || 22,
    user: f.user.value.trim(),
    key: f.key.value.trim(),
    extra: f.extra.value.trim(),
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
    else next[el.name] = el.value;
  }
  await saveSettings(next);
  renderAgents();
});

async function saveSettings(next) {
  settings = next;
  setSettings(settings);
  setFontSize(settings.font_size || 14);
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
  if (open) $("chat-input").focus();
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
  $("status-left").textContent = tab ? `${tab.spec.title} · ${tab.term.cols}×${tab.term.rows}` : "";
  const ac = settings.autocomplete_ai ? `autocomplete: ${PROVIDER_LABEL[settings.complete_provider]}` : "AI autocomplete off";
  if (!$("status-ai").classList.contains("busy") && !$("status-ai").classList.contains("error")) {
    $("status-ai").textContent = `✦ ${PROVIDER_LABEL[settings.chat_provider]} · ${ac}`;
  }
}

$("add-ssh").addEventListener("click", () => openSshDialog());
$("session-filter").addEventListener("input", renderSessions);
$("open-settings").addEventListener("click", openSettings);
$("new-tab").addEventListener("click", newDefaultTab);
$("toggle-ai").addEventListener("click", () => toggleAiPanel());
$("cmdbar-btn").addEventListener("click", () => openCommandBar());
$("files-btn").addEventListener("click", () => toggleFiles());
$("explain-btn").addEventListener("click", () => {
  if (!activeTab()) return;
  toggleAiPanel(true);
  sendChat("Explain the recent terminal output. If something failed, say why and how to fix it.", true);
});
$("chat-provider").addEventListener("change", (e) => saveSettings({ ...settings, chat_provider: e.target.value }));

// ------------------------------------------------------------------ boot

async function boot() {
  initTerminals({
    onKey,
    onInput: trackInput,
    onCursor: positionGhost,
    onSent,
    onActivate: (tab) => (updateStatus(), showFilesFor(tab)),
    onTabsChanged: updateStatus,
    onClose: (tab) => {
      filesOnClose(tab);
      if (tab.spec.tunnelKey) invoke("bastion_tunnel_stop", { key: tab.spec.tunnelKey });
    },
  });
  initFiles({ promptPassword });
  initCommandBar();
  initChat();

  // A webview reload leaves the previous page's shells and SFTP connections running.
  await Promise.all([invoke("pty_kill_all"), invoke("sftp_disconnect_all"), invoke("bastion_stop_all")]);
  [settings, shells, sessions] = await Promise.all([
    invoke("get_settings"),
    invoke("list_shells"),
    invoke("get_sessions"),
  ]);
  setSettings(settings);
  setFontSize(settings.font_size || 14);
  $("chat-provider").value = settings.chat_provider;
  renderShells();
  renderSessions();
  renderAgents();
  updateStatus();
  loadHistory();
  document.body.classList.add("ai-open");
  newDefaultTab();
}

boot();
if (import.meta.env.DEV) window.__moxie = { activeTab, allTabs, renderMarkdown }; // for automated UI tests
window.addEventListener("resize", () => allTabs().forEach(positionGhost));
