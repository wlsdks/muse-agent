/**
 * Goal 067 — shared scaffold for Ctrl-C friendliness in long-
 * running CLI commands. Pattern:
 *
 *   await withSigintAbort(async (signal) => {
 *     await fetch(url, { signal });
 *     await someStream({ signal });
 *   });
 *
 * The wrapper installs a one-shot SIGINT handler that aborts the
 * shared `AbortSignal`, runs the action, and unhooks the handler
 * in `finally` so a long-lived parent process (the CLI's
 * top-level commander dispatch) doesn't accumulate stale
 * listeners across multiple commands.
 *
 * Why not just install a global SIGINT handler in `program.ts`?
 * Because the abort needs to thread into per-command code (fetch
 * options, stream consumers). Scoping the handler to the command's
 * lifetime keeps the surface explicit + composable.
 */

export interface SigintAbortOptions {
  /**
   * Optional one-line stderr notice on SIGINT, after the abort
   * fires but before the action resolves. Useful for "(Ctrl-C —
   * aborting search…)" so the user knows the abort registered
   * instead of staring at a hung terminal.
   */
  readonly onSigint?: () => void;
}

/**
 * Run `action(signal)` with a SIGINT-triggered AbortSignal. The
 * SIGINT handler is unhooked on completion (success or failure)
 * so subsequent commands install a fresh handler.
 *
 * Returns whatever `action` returns. Rethrows the action's error
 * so the caller can react to it (commander dispatch already
 * surfaces thrown errors as exit-1 with a message).
 */
export async function withSigintAbort<T>(
  action: (signal: AbortSignal) => Promise<T>,
  options: SigintAbortOptions = {}
): Promise<T> {
  const controller = new AbortController();
  let aborted = false;
  const handler = (): void => {
    aborted = true;
    controller.abort();
    if (options.onSigint) {
      try {
        options.onSigint();
      } catch {
        // The notice is best-effort; never let it shadow the
        // abort itself.
      }
    }
  };
  process.once("SIGINT", handler);
  try {
    return await action(controller.signal);
  } finally {
    process.off("SIGINT", handler);
    // If the action observed the abort and returned normally,
    // surface the cancellation to the caller via exit code so a
    // shell pipeline `&& next` doesn't fire after a Ctrl-C.
    if (aborted && process.exitCode === undefined) {
      process.exitCode = 130; // 128 + SIGINT (2)
    }
  }
}
