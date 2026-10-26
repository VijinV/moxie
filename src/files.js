// MobaXterm-style SFTP side panel: follows the active SSH tab, browse / download / upload
// (buttons or drag & drop from Explorer) / rename / delete / open with default app.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { activeTab, sendText } from "./terminal.js";

const $ = (id) => document.getElementById(id);
let promptPassword = async () => null;
const transfers = new Map();

export function initFiles(opts) {
  promptPassword = opts.promptPassword;
  $("files-close").addEventListener("click", () => toggleFiles(false));
  $("files-path").addEventListener("keydown", (e) => {
    if (e.key === "Enter") navigate(activeTab(), e.target.value.trim());
  });
  document.querySelector(".files-toolbar").addEventListener("click", (e) => {
    const action = e.target.closest("[data-files]")?.dataset.files;
    const tab = activeTab();
    const f = tab?.files;
    if (!action || f?.status !== "ready") return;
    if (action === "up") navigate(tab, parent(f.cwd));
    if (action === "home") navigate(tab, f.home);
    if (action === "refresh") navigate(tab, f.cwd);
    if (action === "mkdir") mkdir(tab);
    if (action === "upload") pickAndUpload(tab, false);
    if (action === "upload-dir") pickAndUpload(tab, true);
  });

  const body = $("files-body");
  body.addEventListener("click", (e) => select(e.target.closest(".file-row")));
  body.addEventListener("dblclick", (e) => {
    const entry = entryOf(e.target.closest(".file-row"));
    if (entry) activateEntry(activeTab(), entry);
  });
  body.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    const row = e.target.closest(".file-row");
    select(row);
    entryMenu(activeTab(), entryOf(row), e.clientX, e.clientY);
  });
  body.addEventListener("keydown", (e) => {
    const tab = activeTab();
    const entry = tab?.files?.entries?.[tab.files.selected];
    if (e.key === "Backspace") navigate(tab, parent(tab.files.cwd));
    if (!entry) return;
    if (e.key === "Enter") activateEntry(tab, entry);
    if (e.key === "Delete") remove(tab, entry);
    if (e.key === "F2") rename(tab, entry);
  });
  document.addEventListener("mousedown", (e) => {
    if (!e.target.closest("#ctx-menu")) $("ctx-menu").classList.add("hidden");
  });

  listen("sftp-edit", (e) => {
    const { remote, status, error } = e.payload;
    const name = remote.split("/").pop();
    const time = new Date().toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    if (status === "opened") flash(`Editing ${name}: saves upload to the server automatically`);
    else if (status === "uploaded") flash(`✓ ${name} uploaded to ${remote} (${time})`);
    else if (status === "error") flash(`✗ Couldn't upload ${name}: ${error}`);
    else if (status === "stopped") flash(`Stopped syncing ${name} (connection closed)`);
    const tab = activeTab();
    if (status === "uploaded" && tab?.files?.status === "ready" && remote.startsWith(tab.files.cwd)) navigate(tab, tab.files.cwd);
  });
  listen("sftp-progress", (e) => {
    const t = transfers.get(e.payload.transfer_id);
    if (!t) return;
    Object.assign(t, { file: e.payload.name, done: e.payload.done, total: e.payload.total });
    renderTransfers();
  });

  // Drag files/folders from Explorer onto the panel to upload them to the current folder.
  getCurrentWebview().onDragDropEvent((ev) => {
    const p = ev.payload;
    const overPanel = () => {
      if (!document.body.classList.contains("files-open") || !p.position) return false;
      const r = $("files-panel").getBoundingClientRect();
      const x = p.position.x / devicePixelRatio;
      const y = p.position.y / devicePixelRatio;
      return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
    };
    const ready = activeTab()?.files?.status === "ready";
    if (p.type === "enter" || p.type === "over") $("files-drop").classList.toggle("hidden", !(ready && overPanel()));
    else if (p.type === "drop") {
      $("files-drop").classList.add("hidden");
      if (ready && overPanel()) for (const path of p.paths) upload(activeTab(), path);
    } else $("files-drop").classList.add("hidden");
  });
}

export function toggleFiles(force) {
  const open = document.body.classList.toggle("files-open", force);
  document.body.dataset.filesView ??= "files";
  if (open) showFilesFor(activeTab());
  window.dispatchEvent(new Event("resize"));
}

/** Called whenever the active tab changes. */
export function showFilesFor(tab) {
  if (!document.body.classList.contains("files-open")) return;
  if (tab?.spec.ssh && !tab.files) {
    tab.files = { connId: `tab-${tab.id}`, status: "idle", cwd: "", entries: [], selected: -1 };
  }
  if (tab?.files?.status === "idle") connect(tab);
  render();
}

