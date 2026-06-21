// Regenerate the Muse mascot terminal art (apps/cli/src/muse-mascot-ansi.ts)
// from a PNG, with ZERO third-party deps — Node's built-in zlib does the
// DEFLATE inflate/deflate, the rest is plain buffer work.
//
// Default renderer: SEXTANTS (U+1FB00 block — 2x3 subpixels per cell), which
// Ghostty/Kitty/WezTerm draw pixel-perfect builtin. Two colours per cell
// (fg/bg) → crisp B&W line-art at 2x horizontal + 1.5x vertical the detail of
// half-blocks, in the same cell footprint. TRUECOLOR; alpha honoured so the
// transparent background shows the terminal's own colour (no black box).
// RENDER=half falls back to ▀ half-blocks.
//
//   node scripts/gen-mascot-ansi.mjs <input.png> <cols> <out.ts>
//   node scripts/gen-mascot-ansi.mjs <input.png> <cols> preview-png:<file.png>   # visual check

import { readFileSync, writeFileSync } from "node:fs";
import { inflateSync, deflateSync } from "node:zlib";

const [, , inputArg, colsArg, outArg] = process.argv;
const input = inputArg ?? "docs/assets/muse-goddess-alpha.png";
const cols = Number(colsArg ?? 56);
const out = outArg ?? "apps/cli/src/muse-mascot-ansi.ts";
const MODE = process.env.RENDER ?? "sextant"; // "sextant" | "half"
const ALPHA_THRESHOLD = 110;
const SHARPEN_AMOUNT = process.env.SHARPEN_AMOUNT !== undefined ? Number(process.env.SHARPEN_AMOUNT) : 0.7;
const SHARPEN_CONTRAST = process.env.SHARPEN_CONTRAST !== undefined ? Number(process.env.SHARPEN_CONTRAST) : 1.2;
const ESC = "\x1b";

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
  const paeth = (a, b, c) => { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); return pa <= pb && pa <= pc ? a : pb <= pc ? b : c; };
  let rp = 0;
  for (let y = 0; y < height; y++) {
    const f = raw[rp++];
    for (let x = 0; x < stride; x++) {
      const cur = raw[rp++];
      const a = x >= bpp ? px[y * stride + x - bpp] : 0;
      const b = y > 0 ? px[(y - 1) * stride + x] : 0;
      const c = x >= bpp && y > 0 ? px[(y - 1) * stride + x - bpp] : 0;
      let v;
      switch (f) { case 0: v = cur; break; case 1: v = cur + a; break; case 2: v = cur + b; break; case 3: v = cur + ((a + b) >> 1); break; case 4: v = cur + paeth(a, b, c); break; default: throw new Error(`bad filter ${f}`); }
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

// box-average downscale to a (tw x th) subpixel grid, alpha-weighted RGB
function downscale(img, tw, th) {
  const grid = new Array(tw * th);
  for (let oy = 0; oy < th; oy++) {
    const sy0 = Math.floor((oy / th) * img.height), sy1 = Math.max(sy0 + 1, Math.floor(((oy + 1) / th) * img.height));
    for (let ox = 0; ox < tw; ox++) {
      const sx0 = Math.floor((ox / tw) * img.width), sx1 = Math.max(sx0 + 1, Math.floor(((ox + 1) / tw) * img.width));
      let r = 0, g = 0, b = 0, a = 0, wsum = 0, n = 0;
      for (let y = sy0; y < sy1; y++) for (let x = sx0; x < sx1; x++) {
        const [pr, pg, pb, pa] = rgbaAt(img, x, y); const w = pa / 255;
        r += pr * w; g += pg * w; b += pb * w; a += pa; wsum += w; n++;
      }
      const k = wsum > 0 ? 1 / wsum : 0;
      grid[oy * tw + ox] = { r: Math.round(r * k), g: Math.round(g * k), b: Math.round(b * k), a: Math.round(a / n) };
    }
  }
  return grid;
}

// unsharp mask + contrast on a (w x h) grid — restores crisp edges
function sharpen(grid, w, h, amount, contrast) {
  const at = (x, y) => grid[Math.max(0, Math.min(h - 1, y)) * w + Math.max(0, Math.min(w - 1, x))];
  const clamp = (v) => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v));
  return grid.map((p, idx) => {
    const x = idx % w, y = (idx / w) | 0, o = { a: p.a };
    for (const ch of ["r", "g", "b"]) {
      let blur = 0; for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) blur += at(x + dx, y + dy)[ch];
      blur /= 9;
      o[ch] = clamp((p[ch] + amount * (p[ch] - blur) - 128) * contrast + 128);
    }
    return o;
  });
}

