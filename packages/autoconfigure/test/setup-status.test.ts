import { describe, expect, it } from "vitest";

import { readModelKeyState, readWebSearchEnvSnapshot } from "../src/setup-status.js";

const MISSING_KEYS_FILE = "/dev/null/no-such-keys.json";

describe("readWebSearchEnvSnapshot", () => {
  it("returns enabled=true, maxUses=5, source=default when no env vars set", () => {
    expect(readWebSearchEnvSnapshot({})).toEqual({
      enabled: true,
      maxUses: 5,
      source: "default"
    });
  });

  it("MUSE_WEB_SEARCH=off flips enabled to false with source=env", () => {
    expect(readWebSearchEnvSnapshot({ MUSE_WEB_SEARCH: "off" })).toEqual({
      enabled: false,
      maxUses: 5,
      source: "env"
    });
  });

  it("MUSE_WEB_SEARCH=on is the explicit-enable form with source=env", () => {
    expect(readWebSearchEnvSnapshot({ MUSE_WEB_SEARCH: "on" })).toEqual({
      enabled: true,
      maxUses: 5,
      source: "env"
    });
  });

  it("MUSE_WEB_SEARCH_MAX_USES overrides default maxUses when positive", () => {
    expect(readWebSearchEnvSnapshot({ MUSE_WEB_SEARCH_MAX_USES: "12" })).toEqual({
      enabled: true,
      maxUses: 12,
      source: "env"
    });
  });

  it("non-positive MUSE_WEB_SEARCH_MAX_USES falls back to default 5", () => {
    expect(readWebSearchEnvSnapshot({ MUSE_WEB_SEARCH_MAX_USES: "abc" })).toEqual({
      enabled: true,
      maxUses: 5,
      source: "default"
    });
  });

  it("OFF flag is case-insensitive (OFF / Off / off all disable)", () => {
    for (const value of ["OFF", "Off", "off"]) {
      expect(readWebSearchEnvSnapshot({ MUSE_WEB_SEARCH: value }).enabled).toBe(false);
    }
  });
});

describe("readModelKeyState — provider key probing", () => {
  it("detects GROQ_API_KEY", async () => {
    const lines = await readModelKeyState(MISSING_KEYS_FILE, { GROQ_API_KEY: "grq" });
    expect(lines).toContain("groq (env)");
  });

  it("detects DEEPSEEK_API_KEY", async () => {
    const lines = await readModelKeyState(MISSING_KEYS_FILE, { DEEPSEEK_API_KEY: "ds" });
    expect(lines).toContain("deepseek (env)");
  });

  it("detects TOGETHER_API_KEY", async () => {
    const lines = await readModelKeyState(MISSING_KEYS_FILE, { TOGETHER_API_KEY: "tg" });
    expect(lines).toContain("together (env)");
  });

  it("detects MISTRAL_API_KEY", async () => {
    const lines = await readModelKeyState(MISSING_KEYS_FILE, { MISTRAL_API_KEY: "ms" });
    expect(lines).toContain("mistral (env)");
  });

  it("detects MOONSHOT_API_KEY", async () => {
    const lines = await readModelKeyState(MISSING_KEYS_FILE, { MOONSHOT_API_KEY: "mn" });
    expect(lines).toContain("moonshot (env)");
  });

  it("keeps the legacy providers (openai/anthropic/gemini/openrouter/ollama)", async () => {
    const lines = await readModelKeyState(MISSING_KEYS_FILE, {
      OPENAI_API_KEY: "o",
      ANTHROPIC_API_KEY: "a",
      GEMINI_API_KEY: "g",
      OPENROUTER_API_KEY: "or",
      OLLAMA_BASE_URL: "http://localhost:11434"
    });
    expect(lines).toEqual([
      "openai (env)",
      "anthropic (env)",
      "gemini (env)",
      "openrouter (env)",
      "ollama (env)"
    ]);
  });
});
