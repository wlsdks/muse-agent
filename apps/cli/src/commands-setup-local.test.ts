import { describe, expect, it } from "vitest";

import { LOCAL_MODEL_PRESETS, checkPresetRam, isEmbedModelPulled, pickPreset } from "./commands-setup-local.js";

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
    const installed = new Set(["qwen3.5:2b-q4_K_M", "qwen2.5:7b-instruct"]);
    expect(pickPreset(installed)?.tag).toBe("qwen2.5:7b-instruct");
  });

  it("returns 9b when 9b installed alongside smaller", () => {
    const installed = new Set([
      "qwen3.5:2b-q4_K_M",
      "qwen2.5:7b-instruct",
      "qwen3.5:9b-q4_K_M"
    ]);
    expect(pickPreset(installed)?.tag).toBe("qwen3.5:9b-q4_K_M");
  });

  it("returns power tier when 27b installed", () => {
    const installed = new Set(["qwen2.5:7b-instruct", "qwen3.6:27b"]);
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
    expect(pickPreset(new Set(), "ollama/qwen2.5:7b-instruct")?.tag).toBe("qwen2.5:7b-instruct");
  });

  it("matches an override against the preset table when possible", () => {
    const chosen = pickPreset(new Set(), "qwen3.5:2b-q4_K_M");
    expect(chosen?.tier).toBe("low");
    expect(chosen?.approxSizeGb).toBe(1.9);
  });
});

describe("checkPresetRam", () => {
  const power = LOCAL_MODEL_PRESETS.find((p) => p.tier === "power")!;  // 32 GB
  const high = LOCAL_MODEL_PRESETS.find((p) => p.tier === "high")!;    // 12 GB
  const low = LOCAL_MODEL_PRESETS.find((p) => p.tier === "low")!;      // 6 GB

  it("returns undefined when machine RAM clears the bar", () => {
    expect(checkPresetRam(36, power)).toBeUndefined();
    expect(checkPresetRam(32, power)).toBeUndefined();   // exact match passes
    expect(checkPresetRam(16, high)).toBeUndefined();
  });

  it("warns when machine RAM is below the preset minimum", () => {
    const warning = checkPresetRam(8, power);
    expect(warning?.severity).toBe("warn");
    expect(warning?.message).toContain("8.0 GB RAM");
    expect(warning?.message).toContain(power.tag);
    expect(warning?.message).toContain("≥ 32 GB");
  });

  it("references the small-tier fallback in the message so the user has a one-liner fix", () => {
    const warning = checkPresetRam(4, high);
    expect(warning?.message).toMatch(/muse setup local --model qwen3\.5:2b-q4_K_M/);
  });

  it("skips the check for custom presets with minRamGb=0", () => {
    expect(checkPresetRam(2, { ...low, tag: "custom-tag", minRamGb: 0 })).toBeUndefined();
  });

  it("skips the check on a non-finite or non-positive machine reading", () => {
    expect(checkPresetRam(NaN, high)).toBeUndefined();
    expect(checkPresetRam(0, high)).toBeUndefined();
    expect(checkPresetRam(-1, high)).toBeUndefined();
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

describe("isEmbedModelPulled", () => {
  it("is false when no embedding model is pulled (chat-only setup)", () => {
    expect(isEmbedModelPulled(new Set(["qwen3:8b", "qwen3.6:35b-a3b"]))).toBe(false);
    expect(isEmbedModelPulled(new Set())).toBe(false);
  });

  it("is true for the bare name or the implicit :latest tag", () => {
    expect(isEmbedModelPulled(new Set(["qwen3:8b", "nomic-embed-text-v2-moe"]))).toBe(true);
    expect(isEmbedModelPulled(new Set(["nomic-embed-text-v2-moe:latest"]))).toBe(true);
  });

  it("does not match a different embedding model (the setup hint only knows the default)", () => {
    expect(isEmbedModelPulled(new Set(["mxbai-embed-large", "nomic-embed-text"]))).toBe(false);
  });
});