const lum = (p) => 0.299 * p.r + 0.587 * p.g + 0.114 * p.b;

// Sextant glyph for a 6-bit pattern (bit i set = subpixel i is foreground).
// Bit order: 0=TL 1=TR 2=ML 3=MR 4=BL 5=BR. U+1FB00 block, skipping the four
// patterns that coincide with space / ▌ / ▐ / █.
function sextantChar(bits) {
  if (bits === 0) return " ";
  if (bits === 63) return "█";
  if (bits === 21) return "▌"; // TL+ML+BL (left column)
  if (bits === 42) return "▐"; // TR+MR+BR (right column)
  const index = bits - 1 - (bits > 21 ? 1 : 0) - (bits > 42 ? 1 : 0);
  return String.fromCodePoint(0x1fb00 + index);
}

const img = decodePng(readFileSync(input));
// rows (cells) preserves image aspect (terminal cell ~1:2); same for both modes
const rows = Math.max(1, Math.round((cols * img.height) / img.width / 2));
const sub = MODE === "sextant" ? { sx: 2, sy: 3 } : { sx: 1, sy: 2 };
const subW = cols * sub.sx, subH = rows * sub.sy;
const grid = sharpen(downscale(img, subW, subH), subW, subH, SHARPEN_AMOUNT, SHARPEN_CONTRAST);
const gAt = (sx, sy) => grid[sy * subW + sx];
const opaque = (p) => p.a >= ALPHA_THRESHOLD;
const avg = (ps) => ps.length ? { r: Math.round(ps.reduce((s, p) => s + p.r, 0) / ps.length), g: Math.round(ps.reduce((s, p) => s + p.g, 0) / ps.length), b: Math.round(ps.reduce((s, p) => s + p.b, 0) / ps.length) } : { r: 0, g: 0, b: 0 };

// decide, per cell, the glyph + fg + bg (bg "default" = transparent show-through)
function cellAt(cx, cy) {
  const subs = [];
  for (let j = 0; j < sub.sy; j++) for (let i = 0; i < sub.sx; i++) subs.push(gAt(cx * sub.sx + i, cy * sub.sy + j));
  const op = subs.filter(opaque);
  if (op.length === 0) return { glyph: " ", fg: null, bg: null };
  const lums = op.map(lum);
  const thr = (Math.min(...lums) + Math.max(...lums)) / 2;
  const fgSubs = [], bgSubs = [];
  let bits = 0;
  subs.forEach((p, k) => { const isFg = opaque(p) && lum(p) > thr; if (isFg) { bits |= 1 << k; fgSubs.push(p); } else if (opaque(p)) bgSubs.push(p); });
  if (fgSubs.length === 0) { // uniform opaque cell: paint every opaque subpixel as fg
    bits = 0; bgSubs.length = 0;
    subs.forEach((p, k) => { if (opaque(p)) { bits |= 1 << k; fgSubs.push(p); } });
  }
  const hasTransparent = subs.some((p) => !opaque(p));
  const fg = avg(fgSubs.length ? fgSubs : op);
  const bg = hasTransparent || bgSubs.length === 0 ? null : avg(bgSubs);
  const glyph = MODE === "sextant" ? sextantChar(bits) : (bits & 1 ? "▀" : "▄");
  return { glyph, fg, bg };
}

// ---- ANSI rows ----
const rowsAnsi = [];
for (let cy = 0; cy < rows; cy++) {
  let line = "";
  for (let cx = 0; cx < cols; cx++) {
    const { glyph, fg, bg } = cellAt(cx, cy);
    if (fg === null) { line += `${ESC}[0m `; continue; }
    const fgc = `38;2;${fg.r};${fg.g};${fg.b}`;
    line += bg === null ? `${ESC}[49;${fgc}m${glyph}` : `${ESC}[${fgc};48;2;${bg.r};${bg.g};${bg.b}m${glyph}`;
  }
  line += `${ESC}[0m`;
  rowsAnsi.push(line);
}

