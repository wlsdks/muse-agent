import { setTimeout as sleep } from "node:timers/promises";
import { withBestEffort } from "./async-promises.js";



/**
 * `muse daemon`'s default `--interval` (seconds → ms). Kept in this small,
 * dependency-free module (not `commands-daemon-register.ts`, which pulls in
 * the whole tick-composition graph) so a cheap liveness check elsewhere
 * (`muse scheduler add`'s stale-daemon warning, `muse status`'s daemon
 * line) can import just the constant instead of the entire daemon command.
 * Those callers derive their staleness threshold from this SAME constant
 * (3x it) rather than inventing an uncalibrated one.
 */
export const DEFAULT_DAEMON_INTERVAL_MS = 60_000;

/**
 * Stop flag for the daemon foreground loop with an INTERRUPTIBLE
 * sleep: `stop()` both flips `stopped` and wakes any in-flight
 * `sleep()` so ctrl-c exits at once instead of waiting out the tick
 * interval. Testable without real signals or real timers.
 */
export class DaemonStopSignal {
  private isStopped = false;
  private readonly wakers = new Set<() => void>();

  get stopped(): boolean {
    return this.isStopped;
  }

  stop(): void {
    if (this.isStopped) return;
    this.isStopped = true;
    for (const wake of this.wakers) wake();
    this.wakers.clear();
  }

  async sleep(ms: number): Promise<void> {
    if (this.isStopped) return;
    const signal = new AbortController();
    const wake = (): void => {
      signal.abort();
    };
    this.wakers.add(wake);
    try {
      await withBestEffort(sleep(ms, "done", { signal: signal.signal }), undefined);
    } finally {
      this.wakers.delete(wake);
    }
  }
}

/**
 * Run `tick` every `intervalMs` until `signal` stops, returning the
 * number of completed ticks. A tick that throws is reported via
 * `onError` and does NOT stop the loop (an unattended daemon survives
 * a transient tick failure). The sleep is the signal's interruptible
 * one by default; tests inject a synchronous `sleep` to drive it.
 */
export async function runDaemonLoop(opts: {
  readonly tick: () => Promise<void>;
  readonly intervalMs: number;
  readonly signal: DaemonStopSignal;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly onError?: (cause: unknown) => void;
}): Promise<number> {
  const sleep = opts.sleep ?? ((ms: number) => opts.signal.sleep(ms));
  let ticks = 0;
  while (!opts.signal.stopped) {
    try {
      await opts.tick();
      ticks += 1;
    } catch (cause) {
      opts.onError?.(cause);
    }
    if (!opts.signal.stopped) {
      await sleep(opts.intervalMs);
    }
  }
  return ticks;
}
