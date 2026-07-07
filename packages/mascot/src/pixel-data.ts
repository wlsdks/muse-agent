/**
 * Canonical pixel data + palette for the Muse bluebird mascot (파랑새 — the
 * fairy-tale bird of happiness). This package is the SINGLE SOURCE OF TRUTH
 * for the matrices and palette; every surface renders from here:
 *
 * - the CLI (`@muse/cli`) imports this package and renders ANSI half-blocks,
 * - the README animated SVG is generated from this package (`toSvg`),
 * - `apps/web` keeps a local mirror (`components/pixel-bird.ts`) because it is
 *   deliberately OUT of the TypeScript project-reference graph (a Vite island
 *   with no `@muse/*` deps). A drift-guard test in `apps/web` reads THIS file
 *   as text and fails if the two ever diverge.
 *
 * Pure data only — no DOM, no deps. The bird is authored facing RIGHT on a
 * fixed 13x11 grid; the left facing is produced at render time with a mirror.
 */

export const GRID_W = 13;
export const GRID_H = 11;
export const PIXEL = 3;

/** char -> css color. "." is transparent (drawn as nothing). */
export const PALETTE: Readonly<Record<string, string>> = {
  ".": "transparent",
  B: "#8b9dff", // body — bright periwinkle-blue (pops on the near-black canvas)
  S: "#6b78e8", // wing/back — one step darker, same hue (a crescent, not a stain)
  W: "#f4f1ea", // belly / breast — warm white
  K: "#1b1e2e", // eye — soft near-black (a single pixel, high + forward)
  C: "#e79ab0", // blush cheek — soft muted pink
  A: "#f2c14e", // beak — warm yellow
  T: "#6b78e8", // tail — compact indigo tick (same shade as the wing)
  L: "#b7a98f" // legs — warm grey stubs
};

export const CHIRP_COLOR = "#828fff";

export type FrameName =
  | "stand"
  | "blink"
  | "hopUp"
  | "hopLand"
  | "tilt"
  | "peck"
  | "preen"
  | "tail"
  | "attend"
  | "flapA"
  | "flapB"
  | "stretch"
  | "ruffleA"
  | "ruffleB"
  | "doze"
  | "sing"
  | "droop";

/** Poses whose eye is shut — a 2px dark line instead of the single open pixel. */
export const CLOSED_EYE_FRAMES: ReadonlySet<FrameName> = new Set(["blink", "doze"]);

