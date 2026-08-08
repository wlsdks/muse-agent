/**
 * Durable, non-authoritative usage telemetry for authored skills.
 *
 * This sidecar deliberately stays separate from SKILL.md and the reward
 * sidecar: usage is evidence about selection/read activity, not skill content
 * or owner feedback. Every read-modify-write is protected by both the local
 * mutation queue and the cross-process file lock.
 */

import { promises as fs } from "node:fs";

import { atomicWriteFile, withFileLock, withFileMutationQueue } from "./atomic-file-store.js";

export const SKILL_USAGE_SCHEMA_VERSION = 1;
export const MAX_SKILL_USAGE_ENTRIES = 256;
export const MAX_SKILL_USAGE_COUNT = 1_000_000_000;

export interface SkillUsageRecord {
  readonly useCount: number;
  readonly viewCount: number;
  readonly lastActivity: string | null;
}

export type SkillUsageMap = Record<string, SkillUsageRecord>;

export interface SkillUsageMutationOptions {
  /** Test seam used to force overlapping cross-process read-modify-writes. */
  readonly beforeWrite?: () => Promise<void>;
}

interface SkillUsageFile {
  readonly version: number;
  readonly skills: unknown;
}

function emptyRecord(): SkillUsageRecord {
  return { lastActivity: null, useCount: 0, viewCount: 0 };
}

function finiteCount(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return 0;
  return Math.min(MAX_SKILL_USAGE_COUNT, Math.trunc(value));
}

function validActivity(value: unknown): string | null {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) return null;
  return value;
}

function sanitizeRecord(value: unknown): SkillUsageRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return emptyRecord();
  const raw = value as Record<string, unknown>;
  return {
    lastActivity: validActivity(raw["lastActivity"]),
    useCount: finiteCount(raw["useCount"]),
    viewCount: finiteCount(raw["viewCount"])
  };
}

function sanitizeSkills(value: unknown): SkillUsageMap {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([name]) => name.length > 0)
    .slice(0, MAX_SKILL_USAGE_ENTRIES);
  return Object.fromEntries(entries.map(([name, record]) => [name, sanitizeRecord(record)]));
}

/** Read a usage sidecar; missing, corrupt, and invalid rows fail soft. */
export async function readSkillUsage(file: string): Promise<SkillUsageMap> {
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const state = parsed as SkillUsageFile;
  if (state.version !== SKILL_USAGE_SCHEMA_VERSION) return {};
  return sanitizeSkills(state.skills);
}

function isoNow(at: Date): string | undefined {
  const time = at.getTime();
  return Number.isFinite(time) ? at.toISOString() : undefined;
}

async function mutateSkillUsage(
  file: string,
  name: string,
  field: "useCount" | "viewCount",
  at: Date,
  options: SkillUsageMutationOptions
): Promise<SkillUsageRecord | undefined> {
  if (name.length === 0) return undefined;
  const lastActivity = isoNow(at);
  if (!lastActivity) return undefined;
  try {
    return await withFileMutationQueue(file, () => withFileLock(file, async () => {
      const current = await readSkillUsage(file);
      const previous = current[name] ?? emptyRecord();
      const nextRecord: SkillUsageRecord = {
        lastActivity,
        useCount: field === "useCount" ? Math.min(MAX_SKILL_USAGE_COUNT, previous.useCount + 1) : previous.useCount,
        viewCount: field === "viewCount" ? Math.min(MAX_SKILL_USAGE_COUNT, previous.viewCount + 1) : previous.viewCount
      };
      await options.beforeWrite?.();
      const next = { ...current, [name]: nextRecord };
      await atomicWriteFile(
        file,
        `${JSON.stringify({ skills: next, version: SKILL_USAGE_SCHEMA_VERSION }, null, 2)}\n`,
        { mode: 0o600, strictPrivate: true }
      );
      return nextRecord;
    }));
  } catch {
    return undefined;
  }
}

/** Record one authored-skill selection event. */
export function recordSkillUse(
  file: string,
  name: string,
  at: Date = new Date(),
  options: SkillUsageMutationOptions = {}
): Promise<SkillUsageRecord | undefined> {
  return mutateSkillUsage(file, name, "useCount", at, options);
}

/** Record one successful authored-skill read event. */
export function recordSkillView(
  file: string,
  name: string,
  at: Date = new Date(),
  options: SkillUsageMutationOptions = {}
): Promise<SkillUsageRecord | undefined> {
  return mutateSkillUsage(file, name, "viewCount", at, options);
}
