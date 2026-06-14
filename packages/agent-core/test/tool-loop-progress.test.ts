import { describe, expect, it } from "vitest";

import {
  detectToolLoopStall,
  ToolLoopProgressTracker,
  TOOL_LOOP_STALL_WINDOW
} from "../src/index.js";

// Extrinsic early-exit (arXiv:2505.17616): halt a tool loop trapped re-issuing
// near-identical READs that don't advance state.

describe("detectToolLoopStall", () => {
  it("stalled: the last `window` observations are near-identical", () => {
    expect(detectToolLoopStall([
      "search results: alpha beta gamma delta",
      "search results: alpha beta gamma delta",
      "search results: alpha beta gamma delta"
    ])).toBe(true);
  });

  it("NOT stalled: fewer than `window` observations", () => {
    expect(detectToolLoopStall(["alpha beta gamma", "alpha beta gamma"])).toBe(false);
  });

  it("NOT stalled: progressing reads (different content each turn)", () => {
    expect(detectToolLoopStall([
      "search results: alpha beta gamma",
      "search results: delta epsilon zeta",
      "search results: eta theta iota"
    ])).toBe(false);
  });

  it("NOT stalled: a recent observation breaks the near-identity", () => {
    expect(detectToolLoopStall([
      "alpha beta gamma delta",
      "alpha beta gamma delta",
      "completely different content here now"
    ])).toBe(false);
  });

  it("only the LAST window matters (early repetition then progress → not stalled)", () => {
    expect(detectToolLoopStall([
      "same same same same",
      "same same same same",
      "now something new entirely",
      "and another distinct page"
    ])).toBe(false);
  });

  it("exports the window default", () => {
    expect(TOOL_LOOP_STALL_WINDOW).toBe(3);
  });
});

describe("ToolLoopProgressTracker", () => {
  it("flags a stall after window near-identical READ results", () => {
    const t = new ToolLoopProgressTracker();
    t.record("results: alpha beta gamma", false);
    t.record("results: alpha beta gamma", false);
    expect(t.stalled()).toBe(false); // only 2
    t.record("results: alpha beta gamma", false);
    expect(t.stalled()).toBe(true); // 3 near-identical
  });

  it("a WRITE/EXECUTE result RESETS the window (it advanced state)", () => {
    const t = new ToolLoopProgressTracker();
    t.record("results: alpha beta gamma", false);
    t.record("results: alpha beta gamma", false);
    t.record("wrote the file", true); // mutating → reset
    t.record("results: alpha beta gamma", false);
    expect(t.stalled()).toBe(false); // window reset; only 1 read since
  });
});
