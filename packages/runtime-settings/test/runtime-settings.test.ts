import type { MuseDatabase } from "@muse/db";
import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler
} from "kysely";
import { describe, expect, it } from "vitest";

import {
  InMemoryRuntimeSettingsStore,
  RuntimeSettings,
  type RuntimeSetting,
  type RuntimeSettingsStore
} from "../src/index.js";
import {
  buildRuntimeSettingUpsertQuery,
  createRuntimeSettingInsert,
  mapRuntimeSettingRow
} from "../src/kysely-store.js";

describe("RuntimeSettings", () => {
  it("returns typed values and falls back when settings are missing or invalid", async () => {
    const store = new InMemoryRuntimeSettingsStore();
    const service = new RuntimeSettings(store);

    await service.set({ key: "feature.enabled", type: "boolean", value: "true" });
    await service.set({ key: "limits.maxTools", type: "number", value: "12" });
    await service.set({ key: "routing.weights", type: "json", value: "{\"primary\":0.7}" });
    await service.set({ key: "limits.invalid", type: "number", value: "many" });
    await service.set({ key: "limits.decimal", type: "number", value: "12.5" });

    await expect(service.getBoolean("feature.enabled", false)).resolves.toBe(true);
    // The boolean parser tolerates common admin spellings.
    await service.set({ key: "feature.alt", value: "1" });
    await expect(service.getBoolean("feature.alt", false)).resolves.toBe(true);
    await service.set({ key: "feature.alt", value: "Yes" });
    await expect(service.getBoolean("feature.alt", false)).resolves.toBe(true);
    await service.set({ key: "feature.alt", value: "on" });
    await expect(service.getBoolean("feature.alt", false)).resolves.toBe(true);
    await service.set({ key: "feature.alt", value: "0" });
    await expect(service.getBoolean("feature.alt", true)).resolves.toBe(false);
    await service.set({ key: "feature.alt", value: "No" });
    await expect(service.getBoolean("feature.alt", true)).resolves.toBe(false);
    await service.set({ key: "feature.alt", value: "off" });
    await expect(service.getBoolean("feature.alt", true)).resolves.toBe(false);
    // Unknown values fall back to the caller-supplied default
    // (was silently `false` pre-goal-127).
    await service.set({ key: "feature.alt", value: "maybe" });
    await expect(service.getBoolean("feature.alt", true)).resolves.toBe(true);
    await expect(service.getBoolean("feature.alt", false)).resolves.toBe(false);

    await expect(service.getInteger("limits.maxTools", 4)).resolves.toBe(12);
    await expect(service.getInteger("limits.decimal", 4)).resolves.toBe(4);

    // Beyond Number.MAX_SAFE_INTEGER the parsed value loses
    // precision (e.g. "9007199254740993" → 9007199254740992 — silent
    // off-by-one). Reject the precision-loss value via
    // Number.isSafeInteger so the caller sees defaultValue instead of
    // an integer that lies about what the admin typed.
    await service.set({ key: "limits.huge", type: "number", value: "9007199254740993" });
    await expect(service.getInteger("limits.huge", 4)).resolves.toBe(4);
    // Exactly Number.MAX_SAFE_INTEGER is safe.
    await service.set({ key: "limits.maxSafe", type: "number", value: "9007199254740991" });
    await expect(service.getInteger("limits.maxSafe", 4)).resolves.toBe(9007199254740991);
    // Negative beyond −MAX_SAFE_INTEGER also rejected.
    await service.set({ key: "limits.tinyNeg", type: "number", value: "-9007199254740993" });
    await expect(service.getInteger("limits.tinyNeg", 4)).resolves.toBe(4);
    await expect(service.getNumber("limits.decimal", 1.5)).resolves.toBe(12.5);
    await expect(service.getNumber("limits.invalid", 1.5)).resolves.toBe(1.5);
    await expect(service.getString("missing", "fallback")).resolves.toBe("fallback");
    await expect(service.getJson("routing.weights", {})).resolves.toEqual({ primary: 0.7 });
    await service.set({ key: "routing.nonfinite", type: "json", value: "{\"score\":1e400}" });
    await expect(service.getJson("routing.nonfinite", { score: 0 })).resolves.toEqual({ score: 0 });
  });

  it("caches negative lookups until refresh or set invalidates the key", async () => {
    const store = new InMemoryRuntimeSettingsStore();
    const service = new RuntimeSettings(store, { cacheTtlMs: 60_000 });

    await expect(service.getString("feature.flag", "off")).resolves.toBe("off");
    store.upsert({ key: "feature.flag", value: "on" });

    await expect(service.getString("feature.flag", "off")).resolves.toBe("off");
    service.refreshCache();
    await expect(service.getString("feature.flag", "off")).resolves.toBe("on");

    await service.set({ key: "feature.flag", value: "paused" });
    await expect(service.getString("feature.flag", "off")).resolves.toBe("paused");
  });

  it("does not let an older in-flight read repopulate the cache after set", async () => {
    const backing = new InMemoryRuntimeSettingsStore();
    const deferred = Promise.withResolvers<string | undefined>();
    let deferFirstRead = true;
    const store: RuntimeSettingsStore = {
      delete: (key) => backing.delete(key),
      find: (key) => backing.find(key),
      findValue: (key) => {
        if (deferFirstRead) {
          deferFirstRead = false;
          return deferred.promise;
        }
        return backing.findValue(key);
      },
      list: () => backing.list(),
      upsert: (input) => backing.upsert(input)
    };
    const service = new RuntimeSettings(store, { cacheTtlMs: 60_000 });

    const staleRead = service.getString("feature.flag", "off");
    await service.set({ key: "feature.flag", value: "fresh" });
    deferred.resolve("stale");

    await expect(staleRead).resolves.toBe("stale");
    await expect(service.getString("feature.flag", "off")).resolves.toBe("fresh");
  });

  it("does not let an older in-flight read repopulate the cache after refresh", async () => {
    const backing = new InMemoryRuntimeSettingsStore();
    backing.upsert({ key: "feature.flag", value: "fresh" });
    const deferred = Promise.withResolvers<string | undefined>();
    let deferFirstRead = true;
    const store: RuntimeSettingsStore = {
      delete: (key) => backing.delete(key),
      find: (key) => backing.find(key),
      findValue: (key) => {
        if (deferFirstRead) {
          deferFirstRead = false;
          return deferred.promise;
        }
        return backing.findValue(key);
      },
      list: () => backing.list(),
      upsert: (input) => backing.upsert(input)
    };
    const service = new RuntimeSettings(store, { cacheTtlMs: 60_000 });

    const staleRead = service.getString("feature.flag", "off");
    service.refreshCache();
    deferred.resolve("stale");

    await expect(staleRead).resolves.toBe("stale");
    await expect(service.getString("feature.flag", "off")).resolves.toBe("fresh");
  });

  it("falls back to the 30-second default when a non-finite / non-positive cacheTtlMs slips through (NaN from a corrupt config, Infinity from a 'cache forever' typo, 0 / negative from a zero-cache mistake) — the cache must NOT degenerate into always-miss (NaN) or never-expire (Infinity)", async () => {
    const store = new InMemoryRuntimeSettingsStore();
    store.upsert({ key: "feature.flag", value: "on" });

    // NaN — pre-fix `now + NaN = NaN` made every `expiresAt > now`
    // false, so the cache always missed. With the guard the default
    // TTL applies and the lookup is cached normally; bumping the
    // store value AFTER the first lookup must NOT be visible until
    // the cache is explicitly refreshed.
    const withNaN = new RuntimeSettings(store, { cacheTtlMs: Number.NaN });
    await expect(withNaN.getString("feature.flag", "off")).resolves.toBe("on");
    store.upsert({ key: "feature.flag", value: "off-but-cached" });
    await expect(withNaN.getString("feature.flag", "off")).resolves.toBe("on");

    // Infinity — pre-fix the cache entry never expired AND every
    // `now + Infinity = Infinity` → every entry stuck forever.
    // Post-fix it falls to the 30-second default and behaves
    // identically to the NaN branch (cached, until refresh).
    const withInfinity = new RuntimeSettings(store, { cacheTtlMs: Number.POSITIVE_INFINITY });
    await expect(withInfinity.getString("k", "fallback")).resolves.toBe("fallback");

    // 0 — `??` doesn't catch 0; pre-fix this disabled the cache
    // entirely (every `0 > delta` is false → always-miss).
    // Post-fix it falls to 30s default.
    const withZero = new RuntimeSettings(store, { cacheTtlMs: 0 });
    await expect(withZero.getString("k", "fallback")).resolves.toBe("fallback");

    // Negative — same family, same fix.
    const withNegative = new RuntimeSettings(store, { cacheTtlMs: -1 });
    await expect(withNegative.getString("k", "fallback")).resolves.toBe("fallback");
  });
});

