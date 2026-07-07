/**
 * The REPL splash banner. When colour is active it shows the Muse mascot —
 * the bluebird — beside the MUSE wordmark; piped / NO_COLOR output falls back
 * to a plain-text wordmark so a captured REPL log stays free of escape codes.
 */

import { MUSE_TAGLINE } from "./muse-identity.js";
import { MUSE_WORDMARK, renderMuseLogoLines } from "./muse-mascot.js";
import { colorize, colorAllowed, type AnsiOptions } from "./tty-color.js";

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

  // Bird + wordmark + tagline + status lines share a 2-space indent so the
  // whole splash reads as one left-aligned column.
  const art = colorAllowed(options)
    ? renderMuseLogoLines("   ", (line) => tint(line, "cyan")).map((line) => `  ${line}`)
    : MUSE_WORDMARK.map((line) => `  ${tint(line, "cyan")}`);

  const lines: string[] = [
    "",
    ...art,
    `  ${tagline}`
  ];

  if (options.status) {
    lines.push(`  ${tint(options.status, "dim")}`);
  }
  if (options.subStatus) {
    lines.push(`  ${tint(options.subStatus, "dim")}`);
  }
  if (options.hint) {
    lines.push(`  ${tint(options.hint, "dim")}`);
  }
  lines.push("");
  return lines.join("\n");
}
