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
    for (const wake of this.wakers) {
      wake();
    }
    this.wakers.clear();
  }

  async sleep(ms: number): Promise<void> {
    if (this.isStopped) return;
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.wakers.delete(wake);
        resolve();
      }, ms);
      const wake = (): void => {
        clearTimeout(timer);
        resolve();
      };
      this.wakers.add(wake);
    });
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
