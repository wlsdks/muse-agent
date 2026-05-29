import { describe, expect, it } from "vitest";

import { decideWebSearchPolicy, type DecideWebSearchPolicyArgs } from "../src/web-search-policy.js";

const decide = (args: Partial<DecideWebSearchPolicyArgs>) =>
  decideWebSearchPolicy({ model: { modelId: "claude", provider: "anthropic" }, settings: {}, ...args });

describe("decideWebSearchPolicy — enabled resolution", () => {
  it("defaults to enabled when nothing is configured", () => {
    expect(decide({})).toEqual({ enabled: true, maxUses: 5 });
  });

  it("disables only on an explicit settings.enabled === false (truthy/absent stay enabled)", () => {
    expect(decide({ settings: { webSearch: { enabled: false } } }).enabled).toBe(false);
    expect(decide({ settings: { webSearch: { enabled: true } } }).enabled).toBe(true);
    expect(decide({ settings: { webSearch: {} } }).enabled).toBe(true);
  });

  it("honours a per-call override in both directions", () => {
    expect(decide({ override: true }).enabled).toBe(true);
    expect(decide({ override: false }).enabled).toBe(false);
  });

  it("lets override=true re-enable even when settings.enabled is false", () => {
    expect(decide({ override: true, settings: { webSearch: { enabled: false } } }).enabled).toBe(true);
  });

  describe("MUSE_WEB_SEARCH env kill switch (operator-set, beats a per-call override)", () => {
    it.each(["false", "0", "no", "off", "FALSE", "  Off  "])("a falsy spelling %j forces disabled despite override=true", (raw) => {
      expect(decide({ override: true, env: { MUSE_WEB_SEARCH: raw } }).enabled).toBe(false);
    });

    it("a truthy env value is NOT a force-enable — override=false still disables", () => {
      expect(decide({ override: false, env: { MUSE_WEB_SEARCH: "true" } }).enabled).toBe(false);
    });

    it("an unrecognised env value is tri-state undefined and falls through to the default", () => {
      expect(decide({ env: { MUSE_WEB_SEARCH: "garbage" } }).enabled).toBe(true);
    });
  });
});

describe("decideWebSearchPolicy — maxUses resolution (default 5)", () => {
  it("uses the default when nothing sets it", () => {
    expect(decide({}).maxUses).toBe(5);
  });

  describe("from MUSE_WEB_SEARCH_MAX_USES (strict whole positive integer)", () => {
    it("accepts a plain positive integer, trimming surrounding space", () => {
      expect(decide({ env: { MUSE_WEB_SEARCH_MAX_USES: "7" } }).maxUses).toBe(7);
      expect(decide({ env: { MUSE_WEB_SEARCH_MAX_USES: "  9  " } }).maxUses).toBe(9);
    });

    it.each(["3x", "30s", "-5", "0", "3.5", "", " "])("rejects the non-strict value %j and falls back", (raw) => {
      expect(decide({ env: { MUSE_WEB_SEARCH_MAX_USES: raw } }).maxUses).toBe(5);
    });
  });

  describe("from settings.maxUses (same strictness as the env path)", () => {
    it("accepts a positive integer", () => {
      expect(decide({ settings: { webSearch: { maxUses: 10 } } }).maxUses).toBe(10);
    });

    it.each([
      ["Infinity", Infinity],
      ["fractional", 3.5],
      ["zero", 0],
      ["negative", -2]
    ])("rejects %s and falls back to the default", (_label, value) => {
      expect(decide({ settings: { webSearch: { maxUses: value } } }).maxUses).toBe(5);
    });
  });

  describe("precedence between env and settings", () => {
    it("a valid env value overrides settings", () => {
      expect(decide({ env: { MUSE_WEB_SEARCH_MAX_USES: "8" }, settings: { webSearch: { maxUses: 99 } } }).maxUses).toBe(8);
    });

    it("an invalid env value falls back to a valid settings value", () => {
      expect(decide({ env: { MUSE_WEB_SEARCH_MAX_USES: "bad" }, settings: { webSearch: { maxUses: 12 } } }).maxUses).toBe(12);
    });

    it("a disabled policy still carries the resolved maxUses", () => {
      expect(decide({ override: false, env: { MUSE_WEB_SEARCH_MAX_USES: "4" } })).toEqual({ enabled: false, maxUses: 4 });
    });
  });
});
