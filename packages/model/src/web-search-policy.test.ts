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

  it("MUSE_WEB_SEARCH_MAX_USES that is not a positive integer falls through", () => {
    expect(
      decideWebSearchPolicy({
        model: baseModel,
        settings: {},
        env: { MUSE_WEB_SEARCH_MAX_USES: "abc" }
      }).maxUses
    ).toBe(5);
  });

  it("env MUSE_WEB_SEARCH=on is no-op when nothing else disables", () => {
    const r = decideWebSearchPolicy({
      model: baseModel,
      settings: {},
      env: { MUSE_WEB_SEARCH: "on" }
    });
    expect(r.enabled).toBe(true);
  });
});
