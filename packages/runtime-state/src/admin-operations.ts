import type {
  AdminAuditTable,
  AdminAlertTable,
  AdminCostUsageTable,
  AdminSloTable,
  MetricAuditTrailTable,
  MuseDatabase
} from "@muse/db";
import { createRunId, type JsonObject } from "@muse/shared";
import type { Insertable, Kysely, Selectable } from "kysely";

type Awaitable<T> = T | Promise<T>;

export type AdminAlertSeverity = "info" | "warning" | "critical";
export type AdminAlertStatus = "open" | "resolved";
export type AdminSloStatus = "healthy" | "at_risk" | "violated";

export interface AdminAlert {
  readonly id: string;
  readonly severity: AdminAlertSeverity;
  readonly status: AdminAlertStatus;
  readonly message: string;
  readonly target?: string;
  readonly createdAt: Date;
}

export interface AdminSlo {
  readonly id: string;
  readonly name: string;
  readonly target: number;
  readonly actual?: number;
  readonly window: string;
  readonly status: AdminSloStatus;
  readonly updatedAt: Date;
}

export interface AdminCostUsage {
  readonly model?: string;
  readonly costUsd: string;
}

export interface AdminCostSummary {
  readonly totalCostUsd: string;
  readonly byModel: Readonly<Record<string, string>>;
}

export interface AdminOperationsStore {
  listAlerts(): Awaitable<readonly AdminAlert[]>;
  createAlert(input: AdminAlertInput): Awaitable<AdminAlert>;
  resolveAlert(id: string): Awaitable<AdminAlert | undefined>;
  listSlos(): Awaitable<readonly AdminSlo[]>;
  upsertSlo(input: AdminSloInput): Awaitable<AdminSlo>;
  recordCost(input: AdminCostUsage): Awaitable<AdminCostSummary>;
  costSummary(): Awaitable<AdminCostSummary>;
}

export interface AdminAuditRecord {
  readonly id: string;
  readonly category: string;
  readonly action: string;
  readonly actor: string;
  readonly resourceType?: string | null;
  readonly resourceId?: string | null;
  readonly detail?: string | null;
  readonly createdAt: Date;
}

export interface AdminAuditInput {
  readonly id?: string;
  readonly category: string;
  readonly action: string;
  readonly actor: string;
  readonly resourceType?: string | null;
  readonly resourceId?: string | null;
  readonly detail?: string | null;
}

export interface AdminAuditQueryFilter {
  readonly category?: string;
  readonly action?: string;
  readonly limit?: number;
  readonly offset?: number;
}

export interface AdminAuditQueryPage {
  readonly items: readonly AdminAuditRecord[];
  readonly total: number;
}

export interface AdminAuditStore {
  record(input: AdminAuditInput): Awaitable<AdminAuditRecord>;
  listRecent(limit?: number): Awaitable<readonly AdminAuditRecord[]>;
  query(filter?: AdminAuditQueryFilter): Awaitable<AdminAuditQueryPage>;
}

export interface MetricAuditEvent {
  readonly id: string;
  readonly kind: string;
  readonly payload: JsonObject;
  readonly createdAt: Date;
}

export interface MetricAuditEventInput {
  readonly id?: string;
  readonly kind: string;
  readonly payload: JsonObject;
}

export interface MetricAuditEventStore {
  record(input: MetricAuditEventInput): Awaitable<MetricAuditEvent>;
  listRecent(limit?: number): Awaitable<readonly MetricAuditEvent[]>;
}

export interface AdminAlertInput {
  readonly id?: string;
  readonly severity?: AdminAlertSeverity;
  readonly message: string;
  readonly target?: string;
}

export interface AdminSloInput {
  readonly id?: string;
  readonly name: string;
  readonly target: number;
  readonly actual?: number;
  readonly window: string;
}

export interface InMemoryAdminOperationsStoreOptions {
  readonly idFactory?: (kind: "alert" | "slo") => string;
  readonly now?: () => Date;
}

export interface KyselyAdminOperationsStoreOptions {
  readonly idFactory?: (kind: "alert" | "slo" | "cost_usage") => string;
  readonly now?: () => Date;
}

