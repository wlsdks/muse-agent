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
  let stopped = false;
  let inFlight: Promise<void> | undefined;
  let stopPromise: Promise<void> | undefined;
  const runTick = async (): Promise<void> => {
    try { await runner.tick(); } catch (cause) { onError(cause); }
  };
  const tick = (): Promise<void> => {
    if (stopped) return Promise.resolve();
    inFlight ??= runTick().finally(() => {
      inFlight = undefined;
    });
    return inFlight;
  };
  const timer = setInterval(() => { void tick(); }, intervalMs);
  timer.unref();
  void tick();
  return {
    stop() {
      stopPromise ??= (async () => {
        stopped = true;
        clearInterval(timer);
        await inFlight;
        await runner.shutdown();
      })();
      return stopPromise;
    },
    tick
  };
}
