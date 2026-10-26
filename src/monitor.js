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