type AdminAlertRow = Selectable<AdminAlertTable>;
type AdminSloRow = Selectable<AdminSloTable>;
type AdminCostUsageRow = Selectable<AdminCostUsageTable>;
type AdminAuditRow = Selectable<AdminAuditTable>;
type AdminAuditInsert = Insertable<AdminAuditTable>;
type MetricAuditTrailRow = Selectable<MetricAuditTrailTable>;
type MetricAuditTrailInsert = Insertable<MetricAuditTrailTable>;
type AdminAlertInsert = Insertable<AdminAlertTable>;
type AdminSloInsert = Insertable<AdminSloTable>;
type AdminCostUsageInsert = Insertable<AdminCostUsageTable>;

export class InMemoryAdminOperationsStore implements AdminOperationsStore {
  private readonly idFactory: (kind: "alert" | "slo") => string;
  private readonly now: () => Date;
  private readonly alerts = new Map<string, AdminAlert>();
  private readonly slos = new Map<string, AdminSlo>();
  private readonly costs: AdminCostUsage[] = [];

  constructor(options: InMemoryAdminOperationsStoreOptions = {}) {
    this.idFactory = options.idFactory ?? ((kind) => createRunId(kind));
    this.now = options.now ?? (() => new Date());
  }

  listAlerts(): readonly AdminAlert[] {
    return [...this.alerts.values()].sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime());
  }

  createAlert(input: AdminAlertInput): AdminAlert {
    const alert: AdminAlert = {
      createdAt: this.now(),
      id: input.id ?? this.idFactory("alert"),
      message: input.message,
      severity: input.severity ?? "warning",
      status: "open",
      ...(input.target ? { target: input.target } : {})
    };

    this.alerts.set(alert.id, alert);
    return alert;
  }

  resolveAlert(id: string): AdminAlert | undefined {
    const existing = this.alerts.get(id);

    if (!existing) {
      return undefined;
    }

    const updated: AdminAlert = {
      ...existing,
      status: "resolved"
    };

    this.alerts.set(id, updated);
    return updated;
  }

  listSlos(): readonly AdminSlo[] {
    return [...this.slos.values()].sort(compareById);
  }

  upsertSlo(input: AdminSloInput): AdminSlo {
    const slo: AdminSlo = {
      id: input.id ?? this.idFactory("slo"),
      name: input.name,
      status: calculateSloStatus(input.target, input.actual),
      target: input.target,
      ...(input.actual !== undefined ? { actual: input.actual } : {}),
      updatedAt: this.now(),
      window: input.window
    };

    this.slos.set(slo.id, slo);
    return slo;
  }

  recordCost(input: AdminCostUsage): AdminCostSummary {
    this.costs.push(input);
    return this.costSummary();
  }

  costSummary(): AdminCostSummary {
    return {
      byModel: sumCostsByModel(this.costs),
      totalCostUsd: formatCost(this.costs.reduce((sum, item) => sum + Number(item.costUsd), 0))
    };
  }
}

export class InMemoryAdminAuditStore implements AdminAuditStore {
  private readonly audits = new Map<string, AdminAuditRecord>();
  private readonly idFactory: () => string;
  private readonly maxAudits: number;
  private readonly now: () => Date;

  constructor(options: {
    readonly idFactory?: () => string;
    readonly maxAudits?: number;
    readonly now?: () => Date;
  } = {}) {
    this.idFactory = options.idFactory ?? (() => createRunId("admin_audit"));
    this.maxAudits = Math.max(1, options.maxAudits ?? 50_000);
    this.now = options.now ?? (() => new Date());
  }

  record(input: AdminAuditInput): AdminAuditRecord {
    const record: AdminAuditRecord = {
      action: input.action.toUpperCase(),
      actor: input.actor,
      category: input.category,
      createdAt: this.now(),
      detail: input.detail ?? null,
      id: input.id ?? this.idFactory(),
      resourceId: input.resourceId ?? null,
      resourceType: input.resourceType ?? null
    };

    this.audits.set(record.id, record);
    trimOldestMap(this.audits, this.maxAudits);
    return record;
  }

  listRecent(limit = 1000): readonly AdminAuditRecord[] {
    return [...this.audits.values()]
      .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())
      .slice(0, Math.max(1, limit));
  }

  query(filter: AdminAuditQueryFilter = {}): AdminAuditQueryPage {
    const limit = Math.max(1, filter.limit ?? 50);
    const offset = Math.max(0, filter.offset ?? 0);
    const category = filter.category?.toLowerCase();
    const action = filter.action?.toUpperCase();
    const filtered = [...this.audits.values()]
      .filter((record) => !category || record.category.toLowerCase() === category)
      .filter((record) => !action || record.action.toUpperCase() === action)
      .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime());
    return {
      items: filtered.slice(offset, offset + limit),
      total: filtered.length
    };
  }
}

