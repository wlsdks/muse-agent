/**
 * General-shell phase gate — keep a general shell (`run_command`) from
 * cannibalizing the structured file tools during a code-edit loop.
 *
 * Observed (eval:multifile-fix, a RED ceiling probe): on the harder multi-file
 * fix loop the local 12B runs the failing test, greps to locate the file, then
 * reaches for SHELL idioms via `run_command` (`cat src/math.mjs`, `ls -l`,
 * `find . -R`) to inspect/navigate — flailing on cwd/relative paths — and NEVER
 * reaches a successful `file_edit`. Two prompt nudges (a persistence line; an
 * explicit "inspect with file_read, not the shell" line) were IGNORED, so this
 * is a tool-SELECTION bias on a small model, not a prompt-tweakable gap, and the
 * shell-as-reader also bypasses the read-before-edit gate. The simpler one-file
 * loop stays 3/3 — the gap is specifically a general shell competing with the
 * structured file tools.
 *
 * The fix is deterministic tool DISCIPLINE (tool-calling.md #1 — split the tool
 * set by phase, don't expose a general shell alongside the file tools for an
 * edit task): phase the loop. The shell is a verify/execute-phase tool —
 *   - available initially (run the failing test to SEE the error),
 *   - WITHHELD during the locate+fix phase (after the shell has been used and
 *     before a structured file write lands) so `file_read`/`file_grep`/
 *     `file_edit` are the only inspect+edit path,
 *   - RE-ARMED the moment a real file write lands (confirm the fix by running
 *     the test again).
 * The model keeps every OTHER tool the whole time (parallel to the per-tool
 * failure-streak circuit breaker) — only the general shell is gated.
 *
 * The gate engages ONLY when the exposed set contains BOTH a general shell AND a
 * structured file-write tool — the "general shell vs file tools" condition. With
 * the shell alone (the execute eval) or file tools alone (the one-file loop) it
 * never withholds, so neither path regresses. Deterministic, set-membership +
 * one output-marker check; no text similarity, KO/paraphrase-immune.
 */

/** Tool names that are a general-purpose shell able to read/navigate files. */
export const GENERAL_SHELL_TOOL_NAMES: ReadonlySet<string> = new Set(["run_command"]);

/** Structured file-write tools whose landed write re-arms the shell. */
export const STRUCTURED_FILE_WRITE_TOOL_NAMES: ReadonlySet<string> = new Set([
  "file_edit",
  "file_multi_edit",
  "file_write"
]);

/**
 * A landed write: the fs write tools return `{ ..., written: true }` ONLY on a
 * real mutation; every refusal/no-op (ambiguous old_string, unread file,
 * "no change", denied approval) returns `written: false`. A refused edit must
 * NOT re-arm the shell — that would re-open the escape hatch on a failed
 * attempt — so re-arm is gated on the success marker, not on the call.
 */
function writeLanded(output: string): boolean {
  return /"written"\s*:\s*true/u.test(output);
}

export class GeneralShellPhaseGate {
  private readonly engaged: boolean;
  private awaitingEdit = false;

  constructor(toolNames: Iterable<string>) {
    let hasShell = false;
    let hasFileWrite = false;
    for (const name of toolNames) {
      if (GENERAL_SHELL_TOOL_NAMES.has(name)) {
        hasShell = true;
      } else if (STRUCTURED_FILE_WRITE_TOOL_NAMES.has(name)) {
        hasFileWrite = true;
      }
    }
    this.engaged = hasShell && hasFileWrite;
  }

  /**
   * Record a genuinely-executed tool result. Using the general shell opens the
   * fix phase (withhold the shell next turn); a landed structured file write
   * closes it (re-arm the shell to confirm the fix).
   */
  record(toolName: string, output: string): void {
    if (!this.engaged) {
      return;
    }
    if (GENERAL_SHELL_TOOL_NAMES.has(toolName)) {
      this.awaitingEdit = true;
    } else if (STRUCTURED_FILE_WRITE_TOOL_NAMES.has(toolName) && writeLanded(output)) {
      this.awaitingEdit = false;
    }
  }

  /** True when `toolName` is the general shell and we are mid-fix-phase. */
  withholds(toolName: string): boolean {
    return this.engaged && this.awaitingEdit && GENERAL_SHELL_TOOL_NAMES.has(toolName);
  }
}