/** Ctrl+click on a remote path: open the folder, or show the file selected in its folder. */
export async function openRemotePath(tab, path) {
  const f = tab.files;
  if (f?.status !== "ready") return;
  try {
    await invoke("sftp_list", { connId: f.connId, path });
    return navigate(tab, path); // it's a folder
  } catch {}
  const parentDir = parent(path);
  await navigate(tab, parentDir);
  const name = path.split("/").pop();
  const i = f.entries.findIndex((e) => e.name === name);
  if (i < 0) return flash(`Not found on the server: ${path}`);
  f.selected = i;
  render();
  $("files-body").querySelector(".file-row.selected")?.scrollIntoView({ block: "center" });
  flash(`${name}: right-click for Edit / Download`);
}

export function filesOnClose(tab) {
  if (tab.files) invoke("sftp_disconnect", { connId: tab.files.connId });
}

// ---------------------------------------------------------------- connection

async function connect(tab, trust = null) {
  const f = tab.files;
  const s = tab.spec.ssh;
  f.status = "connecting";
  render();
  try {
    const home = await invoke("sftp_connect", {
      connId: f.connId,
      host: s.host,
      port: Number(s.port) || 22,
      user: s.user || "",
      keyPath: s.key || "",
      secretKey: s.secretKey,
      trust,
      knownHostAlias: s.hostKeyAlias ?? null,
      jump: s.jump ?? null,
    });
    f.home = home;
    f.status = "ready";
    await navigate(tab, home);
  } catch (err) {
    const msg = String(err);
    if (msg.startsWith("HOSTKEY_UNKNOWN:")) {
      // "HOSTKEY_UNKNOWN:<fingerprint>;<which host>" — the jump host and the server are checked separately.
      const [fp, which] = msg.slice(16).split(";");
      Object.assign(f, { status: "hostkey", fingerprint: fp, keyHost: which?.startsWith("jump host") ? which : null });
    } else if (msg.startsWith("HOSTKEY_CHANGED:")) {
      Object.assign(f, {
        status: "error",
        error: `WARNING: the host key for ${msg.split(";")[1]?.startsWith("jump host") ? msg.split(";")[1] : s.label ?? s.host} has CHANGED (${msg.slice(16).split(";")[0]}). This could be a man-in-the-middle attack. If the server was reinstalled, remove its old entry from ~/.ssh/known_hosts.`,
      });
    } else if (msg.startsWith("AUTH_")) {
      const retry = await promptPassword(
        s,
        msg === "AUTH_FAILED" ? "The saved password was rejected." : "No key or saved password worked.",
      );
      if (retry) return connect(tab, trust);
      Object.assign(f, { status: "error", error: "Authentication cancelled." });
    } else {
      Object.assign(f, { status: "error", error: msg });
    }
  }
  if (tab === activeTab()) render();
}

async function navigate(tab, path) {
  const f = tab?.files;
  if (f?.status !== "ready" || !path) return;
  try {
    const entries = await invoke("sftp_list", { connId: f.connId, path });
    f.cwd = await invoke("sftp_canonicalize", { connId: f.connId, path });
    f.entries = entries;
    f.selected = -1;
  } catch (err) {
    flash(`Can't open ${path}: ${err}`);
  }
  if (tab === activeTab()) render();
}

// ---------------------------------------------------------------- actions

function activateEntry(tab, entry) {
  if (entry.is_dir) navigate(tab, entry.path);
  else openRemote(tab, entry);
}

/** Opens a remote file in the editor; every save is uploaded back (MobaXterm-style). */
async function editRemote(tab, entry) {
  flash(`Opening ${entry.name} for editing…`);
  try {
    await invoke("sftp_edit", { connId: tab.files.connId, remote: entry.path });
  } catch (err) {
    flash(`Edit failed: ${err}`);
  }
}

async function openRemote(tab, entry) {
  flash(`Opening ${entry.name}…`);
  try {
    await invoke("sftp_open", { connId: tab.files.connId, remote: entry.path });
  } catch (err) {
    flash(`Open failed: ${err}`);
  }
}

async function download(tab, entry) {
  let dir = null;
  try {
    dir = localStorage.getItem("moxie.downloadDir");
  } catch {}
  const picked = await openDialog({ directory: true, title: `Download ${entry.name} to…`, defaultPath: dir ?? undefined });
  if (!picked) return;
  try {
    localStorage.setItem("moxie.downloadDir", picked);
  } catch {}
  const id = startTransfer("↓", entry.name);
  try {
    const local = await invoke("sftp_download", {
      connId: tab.files.connId,
      transferId: id,
      remote: entry.path,
      isDir: entry.is_dir,
      localDir: picked,
    });
    finishTransfer(id, null, local);
  } catch (err) {
    finishTransfer(id, err);
  }
}

