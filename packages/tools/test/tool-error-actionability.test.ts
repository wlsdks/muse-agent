/**
 * What a tool says when the argument is WRONG.
 *
 * Selection was audited; this seam was not. It matters because Muse runs a
 * small local model whose coherence degrades after 2-3 steps: the tool's answer
 * to a bad call decides whether the model recovers in ONE step or burns the
 * budget re-guessing. Two failure shapes are pinned here, both found by probing
 * the real tools:
 *
 *   - an error that names the rejected value but not the expected FORM, so the
 *     model guesses again ("unsupported timezone: Seoul"),
 *   - an internal parser message with no context ("expected number").
 *
 * The rule each test encodes: an error names the parameter, the expected form,
 * AND a concrete valid value.
 */

import { describe, expect, it } from "vitest";

import { createMathEvalTool } from "../src/muse-tools-data.js";
import { createNumberBaseTool } from "../src/muse-tools-number-base.js";
import { createTimeNowTool } from "../src/muse-tools-time.js";

const ctx = { runId: "r", userId: "u" };

describe("a rejected argument tells the model how to fix it", () => {
  it("time_now names the IANA form and an example, not just the rejected value", async () => {
    const out = await createTimeNowTool(() => new Date("2026-07-21T00:00:00Z")).execute({ timezone: "Seoul" }, ctx) as { error?: string };
    expect(out.error).toContain("Seoul");
    expect(out.error).toMatch(/IANA/iu);
    expect(out.error).toContain("Asia/Seoul");
  });

  it("math_eval explains an incomplete expression and shows a valid one", async () => {
    const out = await createMathEvalTool().execute({ expression: "2 +" }, ctx) as { error?: string };
    // A worked example is what lets the model correct itself in one step.
    expect(out.error).toMatch(/incomplete/iu);
    expect(out.error).toContain("2 + 3");
  });

  it("math_eval leaves an ALREADY-specific error alone", async () => {
    // The first fix here wrapped every failure in "give a complete arithmetic
    // expression", which is misleading for 1/0 — the expression IS complete.
    // Guidance belongs at the source of the vague message, not on all of them.
    const out = await createMathEvalTool().execute({ expression: "1/0" }, ctx) as { error?: string };
    expect(out.error).toBe("division by zero");
  });

  it("number_base echoes what it RECEIVED instead of a blank it coerced to", async () => {
    // from/to are read as enum names; a numeric 99 used to be coerced to "" and
    // the message read "from '' to ''", which says nothing about the input.
    const out = await createNumberBaseTool().execute({ from: 16, to: 99, value: "ff" }, ctx) as { error?: string };
    expect(out.error).toContain("99");
    expect(out.error).not.toMatch(/from '' /u);
    expect(out.error).toMatch(/binary.*octal.*decimal.*hex/u);
  });

  it("number_base accepts a radix NUMBER as an alias for the enum name", async () => {
    // A model asked for "base 16" sends 16, not "hex". Repairing a predictable
    // near-miss beats refusing and being re-guessed.
    const out = await createNumberBaseTool().execute({ from: 16, to: 10, value: "ff" }, ctx) as { decimal?: string; error?: string };
    expect(out.error).toBeUndefined();
    expect(out.decimal).toBe("255");
  });

  it("number_base names the valid digits when the value does not fit the base", async () => {
    const out = await createNumberBaseTool().execute({ from: "binary", to: "decimal", value: "2" }, ctx) as { error?: string };
    expect(out.error).toContain("binary");
    expect(out.error).toContain("0 and 1");
  });
});
