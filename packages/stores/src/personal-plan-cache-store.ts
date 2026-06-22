/**
 * Pure data layer for the plan-template cache (`~/.muse/plan-cache.json`).
 *
 * Agentic Plan Caching (arXiv 2506.14852): plan templates extracted from
 * completed runs are reused on similar later tasks. Muse reuses them as a
 * planning few-shot exemplar (the small local model plans better in one shot),
 * not to skip the call. Same durability posture as the sibling stores: atomic
 * fsync+rename write, tolerant read, corrupt store quarantined aside.
 */

import { promises as fs } from "node:fs";

import { atomicWriteFile, withFileMutationQueue } from "./atomic-file-store.js";

/** Newest templates kept — bounds the file + retrieval cost. */
export const MAX_PLAN_CACHE_ENTRIES = 100;

export interface PlanCacheStep {
  readonly tool: string;
  readonly args: Record<string, unknown>;
  readonly description: string;
}

export interface PlanCacheEntry {
  readonly id: string;
  readonly userId: string;
  /** The user request this plan answered. */
  readonly prompt: string;
  readonly steps: readonly PlanCacheStep[];
  readonly createdAt: string;
}

async function quarantineCorruptStore(file: string): Promise<void> {
  try {
    await fs.rename(file, `${file}.corrupt-${Date.now().toString()}`);
  } catch {
    // ignore — read still degrades to empty either way
  }
}

export async function readPlanCache(file: string): Promise<readonly PlanCacheEntry[]> {
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
  if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as { entries?: unknown }).entries)) {
    await quarantineCorruptStore(file);
    return [];
  }
  return (parsed as { entries: unknown[] }).entries.flatMap((entry): readonly PlanCacheEntry[] =>
    isPlanCacheEntry(entry) ? [entry] : []
  );
}

export async function writePlanCache(file: string, entries: readonly PlanCacheEntry[]): Promise<void> {
  const payload = `${JSON.stringify({ entries }, null, 2)}\n`;
  await atomicWriteFile(file, payload);
}

export async function recordPlanTemplate(file: string, entry: PlanCacheEntry): Promise<void> {
  // Serialise the read→upsert→cap→write: concurrent cache writes otherwise read
  // the same snapshot and the last write clobbers the rest (a lost plan template
  // is a cache miss the agent re-plans from scratch), and two writes in the same
  // millisecond collided on the tmp-${pid}-${Date.now()} path and threw ENOENT.
  await withFileMutationQueue(file, async () => {
    const existing = await readPlanCache(file);
    const next = [...existing.filter((e) => e.id !== entry.id), entry].slice(-MAX_PLAN_CACHE_ENTRIES);
    await writePlanCache(file, next);
  });
}

export async function queryPlanCache(file: string, userId?: string): Promise<readonly PlanCacheEntry[]> {
  const all = await readPlanCache(file);
  return userId ? all.filter((e) => e.userId === userId) : all;
}

function isPlanCacheStep(value: unknown): value is PlanCacheStep {
  if (!value || typeof value !== "object") return false;
  const s = value as Partial<PlanCacheStep>;
  return typeof s.tool === "string" && s.tool.length > 0
    && typeof s.description === "string"
    && !!s.args && typeof s.args === "object";
}

function isPlanCacheEntry(value: unknown): value is PlanCacheEntry {
  if (!value || typeof value !== "object") return false;
  const e = value as Partial<PlanCacheEntry>;
  if (typeof e.id !== "string" || e.id.length === 0) return false;
  if (typeof e.userId !== "string" || e.userId.length === 0) return false;
  if (typeof e.prompt !== "string" || e.prompt.trim().length === 0) return false;
  if (typeof e.createdAt !== "string") return false;
  if (!Array.isArray(e.steps) || e.steps.length === 0 || !e.steps.every(isPlanCacheStep)) return false;
  return true;
}
