import { constants as fsConstants, promises as fs } from "node:fs";

import {
  atomicWriteFile,
  withFileLock,
  withFileMutationQueue
} from "./atomic-file-store.js";

export const QUALIFICATION_LEARNING_HOLD_SCHEMA_VERSION = 1 as const;
export const QUALIFICATION_LEARNING_HOLD_REASON = "personal-agent-qualification" as const;

export interface QualificationLearningHoldRecord {
  readonly active: true;
  readonly activatedAt: string;
  readonly holdId: string;
  readonly reason: typeof QUALIFICATION_LEARNING_HOLD_REASON;
  readonly schemaVersion: typeof QUALIFICATION_LEARNING_HOLD_SCHEMA_VERSION;
}

export type QualificationLearningHoldFailure =
  | "invalid-json"
  | "invalid-schema"
  | "unreadable"
  | "unsafe-file-type"
  | "unsafe-permissions";

export type QualificationLearningHoldInspection =
  | { readonly engaged: false; readonly state: "inactive" }
  | { readonly engaged: true; readonly record: QualificationLearningHoldRecord; readonly state: "active" }
  | {
      readonly engaged: true;
      readonly failure: QualificationLearningHoldFailure;
      readonly state: "invalid";
    };

const HOLD_ID_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/u;
const EXACT_KEYS = ["active", "activatedAt", "holdId", "reason", "schemaVersion"] as const;

function canonicalIso(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function isRecord(value: unknown): value is QualificationLearningHoldRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return keys.length === EXACT_KEYS.length
    && keys.every((key, index) => key === [...EXACT_KEYS].sort()[index])
    && record.active === true
    && canonicalIso(record.activatedAt)
    && typeof record.holdId === "string"
    && HOLD_ID_PATTERN.test(record.holdId)
    && record.reason === QUALIFICATION_LEARNING_HOLD_REASON
    && record.schemaVersion === QUALIFICATION_LEARNING_HOLD_SCHEMA_VERSION;
}

export async function inspectQualificationLearningHold(
  file: string
): Promise<QualificationLearningHoldInspection> {
  let pathStat: Awaited<ReturnType<typeof fs.lstat>>;
  try {
    pathStat = await fs.lstat(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { engaged: false, state: "inactive" };
    }
    return { engaged: true, failure: "unreadable", state: "invalid" };
  }
  if (pathStat.isSymbolicLink() || !pathStat.isFile() || pathStat.nlink !== 1) {
    return { engaged: true, failure: "unsafe-file-type", state: "invalid" };
  }
  if (
    process.platform !== "win32"
    && (
      (pathStat.mode & 0o077) !== 0
      || (
        typeof process.getuid === "function"
        && pathStat.uid !== process.getuid()
      )
    )
  ) {
    return { engaged: true, failure: "unsafe-permissions", state: "invalid" };
  }
  let raw: string;
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const openedStat = await handle.stat();
    if (
      !openedStat.isFile()
      || openedStat.nlink !== 1
      || openedStat.dev !== pathStat.dev
      || openedStat.ino !== pathStat.ino
    ) {
      return { engaged: true, failure: "unsafe-file-type", state: "invalid" };
    }
    if (
      process.platform !== "win32"
      && (
        (openedStat.mode & 0o077) !== 0
        || (
          typeof process.getuid === "function"
          && openedStat.uid !== process.getuid()
        )
      )
    ) {
      return { engaged: true, failure: "unsafe-permissions", state: "invalid" };
    }
    raw = await handle.readFile("utf8");
  } catch {
    return { engaged: true, failure: "unreadable", state: "invalid" };
  } finally {
    await handle?.close().catch(() => undefined);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { engaged: true, failure: "invalid-json", state: "invalid" };
  }
  return isRecord(parsed)
    ? { engaged: true, record: parsed, state: "active" }
    : { engaged: true, failure: "invalid-schema", state: "invalid" };
}

export async function activateQualificationLearningHold(
  file: string,
  input: { readonly activatedAt: string; readonly holdId: string }
): Promise<QualificationLearningHoldRecord> {
  if (!canonicalIso(input.activatedAt)) {
    throw new TypeError("qualification learning hold activatedAt must be canonical ISO-8601");
  }
  if (!HOLD_ID_PATTERN.test(input.holdId)) {
    throw new TypeError("qualification learning hold id must be 1-64 lowercase ASCII identifier characters");
  }
  return withFileMutationQueue(file, () => withFileLock(file, async () => {
    const existing = await inspectQualificationLearningHold(file);
    if (existing.state === "active") {
      if (existing.record.holdId !== input.holdId) {
        throw new Error(`qualification learning hold '${existing.record.holdId}' is already active`);
      }
      return existing.record;
    }
    if (existing.state === "invalid") {
      throw new Error(`qualification learning hold is fail-closed (${existing.failure}); repair it before activation`);
    }
    const record: QualificationLearningHoldRecord = {
      active: true,
      activatedAt: input.activatedAt,
      holdId: input.holdId,
      reason: QUALIFICATION_LEARNING_HOLD_REASON,
      schemaVersion: QUALIFICATION_LEARNING_HOLD_SCHEMA_VERSION
    };
    await atomicWriteFile(file, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
    return record;
  }));
}
