import type { ModelToolCall } from "@muse/model";
import type { ToolExecutionResult } from "@muse/tools";
import { describe, expect, it } from "vitest";

import { ToolCallDeduplicator, stableJson } from "../src/tool-call-deduplicator.js";

const call = (overrides: Partial<ModelToolCall> = {}): ModelToolCall => ({
  arguments: {},
  id: "t-1",
  name: "search",
  ...overrides
});

const completed = (overrides: Partial<ToolExecutionResult> = {}): ToolExecutionResult => ({
  id: "t-1",
  name: "search",
  output: "ok",
  status: "completed",
  ...overrides
});

describe("stableJson — canonicalization", () => {
  it("produces the same signature regardless of object key order", () => {
    expect(stableJson({ a: 1, b: 2 })).toBe(stableJson({ b: 2, a: 1 }));
  });

  it("normalises key order at every nesting level", () => {
    expect(stableJson({ outer: { z: 1, a: 2 } })).toBe(stableJson({ outer: { a: 2, z: 1 } }));
  });

  it("preserves array order (semantically meaningful)", () => {
    expect(stableJson([1, 2, 3])).not.toBe(stableJson([3, 2, 1]));
  });

  it("handles primitives, null, and nested arrays", () => {
    expect(stableJson(null)).toBe("null");
    expect(stableJson(7)).toBe("7");
    expect(stableJson("x")).toBe("\"x\"");
    expect(stableJson({ k: [1, { b: 2, a: 1 }] })).toBe("{\"k\":[1,{\"a\":1,\"b\":2}]}");
  });
});

