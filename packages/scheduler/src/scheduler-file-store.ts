/**
 * File-backed `ScheduledJobStore` (`~/.muse/scheduled-jobs.json`) — the CLI
 * (and any API-server process with no Postgres configured) gets a real
 * persistent scheduler store instead of `InMemoryScheduledJobStore`, which
 * is empty at the start of every process and loses every `muse scheduler
 * add`-created job on restart.
 *
 * Delegates ALL business rules (normalize, name-dedup, id generation,
 * maxJobs eviction) to a freshly-hydrated `InMemoryScheduledJobStore` per
 * call and persists its full job list afterward — the file itself never
 * encodes any scheduler semantics of its own. Mirrors `FileTaskMemoryStore`
 * (`@muse/memory`).
 *
 * Durability idioms match the personal sidecar stores in `@muse/stores`:
 * atomic rename-based write (`atomicWriteFile`), a cross-process file lock
 * around every read-modify-write (`withFileLock` — the CLI's one-shot
 * `muse scheduler add` and a running `muse daemon`'s tick are separate
 * processes reading/writing the SAME file), and fail-soft-to-empty +
 * quarantine on a corrupt file (`quarantineCorruptStore`) rather than a
 * crash.
 */

import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { JsonObject, JsonValue } from "@muse/shared";
import { atomicWriteFile, quarantineCorruptStore, withFileLock } from "@muse/stores";

import type {
  InMemoryScheduledJobStoreOptions,
  JobExecutionStatus,
  ScheduledJob,
  ScheduledJobInput,
  ScheduledJobStore,
  ScheduledJobUpdateInput,
  ScheduledJobType
} from "./index.js";
import { InMemoryScheduledJobStore } from "./scheduler-stores.js";

export function defaultScheduledJobsFile(env: Readonly<Record<string, string | undefined>> = process.env): string {
  const fromEnv = env.MUSE_SCHEDULED_JOBS_FILE?.trim();
  return fromEnv && fromEnv.length > 0 ? fromEnv : join(homedir(), ".muse", "scheduled-jobs.json");
}

async function readScheduledJobs(file: string): Promise<readonly ScheduledJob[]> {
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch {
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    await quarantineCorruptStore(file);
    return [];
  }

  if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as { jobs?: unknown }).jobs)) {
    await quarantineCorruptStore(file);
    return [];
  }

  return (parsed as { jobs: readonly unknown[] }).jobs.flatMap((entry): readonly ScheduledJob[] => {
    const job = reviveScheduledJob(entry);
    return job ? [job] : [];
  });
}

async function writeScheduledJobs(file: string, jobs: readonly ScheduledJob[]): Promise<void> {
  // `Date` serializes to an ISO string via its own `toJSON` — no manual
  // date-to-string conversion needed on the write side, only on revive.
  const payload = `${JSON.stringify({ jobs }, null, 2)}\n`;
  await atomicWriteFile(file, payload);
}

function reviveDate(value: unknown): Date | undefined {
  if (typeof value !== "string" || value.trim().length === 0) {
    return undefined;
  }
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : undefined;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function toJsonObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : {};
}

/**
 * Reconstruct one `ScheduledJob` from a raw parsed JSON entry, or `undefined`
 * when the entry is missing a required field / has an unparseable date — a
 * hand-edited or otherwise malformed single entry is DROPPED, not fatal to
 * the whole file (mirrors `isPersistedReminder`'s per-entry fail-soft).
 */
