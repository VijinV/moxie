// File-type colours shared by the SFTP panel and terminal highlighting (like `ls --color`).

const EXT = {
  code: "js mjs cjs jsx ts tsx mts py rb go rs java kt c h cpp hpp cc cs php swift lua pl sh bash zsh fish ps1 psm1 sql vue svelte html htm css scss less r scala dart ex exs erl hs ml clj".split(" "),
  config: "conf cfg cnf ini env toml yaml yml json jsonc xml properties plist service socket timer rules htaccess lock".split(" "),
  archive: "zip tar gz tgz bz2 xz zst 7z rar deb rpm apk jar war iso dmg img".split(" "),
  image: "png jpg jpeg gif svg webp ico bmp tif tiff heic avif psd".split(" "),
  media: "mp3 wav flac ogg m4a mp4 mkv mov avi webm".split(" "),
  key: "pem key crt cer csr der pub p12 pfx gpg asc".split(" "),
  log: "log out err".split(" "),
  doc: "md markdown txt rst pdf doc docx xls xlsx csv tsv odt".split(" "),
  data: "db sqlite sqlite3 sql.gz dump bak backup".split(" "),
};
const BY_EXT = new Map();
for (const [kind, exts] of Object.entries(EXT)) for (const e of exts) BY_EXT.set(e, kind);
const BY_NAME = {
  dockerfile: "config", makefile: "code", "docker-compose.yml": "config", "compose.yml": "config",
  ".bashrc": "config", ".profile": "config", ".zshrc": "config", ".gitconfig": "config", ".gitignore": "config",
  ".env": "config", authorized_keys: "key", known_hosts: "key", id_rsa: "key", id_ed25519: "key", id_ecdsa: "key",
};

/** "dir" | "link" | "exec" | "code" | "config" | "archive" | "image" | "media" | "key" | "log" | "doc" | "data" | "" */
export function fileKind(name, { isDir = false, isLink = false, isExec = false } = {}) {
  if (isDir) return "dir";
  if (isLink) return "link";
  const lower = name.toLowerCase();
  if (BY_NAME[lower]) return BY_NAME[lower];
  if (/\.log\.\d+(\.gz)?$/.test(lower)) return "log";
  if (/\.(tar\.(gz|bz2|xz|zst))$/.test(lower)) return "archive";
  const ext = lower.includes(".") ? lower.slice(lower.lastIndexOf(".") + 1) : "";
  if (ext && BY_EXT.has(ext)) return BY_EXT.get(ext);
  if (isExec) return "exec";
  return "";
}

/** Colours per kind (also used as CSS classes `k-<kind>` in the SFTP panel). */
export const KIND_COLORS = {
  dir: "#7aa2f7",
  link: "#2ac3de",
  exec: "#9ece6a",
  code: "#7dcfff",
  config: "#e0af68",
  archive: "#f7768e",
  image: "#bb9af7",
  media: "#bb9af7",
  key: "#ff79c6",
  log: "#ff9e64",
  doc: "#c0caf5",
  data: "#ff9e64",
};