describe("InMemoryRuntimeSettingsStore", () => {
  it("keeps runtime settings sorted by category and key", () => {
    const updatedAt = new Date("2026-01-01T00:00:00.000Z");
    const store = new InMemoryRuntimeSettingsStore([
      setting({ category: "routing", key: "routing.secondary", updatedAt }),
      setting({ category: "guard", key: "guard.rateLimit", updatedAt }),
      setting({ category: "routing", key: "routing.primary", updatedAt })
    ]);

    expect(store.list().map((item) => item.key)).toEqual([
      "guard.rateLimit",
      "routing.primary",
      "routing.secondary"
    ]);
  });

  it("preserves optional metadata on update unless explicitly cleared", () => {
    const store = new InMemoryRuntimeSettingsStore();

    store.upsert({
      description: "Maximum tools per run",
      key: "tools.max",
      updatedBy: "operator",
      value: "10"
    });
    store.upsert({ key: "tools.max", value: "20" });
    expect(store.find("tools.max")?.description).toBe("Maximum tools per run");
    expect(store.find("tools.max")?.updatedBy).toBe("operator");

    store.upsert({ description: null, key: "tools.max", updatedBy: null, value: "30" });
    expect(store.find("tools.max")?.description).toBeUndefined();
    expect(store.find("tools.max")?.updatedBy).toBeUndefined();
  });
});

