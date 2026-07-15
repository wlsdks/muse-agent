import { describe, expect, it } from "vitest";

import { evaluateFeatures, FEATURE_REGISTRY } from "./feature-registry.js";

const TIER_1_ENV_VARS = [
  "MUSE_CHAT_WRITE_ENABLED",
  "MUSE_EPISODIC_MEMORY_ENABLED",
  "MUSE_KNOWLEDGE_SEARCH_ENABLED",
  "MUSE_AMBIENT_ENABLED",
  "MUSE_AMBIENT_CLIPBOARD",
  "MUSE_APPLE_NOTES_MIRROR",
  "MUSE_APPLE_REMINDERS_MIRROR",
  "MUSE_GITHUB_MCP_ENABLED",
  "MUSE_NOTION_MCP_ENABLED",
  "MUSE_CHROME_DEVTOOLS_ENABLED",
  "MUSE_MACOS_ACTUATORS"
] as const;

describe("FEATURE_REGISTRY — tier-1 coverage drift pin", () => {
  it("every tier-1 env var is registered (deleting/renaming any of them fails this test naming the gap)", () => {
    const registeredEnvVars = new Set(FEATURE_REGISTRY.map((entry) => entry.envVar));
    for (const envVar of TIER_1_ENV_VARS) {
      expect(registeredEnvVars.has(envVar), `missing tier-1 feature entry for ${envVar}`).toBe(true);
    }
  });
});

describe("FEATURE_REGISTRY — invariants", () => {
  it("ids are unique", () => {
    const ids = FEATURE_REGISTRY.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("env vars are unique and match /^MUSE_[A-Z0-9_]+$/", () => {
    const envVars = FEATURE_REGISTRY.map((entry) => entry.envVar);
    expect(new Set(envVars).size).toBe(envVars.length);
    for (const envVar of envVars) {
      expect(envVar).toMatch(/^MUSE_[A-Z0-9_]+$/);
    }
  });

  it("every enableHint contains its own envVar", () => {
    for (const entry of FEATURE_REGISTRY) {
      expect(entry.enableHint).toContain(entry.envVar);
    }
  });

  it("every entry has a non-empty title and unlocks", () => {
    for (const entry of FEATURE_REGISTRY) {
      expect(entry.title.trim().length).toBeGreaterThan(0);
      expect(entry.unlocks.trim().length).toBeGreaterThan(0);
    }
  });
});

describe("evaluateFeatures", () => {
  it("with an empty env every tier-1 feature reports enabled=false", () => {
    const statuses = evaluateFeatures({});
    for (const envVar of TIER_1_ENV_VARS) {
      const status = statuses.find((s) => s.entry.envVar === envVar);
      expect(status, `no status for ${envVar}`).toBeDefined();
      expect(status!.enabled).toBe(false);
    }
  });

  it.each(["true", "1", "yes", "on"])("MUSE_CHAT_WRITE_ENABLED=%s reports enabled=true", (value) => {
    const statuses = evaluateFeatures({ MUSE_CHAT_WRITE_ENABLED: value });
    const status = statuses.find((s) => s.entry.envVar === "MUSE_CHAT_WRITE_ENABLED")!;
    expect(status.enabled).toBe(true);
  });

  it.each(["false", "0", "no", "off"])("MUSE_CHAT_WRITE_ENABLED=%s reports enabled=false", (value) => {
    const statuses = evaluateFeatures({ MUSE_CHAT_WRITE_ENABLED: value });
    const status = statuses.find((s) => s.entry.envVar === "MUSE_CHAT_WRITE_ENABLED")!;
    expect(status.enabled).toBe(false);
  });

  it("an absent flag reports enabled=false", () => {
    const statuses = evaluateFeatures({ SOME_OTHER_VAR: "true" });
    const status = statuses.find((s) => s.entry.envVar === "MUSE_MACOS_ACTUATORS")!;
    expect(status.enabled).toBe(false);
  });

  it("returns one status per registry entry, preserving order", () => {
    const statuses = evaluateFeatures({});
    expect(statuses.map((s) => s.entry.id)).toEqual(FEATURE_REGISTRY.map((entry) => entry.id));
  });
});
