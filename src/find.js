// Find in terminal (Ctrl+F): highlights every match in the active pane, Enter / Shift+Enter to step.
import { activeTab } from "./terminal.js";

const $ = (id) => document.getElementById(id);
const DECOR = {
  matchBackground: "#5b4a1e",
  matchBorder: "#e0af68",
  matchOverviewRuler: "#e0af68",
  activeMatchBackground: "#a78bfa",
  activeMatchBorder: "#ffffff",
  activeMatchColorOverviewRuler: "#a78bfa",
};
const hooked = new WeakSet();

function options() {
  return { caseSensitive: $("find-case").classList.contains("on"), regex: $("find-regex").classList.contains("on"), decorations: DECOR };
}

function run(dir) {
  const pane = activeTab();
  const q = $("find-input").value;
  if (!pane) return;
  if (!hooked.has(pane.search)) {
    hooked.add(pane.search);
    pane.search.onDidChangeResults(({ resultIndex, resultCount }) => {
      if (pane !== activeTab()) return;
      $("find-count").textContent = resultCount ? `${resultIndex + 1} of ${resultCount}` : "No results";
    });
  }
  if (!q) {
    pane.search.clearDecorations();
    $("find-count").textContent = "";
    return;
  }
  try {
    if (dir < 0) pane.search.findPrevious(q, options());
    else pane.search.findNext(q, { ...options(), incremental: dir === 0 });
  } catch {
    $("find-count").textContent = "Invalid pattern";
  }
}

export function initFind() {
  const input = $("find-input");
  input.addEventListener("input", () => run(0));
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") (e.preventDefault(), run(e.shiftKey ? -1 : 1));
    if (e.key === "Escape") closeFind();
  });
  $("find-prev").addEventListener("click", () => run(-1));
  $("find-next").addEventListener("click", () => run(1));
  $("find-close").addEventListener("click", closeFind);
  for (const id of ["find-case", "find-regex"]) {
    $(id).addEventListener("click", () => {
      $(id).classList.toggle("on");
      run(0);
    });
  }
}

export function openFind() {
  const pane = activeTab();
  if (!pane) return;
  $("find-bar").classList.remove("hidden");
  const sel = pane.term.getSelection();
  if (sel && !sel.includes("\n")) $("find-input").value = sel;
  $("find-input").select();
  $("find-input").focus();
  run(0);
}

export function closeFind() {
  $("find-bar").classList.add("hidden");
  const pane = activeTab();
  pane?.search.clearDecorations();
  pane?.term.focus();
}
