// Shell integration: the shell marks prompt / command / output boundaries with the standard
// escape sequences (OSC 133 A/B/C/D, OSC 7 for the current folder; same as VS Code, Windows
// Terminal and Warp), plus a Moxie OSC 7777 for "info" (OS, shell, user, host).
// That gives exact command blocks with exit codes, which the agent, error detection,
// autocomplete and the AI's server context build on.
//
// PowerShell gets the script at startup (-EncodedCommand: no profile edits, no execution-policy
// prompt). bash/zsh — Git Bash, WSL and remote SSH servers — get a one-line hook typed at the
// first prompt; its echo is hidden. cmd.exe has no hook mechanism and stays unintegrated.

const E = "\x1b";
const BEL = "\x07";

const POWERSHELL_SCRIPT = String.raw`
if (-not $global:__moxieSI) {
  $global:__moxieSI = $true
  try { Set-PSReadLineOption -PredictionSource None -ErrorAction Stop } catch {}
  $global:__mxE = [char]27; $global:__mxB = [char]7
  $global:__mxOrigPrompt = $function:prompt
  $global:__mxFirst = $true
  function global:prompt {
    $ok = $?; $code = $global:LASTEXITCODE
    $e = $global:__mxE; $b = $global:__mxB; $out = ''
    if (-not $global:__mxFirst) {
      $exit = if ($ok) { 0 } elseif ($code) { $code } else { 1 }
      $out += "$e]133;D;$exit$b"
    }
    $global:__mxFirst = $false
    $loc = $executionContext.SessionState.Path.CurrentLocation
    if ($loc.Provider.Name -eq 'FileSystem') { $out += "$e]7;file://localhost/$($loc.ProviderPath -replace '\\','/')$b" }
    $p = & $global:__mxOrigPrompt
    $global:LASTEXITCODE = $code
    "$out$e]133;A$b$p$e]133;B$b"
  }
  if (Get-Module PSReadLine) {
    Set-PSReadLineKeyHandler -Chord Enter -ScriptBlock {
      [Console]::Write("$($global:__mxE)]133;C$($global:__mxB)")
      [Microsoft.PowerShell.PSConsoleReadLine]::AcceptLine()
    }
  }
  $nt = Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion' -ErrorAction SilentlyContinue
  $osName = if ([int]$nt.CurrentBuild -ge 22000) { 'Windows 11' } else { 'Windows 10' }
  $os = "$osName $($nt.DisplayVersion) (build $($nt.CurrentBuild))"
  $sh = "PowerShell $($PSVersionTable.PSVersion)"
  [Console]::Write("$($global:__mxE)]7777;info;os=$os;shell=$sh;user=$env:USERNAME;host=$env:COMPUTERNAME$($global:__mxB)")
}
`;

