// Auto-update: checks latest.json on the GitHub release, verifies the signed installer,
// installs it and restarts. A pill in the status bar offers the update; nothing installs by itself.
import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

let pending = null;

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

async function installUpdate() {
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
