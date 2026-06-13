import { describe, expect, it } from "vitest";

import { decideWebSearchPolicy } from "./web-search-policy.js";

describe("decideWebSearchPolicy", () => {
  const baseModel = { provider: "openai", modelId: "gpt-4o" };

  it("defaults to enabled when nothing set", () => {
    const r = decideWebSearchPolicy({ model: baseModel, settings: {}, env: {} });
    expect(r.enabled).toBe(true);
  });

  it("env MUSE_WEB_SEARCH=off forces disabled even with override true", () => {
    const r = decideWebSearchPolicy({
      model: baseModel,
      settings: { webSearch: { enabled: true } },
      override: true,
      env: { MUSE_WEB_SEARCH: "off" }
    });
    expect(r.enabled).toBe(false);
  });

  it("explicit override=true wins over settings.enabled=false", () => {
    const r = decideWebSearchPolicy({
      model: baseModel,
      settings: { webSearch: { enabled: false } },
      override: true,
      env: {}
    });
    expect(r.enabled).toBe(true);
  });

  it("override=false disables even with settings.enabled=true", () => {
    const r = decideWebSearchPolicy({
      model: baseModel,
      settings: { webSearch: { enabled: true } },
      override: false,
      env: {}
    });
    expect(r.enabled).toBe(false);
  });

  it("settings.enabled=false disables when no override", () => {
    const r = decideWebSearchPolicy({
      model: baseModel,
      settings: { webSearch: { enabled: false } },
      env: {}
    });
    expect(r.enabled).toBe(false);
  });

  it("maxUses precedence: env > settings, defaults to 5", () => {
    expect(
      decideWebSearchPolicy({ model: baseModel, settings: {}, env: {} }).maxUses
    ).toBe(5);
    expect(
      decideWebSearchPolicy({
        model: baseModel,
        settings: { webSearch: { maxUses: 3 } },
        env: {}
      }).maxUses
    ).toBe(3);
    expect(
      decideWebSearchPolicy({
        model: baseModel,
        settings: { webSearch: { maxUses: 3 } },
        env: { MUSE_WEB_SEARCH_MAX_USES: "9" }
      }).maxUses
    ).toBe(9);
  });

  it("a settings.maxUses that is non-finite / non-integer falls through to the default — the env path rejects these via strictPositiveInt, the settings path must match", () => {
    for (const bad of [Number.POSITIVE_INFINITY, Number.NaN, 3.5, 0, -1]) {
      expect(
        decideWebSearchPolicy({
          model: baseModel,
          settings: { webSearch: { maxUses: bad } },
          env: {}
        }).maxUses,
        `settings.maxUses=${String(bad)} must not be accepted as a search budget`
      ).toBe(5);
    }
    // A legitimate positive integer is still honoured.
    expect(
      decideWebSearchPolicy({ model: baseModel, settings: { webSearch: { maxUses: 7 } }, env: {} }).maxUses
    ).toBe(7);
  });

  it("MUSE_WEB_SEARCH_MAX_USES that is not a positive integer falls through", () => {
    expect(
      decideWebSearchPolicy({
        model: baseModel,
        settings: {},
        env: { MUSE_WEB_SEARCH_MAX_USES: "abc" }
      }).maxUses
    ).toBe(5);
  });

  it("a lenient-prefix MAX_USES typo falls through instead of being silently accepted (goal-463 runtime sibling)", () => {
    for (const bad of ["3x", "30s", "1e3", "5.9", "12abc", "1_000", "-3", "0", " "]) {
      expect(
        decideWebSearchPolicy({
          model: baseModel,
          settings: { webSearch: { maxUses: 9 } },
          env: { MUSE_WEB_SEARCH_MAX_USES: bad }
        }).maxUses,
        `"${bad}" must not be accepted as an env budget`
      ).toBe(9);
    }
    expect(
      decideWebSearchPolicy({
        model: baseModel,
        settings: { webSearch: { maxUses: 9 } },
        env: { MUSE_WEB_SEARCH_MAX_USES: "7" }
      }).maxUses
    ).toBe(7);
  });

  it("a disabled policy still carries the resolved maxUses (disabling does not zero the budget)", () => {
    expect(
      decideWebSearchPolicy({
        model: baseModel,
        settings: {},
        override: false,
        env: { MUSE_WEB_SEARCH_MAX_USES: "4" }
      })
    ).toEqual({ enabled: false, maxUses: 4 });
  });

  it("env MUSE_WEB_SEARCH=on is no-op when nothing else disables", () => {
    const r = decideWebSearchPolicy({
      model: baseModel,
      settings: {},
      env: { MUSE_WEB_SEARCH: "on" }
    });
    expect(r.enabled).toBe(true);
  });

  it("every standard falsy spelling on MUSE_WEB_SEARCH is a hard kill switch (overrides override=true)", () => {
    for (const value of ["false", "False", "FALSE", "0", "no", "NO", "off", "Off"]) {
      const r = decideWebSearchPolicy({
        model: baseModel,
        settings: { webSearch: { enabled: true } },
        override: true,
        env: { MUSE_WEB_SEARCH: value }
      });
      expect(r.enabled, `MUSE_WEB_SEARCH="${value}" must disable`).toBe(false);
    }
  });

  it("truthy MUSE_WEB_SEARCH spellings (true / 1 / yes / on) are NOT a force-enable — override=false still wins", () => {
    for (const value of ["true", "1", "yes", "on", "YES", "On"]) {
      const r = decideWebSearchPolicy({
        model: baseModel,
        settings: { webSearch: { enabled: true } },
        override: false,
        env: { MUSE_WEB_SEARCH: value }
      });
      expect(r.enabled, `MUSE_WEB_SEARCH="${value}" must not override an explicit override:false`).toBe(false);
    }
  });

  it("an unrecognised MUSE_WEB_SEARCH typo is not a kill switch (does not silently disable)", () => {
    for (const value of ["enabled", "disabled", "y", "n", "xyz", "truue", "  "]) {
      const r = decideWebSearchPolicy({
        model: baseModel,
        settings: { webSearch: { enabled: true } },
        env: { MUSE_WEB_SEARCH: value }
      });
      expect(r.enabled, `MUSE_WEB_SEARCH="${value}" must not flip the policy`).toBe(true);
    }
  });

  // Property fuzz (backlog P5 config-fuzz) over the full combinatorial space of
  // settings × override × env spellings × adversarial maxUses. The example tests
  // pin specific cases; these assert the output-shape invariants ALWAYS hold and
  // the operator kill-switch is absolute, so a malformed budget can't leak an
  // unbounded/NaN search allowance and an env-off can't be overridden.
  describe("property fuzz", () => {
    const enabledOpts = [undefined, true, false];
    const overrideOpts = [undefined, true, false] as const;
    const maxUsesOpts: unknown[] = [undefined, 1, 5, 3.5, 0, -5, Number.NaN, Infinity, -Infinity, "10", null, {}];
    const envWebSearch = [undefined, "true", "false", "on", "off", "1", "0", "garbage", "  ", "TRUE", " Off "];
    const envMaxUses = [undefined, "10", "0", "-3", "3.5", "30s", "Infinity", "999999999999999999999", "x"];

    it("never throws and always returns { enabled: boolean, maxUses: positive integer } across the corpus", () => {
      for (const en of enabledOpts) {
        for (const ov of overrideOpts) {
          for (const mu of maxUsesOpts) {
            for (const ews of envWebSearch) {
              for (const emu of envMaxUses) {
                const args = {
                  model: baseModel,
                  settings: { webSearch: { ...(en !== undefined ? { enabled: en } : {}), maxUses: mu as number } },
                  ...(ov !== undefined ? { override: ov } : {}),
                  env: { ...(ews !== undefined ? { MUSE_WEB_SEARCH: ews } : {}), ...(emu !== undefined ? { MUSE_WEB_SEARCH_MAX_USES: emu } : {}) },
                };
                let policy: ReturnType<typeof decideWebSearchPolicy> | undefined;
                expect(() => { policy = decideWebSearchPolicy(args); }).not.toThrow();
                expect(typeof policy!.enabled).toBe("boolean");
                expect(Number.isInteger(policy!.maxUses) && policy!.maxUses > 0,
                  `maxUses must be a positive integer (got ${String(policy!.maxUses)})`).toBe(true);
              }
            }
          }
        }
      }
    });

    it("a falsy MUSE_WEB_SEARCH spelling (any case/whitespace) is an ABSOLUTE kill switch — override=true cannot re-enable", () => {
      for (const spell of ["false", "0", "no", "off", "FALSE", "  Off  ", "\tNO\n", "On".replace("On", "off")]) {
        for (const ov of [undefined, true, false] as const) {
          const r = decideWebSearchPolicy({
            model: baseModel,
            settings: { webSearch: { enabled: true } },
            ...(ov !== undefined ? { override: ov } : {}),
            env: { MUSE_WEB_SEARCH: spell },
          });
          expect(r.enabled, `${JSON.stringify(spell)} + override=${String(ov)}`).toBe(false);
        }
      }
    });
  });
});