/** Every pose is a 13-wide x 11-tall grid of PALETTE chars. */
export const FRAMES: Readonly<Record<FrameName, readonly string[]>> = {
  stand: [
    "....BBBB.....",
    "...BBBBBB....",
    "..BBBBBBBB...",
    "..BBBBBBBB...",
    ".TBBBBBBKBB..",
    "TTBSBBBBBBA..",
    "..BSSBBBCB...",
    "..BBSWWWBB...",
    "...BBWWWB....",
    ".............",
    ".....L.L....."
  ],
  blink: [
    "....BBBB.....",
    "...BBBBBB....",
    "..BBBBBBBB...",
    "..BBBBBBBB...",
    ".TBBBBBKKBB..",
    "TTBSBBBBBBA..",
    "..BSSBBBCB...",
    "..BBSWWWBB...",
    "...BBWWWB....",
    ".............",
    ".....L.L....."
  ],
  hopUp: [
    "...BBBBBB....",
    "..BBBBBBBB...",
    "..BBBBBBBB...",
    ".TBBBBBBKBB..",
    "TTBSBBBBBBA..",
    "..BSSBBBCB...",
    "..BBSWWWBB...",
    "...BBWWWB....",
    ".............",
    ".............",
    "............."
  ],
  hopLand: [
    "....BBBB.....",
    "...BBBBBB....",
    "..BBBBBBBB...",
    "..BBBBBBBB...",
    ".TBBBBBBKBB..",
    "TTBSBBBBBBA..",
    "..BSSBBBCB...",
    "..BBSWWWBB...",
    "...BBWWWB....",
    ".............",
    "....L...L...."
  ],
  tilt: [
    "....BBBB.....",
    "...BBBBBB....",
    "..BBBBBBBB...",
    "..BBBBBBBB...",
    ".TBBBBBBBBB..",
    "TTBSBBBKBBB..",
    "..BSSBBCBBA..",
    "..BBSWWWBB...",
    "...BBWWWB....",
    ".............",
    ".....L.L....."
  ],
  peck: [
    "....BBBB.....",
    "...BBBBBB....",
    "..BBBBBBBB...",
    "..BBBBBBBB...",
    ".TBBBBBBBBB..",
    "TTBSBBBBKBB..",
    "..BSSBBCBB...",
    "..BBSWWWBBAA.",
    "...BBWWWB....",
    ".............",
    ".....L.L....."
  ],
  preen: [
    ".............",
    "...BBBBBB....",
    "..BBBBBBBB...",
    "..BBBBBBBB...",
    ".TBSBBBBBBB..",
    "TTBSBKCBBBB..",
    "..BBABBBBB...",
    "..BBSWWWBB...",
    "...BBWWWB....",
    "....BBBB.....",
    ".....L.L....."
  ],
  tail: [
    "....BBBB.....",
    "...BBBBBB....",
    "..BBBBBBBB...",
    ".TBBBBBBBB...",
    "TTBBBBBBKBB..",
    "TTBSBBBBBBA..",
    "..BSSBBBCB...",
    "..BBSWWWBB...",
    "...BBWWWB....",
    ".............",
    ".....L.L....."
  ],
  attend: [
    "....BBBB.....",
    "...BBBBBB....",
    "..BBBBBBBB...",
    "..BBBBBBKB...",
    ".TBBBBBBBBA..",
    "TTBSBBBBCBB..",
    "..BSSBBBBB...",
    "..BBSWWWBB...",
    "...BBWWWB....",
    ".............",
    ".....L.L....."
  ],
  flapA: [
    "....BBBB.....",
    "...BBBBBB....",
    ".SBBBBBBBBS..",
    "..BBBBBBBB...",
    ".TBBBBBBKBB..",
    "TTBSBBBBBBA..",
    "..BSSBBBCB...",
    "..BBSWWWBB...",
    "...BBWWWB....",
    ".............",
    ".....L.L....."
  ],
  flapB: [
    "....BBBB.....",
    "...BBBBBB....",
    "..BBBBBBBB...",
    "..BBBBBBBB...",
    "STBBBBBBKBBS.",
    "TTBSBBBBBBA..",
    "..BSSBBBCB...",
    "..BBSWWWBB...",
    "...BBWWWB....",
    ".............",
    ".....L.L....."
  ],
  stretch: [
    "....BBBB.....",
    "...BBBBBB....",
    "..BBBBBBBB...",
    "..BBBBBBBB...",
    ".TBBBBBBKBB..",
    "TTBSBBBBBBA..",
    ".SBSSBBBCB...",
    "SBBBSWWWBB...",
    "...BBWWWB....",
    "..L..........",
    ".......L....."
  ],
  ruffleA: [
    ".....BBBB....",
    "....BBBBBB...",
    "...BBBBBBBB..",
    "...BBBBBBBB..",
    ".TBBBBBBBKBB.",
    "TTBBSBBBBBBA.",
    "..SBSBBBBCB..",
    "...BBSWWWBB..",
    "....BBWWWB...",
    ".............",
    ".....L.L....."
  ],
  ruffleB: [
    "...BBBB......",
    "..BBBBBB.....",
    ".BBBBBBBB....",
    ".BBBBBBBB....",
    "TBBBBBBKBB...",
    "TBSBBBBBBAS..",
    ".BSSBBBCB....",
    ".BBSWWWBBS...",
    "..BBWWWB.....",
    ".............",
    ".....L.L....."
  ],
  doze: [
    ".............",
    "....BBBB.....",
    "...BBBBBB....",
    "..BBBBBBBB...",
    "..BBBBBBBB...",
    ".TBBBBKKBBA..",
    "TTBSBBBBBB...",
    "..BSSBBBCB...",
    "..BBSWWWBB...",
    "...BBWWWB....",
    "............."
  ],
  sing: [
    "....BBBB.....",
    "...BBBBBB....",
    "..BBBBBBBB...",
    "..BBBBBBBB...",
    ".TBBBBBBKBB..",
    "TTBSBBBBBBA..",
    "..BSSBBBCBA..",
    "..BBSWWWBB...",
    "...BBWWWB....",
    ".............",
    ".....L.L....."
  ],
  droop: [
    ".............",
    "....BBBB.....",
    "...BBBBBB....",
    "..BBBBBBBB...",
    "..BBBBBBBB...",
    ".TBBBBBBKB...",
    "TTBSBBBBCBA..",
    "..BSSWWWBB...",
    "..BBWWWBB....",
    "...BBWB......",
    ".....L.L....."
  ]
};

/** Chirp accents that pop above the head on a completed response. */
export const CHIRP_W = 6;
export const CHIRP_H = 4;
export const CHIRP_FRAME: readonly string[] = [
  "CC....",
  "CC..CC",
  "....CC",
  "......"
];

/**
 * Quiet accents that are deliberately NOT the bright chirp indigo:
 * - `MUTED_ACCENT` — the sleepy "z" and the self-amused song notes.
 * - `HEART_COLOR` — the reserved celebrate() pop (a warm pink).
 */
export const MUTED_ACCENT = "#8a8f98";
export const HEART_COLOR = "#f2789f";

/** A tiny sleepy "z" that blinks above a dozing bird. */
export const ZZZ_FRAME: readonly string[] = ["ZZZ", ".Z.", "ZZZ"];
/** A small eighth-note that drifts up while the bird sings to itself. */
export const NOTE_FRAME: readonly string[] = [".N", ".N", "NN"];
/** A 5x5 pixel heart for the reserved celebrate() hook. */
export const HEART_FRAME: readonly string[] = [".H.H.", "HHHHH", "HHHHH", ".HHH.", "..H.."];

/** Validate a matrix: rectangular at the expected dims, palette-clean. */
export function validateFrame(
  frame: readonly string[],
  palette: Readonly<Record<string, string>>,
  width: number,
  height: number
): { ok: boolean; reason?: string } {
  if (frame.length !== height) {
    return { ok: false, reason: `height ${frame.length} != ${height}` };
  }
  for (let r = 0; r < frame.length; r++) {
    const row = frame[r]!;
    if (row.length !== width) {
      return { ok: false, reason: `row ${r} width ${row.length} != ${width}` };
    }
    for (const ch of row) {
      if (!(ch in palette)) {
        return { ok: false, reason: `row ${r} has char '${ch}' outside palette` };
      }
    }
  }
  return { ok: true };
}
