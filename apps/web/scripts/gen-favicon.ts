/**
 * Regenerates the app favicon straight from the desk-pet mascot's `stand`
 * matrix — zero hand-drawn assets, single source of truth. Run it whenever the
 * mascot's pixel data changes:
 *
 *   pnpm --filter @muse/web gen:favicon
 *
 * Output: apps/web/public/favicon.png (committed, but GENERATED — never edit by
 * hand). The bird is centered on a transparent square canvas at an integer
 * scale so it stays crisp at 16px.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

import { FRAMES, GRID_H, GRID_W, PALETTE } from "../src/components/pixel-bird.js";

const CANVAS = 64; // square favicon source; the browser downsamples to 16/32.

function crc32(buf: Buffer): number {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i]!;
    for (let k = 0; k < 8; k++) {
      c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    }
  }
  return ~c >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const t = Buffer.from(type, "ascii");
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([t, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function encodePng(width: number, height: number, rgba: Buffer): Buffer {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type RGBA
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const idat = deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", Buffer.alloc(0))]);
}

function hexToRgba(color: string): [number, number, number, number] {
  if (color === "transparent") {
    return [0, 0, 0, 0];
  }
  const m = color.replace("#", "");
  return [parseInt(m.slice(0, 2), 16), parseInt(m.slice(2, 4), 16), parseInt(m.slice(4, 6), 16), 255];
}

function render(): Buffer {
  const frame = FRAMES.stand;
  const scale = Math.floor(CANVAS / Math.max(GRID_W, GRID_H));
  const artW = GRID_W * scale;
  const artH = GRID_H * scale;
  const offX = Math.floor((CANVAS - artW) / 2);
  const offY = Math.floor((CANVAS - artH) / 2);
  const rgba = Buffer.alloc(CANVAS * CANVAS * 4); // transparent

  for (let r = 0; r < GRID_H; r++) {
    const row = frame[r]!;
    for (let c = 0; c < GRID_W; c++) {
      const color = PALETTE[row[c]!];
      if (!color || color === "transparent") {
        continue;
      }
      const [pr, pg, pb] = hexToRgba(color);
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          const x = offX + c * scale + dx;
          const y = offY + r * scale + dy;
          const idx = (y * CANVAS + x) * 4;
          rgba[idx] = pr;
          rgba[idx + 1] = pg;
          rgba[idx + 2] = pb;
          rgba[idx + 3] = 255;
        }
      }
    }
  }
  return encodePng(CANVAS, CANVAS, rgba);
}

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(here, "../public");
const outFile = resolve(outDir, "favicon.png");
mkdirSync(outDir, { recursive: true });
writeFileSync(outFile, render());
console.log(`wrote ${outFile}`);
