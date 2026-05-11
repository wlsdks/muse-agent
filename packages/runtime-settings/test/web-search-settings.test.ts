import { describe, expect, it } from "vitest";

import { InMemoryRuntimeSettingsStore, readWebSearchSettings } from "../src/index.js";

describe("readWebSearchSettings", () => {
  it("returns defaults when store empty and env empty", async () => {
    const store = new InMemoryRuntimeSettingsStore();
    const out = await readWebSearchSettings(store, {});
    expect(out).toEqual({ enabled: true, maxUses: 5 });
  });

  it("reads webSearch.enabled and webSearch.maxUses from store", async () => {
    const store = new InMemoryRuntimeSettingsStore();
    await store.upsert({ key: "webSearch.enabled", value: "false", type: "boolean", category: "webSearch" });
    await store.upsert({ key: "webSearch.maxUses", value: "9", type: "number", category: "webSearch" });
    const out = await readWebSearchSettings(store, {});
    expect(out).toEqual({ enabled: false, maxUses: 9 });
  });

  it("env MUSE_WEB_SEARCH=off overrides store", async () => {
    const store = new InMemoryRuntimeSettingsStore();
    await store.upsert({ key: "webSearch.enabled", value: "true", type: "boolean", category: "webSearch" });
    const out = await readWebSearchSettings(store, { MUSE_WEB_SEARCH: "off" });
    expect(out.enabled).toBe(false);
  });
});
