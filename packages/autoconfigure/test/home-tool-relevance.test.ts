import { DefaultToolFilter } from "@muse/agent-core";
import { createHomeActionTool, createHomeEntitiesTool, createHomeStateTool } from "@muse/domain-tools";
import { describe, expect, it } from "vitest";

// The REAL home tools, run through the REAL relevance filter. Proves a
// NATURAL home prompt surfaces them (the human's one-shot-selection
// concern) — and an unrelated prompt does NOT (so the exposed set stays
// small per tool-calling.md rule 1).
const filter = new DefaultToolFilter();
const deps = { baseUrl: "http://ha.local", token: "t" };
const homeTools = [
  createHomeStateTool(deps),
  createHomeEntitiesTool(deps),
  createHomeActionTool({ ...deps, actionLogFile: "/tmp/x", approvalGate: () => ({ approved: false }), fetchImpl: globalThis.fetch, userId: "u" })
];

function surfaced(userMessage: string): string[] {
  return filter.filter(homeTools, { userMessage }).map((t) => t.definition.name);
}

describe("home tools surface for NATURAL home prompts (one-shot selection)", () => {
  it("'is the front door locked?' surfaces the home read tools", () => {
    const names = surfaced("is the front door locked?");
    expect(names).toContain("home_state");
  });

  it("'turn on the living room lights' surfaces home_action", () => {
    expect(surfaced("turn on the living room lights")).toContain("home_action");
  });

  it("'what smart-home devices do I have?' surfaces home_entities", () => {
    expect(surfaced("what smart-home devices do I have?")).toContain("home_entities");
  });

  it("a scene / routine prompt surfaces home_action (scene.turn_on / script.turn_on)", () => {
    expect(surfaced("activate the bedtime scene")).toContain("home_action");
    expect(surfaced("run my good night routine")).toContain("home_action");
  });

  it("an unrelated prompt surfaces NONE of the home tools (small exposed set)", () => {
    expect(surfaced("what is 2 + 2?")).toEqual([]);
    expect(surfaced("summarize this article about economics")).toEqual([]);
  });
});
