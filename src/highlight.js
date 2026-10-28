// Terminal output highlighting (MobaXterm-style): colours file names by type, paths, URLs, IP
// addresses, timestamps and words like error / warning / ok in plain output.
//
// Only text the program left in the default colour is touched: anything it coloured itself, and
// everything while a full-screen app (vim, htop, less) is on the alternate screen, passes through
// unchanged. Escape sequences (CSI, OSC — including shell-integration markers) are never split or
// altered; a sequence cut off at the end of a chunk waits for the next one.
import { fileKind, KIND_COLORS } from "./filetypes.js";

let enabled = true;
export const setHighlight = (on) => (enabled = !!on);

const fg = (hex) => `\x1b[38;2;${parseInt(hex.slice(1, 3), 16)};${parseInt(hex.slice(3, 5), 16)};${parseInt(hex.slice(5, 7), 16)}m`;
const RESET_FG = "\x1b[39m";
const C = {
  url: fg("#7aa2f7"),
  path: fg("#7aa2f7"),
  ip: fg("#2ac3de"),
  time: fg("#737aa2"),
  bad: fg("#f7768e"),
  warn: fg("#e0af68"),
  good: fg("#9ece6a"),
};
const KIND = Object.fromEntries(Object.entries(KIND_COLORS).map(([k, v]) => [k, fg(v)]));

const RE = new RegExp(
  [
    String.raw`(?<url>\bhttps?:\/\/[^\s"'<>()\x1b]+)`,
    String.raw`(?<time>\b\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?::\d{2}(?:[.,]\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?\b|\b\d{2}:\d{2}:\d{2}\b)`,
    String.raw`(?<ip>\b(?:\d{1,3}\.){3}\d{1,3}(?:\/\d{1,2}|:\d{1,5})?\b)`,
    String.raw`(?<path>(?<![\w\/])(?:~|\.{1,2})?\/(?:[\w.@+-]+\/)*[\w.@+-]*|\b[A-Za-z]:\\(?:[\w .@+-]+\\)*[\w.@+-]*)`,
    String.raw`(?<file>\b[\w@+-][\w.@+-]*\.[A-Za-z][\w]{0,7}\b)`,
    String.raw`(?<bad>\b(?:error|errors|failed|failure|fatal|exception|denied|refused|panic|critical|unreachable|not found)\b)`,
    String.raw`(?<warn>\b(?:warn|warning|warnings|deprecated|timeout|timed out)\b)`,
    String.raw`(?<good>\b(?:ok|success|successful|succeeded|passed|done|active \(running\))\b)`,
  ].join("|"),
  "gi",
);

function colorText(text) {
  return text.replace(RE, (m, ...args) => {
    const g = args.at(-1);
    let color;
    if (g.url) color = C.url;
    else if (g.time) color = C.time;
    else if (g.ip) color = /^\d+(\.\d+){3}/.test(m) && m.split(/[./:]/).slice(0, 4).every((n) => +n <= 255) ? C.ip : null;
    else if (g.path) color = m.length > 1 ? C.path : null;
    else if (g.file) {
      const kind = fileKind(m);
      color = kind ? KIND[kind] : null;
    } else if (g.bad) color = C.bad;
    else if (g.warn) color = C.warn;
    else if (g.good) color = C.good;
    return color ? color + m + RESET_FG : m;
  });
}

// ESC [ … final | ESC ] … (BEL | ESC \) | ESC P/X/^/_ … ESC \ | ESC (intermediates) final, e.g. ESC ( B, ESC 7
const ESC_RE = /\x1b(?:\[[0-?]*[ -\/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[PX^_][^\x1b]*\x1b\\|(?![\[\]PX^_])[ -\/]*[0-~])/y;

/** Returns `data` with highlighting added (or unchanged). Keeps per-pane state on `pane.hl`. */
export function highlight(pane, data) {
  if (!data) return data;
  const st = (pane.hl ??= { carry: "", colored: false });
  let s = st.carry + data;
  st.carry = "";
  if (!enabled || pane.term.buffer.active.type === "alternate" || pane.spec?.kind === "agent") {
    trackSgr(st, s);
    return s;
  }
  let out = "";
  let i = 0;
  let text = "";
  const flush = () => {
    if (text) out += st.colored ? text : colorText(text);
    text = "";
  };
  while (i < s.length) {
    const esc = s.indexOf("\x1b", i);
    if (esc < 0) {
      text += s.slice(i);
      break;
    }
    text += s.slice(i, esc);
    ESC_RE.lastIndex = esc;
    const m = ESC_RE.exec(s);
    if (!m) {
      // Incomplete sequence at the end: keep it for the next chunk (unless it's clearly bogus).
      if (s.length - esc < 4096) {
        flush();
        st.carry = s.slice(esc);
        return out;
      }
      text += s[esc];
      i = esc + 1;
      continue;
    }
    flush();
    const seq = m[0];
    if (seq.endsWith("m") && seq.startsWith("\x1b[")) updateSgr(st, seq);
    out += seq;
    i = esc + seq.length;
  }
  flush();
  return out;
}

/** Only colour text while the program's foreground colour is the default. */
function updateSgr(st, seq) {
  const params = seq.slice(2, -1);
  if (params === "" || params === "0") return void (st.colored = false);
  const parts = params.split(";").map(Number);
  for (let k = 0; k < parts.length; k++) {
    const p = parts[k];
    if (p === 0 || p === 39) st.colored = false;
    else if ((p >= 30 && p <= 37) || (p >= 90 && p <= 97)) st.colored = true;
    else if (p === 38) {
      st.colored = true;
      k += parts[k + 1] === 5 ? 2 : 4;
    } else if (p === 48) k += parts[k + 1] === 5 ? 2 : 4;
  }
}

function trackSgr(st, s) {
  for (const m of s.matchAll(/\x1b\[[0-9;]*m/g)) updateSgr(st, m[0]);
}
