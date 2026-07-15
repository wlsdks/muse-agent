/**
 * Kysely-backed persistence for MCP servers + the singleton MCP
 * security policy.
 *
 * Lifted out of `packages/mcp/src/index.ts` (1,370 LOC, the largest
 * source file in the repo) so the persistence adapters live in
 * their own focused module. The shared types (`McpServer`,
 * `McpSecurityPolicy`, the store interfaces, the `Kysely*StoreOptions`
 * shapes), the in-memory stores, the manager, the transport
 * connector, and the validation/normalisation helpers all stay in
 * `index.ts`.
 *
 * The classes + their insert/update/map helpers come over together
 * because the helpers are only used by the Kysely stores. The
 * `singletonPolicyId` constant + the four `Selectable`/`Insertable`
 * row aliases also move because they're equally Kysely-only.
 *
 * Two small JsonValue/Date coercion helpers (`toJsonObject`,
 * `toStringArray`, `toDate`) get private copies here rather than
 * being promoted to the public surface of `index.ts`. They are
 * 1-2 lines each.
 */

import type { McpSecurityPolicyTable, McpServerTable, MuseDatabase } from "@muse/db";
import { createRunId, isRecord, type JsonObject, type JsonValue } from "@muse/shared";
import type { Insertable, Kysely, Selectable } from "kysely";

import {
  normalizeMcpSecurityPolicy,
  normalizeMcpServerInput,
  type KyselyMcpSecurityPolicyStoreOptions,
  type KyselyMcpServerStoreOptions,
  type McpSecurityPolicy,
  type McpSecurityPolicyInput,
  type McpSecurityPolicyStore,
  type McpServer,
  type McpServerInput,
  type McpServerStore
} from "./index.js";

type McpServerRow = Selectable<McpServerTable>;
type McpServerInsert = Insertable<McpServerTable>;
type McpSecurityPolicyRow = Selectable<McpSecurityPolicyTable>;
type McpSecurityPolicyInsert = Insertable<McpSecurityPolicyTable>;

const singletonPolicyId = "default";

export class KyselyMcpServerStore implements McpServerStore {
  private readonly idFactory: () => string;
  private readonly now: () => Date;

  constructor(
    private readonly db: Kysely<MuseDatabase>,
    options: KyselyMcpServerStoreOptions = {}
  ) {
    this.idFactory = options.idFactory ?? (() => createRunId("mcp_server"));
    this.now = options.now ?? (() => new Date());
  }

  async list(): Promise<readonly McpServer[]> {
    const rows = await this.db.selectFrom("mcp_servers").selectAll().orderBy("created_at", "asc").execute();
    return rows.map(mapMcpServerRow);
  }

  async findByName(name: string): Promise<McpServer | undefined> {
    const row = await this.db.selectFrom("mcp_servers").selectAll().where("name", "=", name).executeTakeFirst();
    return row ? mapMcpServerRow(row) : undefined;
  }

  async save(input: McpServerInput): Promise<McpServer> {
    const row = await this.db
      .insertInto("mcp_servers")
      .values(createMcpServerInsert(input, { idFactory: this.idFactory, now: this.now }))
      .returningAll()
      .executeTakeFirstOrThrow();

    return mapMcpServerRow(row);
  }

  async update(name: string, input: McpServerInput): Promise<McpServer | undefined> {
    const row = await this.db
      .updateTable("mcp_servers")
      .set(createMcpServerUpdate(input, this.now))
      .where("name", "=", name)
      .returningAll()
      .executeTakeFirst();

    return row ? mapMcpServerRow(row) : undefined;
  }

  async delete(name: string): Promise<void> {
    await this.db.deleteFrom("mcp_servers").where("name", "=", name).execute();
  }
}

export class KyselyMcpSecurityPolicyStore implements McpSecurityPolicyStore {
  private readonly now: () => Date;

  constructor(
    private readonly db: Kysely<MuseDatabase>,
    options: KyselyMcpSecurityPolicyStoreOptions = {}
  ) {
    this.now = options.now ?? (() => new Date());
  }

