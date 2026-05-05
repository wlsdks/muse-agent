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
  RuntimeSettingsService,
  type RuntimeSetting
} from "../src/index.js";
import {
  buildRuntimeSettingUpsertQuery,
  createRuntimeSettingInsert,
  mapRuntimeSettingRow
} from "../src/kysely-store.js";

describe("RuntimeSettingsService", () => {
  it("returns typed values and falls back when settings are missing or invalid", async () => {
    const store = new InMemoryRuntimeSettingsStore();
    const service = new RuntimeSettingsService(store);

    await service.set({ key: "feature.enabled", type: "boolean", value: "true" });
    await service.set({ key: "limits.maxTools", type: "number", value: "12" });
    await service.set({ key: "routing.weights", type: "json", value: "{\"primary\":0.7}" });
    await service.set({ key: "limits.invalid", type: "number", value: "many" });
    await service.set({ key: "limits.decimal", type: "number", value: "12.5" });

    await expect(service.getBoolean("feature.enabled", false)).resolves.toBe(true);
    await expect(service.getInteger("limits.maxTools", 4)).resolves.toBe(12);
    await expect(service.getInteger("limits.decimal", 4)).resolves.toBe(4);
    await expect(service.getNumber("limits.decimal", 1.5)).resolves.toBe(12.5);
    await expect(service.getNumber("limits.invalid", 1.5)).resolves.toBe(1.5);
    await expect(service.getString("missing", "fallback")).resolves.toBe("fallback");
    await expect(service.getJson("routing.weights", {})).resolves.toEqual({ primary: 0.7 });
  });

  it("caches negative lookups until refresh or set invalidates the key", async () => {
    const store = new InMemoryRuntimeSettingsStore();
    const service = new RuntimeSettingsService(store, { cacheTtlMs: 60_000 });

    await expect(service.getString("feature.flag", "off")).resolves.toBe("off");
    store.upsert({ key: "feature.flag", value: "on" });

    await expect(service.getString("feature.flag", "off")).resolves.toBe("off");
    service.refreshCache();
    await expect(service.getString("feature.flag", "off")).resolves.toBe("on");

    await service.set({ key: "feature.flag", value: "paused" });
    await expect(service.getString("feature.flag", "off")).resolves.toBe("paused");
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

  it("preserves descriptions on update unless explicitly cleared", () => {
    const store = new InMemoryRuntimeSettingsStore();

    store.upsert({ description: "Maximum tools per run", key: "tools.max", value: "10" });
    store.upsert({ key: "tools.max", value: "20" });
    expect(store.find("tools.max")?.description).toBe("Maximum tools per run");

    store.upsert({ description: null, key: "tools.max", value: "30" });
    expect(store.find("tools.max")?.description).toBeUndefined();
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