// Must stay valid in both bash and zsh, and be safe to eval twice.
const POSIX_SNIPPET = String.raw`
if [ -z "$__MOXIE_SI" ]; then
__MOXIE_SI=1
if [ -n "$ZSH_VERSION" ]; then
  __moxie_precmd() { local c=$?; printf '\033]133;D;%s\007\033]7;file://%s%s\007' "$c" "$HOST" "$PWD"; }
  __moxie_preexec() { printf '\033]133;C\007'; }
  precmd_functions=(__moxie_precmd $precmd_functions)
  preexec_functions=($preexec_functions __moxie_preexec)
  PS1=$'%{\e]133;A\a%}'"$PS1"$'%{\e]133;B\a%}'
  __mx_sh="zsh $ZSH_VERSION"
else
  __moxie_prompt() { local c=$?; printf '\033]133;D;%s\007\033]7;file://%s%s\007' "$c" "$HOSTNAME" "$PWD"; return $c; }
  if [ -n "$MOXIE_SI_INIT" ]; then
    # Started via environment (local Git Bash / WSL): replace the bootstrap PROMPT_COMMAND.
    # Un-export it, or a bash started inside this one would inherit a hook it doesn't have.
    PROMPT_COMMAND=__moxie_prompt; export -n PROMPT_COMMAND; unset MOXIE_SI_INIT
  else
    # Typed at the prompt (SSH): chain onto the user's own PROMPT_COMMAND, drop our line from history.
    PROMPT_COMMAND="__moxie_prompt${"${"}PROMPT_COMMAND:+;$PROMPT_COMMAND}"
    history -d -1 2>/dev/null
  fi
  PS1='\[\033]133;A\007\]'"$PS1"'\[\033]133;B\007\]'
  PS0=$'\033]133;C\007'
  __mx_sh="bash $BASH_VERSION"
fi
__mx_os="$( (. /etc/os-release 2>/dev/null && printf %s "$PRETTY_NAME") )"
[ -z "$__mx_os" ] && __mx_os="$(uname -sr 2>/dev/null)"
printf '\033]7777;info;os=%s;shell=%s;user=%s;host=%s\007' "$(printf %s "$__mx_os" | tr ';' ',')" "$__mx_sh" "$(id -un 2>/dev/null || whoami)" "$(hostname 2>/dev/null || uname -n)"
unset __mx_os __mx_sh
fi
printf '\033]7777;ready\007'
`;

const utf16Base64 = (s) => {
  const bytes = new Uint8Array(s.length * 2);
  for (let i = 0; i < s.length; i++) {
    bytes[i * 2] = s.charCodeAt(i) & 0xff;
    bytes[i * 2 + 1] = s.charCodeAt(i) >> 8;
  }
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
};
const utf8Base64 = (s) => btoa(unescape(encodeURIComponent(s)));

/** Extra args that load the integration script into a PowerShell started with -NoExit. */
export const powershellIntegrationArgs = () => ["-EncodedCommand", utf16Base64(POWERSHELL_SCRIPT)];

const compactSnippet = () => POSIX_SNIPPET.split("\n").map((l) => l.trim()).filter(Boolean).join("\n");

/**
 * Local bash (Git Bash, WSL): hand the hook over in the environment so nothing is typed. bash runs
 * PROMPT_COMMAND before its first prompt, which evals the hook (and the hook then replaces it).
 */
export function bashIntegrationEnv(wsl) {
  const env = { MOXIE_SI_INIT: compactSnippet(), PROMPT_COMMAND: 'eval "$MOXIE_SI_INIT"' };
  if (wsl) env.WSLENV = "MOXIE_SI_INIT/u:PROMPT_COMMAND/u"; // forward them into the Linux side
  return env;
}

// Leading space: kept out of history where HISTCONTROL ignores it (the snippet also deletes it).
// Kept short: the server echoes every character before running it.
const injectionLine = () => {
  const b64 = utf8Base64(compactSnippet());
  return ` __m=${b64};eval "$( (echo $__m|base64 -d)2>/dev/null||echo $__m|base64 -D)";unset __m\r`;
};

// ------------------------------------------------------------------ per-tab state

let hooks = {};
export function initShellIntegration(h) {
  hooks = h;
}

/**
 * tab.si = {
 *   active: shell has sent markers; phase: "prompt" | "input" | "running" | "idle";
 *   input: { marker, x } where typed input starts; current: the running command;
 *   blocks: finished commands; cwd; info: { os, shell, user, host }; inject: injection state
 * }
 */
