import { describe, expect, it } from "vitest";

import {
  CHIRP_FRAME,
  CHIRP_H,
  CHIRP_W,
  FRAMES,
  GRID_H,
  GRID_W,
  PALETTE,
  validateFrame,
  type FrameName
} from "./pixel-data.js";
import { toAnsi } from "./to-ansi.js";
import { DEFAULT_SEQUENCE, toSvg } from "./to-svg.js";

describe("pixel-data", () => {
  it("every pose is a palette-clean 13x11 grid", () => {
    for (const [name, frame] of Object.entries(FRAMES)) {
      const result = validateFrame(frame, PALETTE, GRID_W, GRID_H);
      expect(result.ok, `${name}: ${result.reason ?? ""}`).toBe(true);
    }
  });

  it("chirp overlay matches its declared dims", () => {
    expect(validateFrame(CHIRP_FRAME, { ".": "x", C: "x" }, CHIRP_W, CHIRP_H).ok).toBe(true);
  });
});

describe("toAnsi", () => {
  it("packs two grid rows per line (11 rows -> 6 lines)", () => {
    const lines = toAnsi(FRAMES.stand).split("\n");
    expect(lines).toHaveLength(Math.ceil(GRID_H / 2));
  });

  it("emits truecolor escapes for the body colour and resets each cell", () => {
    const ansi = toAnsi(FRAMES.stand);
    // periwinkle body #8b9dff -> 139;157;255
    expect(ansi).toContain("38;2;139;157;255");
    expect(ansi).toContain("\x1b[0m");
  });

  it("renders a fully-transparent frame as blank (spaces only, no escapes)", () => {
    const blank = Array.from({ length: GRID_H }, () => ".".repeat(GRID_W));
    const ansi = toAnsi(blank);
    expect(ansi).not.toContain("\x1b");
    expect(ansi.replace(/\n/g, "").trim()).toBe("");
  });
});

describe("toSvg", () => {
  it("is a self-contained, camo-safe animated SVG", () => {
    const svg = toSvg();
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg).toContain("@keyframes");
    expect(svg).toContain("<rect");
    // no external references / script / SMIL that a README sanitiser would strip
    expect(svg).not.toContain("<script");
    expect(svg).not.toContain("http://www.w3.org/1999/xlink");
    expect(svg).not.toContain("<animate");
    expect(svg).not.toMatch(/xlink:href|href="http/);
  });

  it("emits one animated group per UNIQUE pose in the sequence", () => {
    const unique = new Set<FrameName>(DEFAULT_SEQUENCE);
    const svg = toSvg();
    const groups = svg.match(/<g class="mm_/g) ?? [];
    expect(groups).toHaveLength(unique.size);
  });

  it("uses the requested duration and intrinsic size", () => {
    const svg = toSvg({ durationSec: 4, size: 96 });
    expect(svg).toContain("4s linear infinite");
    expect(svg).toContain('width="96"');
  });

  it("rejects invalid options instead of emitting broken SVG markup", () => {
    expect(() => toSvg({ sequence: [] })).toThrow("sequence must contain at least one frame");
    expect(() => toSvg({ sequence: ["unknown" as FrameName] })).toThrow("sequence contains an unknown frame");
    expect(() => toSvg({ durationSec: Number.POSITIVE_INFINITY })).toThrow("durationSec must be a finite positive number");
    expect(() => toSvg({ size: 0 })).toThrow("size must be a finite positive number");
  });
});
