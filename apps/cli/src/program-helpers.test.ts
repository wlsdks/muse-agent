import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { defaultConfigPath } from "./program-helpers.js";

describe("defaultConfigPath", () => {
  beforeEach(() => {
    vi.stubEnv("HOME", "/u/jinan");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("uses HOME when set, rooting config.json under ~/.config/muse", () => {
    expect(defaultConfigPath()).toBe("/u/jinan/.config/muse/config.json");
  });

  it("honours an explicit non-empty `home` argument over HOME (trimmed)", () => {
    expect(defaultConfigPath("/elsewhere")).toBe("/elsewhere/.config/muse/config.json");
    expect(defaultConfigPath("  /trimmed  ")).toBe("/trimmed/.config/muse/config.json");
  });

  it("treats an empty / whitespace-only explicit `home` argument as unset and falls through to HOME", () => {
    expect(defaultConfigPath("")).toBe("/u/jinan/.config/muse/config.json");
    expect(defaultConfigPath("   ")).toBe("/u/jinan/.config/muse/config.json");
  });

  it("FAILS LOUD when HOME and os.homedir() both resolve to empty — config.json must NOT silently land at /.config/muse/... at the filesystem root", () => {
    vi.stubEnv("HOME", "");
    try {
      const resolved = defaultConfigPath();
      expect(resolved).not.toMatch(/^\/\.config\/muse/u);
      expect(resolved).toMatch(/\/.config\/muse\/config\.json$/u);
    } catch (cause) {
      expect((cause as Error).message).toMatch(/Cannot resolve home directory/u);
    }
  });
});
