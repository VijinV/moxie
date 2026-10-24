// Generates app-icon.png (gradient tile with a ">_" glyph); `npx tauri icon` derives the rest.
import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";

const N = 1024;
const px = Buffer.alloc(N * N * 4);
const r = 200; // corner radius
const inRounded = (x, y) => {
  const cx = Math.min(Math.max(x, r), N - r), cy = Math.min(Math.max(y, r), N - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
};
const distToSeg = (x, y, ax, ay, bx, by) => {
  const dx = bx - ax, dy = by - ay;
  const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(x - (ax + t * dx), y - (ay + t * dy));
};
for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
  const i = (y * N + x) * 4;
  if (!inRounded(x, y)) continue;
  const t = (x + y) / (2 * N);
  let [R, G, B] = [167 + (125 - 167) * t, 139 + (207 - 139) * t, 250 + (255 - 250) * t];
  const glyph =
    distToSeg(x, y, 280, 330, 480, 512) < 52 || distToSeg(x, y, 480, 512, 280, 694) < 52 ||
    distToSeg(x, y, 540, 700, 760, 700) < 48;
  if (glyph) [R, G, B] = [16, 14, 28];
  px[i] = R; px[i + 1] = G; px[i + 2] = B; px[i + 3] = 255;
}
const raw = Buffer.alloc((N * 4 + 1) * N);
for (let y = 0; y < N; y++) px.copy(raw, y * (N * 4 + 1) + 1, y * N * 4, (y + 1) * N * 4);
const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = (b) => { let c = 0xffffffff; for (const v of b) c = crcTable[(c ^ v) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(N, 0); ihdr.writeUInt32BE(N, 4); ihdr[8] = 8; ihdr[9] = 6;
writeFileSync(process.argv[2] ?? "app-icon.png", Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]));
