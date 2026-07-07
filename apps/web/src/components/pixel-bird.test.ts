import { describe, expect, it } from "vitest";

import {
  BIRD_H,
  BIRD_W,
  CHIRP_FRAME,
  CHIRP_H,
  CHIRP_W,
  chirpBoxShadow,
  CLOSED_EYE_FRAMES,
  frameToBoxShadow,
  FRAMES,
  GRID_H,
  GRID_W,
  HEART_COLOR,
  HEART_FRAME,
  heartBoxShadow,
  MUTED_ACCENT,
  NOTE_FRAME,
  noteBoxShadow,
  PALETTE,
  PIXEL,
  validateFrame,
  ZZZ_FRAME,
  zzzBoxShadow
} from "./pixel-bird.js";

import type { FrameName } from "./pixel-bird.js";

describe("pixel-bird matrices", () => {
  it("every pose is a 13x11 grid with only palette chars", () => {
    expect(GRID_W).toBe(13);
    expect(GRID_H).toBe(11);
    for (const [name, frame] of Object.entries(FRAMES)) {
      const result = validateFrame(frame, PALETTE, GRID_W, GRID_H);
      expect(result.ok, `${name}: ${result.reason ?? ""}`).toBe(true);
    }
  });

  it("stays within the composer's reserved 42x36 css px footprint", () => {
    expect(BIRD_W).toBeLessThanOrEqual(42);
    expect(BIRD_H).toBeLessThanOrEqual(36);
  });

  it("the chirp overlay matches its declared dims", () => {
    const result = validateFrame(CHIRP_FRAME, { ".": "transparent", C: "#828fff" }, CHIRP_W, CHIRP_H);
    expect(result.ok, result.reason).toBe(true);
  });

  it("derived render dims are consistent", () => {
    expect(BIRD_W).toBe(GRID_W * PIXEL);
    expect(BIRD_H).toBe(GRID_H * PIXEL);
  });

  it("each pose carries the bluebird's identity pixels (tail T, beak A, belly W, dark eye K, blush C)", () => {
    for (const [name, frame] of Object.entries(FRAMES)) {
      const flat = frame.join("");
      expect(flat.includes("T"), `${name} has a perky tail`).toBe(true);
      expect(flat.includes("A"), `${name} has a beak`).toBe(true);
      expect(flat.includes("W"), `${name} has a warm-white belly`).toBe(true);
      expect(flat.includes("K"), `${name} has a dark eye`).toBe(true);
      expect(flat.includes("C"), `${name} has a blush cheek`).toBe(true);
    }
    // Standing/idle poses stand on two leg stubs (hop frames tuck them).
    expect(FRAMES.stand.join("").includes("L")).toBe(true);
  });

  it("open poses use a single dark eye pixel; closed-eye poses (blink, doze) show a 2px line", () => {
    // Suggestion beats detail: the eye is ONE dark pixel per row when open.
    // A shut eye — the happy blink squint, or the sleeping doze — is the only
    // case with two dark eye pixels side-by-side (a closed-eye line).
    const eyePixelsPerRow = (frame: readonly string[]) =>
      Math.max(...frame.map((row) => (row.match(/K/g) ?? []).length));
    for (const [name, frame] of Object.entries(FRAMES)) {
      const widest = eyePixelsPerRow(frame);
      if (CLOSED_EYE_FRAMES.has(name as FrameName)) {
        expect(widest, `${name} closes the eye to a 2px line`).toBe(2);
      } else {
        expect(widest, `${name} keeps a single open dark eye pixel`).toBe(1);
      }
    }
    expect(CLOSED_EYE_FRAMES.has("doze")).toBe(true);
  });

  it("ships the full mascot motion library (idle variations + reactions)", () => {
    for (const pose of ["flapA", "flapB", "stretch", "ruffleA", "ruffleB", "doze", "sing", "droop"] as const) {
      expect(FRAMES[pose], `${pose} pose exists`).toBeDefined();
      expect(validateFrame(FRAMES[pose], PALETTE, GRID_W, GRID_H).ok).toBe(true);
    }
  });

  it("validateFrame rejects wrong height, wrong width, and stray chars", () => {
    expect(validateFrame(["...."], PALETTE, 4, 2).ok).toBe(false); // height
    expect(validateFrame([".", "."], PALETTE, 4, 2).ok).toBe(false); // width
    expect(validateFrame(["Z...", "...."], PALETTE, 4, 2).ok).toBe(false); // stray char
    expect(validateFrame(["....", "...."], PALETTE, 4, 2).ok).toBe(true);
  });
});

describe("frameToBoxShadow", () => {
  it("emits one PIXEL-offset shadow per non-transparent cell, skipping dots", () => {
    const shadow = frameToBoxShadow(["A.", ".A"], { ".": "transparent", A: "#d9a441" }, 3);
    // (0,0) and (1,1) are painted; the two dots are not.
    expect(shadow).toBe("0px 0px 0 0 #d9a441, 3px 3px 0 0 #d9a441");
  });

  it("a fully transparent frame paints nothing", () => {
    expect(frameToBoxShadow(["..", ".."], PALETTE, 3)).toBe("");
  });

  it("the stand pose produces a non-empty shadow list", () => {
    expect(frameToBoxShadow(FRAMES.stand).length).toBeGreaterThan(0);
  });

  it("chirpBoxShadow renders the accent blobs", () => {
    expect(chirpBoxShadow(3)).toContain("#828fff");
  });
});

describe("mascot overlays (zzz / note / heart)", () => {
  it("the doze z and the sing notes render in the muted accent — never the bright chirp", () => {
    const zzz = zzzBoxShadow(3);
    const note = noteBoxShadow(3);
    expect(zzz).toContain(MUTED_ACCENT);
    expect(note).toContain(MUTED_ACCENT);
    // Muted, not the "response arrived!" chirp indigo.
    expect(zzz).not.toContain("#828fff");
    expect(note).not.toContain("#828fff");
  });

  it("the celebrate heart renders in the warm heart pink", () => {
    expect(heartBoxShadow(3)).toContain(HEART_COLOR);
  });

  it("overlay matrices are rectangular", () => {
    expect(validateFrame(ZZZ_FRAME, { ".": "transparent", Z: MUTED_ACCENT }, ZZZ_FRAME[0]!.length, ZZZ_FRAME.length).ok).toBe(true);
    expect(validateFrame(NOTE_FRAME, { ".": "transparent", N: MUTED_ACCENT }, NOTE_FRAME[0]!.length, NOTE_FRAME.length).ok).toBe(true);
    expect(validateFrame(HEART_FRAME, { ".": "transparent", H: HEART_COLOR }, HEART_FRAME[0]!.length, HEART_FRAME.length).ok).toBe(true);
  });
});
