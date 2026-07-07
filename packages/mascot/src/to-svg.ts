/**
 * Render the mascot to a self-contained ANIMATED SVG for the README.
 *
 * GitHub strips `<script>` from Markdown but DOES run CSS `@keyframes` inside
 * an SVG referenced via `<img>` (the classic "animated SVG in a README"
 * trick). So the animation is pure CSS: one `<g>` per unique pose, its
 * opacity toggled by a generated step-function keyframe so exactly one pose
 * is visible at a time. No external refs, no SMIL, no script — camo-safe.
 */

import { FRAMES, GRID_H, GRID_W, PALETTE, type FrameName } from "./pixel-data.js";

/** The default idle loop: mostly standing, with a blink and a head-tilt. */
export const DEFAULT_SEQUENCE: readonly FrameName[] = [
  "stand",
  "stand",
  "blink",
  "stand",
  "stand",
  "tilt"
];

export interface SvgOptions {
  /** Ordered, equal-weight pose slots to cycle through. */
  readonly sequence?: readonly FrameName[];
  /** Total loop duration in seconds. */
  readonly durationSec?: number;
  /** Intrinsic pixel size of the SVG (a hint; the <img> width can override). */
  readonly size?: number;
}

const EPS = 0.01;

function rectsFor(frame: readonly string[], palette: Readonly<Record<string, string>>): string {
  const rects: string[] = [];
  for (let r = 0; r < frame.length; r++) {
    const row = frame[r]!;
    for (let c = 0; c < row.length; c++) {
      const color = palette[row[c]!];
      if (!color || color === "transparent") {
        continue;
      }
      rects.push(`<rect x="${c}" y="${r}" width="1" height="1" fill="${color}"/>`);
    }
  }
  return rects.join("");
}

/** Build a step-function opacity keyframe (1 during the pose's slots, else 0). */
function keyframesFor(name: string, onWindows: ReadonlyArray<[number, number]>): string {
  const inWindow = (p: number): boolean => onWindows.some(([s, e]) => p >= s && p < e);
  const stops: string[] = [];
  const push = (pct: number, op: number): void => {
    const clamped = Math.max(0, Math.min(100, pct));
    const stop = `${clamped.toFixed(2)}%{opacity:${op}}`;
    if (stops[stops.length - 1] !== stop) {
      stops.push(stop);
    }
  };

  push(0, inWindow(0) ? 1 : 0);
  for (const [s, e] of onWindows) {
    if (s > 0) {
      push(s - EPS, 0);
    }
    push(s, 1);
    push(e - EPS, 1);
    if (e < 100) {
      push(e, 0);
    }
  }
  push(100, inWindow(100 - EPS) ? 1 : 0);

  return `@keyframes ${name}{${stops.join("")}}`;
}

export function toSvg(options: SvgOptions = {}): string {
  const sequence = options.sequence ?? DEFAULT_SEQUENCE;
  const duration = options.durationSec ?? 3;
  const size = options.size ?? 128;
  const n = sequence.length;
  const slotPct = 100 / n;

  const unique: FrameName[] = [];
  for (const f of sequence) {
    if (!unique.includes(f)) {
      unique.push(f);
    }
  }

  const styles: string[] = [];
  const groups: string[] = [];

  for (const f of unique) {
    const windows: Array<[number, number]> = [];
    sequence.forEach((slot, i) => {
      if (slot !== f) {
        return;
      }
      const start = i * slotPct;
      const end = (i + 1) * slotPct;
      const last = windows[windows.length - 1];
      // Merge adjacent same-pose slots so a held pose stays ON continuously
      // (otherwise the shared boundary flickers the pose off for one frame).
      if (last && Math.abs(last[1] - start) < EPS) {
        last[1] = end;
      } else {
        windows.push([start, end]);
      }
    });
    const kfName = `mm_${f}`;
    styles.push(keyframesFor(kfName, windows));
    styles.push(`.${kfName}{animation:${kfName} ${duration}s linear infinite}`);
    groups.push(`<g class="${kfName}">${rectsFor(FRAMES[f], PALETTE)}</g>`);
  }

  const height = Math.round((size * GRID_H) / GRID_W);

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${GRID_W} ${GRID_H}" width="${size}" height="${height}" shape-rendering="crispEdges" role="img" aria-label="Muse bluebird mascot">`,
    `<style>${styles.join("")}</style>`,
    groups.join(""),
    `</svg>`,
    ``
  ].join("\n");
}
