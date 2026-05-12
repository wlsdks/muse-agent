import { describe, expect, it } from "vitest";

import { LOCAL_MODEL_PRESETS, pickPreset } from "./commands-setup-local.js";

describe("pickPreset", () => {
  it("returns highest-tier preset when nothing pulled (so caller can render pull hint)", () => {
    const chosen = pickPreset(new Set());
    // Power tier is the head when present; the picker walks reversed
    // and stops at the first installed, but with nothing installed the
    // very-first reversed entry surfaces as the recommendation.
    expect(chosen?.tier).toBe("power");
    expect(chosen?.tag).toBe("qwen3.6:27b");
  });

  it("prefers highest-tier preset already installed", () => {
    const installed = new Set(["qwen2.5:1.5b-instruct", "qwen3.5:2b-q4_K_M"]);
    expect(pickPreset(installed)?.tag).toBe("qwen3.5:2b-q4_K_M");
  });

  it("returns 9b when 9b installed alongside smaller", () => {
    const installed = new Set([
      "qwen2.5:1.5b-instruct",
      "qwen3.5:2b-q4_K_M",
      "qwen3.5:9b-q4_K_M"
    ]);
    expect(pickPreset(installed)?.tag).toBe("qwen3.5:9b-q4_K_M");
  });

  it("returns power tier when 27b installed", () => {
    const installed = new Set(["qwen3.5:2b-q4_K_M", "qwen3.6:27b"]);
    expect(pickPreset(installed)?.tag).toBe("qwen3.6:27b");
    expect(pickPreset(installed)?.tier).toBe("power");
  });

  it("honours explicit override even when not in presets", () => {
    const chosen = pickPreset(new Set(), "llama3.2");
    expect(chosen?.tag).toBe("llama3.2");
    expect(chosen?.tier).toBe("mid");
    expect(chosen?.note).toMatch(/user-specified/);
  });

  it("strips the ollama/ prefix from override", () => {
    expect(pickPreset(new Set(), "ollama/qwen3.5:9b-q4_K_M")?.tag).toBe("qwen3.5:9b-q4_K_M");
  });

  it("matches an override against the preset table when possible", () => {
    const chosen = pickPreset(new Set(), "qwen2.5:1.5b-instruct");
    expect(chosen?.tier).toBe("low");
    expect(chosen?.approxSizeGb).toBe(1.0);
  });
});

describe("LOCAL_MODEL_PRESETS", () => {
  it("is ordered low → mid → high → power so the highest-tier picker walks it last", () => {
    expect(LOCAL_MODEL_PRESETS.map((preset) => preset.tier)).toEqual(["low", "mid", "high", "power"]);
  });

  it("has strictly increasing RAM requirements", () => {
    for (let i = 1; i < LOCAL_MODEL_PRESETS.length; i += 1) {
      expect(LOCAL_MODEL_PRESETS[i]!.minRamGb).toBeGreaterThan(LOCAL_MODEL_PRESETS[i - 1]!.minRamGb);
    }
  });
});
