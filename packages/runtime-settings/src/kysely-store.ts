import type { MuseDatabase, RuntimeSettingTable } from "@muse/db";
import { toDate } from "@muse/shared";
import type { Insertable, Kysely, Selectable } from "kysely";

import type {
  RuntimeSetting,
  RuntimeSettingsStore,
  RuntimeSettingType,
  RuntimeSettingUpsert
} from "./index.js";

type RuntimeSettingRow = Selectable<RuntimeSettingTable>;
type RuntimeSettingInsert = Insertable<RuntimeSettingTable>;

export interface KyselyRuntimeSettingsStoreOptions {
  readonly now?: () => Date;
}

export class KyselyRuntimeSettingsStore implements RuntimeSettingsStore {
  private readonly now: () => Date;

  constructor(
    private readonly db: Kysely<MuseDatabase>,
    options: KyselyRuntimeSettingsStoreOptions = {}
  ) {
    this.now = options.now ?? (() => new Date());
  }

  async findValue(key: string): Promise<string | undefined> {
    const row = await this.db
      .selectFrom("runtime_settings")
      .select("value")
      .where("key", "=", key)
      .executeTakeFirst();

    return row?.value;
  }

  async find(key: string): Promise<RuntimeSetting | undefined> {
    const row = await this.db
      .selectFrom("runtime_settings")
      .selectAll()
      .where("key", "=", key)
      .executeTakeFirst();

    return row ? mapRuntimeSettingRow(row) : undefined;
  }

  async list(): Promise<readonly RuntimeSetting[]> {
    const rows = await this.db
      .selectFrom("runtime_settings")
      .selectAll()
      .orderBy("category", "asc")
      .orderBy("key", "asc")
      .execute();

    return rows.map(mapRuntimeSettingRow);
  }

  async upsert(input: RuntimeSettingUpsert): Promise<RuntimeSetting> {
    const row = await buildRuntimeSettingUpsertQuery(this.db, input, {
      now: this.now
    }).executeTakeFirstOrThrow();

    return mapRuntimeSettingRow(row);
  }

  async delete(key: string): Promise<void> {
    await this.db.deleteFrom("runtime_settings").where("key", "=", key).execute();
  }
}

export function buildRuntimeSettingUpsertQuery(
  db: Kysely<MuseDatabase>,
  input: RuntimeSettingUpsert,
  options: Required<KyselyRuntimeSettingsStoreOptions>
) {
  const row = createRuntimeSettingInsert(input, options);
  // Match the in-memory store's patch semantics: an omitted optional field
  // preserves its persisted value, while explicit null still clears it.
  const updates = {
    ...(input.category === undefined ? {} : { category: row.category }),
    ...(input.description === undefined ? {} : { description: row.description }),
    ...(input.type === undefined ? {} : { type: row.type }),
    updated_at: row.updated_at,
    ...(input.updatedBy === undefined ? {} : { updated_by: row.updated_by }),
    value: row.value
  };

  return db
    .insertInto("runtime_settings")
    .values(row)
    .onConflict((oc) => oc.column("key").doUpdateSet(updates))
    .returningAll();
}

export function createRuntimeSettingInsert(
  input: RuntimeSettingUpsert,
  options: Required<KyselyRuntimeSettingsStoreOptions>
): RuntimeSettingInsert {
  return {
    category: input.category ?? "general",
    description: input.description ?? null,
    key: input.key,
    type: input.type ?? "string",
    updated_at: input.updatedAt ?? options.now(),
    updated_by: input.updatedBy ?? null,
    value: input.value
  };
}

export function mapRuntimeSettingRow(row: RuntimeSettingRow): RuntimeSetting {
  return {
    category: row.category,
    description: row.description ?? undefined,
    key: row.key,
    type: row.type as RuntimeSettingType,
    updatedAt: toDate(row.updated_at),
    updatedBy: row.updated_by ?? undefined,
    value: row.value
  };
}
