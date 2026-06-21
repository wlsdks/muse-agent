/**
 * The REPL splash banner. When colour is active it shows the Muse mascot —
 * the goddess — as terminal art; piped / NO_COLOR output falls back to a
 * plain-text wordmark so a captured REPL log stays free of escape codes.
 */

import { MUSE_MASCOT_ANSI } from "./muse-mascot-ansi.js";
import { MUSE_TAGLINE } from "./muse-identity.js";
import { colorize, colorAllowed, type AnsiOptions } from "./tty-color.js";

const WORDMARK = [
  "███╗   ███╗██╗   ██╗███████╗███████╗",
  "████╗ ████║██║   ██║██╔════╝██╔════╝",
  "██╔████╔██║██║   ██║███████╗█████╗  ",
  "██║╚██╔╝██║██║   ██║╚════██║██╔══╝  ",
  "██║ ╚═╝ ██║╚██████╔╝███████║███████╗",
  "╚═╝     ╚═╝ ╚═════╝ ╚══════╝╚══════╝"
];

export interface MuseBannerOptions extends AnsiOptions {
  /** Short status line rendered under the wordmark (user / model / tools). */
  readonly status?: string;
  /** Optional second status line (e.g. remembered-facts hint). */
  readonly subStatus?: string;
  /** Optional final hint line (e.g. "/help for commands"). */
  readonly hint?: string;
}

/**
 * Render the multi-line Muse REPL banner. The caller prints the
 * returned string verbatim; it already carries its own leading and
 * trailing blank lines so the prompt that follows has room to breathe.
 */
export function renderMuseBanner(options: MuseBannerOptions = {}): string {
  const tint = (value: string, color: Parameters<typeof colorize>[1]): string => colorize(value, color, options);

  const tagline = tint(MUSE_TAGLINE, "dim");
  const rule = tint("─".repeat(38), "cyan");

  const art = colorAllowed(options)
    ? MUSE_MASCOT_ANSI.split("\n").map((line) => `  ${line}`)
    : [`   ${tint("♪ ♫ ♬", "cyan")}`, ...WORDMARK.map((line) => `   ${tint(line, "cyan")}`)];

  const lines: string[] = [
    "",
    ...art,
    `   ${tagline}`,
    `   ${rule}`
  ];

  if (options.status) {
    lines.push(`   ${tint(options.status, "dim")}`);
  }
  if (options.subStatus) {
    lines.push(`   ${tint(options.subStatus, "dim")}`);
  }
  if (options.hint) {
    lines.push(`   ${tint(options.hint, "dim")}`);
  }
  lines.push("");
  return lines.join("\n");
}
