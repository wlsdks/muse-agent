import { describe, expect, it } from "vitest";

import { CLOUD_PROVIDERS, planCloudSetup } from "./commands-setup-cloud.js";

describe("planCloudSetup — cloud BYO-key onboarding (muse setup cloud)", () => {
  it("unknown provider → undefined", () => {
    expect(planCloudSetup("llama-cloud", {})).toBeUndefined();
  });
  it("cloud allowed by default: only the API key is required when nothing is set", () => {
    const plan = planCloudSetup("gemini", {})!;
    expect(plan.defaultModel).toBe("gemini/gemini-2.0-flash");
    expect(plan.keyPresent).toBe(false);
    expect(plan.localOnlyDisabled).toBe(true);
    expect(plan.requiredExports).toEqual(["export GEMINI_API_KEY=<your-key>"]);
  });
  it("a --model override is namespaced under the provider id", () => {
    expect(planCloudSetup("anthropic", {}, "claude-opus-4-8")!.defaultModel).toBe("anthropic/claude-opus-4-8");
  });
  it("detects a present key (incl. the alias GOOGLE_API_KEY) → ready, no exports", () => {
    const plan = planCloudSetup("gemini", { GOOGLE_API_KEY: "k" })!;
    expect(plan.keyPresent).toBe(true);
    expect(plan.localOnlyDisabled).toBe(true);
    expect(plan.requiredExports).toEqual([]);
  });
  it("key present but local-only explicitly forced on → must unset MUSE_LOCAL_ONLY (the gate would refuse otherwise)", () => {
    const plan = planCloudSetup("openai", { OPENAI_API_KEY: "k", MUSE_LOCAL_ONLY: "true" })!;
    expect(plan.localOnlyDisabled).toBe(false);
    expect(plan.requiredExports).toEqual(["unset MUSE_LOCAL_ONLY"]);
  });
  it("every provider has a key env var and a namespaced default model", () => {
    for (const p of CLOUD_PROVIDERS) {
      expect(p.keyEnvVars.length).toBeGreaterThan(0);
      expect(p.defaultModel.startsWith(`${p.id}/`)).toBe(true);
    }
  });
});
