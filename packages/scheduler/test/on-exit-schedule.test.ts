import { describe, expect, it, vi } from "vitest";

import { SchedulerValidationError } from "../src/scheduler-errors.js";
import {
  InMemoryOnExitWatchStore,
  minOnExitTimeoutMs,
  OnExitScheduler,
  OnExitWatcher,
  validateOnExitTrigger,
  type OnExitSpawnedChild,
  type OnExitSpawner,
  type OnExitTrigger,
  type OnExitWatchOutcome
} from "../src/on-exit-schedule.js";

function exitsAfter(ms: number, code = 0): OnExitTrigger {
  return { command: `node -e "setTimeout(()=>process.exit(${String(code)}),${String(ms)})"`, kind: "on-exit" };
}

describe("validateOnExitTrigger", () => {
  it("accepts a well-formed trigger", () => {
    expect(() => validateOnExitTrigger({ command: "node build.js", kind: "on-exit" })).not.toThrow();
    expect(() => validateOnExitTrigger({ command: "node build.js", kind: "on-exit", pollMs: 500, timeoutMs: 60_000 })).not.toThrow();
  });

  it("rejects a blank command", () => {
    expect(() => validateOnExitTrigger({ command: "   ", kind: "on-exit" })).toThrow(SchedulerValidationError);
    expect(() => validateOnExitTrigger({ command: "   ", kind: "on-exit" })).toThrow(/non-blank command/);
  });

  it("rejects pollMs out of bounds", () => {
    expect(() => validateOnExitTrigger({ command: "x", kind: "on-exit", pollMs: 99 })).toThrow(SchedulerValidationError);
    expect(() => validateOnExitTrigger({ command: "x", kind: "on-exit", pollMs: 60_001 })).toThrow(SchedulerValidationError);
    expect(() => validateOnExitTrigger({ command: "x", kind: "on-exit", pollMs: 1.5 })).toThrow(SchedulerValidationError);
  });

  it("rejects timeoutMs out of bounds or non-finite", () => {
    expect(() => validateOnExitTrigger({ command: "x", kind: "on-exit", timeoutMs: 999 })).toThrow(SchedulerValidationError);
    expect(() => validateOnExitTrigger({ command: "x", kind: "on-exit", timeoutMs: 3_600_001 })).toThrow(SchedulerValidationError);
    expect(() => validateOnExitTrigger({ command: "x", kind: "on-exit", timeoutMs: Number.NaN })).toThrow(SchedulerValidationError);
  });
});

describe("OnExitWatcher.watch — real child process", () => {
  it("fires on real child exit with the exit code and a measured duration", async () => {
    const watcher = new OnExitWatcher();
    const outcome = await watcher.watch(exitsAfter(50, 0));

    expect(outcome.status).toBe("exited");
    expect(outcome.exitCode).toBe(0);
    expect(outcome.durationMs).toBeGreaterThanOrEqual(40);
  }, 10_000);

  it("carries a non-zero exit code through", async () => {
    const watcher = new OnExitWatcher();
    const outcome = await watcher.watch({ command: 'node -e "process.exit(3)"', kind: "on-exit" });

    expect(outcome.status).toBe("exited");
    expect(outcome.exitCode).toBe(3);
  }, 10_000);

  it("kills a child that outlives timeoutMs and reports 'timed-out'", async () => {
    const watcher = new OnExitWatcher({ killGraceMs: 100 });
    const outcome = await watcher.watch({
      command: 'node -e "setTimeout(()=>{}, 30000)"',
      kind: "on-exit",
      timeoutMs: minOnExitTimeoutMs
    });

    expect(outcome.status).toBe("timed-out");
    expect(outcome.durationMs).toBeLessThan(5_000);
  }, 10_000);

  it("refuses an obviously catastrophic command without spawning it", () => {
    const spawner: OnExitSpawner = { spawn: vi.fn() };
    const watcher = new OnExitWatcher({ spawner });

    expect(() => watcher.watch({ command: "rm -rf /", kind: "on-exit" })).toThrow(SchedulerValidationError);
    expect(spawner.spawn).not.toHaveBeenCalled();
  });

  it("falls back to the pollMs liveness probe when the exit event is never delivered", async () => {
    let onExitListener: ((code: number | null, signal: NodeJS.Signals | null) => void) | undefined;
    const child: OnExitSpawnedChild = {
      kill: vi.fn(),
      onExit(listener) {
        onExitListener = listener;
      },
      pid: 4242
    };
    const spawner: OnExitSpawner = { spawn: () => child };
    let alive = true;
    const watcher = new OnExitWatcher({ isAlive: () => alive, spawner });

    const watchPromise = watcher.watch({ command: "some-watched-process", kind: "on-exit", pollMs: 100 });
    alive = false;
    const outcome = await watchPromise;

    expect(outcome.status).toBe("exited");
    expect(outcome.exitCode).toBeNull();
    expect(onExitListener).toBeTypeOf("function");
  }, 10_000);
});