export class KyselyAdminAuditStore implements AdminAuditStore {
  private readonly idFactory: () => string;
  private readonly now: () => Date;

  constructor(
    private readonly db: Kysely<MuseDatabase>,
    options: { readonly idFactory?: () => string; readonly now?: () => Date } = {}
  ) {
    this.idFactory = options.idFactory ?? (() => createRunId("admin_audit"));
    this.now = options.now ?? (() => new Date());
  }

  async record(input: AdminAuditInput): Promise<AdminAuditRecord> {
    const row = await this.db
      .insertInto("admin_audits")
      .values(createAdminAuditInsert(input, { idFactory: this.idFactory, now: this.now }))
      .returningAll()
      .executeTakeFirstOrThrow();
    return mapAdminAuditRow(row);
  }

  async listRecent(limit = 1000): Promise<readonly AdminAuditRecord[]> {
    const rows = await this.db
      .selectFrom("admin_audits")
      .selectAll()
      .orderBy("created_at", "desc")
      .limit(Math.max(1, limit))
      .execute();
    return rows.map(mapAdminAuditRow);
  }

  async query(filter: AdminAuditQueryFilter = {}): Promise<AdminAuditQueryPage> {
    const limit = Math.max(1, filter.limit ?? 50);
    const offset = Math.max(0, filter.offset ?? 0);
    let listing = this.db.selectFrom("admin_audits").selectAll();
    let counter = this.db.selectFrom("admin_audits").select((eb) => eb.fn.countAll().as("total"));
    if (filter.category) {
      listing = listing.where("category", "=", filter.category.toLowerCase());
      counter = counter.where("category", "=", filter.category.toLowerCase());
    }
    if (filter.action) {
      listing = listing.where("action", "=", filter.action.toUpperCase());
      counter = counter.where("action", "=", filter.action.toUpperCase());
    }
    const rows = await listing.orderBy("created_at", "desc").limit(limit).offset(offset).execute();
    const totalRow = await counter.executeTakeFirst();
    const total = totalRow ? Number(totalRow.total ?? 0) : 0;
    return {
      items: rows.map(mapAdminAuditRow),
      total: Number.isFinite(total) ? total : 0
    };
  }
}

export class InMemoryMetricAuditEventStore implements MetricAuditEventStore {
  private readonly events: MetricAuditEvent[] = [];
  private readonly idFactory: () => string;
  private readonly maxEvents: number;
  private readonly now: () => Date;

  constructor(options: {
    readonly idFactory?: () => string;
    readonly maxEvents?: number;
    readonly now?: () => Date;
  } = {}) {
    this.idFactory = options.idFactory ?? (() => createRunId("metric_event"));
    this.maxEvents = Math.max(1, options.maxEvents ?? 50_000);
    this.now = options.now ?? (() => new Date());
  }

  record(input: MetricAuditEventInput): MetricAuditEvent {
    const event: MetricAuditEvent = {
      createdAt: this.now(),
      id: input.id ?? this.idFactory(),
      kind: input.kind,
      payload: input.payload
    };

    this.events.push(event);

    while (this.events.length > this.maxEvents) {
      this.events.shift();
    }

    return event;
  }

  listRecent(limit = 1000): readonly MetricAuditEvent[] {
    return [...this.events]
      .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())
      .slice(0, Math.max(1, limit));
  }
}

export class KyselyMetricAuditEventStore implements MetricAuditEventStore {
  private readonly idFactory: () => string;
  private readonly now: () => Date;

  constructor(
    private readonly db: Kysely<MuseDatabase>,
    options: { readonly idFactory?: () => string; readonly now?: () => Date } = {}
  ) {
    this.idFactory = options.idFactory ?? (() => createRunId("metric_event"));
    this.now = options.now ?? (() => new Date());
  }

  async record(input: MetricAuditEventInput): Promise<MetricAuditEvent> {
    const event: MetricAuditEvent = {
      createdAt: this.now(),
      id: input.id ?? this.idFactory(),
      kind: input.kind,
      payload: input.payload
    };

    await this.db
      .insertInto("metric_audit_trail")
      .values(createMetricAuditTrailInsert(event))
      .executeTakeFirstOrThrow();

    return event;
  }

