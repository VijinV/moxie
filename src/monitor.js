import { invoke } from "@tauri-apps/api/core";

const $ = (id) => document.getElementById(id);
let timer = null;
let isOpen = false;
let activeTab = null;  // set by main.js via setMonitorTab()

export function initMonitor() {
  $("monitor-btn").addEventListener("click", () => toggleMonitor());
  $("monitor-close").addEventListener("click", () => toggleMonitor(false));

  const handle = $("monitor-resize-handle");
  handle.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    const startY = e.clientY;
    const startH = parseInt(getComputedStyle(document.documentElement).getPropertyValue("--monitor-h")) || 220;
    document.body.classList.add("resizing");
    const onMove = (e) => {
      const h = Math.max(120, Math.min(600, startH - (e.clientY - startY)));
      document.documentElement.style.setProperty("--monitor-h", h + "px");
      localStorage.setItem("moxie-monitor-h", h + "px");
    };
    const onUp = () => {
      document.body.classList.remove("resizing");
      handle.removeEventListener("pointermove", onMove);
    };
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp, { once: true });
    handle.addEventListener("pointercancel", onUp, { once: true });
  });

  const saved = localStorage.getItem("moxie-monitor-h");
  if (saved) document.documentElement.style.setProperty("--monitor-h", saved);
}

/** Called by main.js whenever the active terminal tab changes. */
export function setMonitorTab(tab) {
  activeTab = tab;
  updateHostLabel();
  if (isOpen) poll(); // immediate refresh when switching tabs
  statusPoll();
}

export function toggleMonitor(force) {
  isOpen = force !== undefined ? !!force : !isOpen;
  document.body.classList.toggle("monitor-open", isOpen);
  $("monitor-btn").classList.toggle("active", isOpen);
  if (isOpen) {
    poll();
    timer = setInterval(poll, 2000);
  } else {
    clearInterval(timer);
    timer = null;
  }
}

/** "user@server · Ubuntu 24.04 · up 3d 4h" once stats arrive (`s`), just the target before. */
function updateHostLabel(s) {
  const el = $("monitor-host");
  if (!el) return;
  const ssh = activeTab?.spec?.ssh;
  const who = ssh ? `${ssh.user ? ssh.user + "@" : ""}${ssh.label ?? ssh.host}` : s?.host ? `${s.host} (this PC)` : "this PC";
  el.textContent = [who, s?.os, s?.uptime ? `up ${fmtUptime(s.uptime)}` : ""].filter(Boolean).join("  ·  ");
}

async function poll() {
  if (!isOpen) return;
  try {
    const tab = activeTab;
    const ssh = tab?.spec?.ssh;
    let stats;
    if (ssh) {
      stats = await invoke("get_remote_stats", {
        host: ssh.host,
        port: ssh.port ?? 22,
        user: ssh.user ?? "",
        keyPath: ssh.key ?? "",
        secretKey: ssh.secretKey ?? null,
        // The SFTP panel's connection when it has one: it already went through jump hosts / Bastion.
        connId: tab.files?.status === "ready" ? tab.files.connId : null,
      });
    } else {
      stats = await invoke("get_stats");
    }
    if (tab !== activeTab) return; // switched tabs while this poll was in flight
    render(stats);
  } catch (e) {
    const body = $("monitor-body");
    if (body) body.innerHTML = `<span class="muted" style="padding:12px">${esc(e)}</span>`;
  }
}

// ---- rendering helpers ----

// Process names and errors come from the server: never let them become markup.
const esc = (v) => String(v).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function bar(pct) {
  const p = Math.min(100, Math.max(0, pct));
  const color = p > 85 ? "var(--danger)" : p > 60 ? "#e0af68" : "var(--ok)";
  return `<div class="mon-bar"><div class="mon-fill" style="width:${p}%;background:${color}"></div></div>`;
}

