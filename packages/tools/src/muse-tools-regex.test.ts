import { describe, expect, it } from "vitest";

import { createMuseTools, hasNestedUnboundedQuantifier } from "./muse-tools.js";

const regexTool = () => {
  const tool = createMuseTools().find((t) => t.definition.name === "regex_extract");
  if (!tool) throw new Error("regex_extract tool not found");
  return tool;
};

describe("hasNestedUnboundedQuantifier — catastrophic-backtracking detector", () => {
  it("flags the classic nested-quantifier shapes", () => {
    for (const p of ["(a+)+", "(a*)*", "(.*)+", "(.*)*", "([a-z]+){2,}", "((a+))+", "(\\w+\\s)+", "(\\d+)+$"]) {
      expect(hasNestedUnboundedQuantifier(p)).toBe(true);
    }
  });

  it("accepts ordinary safe patterns the model actually writes", () => {
    for (const p of ["\\d+", "(ab)+", "(a|b)+", "(\\d{3})-(\\d{4})", "[\\w.]+@[\\w.-]+\\.\\w+", "https?://\\S+", "(foo)*bar", "#\\w+"]) {
      expect(hasNestedUnboundedQuantifier(p)).toBe(false);
    }
  });

  it("skips escaped parens/quantifiers (a literal \\(a+\\)+ is not a group)", () => {
    expect(hasNestedUnboundedQuantifier("\\(a+\\)\\+")).toBe(false);
  });
});

describe("regex_extract — rejects catastrophic patterns instead of hanging", () => {
  it("returns an error (no event-loop hang) for a nested-quantifier pattern", () => {
    const out = regexTool().execute({ pattern: "(a+)+$", text: "a".repeat(50) + "!" }, { runId: "r", userId: "u" }) as { error?: string; matches?: string[] };
    expect(out.error).toBeTruthy();
    expect(String(out.error).toLowerCase()).toMatch(/backtrack|catastroph|simplif|vulnerab/);
    expect(out.matches).toBeUndefined();
  });

  it("still extracts with a normal pattern", () => {
    const out = regexTool().execute({ pattern: "\\d+", text: "a1 b22 c333" }, { runId: "r", userId: "u" }) as { matches?: string[] };
    expect(out.matches).toEqual(["1", "22", "333"]);
  });
});