async function pickAndUpload(tab, directory) {
  const picked = await openDialog({ multiple: !directory, directory, title: "Upload to " + tab.files.cwd });
  if (!picked) return;
  for (const path of [].concat(picked)) upload(tab, path);
}

async function upload(tab, localPath) {
  const f = tab.files;
  const dir = f.cwd;
  const id = startTransfer("↑", localPath.split(/[\\/]/).pop());
  try {
    await invoke("sftp_upload", { connId: f.connId, transferId: id, local: localPath, remoteDir: dir });
    finishTransfer(id);
    if (f.cwd === dir) navigate(tab, dir);
  } catch (err) {
    finishTransfer(id, err);
  }
}

async function mkdir(tab) {
  const name = prompt("New folder name");
  if (!name) return;
  try {
    await invoke("sftp_mkdir", { connId: tab.files.connId, path: join(tab.files.cwd, name) });
    navigate(tab, tab.files.cwd);
  } catch (err) {
    flash(`mkdir failed: ${err}`);
  }
}

async function rename(tab, entry) {
  const name = prompt("Rename to", entry.name);
  if (!name || name === entry.name) return;
  try {
    await invoke("sftp_rename", { connId: tab.files.connId, from: entry.path, to: join(tab.files.cwd, name) });
    navigate(tab, tab.files.cwd);
  } catch (err) {
    flash(`Rename failed: ${err}`);
  }
}

async function remove(tab, entry) {
  const what = entry.is_dir ? `folder "${entry.name}" and everything in it` : `"${entry.name}"`;
  if (!confirm(`Delete ${what} from the server? This can't be undone.`)) return;
  try {
    await invoke("sftp_remove", { connId: tab.files.connId, path: entry.path, isDir: entry.is_dir });
    navigate(tab, tab.files.cwd);
  } catch (err) {
    flash(`Delete failed: ${err}`);
  }
}

function entryMenu(tab, entry, x, y) {
  if (!tab?.files || tab.files.status !== "ready") return;
  const items = entry
    ? [
        [entry.is_dir ? "Open folder" : "Open", () => activateEntry(tab, entry)],
        ...(entry.is_dir ? [] : [["Edit (uploads on save)", () => editRemote(tab, entry)]]),
        ["Download…", () => download(tab, entry)],
        ["Rename… (F2)", () => rename(tab, entry)],
        ["Delete (Del)", () => remove(tab, entry)],
        ["—"],
        ["Copy path", () => navigator.clipboard.writeText(entry.path)],
        ["Insert path in terminal", () => sendText(tab, quote(entry.path))],
        ...(entry.is_dir ? [["cd here in terminal", () => sendText(tab, `cd ${quote(entry.path)}`, true)]] : []),
      ]
    : [
        ["New folder…", () => mkdir(tab)],
        ["Upload files…", () => pickAndUpload(tab, false)],
        ["Refresh", () => navigate(tab, tab.files.cwd)],
        ["cd here in terminal", () => sendText(tab, `cd ${quote(tab.files.cwd)}`, true)],
      ];
  const menu = $("ctx-menu");
  menu.innerHTML = "";
  for (const [label, fn] of items) {
    if (label === "—") {
      menu.insertAdjacentHTML("beforeend", "<hr>");
      continue;
    }
    const b = document.createElement("button");
    b.textContent = label;
    b.addEventListener("click", () => {
      menu.classList.add("hidden");
      fn();
    });
    menu.appendChild(b);
  }
  menu.classList.remove("hidden");
  menu.style.left = `${Math.min(x, innerWidth - 220)}px`;
  menu.style.top = `${Math.min(y, innerHeight - menu.offsetHeight - 8)}px`;
}

// ---------------------------------------------------------------- transfers

function startTransfer(dir, name) {
  const id = crypto.randomUUID();
  transfers.set(id, { dir, name, file: name, done: 0, total: 0, state: "running" });
  renderTransfers();
  return id;
}

function finishTransfer(id, error = null, local = null) {
  const t = transfers.get(id);
  if (!t) return;
  t.state = error ? "error" : "done";
  t.error = error ? String(error) : null;
  t.local = local;
  renderTransfers();
  setTimeout(() => (transfers.delete(id), renderTransfers()), error ? 15000 : 8000);
}