describe("OnExitScheduler — one-shot arm + fire", () => {
  it("fires the job exactly once through the injected pipeline hook and clears the armed record", async () => {
    const store = new InMemoryOnExitWatchStore();
    const scheduler = new OnExitScheduler({ store });
    const fires: Array<{ jobId: string; outcome: OnExitWatchOutcome }> = [];

    await scheduler.arm("job-1", exitsAfter(30, 0), (jobId, outcome) => {
      fires.push({ jobId, outcome });
    });

    expect(fires).toHaveLength(1);
    expect(fires[0]?.jobId).toBe("job-1");
    expect(fires[0]?.outcome.status).toBe("exited");
    expect(await store.findArmed("job-1")).toBeUndefined();
  }, 10_000);

  it("refuses to double-arm the same job id while a watch is in flight", async () => {
    const store = new InMemoryOnExitWatchStore();
    const scheduler = new OnExitScheduler({ store });

    const first = scheduler.arm("job-2", exitsAfter(200, 0), () => {});
    await expect(scheduler.arm("job-2", exitsAfter(10, 0), () => {})).rejects.toThrow(SchedulerValidationError);

    await first;
  }, 10_000);

  it("does not re-fire after the watch has already resolved", async () => {
    const store = new InMemoryOnExitWatchStore();
    const scheduler = new OnExitScheduler({ store });
    let fireCount = 0;

    await scheduler.arm("job-3", exitsAfter(20, 0), () => {
      fireCount += 1;
    });

    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(fireCount).toBe(1);
  }, 10_000);
});

describe("OnExitScheduler.reconcileOnStartup — crash-safety", () => {
  it("fires 'watcher-lost' for a job that was armed before a restart wiped in-process state", async () => {
    const store = new InMemoryOnExitWatchStore();
    // Simulate a scheduler that armed a watch, then crashed before the child exited:
    // the durable record survives, but no live OnExitWatcher instance does.
    await store.markArmed("job-4", { command: "node build.js", kind: "on-exit" }, new Date(Date.now() - 5_000));

    const freshScheduler = new OnExitScheduler({ store });
    const fires: Array<{ jobId: string; outcome: OnExitWatchOutcome }> = [];

    const reconciled = await freshScheduler.reconcileOnStartup((jobId, outcome) => {
      fires.push({ jobId, outcome });
    });

    expect(reconciled).toEqual(["job-4"]);
    expect(fires).toHaveLength(1);
    expect(fires[0]?.outcome.status).toBe("watcher-lost");
    expect(fires[0]?.outcome.exitCode).toBeNull();
    expect(await store.findArmed("job-4")).toBeUndefined();
  });

  it("reconciles nothing when no watch was left armed", async () => {
    const store = new InMemoryOnExitWatchStore();
    const scheduler = new OnExitScheduler({ store });

    expect(await scheduler.reconcileOnStartup(() => {})).toEqual([]);
  });
});
