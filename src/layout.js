// Resizable side panels: drag the handles between sidebar | SFTP | terminal | AI panel.
// Widths are remembered per viewer; double-click a handle to reset it. The terminal area keeps
// a minimum width: when the window is too small, the side panels shrink (without changing the
// saved widths) instead of pushing anything off-screen.

const KEY = "moxie.layout";
const DEFAULTS = { side: 240, files: 330, ai: 400 };
const LIMITS = { side: [170, 420], files: [220, 700], ai: [300, 900] };
const MAIN_MIN = 380;
const RAIL = 48; // collapsed sidebar: icons only

let saved = load();
const app = () => document.getElementById("app");
const isOpen = (panel) =>
  panel === "side"
    ? !document.body.classList.contains("side-collapsed")
    : document.body.classList.contains(`${panel === "files" ? "files" : "ai"}-open`);

function load() {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) ?? "{}") };
  } catch {
    return { ...DEFAULTS };
  }
}

function save() {
  try {
    localStorage.setItem(KEY, JSON.stringify(saved));
  } catch {}
}

const clamp = (v, [lo, hi]) => Math.max(lo, Math.min(hi, Math.round(v)));

/** Effective widths: saved sizes, squeezed if the window can't fit them plus the terminal. */
function effective() {
  const w = {
    side: isOpen("side") ? saved.side : RAIL,
    files: isOpen("files") ? saved.files : 0,
    ai: isOpen("ai") ? saved.ai : 0,
  };
  let excess = w.side + w.files + w.ai + MAIN_MIN - innerWidth;
  for (const k of ["ai", "files", "side"]) {
    if (excess <= 0 || !w[k] || !isOpen(k)) continue;
    const give = Math.min(excess, w[k] - LIMITS[k][0]);
    w[k] -= give;
    excess -= give;
  }
  return w;
}

export function applyLayout() {
  const w = effective();
  const el = app();
  el.style.setProperty("--side-w", `${w.side}px`);
  el.style.setProperty("--files-w", `${w.files}px`);
  el.style.setProperty("--ai-w", `${w.ai}px`);
  const handle = (name, x, show) => {
    const h = document.querySelector(`.splitter[data-panel="${name}"]`);
    h.style.left = `${x - 3}px`;
    h.hidden = !show;
  };
  handle("side", w.side, isOpen("side"));
  handle("files", w.side + w.files, w.files > 0);
  handle("ai", innerWidth - w.ai, w.ai > 0);
}

export function initLayout() {
  for (const panel of ["side", "files", "ai"]) {
    const h = document.createElement("div");
    h.className = "splitter";
    h.dataset.panel = panel;
    h.title = "Drag to resize · double-click to reset";
    h.addEventListener("pointerdown", (e) => startDrag(e, panel));
    h.addEventListener("dblclick", () => {
      saved[panel] = DEFAULTS[panel];
      save();
      applyLayout();
    });
    app().appendChild(h);
  }
  // Panels open/close by toggling body classes; keep the grid and handles in sync.
  new MutationObserver(applyLayout).observe(document.body, { attributes: true, attributeFilter: ["class"] });
  addEventListener("resize", applyLayout);
  applyLayout();
}

function startDrag(e, panel) {
  e.preventDefault();
  const handle = e.currentTarget;
  handle.setPointerCapture(e.pointerId);
  document.body.classList.add("resizing");
  const w = effective();
  const move = (ev) => {
    let size;
    if (panel === "side") size = ev.clientX;
    else if (panel === "files") size = ev.clientX - w.side;
    else size = innerWidth - ev.clientX;
    // Never let a drag squeeze the terminal below its minimum.
    const others = (panel === "side" ? 0 : w.side) + (panel === "files" ? 0 : w.files) + (panel === "ai" ? 0 : w.ai);
    size = Math.min(size, innerWidth - MAIN_MIN - others);
    saved[panel] = clamp(size, LIMITS[panel]);
    applyLayout();
  };
  const up = () => {
    handle.removeEventListener("pointermove", move);
    document.body.classList.remove("resizing");
    save();
  };
  handle.addEventListener("pointermove", move);
  handle.addEventListener("pointerup", up, { once: true });
  handle.addEventListener("pointercancel", up, { once: true });
}
