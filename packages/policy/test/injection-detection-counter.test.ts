import { describe, expect, it } from "vitest";

import { InMemoryInjectionDetectionCounter } from "../src/injection-detection-counter.js";

describe("InMemoryInjectionDetectionCounter (goal 085)", () => {
  it("bumps per-family counts and rolls up totals", () => {
    let now = new Date("2026-05-14T12:00:00Z");
    const counter = new InMemoryInjectionDetectionCounter({ now: () => now });
    counter.bumpFrom([
      { name: "history_poisoning", count: 2 },
      { name: "tool_spoofing", count: 1 }
    ]);
    const after = counter.bumpFrom([{ name: "history_poisoning", count: 3 }]);
    expect(after.total).toBe(6);
    expect(after.counts).toEqual({ history_poisoning: 5, tool_spoofing: 1 });
    expect(after.lastFiredAt).toBe("2026-05-14T12:00:00.000Z");

    // Empty findings array doesn't move the clock or bump anything.
    now = new Date("2026-05-15T12:00:00Z");
    const noopSnap = counter.bumpFrom([]);
    expect(noopSnap.total).toBe(6);
    expect(noopSnap.lastFiredAt).toBe("2026-05-14T12:00:00.000Z");

    // Reset clears counters + lastFiredAt.
    counter.reset();
    const empty = counter.snapshot();
    expect(empty.total).toBe(0);
    expect(empty.counts).toEqual({});
    expect(empty.lastFiredAt).toBeUndefined();
  });

  it("ignores zero/negative counts and empty names", () => {
    const counter = new InMemoryInjectionDetectionCounter();
    counter.bumpFrom([
      { name: "", count: 5 },
      { name: "ok", count: 0 },
      { name: "ok", count: -3 },
      { name: "real_family", count: 2 }
    ]);
    const snap = counter.snapshot();
    expect(snap.counts).toEqual({ real_family: 2 });
    expect(snap.total).toBe(2);
  });
});
