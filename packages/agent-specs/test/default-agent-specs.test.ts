import { describe, expect, it } from "vitest";

import { DEFAULT_AGENT_SPECS, InMemoryAgentSpecRegistry, scoreAgentSpec } from "../src/index.js";

describe("DEFAULT_AGENT_SPECS", () => {
  it("provides two distinct, enabled, keyword-free workers with system prompts", () => {
    expect(DEFAULT_AGENT_SPECS).toHaveLength(2);
    expect(new Set(DEFAULT_AGENT_SPECS.map((s) => s.id)).size).toBe(2);
    expect(new Set(DEFAULT_AGENT_SPECS.map((s) => s.name)).size).toBe(2);
    for (const spec of DEFAULT_AGENT_SPECS) {
      expect(spec.enabled).toBe(true);
      expect(spec.keywords ?? []).toEqual([]);
      expect((spec.systemPrompt ?? "").length).toBeGreaterThan(0);
    }
  });

  it("orders Generalist before Critic by createdAt so the sequential pipeline answers then refines", () => {
    const generalist = DEFAULT_AGENT_SPECS.find((s) => s.id === "default-generalist");
    const critic = DEFAULT_AGENT_SPECS.find((s) => s.id === "default-critic");
    expect(generalist?.createdAt).toBeInstanceOf(Date);
    expect(critic?.createdAt).toBeInstanceOf(Date);
    expect(generalist!.createdAt!.getTime()).toBeLessThan(critic!.createdAt!.getTime());
  });

  it("the Critic adds risks/gaps as a DISTINCT perspective, not a rewrite of the draft (G5 redesign)", () => {
    const prompt = DEFAULT_AGENT_SPECS.find((s) => s.id === "default-critic")?.systemPrompt ?? "";
    expect(prompt).toMatch(/risk|edge case|gap|caveat/i);
    expect(prompt).toMatch(/not\s+repeat|do not repeat/i);
    expect(prompt).not.toMatch(/sharper version|corrected/i); // the old echo-prone framing is gone
  });

  it("seeds an InMemoryAgentSpecRegistry so orchestration has enabled workers", async () => {
    const registry = new InMemoryAgentSpecRegistry(DEFAULT_AGENT_SPECS);
    expect((await registry.listEnabled()).length).toBe(2);
  });

  it("never matches single-agent routing: empty keywords ⇒ scoreAgentSpec is undefined", async () => {
    const registry = new InMemoryAgentSpecRegistry(DEFAULT_AGENT_SPECS);
    for (const spec of await registry.list()) {
      expect(scoreAgentSpec(spec, "please help answer and then review and improve this")).toBeUndefined();
    }
  });
});
