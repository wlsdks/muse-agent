/**
 * The REPL splash banner. "Muse" is the Greek goddesses of the arts —
 * music among them — so the banner leans on a musical motif (notes +
 * a staff rule). Colour-aware: plain text when piped / NO_COLOR set,
 * so a captured / redirected REPL log stays free of escape codes.
 */

import { colorize, type AnsiOptions } from "./tty-color.js";

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

  const notes = tint("♪ ♫ ♬", "cyan");
  const tagline = tint("your personal AI agent & assistant", "dim");
  const rule = tint("─".repeat(38), "cyan");

  const lines: string[] = [
    "",
    `   ${notes}`,
    ...WORDMARK.map((line) => `   ${tint(line, "cyan")}`),
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