describe("ToolCallDeduplicator", () => {
  it("first call is not a duplicate; second identical call is", () => {
    const d = new ToolCallDeduplicator();
    const c = call({ arguments: { q: "hi" } });
    expect(d.check(c)).toMatchObject({ duplicate: false });
    d.record(c, completed({ output: "answer" }));
    expect(d.check(c)).toMatchObject({ duplicate: true, result: { output: "answer" } });
  });

  it("on a duplicate, the returned result carries the CURRENT call's id/name (correlation)", () => {
    const d = new ToolCallDeduplicator();
    const first = call({ arguments: { q: "hi" }, id: "first" });
    d.record(first, completed({ id: "first", output: "answer" }));
    const second = call({ arguments: { q: "hi" }, id: "second", name: "search" });
    const decision = d.check(second);
    expect(decision.duplicate).toBe(true);
    if (decision.duplicate) {
      expect(decision.result.id).toBe("second");
      expect(decision.result.name).toBe("search");
      expect(decision.result.output).toBe("answer");
    }
  });

  it("key-reordered arguments collide on the same memoized entry", () => {
    const d = new ToolCallDeduplicator();
    d.record(call({ arguments: { a: 1, b: 2 } }), completed({ output: "memo" }));
    const reordered = call({ arguments: { b: 2, a: 1 }, id: "reord" });
    expect(d.check(reordered)).toMatchObject({ duplicate: true, result: { output: "memo" } });
  });

  it("different tool names with identical arguments do NOT collide", () => {
    const d = new ToolCallDeduplicator();
    d.record(call({ arguments: { q: "x" }, name: "search" }), completed({ name: "search" }));
    expect(d.check(call({ arguments: { q: "x" }, name: "lookup" }))).toMatchObject({ duplicate: false });
  });

  it("only memoizes completed results — blocked / failed are skipped so the agent can retry", () => {
    const d = new ToolCallDeduplicator();
    const c = call({ arguments: { q: "hi" } });
    d.record(c, { id: "t-1", name: "search", output: "denied", status: "blocked" });
    expect(d.check(c)).toMatchObject({ duplicate: false });
    d.record(c, { error: "boom", id: "t-1", name: "search", output: "", status: "failed" });
    expect(d.check(c)).toMatchObject({ duplicate: false });
    d.record(c, completed({ output: "ok-now" }));
    expect(d.check(c)).toMatchObject({ duplicate: true });
  });

  it("evicts the oldest entry once it exceeds maxEntries (oldest-first, FIFO)", () => {
    const d = new ToolCallDeduplicator(2);
    const a = call({ arguments: { n: 1 }, id: "a" });
    const b = call({ arguments: { n: 2 }, id: "b" });
    const c = call({ arguments: { n: 3 }, id: "c" });
    d.record(a, completed({ output: "A" }));
    d.record(b, completed({ output: "B" }));
    d.record(c, completed({ output: "C" }));
    expect(d.check(a)).toMatchObject({ duplicate: false }); // evicted
    expect(d.check(b)).toMatchObject({ duplicate: true });
    expect(d.check(c)).toMatchObject({ duplicate: true });
  });

  it("constructor coerces a non-finite / non-positive cap to the default (no unbounded mode)", () => {
    const d = new ToolCallDeduplicator(Number.NaN);
    for (let i = 0; i < 257; i++) {
      d.record(call({ arguments: { n: i }, id: `c-${i.toString()}` }), completed({ output: `r-${i.toString()}` }));
    }
    // The oldest (n=0) must have been evicted at size > 256 — proves the cap
    // landed on the default rather than disabling eviction.
    expect(d.check(call({ arguments: { n: 0 }, id: "probe" }))).toMatchObject({ duplicate: false });
  });

  // --- read-invalidation-on-write tests ---

  it("read entry is memoized (non-mutating record returns duplicate)", () => {
    const d = new ToolCallDeduplicator();
    const readCall = call({ name: "tasks_list", arguments: {} });
    const resultA = completed({ name: "tasks_list", output: "[task1]" });
    d.record(readCall, resultA, false);
    expect(d.check(readCall)).toMatchObject({ duplicate: true, result: { output: "[task1]" } });
  });

  it("write invalidates prior read entries — subsequent identical read is NOT a duplicate", () => {
    const d = new ToolCallDeduplicator();
    const readCall = call({ name: "tasks_list", arguments: {} });
    const writeCall = call({ name: "tasks_add", arguments: { title: "new task" } });

    d.record(readCall, completed({ name: "tasks_list", output: "[task1]" }), false);
    // Confirm read is memoized before the write
    expect(d.check(readCall)).toMatchObject({ duplicate: true });

    // Write completes — must invalidate the read entry
    d.record(writeCall, completed({ name: "tasks_add", output: "added" }), true);

    // The read must now re-execute against fresh state
    expect(d.check(readCall)).toMatchObject({ duplicate: false });
  });

  it("write entries survive a later write — anti-double-write is preserved", () => {
    const d = new ToolCallDeduplicator();
    const writeCallA = call({ name: "tasks_add", arguments: { title: "task A" } });
    const writeCallB = call({ name: "tasks_add", arguments: { title: "task B" } });

    d.record(writeCallA, completed({ name: "tasks_add", output: "added A" }), true);
    d.record(writeCallB, completed({ name: "tasks_add", output: "added B" }), true);

    // Write A must still be duplicate — it was not invalidated by write B
    const decision = d.check(writeCallA);
    expect(decision).toMatchObject({ duplicate: true, result: { output: "added A" } });
  });

  it("read after write re-memoizes with fresh result", () => {
    const d = new ToolCallDeduplicator();
    const readCall = call({ name: "tasks_list", arguments: {} });
    const writeCall = call({ name: "tasks_add", arguments: { title: "new task" } });

    // Initial read, then write invalidates it
    d.record(readCall, completed({ name: "tasks_list", output: "[task1]" }), false);
    d.record(writeCall, completed({ name: "tasks_add", output: "added" }), true);
    expect(d.check(readCall)).toMatchObject({ duplicate: false });

    // Re-execute the read and record fresh result
    const freshResult = completed({ name: "tasks_list", output: "[task1, new task]" });
    d.record(readCall, freshResult, false);
    expect(d.check(readCall)).toMatchObject({ duplicate: true, result: { output: "[task1, new task]" } });
  });

  it("non-completed results are not memoized regardless of mutating flag", () => {
    const d = new ToolCallDeduplicator();
    const c = call({ arguments: { q: "x" } });
    d.record(c, { id: "t-1", name: "search", output: "", status: "failed", error: "err" }, false);
    expect(d.check(c)).toMatchObject({ duplicate: false });
    d.record(c, { id: "t-1", name: "search", output: "denied", status: "blocked" }, true);
    expect(d.check(c)).toMatchObject({ duplicate: false });
  });

  it("eviction cap still works with wrapped entries — oldest evicted regardless of mutating flag", () => {
    const d = new ToolCallDeduplicator(2);
    const a = call({ arguments: { n: 10 }, id: "a", name: "read_a" });
    const b = call({ arguments: { n: 20 }, id: "b", name: "write_b" });
    const c = call({ arguments: { n: 30 }, id: "c", name: "read_c" });
    d.record(a, completed({ output: "A" }), false);
    d.record(b, completed({ output: "B" }), true);
    d.record(c, completed({ output: "C" }), false);
    expect(d.check(a)).toMatchObject({ duplicate: false }); // evicted (oldest)
    expect(d.check(b)).toMatchObject({ duplicate: true });
    expect(d.check(c)).toMatchObject({ duplicate: true });
  });
});
