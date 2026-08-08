import { describe, expect, it } from "vitest";
import type { RuntimeSetting } from "@muse/runtime-settings";

import { resolveConsolidateIdleEnabled } from "./consolidate-idle-flag.js";

function runtimeSetting(value: string, type: "boolean" | "string" = "boolean"): RuntimeSetting {
  return { category: "daemon", key: "MUSE_SKILL_CONSOLIDATE_IDLE_ENABLED", type, updatedAt: new Date(), value };
}

describe("resolveConsolidateIdleEnabled", () => {
  it("uses a valid runtime boolean before the environment", () => {
    expect(resolveConsolidateIdleEnabled(
      { MUSE_SKILL_CONSOLIDATE_IDLE_ENABLED: "true" },
      runtimeSetting("false")
    )).toBe(false);
    expect(resolveConsolidateIdleEnabled(
      { MUSE_SKILL_CONSOLIDATE_IDLE_ENABLED: "false" },
      runtimeSetting("true")
    )).toBe(true);
  });

  it("uses the valid environment value before the explicit default", () => {
    expect(resolveConsolidateIdleEnabled({ MUSE_SKILL_CONSOLIDATE_IDLE_ENABLED: "true" }, undefined)).toBe(true);
    expect(resolveConsolidateIdleEnabled({ MUSE_SKILL_CONSOLIDATE_IDLE_ENABLED: "false" }, undefined, true)).toBe(false);
  });

  it("falls back safely for absent, malformed, and wrongly typed runtime settings", () => {
    expect(resolveConsolidateIdleEnabled({}, undefined)).toBe(false);
    expect(resolveConsolidateIdleEnabled({}, runtimeSetting("maybe"))).toBe(false);
    expect(resolveConsolidateIdleEnabled({}, runtimeSetting("true", "string"))).toBe(false);
    expect(resolveConsolidateIdleEnabled({ MUSE_SKILL_CONSOLIDATE_IDLE_ENABLED: "true" }, runtimeSetting("maybe"))).toBe(true);
  });
});
