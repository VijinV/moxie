// Built-in editor (MobaXterm's MobaTextEditor): remote files over the SFTP panel's connection,
// local files from disk. Opens over the terminal area; each file gets a tab with its own undo
// history. Ctrl+S saves straight back; a file changed elsewhere since it was opened isn't
// overwritten without asking. Languages load on demand.
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { EditorView, basicSetup } from "codemirror";
import { EditorState, Compartment } from "@codemirror/state";
import { keymap } from "@codemirror/view";
import { indentWithTab } from "@codemirror/commands";
import { StreamLanguage } from "@codemirror/language";
import { oneDark } from "@codemirror/theme-one-dark";

const $ = (id) => document.getElementById(id);

const docs = []; // { key, name, path, tab (SSH tab) | null, where, state, saved, mtime, crlf, bom }
let current = null;
let view = null;
let hooks = { flash: () => {}, onChange: () => {} };
const lang = new Compartment();
const wrap = new Compartment();
let wrapOn = false;

const legacy = (load) => () => load().then((m) => StreamLanguage.define(Object.values(m)[0]));
const LANGS = [
  [/\.(m?js|cjs|jsx)$/i, () => import("@codemirror/lang-javascript").then((m) => m.javascript({ jsx: true }))],
  [/\.(ts|tsx|mts)$/i, () => import("@codemirror/lang-javascript").then((m) => m.javascript({ typescript: true, jsx: true }))],
  [/\.(json|jsonc|json5)$|^\.(babelrc|eslintrc)$/i, () => import("@codemirror/lang-json").then((m) => m.json())],
  [/\.(py|pyw)$/i, () => import("@codemirror/lang-python").then((m) => m.python())],
  [/\.(html?|vue|svelte)$/i, () => import("@codemirror/lang-html").then((m) => m.html())],
  [/\.(css|scss|less)$/i, () => import("@codemirror/lang-css").then((m) => m.css())],
  [/\.(md|markdown)$/i, () => import("@codemirror/lang-markdown").then((m) => m.markdown())],
  [/\.(ya?ml)$/i, () => import("@codemirror/lang-yaml").then((m) => m.yaml())],
  [/\.sql$/i, () => import("@codemirror/lang-sql").then((m) => m.sql())],
  [/\.(php|phtml)$/i, () => import("@codemirror/lang-php").then((m) => m.php())],
  [/\.rs$/i, () => import("@codemirror/lang-rust").then((m) => m.rust())],
  [/\.(xml|svg|xsd|plist|csproj|config)$/i, () => import("@codemirror/lang-xml").then((m) => m.xml())],
  [/\.(sh|bash|zsh|ksh)$|^\.(bashrc|bash_profile|bash_aliases|profile|zshrc|zprofile)$|^(PKGBUILD)$/i, legacy(() => import("@codemirror/legacy-modes/mode/shell"))],
  [/\.ps1$|\.psm1$/i, legacy(() => import("@codemirror/legacy-modes/mode/powershell"))],
  [/^nginx\.conf$|\/nginx\/.*\.conf$|\/sites-(available|enabled)\//i, legacy(() => import("@codemirror/legacy-modes/mode/nginx"))],
  [/^dockerfile$|\.dockerfile$/i, legacy(() => import("@codemirror/legacy-modes/mode/dockerfile"))],
  [/\.toml$/i, legacy(() => import("@codemirror/legacy-modes/mode/toml"))],
  [/\.(ini|conf|cfg|cnf|properties|env)$|^\.env(\..*)?$|^\.(gitconfig|editorconfig)$/i, legacy(() => import("@codemirror/legacy-modes/mode/properties"))],
  [/\.go$/i, legacy(() => import("@codemirror/legacy-modes/mode/go"))],
  [/\.rb$|^Gemfile$/i, legacy(() => import("@codemirror/legacy-modes/mode/ruby"))],
  [/\.lua$/i, legacy(() => import("@codemirror/legacy-modes/mode/lua"))],
  [/\.(pl|pm)$/i, legacy(() => import("@codemirror/legacy-modes/mode/perl"))],
];
const langLabel = (name) => (name.match(/\.([^.]+)$/)?.[1] ?? "text").toLowerCase();

const theme = EditorView.theme({
  "&": { height: "100%", backgroundColor: "var(--bg)" },
  ".cm-scroller": { fontFamily: "var(--mono)", fontSize: "13px", lineHeight: "1.5" },
  ".cm-gutters": { backgroundColor: "var(--bg)", borderRight: "1px solid var(--border)" },
  "&.cm-focused": { outline: "none" },
});

function newState(text) {
  return EditorState.create({
    doc: text,
    extensions: [
      basicSetup,
      keymap.of([indentWithTab, { key: "Mod-s", run: () => (save(current), true), preventDefault: true }]),
      oneDark,
      theme,
      lang.of([]),
      wrap.of(wrapOn ? EditorView.lineWrapping : []),
      EditorView.updateListener.of((u) => u.docChanged && renderTabs()),
    ],
  });
}

export function initEditor(h) {
  hooks = { ...hooks, ...h };
  view = new EditorView({ parent: $("ed-host"), state: newState("") });
  $("editor-btn").addEventListener("click", () => toggleEditor());
  $("ed-hide").addEventListener("click", () => toggleEditor(false));
  $("ed-save").addEventListener("click", () => save(current));
  $("ed-open").addEventListener("click", openLocalDialog);
  $("ed-empty-open").addEventListener("click", openLocalDialog);
  $("ed-wrap").addEventListener("click", () => {
    wrapOn = !wrapOn;
    $("ed-wrap").classList.toggle("on", wrapOn);
    view.dispatch({ effects: wrap.reconfigure(wrapOn ? EditorView.lineWrapping : []) });
  });
  renderTabs();
}

export const editorOpen = () => document.body.classList.contains("editor-open");

export function toggleEditor(force) {
  const on = document.body.classList.toggle("editor-open", force);
  $("editor-btn").classList.toggle("active", on);
  if (on && current) view.focus();
  hooks.onChange(on);
}

const isDirty = (d) => d !== current ? !d.state.doc.eq(d.saved) : !view.state.doc.eq(d.saved);

/** `tab`: the SSH tab whose SFTP connection to use (null for a local file). */
export async function openInEditor(tab, path) {
  const key = `${tab ? tab.spec.ssh.host + ":" + (tab.spec.ssh.port ?? 22) : "local"}|${path}`;
  const existing = docs.find((d) => d.key === key);
  if (existing) return activate(existing), toggleEditor(true);
  const connId = tab ? tab.files?.connId : null;
  if (tab && tab.files?.status !== "ready") return hooks.flash("Open the Files panel first (Ctrl+Shift+F): the editor uses its connection.");
  let f;
  try {
    f = await invoke("editor_read", { connId, path });
  } catch (err) {
    const e = String(err);
    if (e === "BINARY") return { binary: true };
    if (e.startsWith("TOO_LARGE:")) return { tooLarge: Number(e.slice(10)) };
    hooks.flash(`Couldn't open ${path}: ${e}`);
    return { error: e };
  }
  const name = path.split(/[\\/]/).pop();
  const doc = {
    key,
    name,
    path,
    tab,
    where: tab ? tab.spec.ssh.label ?? tab.spec.ssh.host : "this PC",
    state: newState(f.text),
    saved: null,
    mtime: f.mtime,
    crlf: f.crlf,
    bom: f.bom,
  };
  doc.saved = doc.state.doc;
  docs.push(doc);
  activate(doc);
  toggleEditor(true);
  const match = LANGS.find(([re]) => re.test(name) || re.test(path));
  if (match) {
    match[1]().then((ext) => {
      // Apply to the stored state, or to the live view if this doc is showing.
      if (current === doc) view.dispatch({ effects: lang.reconfigure(ext) });
      else doc.state = doc.state.update({ effects: lang.reconfigure(ext) }).state;
    }).catch(() => {});
  }
  return { ok: true };
}

function activate(doc) {
  if (current && current !== doc) current.state = view.state;
  current = doc;
  view.setState(doc.state);
  view.dispatch({ effects: wrap.reconfigure(wrapOn ? EditorView.lineWrapping : []) });
  renderTabs();
  view.focus();
}

async function save(doc, force = false) {
  if (!doc) return;
  if (doc === current) doc.state = view.state;
  const connId = doc.tab ? doc.tab.files?.connId : null;
  if (doc.tab && doc.tab.files?.status !== "ready") {
    return hooks.flash(`Can't save ${doc.name}: the connection to ${doc.where} is closed. Reopen the session and its Files panel, then save again.`);
  }
  const text = doc.state.doc.toString();
  try {
    doc.mtime = await invoke("editor_write", {
      connId,
      path: doc.path,
      text,
      crlf: doc.crlf,
      bom: doc.bom,
      expectMtime: force ? null : doc.mtime,
    });
  } catch (err) {
    if (String(err) === "CHANGED") {
      if (confirm(`${doc.name} was changed on ${doc.where} after you opened it.\n\nOverwrite it with your version?`)) return save(doc, true);
      return;
    }
    return hooks.flash(`Couldn't save ${doc.name}: ${err}`);
  }
  doc.saved = doc.state.doc;
  renderTabs();
  hooks.flash(`✓ Saved ${doc.name}${doc.tab ? ` to ${doc.where}` : ""}`);
}

function closeDoc(doc) {
  if (isDirty(doc) && !confirm(`${doc.name} has unsaved changes. Close it anyway?`)) return;
  const i = docs.indexOf(doc);
  docs.splice(i, 1);
  if (current === doc) {
    current = null;
    const next = docs[i] ?? docs[i - 1];
    if (next) activate(next);
    else view.setState(newState(""));
  }
  renderTabs();
}

async function openLocalDialog() {
  const path = await openDialog({ multiple: false, directory: false });
  if (!path) return;
  const r = await openInEditor(null, path);
  if (r?.binary) hooks.flash("That file isn't text, so it can't be edited here.");
  if (r?.tooLarge) hooks.flash(`That file is ${(r.tooLarge / 1048576).toFixed(1)} MB; the editor opens files up to 5 MB.`);
}

function renderTabs() {
  const box = $("ed-tabs");
  box.innerHTML = "";
  for (const d of docs) {
    const b = document.createElement("div");
    b.className = "ed-tab" + (d === current ? " active" : "") + (isDirty(d) ? " dirty" : "");
    b.title = `${d.path} (${d.where})`;
    b.innerHTML = `<span class="ed-name"></span><span class="ed-dot">●</span><button class="ed-x" title="Close">×</button>`;
    b.querySelector(".ed-name").textContent = d.name;
    b.addEventListener("mousedown", (e) => {
      if (e.button === 1) return e.preventDefault(), closeDoc(d);
      if (!e.target.closest(".ed-x")) activate(d);
    });
    b.querySelector(".ed-x").addEventListener("click", () => closeDoc(d));
    box.append(b);
  }
  const has = !!current;
  $("ed-empty").classList.toggle("hidden", has);
  $("ed-host").classList.toggle("hidden", !has);
  $("ed-save").disabled = !has;
  $("ed-info").textContent = has
    ? `${current.where} · ${current.path} · ${langLabel(current.name)}${current.crlf ? " · CRLF" : ""}`
    : "";
  const dirty = docs.filter(isDirty).length;
  $("editor-btn").querySelector(".badge").textContent = dirty ? String(dirty) : docs.length ? String(docs.length) : "";
  $("editor-btn").classList.toggle("has-dirty", dirty > 0);
}

/** Unsaved files, for a warning before the window or an SSH tab closes. */
export const unsavedCount = () => docs.filter(isDirty).length;
