import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { defaultConfigPath, firstNonEmpty, readResponseGrounded, readResponseSuccess, setConfigValue, unsetConfigValue } from "./program-helpers.js";

describe("readResponseSuccess / readResponseGrounded (trace outcome labels)", () => {
  it("lifts a boolean success and a present grounded (object or explicit null)", () => {
    expect(readResponseSuccess({ success: true })).toBe(true);
    expect(readResponseSuccess({ success: false })).toBe(false);
    expect(readResponseGrounded({ grounded: { verdict: "grounded" } })).toEqual({ verdict: "grounded" });
    expect(readResponseGrounded({ grounded: null })).toBeNull(); // explicit null is a real label, kept distinct from absent
  });

  it("returns undefined when the field is absent or the wrong type (cli.local today)", () => {
    expect(readResponseSuccess({ runId: "x" })).toBeUndefined();
    expect(readResponseSuccess({ success: "yes" })).toBeUndefined();
    expect(readResponseGrounded({ runId: "x" })).toBeUndefined();
    expect(readResponseSuccess(undefined)).toBeUndefined();
  });
});

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

describe("firstNonEmpty (readApiOptions / token precedence-chain helper)", () => {
  it("returns the first non-empty trimmed candidate", () => {
    expect(firstNonEmpty("a", "b")).toBe("a");
    expect(firstNonEmpty(undefined, "b")).toBe("b");
    expect(firstNonEmpty(undefined, undefined, "c")).toBe("c");
  });

  it("skips empty / whitespace-only / non-string candidates", () => {
    expect(firstNonEmpty("", "real")).toBe("real");
    expect(firstNonEmpty("   ", "real")).toBe("real");
    expect(firstNonEmpty("", "   ", "real")).toBe("real");
    expect(firstNonEmpty(undefined, "", "real")).toBe("real");
  });

  it("trims a non-empty candidate before returning it (a padded `--api-url` still works)", () => {
    expect(firstNonEmpty("  http://localhost:3030  ")).toBe("http://localhost:3030");
  });

  it("returns undefined when every candidate is empty / whitespace / undefined", () => {
    expect(firstNonEmpty()).toBeUndefined();
    expect(firstNonEmpty("", "   ", undefined)).toBeUndefined();
  });
});

describe("setConfigValue", () => {
  it("accepts the two supported keys + trims the value", () => {
    expect(setConfigValue({}, "apiUrl", "  http://localhost:3030  ")).toMatchObject({ apiUrl: "http://localhost:3030" });
    expect(setConfigValue({}, "defaultModel", "  qwen3:8b  ")).toMatchObject({ defaultModel: "qwen3:8b" });
  });

  it("rejects an empty / whitespace-only value", () => {
    expect(() => setConfigValue({}, "apiUrl", "   ")).toThrow(/Config value must not be empty/u);
  });

  it("rejects an unknown key with a `did you mean` hint for a near-miss typo", () => {
    expect(() => setConfigValue({}, "apirurl", "x")).toThrow(/Unsupported config key 'apirurl'.*expected one of: apiUrl, defaultModel.*did you mean 'apiUrl'/u);
    expect(() => setConfigValue({}, "deafultModel", "x")).toThrow(/did you mean 'defaultModel'/u);
  });

  it("rejects an unknown key WITHOUT a guess when nothing is close (no random suggestion)", () => {
    expect(() => setConfigValue({}, "totallydifferent", "x")).toThrow(/Unsupported config key 'totallydifferent'.*expected one of: apiUrl, defaultModel\)$/u);
  });
});

describe("unsetConfigValue — set's missing inverse (revert a key to the built-in default)", () => {
  it("clears a set key and reports wasSet=true, leaving the other key intact", () => {
    const r = unsetConfigValue({ apiUrl: "http://remote:3030", defaultModel: "qwen3:8b" }, "apiUrl");
    expect(r.wasSet).toBe(true);
    expect(r.config).toEqual({ defaultModel: "qwen3:8b" });
    expect("apiUrl" in r.config).toBe(false);
  });

  it("is a no-op (wasSet=false) when the key was never set — so the caller can say 'was not set'", () => {
    const r = unsetConfigValue({ defaultModel: "qwen3:8b" }, "apiUrl");
    expect(r.wasSet).toBe(false);
    expect(r.config).toEqual({ defaultModel: "qwen3:8b" });
  });

  it("rejects an unknown key with the same `did you mean` hint as set", () => {
    expect(() => unsetConfigValue({}, "apirurl")).toThrow(/Unsupported config key 'apirurl'.*did you mean 'apiUrl'/u);
  });
});
