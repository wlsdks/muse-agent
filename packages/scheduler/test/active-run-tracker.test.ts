import { describe, expect, it } from "vitest";
import { setTimeout as sleep } from "node:timers/promises";


import { ActiveRunTracker } from "../src/index.js";

function deferred<T>() {
  return Promise.withResolvers<T>();
}

function neverSettle<T>(): Promise<T> {
  return Promise.withResolvers<T>().promise;
}

describe("ActiveRunTracker (CRON-9)", () => {
  it("counts an in-flight run and forgets it once it settles", async () => {
    const tracker = new ActiveRunTracker();
    const d = deferred<string>();
    tracker.track(d.promise);
    expect(tracker.size).toBe(1);
    d.resolve("done");
    await d.promise;
    await Promise.resolve(); // let the finally microtask run
    expect(tracker.size).toBe(0);
  });

  it("forgets a run even when it rejects", async () => {
    const tracker = new ActiveRunTracker();
    const d = deferred<string>();
    tracker.track(d.promise.then(() => { throw new Error("boom"); }));
    expect(tracker.size).toBe(1);
    d.resolve("x");
    await Promise.allSettled([...([] as Promise<unknown>[])]);
    await sleep(0);
    expect(tracker.size).toBe(0);
  });

  it("drain returns 'drained' immediately when nothing is in flight", async () => {
    expect(await new ActiveRunTracker().drain(1000)).toBe("drained");
  });

  it("drain waits for in-flight runs and returns 'drained'", async () => {
    const tracker = new ActiveRunTracker();
    const d = deferred<string>();
    tracker.track(d.promise);
    const drainP = tracker.drain(10_000, async () => neverSettle());
    d.resolve("ok");
    expect(await drainP).toBe("drained");
  });

  it("drain returns 'timeout' when a run never finishes", async () => {
    const tracker = new ActiveRunTracker();
    tracker.track(neverSettle<void>()); // never settles
    const outcome = await tracker.drain(5, async (ms) => { await sleep(ms); });
    expect(outcome).toBe("timeout");
  });
});