function renderTransfers() {
  const root = $("transfers");
  root.innerHTML = "";
  for (const [id, t] of transfers) {
    const pct = t.total ? Math.round((t.done / t.total) * 100) : t.state === "done" ? 100 : 0;
    const row = document.createElement("div");
    row.className = `transfer ${t.state}`;
    const label =
      t.state === "error" ? `${t.name}: ${t.error}` : t.state === "done" ? `${t.name} — done` : `${t.file} ${pct}% (${fmtSize(t.done)})`;
    row.innerHTML = `<div class="transfer-label"><span>${t.dir}</span> <span class="tl"></span></div><div class="bar"><div style="width:${pct}%"></div></div>`;
    row.querySelector(".tl").textContent = label;
    if (t.local) {
      const show = document.createElement("button");
      show.textContent = "Show";
      show.addEventListener("click", () => invoke("reveal_local", { path: t.local }));
      row.querySelector(".transfer-label").appendChild(show);
    }
    root.appendChild(row);
  }
}

// ---------------------------------------------------------------- render

function render() {
  const tab = activeTab();
  const body = $("files-body");
  const f = tab?.files;
  $("files-title").textContent = tab?.spec.ssh ? `SFTP · ${tab.spec.title}` : "SFTP";
  $("files-path").value = f?.cwd ?? "";
  $("files-path").disabled = f?.status !== "ready";

  if (!tab?.spec.ssh) return void (body.innerHTML = `<div class="files-msg">Open an SSH session to browse its files.</div>`);
  if (f.status === "connecting") return void (body.innerHTML = `<div class="files-msg">Connecting…</div>`);
  if (f.status === "hostkey") {
    body.innerHTML = `<div class="files-msg">First connection to <b></b>. Verify its host key fingerprint:<code></code>
      <button class="primary-btn">Trust &amp; connect</button></div>`;
    body.querySelector("b").textContent = f.keyHost ?? tab.spec.ssh.label ?? tab.spec.ssh.host;
    body.querySelector("code").textContent = f.fingerprint;
    body.querySelector("button").addEventListener("click", () => connect(tab, f.fingerprint));
    return;
  }
  if (f.status === "error") {
    body.innerHTML = `<div class="files-msg error"><span></span><button class="ghost-btn">Retry</button></div>`;
    body.querySelector("span").textContent = f.error;
    body.querySelector("button").addEventListener("click", () => connect(tab));
    return;
  }
  if (f.status !== "ready") return;

  body.innerHTML = "";
  body.tabIndex = 0;
  if (!f.entries.length) body.innerHTML = `<div class="files-msg">Empty folder</div>`;
  f.entries.forEach((e, i) => {
    const row = document.createElement("div");
    row.className = "file-row" + (i === f.selected ? " selected" : "") + (e.name.startsWith(".") ? " dot" : "");
    row.dataset.index = i;
    row.title = `${e.perms}  ${e.path}`;
    row.innerHTML = `<span class="fi"></span><span class="fn"></span><span class="fs"></span><span class="fd"></span>`;
    row.querySelector(".fi").textContent = e.is_dir ? "📁" : e.is_link ? "🔗" : "📄";
    row.querySelector(".fn").textContent = e.name;
    row.querySelector(".fs").textContent = e.is_dir ? "" : fmtSize(e.size);
    row.querySelector(".fd").textContent = e.mtime ? fmtDate(e.mtime) : "";
    body.appendChild(row);
  });
}

function select(row) {
  const f = activeTab()?.files;
  if (!f) return;
  f.selected = row ? Number(row.dataset.index) : -1;
  for (const r of $("files-body").querySelectorAll(".file-row")) r.classList.toggle("selected", r === row);
}

function entryOf(row) {
  return row ? activeTab()?.files?.entries[Number(row.dataset.index)] : null;
}

function flash(text) {
  const el = $("status-left");
  if (el) el.textContent = text;
}

const parent = (p) => (p === "/" ? "/" : p.replace(/\/[^/]+\/?$/, "") || "/");
const join = (dir, name) => (dir.endsWith("/") ? dir + name : `${dir}/${name}`);
const quote = (p) => (/^[\w./~-]+$/.test(p) ? p : `'${p.replace(/'/g, `'\\''`)}'`);

function fmtSize(n) {
  if (n < 1024) return `${n} B`;
  const u = ["KB", "MB", "GB", "TB"];
  let i = -1;
  do {
    n /= 1024;
    i++;
  } while (n >= 1024 && i < u.length - 1);
  return `${n.toFixed(n < 10 ? 1 : 0)} ${u[i]}`;
}

function fmtDate(secs) {
  const d = new Date(secs * 1000);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", ...(sameYear ? {} : { year: "numeric" }) }) +
    (sameYear ? " " + d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }) : "");
}
