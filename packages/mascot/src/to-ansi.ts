/**
 * Render a pixel matrix to ANSI truecolor half-blocks for the terminal.
 *
 * Two grid rows are packed into ONE text line using the upper-half-block
 * glyph `▀`: its foreground paints the UPPER pixel, its background the LOWER
 * pixel. A 13x11 grid therefore becomes 13 columns x 6 lines. Transparent
 * pixels fall back to the terminal's own background (a reset), so the bird
 * floats on whatever the terminal colour is.
 */

import { PALETTE } from "./pixel-data.js";

const UPPER_HALF = "▀"; // ▀ — fg = upper pixel, bg = lower pixel
const LOWER_HALF = "▄"; // ▄ — fg = lower pixel (used when the upper pixel is transparent)
const RESET = "\x1b[0m";

function rgb(color: string): [number, number, number] {
  const m = color.replace("#", "");
  return [parseInt(m.slice(0, 2), 16), parseInt(m.slice(2, 4), 16), parseInt(m.slice(4, 6), 16)];
}

function fg([r, g, b]: [number, number, number]): string {
  return `\x1b[38;2;${r};${g};${b}m`;
}

function bg([r, g, b]: [number, number, number]): string {
  return `\x1b[48;2;${r};${g};${b}m`;
}

function colorAt(
  frame: readonly string[],
  palette: Readonly<Record<string, string>>,
  row: number,
  col: number
): string | null {
  const line = frame[row];
  if (line === undefined) {
    return null;
  }
  const ch = line[col];
  if (ch === undefined) {
    return null;
  }
  const color = palette[ch];
  if (!color || color === "transparent") {
    return null;
  }
  return color;
}

/**
 * Turn a pixel matrix into a multi-line ANSI string (no trailing newline).
 * Each output line is a reset-terminated run of half-block cells; transparent
 * cells emit a plain space so the terminal background shows through.
 */
export function toAnsi(
  frame: readonly string[],
  palette: Readonly<Record<string, string>> = PALETTE
): string {
  const height = frame.length;
  const width = frame.reduce((w, line) => Math.max(w, line.length), 0);
  const out: string[] = [];

  for (let top = 0; top < height; top += 2) {
    let line = "";
    for (let col = 0; col < width; col++) {
      const upper = colorAt(frame, palette, top, col);
      const lower = colorAt(frame, palette, top + 1, col);

      if (upper && lower) {
        line += `${fg(rgb(upper))}${bg(rgb(lower))}${UPPER_HALF}${RESET}`;
      } else if (upper) {
        line += `${fg(rgb(upper))}${UPPER_HALF}${RESET}`;
      } else if (lower) {
        line += `${fg(rgb(lower))}${LOWER_HALF}${RESET}`;
      } else {
        line += " ";
      }
    }
    out.push(line);
  }

  return out.join("\n");
}
