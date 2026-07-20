/**
 * Bridge to `muse-mac-helper`, the bundled Swift binary that reads macOS state
 * through Apple's native frameworks instead of driving GUI apps.
 *
 * Why a binary at all (measured on macOS 26.5, 2026-07-20):
 *   • Contacts via AppleScript: 3,273 ms AND it launches Contacts.app.
 *     Through Contacts.framework: 131-175 ms, no GUI.
 *   • A window snapshot with titles and geometry: ~230 ms / ~1.7 KB. The
 *     screenshot it replaces is 1.9 MB — three orders of magnitude of context
 *     for the same question ("what is on screen?").
 *   • AppleScript cannot answer window GEOMETRY at all; System Events gives a
 *     process list in ~412 ms and nothing about window position or size.
 *
 * The helper is READ-ONLY by construction — it has no subcommand that clicks,
 * types, or sets anything. That restraint is Muse's own: Apple gates AX reads
 * and AX control behind the SAME trust prompt, so nothing in macOS stops a
 * future subcommand from crossing the line. Keeping the binary read-only is
 * what makes "Accessibility is granted" a bounded statement.
 *
 * Absent helper ⇒ a typed `helper_unavailable`, never a throw: every caller
 * must be able to degrade to the AppleScript path rather than fail a turn.
 */

import { runChild, type MacCommandResult } from "./macos-exec.js";

/** Read-only subcommands. Deliberately an exact union — a new verb must be a
 *  conscious edit here, not something that slips in via a string. */
export const MAC_HELPER_READS = ["windows", "focus", "apps", "permissions"] as const;
export type MacHelperRead = (typeof MAC_HELPER_READS)[number];

export interface MacHelperWindow {
  readonly app: string;
  readonly focused: boolean;
  readonly title?: string;
  readonly x?: number;
  readonly y?: number;
  readonly width?: number;
  readonly height?: number;
}

export type MacHelperResult =
  | { readonly ok: true; readonly data: Record<string, unknown> }
  | { readonly ok: false; readonly code: string; readonly message: string };

/** 5s: every read here is a local framework call measured in the low hundreds
 *  of ms. A read that takes seconds is wedged, not slow. */
export const MAC_HELPER_TIMEOUT_MS = 5_000;

export interface MacHelperDeps {
  /** Absolute path to the built binary. Absent ⇒ every read reports unavailable. */
  readonly binaryPath?: string;
  /** Injected in tests so the contract is exercised without a real spawn. */
  readonly run?: (bin: string, argv: readonly string[]) => Promise<MacCommandResult>;
}

function parseHelperOutput(stdout: string): MacHelperResult {
  const text = stdout.trim();
  if (text.length === 0) {
    return { code: "empty_output", message: "helper produced no output", ok: false };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // The helper's contract is "always a JSON object on stdout". Non-JSON means
    // a different binary, a crash banner, or a corrupted install — all of which
    // are safer to report than to guess at.
    return { code: "malformed_output", message: `helper output was not JSON: ${text.slice(0, 120)}`, ok: false };
  }
  if (typeof parsed !== "object" || parsed === null) {
    return { code: "malformed_output", message: "helper output was not a JSON object", ok: false };
  }
  const record = parsed as Record<string, unknown>;
  if (record.ok === true) {
    return { data: record, ok: true };
  }
  return {
    code: typeof record.code === "string" ? record.code : "helper_error",
    message: typeof record.message === "string" ? record.message : "helper reported a failure",
    ok: false
  };
}

/**
 * Run one read. Never throws: a missing binary, a spawn failure, a timeout, and
 * a permission denial all arrive as a typed `{ ok: false, code }` so a caller
 * can decide whether to fall back or to explain.
 */
export async function readMacHelper(read: MacHelperRead, deps: MacHelperDeps = {}): Promise<MacHelperResult> {
  const binaryPath = deps.binaryPath;
  if (!binaryPath || binaryPath.trim().length === 0) {
    return {
      code: "helper_unavailable",
      message: "muse-mac-helper is not installed — falling back to the AppleScript path",
      ok: false
    };
  }

  const run = deps.run ?? ((bin, argv) => runChild(bin, argv, undefined, MAC_HELPER_TIMEOUT_MS));
  let result: MacCommandResult;
  try {
    result = await run(binaryPath, [read]);
  } catch (cause) {
    // ENOENT means the configured path does not exist — that is "not installed",
    // the same actionable condition as an absent path, not a spawn malfunction.
    // Verified against a real spawn: a missing binary surfaces as ENOENT here.
    const detail = cause instanceof Error ? cause.message : String(cause);
    const missing = /ENOENT|no such file/iu.test(detail);
    return {
      code: missing ? "helper_unavailable" : "helper_spawn_failed",
      message: missing
        ? `muse-mac-helper is not installed at ${binaryPath} — falling back to the AppleScript path`
        : detail,
      ok: false
    };
  }

  if (result.timedOut) {
    return { code: "helper_timeout", message: `muse-mac-helper timed out after ${MAC_HELPER_TIMEOUT_MS.toString()}ms`, ok: false };
  }
  // The helper exits 0 even for its own errors, so a non-zero exit means the
  // process itself failed — a genuinely different condition worth naming.
  if (result.exitCode !== 0) {
    return {
      code: "helper_crashed",
      message: `muse-mac-helper exited ${String(result.exitCode)}: ${result.stderr.trim().slice(0, 200)}`,
      ok: false
    };
  }
  return parseHelperOutput(result.stdout);
}

/** Typed accessor for the window list, since that is the shape callers use most. */
export async function readMacWindows(deps: MacHelperDeps = {}): Promise<
  { readonly ok: true; readonly windows: readonly MacHelperWindow[] } | { readonly ok: false; readonly code: string; readonly message: string }
> {
  const result = await readMacHelper("windows", deps);
  if (!result.ok) return result;
  const raw = result.data.windows;
  if (!Array.isArray(raw)) {
    return { code: "malformed_output", message: "helper did not return a windows array", ok: false };
  }
  return { ok: true, windows: raw as readonly MacHelperWindow[] };
}
