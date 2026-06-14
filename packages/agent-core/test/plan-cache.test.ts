import { describe, expect, it } from "vitest";

import { exemplarFitsToolset, exemplarIsSelfConsistent, renderPlanExemplar, selectPlanExemplar, selectSuccessfulPlanSteps, type CachedPlan } from "../src/index.js";

const plan = (prompt: string, tool: string): CachedPlan => ({
  prompt,
  steps: [{ args: {}, description: "step", tool }]
});

describe("selectSuccessfulPlanSteps — outcome-conditioned step filter (AWM, arXiv:2409.07429)", () => {
  const step = (tool: string) => ({ args: {}, description: tool, tool });

  it("returns only the successful steps in order when mixed success/fail", () => {
    const executed = [
      { step: step("step_a"), stepResult: { success: true } },
      { step: step("step_b"), stepResult: { success: false } },
      { step: step("step_c"), stepResult: { success: true } }
    ];
    const result = selectSuccessfulPlanSteps(executed);
    expect(result).toHaveLength(2);
    expect(result[0]!.tool).toBe("step_a");
    expect(result[1]!.tool).toBe("step_c");
  });

  it("returns all steps when every step succeeded (identity case)", () => {
    const executed = [
      { step: step("step_a"), stepResult: { success: true } },
      { step: step("step_b"), stepResult: { success: true } }
    ];
    const result = selectSuccessfulPlanSteps(executed);
    expect(result).toHaveLength(2);
    expect(result[0]!.tool).toBe("step_a");
    expect(result[1]!.tool).toBe("step_b");
  });

  it("returns empty array when every step failed", () => {
    const executed = [
      { step: step("step_a"), stepResult: { success: false } },
      { step: step("step_b"), stepResult: { success: false } }
    ];
    expect(selectSuccessfulPlanSteps(executed)).toHaveLength(0);
  });

  it("returns empty array for empty input", () => {
    expect(selectSuccessfulPlanSteps([])).toHaveLength(0);
  });
});

describe("selectPlanExemplar — retrieve the most similar past plan (Agentic Plan Caching, arXiv 2506.14852)", () => {
  it("returns the most similar past plan above the threshold", () => {
    const entries = [
      plan("summarize my Q3 budget notes", "notes_search"),
      plan("book a dentist appointment", "calendar_create")
    ];
    const out = selectPlanExemplar(entries, "summarize my Q4 budget notes");
    expect(out?.steps[0]!.tool).toBe("notes_search");
  });

  it("returns undefined when nothing is similar enough", () => {
    const entries = [plan("book a dentist appointment", "calendar_create")];
    expect(selectPlanExemplar(entries, "deploy the backend to production")).toBeUndefined();
  });

  it("returns undefined for an empty cache", () => {
    expect(selectPlanExemplar([], "anything at all here")).toBeUndefined();
  });
});

describe("renderPlanExemplar — format a past plan as a planning few-shot", () => {
  it("renders the prompt and the steps as JSON", () => {
    const out = renderPlanExemplar({
      prompt: "summarize notes",
      steps: [{ args: { query: "x" }, description: "find notes", tool: "notes_search" }]
    });
    expect(out).toContain("summarize notes");
    expect(out).toContain("notes_search");
    expect(out).toContain("\"tool\"");
  });
});

describe("exemplarFitsToolset — RAP retrieval-side toolset-fit gate (arXiv:2402.03610)", () => {
  const twoStepPlan: CachedPlan = {
    prompt: "search the web and save notes",
    steps: [
      { args: { query: "weather" }, description: "search", tool: "web_search" },
      { args: { content: "sunny" }, description: "save", tool: "notes_add" }
    ]
  };

  it("positive: all exemplar tools present in availableToolNames → true", () => {
    const available = new Set(["web_search", "notes_add", "calendar_add"]);
    expect(exemplarFitsToolset(twoStepPlan, available)).toBe(true);
  });

  it("negative (discriminator): one tool absent from availableToolNames → false", () => {
    // web_search NOT registered in this turn; notes_add is.
    const available = new Set(["notes_add", "calendar_add"]);
    expect(exemplarFitsToolset(twoStepPlan, available)).toBe(false);
  });

  it("empty-steps exemplar → false (no steps to validate = no fit)", () => {
    const emptyPlan: CachedPlan = { prompt: "something", steps: [] };
    const available = new Set(["web_search", "notes_add"]);
    expect(exemplarFitsToolset(emptyPlan, available)).toBe(false);
  });

  it("counterfactual: same exemplar, toolset WITH the tool → true; WITHOUT → false", () => {
    const singleStepPlan: CachedPlan = {
      prompt: "search web",
      steps: [{ args: {}, description: "search", tool: "web_search" }]
    };
    expect(exemplarFitsToolset(singleStepPlan, new Set(["web_search", "notes_add"]))).toBe(true);
    expect(exemplarFitsToolset(singleStepPlan, new Set(["notes_add"]))).toBe(false);
  });
});

describe("exemplarIsSelfConsistent — RAP structural-validity gate (arXiv:2402.03610 + LLMCompiler arXiv:2312.04511)", () => {
  it("valid plan (a later step references an EARLIER step) → true", () => {
    const valid: CachedPlan = {
      prompt: "search then save",
      steps: [
        { args: { query: "weather" }, description: "search", tool: "web_search" },
        { args: { content: "{{step1}}" }, description: "save the result", tool: "notes_add" }
      ]
    };
    expect(exemplarIsSelfConsistent(valid)).toBe(true);
  });

  it("dangling/forward ref (the artifact selectSuccessfulPlanSteps can leave) → false", () => {
    // A surviving step references {{step2}} but that producer was filtered out.
    const dangling: CachedPlan = {
      prompt: "save notes",
      steps: [{ args: { content: "{{step2}}" }, description: "save", tool: "notes_add" }]
    };
    expect(exemplarIsSelfConsistent(dangling)).toBe(false);
  });

  it("plain plan with no dependency tokens → true", () => {
    const plain: CachedPlan = {
      prompt: "search",
      steps: [{ args: { query: "weather" }, description: "search", tool: "web_search" }]
    };
    expect(exemplarIsSelfConsistent(plain)).toBe(true);
  });
});
