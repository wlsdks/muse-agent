import type { ModelToolCall } from "@muse/model";
import type { JsonObject } from "@muse/shared";
import { describe, expect, it } from "vitest";

import {
  buildPingPongSignature,
  detectPingPong,
  PingPongLoopGuard,
  stripVolatileFields,
  PINGPONG_BLOCK,
  PINGPONG_WARN
} from "./tool-loop-pingpong.js";

const call = (id: string, name = "search", args: JsonObject = { q: "x" }): ModelToolCall => ({
  arguments: args,
  id,
  name
});

function alternating(count: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < count; i += 1) out.push(i % 2 === 0 ? "A" : "B");
  return out;
}

describe("detectPingPong (pure)", () => {
  it("reaches block once the trailing alternation run hits PINGPONG_BLOCK", () => {
    expect(detectPingPong(alternating(PINGPONG_BLOCK))).toBe("block");
  });

  it("reaches warn once the trailing alternation run hits PINGPONG_WARN but stays below block", () => {
    expect(detectPingPong(alternating(PINGPONG_WARN))).toBe("warn");
    expect(detectPingPong(alternating(PINGPONG_BLOCK - 1))).toBe("warn");
  });

  it("fewer than PINGPONG_WARN signatures never trips", () => {
    expect(detectPingPong(alternating(PINGPONG_WARN - 1))).toBe("none");
  });

  it("genuine progress (all distinct calls) never trips, however long", () => {
    const signatures = Array.from({ length: 15 }, (_, i) => `call-${i.toString()}`);
    expect(detectPingPong(signatures)).toBe("none");
  });

  it("a pure stall (same value repeated) is owned by the stall detector, not ping-pong", () => {
    const signatures = Array.from({ length: 10 }, () => "A");
    expect(detectPingPong(signatures)).toBe("none");
  });

  it("a 3-value cycle (A,B,C,A,B,C,...) is out of scope — 2-value alternation only", () => {
    const signatures: string[] = [];
    for (let i = 0; i < 15; i += 1) signatures.push(["A", "B", "C"][i % 3]!);
    expect(detectPingPong(signatures)).toBe("none");
  });

  it("an alternation that then breaks resets the trailing run below warn", () => {
    const signatures = [...alternating(PINGPONG_BLOCK), "C"];
    expect(detectPingPong(signatures)).toBe("none");
  });

  it("respects custom window/warn/block options", () => {
    expect(detectPingPong(alternating(4), { block: 4, warn: 2 })).toBe("block");
    expect(detectPingPong(alternating(3), { block: 4, warn: 2 })).toBe("warn");
    expect(detectPingPong(alternating(1), { block: 4, warn: 2 })).toBe("none");
  });
});

describe("stripVolatileFields", () => {
  it("removes top-level volatile keys and re-serializes deterministically", () => {
    const a = stripVolatileFields(JSON.stringify({ ok: true, runId: "r1", value: 42 }));
    const b = stripVolatileFields(JSON.stringify({ ok: true, runId: "r2", value: 42 }));
    expect(a).toBe(b);
  });

  it("removes nested volatile keys at any depth", () => {
    const a = stripVolatileFields(JSON.stringify({ data: { id: "x1", nested: { ts: 111, v: 1 } } }));
    const b = stripVolatileFields(JSON.stringify({ data: { id: "x2", nested: { ts: 222, v: 1 } } }));
    expect(a).toBe(b);
  });

  it("leaves non-JSON output unchanged", () => {
    expect(stripVolatileFields("plain text result")).toBe("plain text result");
  });

  it("leaves genuinely different content distinguishable", () => {
    const a = stripVolatileFields(JSON.stringify({ value: 1 }));
    const b = stripVolatileFields(JSON.stringify({ value: 2 }));
    expect(a).not.toBe(b);
  });
});

describe("buildPingPongSignature", () => {
  it("two results identical except a top-level volatile id hash equal", () => {
    const toolCall = call("t1");
    const a = buildPingPongSignature(toolCall, JSON.stringify({ ok: true, runId: "r1" }));
    const b = buildPingPongSignature(toolCall, JSON.stringify({ ok: true, runId: "r2" }));
    expect(a).toBe(b);
  });

  it("two results identical except a nested volatile timestamp hash equal", () => {
    const toolCall = call("t1");
    const a = buildPingPongSignature(toolCall, JSON.stringify({ meta: { tsIso: "2026-01-01T00:00:00Z" }, ok: true }));
    const b = buildPingPongSignature(toolCall, JSON.stringify({ meta: { tsIso: "2026-02-02T00:00:00Z" }, ok: true }));
    expect(a).toBe(b);
  });

  it("is stable under arg key reordering", () => {
    const a = buildPingPongSignature(call("t1", "search", { a: 1, b: 2 }), "same");
    const b = buildPingPongSignature(call("t2", "search", { b: 2, a: 1 }), "same");
    expect(a).toBe(b);
  });
});

describe("PingPongLoopGuard", () => {
  it("A,B,A,B... alternation between two real tool calls escalates none -> warn -> block", () => {
    const guard = new PingPongLoopGuard();
    const toolA = call("a", "toolA", { q: "a" });
    const toolB = call("b", "toolB", { q: "b" });
    const levels: string[] = [];
    for (let i = 0; i < PINGPONG_BLOCK; i += 1) {
      const toolCall = i % 2 === 0 ? toolA : toolB;
      const output = i % 2 === 0 ? "resultA" : "resultB";
      levels.push(guard.record(buildPingPongSignature(toolCall, output)));
    }
    expect(levels[PINGPONG_WARN - 1]).toBe("warn");
    expect(levels[PINGPONG_BLOCK - 1]).toBe("block");
    expect(levels.slice(0, PINGPONG_WARN - 1).every((l) => l === "none")).toBe(true);
  });

  it("ping-pong where B differs only by a volatile id each time is still detected", () => {
    const guard = new PingPongLoopGuard();
    const toolA = call("a", "toolA", { q: "a" });
    const toolB = call("b", "toolB", { q: "b" });
    let last = "none";
    for (let i = 0; i < PINGPONG_BLOCK; i += 1) {
      const toolCall = i % 2 === 0 ? toolA : toolB;
      const output = i % 2 === 0
        ? JSON.stringify({ ok: true })
        : JSON.stringify({ ok: true, runId: `run-${i.toString()}` });
      last = guard.record(buildPingPongSignature(toolCall, output));
    }
    expect(last).toBe("block");
  });

  it("a run of all-distinct calls never leaves none", () => {
    const guard = new PingPongLoopGuard();
    for (let i = 0; i < 15; i += 1) {
      expect(guard.record(`distinct-${i.toString()}`)).toBe("none");
    }
  });

  it("stays correct after a very long unrelated history (retained history stays bounded, not unbounded growth)", () => {
    const guard = new PingPongLoopGuard();
    // 500 distinct, unrelated prior calls — a proxy for "retention is bounded
    // to the window, not the whole run": if old history leaked in unbounded,
    // it would still just be more distinct noise and never change the verdict
    // below, but this also exercises record() at scale without degrading.
    for (let i = 0; i < 500; i += 1) guard.record(`noise-${i.toString()}`);
    const levels: string[] = [];
    for (let i = 0; i < PINGPONG_BLOCK; i += 1) {
      levels.push(guard.record(i % 2 === 0 ? "A" : "B"));
    }
    expect(levels[PINGPONG_WARN - 1]).toBe("warn");
    expect(levels[PINGPONG_BLOCK - 1]).toBe("block");
  });
});