export function setupShellIntegration(tab, mode) {
  const t = tab.term;
  tab.si = { active: false, phase: "idle", input: null, current: null, blocks: [], cwd: null, info: null, inject: null };
  if (mode === "inject") tab.si.inject = { state: "waiting", started: Date.now(), buffer: "", timer: null };
  t.parser.registerOscHandler(133, (data) => (on133(tab, data), true));
  t.parser.registerOscHandler(7, (data) => {
    const m = data.match(/^file:\/\/[^/]*(\/.*)$/);
    if (m) {
      let p = decodeURIComponent(m[1]);
      if (/^\/[A-Za-z]:\//.test(p)) p = p.slice(1).replace(/\//g, "\\"); // Windows path
      tab.si.cwd = p;
    }
    return true;
  });
  t.parser.registerOscHandler(7777, (data) => {
    if (data.startsWith("info;")) {
      tab.si.info = Object.fromEntries(
        data.slice(5).split(";").map((kv) => [kv.slice(0, kv.indexOf("=")), kv.slice(kv.indexOf("=") + 1)]),
      );
      hooks.onInfo?.(tab);
    }
    return true;
  });
}

function on133(tab, data) {
  const si = tab.si;
  const t = tab.term;
  const [code, arg] = data.split(";");
  si.active = true;
  if (code === "A") {
    si.phase = "prompt";
    si.promptMarker = t.registerMarker(0);
  } else if (code === "B") {
    si.phase = "input";
    si.input = { marker: t.registerMarker(0), x: t.buffer.active.cursorX };
  } else if (code === "C") {
    const cmd = si.input ? readInput(tab, si.input, true) : "";
    si.phase = "running";
    si.current = { cmd, promptMarker: si.promptMarker, outMarker: t.registerMarker(0), started: Date.now() };
    hooks.onCommandStart?.(tab, si.current);
  } else if (code === "D") {
    const cur = si.current;
    si.current = null;
    si.phase = "idle";
    if (!cur || !cur.cmd.trim()) return;
    const block = { ...cur, exit: Number(arg ?? 0) || 0, endMarker: t.registerMarker(0), ended: Date.now() };
    si.blocks.push(block);
    if (si.blocks.length > 500) si.blocks.shift().promptMarker?.dispose();
    decorate(tab, block);
    for (const fn of si.waiters ?? []) fn(block);
    si.waiters = [];
    hooks.onCommandDone?.(tab, block);
  }
}

/** Text typed at the prompt, read straight from the screen (exact, unlike keystroke tracking). */
function readInput(tab, input, toEndOfLine = false) {
  const buf = tab.term.buffer.active;
  const start = input.marker.line;
  if (start < 0) return "";
  const end = Math.max(start, buf.baseY + buf.cursorY);
  let text = "";
  for (let y = start; y <= end; y++) {
    const line = buf.getLine(y);
    if (!line) break;
    if (y > start && !line.isWrapped) {
      // bash prints PS0 after the newline; anything past the input's last row isn't input.
      if (toEndOfLine) break;
      text += "\n";
    }
    text += line.translateToString(true, y === start ? input.x : 0);
  }
  return text.replace(/\s+$/, "");
}

/** The current prompt input, or null when the shell isn't integrated / not at a prompt. */
export function currentInput(tab) {
  if (!tab.si?.active || tab.si.phase !== "input" || !tab.si.input) return null;
  if (tab.term.buffer.active.type !== "normal") return null;
  return readInput(tab, tab.si.input);
}

export function blockOutput(tab, block) {
  const buf = tab.term.buffer.active;
  const from = block.outMarker.line;
  const to = block.endMarker.line - 1;
  if (from < 0) return "(output scrolled out of the buffer)";
  const lines = [];
  for (let y = from; y <= to; y++) lines.push(buf.getLine(y)?.translateToString(true) ?? "");
  return lines.join("\n").replace(/\n+$/, "");
}

/** Resolves with the next finished command block (used by the agent). */
export function nextBlock(tab) {
  return new Promise((resolve) => (tab.si.waiters ??= []).push(resolve));
}

// ------------------------------------------------------------------ block gutter + menu

function decorate(tab, block) {
  const start = block.promptMarker ?? block.outMarker;
  const rows = Math.max(1, block.endMarker.line - start.line);
  const deco = tab.term.registerDecoration({ marker: start, x: 0, width: 1, height: rows, layer: "top" });
  if (!deco) return;
  block.decoration = deco;
  deco.onRender((el) => {
    if (el.dataset.ready) return;
    el.dataset.ready = "1";
    el.classList.add("moxie-block", block.exit === 0 ? "ok" : "fail"); // keep xterm's own positioning class
    el.title = `${block.cmd}\nexit ${block.exit} · ${((block.ended - block.started) / 1000).toFixed(1)}s · click for options`;
    el.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      hooks.onBlockMenu?.(tab, block, e.clientX, e.clientY);
    });
  });
}

