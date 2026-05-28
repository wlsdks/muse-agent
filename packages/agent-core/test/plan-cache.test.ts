import { describe, expect, it } from "vitest";

import { renderPlanExemplar, selectPlanExemplar, type CachedPlan } from "../src/index.js";

const plan = (prompt: string, tool: string): CachedPlan => ({
  prompt,
  steps: [{ args: {}, description: "step", tool }]
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