function fmtBytes(b) {
  if (b < 1024) return b + " B/s";
  if (b < 1 << 20) return (b / 1024).toFixed(1) + " KB/s";
  if (b < 1 << 30) return (b / (1 << 20)).toFixed(1) + " MB/s";
  return (b / (1 << 30)).toFixed(2) + " GB/s";
}

function fmtMem(bytes) {
  const gb = bytes / (1 << 30);
  return gb >= 1 ? gb.toFixed(1) + " GB" : (bytes / (1 << 20)).toFixed(0) + " MB";
}

function fmtUptime(sec) {
  const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
}

function render(s) {
  updateHostLabel(s);
  const memPct  = s.mem_total  ? (s.mem_used  / s.mem_total  * 100) : 0;
  const swapPct = s.swap_total ? (s.swap_used / s.swap_total * 100) : 0;

  const coresHtml = s.cores.map(c => {
    const p = Math.min(100, c);
    const color = p > 85 ? "var(--danger)" : p > 60 ? "#e0af68" : "var(--ok)";
    return `<div class="mon-core" title="${c.toFixed(1)}%"><div class="mon-core-fill" style="height:${p}%;background:${color}"></div></div>`;
  }).join("");

  const procsHtml = s.procs.map(p =>
    `<div class="mon-proc">
      <span class="mon-proc-name" title="${esc(p.name)}">${esc(p.name)}</span>
      <span class="mon-proc-cpu ${p.cpu > 50 ? "hot" : ""}">${p.cpu.toFixed(1)}%</span>
      <div class="mon-bar slim"><div class="mon-fill" style="width:${Math.min(100,p.cpu)}%;background:${p.cpu>50?"var(--danger)":"var(--accent)"}"></div></div>
      <span class="mon-proc-mem">${p.mem_mb} MB</span>
    </div>`
  ).join("") || '<span class="muted">No processes</span>';

  const svcsHtml = (s.services ?? []).length
    ? (s.services ?? []).map(svc =>
        `<div class="mon-svc-chip"><span class="mon-svc-name">${esc(svc.name)}</span><span class="mon-svc-ver">${esc(svc.version)}</span></div>`
      ).join("")
    : "";

  $("monitor-body").innerHTML = `
    <div class="mon-col">
      <div class="mon-row">
        <span class="mon-lbl">CPU</span>
        ${bar(s.cpu)}
        <span class="mon-val">${s.cpu.toFixed(1)}%</span>
        <span class="mon-muted">load ${s.load.map(l => l.toFixed(2)).join(" ")}</span>
      </div>
      ${coresHtml.length ? `<div class="mon-cores-row">${coresHtml}</div>` : ""}
      <div class="mon-row">
        <span class="mon-lbl">MEM</span>
        ${bar(memPct)}
        <span class="mon-val">${fmtMem(s.mem_used)} / ${fmtMem(s.mem_total)}</span>
      </div>
      ${s.swap_total > 0 ? `<div class="mon-row">
        <span class="mon-lbl">SWP</span>
        ${bar(swapPct)}
        <span class="mon-val">${fmtMem(s.swap_used)} / ${fmtMem(s.swap_total)}</span>
      </div>` : ""}
      ${s.disks.map((d) => `<div class="mon-row">
        <span class="mon-lbl">DSK</span>
        ${bar(d.total ? (d.used / d.total) * 100 : 0)}
        <span class="mon-val">${fmtMem(d.used)} / ${fmtMem(d.total)}</span>
        <span class="mon-muted">${esc(d.mount)}</span>
      </div>`).join("")}
      <div class="mon-row">
        <span class="mon-lbl">NET</span>
        <span class="mon-net">↑ ${fmtBytes(s.net_tx)}</span>
        <span class="mon-net">↓ ${fmtBytes(s.net_rx)}</span>
      </div>
    </div>
    <div class="mon-divider"></div>
    ${svcsHtml ? `<div class="mon-col mon-svc-col">
      <span class="mon-lbl">SERVICES</span>
      <div class="mon-svc-grid">${svcsHtml}</div>
    </div>
    <div class="mon-divider"></div>` : ""}
    <div class="mon-col mon-procs-col">
      <div class="mon-procs-head">
        <span class="mon-lbl">PROCESSES</span>
        <span class="mon-muted" style="margin-left:auto">CPU</span>
        <span style="width:56px"></span>
        <span class="mon-muted">MEM</span>
      </div>
      ${procsHtml}
    </div>`;
}