// ------------------------------------------------------------------ bash/zsh hook injection

const PROMPT_RE = /([$#%>] ?|❯ ?)$/;

/**
 * Called with every chunk of PTY output before it is written to xterm. Returns what to write.
 * While the hook line is being typed, output is held back and dropped up to the "ready" marker,
 * so the user never sees it.
 */
export function filterOutput(tab, data) {
  const inj = tab.si?.inject;
  if (!inj || inj.state === "done") return data;

  if (inj.state === "injecting") {
    inj.buffer += data;
    // Never hide what the user is typing: if they start typing, show everything right away.
    if ((tab.lastKey ?? 0) > inj.at) {
      const held = inj.buffer;
      finishInjection(tab);
      return held;
    }
    const i = inj.buffer.indexOf(`${E}]7777;ready${BEL}`);
    if (i >= 0) {
      const hidden = inj.buffer.slice(0, i);
      const rest = inj.buffer.slice(i + `${E}]7777;ready${BEL}`.length);
      finishInjection(tab);
      // Keep the invisible status sequences the hook printed (OS/shell info, folder); drop the echo.
      const status = hidden.match(/\x1b\](?:7777;info|7);[^\x07]*\x07/g) ?? [];
      // The echo (and its newline) were swallowed: clear the old prompt line, the new one replaces it.
      return status.join("") + `\r${E}[2K` + rest;
    }
    return "";
  }

  // "waiting": look for the first prompt, then inject once output settles.
  clearTimeout(inj.timer);
  if (Date.now() - inj.started > 60000 || tab.si.active) {
    inj.state = "done";
    return data;
  }
  inj.timer = setTimeout(() => maybeInject(tab), 450);
  return data;
}

function maybeInject(tab) {
  const inj = tab.si.inject;
  if (!inj || inj.state !== "waiting" || tab.exited || tab.si.active) return;
  // Read the screen, not the byte stream: ConPTY often repaints with cursor moves instead of text.
  const buf = tab.term.buffer.active;
  const beforeCursor = buf.getLine(buf.baseY + buf.cursorY)?.translateToString(false, 0, buf.cursorX) ?? "";
  if (!PROMPT_RE.test(beforeCursor)) return;
  const typedRecently = Date.now() - (tab.lastKey ?? 0) < 1500;
  if (typedRecently || (tab.line && tab.line.length)) {
    inj.timer = setTimeout(() => maybeInject(tab), 1000); // at a prompt but busy typing: try again
    return;
  }
  inj.state = "injecting";
  inj.buffer = "";
  inj.at = Date.now();
  // Small chunks: Git Bash (MSYS on ConPTY) drops input written in one large burst.
  const line = injectionLine();
  for (let i = 0, k = 0; i < line.length; i += 128, k++) {
    setTimeout(() => hooks.write(tab, line.slice(i, i + 128)), k * 15);
  }
  // Not bash/zsh after all (fish, a router…): give up and show whatever came back.
  inj.timer = setTimeout(() => {
    if (inj.state !== "injecting") return;
    const held = inj.buffer;
    finishInjection(tab);
    tab.term.write(held);
  }, 10000);
}

function finishInjection(tab) {
  const inj = tab.si.inject;
  clearTimeout(inj.timer);
  inj.state = "done";
  inj.buffer = "";
}
