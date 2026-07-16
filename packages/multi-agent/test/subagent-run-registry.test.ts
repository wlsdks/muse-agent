import { describe, expect, it } from "vitest";
import { SubAgentRunRegistry } from "../src/index.js";

describe("SubAgentRunRegistry", () => {
  let clock = 0;
  const now = () => new Date(clock);

  function fresh() {
    clock = 0;
    return new SubAgentRunRegistry({ now });
  }

  it("register creates a running record with correct initial timestamps and status", () => {
    clock = 1000;
    const registry = new SubAgentRunRegistry({ now });
    const record = registry.register({ runId: "r1" });

    expect(record.runId).toBe("r1");
    expect(record.status).toBe("running");
    expect(record.startedAt).toEqual(new Date(1000));
    expect(record.lastHeartbeatAt).toEqual(new Date(1000));
    expect(record.timeoutMs).toBe(0);
    expect(record.finishedAt).toBeUndefined();
  });

  it("register throws on empty runId", () => {
    const registry = fresh();
    expect(() => registry.register({ runId: "" })).toThrow(RangeError);
    expect(() => registry.register({ runId: "   " })).toThrow(RangeError);
  });

  it("register throws on duplicate runId", () => {
    const registry = fresh();
    registry.register({ runId: "dup" });
    expect(() => registry.register({ runId: "dup" })).toThrow(/duplicate run id/);
  });

  it("register throws when parentRunId is unknown", () => {
    const registry = fresh();
    expect(() => registry.register({ runId: "child", parentRunId: "ghost" })).toThrow(/parentRunId/);
  });

  it("register succeeds when parentRunId is a known running parent; children() returns child", () => {
    const registry = fresh();
    registry.register({ runId: "parent" });
    const child = registry.register({ runId: "child", parentRunId: "parent" });

    expect(child.parentRunId).toBe("parent");

    const kids = registry.children("parent");
    expect(kids).toHaveLength(1);
    expect(kids[0].runId).toBe("child");
  });

  it("children returns multiple children in registration order and excludes non-children", () => {
    const registry = fresh();
    registry.register({ runId: "p" });
    registry.register({ runId: "c1", parentRunId: "p" });
    registry.register({ runId: "c2", parentRunId: "p" });
    registry.register({ runId: "unrelated" });

    const kids = registry.children("p");
    expect(kids.map((k) => k.runId)).toEqual(["c1", "c2"]);
  });

  it("heartbeat updates lastHeartbeatAt for a running run and returns true", () => {
    const registry = fresh();
    clock = 0;
    registry.register({ runId: "r" });

    clock = 500;
    const updated = registry.heartbeat("r");
    expect(updated).toBe(true);

    const record = registry.get("r")!;
    expect(record.lastHeartbeatAt).toEqual(new Date(500));
  });

  it("heartbeat on unknown run returns false", () => {
    const registry = fresh();
    expect(registry.heartbeat("nope")).toBe(false);
  });

  it("heartbeat on a completed run returns false and does NOT change lastHeartbeatAt", () => {
    const registry = fresh();
    clock = 0;
    registry.register({ runId: "r" });

    clock = 100;
    registry.heartbeat("r");
    const beforeComplete = registry.get("r")!.lastHeartbeatAt;

    registry.complete("r");

    clock = 999;
    const result = registry.heartbeat("r");
    expect(result).toBe(false);

    const after = registry.get("r")!.lastHeartbeatAt;
    expect(after).toEqual(beforeComplete);
  });

  it("complete transitions running→completed, sets finishedAt and outcome; second call returns false (idempotent)", () => {
    const registry = fresh();
    clock = 0;
    registry.register({ runId: "r" });

    clock = 200;
    const first = registry.complete("r", "all done");
    expect(first).toBe(true);

    const record = registry.get("r")!;
    expect(record.status).toBe("completed");
    expect(record.finishedAt).toEqual(new Date(200));
    expect(record.outcome).toBe("all done");

    clock = 300;
    const second = registry.complete("r", "again");
    expect(second).toBe(false);

    // state is unchanged
    expect(registry.get("r")!.finishedAt).toEqual(new Date(200));
    expect(registry.get("r")!.outcome).toBe("all done");
  });

  it("fail transitions running→failed with error; complete-after-fail returns false", () => {
    const registry = fresh();
    registry.register({ runId: "r" });

    const ok = registry.fail("r", "boom");
    expect(ok).toBe(true);

    const record = registry.get("r")!;
    expect(record.status).toBe("failed");
    expect(record.error).toBe("boom");

    expect(registry.complete("r")).toBe(false);
  });

  it("activeCount reflects running count and drops when runs complete or fail", () => {
    const registry = fresh();
    registry.register({ runId: "a" });
    registry.register({ runId: "b" });
    expect(registry.activeCount()).toBe(2);

    registry.complete("a");
    expect(registry.activeCount()).toBe(1);

    registry.fail("b");
    expect(registry.activeCount()).toBe(0);
  });

  it("detectStalled: respects timeoutMs > 0 boundary and never stalls timeoutMs=0", () => {
    const registry = fresh();
    clock = 0;
    registry.register({ runId: "finite", timeoutMs: 100 });
    registry.register({ runId: "infinite", timeoutMs: 0 });

    // not yet stalled
    clock = 50;
    expect(registry.detectStalled().map((r) => r.runId)).toEqual([]);

    // exactly at boundary: NOT stalled (strictly greater)
    clock = 100;
    expect(registry.detectStalled().map((r) => r.runId)).toEqual([]);

    // one ms over: stalled
    clock = 101;
    expect(registry.detectStalled().map((r) => r.runId)).toEqual(["finite"]);

    // infinite never stalls even far in the future
    clock = 999999;
    const stalled = registry.detectStalled().map((r) => r.runId);
    expect(stalled).not.toContain("infinite");
  });

  it("detectStalled does NOT mutate status (pure read)", () => {
    const registry = fresh();
    clock = 0;
    registry.register({ runId: "r", timeoutMs: 10 });

    clock = 100;
    registry.detectStalled();

    expect(registry.get("r")!.status).toBe("running");
  });

  it("detectStalled: completed run is never stalled", () => {
    const registry = fresh();
    clock = 0;
    registry.register({ runId: "done", timeoutMs: 100 });
    registry.complete("done");

    clock = 9999;
    expect(registry.detectStalled().map((r) => r.runId)).not.toContain("done");
  });

  it("detectStalled boundary: fresh heartbeat resets the stall window", () => {
    const registry = fresh();
    clock = 0;
    registry.register({ runId: "r", timeoutMs: 100 });

    clock = 90;
    registry.heartbeat("r");

    // 90 + 99 = 189 — only 99ms since last heartbeat, not stalled
    clock = 189;
    expect(registry.detectStalled().map((r) => r.runId)).toEqual([]);

    // 90 + 101 = 191 — 101ms since last heartbeat, stalled
    clock = 191;
    expect(registry.detectStalled().map((r) => r.runId)).toEqual(["r"]);
  });

  it("markStalledAsTimedOut transitions stalled runs; they no longer appear in detectStalled; activeCount drops", () => {
    const registry = fresh();
    clock = 0;
    registry.register({ runId: "s1", timeoutMs: 100 });
    registry.register({ runId: "s2", timeoutMs: 100 });
    registry.register({ runId: "ok", timeoutMs: 0 });

    clock = 200;
    const transitioned = registry.markStalledAsTimedOut();

    expect(transitioned.map((r) => r.runId).sort()).toEqual(["s1", "s2"]);
    expect(transitioned[0].status).toBe("timed-out");
    expect(transitioned[0].finishedAt).toEqual(new Date(200));

    // detectStalled now empty for those runs
    expect(registry.detectStalled().map((r) => r.runId)).toEqual([]);

    // activeCount only counts "ok" (still running)
    expect(registry.activeCount()).toBe(1);
  });

  it("returned records are frozen — mutating them throws or is silently ignored", () => {
    const registry = fresh();
    registry.register({ runId: "r" });

    const record = registry.get("r")!;
    expect(Object.isFrozen(record)).toBe(true);

    expect(() => {
      // @ts-expect-error intentional mutation attempt
      record.status = "completed";
    }).toThrow();
  });

  it("returned timestamps are snapshots and cannot rewrite registry lifecycle state", () => {
    const registry = fresh();
    clock = 100;
    registry.register({ runId: "r" });

    const running = registry.get("r")!;
    running.startedAt.setTime(1);
    running.lastHeartbeatAt.setTime(2);
    expect(registry.get("r")).toMatchObject({
      lastHeartbeatAt: new Date(100),
      startedAt: new Date(100)
    });

    clock = 200;
    registry.complete("r");
    const completed = registry.list()[0]!;
    completed.finishedAt!.setTime(3);
    expect(registry.get("r")?.finishedAt).toEqual(new Date(200));
  });

  it("captures timestamps from a mutable injected clock at every state transition", () => {
    const sharedClockDate = new Date(100);
    const registry = new SubAgentRunRegistry({ now: () => sharedClockDate });

    registry.register({ runId: "r" });
    sharedClockDate.setTime(200);
    expect(registry.get("r")).toMatchObject({
      lastHeartbeatAt: new Date(100),
      startedAt: new Date(100)
    });

    registry.heartbeat("r");
    sharedClockDate.setTime(300);
    expect(registry.get("r")?.lastHeartbeatAt).toEqual(new Date(200));

    registry.complete("r");
    sharedClockDate.setTime(400);
    expect(registry.get("r")?.finishedAt).toEqual(new Date(300));

    const orphanRegistry = new SubAgentRunRegistry({ now: () => sharedClockDate });
    orphanRegistry.register({ runId: "parent" });
    orphanRegistry.register({ parentRunId: "parent", runId: "child" });
    orphanRegistry.complete("parent");
    orphanRegistry.recoverOrphaned();
    sharedClockDate.setTime(500);
    expect(orphanRegistry.get("child")?.finishedAt).toEqual(new Date(400));
  });

  it("rejects malformed positive stall timeout configuration instead of disabling detection", () => {
    for (const defaultTimeoutMs of [Number.NaN, Number.POSITIVE_INFINITY, 1.5]) {
      expect(() => new SubAgentRunRegistry({ defaultTimeoutMs })).toThrow(RangeError);
    }

    const registry = fresh();
    for (const timeoutMs of [Number.NaN, Number.POSITIVE_INFINITY, 1.5]) {
      expect(() => registry.register({ runId: `r-${String(timeoutMs)}`, timeoutMs })).toThrow(RangeError);
    }
  });

  it("list returns all records in insertion order", () => {
    const registry = fresh();
    registry.register({ runId: "z" });
    registry.register({ runId: "a" });
    registry.register({ runId: "m" });

    expect(registry.list().map((r) => r.runId)).toEqual(["z", "a", "m"]);
  });

  it("register succeeds when parentRunId is a terminal (completed) parent", () => {
    const registry = fresh();
    registry.register({ runId: "parent" });
    registry.complete("parent");

    const child = registry.register({ runId: "child", parentRunId: "parent" });
    expect(child.parentRunId).toBe("parent");
  });

  it("timeoutMs from args overrides defaultTimeoutMs", () => {
    const registry = new SubAgentRunRegistry({ now, defaultTimeoutMs: 500 });
    clock = 0;
    registry.register({ runId: "default" });
    registry.register({ runId: "override", timeoutMs: 10 });

    clock = 50;
    const stalled = registry.detectStalled().map((r) => r.runId);
    expect(stalled).toContain("override");
    expect(stalled).not.toContain("default");
  });

  it("detectOrphaned flags a running child whose parent reached a terminal status", () => {
    const registry = fresh();
    registry.register({ runId: "p" });
    registry.register({ runId: "c", parentRunId: "p" });

    // parent still running → child not orphaned
    expect(registry.detectOrphaned().map((r) => r.runId)).toEqual([]);

    registry.complete("p");
    // parent finished, child still running → child is orphaned
    expect(registry.detectOrphaned().map((r) => r.runId)).toEqual(["c"]);
  });

  it("detectOrphaned flags a child registered against an already-terminal parent", () => {
    const registry = fresh();
    registry.register({ runId: "p" });
    registry.fail("p");
    registry.register({ runId: "c", parentRunId: "p" });

    expect(registry.detectOrphaned().map((r) => r.runId)).toEqual(["c"]);
  });

  it("detectOrphaned ignores parentless (root) runs and already-terminal children", () => {
    const registry = fresh();
    registry.register({ runId: "root" }); // no parent → never orphaned
    registry.register({ runId: "p" });
    registry.register({ runId: "c", parentRunId: "p" });
    registry.complete("p");
    registry.complete("c"); // child already terminal → not orphaned

    expect(registry.detectOrphaned()).toEqual([]);
  });

  it("recoverOrphaned transitions orphans to failed; they drop from detectOrphaned and activeCount", () => {
    const registry = fresh();
    registry.register({ runId: "p" });
    registry.register({ runId: "c1", parentRunId: "p" });
    registry.register({ runId: "c2", parentRunId: "p" });
    registry.register({ runId: "live" }); // unrelated root, stays running
    clock = 500;
    registry.complete("p");

    clock = 900;
    const recovered = registry.recoverOrphaned("parent abandoned child");

    expect(recovered.map((r) => r.runId).sort()).toEqual(["c1", "c2"]);
    expect(recovered[0].status).toBe("failed");
    expect(recovered[0].finishedAt).toEqual(new Date(900));
    expect(recovered[0].error).toBe("parent abandoned child");

    // no longer orphaned
    expect(registry.detectOrphaned()).toEqual([]);
    // only the unrelated root is still active
    expect(registry.activeCount()).toBe(1);
    expect(registry.get("live")!.status).toBe("running");
  });

  it("recoverOrphaned does not touch unrelated running state", () => {
    const registry = fresh();
    registry.register({ runId: "p" });
    registry.register({ runId: "c", parentRunId: "p" });
    registry.register({ runId: "sibling-root" });
    registry.register({ runId: "other-parent" });
    registry.register({ runId: "other-child", parentRunId: "other-parent" });
    registry.complete("p");

    registry.recoverOrphaned();

    // other-parent still running → other-child is NOT orphaned, untouched
    expect(registry.get("other-child")!.status).toBe("running");
    expect(registry.get("sibling-root")!.status).toBe("running");
    expect(registry.get("c")!.status).toBe("failed");
  });
});
