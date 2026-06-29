import { describe, expect, it } from "vitest";

import { CLOUD_PROVIDERS, planCloudSetup } from "./commands-setup-cloud.js";

describe("planCloudSetup — cloud BYO-key onboarding (muse setup cloud)", () => {
  it("unknown provider → undefined", () => {
    expect(planCloudSetup("llama-cloud", {})).toBeUndefined();
  });
  it("resolves the provider default model + flags both env requirements when nothing is set", () => {
    const plan = planCloudSetup("gemini", {})!;
    expect(plan.defaultModel).toBe("gemini/gemini-2.0-flash");
    expect(plan.keyPresent).toBe(false);
    expect(plan.localOnlyDisabled).toBe(false);
    expect(plan.requiredExports).toEqual(["export MUSE_LOCAL_ONLY=false", "export GEMINI_API_KEY=<your-key>"]);
  });
  it("a --model override is namespaced under the provider id", () => {
    expect(planCloudSetup("anthropic", {}, "claude-opus-4-8")!.defaultModel).toBe("anthropic/claude-opus-4-8");
  });
  it("detects a present key (incl. the alias GOOGLE_API_KEY) and an explicit MUSE_LOCAL_ONLY=false → ready, no exports", () => {
    const plan = planCloudSetup("gemini", { GOOGLE_API_KEY: "k", MUSE_LOCAL_ONLY: "false" })!;
    expect(plan.keyPresent).toBe(true);
    expect(plan.localOnlyDisabled).toBe(true);
    expect(plan.requiredExports).toEqual([]);
  });
  it("key present but local-only still on → only the MUSE_LOCAL_ONLY export is required (the gate would refuse otherwise)", () => {
    const plan = planCloudSetup("openai", { OPENAI_API_KEY: "k" })!;
    expect(plan.requiredExports).toEqual(["export MUSE_LOCAL_ONLY=false"]);
  });
  it("every provider has a key env var and a namespaced default model", () => {
    for (const p of CLOUD_PROVIDERS) {
      expect(p.keyEnvVars.length).toBeGreaterThan(0);
      expect(p.defaultModel.startsWith(`${p.id}/`)).toBe(true);
    }
  });
});
