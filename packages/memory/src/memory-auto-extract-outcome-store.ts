/**
 * Privacy-minimal terminal outcomes for automatic user-memory extraction.
 *
 * This diagnostic sidecar deliberately stores no user id, prompt, answer,
 * extracted key, or extracted value. It only answers whether an attempted
 * extraction learned something and, when it did not, which terminal class
 * explains the result. The bounded file is the durable substrate used by the
 * later doctor/status health projection.
 */

import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import { dirname } from "node:path";

import { withFileLock, withFileMutationQueue } from "@muse/shared";

export const USER_MEMORY_AUTO_EXTRACT_REASONS = [
  "learned",
  "nothing_new",
  "policy_rejected",
  "model_error",
  "schema_error",
  "store_error",
  "timeout"
] as const;

export type UserMemoryAutoExtractReason = typeof USER_MEMORY_AUTO_EXTRACT_REASONS[number];

export interface UserMemoryAutoExtractOutcome {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly reason: UserMemoryAutoExtractReason;
  readonly recordedAt: string;
}

export interface PersistedUserMemoryAutoExtractOutcome {
  readonly schemaVersion: 1;
  /** Fixed-length correlation token; the raw run id is never persisted. */
  readonly runIdHash: string;
  readonly reason: UserMemoryAutoExtractReason;
  readonly recordedAt: string;
}

export interface UserMemoryAutoExtractOutcomeStore {
  record(outcome: UserMemoryAutoExtractOutcome): Promise<void>;
}

export interface FileUserMemoryAutoExtractOutcomeStoreOptions {
  readonly file: string;
  readonly maxEntries?: number;
}

export const DEFAULT_USER_MEMORY_AUTO_EXTRACT_OUTCOME_MAX_ENTRIES = 256;

/** The health projection never examines more than the sidecar's own cap. */
export const DEFAULT_USER_MEMORY_AUTO_EXTRACT_HEALTH_MAX_INPUT_WINDOW = 256;
/** A success older than this is no longer current health evidence. */
export const DEFAULT_USER_MEMORY_AUTO_EXTRACT_HEALTH_FRESHNESS_MS = 24 * 60 * 60 * 1_000;

export type UserMemoryAutoExtractHealthStatus = "healthy" | "degraded" | "stale" | "no-data";
export type UserMemoryAutoExtractHealthFreshness = "fresh" | "stale" | "no-success";
export type UserMemoryAutoExtractReasonCounts = Readonly<Record<UserMemoryAutoExtractReason, number>>;

/**
 * Privacy-minimal health summary for status/doctor. It intentionally excludes
 * run ids (including hashes), user ids, prompts, and extracted keys/values.
 */
export interface UserMemoryAutoExtractHealthProjection {
  readonly status: UserMemoryAutoExtractHealthStatus;
  readonly freshness: UserMemoryAutoExtractHealthFreshness;
  readonly lastSuccessAt?: string;
  readonly consecutiveFailures: number;
  readonly reasonCounts: UserMemoryAutoExtractReasonCounts;
  readonly sampleSize: number;
}

export interface UserMemoryAutoExtractHealthProjectionOptions {
  readonly nowMs?: number;
  /** Lowering this is useful for embedded callers; it can never exceed 256. */
  readonly maxInputWindow?: number;
  readonly freshnessMs?: number;
}

function isReason(value: unknown): value is UserMemoryAutoExtractReason {
  return USER_MEMORY_AUTO_EXTRACT_REASONS.includes(value as UserMemoryAutoExtractReason);
}

function emptyReasonCounts(): Record<UserMemoryAutoExtractReason, number> {
  return {
    learned: 0,
    model_error: 0,
    nothing_new: 0,
    policy_rejected: 0,
    schema_error: 0,
    store_error: 0,
    timeout: 0
  };
}

function isProjectableOutcome(
  value: unknown
): value is Pick<PersistedUserMemoryAutoExtractOutcome, "reason" | "recordedAt"> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const outcome = value as Partial<Pick<PersistedUserMemoryAutoExtractOutcome, "reason" | "recordedAt">>;
  return isReason(outcome.reason) && typeof outcome.recordedAt === "string" && !Number.isNaN(Date.parse(outcome.recordedAt));
}

/**
 * Pure bounded projection over automatic-extraction terminal outcomes. The sidecar is
 * append-only, so ordering determines the active technical-failure streak.
 * Missing, corrupt, or entirely invalid input becomes no-data, never a throw.
 */
