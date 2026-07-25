import type { ObserveRunner } from "@muse/attunement/host";
export type { ObserveRunner } from "@muse/attunement/host";

export interface ObserveDaemonTimer {
  stop(): Promise<void>;
  tick(): Promise<void>;
}

/** Dedicated Observe cadence; failures never abort unrelated daemon work. */
export function startObserveDaemonTimer(
  runner: ObserveRunner,
  intervalMs: number,
  onError: (cause: unknown) => void
): ObserveDaemonTimer {
  const tick = async (): Promise<void> => {
    try { await runner.tick(); } catch (cause) { onError(cause); }
  };
  const timer = setInterval(() => { void tick(); }, intervalMs);
  timer.unref();
  void tick();
  return {
    async stop() { clearInterval(timer); await runner.shutdown(); },
    tick
  };
}
