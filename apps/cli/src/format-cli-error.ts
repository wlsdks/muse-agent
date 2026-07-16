import { isErrorLike, redactSecretsInText } from "@muse/shared";
/**
 * Actionable top-level error formatting (clig.dev "Errors").
 *
 * Two jobs:
 *   1. EXPECTED errors (a user mistake, a known operational condition such as
 *      the API being unreachable) → a clean one-line `muse:` message that
 *      already carries its next-step hint. No stack, no "report a bug".
 *   2. UNEXPECTED errors (a genuine defect — a programmer-error type or an
 *      error with no message) → a short message PLUS a pre-filled GitHub
 *      issue URL carrying the version + command so the user can report it in
 *      one click.
 *
 * Pure + exported so the classification and the rendered text are gradeable
 * without spawning the CLI. Wired into the entrypoint's `parseAsync` catch so
 * EVERY command's uncaught failure is humane and exits non-zero.
 */

import { isApiUnreachable } from "./program-helpers.js";

const ISSUE_TRACKER_URL = "https://github.com/wlsdks/Muse/issues/new";

/**
 * Built-in error subclasses that signal a DEFECT (not a user mistake): a
 * TypeError / ReferenceError / etc. is a bug in Muse, so it earns the
 * report-a-bug footer. A plain `Error("--image requires --local")` is an
 * intentional user-facing message and stays clean.
 *
 * `SyntaxError` is deliberately NOT here: at CLI runtime it means bad JSON the
 * user supplied (a `--config`/`--args` flag or a corrupt config file), which is
 * user-fixable — genuine source syntax errors fail at module load, never reach
 * this handler. So a SyntaxError gets a fix-it hint, not the bug-report URL.
 */
const PROGRAMMER_ERROR_NAMES: ReadonlySet<string> = new Set([
  "TypeError",
  "RangeError",
  "ReferenceError",
  "EvalError",
  "URIError"
]);

/**
 * Canonical one-line envelope for an EXPECTED, user-facing failure raised from
 * INSIDE a command handler (not the top-level catch): the same
 * `muse <cmd>: <message>` prefix shape the top-level formatter uses, minus the
 * bug-report footer — these are known operational conditions (a missing file, an
 * unknown id), never defects. Pure: it only builds the newline-terminated line so
 * the prefix stays consistent across commands; the CALLER keeps ownership of the
 * exit code and the stream (errors go to `io.stderr`), so a `--json` failure that
 * must leave stdout empty and the exit code each site already sets are preserved.
 */
export function commandErrorLine(command: string, message: string): string {
  return `muse ${command}: ${message}\n`;
}

export interface FormatCliErrorOptions {
  /** Muse CLI version stamped into the bug-report URL. */
  readonly version?: string;
  /** The command the user ran (e.g. "ask"), stamped into the bug-report URL. */
  readonly command?: string;
}

/**
 * The first non-flag argv token — the command the user was running. Pure so
 * the entrypoint can derive a bug-report subject without duplicating parsing.
 * `argv` is the raw `process.argv` (node + script + args); returns undefined
 * when only global flags were passed (a bare `muse --oops`).
 */
export function commandFromArgv(argv: readonly string[]): string | undefined {
  for (const token of argv.slice(2)) {
    if (token.startsWith("-")) continue;
    return token;
  }
  return undefined;
}

/**
 * True when the error is a known / expected condition we can present cleanly
 * (no bug-report footer). API-unreachable is expected; so is any plain `Error`
 * with a real message that isn't a programmer-error subclass.
 */
export function isExpectedCliError(error: unknown): boolean {
  if (isApiUnreachable(error)) return true;
  if (!(isErrorLike(error))) return false;
  if (PROGRAMMER_ERROR_NAMES.has(error.name)) return false;
  return typeof error.message === "string" && error.message.trim().length > 0;
}

function errorMessage(error: unknown): string {
  if (isErrorLike(error)) {
    return error.message.trim().length > 0 ? error.message : error.name;
  }
  return String(error);
}

/**
 * Build a pre-filled GitHub "new issue" URL carrying the version, command, and
 * error so a bug report is one click away with the essentials already in it.
 */
export function bugReportUrl(errorText: string, options: FormatCliErrorOptions = {}): string {
  const version = options.version ?? "unknown";
  const command = (options.command ?? "").trim() || "<command>";
  const redactedErrorText = redactSecretsInText(errorText);
  const firstLine = redactedErrorText.split("\n")[0]?.slice(0, 120) ?? redactedErrorText;
  const title = `[bug] muse ${command}: ${firstLine}`;
  const body = [
    `**Command:** \`muse ${command}\``,
    `**Version:** ${version}`,
    "",
    "**Error:**",
    "```",
    redactedErrorText,
    "```",
    "",
    "**What I expected / steps to reproduce:**",
    ""
  ].join("\n");
  const params = new URLSearchParams({
    body: redactSecretsInText(body),
    title: redactSecretsInText(title)
  });
  return `${ISSUE_TRACKER_URL}?${params.toString()}`;
}

/**
 * Render an uncaught CLI error to the exact stderr text (newline-terminated).
 * Expected errors are one clean line; unexpected errors add the report footer.
 */
export function formatCliError(error: unknown, options: FormatCliErrorOptions = {}): string {
  const message = errorMessage(error);
  if (isExpectedCliError(error)) {
    if (isErrorLike(error) && error.name === "SyntaxError") {
      return `muse: invalid JSON — ${message}\n`;
    }
    return `muse: ${message}\n`;
  }
  const version = options.version ?? "unknown";
  const url = bugReportUrl(message, options);
  return [
    `muse: ${message}`,
    "",
    `This looks like an unexpected error in Muse (v${version}). Please report it:`,
    `  ${url}`,
    ""
  ].join("\n");
}
