/**
 * The Muse mascot for the terminal — the bluebird (파랑새), rendered as ANSI
 * truecolor half-blocks straight from the canonical pixel data in
 * `@muse/mascot`. Single source of truth: the same matrices drive the web
 * desk-pet, the favicon, and the README's animated SVG.
 *
 * The 13x11 grid becomes 13 columns x 6 lines; the wordmark below spells MUSE.
 */

import { FRAMES, toAnsi } from "@muse/mascot";

/** The bird standing (open eye), 6 half-block lines. */
export const MUSE_BIRD_ANSI: string = toAnsi(FRAMES.stand);
/** The bird mid-blink — used for the one-shot `muse logo` blink animation. */
export const MUSE_BIRD_BLINK_ANSI: string = toAnsi(FRAMES.blink);

/** Rows the rendered bird occupies (for cursor-based redraws). */
export const MUSE_BIRD_ROWS = MUSE_BIRD_ANSI.split("\n").length;

/** Block-art wordmark spelling MUSE (6 lines), colour-agnostic. */
export const MUSE_WORDMARK: readonly string[] = [
  "███╗   ███╗██╗   ██╗███████╗███████╗",
  "████╗ ████║██║   ██║██╔════╝██╔════╝",
  "██╔████╔██║██║   ██║███████╗█████╗  ",
  "██║╚██╔╝██║██║   ██║╚════██║██╔══╝  ",
  "██║ ╚═╝ ██║╚██████╔╝███████║███████╗",
  "╚═╝     ╚═╝ ╚═════╝ ╚══════╝╚══════╝"
];

/**
 * Compose the bird beside the wordmark — both are 6 lines tall, so they sit
 * side by side. `tintWordmark` lets a caller colour the wordmark; the bird
 * carries its own truecolour.
 */
export function renderMuseLogoLines(
  gap = "   ",
  tintWordmark: (line: string) => string = (line) => line
): string[] {
  const bird = MUSE_BIRD_ANSI.split("\n");
  const rows = Math.max(bird.length, MUSE_WORDMARK.length);
  const lines: string[] = [];
  for (let i = 0; i < rows; i++) {
    const left = bird[i] ?? "";
    const right = MUSE_WORDMARK[i];
    lines.push(right === undefined ? left : `${left}${gap}${tintWordmark(right)}`);
  }
  return lines;
}
