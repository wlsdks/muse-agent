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

function isReason(value: unknown): value is UserMemoryAutoExtractReason {
  return USER_MEMORY_AUTO_EXTRACT_REASONS.includes(value as UserMemoryAutoExtractReason);
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
