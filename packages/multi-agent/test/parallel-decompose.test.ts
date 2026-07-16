import { fc, test } from "@fast-check/vitest";
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
  test.prop([
    fc.array(
      fc.array(fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz"), { minLength: 1, maxLength: 24 })
        .map((characters) => characters.join("")),
      { minLength: 2, maxLength: 5 }
    )
  ])("preserves every generated subtask while stripping supported list markers", (titles) => {
    const markers = ["-", "*", "•", "1.", "2)"] as const;
    const output = titles.map((title, index) => `${markers[index]!} ${title}`).join("\n");
    expect(parseParallelPlan(output)).toEqual(titles);
  });
  test.prop([fc.string(), fc.string()])("treats an explicit NONE line as fail-closed for any surrounding output", (before, after) => {
    expect(parseParallelPlan(`${before}\nNONE\n${after}`)).toEqual([]);
  });
  it("planParallelSubtasks pipes the model output through the parser", async () => {
    const subs = await planParallelSubtasks("compare X and Y", { generate: async () => "compare X\ncompare Y" });
    expect(subs).toEqual(["compare X", "compare Y"]);
    const none = await planParallelSubtasks("one task", { generate: async () => "NONE" });
    expect(none).toEqual([]);
  });
});

import { parallelDecomposePrompt } from "../src/parallel-decompose.js";

describe("parallelDecomposePrompt", () => {
  it("embeds the goal and instructs the model to answer NONE for a non-parallel goal", () => {
    const p = parallelDecomposePrompt("compare X and Y");
    expect(p).toContain("compare X and Y");
    expect(p).toMatch(/INDEPENDENT/u);
    expect(p).toMatch(/NONE/u);
  });
});