// ---- status bar: CPU and memory of the active terminal's machine, plus the server's stack.
// SSH tabs read them over the Files panel's connection only, so the status bar never opens an
// SSH login of its own; without that connection it just shows nothing.

const STACK_PROBE = [
  "p(){ printf '%s=%s\\n' \"$1\" \"$2\"; }",
  "command -v nginx >/dev/null 2>&1 && p nginx ''",
  "command -v apache2 >/dev/null 2>&1 && p apache ''",
  "command -v php >/dev/null 2>&1 && p php \"$(php -r 'echo PHP_MAJOR_VERSION.\".\".PHP_MINOR_VERSION;' 2>/dev/null)\"",
  "command -v node >/dev/null 2>&1 && p node \"$(node -v 2>/dev/null | sed 's/^v//; s/\\..*//')\"",
  "command -v python3 >/dev/null 2>&1 && p python \"$(python3 -c 'import sys; print(\"%d.%d\" % sys.version_info[:2])' 2>/dev/null)\"",
  "command -v docker >/dev/null 2>&1 && p docker \"$(docker --version 2>/dev/null | sed -E 's/[^0-9]*([0-9]+).*/\\1/')\"",
  "command -v mysql >/dev/null 2>&1 && p mysql ''",
  "command -v psql >/dev/null 2>&1 && p postgres ''",
  "command -v redis-server >/dev/null 2>&1 && p redis ''",
  "true",
].join("; ");

const escStatus = (v) => String(v).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const gb = (b) => {
  const g = b / 2 ** 30;
  return g >= 10 ? String(Math.round(g)) : g.toFixed(1).replace(/\.0$/, "");
};

export function initStatusStats() {
  setInterval(statusPoll, 5000);
  statusPoll();
}

async function probeStack(tab) {
  tab.stack = [];
  try {
    const out = await invoke("sftp_exec", { connId: tab.files.connId, command: STACK_PROBE });
    tab.stack = out
      .split("\n")
      .map((l) => l.match(/^(\w+)=(.*)$/))
      .filter(Boolean)
      .map(([, name, ver]) => (ver.trim() ? `${name} ${ver.trim()}` : name));
  } catch {}
}

async function statusPoll() {
  const el = $("status-stats");
  const tab = activeTab;
  if (!el) return;
  if (!tab || tab.exited) return void (el.innerHTML = "");
  const ssh = tab.spec?.ssh;
  let s;
  try {
    if (ssh) {
      if (tab.files?.status !== "ready") return void (el.innerHTML = "");
      if (!tab.stack) await probeStack(tab);
      s = await invoke("get_remote_stats", {
        host: ssh.host,
        port: ssh.port ?? 22,
        user: ssh.user ?? "",
        keyPath: ssh.key ?? "",
        secretKey: ssh.secretKey ?? null,
        connId: tab.files.connId,
      });
    } else {
      s = await invoke("get_stats");
    }
  } catch {
    return void (el.innerHTML = "");
  }
  if (tab !== activeTab) return;
  el.innerHTML = [
    `<span>CPU ${Math.round(s.cpu)}%</span>`,
    s.mem_total ? `<span>Mem ${gb(s.mem_used)} / ${gb(s.mem_total)} GB</span>` : "",
    tab.stack?.length ? `<span class="status-stack">${escStatus(tab.stack.join(" · "))}</span>` : "",
  ].join("");
}