  async listRecent(limit = 1000): Promise<readonly MetricAuditEvent[]> {
    const rows = await this.db
      .selectFrom("metric_audit_trail")
      .selectAll()
      .orderBy("time", "desc")
      .limit(Math.max(1, limit))
      .execute();
    return rows.map(mapMetricAuditTrailRow);
  }
}

export class KyselyAdminOperationsStore implements AdminOperationsStore {
  private readonly idFactory: (kind: "alert" | "slo" | "cost_usage") => string;
  private readonly now: () => Date;

  constructor(
    private readonly db: Kysely<MuseDatabase>,
    options: KyselyAdminOperationsStoreOptions = {}
  ) {
    this.idFactory = options.idFactory ?? ((kind) => createRunId(kind));
    this.now = options.now ?? (() => new Date());
  }

  async listAlerts(): Promise<readonly AdminAlert[]> {
    const rows = await this.db
      .selectFrom("admin_alerts")
      .selectAll()
      .orderBy("created_at", "desc")
      .execute();
    return rows.map(mapAdminAlertRow);
  }

  async createAlert(input: AdminAlertInput): Promise<AdminAlert> {
    const row = await this.db
      .insertInto("admin_alerts")
      .values(createAdminAlertInsert(input, {
        idFactory: this.idFactory,
        now: this.now
      }))
      .returningAll()
      .executeTakeFirstOrThrow();

    return mapAdminAlertRow(row);
  }

  async resolveAlert(id: string): Promise<AdminAlert | undefined> {
    const row = await this.db
      .updateTable("admin_alerts")
      .set({
        status: "resolved"
      })
      .where("id", "=", id)
      .returningAll()
      .executeTakeFirst();

    return row ? mapAdminAlertRow(row) : undefined;
  }

  async listSlos(): Promise<readonly AdminSlo[]> {
    const rows = await this.db.selectFrom("admin_slos").selectAll().orderBy("id", "asc").execute();
    return rows.map(mapAdminSloRow);
  }

  async upsertSlo(input: AdminSloInput): Promise<AdminSlo> {
    const row = createAdminSloInsert(input, {
      idFactory: this.idFactory,
      now: this.now
    });
    const saved = await this.db
      .insertInto("admin_slos")
      .values(row)
      .onConflict((oc) =>
        oc.column("id").doUpdateSet({
          actual: row.actual,
          name: row.name,
          status: row.status,
          target: row.target,
          updated_at: row.updated_at,
          window: row.window
        })
      )
      .returningAll()
      .executeTakeFirstOrThrow();

    return mapAdminSloRow(saved);
  }

  async recordCost(input: AdminCostUsage): Promise<AdminCostSummary> {
    await this.db
      .insertInto("admin_cost_usage")
      .values(createAdminCostUsageInsert(input, {
        idFactory: this.idFactory,
        now: this.now
      }))
      .executeTakeFirstOrThrow();

    return this.costSummary();
  }

  async costSummary(): Promise<AdminCostSummary> {
    const [total, byModel] = await Promise.all([
      this.costTotal(),
      this.costBy("model")
    ]);

    return {
      byModel,
      totalCostUsd: total
    };
  }

  private async costTotal(): Promise<string> {
    const row = await this.db
      .selectFrom("admin_cost_usage")
      .select((eb) => eb.fn.sum<string>("cost_usd").as("cost"))
      .executeTakeFirst();

    return formatCost(Number(row?.cost ?? 0));
  }

  private async costBy(column: "model"): Promise<Readonly<Record<string, string>>> {
    const rows = await this.db
      .selectFrom("admin_cost_usage")
      .select(column)
      .select((eb) => eb.fn.sum<string>("cost_usd").as("cost"))
      .groupBy(column)
      .execute();

    return Object.fromEntries(rows.map((row) => [String(row[column] ?? "unknown"), formatCost(Number(row.cost ?? 0))]));
  }
}

export function createAdminAlertInsert(
  input: AdminAlertInput,
  options: Required<KyselyAdminOperationsStoreOptions>
): AdminAlertInsert {
  return {
    acknowledged_at: null,
    created_at: options.now(),
    id: input.id ?? options.idFactory("alert"),
    message: input.message,
    severity: input.severity ?? "warning",
    status: "open",
    target: input.target ?? null
  };
}