describe("KyselyRuntimeSettingsStore", () => {
  it("builds PostgreSQL upsert SQL for runtime settings", () => {
    const db = createPostgresBuilder();
    const now = new Date("2026-01-01T00:00:00.000Z");
    const query = buildRuntimeSettingUpsertQuery(
      db,
      {
        category: "guard",
        description: "Requests per minute",
        key: "guard.rateLimit",
        type: "number",
        updatedBy: "operator",
        value: "20"
      },
      { now: () => now }
    );

    const compiled = query.compile();

    expect(compiled.sql).toContain('insert into "runtime_settings"');
    expect(compiled.sql).toContain('on conflict ("key") do update');
    expect(compiled.sql).toContain("returning *");
    expect(compiled.parameters).toEqual([
      "guard",
      "Requests per minute",
      "guard.rateLimit",
      "number",
      now,
      "operator",
      "20",
      "guard",
      "Requests per minute",
      "number",
      now,
      "operator",
      "20"
    ]);
  });

  it("preserves omitted metadata in a Kysely conflict update, matching the in-memory patch contract", () => {
    const db = createPostgresBuilder();
    const now = new Date("2026-01-01T00:00:00.000Z");
    const compiled = buildRuntimeSettingUpsertQuery(
      db,
      { key: "guard.rateLimit", value: "30" },
      { now: () => now }
    ).compile();

    expect(compiled.parameters).toEqual([
      "general",
      null,
      "guard.rateLimit",
      "string",
      now,
      null,
      "30",
      now,
      "30"
    ]);
  });

  it("maps runtime setting rows and insert payloads without private material", () => {
    const now = new Date("2026-01-01T00:00:00.000Z");
    const insert = createRuntimeSettingInsert(
      { key: "model.default", type: "string", value: "provider/model" },
      { now: () => now }
    );

    expect(insert).toMatchObject({
      category: "general",
      description: null,
      key: "model.default",
      type: "string",
      updated_at: now,
      updated_by: null,
      value: "provider/model"
    });
    expect(
      mapRuntimeSettingRow({
        ...insert,
        description: "Default model alias",
        updated_by: "operator"
      })
    ).toEqual({
      category: "general",
      description: "Default model alias",
      key: "model.default",
      type: "string",
      updatedAt: now,
      updatedBy: "operator",
      value: "provider/model"
    });
  });
});

function setting(input: Partial<RuntimeSetting> & Pick<RuntimeSetting, "key" | "updatedAt">): RuntimeSetting {
  return {
    category: input.category ?? "general",
    description: input.description,
    key: input.key,
    type: input.type ?? "string",
    updatedAt: input.updatedAt,
    updatedBy: input.updatedBy,
    value: input.value ?? "value"
  };
}

function createPostgresBuilder(): Kysely<MuseDatabase> {
  return new Kysely<MuseDatabase>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => new DummyDriver(),
      createIntrospector: (db) => new PostgresIntrospector(db),
      createQueryCompiler: () => new PostgresQueryCompiler()
    }
  });
}
