// Regenerate the Muse mascot terminal art (apps/cli/src/muse-mascot-ansi.ts)
// from a PNG, with ZERO third-party deps — Node's built-in zlib does the
// DEFLATE inflate, the rest is plain buffer work. The goddess is monochrome,
// so we render to the 256-color grayscale ramp (broad terminal compatibility)
// using half-block characters (one cell = two vertical pixels).
//
//   node scripts/gen-mascot-ansi.mjs <input.png> <cols> <out.ts>
//   node scripts/gen-mascot-ansi.mjs docs/assets/muse-goddess.png 72 apps/cli/src/muse-mascot-ansi.ts

import { readFileSync, writeFileSync } from "node:fs";
import { inflateSync } from "node:zlib";

const [, , inputArg, colsArg, outArg] = process.argv;
const input = inputArg ?? "docs/assets/muse-goddess.png";
const cols = Number(colsArg ?? 72);
const out = outArg ?? "apps/cli/src/muse-mascot-ansi.ts";

function decodePng(buf) {
  const sig = "\x89PNG\r\n\x1a\n";
  for (let i = 0; i < 8; i++) {
    if (buf[i] !== sig.charCodeAt(i)) throw new Error("not a PNG");
  }
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  const bitDepth = buf[24];
  const colorType = buf[25];
  const interlace = buf[28];
  if (bitDepth !== 8) throw new Error(`unsupported bitDepth ${bitDepth} (need 8)`);
  if (interlace !== 0) throw new Error("interlaced PNG not supported");
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[colorType];
  if (!channels) throw new Error(`unsupported colorType ${colorType}`);

  const idat = [];
  let pos = 8;
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString("ascii", pos + 4, pos + 8);
    const start = pos + 8;
    if (type === "IDAT") idat.push(buf.subarray(start, start + len));
    pos = start + len + 4;
    if (type === "IEND") break;
  }
  const raw = inflateSync(Buffer.concat(idat));

  const bpp = channels;
  const stride = width * bpp;
  const pixels = Buffer.alloc(stride * height);
  const paeth = (a, b, c) => {
    const p = a + b - c;
    const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
  };
  let rp = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[rp++];
    for (let x = 0; x < stride; x++) {
      const cur = raw[rp++];
      const a = x >= bpp ? pixels[y * stride + x - bpp] : 0;
      const b = y > 0 ? pixels[(y - 1) * stride + x] : 0;
      const c = x >= bpp && y > 0 ? pixels[(y - 1) * stride + x - bpp] : 0;
      let v;
      switch (filter) {
        case 0: v = cur; break;
        case 1: v = cur + a; break;
        case 2: v = cur + b; break;
        case 3: v = cur + ((a + b) >> 1); break;
        case 4: v = cur + paeth(a, b, c); break;
        default: throw new Error(`bad filter ${filter}`);
      }
      pixels[y * stride + x] = v & 0xff;
    }
  }
  return { width, height, channels, pixels };
}

// luminance of a source pixel, alpha composited over black
function lumAt(img, x, y) {
  const { channels, width, pixels } = img;
  const i = (y * width + x) * channels;
  let r, g, b, alpha;
  if (channels >= 3) { r = pixels[i]; g = pixels[i + 1]; b = pixels[i + 2]; alpha = channels === 4 ? pixels[i + 3] : 255; }
  else { r = g = b = pixels[i]; alpha = channels === 2 ? pixels[i + 1] : 255; }
  const l = 0.299 * r + 0.587 * g + 0.114 * b;
  return (l * alpha) / 255; // composite over black bg
}

// box-average downscale to (cols x rowsPx) grayscale
function downscale(img, cols) {
  const aspect = img.height / img.width;
  const rowsPx = Math.round(cols * aspect * 0.5) * 2; // even, terminal cell ~2:1 corrected by half-block
  const grid = new Float64Array(cols * rowsPx);
  for (let oy = 0; oy < rowsPx; oy++) {
    const sy0 = Math.floor((oy / rowsPx) * img.height);
    const sy1 = Math.max(sy0 + 1, Math.floor(((oy + 1) / rowsPx) * img.height));
    for (let ox = 0; ox < cols; ox++) {
      const sx0 = Math.floor((ox / cols) * img.width);
      const sx1 = Math.max(sx0 + 1, Math.floor(((ox + 1) / cols) * img.width));
      let sum = 0, n = 0;
      for (let y = sy0; y < sy1; y++) for (let x = sx0; x < sx1; x++) { sum += lumAt(img, x, y); n++; }
      grid[oy * cols + ox] = sum / n;
    }
  }
  return { grid, cols, rowsPx };
}

// xterm-256 grayscale candidates: 16 (black), 232..255 (ramp), 231 (white)
const GRAYS = [[16, 0], ...Array.from({ length: 24 }, (_, i) => [232 + i, 8 + i * 10]), [231, 255]];
function gray256(v) {
  let best = 16, bestD = Infinity;
  for (const [idx, gv] of GRAYS) { const d = Math.abs(gv - v); if (d < bestD) { bestD = d; best = idx; } }
  return best;
}

const img = decodePng(readFileSync(input));
const { grid, rowsPx } = downscale(img, cols);

// build real-ANSI rows (ESC = \x1b)
const ESC = "\x1b";
const rowsAnsi = [];
for (let r = 0; r < rowsPx; r += 2) {
  let line = "";
  for (let c = 0; c < cols; c++) {
    const top = gray256(grid[r * cols + c]);
    const bot = gray256(grid[(r + 1) * cols + c]);
    line += `${ESC}[38;5;${top};48;5;${bot}m▀`;
  }
  line += `${ESC}[0m`;
  rowsAnsi.push(line);
}
const rows = rowsPx / 2;

if (out === "preview") {
  process.stdout.write(rowsAnsi.join("\n") + "\n");
  console.error(`preview: ${cols} cols x ${rows} rows (from ${img.width}x${img.height})`);
  process.exit(0);
}

const lines = rowsAnsi.map((line) => "  `" + line.replaceAll(ESC, "\\x1b") + "`");
const ts = `// Muse mascot for the terminal — the goddess rendered as 256-color grayscale
// half-block art (one char = two vertical pixels). 256-color is chosen over
// truecolor for broad terminal compatibility.
//
// GENERATED by scripts/gen-mascot-ansi.mjs from ${input} — do NOT hand-edit.
// Regenerate: node scripts/gen-mascot-ansi.mjs ${input} ${cols} ${out}

/** Columns (half-blocks) per row. */
export const MUSE_MASCOT_WIDTH = ${cols};
/** Rows of half-blocks (each row = two source pixels tall). */
export const MUSE_MASCOT_ROWS = ${rows};

/** ${img.width}x${img.height} source → ${cols} cols x ${rows} rows of half-blocks. */
export const MUSE_MASCOT_ANSI: string = [
${lines.join(",\n")}
].join("\\n");
`;
writeFileSync(out, ts);
console.log(`wrote ${out}: ${cols} cols x ${rows} rows (from ${img.width}x${img.height})`);
