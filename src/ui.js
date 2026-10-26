// Small shared UI helpers.

/** Context menu at (x, y). items: [label, onClick] pairs; "—" as label draws a separator. */
export function showMenu(items, x, y) {
  const menu = document.getElementById("ctx-menu");
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
  menu.style.left = `${Math.min(x, innerWidth - 230)}px`;
  menu.style.top = `${Math.min(y, innerHeight - menu.offsetHeight - 8)}px`;
}

let toastTimer;
/** Brief message in the status bar. */
export function toast(text, ms = 5000) {
  const el = document.getElementById("status-left");
  if (!el) return;
  el.textContent = text;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => window.dispatchEvent(new Event("moxie:status")), ms);
}
