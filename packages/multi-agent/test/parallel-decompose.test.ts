import { describe, expect, it } from "vitest";

import { parseParallelPlan, planParallelSubtasks } from "../src/parallel-decompose.js";

describe("parseParallelPlan — the deterministic contract on the model's reply", () => {
  it("a refusal (NONE) → [] (never force-splits a single/sequential goal)", () => {
    expect(parseParallelPlan("NONE")).toEqual([]);
    expect(parseParallelPlan("None.")).toEqual([]);
    expect(parseParallelPlan("research A\nNONE")).toEqual([]); // any NONE line abstains
  });
  it("strips list markers and blank lines, keeping the titles", () => {
    expect(parseParallelPlan("1. research Python\n2. research Rust\n- research Go")).toEqual(["research Python", "research Rust", "research Go"]);
    expect(parseParallelPlan("\n* a\n\n* b\n")).toEqual(["a", "b"]);
  });
  it("fewer than 2 real lines → [] (not a parallel decomposition)", () => {
    expect(parseParallelPlan("just one thing")).toEqual([]);
    expect(parseParallelPlan("")).toEqual([]);
  });
  it("planParallelSubtasks pipes the model output through the parser", async () => {
    const subs = await planParallelSubtasks("compare X and Y", { generate: async () => "compare X\ncompare Y" });
    expect(subs).toEqual(["compare X", "compare Y"]);
    const none = await planParallelSubtasks("one task", { generate: async () => "NONE" });
    expect(none).toEqual([]);
  });
});
