import type { AgentSpec } from "@muse/agent-specs";
import { describe, expect, it } from "vitest";

import { parseAgentSpecInput, toAgentSpecResponse, toAgentSpecUpdateInput } from "./compat-agent-spec.js";

// Direct coverage for the agent-spec compat serializers (untested). parseAgentSpecInput
// is the create/update input gate; toAgentSpecResponse exposes a system-prompt
// PREVIEW (≤120 chars) + a hasSystemPrompt flag rather than the full prompt; and
// toAgentSpecUpdateInput merges a partial body over the existing spec.

const spec = (over: Partial<AgentSpec> = {}): AgentSpec =>
  ({
    createdAt: new Date(1_000), description: "d", enabled: true, id: "s1", independentExecution: false,
    keywords: ["k"], mode: "react", name: "Helper", systemPrompt: "short", toolNames: ["t"], updatedAt: new Date(2_000), ...over
  }) as unknown as AgentSpec;

describe("parseAgentSpecInput", () => {
  it("rejects a non-object body and a missing name, but takes the name from the id when absent", () => {
    expect(parseAgentSpecInput(5).ok).toBe(false);
    expect(parseAgentSpecInput({})).toMatchObject({ error: { message: "Body must include a non-empty name" }, ok: false });
    expect(parseAgentSpecInput({}, "spec-1")).toMatchObject({ ok: true, value: { name: "spec-1" } });
  });

  it("rejects an invalid mode but accepts a valid spec, dropping undefined fields", () => {
    expect(parseAgentSpecInput({ mode: "bogus", name: "x" })).toMatchObject({ error: { message: "Invalid mode: bogus" }, ok: false });
    const ok = parseAgentSpecInput({ enabled: true, keywords: ["a", "b"], mode: "plan_execute", name: "helper" });
    expect(ok.ok && ok.value).toEqual({ enabled: true, keywords: ["a", "b"], mode: "plan_execute", name: "helper" });
  });
});

describe("toAgentSpecResponse", () => {
  it("previews a long system prompt to 120 chars + ellipsis and never leaks the full prompt", () => {
    const response = toAgentSpecResponse(spec({ systemPrompt: "x".repeat(150) }));
    expect(response.systemPromptPreview).toHaveLength(121); // 120 + the ellipsis char
    expect((response.systemPromptPreview as string).endsWith("…")).toBe(true);
    expect(response.hasSystemPrompt).toBe(true);
    expect(JSON.stringify(response)).not.toContain("x".repeat(130)); // full prompt not in the response
    expect(response.mode).toBe("REACT"); // via agentModeResponse
  });

  it("returns the full prompt as the preview when short, and null + false when absent", () => {
    expect(toAgentSpecResponse(spec({ systemPrompt: "short" })).systemPromptPreview).toBe("short");
    const none = toAgentSpecResponse(spec({ systemPrompt: undefined }));
    expect(none.systemPromptPreview).toBeNull();
    expect(none.hasSystemPrompt).toBe(false);
  });
});

describe("toAgentSpecUpdateInput", () => {
  it("merges the partial body over the existing spec (unset fields fall back)", () => {
    const merged = toAgentSpecUpdateInput({ description: "new" }, spec());
    expect(merged).toMatchObject({ description: "new", id: "s1", mode: "react", name: "Helper" });
  });

  it("clears the system prompt when the body sends null", () => {
    expect(toAgentSpecUpdateInput({ systemPrompt: null }, spec({ systemPrompt: "keep" })).systemPrompt).toBeNull();
  });
});
