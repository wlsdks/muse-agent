import type {
  AdminAlertTable,
  AdminCostUsageTable,
  AdminSloTable,
  AdminTenantTable,
  MuseDatabase
} from "@muse/db";
import { createRunId } from "@muse/shared";
import type { Insertable, Kysely, Selectable } from "kysely";

type Awaitable<T> = T | Promise<T>;

export type AdminTenantStatus = "active" | "suspended" | "disabled";
export type AdminAlertSeverity = "info" | "warning" | "critical";
export type AdminAlertStatus = "open" | "acknowledged" | "resolved";
export type AdminSloStatus = "healthy" | "at_risk" | "violated";

export interface AdminTenant {
  readonly id: string;
  readonly name: string;
  readonly status: AdminTenantStatus;
  readonly monthlyBudgetUsd?: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface AdminAlert {
  readonly id: string;
  readonly severity: AdminAlertSeverity;
  readonly status: AdminAlertStatus;
  readonly message: string;
  readonly target?: string;
  readonly createdAt: Date;
  readonly acknowledgedAt?: Date;
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
  readonly tenantId?: string;
  readonly model?: string;
  readonly costUsd: string;
}

export interface AdminCostSummary {
  readonly totalCostUsd: string;
  readonly byModel: Readonly<Record<string, string>>;
  readonly byTenant: Readonly<Record<string, string>>;
}

export interface AdminOperationsStore {
  listTenants(): Awaitable<readonly AdminTenant[]>;
  upsertTenant(input: AdminTenantInput): Awaitable<AdminTenant>;
  listAlerts(): Awaitable<readonly AdminAlert[]>;
  createAlert(input: AdminAlertInput): Awaitable<AdminAlert>;
  acknowledgeAlert(id: string): Awaitable<AdminAlert | undefined>;
  listSlos(): Awaitable<readonly AdminSlo[]>;
  upsertSlo(input: AdminSloInput): Awaitable<AdminSlo>;
  recordCost(input: AdminCostUsage): Awaitable<AdminCostSummary>;
  costSummary(): Awaitable<AdminCostSummary>;
}

export interface AdminTenantInput {
  readonly id?: string;
  readonly name: string;
  readonly status?: AdminTenantStatus;
  readonly monthlyBudgetUsd?: string;
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
  readonly idFactory?: (kind: "tenant" | "alert" | "slo") => string;
  readonly now?: () => Date;
}

export interface KyselyAdminOperationsStoreOptions {
  readonly idFactory?: (kind: "tenant" | "alert" | "slo" | "cost_usage") => string;
  readonly now?: () => Date;
}

type AdminTenantRow = Selectable<AdminTenantTable>;
type AdminAlertRow = Selectable<AdminAlertTable>;
type AdminSloRow = Selectable<AdminSloTable>;
type AdminCostUsageRow = Selectable<AdminCostUsageTable>;
type AdminTenantInsert = Insertable<AdminTenantTable>;
type AdminAlertInsert = Insertable<AdminAlertTable>;
type AdminSloInsert = Insertable<AdminSloTable>;
type AdminCostUsageInsert = Insertable<AdminCostUsageTable>;

export class InMemoryAdminOperationsStore implements AdminOperationsStore {
  private readonly idFactory: (kind: "tenant" | "alert" | "slo") => string;
  private readonly now: () => Date;
  private readonly tenants = new Map<string, AdminTenant>();
  private readonly alerts = new Map<string, AdminAlert>();
  private readonly slos = new Map<string, AdminSlo>();
  private readonly costs: AdminCostUsage[] = [];

  constructor(options: InMemoryAdminOperationsStoreOptions = {}) {
    this.idFactory = options.idFactory ?? ((kind) => createRunId(kind));
    this.now = options.now ?? (() => new Date());
  }

  listTenants(): readonly AdminTenant[] {
    return [...this.tenants.values()].sort(compareById);
  }

