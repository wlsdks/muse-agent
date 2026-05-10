import type {
  AdminAlertTable,
  AdminCostUsageTable,
  MuseDatabase
} from "@muse/db";
import { createRunId } from "@muse/shared";
import type { Insertable, Kysely, Selectable } from "kysely";

type Awaitable<T> = T | Promise<T>;

export type AdminAlertSeverity = "info" | "warning" | "critical";
export type AdminAlertStatus = "open" | "resolved";

export interface AdminAlert {
  readonly id: string;
  readonly severity: AdminAlertSeverity;
  readonly status: AdminAlertStatus;
  readonly message: string;
  readonly createdAt: Date;
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
  recordCost(input: AdminCostUsage): Awaitable<AdminCostSummary>;
  costSummary(): Awaitable<AdminCostSummary>;
}

export interface AdminAlertInput {
  readonly id?: string;
  readonly severity?: AdminAlertSeverity;
  readonly message: string;
}

export interface InMemoryAdminOperationsStoreOptions {
  readonly idFactory?: (kind: "alert") => string;
  readonly now?: () => Date;
}

export interface KyselyAdminOperationsStoreOptions {
  readonly idFactory?: (kind: "alert" | "cost_usage") => string;
  readonly now?: () => Date;
}

type AdminAlertRow = Selectable<AdminAlertTable>;
type AdminCostUsageRow = Selectable<AdminCostUsageTable>;
type AdminAlertInsert = Insertable<AdminAlertTable>;
type AdminCostUsageInsert = Insertable<AdminCostUsageTable>;

export class InMemoryAdminOperationsStore implements AdminOperationsStore {
  private readonly idFactory: (kind: "alert") => string;
  private readonly now: () => Date;
  private readonly alerts = new Map<string, AdminAlert>();
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
      status: "open"
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

export class KyselyAdminOperationsStore implements AdminOperationsStore {
  private readonly idFactory: (kind: "alert" | "cost_usage") => string;
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
    status: "open"
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
    model: input.model ?? null
  };
}

export function mapAdminAlertRow(row: AdminAlertRow): AdminAlert {
  return {
    createdAt: toDate(row.created_at ?? new Date(0)),
    id: row.id,
    message: row.message,
    severity: row.severity,
    status: row.status === "acknowledged" ? "open" : row.status
  };
}

export function mapAdminCostUsageRow(row: AdminCostUsageRow): AdminCostUsage {
  return {
    costUsd: row.cost_usd,
    model: row.model ?? undefined
  };
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

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}