  async getOrNull(): Promise<McpSecurityPolicy | undefined> {
    const row = await this.db
      .selectFrom("mcp_security_policy")
      .selectAll()
      .where("id", "=", singletonPolicyId)
      .executeTakeFirst();

    return row ? mapMcpSecurityPolicyRow(row) : undefined;
  }

  async save(input: McpSecurityPolicyInput): Promise<McpSecurityPolicy> {
    const row = createMcpSecurityPolicyInsert(input, this.now);
    const saved = await this.db
      .insertInto("mcp_security_policy")
      .values(row)
      .onConflict((oc) =>
        oc.column("id").doUpdateSet({
          allowed_server_names: row.allowed_server_names,
          allowed_stdio_commands: row.allowed_stdio_commands,
          max_tool_output_length: row.max_tool_output_length,
          updated_at: row.updated_at
        })
      )
      .returningAll()
      .executeTakeFirstOrThrow();

    return mapMcpSecurityPolicyRow(saved);
  }

  async delete(): Promise<boolean> {
    const result = await this.db
      .deleteFrom("mcp_security_policy")
      .where("id", "=", singletonPolicyId)
      .executeTakeFirst();

    return Number(result.numDeletedRows ?? 0n) > 0;
  }
}

export function createMcpServerInsert(
  input: McpServerInput,
  options: Required<KyselyMcpServerStoreOptions>
): McpServerInsert {
  const server = normalizeMcpServerInput(input, {
    id: input.id ?? options.idFactory(),
    now: options.now
  });

  return {
    auto_connect: server.autoConnect,
    config: server.config,
    created_at: server.createdAt,
    description: server.description ?? null,
    id: server.id,
    name: server.name,
    transport_type: server.transportType,
    updated_at: server.updatedAt,
    version: server.version ?? null
  };
}

export function createMcpServerUpdate(input: McpServerInput, now: () => Date) {
  return {
    auto_connect: input.autoConnect ?? false,
    config: input.config ?? {},
    description: input.description ?? null,
    transport_type: input.transportType,
    updated_at: input.updatedAt ?? now(),
    version: input.version ?? null
  };
}

export function createMcpSecurityPolicyInsert(
  input: McpSecurityPolicyInput,
  now: () => Date
): McpSecurityPolicyInsert {
  const timestamp = now();
  const policy = normalizeMcpSecurityPolicy(input, timestamp);

  return {
    allowed_server_names: [...policy.allowedServerNames],
    allowed_stdio_commands: [...policy.allowedStdioCommands],
    created_at: policy.createdAt,
    id: singletonPolicyId,
    max_tool_output_length: policy.maxToolOutputLength,
    updated_at: policy.updatedAt
  };
}

export function mapMcpServerRow(row: McpServerRow): McpServer {
  return {
    autoConnect: row.auto_connect,
    config: toJsonObject(row.config),
    createdAt: toDate(row.created_at),
    description: row.description ?? undefined,
    id: row.id,
    name: row.name,
    transportType: row.transport_type,
    updatedAt: toDate(row.updated_at),
    version: row.version ?? undefined
  };
}

export function mapMcpSecurityPolicyRow(row: McpSecurityPolicyRow): McpSecurityPolicy {
  return normalizeMcpSecurityPolicy(
    {
      allowedServerNames: toStringArray(row.allowed_server_names),
      allowedStdioCommands: toStringArray(row.allowed_stdio_commands),
      maxToolOutputLength: row.max_tool_output_length
    },
    toDate(row.updated_at)
  );
}

function toJsonObject(value: unknown): JsonObject {
  if (!isRecord(value)) {
    return {};
  }

  const normalized: JsonObject = {};
  for (const [key, item] of Object.entries(value)) {
    normalized[key] = normalizeJsonValue(item);
  }
  return normalized;
}

function normalizeJsonValue(value: unknown): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => normalizeJsonValue(entry));
  }
  if (isRecord(value)) {
    return toJsonObject(value);
  }
  return null;
}

function toStringArray(value: JsonValue): readonly string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}