  upsertTenant(input: AdminTenantInput): AdminTenant {
    const id = input.id ?? this.idFactory("tenant");
    const existing = this.tenants.get(id);
    const tenant: AdminTenant = {
      createdAt: existing?.createdAt ?? this.now(),
      id,
      ...(input.monthlyBudgetUsd ? { monthlyBudgetUsd: input.monthlyBudgetUsd } : {}),
      name: input.name,
      status: input.status ?? existing?.status ?? "active",
      updatedAt: this.now()
    };

    this.tenants.set(id, tenant);
    return tenant;
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

  acknowledgeAlert(id: string): AdminAlert | undefined {
    const existing = this.alerts.get(id);

    if (!existing) {
      return undefined;
    }

    const updated: AdminAlert = {
      ...existing,
      acknowledgedAt: this.now(),
      status: "acknowledged"
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
      byModel: sumCosts(this.costs, "model"),
      byTenant: sumCosts(this.costs, "tenantId"),
      totalCostUsd: formatCost(this.costs.reduce((sum, item) => sum + Number(item.costUsd), 0))
    };
  }
}

export class KyselyAdminOperationsStore implements AdminOperationsStore {
  private readonly idFactory: (kind: "tenant" | "alert" | "slo" | "cost_usage") => string;
  private readonly now: () => Date;

  constructor(
    private readonly db: Kysely<MuseDatabase>,
    options: KyselyAdminOperationsStoreOptions = {}
  ) {
    this.idFactory = options.idFactory ?? ((kind) => createRunId(kind));
    this.now = options.now ?? (() => new Date());
  }

  async listTenants(): Promise<readonly AdminTenant[]> {
    const rows = await this.db.selectFrom("admin_tenants").selectAll().orderBy("id", "asc").execute();
    return rows.map(mapAdminTenantRow);
  }

  async upsertTenant(input: AdminTenantInput): Promise<AdminTenant> {
    const row = createAdminTenantInsert(input, {
      idFactory: this.idFactory,
      now: this.now
    });
    const saved = await this.db
      .insertInto("admin_tenants")
      .values(row)
      .onConflict((oc) =>
        oc.column("id").doUpdateSet({
          monthly_budget_usd: row.monthly_budget_usd,
          name: row.name,
          status: row.status,
          updated_at: row.updated_at
        })
      )
      .returningAll()
      .executeTakeFirstOrThrow();

    return mapAdminTenantRow(saved);
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

  async acknowledgeAlert(id: string): Promise<AdminAlert | undefined> {
    const row = await this.db
      .updateTable("admin_alerts")
      .set({
        acknowledged_at: this.now(),
        status: "acknowledged"
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
    const [total, byModel, byTenant] = await Promise.all([
      this.costTotal(),
      this.costBy("model"),
      this.costBy("tenant_id")
    ]);

    return {
      byModel,
      byTenant,
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

  private async costBy(column: "model" | "tenant_id"): Promise<Readonly<Record<string, string>>> {
    const rows = await this.db
      .selectFrom("admin_cost_usage")
      .select(column)
      .select((eb) => eb.fn.sum<string>("cost_usd").as("cost"))
      .groupBy(column)
      .execute();

    return Object.fromEntries(rows.map((row) => [String(row[column] ?? "unknown"), formatCost(Number(row.cost ?? 0))]));
  }
}

export function createAdminTenantInsert(
  input: AdminTenantInput,
  options: Required<KyselyAdminOperationsStoreOptions>
): AdminTenantInsert {
  const now = options.now();

  return {
    created_at: now,
    id: input.id ?? options.idFactory("tenant"),
    monthly_budget_usd: input.monthlyBudgetUsd ?? null,
    name: input.name,
    status: input.status ?? "active",
    updated_at: now
  };
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
    tenant_id: input.tenantId ?? null
  };
}

export function mapAdminTenantRow(row: AdminTenantRow): AdminTenant {
  return {
    createdAt: toDate(row.created_at),
    id: row.id,
    monthlyBudgetUsd: row.monthly_budget_usd ?? undefined,
    name: row.name,
    status: row.status,
    updatedAt: toDate(row.updated_at)
  };
}

export function mapAdminAlertRow(row: AdminAlertRow): AdminAlert {
  return {
    acknowledgedAt: row.acknowledged_at ? toDate(row.acknowledged_at) : undefined,
    createdAt: toDate(row.created_at),
    id: row.id,
    message: row.message,
    severity: row.severity,
    status: row.status,
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
    model: row.model ?? undefined,
    tenantId: row.tenant_id ?? undefined
  };
}

function calculateSloStatus(target: number, actual: number | undefined): AdminSloStatus {
  if (actual === undefined || actual >= target) {
    return "healthy";
  }

  return actual >= target * 0.95 ? "at_risk" : "violated";
}

function sumCosts(items: readonly AdminCostUsage[], key: "model" | "tenantId"): Readonly<Record<string, string>> {
  const sums = new Map<string, number>();

  for (const item of items) {
    const value = item[key] ?? "unknown";
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
