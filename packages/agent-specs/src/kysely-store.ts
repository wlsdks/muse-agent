import type { AgentSpecTable, MuseDatabase } from "@muse/db";
import { createRunId, toDate, type JsonValue } from "@muse/shared";
import type { Insertable, Kysely, Selectable } from "kysely";

import type { AgentSpec, AgentSpecInput, AgentSpecMode, AgentSpecRegistry } from "./index.js";
import { normalizeAgentSpecInput } from "./index.js";

type AgentSpecRow = Selectable<AgentSpecTable>;
type AgentSpecInsert = Insertable<AgentSpecTable>;

export interface KyselyAgentSpecRegistryOptions {
  readonly idFactory?: () => string;
  readonly now?: () => Date;
}

export class KyselyAgentSpecRegistry implements AgentSpecRegistry {
  private readonly idFactory: () => string;
  private readonly now: () => Date;

  constructor(
    private readonly db: Kysely<MuseDatabase>,
    options: KyselyAgentSpecRegistryOptions = {}
  ) {
    this.idFactory = options.idFactory ?? (() => createRunId("agent_spec"));
    this.now = options.now ?? (() => new Date());
  }

  async list(): Promise<readonly AgentSpec[]> {
    const rows = await this.db
      .selectFrom("agent_specs")
      .selectAll()
      .orderBy("name", "asc")
      .execute();

    return rows.map(mapAgentSpecRow);
  }

  async listEnabled(): Promise<readonly AgentSpec[]> {
    const rows = await this.db
      .selectFrom("agent_specs")
      .selectAll()
      .where("enabled", "=", true)
      .orderBy("name", "asc")
      .execute();

    return rows.map(mapAgentSpecRow);
  }

  async getById(id: string): Promise<AgentSpec | undefined> {
    const row = await this.db
      .selectFrom("agent_specs")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirst();

    return row ? mapAgentSpecRow(row) : undefined;
  }

  async getByName(name: string): Promise<AgentSpec | undefined> {
    const row = await this.db
      .selectFrom("agent_specs")
      .selectAll()
      .where("name", "=", name)
      .executeTakeFirst();

    return row ? mapAgentSpecRow(row) : undefined;
  }

  async save(input: AgentSpecInput): Promise<AgentSpec> {
    const row = await buildAgentSpecUpsertQuery(this.db, input, {
      idFactory: this.idFactory,
      now: this.now
    }).executeTakeFirstOrThrow();

    return mapAgentSpecRow(row);
  }

  async deleteById(id: string): Promise<void> {
    await this.db.deleteFrom("agent_specs").where("id", "=", id).execute();
  }

  async deleteByName(name: string): Promise<void> {
    await this.db.deleteFrom("agent_specs").where("name", "=", name).execute();
  }
}

export function buildAgentSpecUpsertQuery(
  db: Kysely<MuseDatabase>,
  input: AgentSpecInput,
  options: Required<KyselyAgentSpecRegistryOptions>
) {
  const row = createAgentSpecInsert(input, options);

  return db
    .insertInto("agent_specs")
    .values(row)
    .onConflict((oc) =>
      oc.column("name").doUpdateSet({
        description: row.description,
        enabled: row.enabled,
        independent_execution: row.independent_execution,
        keywords: row.keywords,
        mode: row.mode,
        system_prompt: row.system_prompt,
        tool_names: row.tool_names,
        updated_at: row.updated_at
      })
    )
    .returningAll();
}

export function createAgentSpecInsert(
  input: AgentSpecInput,
  options: Required<KyselyAgentSpecRegistryOptions>
): AgentSpecInsert {
  const now = input.createdAt ?? options.now();
  const normalized = normalizeAgentSpecInput(input, {
    createdAt: now,
    id: input.id ?? options.idFactory(),
    updatedAt: input.updatedAt ?? now
  });

  return {
    created_at: normalized.createdAt,
    description: normalized.description,
    enabled: normalized.enabled,
    id: normalized.id,
    independent_execution: normalized.independentExecution,
    keywords: [...normalized.keywords],
    mode: normalized.mode,
    name: normalized.name,
    system_prompt: normalized.systemPrompt ?? null,
    tool_names: [...normalized.toolNames],
    updated_at: normalized.updatedAt
  };
}

export function mapAgentSpecRow(row: AgentSpecRow): AgentSpec {
  return {
    createdAt: toDate(row.created_at),
    description: row.description,
    enabled: row.enabled,
    id: row.id,
    independentExecution: row.independent_execution,
    keywords: toStringArray(row.keywords),
    mode: row.mode as AgentSpecMode,
    name: row.name,
    systemPrompt: row.system_prompt ?? undefined,
    toolNames: toStringArray(row.tool_names),
    updatedAt: toDate(row.updated_at)
  };
}

function toStringArray(value: JsonValue): readonly string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((item): item is string => typeof item === "string");
}
