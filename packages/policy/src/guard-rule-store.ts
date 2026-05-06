import type {
  InputGuardRuleTable,
  MuseDatabase,
  OutputGuardRuleAuditTable,
  OutputGuardRuleTable
} from "@muse/db";
import { createRunId, type JsonObject } from "@muse/shared";
import type { Insertable, Kysely, Selectable } from "kysely";

export interface GuardRuleStore {
  deleteInputRule(id: string): Promise<boolean>;
  deleteOutputRule(id: string): Promise<boolean>;
  getInputRule(id: string): Promise<JsonObject | undefined>;
  getOutputRule(id: string): Promise<JsonObject | undefined>;
  listInputRules(): Promise<readonly JsonObject[]>;
  listOutputAudits(limit?: number): Promise<readonly JsonObject[]>;
  listOutputRules(): Promise<readonly JsonObject[]>;
  saveInputRule(record: JsonObject): Promise<JsonObject>;
  saveOutputAudit(record: JsonObject): Promise<JsonObject>;
  saveOutputRule(record: JsonObject): Promise<JsonObject>;
}

export type InputGuardRuleDecision =
  | { readonly allowed: true; readonly ruleId?: string }
  | { readonly allowed: false; readonly reason: string; readonly ruleId: string };

type InputGuardRuleRow = Selectable<InputGuardRuleTable>;
type InputGuardRuleInsert = Insertable<InputGuardRuleTable>;
type OutputGuardRuleRow = Selectable<OutputGuardRuleTable>;
type OutputGuardRuleInsert = Insertable<OutputGuardRuleTable>;
type OutputGuardRuleAuditRow = Selectable<OutputGuardRuleAuditTable>;
type OutputGuardRuleAuditInsert = Insertable<OutputGuardRuleAuditTable>;

export class InMemoryGuardRuleStore implements GuardRuleStore {
  private readonly inputRules = new Map<string, JsonObject>();
  private readonly outputAudits = new Map<string, JsonObject>();
  private readonly outputRules = new Map<string, JsonObject>();

  async saveInputRule(record: JsonObject): Promise<JsonObject> {
    const saved = withIdentity(record, "input_guard_rule");
    this.inputRules.set(saved.id, saved);
    return saved;
  }

  async listInputRules(): Promise<readonly JsonObject[]> {
    return [...this.inputRules.values()].sort(compareRulePriority);
  }

  async getInputRule(id: string): Promise<JsonObject | undefined> {
    return this.inputRules.get(id) ?? [...this.inputRules.values()].find((rule) => rule.name === id);
  }

  async deleteInputRule(id: string): Promise<boolean> {
    const existing = await this.getInputRule(id);
    return existing ? this.inputRules.delete(stringValue(existing.id)) : false;
  }

  async saveOutputRule(record: JsonObject): Promise<JsonObject> {
    const saved = withIdentity(record, "output_guard_rule");
    this.outputRules.set(saved.id, saved);
    return saved;
  }

  async listOutputRules(): Promise<readonly JsonObject[]> {
    return [...this.outputRules.values()].sort(compareRulePriority);
  }

  async getOutputRule(id: string): Promise<JsonObject | undefined> {
    return this.outputRules.get(id) ?? [...this.outputRules.values()].find((rule) => rule.name === id);
  }

  async deleteOutputRule(id: string): Promise<boolean> {
    const existing = await this.getOutputRule(id);
    return existing ? this.outputRules.delete(stringValue(existing.id)) : false;
  }

  async saveOutputAudit(record: JsonObject): Promise<JsonObject> {
    const saved = withIdentity(record, "output_guard_audit");
    this.outputAudits.set(saved.id, saved);
    return saved;
  }

  async listOutputAudits(limit = 100): Promise<readonly JsonObject[]> {
    return [...this.outputAudits.values()]
      .sort((left, right) => dateValue(left.createdAt).getTime() - dateValue(right.createdAt).getTime())
      .slice(-Math.min(Math.max(limit, 1), 1000));
  }
}

export class KyselyGuardRuleStore implements GuardRuleStore {
  constructor(private readonly db: Kysely<MuseDatabase>) {}

  async saveInputRule(record: JsonObject): Promise<JsonObject> {
    const row = createInputGuardRuleInsert(record);
    const saved = await this.db
      .insertInto("input_guard_rules")
      .values(row)
      .onConflict((oc) => oc.column("id").doUpdateSet({
        action: row.action,
        category: row.category,
        description: row.description,
        enabled: row.enabled,
        name: row.name,
        pattern: row.pattern,
        pattern_type: row.pattern_type,
        priority: row.priority,
        updated_at: row.updated_at
      }))
      .returningAll()
      .executeTakeFirstOrThrow();
    return mapInputGuardRuleRow(saved);
  }