// ---- preview PNG (renders the quantized cells, composited over terminal bg) ----
function encodePng(width, height, rgba) {
  const stride = width * 4, raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) { raw[y * (stride + 1)] = 0; rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride); }
  const T = (() => { const t = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
  const crc = (b) => { let c = 0xffffffff; for (let i = 0; i < b.length; i++) c = T[(c ^ b[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type, "ascii"), data]); const cc = Buffer.alloc(4); cc.writeUInt32BE(crc(td)); return Buffer.concat([len, td, cc]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from("\x89PNG\r\n\x1a\n", "binary"), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

if (out.startsWith("preview-png:")) {
  const file = out.slice("preview-png:".length);
  const scale = 6, bg = [17, 17, 17]; // simulate Ghostty's near-black background
  const W = cols * sub.sx * scale, H = rows * sub.sy * scale;
  const rgba = Buffer.alloc(W * H * 4);
  for (let cy = 0; cy < rows; cy++) for (let cx = 0; cx < cols; cx++) {
    const { glyph, fg, bg: cbg } = cellAt(cx, cy);
    // reconstruct which subpixels are fg from the glyph's bit pattern
    let bits = 0;
    if (glyph === "█") bits = (1 << (sub.sx * sub.sy)) - 1; else if (glyph === "▌") bits = 21; else if (glyph === "▐") bits = 42;
    else if (glyph === "▀") bits = 0b01; else if (glyph === "▄") bits = 0b10; else if (glyph !== " ") {
      let idx = glyph.codePointAt(0) - 0x1fb00; let v = idx + 1; if (v >= 21) v++; if (v >= 42) v++; bits = v;
    }
    for (let j = 0; j < sub.sy; j++) for (let i = 0; i < sub.sx; i++) {
      const k = j * sub.sx + i, isFg = (bits >> k) & 1;
      const col = isFg && fg ? fg : cbg; // null bg → terminal bg
      const r = col ? col.r : bg[0], g = col ? col.g : bg[1], b = col ? col.b : bg[2];
      for (let py = 0; py < scale; py++) for (let px2 = 0; px2 < scale; px2++) {
        const X = (cx * sub.sx + i) * scale + px2, Y = (cy * sub.sy + j) * scale + py, o = (Y * W + X) * 4;
        rgba[o] = r; rgba[o + 1] = g; rgba[o + 2] = b; rgba[o + 3] = 255;
      }
    }
  }
  writeFileSync(file, encodePng(W, H, rgba));
  console.log(`wrote preview ${file}: mode=${MODE} ${cols}x${rows} cells (sub ${subW}x${subH}, source ${img.width}x${img.height})`);
} else {
  const lines = rowsAnsi.map((l) => "  `" + l.replaceAll(ESC, "\\x1b") + "`");
  const ts = `// Muse mascot for the terminal — the goddess rendered as TRUECOLOR (24-bit)
// ${MODE === "sextant" ? "sextant (2x3 subpixel) art (U+1FB00 block)" : "half-block art"},
// alpha honoured so the transparent background shows the terminal's own colour.
//
// GENERATED by scripts/gen-mascot-ansi.mjs from ${input} — do NOT hand-edit.
// Regenerate: node scripts/gen-mascot-ansi.mjs ${input} ${cols} ${out}

/** Cells (glyphs) per row. */
export const MUSE_MASCOT_WIDTH = ${cols};
/** Rows of cells. */
export const MUSE_MASCOT_ROWS = ${rows};

/** ${img.width}x${img.height} source → ${cols} x ${rows} cells (${MODE}). */
export const MUSE_MASCOT_ANSI: string = [
${lines.join(",\n")}
].join("\\n");
`;
  writeFileSync(out, ts);
  console.log(`wrote ${out}: mode=${MODE} ${cols}x${rows} cells (from ${img.width}x${img.height})`);
}
