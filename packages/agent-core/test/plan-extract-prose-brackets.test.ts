import { describe, expect, it } from "vitest";

import { extractJsonArray, parsePlan } from "../src/plan-execute.js";

const VALID_PLAN = `[{"tool":"search","args":{"q":"x"},"description":"find it"}]`;
const PARSED_PLAN = [{ args: { q: "x" }, description: "find it", tool: "search" }];

// The local Qwen planner (CLAUDE.md: qwen3:8b, reasoning=false) routinely
// wraps its JSON plan in prose, and that prose frequently contains a `[`:
// markdown checkboxes, numeric ranges, citations, example arrays. Anchoring
// extraction on the literal first `[` made any such preamble swallow the
// real plan and surface as a silent PLAN_GENERATION_FAILED. parsePlan now
// walks every JSON-array candidate and returns the first that is actually a
// plan, so none of these preambles lose it.
describe("parsePlan — prose/array preambles must not eat the real plan", () => {
  const proseCases: ReadonlyArray<readonly [string, string]> = [
    ["numeric range", `Here is the plan for steps [1-3]:\n${VALID_PLAN}`],
    ["half-open interval (unbalanced bracket)", `I will cover [0,5) then run:\n${VALID_PLAN}`],
    ["markdown checkbox list (empty array [ ])", `Plan:\n- [x] decide\n- [ ] act\n${VALID_PLAN}`],
    ["citation marker (valid 1-elem array [2])", `Per the docs [2], the plan is: ${VALID_PLAN}`],
    ["irrelevant valid array before the plan", `tags: ["a","b"] then ${VALID_PLAN}`],
    ["multiple stray + valid arrays", `[x] [2] ["a"] finally ${VALID_PLAN}`]
  ];

  for (const [label, text] of proseCases) {
    it(`recovers the trailing plan despite: ${label}`, () => {
      expect(parsePlan(text)).toEqual(PARSED_PLAN);
    });
  }

  it("returns null when there is genuinely no plan-shaped array", () => {
    expect(parsePlan("no brackets at all")).toBeNull();
    expect(parsePlan("only [non json] brackets [here]")).toBeNull();
    expect(parsePlan("steps: [1-3] but no actual plan")).toBeNull();
  });

  it("a lone empty array is still the valid empty plan", () => {
    expect(parsePlan("[]")).toEqual([]);
    expect(parsePlan("The plan is: []")).toEqual([]);
  });

  it("does not let a `]` inside step text close the array early", () => {
    const withBracketInText = `[{"tool":"a","args":{"q":"find ] and ["},"description":"x"}]`;
    expect(parsePlan(`note [ref]: ${withBracketInText}`)).toEqual([
      { args: { q: "find ] and [" }, description: "x", tool: "a" }
    ]);
  });

  it("known narrow limit: a plan-SHAPED array in prose before the real plan wins", () => {
    // Only an array that already validates as a plan can shadow the real
    // one. This is the irreducible ambiguity (which plan did the model
    // mean?) — pinned so a future change is a deliberate decision.
    const decoy = `example: [{"tool":"noop","args":{}}] real: ${VALID_PLAN}`;
    expect(parsePlan(decoy)).toEqual([{ args: {}, description: "", tool: "noop" }]);
  });
});

describe("extractJsonArray — first VALID JSON array (lower-level contract)", () => {
  it("returns the plan when it is the first valid JSON array", () => {
    expect(extractJsonArray(`Sure: ${VALID_PLAN}`)).toBe(VALID_PLAN);
  });

  it("skips non-JSON bracket spans", () => {
    expect(extractJsonArray(`steps [1-3]: ${VALID_PLAN}`)).toBe(VALID_PLAN);
  });

  it("returns the first valid array even if trivial (parsePlan does plan-aware selection)", () => {
    expect(extractJsonArray(`[2] then ${VALID_PLAN}`)).toBe("[2]");
  });

  it("returns null when no balanced span parses as JSON", () => {
    expect(extractJsonArray("[ { unbalanced ")).toBeNull();
    expect(extractJsonArray("no array here")).toBeNull();
  });
});
