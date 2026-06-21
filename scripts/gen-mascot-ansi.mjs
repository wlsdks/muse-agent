// Regenerate the Muse mascot terminal art (apps/cli/src/muse-mascot-ansi.ts)
// from a PNG, with ZERO third-party deps — Node's built-in zlib does the
// DEFLATE inflate/deflate, the rest is plain buffer work.
//
// Rendering: TRUECOLOR (24-bit) half-blocks (one cell = two vertical pixels),
// with ALPHA honoured — transparent pixels become the terminal's own
// background (no black box). Uses ▀ (upper), ▄ (lower) or a space depending
// on which of the two stacked pixels are opaque.
//
//   node scripts/gen-mascot-ansi.mjs <input.png> <cols> <out.ts>
//   node scripts/gen-mascot-ansi.mjs <input.png> <cols> preview-png:<file.png>   # visual check

import { readFileSync, writeFileSync } from "node:fs";
import { inflateSync, deflateSync } from "node:zlib";

const [, , inputArg, colsArg, outArg] = process.argv;
const input = inputArg ?? "docs/assets/muse-goddess-alpha.png";
const cols = Number(colsArg ?? 56);
const out = outArg ?? "apps/cli/src/muse-mascot-ansi.ts";
const ALPHA_THRESHOLD = 110;

function decodePng(buf) {
  const sig = "\x89PNG\r\n\x1a\n";
  for (let i = 0; i < 8; i++) if (buf[i] !== sig.charCodeAt(i)) throw new Error("not a PNG");
  const width = buf.readUInt32BE(16), height = buf.readUInt32BE(20);
  const bitDepth = buf[24], colorType = buf[25], interlace = buf[28];
  if (bitDepth !== 8) throw new Error(`unsupported bitDepth ${bitDepth}`);
  if (interlace !== 0) throw new Error("interlaced PNG not supported");
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[colorType];
  if (!channels) throw new Error(`unsupported colorType ${colorType}`);
  const idat = [];
  let pos = 8;
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString("ascii", pos + 4, pos + 8);
    if (type === "IDAT") idat.push(buf.subarray(pos + 8, pos + 8 + len));
    pos += 12 + len;
    if (type === "IEND") break;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const bpp = channels, stride = width * bpp;
  const px = Buffer.alloc(stride * height);
  const paeth = (a, b, c) => {
    const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
  };
  let rp = 0;
  for (let y = 0; y < height; y++) {
    const f = raw[rp++];
    for (let x = 0; x < stride; x++) {
      const cur = raw[rp++];
      const a = x >= bpp ? px[y * stride + x - bpp] : 0;
      const b = y > 0 ? px[(y - 1) * stride + x] : 0;
      const c = x >= bpp && y > 0 ? px[(y - 1) * stride + x - bpp] : 0;
      let v;
      switch (f) {
        case 0: v = cur; break; case 1: v = cur + a; break; case 2: v = cur + b; break;
        case 3: v = cur + ((a + b) >> 1); break; case 4: v = cur + paeth(a, b, c); break;
        default: throw new Error(`bad filter ${f}`);
      }
      px[y * stride + x] = v & 0xff;
    }
  }
  return { width, height, channels, pixels: px };
}

function rgbaAt(img, x, y) {
  const { channels, width, pixels } = img;
  const i = (y * width + x) * channels;
  if (channels >= 3) return [pixels[i], pixels[i + 1], pixels[i + 2], channels === 4 ? pixels[i + 3] : 255];
  const g = pixels[i];
  return [g, g, g, channels === 2 ? pixels[i + 1] : 255];
}

// box-average downscale to (cols x rowsPx), alpha-weighted RGB + mean alpha
function downscale(img, cols) {
  const rowsPx = Math.round((cols * img.height) / img.width / 2) * 2;
  const cell = new Array(cols * rowsPx);
  for (let oy = 0; oy < rowsPx; oy++) {
    const sy0 = Math.floor((oy / rowsPx) * img.height);
    const sy1 = Math.max(sy0 + 1, Math.floor(((oy + 1) / rowsPx) * img.height));
    for (let ox = 0; ox < cols; ox++) {
      const sx0 = Math.floor((ox / cols) * img.width);
      const sx1 = Math.max(sx0 + 1, Math.floor(((ox + 1) / cols) * img.width));
      let r = 0, g = 0, b = 0, a = 0, wsum = 0, n = 0;
      for (let y = sy0; y < sy1; y++) for (let x = sx0; x < sx1; x++) {
        const [pr, pg, pb, pa] = rgbaAt(img, x, y);
        const w = pa / 255;
        r += pr * w; g += pg * w; b += pb * w; a += pa; wsum += w; n++;
      }
      const k = wsum > 0 ? 1 / wsum : 0;
      cell[oy * cols + ox] = { r: Math.round(r * k), g: Math.round(g * k), b: Math.round(b * k), a: Math.round(a / n) };
    }
  }
  return { cell, cols, rowsPx };
}

