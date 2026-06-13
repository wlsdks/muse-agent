import type { JsonValue } from "@muse/shared";
import { describe, expect, it } from "vitest";

import { dedupeExactSteps, dedupeNearDuplicateSteps, validatePlan, type PlanStep } from "../src/plan-execute.js";

// Unit tests for ISR-LLM (arXiv:2308.13724) plan validation extensions:
// arg-presence checks, exact-duplicate detection, and deduplication.

const echoSchema: JsonValue = {
  type: "object",
  properties: { value: { type: "string" } },
  required: ["value"]
};

const multiArgSchema: JsonValue = {
  type: "object",
  properties: {
    name: { type: "string" },
    count: { type: "integer" }
  },
  required: ["name", "count"]
};

const coercibleSchema: JsonValue = {
  type: "object",
  properties: { count: { type: "integer" } },
  required: ["count"]
};

const makeStep = (tool: string, args: Record<string, unknown>, description = "step"): PlanStep => ({
  args: args as PlanStep["args"],
  description,
  tool
});

const toolSchemas = new Map<string, JsonValue>([
  ["echo_value", echoSchema],
  ["multi_arg", multiArgSchema],
  ["coercible_tool", coercibleSchema]
]);

const availableToolNames = new Set(["echo_value", "multi_arg", "coercible_tool"]);

