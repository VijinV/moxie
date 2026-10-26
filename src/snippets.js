// Saved snippets and workflows (sidebar). A snippet is one or more commands with optional
// {{name}} / {{name:default}} placeholders; a workflow runs line by line, waits for each command
// to finish (exit code from shell integration) and stops at the first failure.
import { invoke } from "@tauri-apps/api/core";
import { activeTab, sendText } from "./terminal.js";
import { nextBlock } from "./shell.js";

const $ = (id) => document.getElementById(id);
const PLACEHOLDER = /\{\{\s*([\w-]+)(?::([^}]*))?\s*\}\}/g;
let snippets = [];
let status = () => {};

export async function initSnippets(opts) {
  status = opts.setStatus;
  try {
    snippets = await invoke("snippets_get");
  } catch {
    snippets = [];
  }
  render();
  $("add-snippet").addEventListener("click", () => openSnippetEditor());
  $("snippet-filter").addEventListener("input", render);
  $("snippet-dialog").addEventListener("close", saveFromDialog);
  $("snippet-run-form").addEventListener("input", preview);
}

const save = () => invoke("snippets_save", { snippets });

function render() {
  const ul = $("snippet-list");
  const q = $("snippet-filter").value.toLowerCase();
  const list = snippets.filter((s) => `${s.name} ${s.command} ${s.folder ?? ""} ${s.description ?? ""}`.toLowerCase().includes(q));
  ul.innerHTML = "";
  if (!list.length) {
    ul.innerHTML = `<li class="muted small">${snippets.length ? "No matches" : "No snippets yet · + to add, or “Save as snippet” on a command"}</li>`;
    return;
  }
  const byFolder = new Map();
  for (const s of list) {
    const f = s.folder?.trim() || "";
    if (!byFolder.has(f)) byFolder.set(f, []);
    byFolder.get(f).push(s);
  }
  for (const folder of [...byFolder.keys()].sort((a, b) => (a === "") - (b === "") || a.localeCompare(b))) {
    if (folder) ul.insertAdjacentHTML("beforeend", `<li class="folder-row snippet-folder"><span class="item-icon">▾</span><span class="item-label"></span></li>`);
    if (folder) ul.lastElementChild.querySelector(".item-label").textContent = folder;
    for (const s of byFolder.get(folder).sort((a, b) => a.name.localeCompare(b.name))) {
      const li = document.createElement("li");
      if (folder) li.classList.add("in-folder");
      li.innerHTML = `<span class="item-icon">${s.workflow ? "⚙" : "⌁"}</span><span class="item-label"></span><span class="item-actions"><button title="Edit">✎</button><button title="Delete">×</button></span>`;
      li.querySelector(".item-label").textContent = s.name;
      li.title = `${s.description ? s.description + "\n\n" : ""}${s.command}`;
      li.addEventListener("click", () => runSnippet(s));
      const [edit, del] = li.querySelectorAll(".item-actions button");
      edit.addEventListener("click", (e) => (e.stopPropagation(), openSnippetEditor(s)));
      del.addEventListener("click", async (e) => {
        e.stopPropagation();
        if (!confirm(`Delete snippet "${s.name}"?`)) return;
        snippets = snippets.filter((x) => x.id !== s.id);
        await save();
        render();
      });
      ul.appendChild(li);
    }
  }
}

/** New snippet, editing one, or prefilled from a command (block menu → Save as snippet). */
export function openSnippetEditor(s = null) {
  const f = $("snippet-form").elements;
  $("snippet-form").reset();
  const v = typeof s === "string" ? { command: s, name: s.split(/\s+/).slice(0, 3).join(" ") } : s ?? {};
  for (const k of ["id", "name", "folder", "command", "description"]) f[k].value = v[k] ?? "";
  f.workflow.checked = !!v.workflow;
  $("snippet-dialog").showModal();
  f.name.select();
}

async function saveFromDialog() {
  if ($("snippet-dialog").returnValue !== "save") return;
  const f = $("snippet-form").elements;
  const s = {
    id: f.id.value || crypto.randomUUID(),
    name: f.name.value.trim(),
    folder: f.folder.value.trim(),
    command: f.command.value.replace(/\s+$/, ""),
    description: f.description.value.trim(),
    workflow: f.workflow.checked,
  };
  if (!s.name || !s.command) return;
  const i = snippets.findIndex((x) => x.id === s.id);
  if (i >= 0) snippets[i] = s;
  else snippets.push(s);
  await save();
  render();
  status(`Saved snippet "${s.name}"`);
}

// ------------------------------------------------------------------ running

let running = null; // the snippet in the run dialog

function fill(command, values) {
  return command.replace(PLACEHOLDER, (_, name, def) => values[name] ?? def ?? "");
}

function fieldValues() {
  const values = {};
  for (const el of $("snippet-fields").querySelectorAll("input")) values[el.name] = el.value;
  return values;
}

function preview() {
  if (running) $("snippet-preview").textContent = fill(running.command, fieldValues());
}

export function runSnippet(s) {
  if (!activeTab()) return status("Open a terminal first.");
  running = s;
  const fields = new Map();
  for (const m of s.command.matchAll(PLACEHOLDER)) if (!fields.has(m[1])) fields.set(m[1], m[2] ?? "");
  $("snippet-run-title").textContent = `${s.workflow ? "⚙ Workflow" : "⌁ Snippet"}: ${s.name}`;
  $("snippet-fields").innerHTML = [...fields]
    .map(([name]) => `<label>${name} <input name="${name}" spellcheck="false" /></label>`)
    .join("");
  for (const [name, def] of fields) $("snippet-fields").querySelector(`input[name="${name}"]`).value = def;
  preview();
  const dlg = $("snippet-run-dialog");
  dlg.querySelector('button[value="insert"]').hidden = !!s.workflow;
  dlg.showModal();
  dlg.querySelector("input")?.select();
  dlg.addEventListener(
    "close",
    () => {
      if (dlg.returnValue !== "run" && dlg.returnValue !== "insert") return;
      const text = fill(s.command, fieldValues());
      const tab = activeTab();
      if (s.workflow) runWorkflow(tab, s.name, text);
      else sendText(tab, text, dlg.returnValue === "run");
    },
    { once: true },
  );
}

async function runWorkflow(tab, name, text) {
  const lines = text.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
  if (!tab.si?.active) {
    // Without shell integration we can't see exit codes: send the lines and let the shell run them.
    status(`⚙ ${name}: this shell has no command tracking, so lines run without stop-on-error`);
    sendText(tab, lines.join("\n"), true);
    return;
  }
  for (let i = 0; i < lines.length; i++) {
    status(`⚙ ${name}: step ${i + 1}/${lines.length} · ${lines[i]}`);
    const done = nextBlock(tab);
    sendText(tab, lines[i], true);
    const block = await done;
    if (block.exit !== 0) return status(`⚙ ${name}: stopped at step ${i + 1} (${lines[i]}) — exit ${block.exit}`);
  }
  status(`⚙ ${name}: all ${lines.length} steps finished ✓`);
}

export function focusSnippets() {
  $("snippet-filter").focus();
}
