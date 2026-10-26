// Auto-update: checks latest.json on the GitHub release, verifies the signed installer,
// installs it and restarts. A pill in the status bar offers the update; nothing installs by itself.
import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

let pending = null;
export const getPending = () => pending;

export function initUpdater() {
  setTimeout(() => checkForUpdate(false), 8000);
  setInterval(() => checkForUpdate(false), 6 * 60 * 60 * 1000);
}

/** `manual`: report "up to date" / errors (from the Settings button) instead of staying quiet. */
export async function checkForUpdate(manual) {
  try {
    const update = await check();
    if (!update) {
      if (manual) alert("Moxie is up to date.");
      return;
    }
    pending = update;
    showPill(`⬆ Update to v${update.version}`);
    document.getElementById("open-changelog")?.classList.add("has-update");
    if (!manual) showToast(update);
    if (manual) installUpdate();
  } catch (err) {
    if (manual) alert(`Couldn't check for updates: ${err}`);
  }
}

function showPill(text) {
  const pill = document.getElementById("update-pill");
  pill.textContent = text;
  pill.title = pending?.body ? `What's new:\n${pending.body}` : "Install the new version and restart";
  pill.classList.remove("hidden");
  pill.onclick = installUpdate;
}

/** A card in the corner, once per version ("Later" hides it until the next version). */
function showToast(update) {
  let dismissed = "";
  try { dismissed = localStorage.getItem("moxie-update-dismissed") ?? ""; } catch {}
  if (dismissed === update.version || document.getElementById("update-toast")) return;
  const el = document.createElement("div");
  el.id = "update-toast";
  el.innerHTML = `<div class="ut-title">⬆ Moxie <span></span> is available</div>
    <div class="ut-sub">You have v${__APP_VERSION__}. Updating takes a few seconds and restarts Moxie.</div>
    <div class="ut-actions"><button class="ghost-btn" data-a="later">Later</button><button class="ghost-btn" data-a="notes">What's new</button><button class="primary-btn" data-a="install">Update now</button></div>`;
  el.querySelector(".ut-title span").textContent = `v${update.version}`;
  el.addEventListener("click", (e) => {
    const a = e.target.closest("[data-a]")?.dataset.a;
    if (!a) return;
    if (a === "later") {
      try { localStorage.setItem("moxie-update-dismissed", update.version); } catch {}
      el.remove();
    } else if (a === "notes") {
      el.remove();
      document.getElementById("open-changelog")?.click();
    } else {
      el.remove();
      installUpdate();
    }
  });
  document.body.append(el);
}

export async function installUpdate() {
  if (!pending) return;
  if (!confirm(`Install Moxie v${pending.version} and restart now?\nOpen terminals and SSH sessions will be closed.`)) return;
  const pill = document.getElementById("update-pill");
  pill.onclick = null;
  let total = 0;
  let done = 0;
  try {
    await pending.downloadAndInstall((ev) => {
      if (ev.event === "Started") total = ev.data.contentLength ?? 0;
      else if (ev.event === "Progress") {
        done += ev.data.chunkLength;
        pill.textContent = total ? `⬇ Downloading ${Math.round((done / total) * 100)}%` : "⬇ Downloading…";
      } else if (ev.event === "Finished") pill.textContent = "Installing…";
    });
    await relaunch();
  } catch (err) {
    showPill(`⬆ Update to v${pending.version}`);
    alert(`Update failed: ${err}`);
  }
}