describe("validatePlan — required arg checks (ISR-LLM arXiv:2308.13724)", () => {
  it("flags a step missing a required arg with the correct stepIndex and arg name", () => {
    const steps = [makeStep("echo_value", {})];
    const result = validatePlan({ availableToolNames, steps, toolSchemas });
    expect(result.valid).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatchObject({ stepIndex: 0, tool: "echo_value", reason: "missing required argument 'value'" });
  });

  it("counterfactual: same plan WITH the required arg supplied → valid (no error)", () => {
    const steps = [makeStep("echo_value", { value: "hello" })];
    const result = validatePlan({ availableToolNames, steps, toolSchemas });
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("flags missing args on a LATER step (multi-step: first valid, second missing)", () => {
    const steps = [
      makeStep("echo_value", { value: "ok" }),
      makeStep("multi_arg", { name: "test" }) // missing 'count'
    ];
    const result = validatePlan({ availableToolNames, steps, toolSchemas });
    expect(result.valid).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatchObject({ stepIndex: 1, tool: "multi_arg", reason: "missing required argument 'count'" });
  });

  it("coercible value ('5' for integer param) is NOT flagged — coercion runs before validation", () => {
    const steps = [makeStep("coercible_tool", { count: "5" })];
    const result = validatePlan({ availableToolNames, steps, toolSchemas });
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("multiple missing args on one step → one error per missing arg", () => {
    const steps = [makeStep("multi_arg", {})];
    const result = validatePlan({ availableToolNames, steps, toolSchemas });
    expect(result.valid).toBe(false);
    const reasons = result.errors.map((e) => e.reason);
    expect(reasons).toContain("missing required argument 'name'");
    expect(reasons).toContain("missing required argument 'count'");
  });

  it("toolSchemas absent → byte-identical to prior behaviour (no arg errors, only name/blank checks)", () => {
    const steps = [makeStep("echo_value", {}), makeStep("multi_arg", { name: "x" })];

    const withSchemas = validatePlan({ availableToolNames, steps, toolSchemas });
    const withoutSchemas = validatePlan({ availableToolNames, steps });

    // With schemas: missing arg errors appear.
    expect(withSchemas.valid).toBe(false);
    // Without schemas: no arg errors — behaves exactly as before.
    expect(withoutSchemas.valid).toBe(true);
    expect(withoutSchemas.errors).toHaveLength(0);
  });
});

describe("validatePlan — exact-duplicate detection", () => {
  it("flags a step that repeats an earlier step verbatim with 'repeats step N verbatim'", () => {
    const steps = [
      makeStep("echo_value", { value: "x" }),
      makeStep("echo_value", { value: "x" }) // exact dup of step 0
    ];
    const result = validatePlan({ availableToolNames, steps, toolSchemas });
    expect(result.valid).toBe(false);
    const dupError = result.errors.find((e) => e.reason.startsWith("repeats step"));
    expect(dupError).toBeDefined();
    expect(dupError?.stepIndex).toBe(1);
    expect(dupError?.reason).toBe("repeats step 0 verbatim");
  });

  it("near-duplicate (different args) is NOT flagged", () => {
    const steps = [
      makeStep("echo_value", { value: "x" }),
      makeStep("echo_value", { value: "y" }) // different arg → not a dup
    ];
    const result = validatePlan({ availableToolNames, steps, toolSchemas });
    const dupError = result.errors.find((e) => e.reason.startsWith("repeats step"));
    expect(dupError).toBeUndefined();
  });

  it("duplicate detection is key-order-independent ({a,b} and {b,a} are the same)", () => {
    const steps = [
      makeStep("multi_arg", { name: "alice", count: 3 }),
      makeStep("multi_arg", { count: 3, name: "alice" }) // same values, different key order
    ];
    const result = validatePlan({ availableToolNames, steps, toolSchemas });
    const dupError = result.errors.find((e) => e.reason.startsWith("repeats step"));
    expect(dupError).toBeDefined();
    expect(dupError?.stepIndex).toBe(1);
  });

  it("toolSchemas absent — duplicate detection still works", () => {
    const steps = [
      makeStep("echo_value", { value: "x" }),
      makeStep("echo_value", { value: "x" })
    ];
    const result = validatePlan({ availableToolNames, steps });
    const dupError = result.errors.find((e) => e.reason.startsWith("repeats step"));
    expect(dupError).toBeDefined();
  });
});

describe("dedupeExactSteps", () => {
  it("returns the same array reference when no duplicates exist (non-vacuity)", () => {
    const steps = [
      makeStep("echo_value", { value: "a" }),
      makeStep("echo_value", { value: "b" })
    ];
    const result = dedupeExactSteps(steps);
    expect(result).toHaveLength(2);
    expect(result[0]?.args).toEqual({ value: "a" });
    expect(result[1]?.args).toEqual({ value: "b" });
  });

  it("drops the second occurrence of an exact duplicate, preserving order", () => {
    const steps = [
      makeStep("echo_value", { value: "x" }, "first"),
      makeStep("echo_value", { value: "y" }, "second"),
      makeStep("echo_value", { value: "x" }, "dup of first")
    ];
    const result = dedupeExactSteps(steps);
    expect(result).toHaveLength(2);
    expect(result[0]?.description).toBe("first");
    expect(result[1]?.description).toBe("second");
  });

  it("an empty plan stays empty", () => {
    expect(dedupeExactSteps([])).toHaveLength(0);
  });

  it("a single-step plan is unchanged", () => {
    const steps = [makeStep("echo_value", { value: "z" })];
    const result = dedupeExactSteps(steps);
    expect(result).toHaveLength(1);
  });

  it("distinct-args plan is returned unchanged (non-vacuity assertion)", () => {
    const steps = [
      makeStep("multi_arg", { name: "alice", count: 1 }),
      makeStep("multi_arg", { name: "bob", count: 2 }),
      makeStep("multi_arg", { name: "carol", count: 3 })
    ];
    const result = dedupeExactSteps(steps);
    expect(result).toHaveLength(3);
  });
});

describe("dedupeNearDuplicateSteps (Mem0 arXiv:2504.19413 consolidate-before-add)", () => {
  it("positive collapse — trailing whitespace variant: {q:'Paris '} vs {q:'Paris'} → length 1", () => {
    const steps = [
      makeStep("search", { q: "Paris " }, "first"),
      makeStep("search", { q: "Paris" }, "second")
    ];
    const result = dedupeNearDuplicateSteps(steps);
    expect(result).toHaveLength(1);
    expect(result[0]?.description).toBe("first");
    expect(result[0]?.args).toEqual({ q: "Paris " });
  });

  it("positive collapse — case variant: {q:'Paris '} vs {q:'paris'} → length 1", () => {
    const steps = [
      makeStep("search", { q: "Paris " }, "first"),
      makeStep("search", { q: "paris" }, "second")
    ];
    const result = dedupeNearDuplicateSteps(steps);
    expect(result).toHaveLength(1);
    expect(result[0]?.description).toBe("first");
    // Original args of the FIRST occurrence are kept unmutated.
    expect(result[0]?.args).toEqual({ q: "Paris " });
  });

  it("positive collapse — numeric-string vs number: {n:'5'} vs {n:5} → length 1", () => {
    const steps = [
      makeStep("count_items", { n: "5" }, "first"),
      makeStep("count_items", { n: 5 }, "second")
    ];
    const result = dedupeNearDuplicateSteps(steps);
    expect(result).toHaveLength(1);
    expect(result[0]?.description).toBe("first");
    expect(result[0]?.args).toEqual({ n: "5" });
  });

  it("positive collapse — numeric-string with decimal: {x:'5.0'} vs {x:5} → length 1", () => {
    const steps = [
      makeStep("count_items", { x: "5.0" }, "first"),
      makeStep("count_items", { x: 5 }, "second")
    ];
    const result = dedupeNearDuplicateSteps(steps);
    expect(result).toHaveLength(1);
    expect(result[0]?.args).toEqual({ x: "5.0" });
  });

  it("OVER-MERGE counterfactual — different values {q:'Paris'} vs {q:'London'} → length 2 (NOT merged)", () => {
    const steps = [
      makeStep("search", { q: "Paris" }),
      makeStep("search", { q: "London" })
    ];
    const result = dedupeNearDuplicateSteps(steps);
    expect(result).toHaveLength(2);
  });

  it("OVER-MERGE counterfactual — different tools same args → length 2 (NOT merged)", () => {
    const steps = [
      makeStep("tool_a", { x: 1 }),
      makeStep("tool_b", { x: 1 })
    ];
    const result = dedupeNearDuplicateSteps(steps);
    expect(result).toHaveLength(2);
  });

  it("order-preserving: first occurrence kept with ORIGINAL args unmutated", () => {
    const steps = [
      makeStep("search", { q: "Paris " }, "original"),
      makeStep("search", { q: "paris" }, "duplicate")
    ];
    const result = dedupeNearDuplicateSteps(steps);
    expect(result).toHaveLength(1);
    expect(result[0]?.description).toBe("original");
    expect(result[0]?.args).toEqual({ q: "Paris " });
  });

  it("superset parity: collapses every byte-identical case that dedupeExactSteps would collapse", () => {
    const steps = [
      makeStep("echo_value", { value: "x" }),
      makeStep("echo_value", { value: "x" })
    ];
    expect(dedupeExactSteps(steps)).toHaveLength(1);
    expect(dedupeNearDuplicateSteps(steps)).toHaveLength(1);
  });

  it("empty plan stays empty", () => {
    expect(dedupeNearDuplicateSteps([])).toHaveLength(0);
  });

  it("single-step plan unchanged", () => {
    const steps = [makeStep("search", { q: "test" })];
    expect(dedupeNearDuplicateSteps(steps)).toHaveLength(1);
  });

  it("internal whitespace collapsed: {q:'New  York'} vs {q:'New York'} → length 1", () => {
    const steps = [
      makeStep("search", { q: "New  York" }, "first"),
      makeStep("search", { q: "New York" }, "second")
    ];
    const result = dedupeNearDuplicateSteps(steps);
    expect(result).toHaveLength(1);
    expect(result[0]?.args).toEqual({ q: "New  York" });
  });

  it("genuinely different numeric values are NOT merged: {n:5} vs {n:6} → length 2", () => {
    const steps = [
      makeStep("count_items", { n: 5 }),
      makeStep("count_items", { n: 6 })
    ];
    const result = dedupeNearDuplicateSteps(steps);
    expect(result).toHaveLength(2);
  });
});