function reviveScheduledJob(raw: unknown): ScheduledJob | undefined {
  if (!raw || typeof raw !== "object") {
    return undefined;
  }
  const r = raw as Record<string, unknown>;

  if (typeof r.id !== "string" || r.id.length === 0) return undefined;
  if (typeof r.name !== "string" || r.name.length === 0) return undefined;
  if (typeof r.cronExpression !== "string" || r.cronExpression.length === 0) return undefined;
  if (typeof r.timezone !== "string" || r.timezone.length === 0) return undefined;
  if (r.jobType !== "agent" && r.jobType !== "mcp_tool") return undefined;

  const createdAt = reviveDate(r.createdAt);
  const updatedAt = reviveDate(r.updatedAt);
  if (!createdAt || !updatedAt) return undefined;

  const lastRunAt = r.lastRunAt !== undefined ? reviveDate(r.lastRunAt) : undefined;
  const lastStatus = r.lastStatus;
  const validLastStatus: JobExecutionStatus | undefined =
    lastStatus === "success" || lastStatus === "failed" || lastStatus === "running" || lastStatus === "skipped"
      ? lastStatus
      : undefined;

  return {
    agentMaxToolCalls: optionalNumber(r.agentMaxToolCalls),
    agentModel: optionalString(r.agentModel),
    agentPrompt: optionalString(r.agentPrompt),
    agentSystemPrompt: optionalString(r.agentSystemPrompt),
    createdAt,
    cronExpression: r.cronExpression,
    description: optionalString(r.description),
    enabled: typeof r.enabled === "boolean" ? r.enabled : true,
    executionTimeoutMs: optionalNumber(r.executionTimeoutMs),
    id: r.id,
    jobType: r.jobType as ScheduledJobType,
    lastResult: optionalString(r.lastResult),
    lastRunAt,
    lastStatus: validLastStatus,
    maxRetryCount: optionalNumber(r.maxRetryCount) ?? 3,
    mcpServerName: optionalString(r.mcpServerName),
    name: r.name,
    notificationChannelId: optionalString(r.notificationChannelId),
    personaId: optionalString(r.personaId),
    retryOnFailure: typeof r.retryOnFailure === "boolean" ? r.retryOnFailure : false,
    tags: Array.isArray(r.tags) ? r.tags.filter((tag): tag is string => typeof tag === "string") : [],
    timezone: r.timezone,
    toolArguments: toJsonObject(r.toolArguments as JsonValue),
    toolName: optionalString(r.toolName),
    updatedAt,
    webhookUrl: optionalString(r.webhookUrl)
  };
}

export interface FileScheduledJobStoreOptions extends InMemoryScheduledJobStoreOptions {
  readonly file?: string;
}

export class FileScheduledJobStore implements ScheduledJobStore {
  private readonly file: string;
  private readonly memOptions: InMemoryScheduledJobStoreOptions;

  constructor(options: FileScheduledJobStoreOptions = {}) {
    this.file = options.file && options.file.trim().length > 0 ? options.file : defaultScheduledJobsFile();
    this.memOptions = {
      ...(options.idFactory ? { idFactory: options.idFactory } : {}),
      ...(options.maxJobs !== undefined ? { maxJobs: options.maxJobs } : {}),
      ...(options.now ? { now: options.now } : {})
    };
  }

  private async hydrate(): Promise<InMemoryScheduledJobStore> {
    const mem = new InMemoryScheduledJobStore(this.memOptions);
    mem.restore(await readScheduledJobs(this.file));
    return mem;
  }

  async list(): Promise<readonly ScheduledJob[]> {
    return (await this.hydrate()).list();
  }

  async findById(id: string): Promise<ScheduledJob | undefined> {
    return (await this.hydrate()).findById(id);
  }

  async findByName(name: string): Promise<ScheduledJob | undefined> {
    return (await this.hydrate()).findByName(name);
  }

  async save(input: ScheduledJobInput): Promise<ScheduledJob> {
    return withFileLock(this.file, async () => {
      const mem = await this.hydrate();
      const saved = mem.save(input);
      await writeScheduledJobs(this.file, mem.list());
      return saved;
    });
  }

  async update(id: string, input: ScheduledJobUpdateInput): Promise<ScheduledJob | undefined> {
    return withFileLock(this.file, async () => {
      const mem = await this.hydrate();
      const updated = mem.update(id, input);
      if (updated) {
        await writeScheduledJobs(this.file, mem.list());
      }
      return updated;
    });
  }

  async delete(id: string): Promise<void> {
    return withFileLock(this.file, async () => {
      const mem = await this.hydrate();
      mem.delete(id);
      await writeScheduledJobs(this.file, mem.list());
    });
  }

  async updateExecutionResult(id: string, status: JobExecutionStatus, result?: string | null): Promise<void> {
    return withFileLock(this.file, async () => {
      const mem = await this.hydrate();
      mem.updateExecutionResult(id, status, result);
      await writeScheduledJobs(this.file, mem.list());
    });
  }
}
