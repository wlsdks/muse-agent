import { describe, expect, it } from "vitest";

import { OPENAI_COMPAT_PRESETS } from "../src/openai-compat-presets.js";

describe("OPENAI_COMPAT_PRESETS — the shipped OpenAI-compatible backend table", () => {
  it("preserves the credential-fallback PRIORITY order (load-bearing for inferDefaultModelFromCredentials)", () => {
    // A silent reorder would change which provider wins when several keys are
    // present — the historical order locked by the setup-status parity tests.
    expect(Object.keys(OPENAI_COMPAT_PRESETS)).toEqual(["groq", "deepseek", "together", "mistral", "moonshot", "cerebras"]);
  });

  it("every preset is well-formed: https baseUrl, *_API_KEY envKey, and a provider-prefixed defaultModel", () => {
    for (const [id, preset] of Object.entries(OPENAI_COMPAT_PRESETS)) {
      expect(preset.baseUrl, `${id} baseUrl`).toMatch(/^https:\/\//u);
      expect(preset.envKey, `${id} envKey`).toMatch(/^[A-Z][A-Z0-9_]*_API_KEY$/u);
      // the routed model id is namespaced by the provider key so the model
      // router dispatches it to the right adapter (e.g. "groq/llama-3.3-70b…").
      expect(preset.defaultModel.startsWith(`${id}/`), `${id} defaultModel prefix`).toBe(true);
    }
  });

  it("pins a couple of concrete entries so a wrong base URL / env key is caught", () => {
    expect(OPENAI_COMPAT_PRESETS.groq).toMatchObject({ baseUrl: "https://api.groq.com/openai/v1", envKey: "GROQ_API_KEY" });
    expect(OPENAI_COMPAT_PRESETS.deepseek.envKey).toBe("DEEPSEEK_API_KEY");
  });
});
