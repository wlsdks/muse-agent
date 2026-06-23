/**
 * Tiny ANSI helper for the TTY-aware coloured output
 * on `muse today` and friends. Avoids a chalk / picocolors dep —
 * the surface we need is small (red / yellow / green / bold) and
 * a hand-rolled wrapper keeps the helper auditable.
 *
 * Behaviour matrix:
 *
 *   NO_COLOR set (any value)        → never colour (always wins)
 *   `force: true`                   → colour regardless of TTY (tests)
 *   process.stdout.isTTY === true   → colour
 *   process.stdout.isTTY undefined  → never colour (piped / CI)
 *
 * Returns the wrapped string when colour is active, the raw
 * string otherwise — callers don't have to branch.
 */

export type TerminalBackground = "dark" | "light" | "unknown";

export interface AnsiOptions {
  /** Override the TTY probe — useful for tests. */
  readonly isTty?: boolean;
  /** Force colour on even when isTty is false (rare; used in golden tests). */
  readonly force?: boolean;
  /** Override the detected terminal background — useful for tests. */
  readonly background?: TerminalBackground;
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
 * Decide whether colour output is currently allowed. Centralised
 * here so individual formatters call `if (!colorAllowed(...))` at
 * most once per render instead of duplicating the policy.
 */
export function colorAllowed(options: AnsiOptions = {}): boolean {
  // NO_COLOR wins unconditionally (https://no-color.org/).
  if (process.env.NO_COLOR !== undefined) return false;
  if (options.force) return true;
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
