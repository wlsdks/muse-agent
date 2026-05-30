import { describe, expect, it } from "vitest";

import {
  measureSystemPromptBudget,
  measureSystemPromptText,
  promptBudgetSpanAttributes
} from "../src/prompt-budget.js";

describe("measureSystemPromptText", () => {
  it("counts the whole content as prelude when no markers are present", () => {
    const report = measureSystemPromptText("You are Muse. Be terse.");
    expect(report.sections).toEqual([]);
    expect(report.preludeChars).toBe(report.totalChars);
    expect(report.totalChars).toBe("You are Muse. Be terse.".length);
    expect(report.totalEstimatedTokens).toBeGreaterThan(0);
  });

  it("splits a multi-section system prompt by marker and counts each", () => {
    const text = [
      "You are Muse.",
      "",
      "<!-- muse:active-context -->",
      "[Active Context]",
      "now=2026-05-11T08:00:00Z (Monday, UTC)",
      "",
      "<!-- muse:inbox-context -->",
      "[Recent Messages]",
      "— slack C1 (1):",
      "  · 2026-05-11T07:45:00Z bob: standup at 10",
      "",
      "<!-- muse:skills-catalog -->",
      "[Available Skills]",
      "- github (bins: gh): GitHub CLI"
    ].join("\n");
    const report = measureSystemPromptText(text);
    expect(report.sections.map((section) => section.id)).toEqual([
      "active-context",
      "inbox-context",
      "skills-catalog"
    ]);
    // Prelude is "You are Muse." plus the surrounding blank line.
    expect(report.preludeChars).toBeGreaterThan(0);
    expect(report.preludeChars).toBeLessThan(report.totalChars);
    // Per-section chars roughly correspond to slice lengths.
    expect(report.sections[0]?.chars).toBeGreaterThan(20);
    expect(report.sections[0]?.estimatedTokens).toBeGreaterThan(0);
    // Sum of section chars + prelude approximates the total.
    const sectionChars = report.sections.reduce((sum, s) => sum + s.chars, 0);
    expect(report.preludeChars + sectionChars).toBe(report.totalChars);
  });

  it("handles a marker with no body (transform fired but produced nothing observable)", () => {
    const text = "lead\n\n<!-- muse:active-context -->";
    const report = measureSystemPromptText(text);
    expect(report.sections).toHaveLength(1);
    expect(report.sections[0]?.id).toBe("active-context");
    expect(report.sections[0]?.chars).toBe("<!-- muse:active-context -->".length);
  });

  it("conserves chars: preludeChars + Σ section.chars === totalChars (no double-count, no gap)", () => {
    const text = "PRELUDE base prompt.\n<!-- muse:memory -->\nmem section text\n<!-- muse:tools -->\ntool section text";
    const report = measureSystemPromptText(text);
    expect(report.preludeChars).toBe(text.indexOf("<!-- muse:memory")); // prelude is everything before the first marker
    const sum = report.preludeChars + report.sections.reduce((acc, s) => acc + s.chars, 0);
    expect(sum).toBe(report.totalChars);
    expect(report.sections.map((s) => s.id)).toEqual(["memory", "tools"]);
  });
});

describe("measureSystemPromptBudget", () => {
  it("returns undefined when there is no system message", () => {
    expect(
      measureSystemPromptBudget([
        { content: "hi", role: "user" }
      ])
    ).toBeUndefined();
  });

  it("measures the FIRST system message when multiple exist (the runtime convention)", () => {
    const report = measureSystemPromptBudget([
      { content: "You are Muse.\n\n<!-- muse:active-context -->\nnow=...", role: "system" },
      { content: "hi", role: "user" },
      // A second system message must NOT be measured.
      { content: "<!-- muse:skills-catalog -->\n[Available Skills]", role: "system" }
    ]);
    expect(report?.sections.map((section) => section.id)).toEqual(["active-context"]);
  });
});

describe("promptBudgetSpanAttributes", () => {
  it("flattens a report into ctx.budget.* attributes", () => {
    const attrs = promptBudgetSpanAttributes({
      preludeChars: 12,
      sections: [
        { chars: 80, estimatedTokens: 20, id: "active-context" },
        { chars: 256, estimatedTokens: 64, id: "skills-catalog" }
      ],
      totalChars: 348,
      totalEstimatedTokens: 84
    });
    expect(attrs).toMatchObject({
      "ctx.budget.prelude_chars": 12,
      "ctx.budget.section.active-context.chars": 80,
      "ctx.budget.section.active-context.tokens": 20,
      "ctx.budget.section.skills-catalog.chars": 256,
      "ctx.budget.section.skills-catalog.tokens": 64,
      "ctx.budget.total_chars": 348,
      "ctx.budget.total_tokens": 84
    });
  });

  it("a duplicate section id keeps both in the report but the flat span attr is last-wins (documents the collision)", () => {
    const report = measureSystemPromptText("<!-- muse:tools -->\nAAA\n<!-- muse:tools -->\nBBBB");
    expect(report.sections).toHaveLength(2); // both sections are measured
    expect(report.sections.map((s) => s.id)).toEqual(["tools", "tools"]);
    // the flat attribute map keys by id, so the SECOND section's chars win
    const attrs = promptBudgetSpanAttributes(report);
    expect(attrs["ctx.budget.section.tools.chars"]).toBe(report.sections[1]!.chars);
  });
});
