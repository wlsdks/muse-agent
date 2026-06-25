/**
 * Graceful shutdown for the API server: drain in-flight scheduled (cron) runs
 * before closing, so a SIGTERM/SIGINT doesn't abandon a half-done autonomous
 * job. Without this the process exits abruptly, leaving runs stuck "running"
 * until reconcile-on-boot corrects the status (the work itself is still lost).
 *
 * Returns an idempotent shutdown fn — a second signal won't double-drain, and
 * a drain failure never blocks the close (best-effort).
 */
export interface GracefulShutdownDeps {
  readonly drainScheduler?: () => Promise<unknown>;
  readonly closeServer: () => Promise<unknown>;
  readonly log?: (message: string) => void;
}

export function createGracefulShutdown(deps: GracefulShutdownDeps): () => Promise<void> {
  let started = false;
  return async (): Promise<void> => {
    if (started) {
      return;
    }
    started = true;
    if (deps.drainScheduler) {
      deps.log?.("draining in-flight scheduled runs before shutdown…");
      try {
        await deps.drainScheduler();
      } catch {
        // best-effort drain — a drain failure must not block the server close
      }
    }
    await deps.closeServer();
  };
}