export function createAdminSloInsert(
  input: AdminSloInput,
  options: Required<KyselyAdminOperationsStoreOptions>
): AdminSloInsert {
  return {
    actual: input.actual ?? null,
    id: input.id ?? options.idFactory("slo"),
    name: input.name,
    status: calculateSloStatus(input.target, input.actual),
    target: input.target,
    updated_at: options.now(),
    window: input.window
  };
}

export function createAdminCostUsageInsert(
  input: AdminCostUsage,
  options: Required<KyselyAdminOperationsStoreOptions>
): AdminCostUsageInsert {
  return {
    cost_usd: input.costUsd,
    created_at: options.now(),
    id: options.idFactory("cost_usage"),
    model: input.model ?? null,
    tenant_id: null
  };
}

export function mapAdminAlertRow(row: AdminAlertRow): AdminAlert {
  return {
    createdAt: toDate(row.created_at ?? new Date(0)),
    id: row.id,
    message: row.message,
    severity: row.severity,
    status: row.status === "acknowledged" ? "open" : row.status,
    target: row.target ?? undefined
  };
}

export function mapAdminSloRow(row: AdminSloRow): AdminSlo {
  return {
    actual: row.actual ?? undefined,
    id: row.id,
    name: row.name,
    status: row.status,
    target: row.target,
    updatedAt: toDate(row.updated_at),
    window: row.window
  };
}

export function mapAdminCostUsageRow(row: AdminCostUsageRow): AdminCostUsage {
  return {
    costUsd: row.cost_usd,
    model: row.model ?? undefined
  };
}

export function createAdminAuditInsert(
  input: AdminAuditInput,
  options: { readonly idFactory: () => string; readonly now: () => Date }
): AdminAuditInsert {
  return {
    action: input.action.toUpperCase(),
    actor: input.actor,
    category: input.category,
    created_at: options.now(),
    detail: input.detail ?? null,
    id: input.id ?? options.idFactory(),
    resource_id: input.resourceId ?? null,
    resource_type: input.resourceType ?? null
  };
}

export function mapAdminAuditRow(row: AdminAuditRow | AdminAuditInsert): AdminAuditRecord {
  return {
    action: row.action.toUpperCase(),
    actor: row.actor,
    category: row.category,
    createdAt: toDate(row.created_at ?? new Date(0)),
    detail: row.detail ?? null,
    id: row.id,
    resourceId: row.resource_id ?? null,
    resourceType: row.resource_type ?? null
  };
}

export function createMetricAuditTrailInsert(event: MetricAuditEvent): MetricAuditTrailInsert {
  return {
    actor_email: null,
    actor_id: null,
    detail: event.payload,
    event_type: event.kind,
    resource_id: event.id,
    resource_type: "metric_event",
    source_ip: null,
    tenant_id: "default",
    time: event.createdAt
  };
}

export function mapMetricAuditTrailRow(row: MetricAuditTrailRow | MetricAuditTrailInsert): MetricAuditEvent {
  return {
    createdAt: toDate(row.time ?? new Date(0)),
    id: row.resource_id ?? createRunId("metric_event"),
    kind: row.event_type,
    payload: jsonObject(row.detail)
  };
}

function calculateSloStatus(target: number, actual: number | undefined): AdminSloStatus {
  if (actual === undefined || actual >= target) {
    return "healthy";
  }

  return actual >= target * 0.95 ? "at_risk" : "violated";
}

function sumCostsByModel(items: readonly AdminCostUsage[]): Readonly<Record<string, string>> {
  const sums = new Map<string, number>();

  for (const item of items) {
    const value = item.model ?? "unknown";
    sums.set(value, (sums.get(value) ?? 0) + Number(item.costUsd));
  }

  return Object.fromEntries([...sums.entries()].map(([name, value]) => [name, formatCost(value)]));
}

function formatCost(value: number): string {
  return Number.isFinite(value) ? value.toFixed(8) : "0.00000000";
}

function compareById(left: { readonly id: string }, right: { readonly id: string }): number {
  return left.id.localeCompare(right.id);
}

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function trimOldestMap<K, V>(map: Map<K, V>, maxSize: number): void {
  while (map.size > maxSize) {
    const oldest = map.keys().next().value as K | undefined;

    if (oldest === undefined) {
      return;
    }

    map.delete(oldest);
  }
}

function jsonObject(value: unknown): JsonObject {
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      return jsonObject(parsed);
    } catch {
      return {};
    }
  }

  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}