// Unsharp mask + contrast on the downscaled grid. Box-average downscaling
// blurs crisp B&W line-art into grays; this restores edge definition.
function sharpen(cell, cols, rowsPx, amount = 1.1, contrast = 1.35) {
  const at = (x, y) => cell[Math.max(0, Math.min(rowsPx - 1, y)) * cols + Math.max(0, Math.min(cols - 1, x))];
  const out = new Array(cols * rowsPx);
  const clamp = (v) => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v));
  for (let y = 0; y < rowsPx; y++) for (let x = 0; x < cols; x++) {
    const p = cell[y * cols + x];
    const o = { a: p.a };
    for (const ch of ["r", "g", "b"]) {
      let blur = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) blur += at(x + dx, y + dy)[ch];
      blur /= 9;
      const sharp = p[ch] + amount * (p[ch] - blur);
      o[ch] = clamp((sharp - 128) * contrast + 128);
    }
    out[y * cols + x] = o;
  }
  return out;
}

const img = decodePng(readFileSync(input));
const down = downscale(img, cols);
const rowsPx = down.rowsPx;
const amount = process.env.SHARPEN_AMOUNT !== undefined ? Number(process.env.SHARPEN_AMOUNT) : 0.7;
const contrast = process.env.SHARPEN_CONTRAST !== undefined ? Number(process.env.SHARPEN_CONTRAST) : 1.2;
const cell = sharpen(down.cell, cols, rowsPx, amount, contrast);
const rows = rowsPx / 2;
const ESC = "\x1b";
const opaque = (p) => p.a >= ALPHA_THRESHOLD;

const rowsAnsi = [];
for (let r = 0; r < rowsPx; r += 2) {
  let line = "";
  for (let c = 0; c < cols; c++) {
    const top = cell[r * cols + c], bot = cell[(r + 1) * cols + c];
    const to = opaque(top), bo = opaque(bot);
    if (to && bo) line += `${ESC}[38;2;${top.r};${top.g};${top.b};48;2;${bot.r};${bot.g};${bot.b}m▀`;
    else if (to) line += `${ESC}[49;38;2;${top.r};${top.g};${top.b}m▀`;
    else if (bo) line += `${ESC}[49;38;2;${bot.r};${bot.g};${bot.b}m▄`;
    else line += `${ESC}[0m `;
  }
  line += `${ESC}[0m`;
  rowsAnsi.push(line);
}

// ---- preview PNG (nearest-neighbour upscale, composited over terminal bg) ----
function encodePng(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) { raw[y * (stride + 1)] = 0; rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride); }
  const crcTable = (() => { const t = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
  const crc32 = (b) => { let c = 0xffffffff; for (let i = 0; i < b.length; i++) c = crcTable[(c ^ b[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type, "ascii"), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td)); return Buffer.concat([len, td, crc]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from("\x89PNG\r\n\x1a\n", "binary"), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

if (out.startsWith("preview-png:")) {
  const file = out.slice("preview-png:".length);
  const scale = 10;
  const bg = [17, 17, 17]; // simulate Ghostty's near-black background
  const W = cols * scale, H = rowsPx * scale;
  const rgba = Buffer.alloc(W * H * 4);
  for (let py = 0; py < H; py++) for (let px2 = 0; px2 < W; px2++) {
    const p = cell[Math.floor(py / scale) * cols + Math.floor(px2 / scale)];
    const a = p.a / 255;
    const i = (py * W + px2) * 4;
    rgba[i] = Math.round(p.r * a + bg[0] * (1 - a));
    rgba[i + 1] = Math.round(p.g * a + bg[1] * (1 - a));
    rgba[i + 2] = Math.round(p.b * a + bg[2] * (1 - a));
    rgba[i + 3] = 255;
  }
  writeFileSync(file, encodePng(W, H, rgba));
  console.log(`wrote preview ${file}: ${cols} cols x ${rows} rows (source ${img.width}x${img.height})`);
} else {
  const lines = rowsAnsi.map((l) => "  `" + l.replaceAll(ESC, "\\x1b") + "`");
  const ts = `// Muse mascot for the terminal — the goddess rendered as TRUECOLOR (24-bit)
// half-block art (one char = two vertical pixels), alpha honoured so the
// transparent background shows the terminal's own colour (no black box).
//
// GENERATED by scripts/gen-mascot-ansi.mjs from ${input} — do NOT hand-edit.
// Regenerate: node scripts/gen-mascot-ansi.mjs ${input} ${cols} ${out}

/** Columns (half-block cells) per row. */
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
}
