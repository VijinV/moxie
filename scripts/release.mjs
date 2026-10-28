// Builds signed installers and the latest.json that Moxie's auto-updater reads.
//
//   npm run release                 build + write latest.json
//   npm run release -- --publish    …and create the GitHub release (needs `gh auth login`)
//
// Signing key: ~/.tauri/moxie-updater.key (or TAURI_SIGNING_PRIVATE_KEY). Keep it safe and
// backed up: installed copies only accept updates signed with this key.
import { execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const REPO = "VijinV/moxie";
const root = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const conf = JSON.parse(readFileSync(join(root, "src-tauri/tauri.conf.json"), "utf8"));
const version = conf.version;
const tag = `v${version}`;

const keyFile = join(homedir(), ".tauri", "moxie-updater.key");
const env = { ...process.env };
if (!env.TAURI_SIGNING_PRIVATE_KEY) {
  if (!existsSync(keyFile)) throw new Error(`No signing key: set TAURI_SIGNING_PRIVATE_KEY or create ${keyFile}`);
  env.TAURI_SIGNING_PRIVATE_KEY = readFileSync(keyFile, "utf8").trim();
}
env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD ??= "";
env.PATH = `${join(homedir(), ".cargo", "bin")}${process.platform === "win32" ? ";" : ":"}${env.PATH}`;

// Windows code signing (removes the SmartScreen warning) — whichever is configured:
//   WINDOWS_CERT_THUMBPRINT     a code-signing certificate installed in the Windows cert store
//   AZURE_SIGNING_ENDPOINT + AZURE_SIGNING_ACCOUNT + AZURE_SIGNING_PROFILE
//                               Azure Trusted Signing (needs `trusted-signing-cli` on PATH and
//                               az login / AZURE_CLIENT_ID+SECRET+TENANT_ID)
// Neither set: the installers are built unsigned, as before.
const signing = (() => {
  if (env.WINDOWS_CERT_THUMBPRINT) {
    return { certificateThumbprint: env.WINDOWS_CERT_THUMBPRINT, digestAlgorithm: "sha256", timestampUrl: "http://timestamp.digicert.com" };
  }
  if (env.AZURE_SIGNING_ENDPOINT && env.AZURE_SIGNING_ACCOUNT && env.AZURE_SIGNING_PROFILE) {
    return { signCommand: `trusted-signing-cli -e ${env.AZURE_SIGNING_ENDPOINT} -a ${env.AZURE_SIGNING_ACCOUNT} -c ${env.AZURE_SIGNING_PROFILE} %1` };
  }
  return null;
})();
// Passed as a file: JSON on the command line doesn't survive npm + cmd.exe quoting.
const signingConf = join(root, "src-tauri", "target", "signing.conf.json");
if (signing) writeFileSync(signingConf, JSON.stringify({ bundle: { windows: signing } }));
const configArg = signing ? ` --config "${signingConf}"` : "";
console.log(`Building Moxie ${version}${signing ? " (code-signed)" : " (not code-signed)"}…`);
execSync(`npm run tauri build --${configArg}`, { cwd: root, env, stdio: "inherit" });

const bundle = join(root, "src-tauri/target/release/bundle");
const setup = `Moxie_${version}_x64-setup.exe`;
const msi = `Moxie_${version}_x64_en-US.msi`;
const sig = readFileSync(join(bundle, "nsis", `${setup}.sig`), "utf8").trim();

const notesArg = process.argv.indexOf("--notes");
const notes = notesArg > 0 ? readFileSync(process.argv[notesArg + 1], "utf8") : `Moxie ${version}`;
const latest = {
  version,
  notes,
  pub_date: new Date().toISOString(),
  platforms: {
    "windows-x86_64": { signature: sig, url: `https://github.com/${REPO}/releases/download/${tag}/${setup}` },
  },
};
const latestPath = join(bundle, "latest.json");
writeFileSync(latestPath, JSON.stringify(latest, null, 2));
console.log(`Wrote ${latestPath}`);

if (process.argv.includes("--publish")) {
  const files = [join(bundle, "nsis", setup), join(bundle, "msi", msi), latestPath].map((f) => `"${f}"`).join(" ");
  const notesFlag = notesArg > 0 ? `--notes-file "${process.argv[notesArg + 1]}"` : `--notes "Moxie ${version}"`;
  const ghWin = "C:\\Program Files\\GitHub CLI\\gh.exe";
  const gh = process.platform === "win32" && existsSync(ghWin) ? `"${ghWin}"` : "gh";
  execSync(`${gh} release create ${tag} ${files} --repo ${REPO} --target main --title "Moxie ${tag}" ${notesFlag} --latest`, {
    cwd: root,
    stdio: "inherit",
  });
}
