// Server dashboard (Files panel → Server tab): CPU, load, memory, disks, uptime and top processes
// for the active SSH session, read over the panel's own SSH connection every few seconds.
import { invoke } from "@tauri-apps/api/core";
import { activeTab } from "./terminal.js";

const $ = (id) => document.getElementById(id);

// One round trip; sections are separated by @@ markers so missing tools just leave a section empty.
const PROBE = [
  "echo @@stat; head -1 /proc/stat",
  "echo @@load; cat /proc/loadavg",
  "echo @@cpus; nproc 2>/dev/null || grep -c ^processor /proc/cpuinfo",
  "echo @@mem; grep -E '^(MemTotal|MemAvailable|SwapTotal|SwapFree):' /proc/meminfo",
  "echo @@disk; df -Pk 2>/dev/null | tail -n +2",
  "echo @@up; cat /proc/uptime",
  "echo @@ps; (ps -eo pid,user,pcpu,pmem,comm --sort=-pcpu 2>/dev/null || ps -o pid,user,comm 2>/dev/null) | head -9",
].join("; ");

let timer = null;
const lastStat = new Map(); // connId -> [idle, total]

export function initDashboard() {
  document.querySelectorAll(".panel-tabs [data-view]").forEach((b) =>
    b.addEventListener("click", () => showView(b.dataset.view)),
  );
}

function showView(view) {
  document.body.dataset.filesView = view;
  document.querySelectorAll(".panel-tabs [data-view]").forEach((b) => b.classList.toggle("on", b.dataset.view === view));
  if (view === "server") refreshDashboard();
  else stop();
}

export function refreshDashboard() {
  stop();
  if (document.body.dataset.filesView !== "server" || !document.body.classList.contains("files-open")) return;
  poll();
  timer = setInterval(poll, 4000);
}

function stop() {
  clearInterval(timer);
  timer = null;
}

async function poll() {
  const tab = activeTab();
  const box = $("dashboard");
  if (!tab?.spec.ssh) return void (box.innerHTML = `<div class="files-msg">Open an SSH session to see its CPU, memory, disks and processes.</div>`);
  if (tab.files?.status !== "ready") return void (box.innerHTML = `<div class="files-msg">Connecting… (the dashboard uses the Files panel's connection)</div>`);
  let out;
  try {
    out = await invoke("sftp_exec", { connId: tab.files.connId, command: PROBE });
  } catch (err) {
    box.innerHTML = `<div class="files-msg error"></div>`;
    box.firstChild.textContent = `Couldn't read server stats: ${err}`;
    return;
  }
  if (tab !== activeTab()) return;
  render(tab, parse(out));
}

function parse(out) {
  const sec = {};
  let cur = null;
  for (const line of out.split("\n")) {
    const m = line.match(/^@@(\w+)$/);
    if (m) sec[(cur = m[1])] = [];
    else if (cur && line.trim()) sec[cur].push(line);
  }
  const kb = (name) => Number((sec.mem ?? []).find((l) => l.startsWith(name + ":"))?.match(/(\d+)/)?.[1] ?? 0) * 1024;
  const disks = (sec.disk ?? [])
    .map((l) => l.trim().split(/\s+/))
    .filter((c) => c.length >= 6 && /^\//.test(c[5]) && Number(c[1]) > 0 && !/^\/(proc|sys|dev|run)/.test(c[5]))
    .map((c) => ({ mount: c[5], size: Number(c[1]) * 1024, used: Number(c[2]) * 1024 }));
  return {
    stat: (sec.stat?.[0] ?? "").trim().split(/\s+/).slice(1).map(Number),
    load: (sec.load?.[0] ?? "").split(" ").slice(0, 3),
    cpus: Number(sec.cpus?.[0]) || 1,
    mem: { total: kb("MemTotal"), avail: kb("MemAvailable"), swapTotal: kb("SwapTotal"), swapFree: kb("SwapFree") },
    disks,
    uptime: Number((sec.up?.[0] ?? "0").split(" ")[0]),
    ps: sec.ps ?? [],
  };
}

function cpuPercent(connId, stat) {
  if (stat.length < 4) return null;
  const idle = stat[3] + (stat[4] ?? 0);
  const total = stat.reduce((a, b) => a + b, 0);
  const prev = lastStat.get(connId);
  lastStat.set(connId, [idle, total]);
  if (!prev || total === prev[1]) return null;
  return Math.max(0, Math.min(100, 100 * (1 - (idle - prev[0]) / (total - prev[1]))));
}

const fmtBytes = (n) => {
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) (n /= 1024), i++;
  return `${n.toFixed(n < 10 && i ? 1 : 0)} ${u[i]}`;
};
const fmtUptime = (s) => {
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
};
const level = (pct) => (pct >= 90 ? "crit" : pct >= 75 ? "warn" : "ok");
const bar = (pct) => `<div class="db-bar ${level(pct)}"><div style="width:${Math.min(100, pct).toFixed(1)}%"></div></div>`;
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

function render(tab, d) {
  const cpu = cpuPercent(tab.files.connId, d.stat);
  const memUsed = d.mem.total - d.mem.avail;
  const memPct = d.mem.total ? (memUsed / d.mem.total) * 100 : 0;
  const swapUsed = d.mem.swapTotal - d.mem.swapFree;
  const info = tab.si?.info;
  const loadPct = (Number(d.load[0]) / d.cpus) * 100;
  $("dashboard").innerHTML = `
    <div class="db-head">${esc(info ? `${info.user}@${info.host}` : tab.spec.title)}<span>${esc(info?.os ?? "")}</span><span>up ${fmtUptime(d.uptime)}</span></div>
    <div class="db-metric"><div class="db-label">CPU <b>${cpu == null ? "…" : cpu.toFixed(0) + "%"}</b><span>${d.cpus} core${d.cpus > 1 ? "s" : ""}</span></div>${bar(cpu ?? 0)}</div>
    <div class="db-metric"><div class="db-label">Load <b>${esc(d.load.join(" · "))}</b><span>1 · 5 · 15 min</span></div>${bar(loadPct)}</div>
    <div class="db-metric"><div class="db-label">Memory <b>${fmtBytes(memUsed)} / ${fmtBytes(d.mem.total)}</b><span>${memPct.toFixed(0)}%</span></div>${bar(memPct)}</div>
    ${d.mem.swapTotal ? `<div class="db-metric"><div class="db-label">Swap <b>${fmtBytes(swapUsed)} / ${fmtBytes(d.mem.swapTotal)}</b></div>${bar((swapUsed / d.mem.swapTotal) * 100)}</div>` : ""}
    <div class="db-section">Disks</div>
    ${d.disks
      .map((x) => {
        const pct = (x.used / x.size) * 100;
        return `<div class="db-metric"><div class="db-label"><code>${esc(x.mount)}</code><b>${fmtBytes(x.used)} / ${fmtBytes(x.size)}</b><span>${pct.toFixed(0)}%</span></div>${bar(pct)}</div>`;
      })
      .join("") || `<div class="files-msg">No disks reported</div>`}
    <div class="db-section">Top processes</div>
    <pre class="db-ps">${esc(d.ps.join("\n"))}</pre>
    <div class="db-foot">Refreshes every 4 s · read over the panel's own SSH connection</div>`;
}
