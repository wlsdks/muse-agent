/**
 * Tiny ANSI helper for the TTY-aware coloured output
 * on `muse today` and friends. Avoids a chalk / picocolors dep —
 * the surface we need is small (red / yellow / green / bold) and
 * a hand-rolled wrapper keeps the helper auditable.
 *
 * Precedence (highest first — clig.dev colour discipline):
 *
 *   NO_COLOR set (any value)        → never  (https://no-color.org/)
 *   --no-color requested            → never  (explicit user request beats FORCE_COLOR)
 *   FORCE_COLOR truthy              → always (https://force-color.org/)
 *   `force: true`                   → always (test-only force, same tier)
 *   TERM=dumb                       → never  (no ANSI capability)
 *   else process.stdout.isTTY       → colour when a TTY, plain when piped/CI
 *
 * Returns the wrapped string when colour is active, the raw
 * string otherwise — callers don't have to branch.
 */

import { isColorDisabled } from "./cli-context.js";

export type TerminalBackground = "dark" | "light" | "unknown";

export interface AnsiOptions {
  /** Override the TTY probe — useful for tests. */
  readonly isTty?: boolean;
  /** Force colour on even when isTty is false (rare; used in golden tests). */
  readonly force?: boolean;
  /** Override the detected terminal background — useful for tests. */
  readonly background?: TerminalBackground;
  /** Override the environment read — defaults to `process.env`. Pure-test seam. */
  readonly env?: NodeJS.ProcessEnv;
  /**
   * Override the `--no-color` signal — defaults to the shared cli-context.
   * Lets `colorAllowed` stay a pure function under test.
   */
  readonly noColor?: boolean;
}

/**
 * Detect the terminal's background lightness from `COLORFGBG` (set by
 * many terminals as `"<fg>;<bg>"`, e.g. rxvt/xterm/Konsole). Used to
 * avoid near-invisible low-contrast output on a light theme. Returns
 * "unknown" when the variable is absent or unparseable — callers then
 * keep their default behaviour. Pure (env passed in for testability).
 */
export function detectTerminalBackground(env: NodeJS.ProcessEnv = process.env): TerminalBackground {
  const raw = env.COLORFGBG;
  if (!raw) return "unknown";
  // "fg;bg" or rxvt's "fg;;bg" — the background is the LAST field. A
  // single field is just a foreground and tells us nothing about the bg.
  const fields = raw.split(";").map((f) => f.trim()).filter((f) => f.length > 0);
  if (fields.length < 2) return "unknown";
  const bg = Number(fields[fields.length - 1]);
  if (!Number.isInteger(bg)) return "unknown";
  // De-facto COLORFGBG convention over the 16-colour palette: 7 and
  // 9–15 are light shades; 0–6 and 8 are dark.
  if (bg === 7 || (bg >= 9 && bg <= 15)) return "light";
  if ((bg >= 0 && bg <= 6) || bg === 8) return "dark";
  return "unknown";
}

const RESET = "\x1b[0m";
const COLORS: Readonly<Record<string, string>> = {
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  green: "\x1b[32m",
  cyan: "\x1b[36m",
  bold: "\x1b[1m",
  dim: "\x1b[2m"
};

/**
 * True when `FORCE_COLOR` is set to a truthy value per force-color.org:
 * absent / `""` / `"0"` / `"false"` are falsy; `"1"`/`"2"`/`"3"`/`"true"`
 * (or any other non-falsy string) force colour on.
 */
function forceColorRequested(env: NodeJS.ProcessEnv): boolean {
  const raw = env.FORCE_COLOR;
  if (raw === undefined) return false;
  const value = raw.trim().toLowerCase();
  return value !== "" && value !== "0" && value !== "false";
}

/**
 * Decide whether colour output is currently allowed. Centralised
 * here so individual formatters call `if (!colorAllowed(...))` at
 * most once per render instead of duplicating the policy. See the
 * precedence table at the top of the file.
 */
export function colorAllowed(options: AnsiOptions = {}): boolean {
  const env = options.env ?? process.env;
  // 1. NO_COLOR wins unconditionally (https://no-color.org/).
  if (env.NO_COLOR !== undefined) return false;
  // 2. An explicit --no-color request (via cli-context) beats FORCE_COLOR — a
  // user who typed --no-color means it even if the env has FORCE_COLOR set.
  if ((options.noColor ?? isColorDisabled()) === true) return false;
  // 3. FORCE_COLOR (or the test-only `force`) forces colour on.
  if (forceColorRequested(env) || options.force) return true;
  // 4. A dumb terminal has no ANSI capability.
  if ((env.TERM ?? "").toLowerCase() === "dumb") return false;
  // 5. Otherwise colour only when attached to a TTY.
  return options.isTty ?? process.stdout.isTTY === true;
}

/**
 * Wrap `value` in the named ANSI sequence when colour is active,
 * otherwise return it unchanged. Unknown color names pass through
 * untouched so a typo doesn't crash a render.
 */
export function colorize(value: string, color: keyof typeof COLORS, options: AnsiOptions = {}): string {
  if (!colorAllowed(options)) return value;
  // `dim` (grey) is near-invisible on a light terminal background; render
  // it plain there rather than as unreadable low-contrast text. Only kicks
  // in when the background is KNOWN light — unknown keeps current behaviour.
  if (color === "dim" && (options.background ?? detectTerminalBackground()) === "light") {
    return value;
  }
  const code = COLORS[color];
  if (!code) return value;
  return `${code}${value}${RESET}`;
}
