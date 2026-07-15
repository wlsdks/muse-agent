/**
 * CRON-9 — track in-flight scheduled runs so shutdown can DRAIN them instead
 * of abandoning a job mid-execution. The scheduler fires runs fire-and-forget;
 * without this, `destroy()` cancels future schedules but a run already
 * executing is orphaned (its result-record left "running", its work half-done).
 * `track` registers a run and auto-forgets it on settle; `drain` waits for all
 * registered runs up to a timeout (a hung run can't block shutdown forever).
 * Pure + deterministic — the sleep is injectable so the timeout path is tested
 * without real timers.
 */

import { sleep as defaultSleep } from "@muse/shared";

export type DrainOutcome = "drained" | "timeout";

export class ActiveRunTracker {
  private readonly active = new Set<Promise<unknown>>();

  /** Register an in-flight run; it is auto-removed when it settles. Returns the same promise. */
  track<T>(run: Promise<T>): Promise<T> {
    this.active.add(run);
    void run
      .catch(() => undefined)
      .finally(() => {
        this.active.delete(run);
      });
    return run;
  }

  get size(): number {
    return this.active.size;
  }

  /**
   * Wait for every in-flight run to settle, or `timeoutMs`, whichever comes
   * first. Returns "drained" when all finished, "timeout" when the deadline
   * hit with runs still pending.
   */
  async drain(
    timeoutMs: number,
    sleep: (ms: number) => Promise<void> = defaultSleep
  ): Promise<DrainOutcome> {
    if (this.active.size === 0) {
      return "drained";
    }
    const timeout = (async () => {
      await sleep(timeoutMs);
      return "timeout";
    })();
    const outcome = await Promise.race<
      readonly PromiseSettledResult<unknown>[] | "timeout"
    >([
      Promise.allSettled([...this.active]),
      timeout
    ]);
    return outcome === "timeout" ? "timeout" : "drained";
  }
}