export function projectUserMemoryAutoExtractHealth(
  source: readonly unknown[],
  options: UserMemoryAutoExtractHealthProjectionOptions = {}
): UserMemoryAutoExtractHealthProjection {
  const requestedWindow = options.maxInputWindow ?? DEFAULT_USER_MEMORY_AUTO_EXTRACT_HEALTH_MAX_INPUT_WINDOW;
  const maxInputWindow = Number.isSafeInteger(requestedWindow) && requestedWindow > 0
    ? Math.min(requestedWindow, DEFAULT_USER_MEMORY_AUTO_EXTRACT_HEALTH_MAX_INPUT_WINDOW)
    : DEFAULT_USER_MEMORY_AUTO_EXTRACT_HEALTH_MAX_INPUT_WINDOW;
  const freshnessMs = options.freshnessMs ?? DEFAULT_USER_MEMORY_AUTO_EXTRACT_HEALTH_FRESHNESS_MS;
  const validFreshnessMs = Number.isFinite(freshnessMs) && freshnessMs >= 0
    ? freshnessMs
    : DEFAULT_USER_MEMORY_AUTO_EXTRACT_HEALTH_FRESHNESS_MS;
  const nowMs = options.nowMs ?? Date.now();
  const outcomes = source.slice(-maxInputWindow).filter(isProjectableOutcome);
  const reasonCounts = emptyReasonCounts();
  let lastSuccessAt: string | undefined;
  let lastSuccessMs = Number.NEGATIVE_INFINITY;

  for (const outcome of outcomes) {
    reasonCounts[outcome.reason] += 1;
    if (outcome.reason === "learned") {
      const recordedAtMs = Date.parse(outcome.recordedAt);
      if (recordedAtMs >= lastSuccessMs) {
        lastSuccessMs = recordedAtMs;
        lastSuccessAt = outcome.recordedAt;
      }
    }
  }

  let consecutiveFailures = 0;
  for (let index = outcomes.length - 1; index >= 0; index -= 1) {
    const reason = outcomes[index]!.reason;
    if (reason === "model_error" || reason === "schema_error" || reason === "store_error" || reason === "timeout") {
      consecutiveFailures += 1;
      continue;
    }
    // learned, nothing_new, and policy_rejected reset the technical streak.
    break;
  }

  const freshness: UserMemoryAutoExtractHealthFreshness = lastSuccessAt === undefined
    ? "no-success"
    : nowMs >= lastSuccessMs && nowMs - lastSuccessMs <= validFreshnessMs
      ? "fresh"
      : "stale";
  const status: UserMemoryAutoExtractHealthStatus = outcomes.length === 0
    ? "no-data"
    : consecutiveFailures > 0 || freshness === "no-success"
      ? "degraded"
      : freshness === "stale"
        ? "stale"
        : "healthy";

  return {
    consecutiveFailures,
    freshness,
    ...(lastSuccessAt ? { lastSuccessAt } : {}),
    reasonCounts,
    sampleSize: outcomes.length,
    status
  };
}

function isPersistedOutcome(value: unknown): value is PersistedUserMemoryAutoExtractOutcome {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const outcome = value as Partial<PersistedUserMemoryAutoExtractOutcome>;
  const keys = Object.keys(value);
  return outcome.schemaVersion === 1
    && keys.length === 4
    && keys.every((key) => ["schemaVersion", "runIdHash", "reason", "recordedAt"].includes(key))
    && typeof outcome.runIdHash === "string"
    && /^[a-f0-9]{32}$/u.test(outcome.runIdHash)
    && isReason(outcome.reason)
    && typeof outcome.recordedAt === "string"
    && !Number.isNaN(Date.parse(outcome.recordedAt));
}

export async function readUserMemoryAutoExtractOutcomes(
  file: string
): Promise<readonly PersistedUserMemoryAutoExtractOutcome[]> {
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
    return [];
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];
  const outcomes = (parsed as { outcomes?: unknown }).outcomes;
  if (!Array.isArray(outcomes)) return [];
  return outcomes.flatMap((outcome): readonly PersistedUserMemoryAutoExtractOutcome[] =>
    isPersistedOutcome(outcome) ? [outcome] : []
  );
}

/** Missing or corrupt sidecars deliberately read as no usable diagnostics. */
export async function readUserMemoryAutoExtractHealth(
  file: string,
  options: UserMemoryAutoExtractHealthProjectionOptions = {}
): Promise<UserMemoryAutoExtractHealthProjection> {
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch {
    return projectUserMemoryAutoExtractHealth([], options);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return projectUserMemoryAutoExtractHealth([], options);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return projectUserMemoryAutoExtractHealth([], options);
  }
  const outcomes = (parsed as { outcomes?: unknown }).outcomes;
  if (!Array.isArray(outcomes) || !outcomes.every(isPersistedOutcome)) {
    return projectUserMemoryAutoExtractHealth([], options);
  }
  return projectUserMemoryAutoExtractHealth(outcomes, options);
}

async function writeOutcomes(
  file: string,
  outcomes: readonly PersistedUserMemoryAutoExtractOutcome[]
): Promise<void> {
  await fs.mkdir(dirname(file), { recursive: true });
  const temp = `${file}.tmp-${process.pid.toString()}-${Date.now().toString()}`;
  const handle = await fs.open(temp, "w", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify({ outcomes }, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(temp, file);
  await fs.chmod(file, 0o600).catch(() => undefined);
}

export class FileUserMemoryAutoExtractOutcomeStore implements UserMemoryAutoExtractOutcomeStore {
  private readonly file: string;
  private readonly maxEntries: number;

  constructor(options: FileUserMemoryAutoExtractOutcomeStoreOptions) {
    if (!options.file.trim()) {
      throw new RangeError("file must be non-empty");
    }
    const maxEntries = options.maxEntries ?? DEFAULT_USER_MEMORY_AUTO_EXTRACT_OUTCOME_MAX_ENTRIES;
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) {
      throw new RangeError("maxEntries must be a positive safe integer");
    }
    this.file = options.file;
    this.maxEntries = maxEntries;
  }

  async record(outcome: UserMemoryAutoExtractOutcome): Promise<void> {
    if (
      outcome.schemaVersion !== 1
      || !outcome.runId
      || !isReason(outcome.reason)
      || Number.isNaN(Date.parse(outcome.recordedAt))
    ) {
      throw new TypeError("invalid user-memory auto-extract outcome");
    }
    const persisted: PersistedUserMemoryAutoExtractOutcome = {
      reason: outcome.reason,
      recordedAt: outcome.recordedAt,
      runIdHash: createHash("sha256").update(outcome.runId).digest("hex").slice(0, 32),
      schemaVersion: 1
    };
    await withFileMutationQueue(this.file, () => withFileLock(this.file, async () => {
      const current = await readUserMemoryAutoExtractOutcomes(this.file);
      await writeOutcomes(this.file, [...current, persisted].slice(-this.maxEntries));
    }));
  }
}
