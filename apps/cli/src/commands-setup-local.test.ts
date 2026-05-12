import { describe, expect, it } from "vitest";

import { LOCAL_MODEL_PRESETS, pickPreset } from "./commands-setup-local.js";

describe("pickPreset", () => {
  it("returns highest-tier preset when nothing pulled (so caller can render pull hint)", () => {
    const chosen = pickPreset(new Set());
    expect(chosen?.tag).toBe("qwen2.5:7b-instruct");
    expect(chosen?.tier).toBe("high");
  });

  it("prefers highest-tier preset already installed", () => {
    const installed = new Set(["qwen2.5:1.5b-instruct", "qwen2.5:3b"]);
    expect(pickPreset(installed)?.tag).toBe("qwen2.5:3b");
  });

  it("returns 7b when 7b installed alongside smaller", () => {
    const installed = new Set([
      "qwen2.5:1.5b-instruct",
      "qwen2.5:3b",
      "qwen2.5:7b-instruct"
    ]);
    expect(pickPreset(installed)?.tag).toBe("qwen2.5:7b-instruct");
  });

  it("honours explicit override even when not in presets", () => {
    const chosen = pickPreset(new Set(), "llama3.2");
    expect(chosen?.tag).toBe("llama3.2");
    expect(chosen?.tier).toBe("mid");
    expect(chosen?.note).toMatch(/user-specified/);
  });

  it("strips the ollama/ prefix from override", () => {
    expect(pickPreset(new Set(), "ollama/qwen2.5:7b-instruct")?.tag).toBe("qwen2.5:7b-instruct");
  });

  it("matches an override against the preset table when possible", () => {
    const chosen = pickPreset(new Set(), "qwen2.5:1.5b-instruct");
    expect(chosen?.tier).toBe("low");
    expect(chosen?.approxSizeGb).toBe(1.0);
  });
});

describe("LOCAL_MODEL_PRESETS", () => {
  it("is ordered low → mid → high so the highest-tier picker walks it last", () => {
    expect(LOCAL_MODEL_PRESETS.map((preset) => preset.tier)).toEqual(["low", "mid", "high"]);
  });

  it("has strictly increasing RAM requirements", () => {
    for (let i = 1; i < LOCAL_MODEL_PRESETS.length; i += 1) {
      expect(LOCAL_MODEL_PRESETS[i]!.minRamGb).toBeGreaterThan(LOCAL_MODEL_PRESETS[i - 1]!.minRamGb);
    }
  });
});
