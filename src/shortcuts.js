// Keyboard shortcut reference (Ctrl+/ or the ⌨ button in the status bar).

export const SHORTCUTS = [
  ["Tabs & panes", [
    ["Ctrl+Shift+T", "New tab"],
    ["Ctrl+Shift+W", "Close pane"],
    ["Ctrl+Shift+D", "Split right"],
    ["Ctrl+Shift+E", "Split down"],
    ["Alt+←/→/↑/↓", "Move between panes"],
    ["Ctrl+Shift+B", "Broadcast typing to all panes in the tab"],
  ]],
  ["Terminal", [
    ["Ctrl+F", "Find in terminal (Enter / Shift+Enter: next / previous)"],
    ["Ctrl+Shift+↑/↓", "Jump to previous / next command"],
    ["Ctrl+Shift+C / V", "Copy / paste"],
    ["Ctrl+click", "Open a link or file path"],
    ["Ctrl+= / Ctrl+-", "Bigger / smaller font"],
  ]],
  ["Autocomplete", [
    ["Tab · ↓/↑ · Esc", "Menu: accept · choose · close"],
    ["→ or End", "Accept the grey inline suggestion"],
    ["Ctrl+Space", "Ask the AI to complete the line"],
  ]],
  ["AI", [
    ["Ctrl+K", "Ask bar: runs commands and shows the answer"],
    ["Shift+Enter (in Ask bar)", "Just type the command at the prompt"],
    ["Ctrl+Shift+A", "Toggle the AI panel"],
  ]],
  ["Panels", [
    ["Ctrl+Shift+F", "SFTP files / server dashboard"],
    ["Ctrl+Shift+S", "Snippets"],
    ["Ctrl+/", "This list"],
  ]],
];

export function openShortcuts() {
  const dlg = document.getElementById("shortcuts-dialog");
  dlg.querySelector(".shortcut-grid").innerHTML = SHORTCUTS.map(
    ([group, rows]) =>
      `<section><h3>${group}</h3>${rows
        .map(([keys, what]) => `<div class="sc-row"><span class="sc-keys">${keys
          .split(" · ")
          .map((k) => k.split(/(?<=\S)\+(?=\S)/).map((p) => `<kbd>${p}</kbd>`).join("+"))
          .join(" · ")}</span><span class="sc-what">${what}</span></div>`)
        .join("")}</section>`,
  ).join("");
  dlg.showModal();
}