  async listInputRules(): Promise<readonly JsonObject[]> {
    const rows = await this.db
      .selectFrom("input_guard_rules")
      .selectAll()
      .orderBy("priority", "asc")
      .orderBy("created_at", "asc")
      .execute();
    return rows.map(mapInputGuardRuleRow);
  }

  async getInputRule(id: string): Promise<JsonObject | undefined> {
    const row = await this.db
      .selectFrom("input_guard_rules")
      .selectAll()
      .where((eb) => eb.or([eb("id", "=", id), eb("name", "=", id)]))
      .executeTakeFirst();
    return row ? mapInputGuardRuleRow(row) : undefined;
  }

  async deleteInputRule(id: string): Promise<boolean> {
    const existing = await this.getInputRule(id);
    if (!existing) {
      return false;
    }
    const result = await this.db.deleteFrom("input_guard_rules").where("id", "=", stringValue(existing.id)).executeTakeFirst();
    return Number(result.numDeletedRows ?? 0) > 0;
  }

  async saveOutputRule(record: JsonObject): Promise<JsonObject> {
    const row = createOutputGuardRuleInsert(record);
    const saved = await this.db
      .insertInto("output_guard_rules")
      .values(row)
      .onConflict((oc) => oc.column("id").doUpdateSet({
        action: row.action,
        enabled: row.enabled,
        name: row.name,
        pattern: row.pattern,
        priority: row.priority,
        replacement: row.replacement,
        updated_at: row.updated_at
      }))
      .returningAll()
      .executeTakeFirstOrThrow();
    return mapOutputGuardRuleRow(saved);
  }

  async listOutputRules(): Promise<readonly JsonObject[]> {
    const rows = await this.db
      .selectFrom("output_guard_rules")
      .selectAll()
      .orderBy("priority", "asc")
      .orderBy("created_at", "asc")
      .execute();
    return rows.map(mapOutputGuardRuleRow);
  }

  async getOutputRule(id: string): Promise<JsonObject | undefined> {
    const row = await this.db
      .selectFrom("output_guard_rules")
      .selectAll()
      .where((eb) => eb.or([eb("id", "=", id), eb("name", "=", id)]))
      .executeTakeFirst();
    return row ? mapOutputGuardRuleRow(row) : undefined;
  }

  async deleteOutputRule(id: string): Promise<boolean> {
    const existing = await this.getOutputRule(id);
    if (!existing) {
      return false;
    }
    const result = await this.db.deleteFrom("output_guard_rules").where("id", "=", stringValue(existing.id)).executeTakeFirst();
    return Number(result.numDeletedRows ?? 0) > 0;
  }

  async saveOutputAudit(record: JsonObject): Promise<JsonObject> {
    const row = createOutputGuardRuleAuditInsert(record);
    const saved = await this.db
      .insertInto("output_guard_rule_audits")
      .values(row)
      .returningAll()
      .executeTakeFirstOrThrow();
    return mapOutputGuardRuleAuditRow(saved);
  }

  async listOutputAudits(limit = 100): Promise<readonly JsonObject[]> {
    const rows = await this.db
      .selectFrom("output_guard_rule_audits")
      .selectAll()
      .orderBy("created_at", "desc")
      .limit(Math.min(Math.max(limit, 1), 1000))
      .execute();
    return rows.reverse().map(mapOutputGuardRuleAuditRow);
  }
}

export function createInputGuardRuleInsert(record: JsonObject): InputGuardRuleInsert {
  const prepared = withIdentity(record, "input_guard_rule");
  return {
    action: stringValue(prepared.action) || "block",
    category: stringValue(prepared.category) || "custom",
    created_at: dateValue(prepared.createdAt),
    description: nullableString(prepared.description),
    enabled: booleanValue(prepared.enabled, true),
    id: prepared.id,
    name: stringValue(prepared.name),
    pattern: stringValue(prepared.pattern),
    pattern_type: stringValue(prepared.patternType) || "regex",
    priority: numberValue(prepared.priority, 100),
    updated_at: dateValue(prepared.updatedAt)
  };
}

