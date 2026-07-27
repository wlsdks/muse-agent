/**
 * Graceful shutdown for the API server: drain in-flight scheduled (cron) runs
 * before closing, so a SIGTERM/SIGINT doesn't abandon a half-done autonomous
 * job. Without this the process exits abruptly, leaving runs stuck "running"
 * until reconcile-on-boot corrects the status (the work itself is still lost).
 *
 * Returns an idempotent shutdown fn — a second signal won't double-drain.
 * Scheduler drain is best-effort. Owned runtime resources (such as MCP stdio
 * children) close before Fastify; a resource-close failure still allows the
 * listener to close but keeps the hard deadline armed.
 *
 * The drain is DEADLINED: a long-running cron job or a lingering socket must
 * not keep a supposedly-stopped server alive for minutes — observed live as a
 * zombie process still holding the Telegram long-poll (→ getUpdates Conflict
 * against its replacement) while its supervisor waited for an exit that never
 * came. Past the deadline the process force-exits; reconcile-on-boot owns the
 * cleanup of anything the hard stop abandoned.
 */
export interface GracefulShutdownDeps {
  readonly drainScheduler?: () => Promise<unknown>;
  /** Close non-server runtime owners before Fastify releases its listener. */
  readonly closeResources?: () => Promise<unknown>;
  readonly closeServer: () => Promise<unknown>;
  readonly log?: (message: string) => void;
  /** Hard deadline for the whole drain+close (default 8s). */
  readonly forceExitAfterMs?: number;
  /** Test seam — production exits the process. */
  readonly exit?: (code: number) => void;
}

const DEFAULT_FORCE_EXIT_MS = 8_000;

export function createGracefulShutdown(deps: GracefulShutdownDeps): () => Promise<void> {
  let started = false;
  return async (): Promise<void> => {
    if (started) {
      return;
    }
    started = true;

    const forceAfterMs = deps.forceExitAfterMs ?? DEFAULT_FORCE_EXIT_MS;
    const exit = deps.exit ?? ((code: number) => process.exit(code));
    const deadline = setTimeout(() => {
      deps.log?.(`drain deadline (${(forceAfterMs / 1000).toString()}s) reached — forcing exit`);
      exit(0);
    }, forceAfterMs);
    if (typeof deadline.unref === "function") {
      deadline.unref();
    }

    if (deps.drainScheduler) {
      deps.log?.("draining in-flight scheduled runs before shutdown…");
      try {
        await deps.drainScheduler();
      } catch {
        // best-effort drain — a drain failure must not block the server close
      }
    }
    let resourceCloseFailed = false;
    if (deps.closeResources) {
      try {
        await deps.closeResources();
      } catch {
        resourceCloseFailed = true;
        deps.log?.("resource close failed; continuing server close");
      }
    }
    try {
      await deps.closeServer();
      if (!resourceCloseFailed) {
        clearTimeout(deadline);
      }
    } catch {
      // Signal handlers intentionally invoke this function with `void`. Keep
      // a close failure observable without creating an unhandled rejection;
      // the existing deadline remains armed to release a stuck listener.
      deps.log?.("server close failed; waiting for the forced-exit deadline");
    }
  };
}