export function mapInputGuardRuleRow(row: InputGuardRuleRow | InputGuardRuleInsert): JsonObject {
  return {
    action: row.action,
    category: row.category,
    createdAt: dateValue(row.created_at).toISOString(),
    description: row.description ?? null,
    enabled: row.enabled,
    id: row.id,
    name: row.name,
    pattern: row.pattern,
    patternType: row.pattern_type,
    priority: row.priority,
    updatedAt: dateValue(row.updated_at).toISOString()
  };
}

export async function evaluateInputGuardRules(
  store: Pick<GuardRuleStore, "listInputRules">,
  input: string
): Promise<InputGuardRuleDecision> {
  const rules = await store.listInputRules();

  for (const rule of rules) {
    if (!booleanValue(rule.enabled, true) || !matchesInputGuardRule(rule, input)) {
      continue;
    }

    if (stringValue(rule.action).toLowerCase() === "allow") {
      return {
        allowed: true,
        ruleId: stringValue(rule.id)
      };
    }

    return {
      allowed: false,
      reason: `Blocked by input guard rule: ${stringValue(rule.name) || stringValue(rule.id)}`,
      ruleId: stringValue(rule.id)
    };
  }

  return { allowed: true };
}

export function createOutputGuardRuleInsert(record: JsonObject): OutputGuardRuleInsert {
  const prepared = withIdentity(record, "output_guard_rule");
  return {
    action: stringValue(prepared.action) || "MASK",
    created_at: dateValue(prepared.createdAt),
    enabled: booleanValue(prepared.enabled, true),
    id: prepared.id,
    name: stringValue(prepared.name),
    pattern: stringValue(prepared.pattern),
    priority: numberValue(prepared.priority, 100),
    replacement: stringValue(prepared.replacement) || "[REDACTED]",
    updated_at: dateValue(prepared.updatedAt)
  };
}

export function mapOutputGuardRuleRow(row: OutputGuardRuleRow | OutputGuardRuleInsert): JsonObject {
  return {
    action: row.action,
    createdAt: dateValue(row.created_at).toISOString(),
    enabled: row.enabled,
    id: row.id,
    name: row.name,
    pattern: row.pattern,
    priority: row.priority,
    replacement: row.replacement,
    updatedAt: dateValue(row.updated_at).toISOString()
  };
}

export function createOutputGuardRuleAuditInsert(record: JsonObject): OutputGuardRuleAuditInsert {
  const prepared = withIdentity(record, "output_guard_audit");
  return {
    action: stringValue(prepared.action) || "CREATE",
    actor: stringValue(prepared.actor) || "anonymous",
    created_at: dateValue(prepared.createdAt),
    detail: nullableString(prepared.detail),
    id: prepared.id,
    rule_id: nullableString(prepared.ruleId)
  };
}

export function mapOutputGuardRuleAuditRow(row: OutputGuardRuleAuditRow | OutputGuardRuleAuditInsert): JsonObject {
  return {
    action: row.action,
    actor: row.actor,
    createdAt: dateValue(row.created_at).toISOString(),
    detail: row.detail ?? null,
    id: row.id,
    ruleId: row.rule_id ?? null
  };
}

function withIdentity(record: JsonObject, prefix: string): JsonObject & { readonly id: string } {
  const createdAt = dateValue(record.createdAt).toISOString();
  return {
    ...record,
    createdAt,
    id: stringValue(record.id) || createRunId(prefix),
    updatedAt: dateValue(record.updatedAt ?? createdAt).toISOString()
  };
}

function compareRulePriority(left: JsonObject, right: JsonObject): number {
  return numberValue(left.priority, 100) - numberValue(right.priority, 100)
    || dateValue(left.createdAt).getTime() - dateValue(right.createdAt).getTime();
}

function matchesInputGuardRule(rule: JsonObject, input: string): boolean {
  const pattern = stringValue(rule.pattern);
  const patternType = stringValue(rule.patternType).toLowerCase();

  if (pattern.length === 0) {
    return false;
  }

  if (patternType === "keyword") {
    return input.toLowerCase().includes(pattern.toLowerCase());
  }

  try {
    return new RegExp(pattern, "iu").test(input);
  } catch {
    return false;
  }
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function nullableString(value: unknown): string | null {
  const normalized = stringValue(value).trim();
  return normalized.length > 0 ? normalized : null;
}

function numberValue(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.trunc(value);
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.trunc(parsed) : fallback;
  }
  return fallback;
}

function booleanValue(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function dateValue(value: unknown): Date {
  return value instanceof Date ? value : new Date(typeof value === "string" ? value : Date.now());
}
