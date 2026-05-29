/**
 * Pure data layer for the reviewable autonomous-action log
 * (`~/.muse/action-log.json`).
 *
 * Accountability (P6-b1): every autonomous action Muse takes —
 * whether it performed or was refused — records a rationale-bearing
 * entry the user can review later (what / why / when / result).
 * Trust requires the user can SEE what was done on their behalf.
 *
 * APPEND-ONLY by contract: an audit log must never lose or rewrite
 * history, so there is no upsert/patch — only `appendActionLog`.
 * Same durability posture as the other personal stores: atomic
 * fsync+rename write, tolerant read, corrupt store quarantined
 * aside (never destroyed).
 */

import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { dirname } from "node:path";

import type { JsonObject } from "@muse/shared";

export type ActionResult = "performed" | "refused" | "failed";

export interface ActionLogEntry {
  readonly id: string;
  /** User the action was taken on behalf of (~/.muse bucket). */
  readonly userId: string;
  /** ISO timestamp the action was attempted. */
  readonly when: string;
  /** WHAT was done — a concise human description of the action. */
  readonly what: string;
  /** WHY — the rationale (the objective spec / trigger reason). */
  readonly why: string;
  /** Outcome. `refused` covers a fail-closed consent block. */
  readonly result: ActionResult;
  /** Standing objective that triggered the action, when applicable. */
  readonly objectiveId?: string;
  /** Free-form result detail ("HTTP 201", "no recorded consent"). */
  readonly detail?: string;
}

async function quarantineCorruptStore(file: string): Promise<void> {
  try {
    await fs.rename(file, `${file}.corrupt-${Date.now().toString()}`);
  } catch {
    // ignore — read still degrades to empty either way
  }
}

export async function readActionLog(file: string): Promise<readonly ActionLogEntry[]> {
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
  return (parsed as { entries: unknown[] }).entries.flatMap((entry): readonly ActionLogEntry[] =>
    isActionLogEntry(entry) ? [entry] : []
  );
}

async function writeActionLog(file: string, entries: readonly ActionLogEntry[]): Promise<void> {
  const payload = `${JSON.stringify({ entries }, null, 2)}\n`;
  // Unique per in-flight write: a `${pid}-${Date.now()}` tmp collides between
  // two same-ms concurrent writers and one rename consumes the other's tmp →
  // ENOENT. randomUUID guarantees uniqueness; serializeAppend below also
  // serialises the read-modify-write so no entry is lost.
  const tmp = `${file}.tmp-${process.pid.toString()}-${randomUUID()}`;
  await fs.mkdir(dirname(file), { recursive: true });
  const handle = await fs.open(tmp, "w", 0o600);
  try {
    await handle.writeFile(payload, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(tmp, file);
  await fs.chmod(file, 0o600).catch(() => undefined);
}

/**
 * Append one entry. Append-only: existing entries are preserved
 * verbatim and the new one is added at the end (chronological).
 * A duplicate `id` is still appended — the log records attempts,
 * it does not deduplicate them.
 */
// Per-file queue: the audit log is the accountability trail, so a concurrent
// append (multi-channel actions / daemons) must NOT lose an entry to a
// last-writer-wins read-modify-write. Serialise the whole append per file.
const appendQueues = new Map<string, Promise<unknown>>();

export async function appendActionLog(file: string, entry: ActionLogEntry): Promise<void> {
  const prior = appendQueues.get(file) ?? Promise.resolve();
  const op = async (): Promise<void> => {
    const existing = await readActionLog(file);
    await writeActionLog(file, [...existing, entry]);
  };
  const next = prior.then(op, op);
  appendQueues.set(file, next.then(() => undefined, () => undefined));
  return next;
}

/**
 * Review surface: the entries the user can see, newest first,
 * optionally scoped to one user. This is what `muse actions` /
 * an `/api/actions` route render.
 */
export async function queryActionLog(
  file: string,
  query: { readonly userId?: string } = {}
): Promise<readonly ActionLogEntry[]> {
  const all = await readActionLog(file);
  const scoped = query.userId ? all.filter((e) => e.userId === query.userId) : all;
  return [...scoped].sort((a, b) => {
    // Compare parsed instants, not raw ISO strings: lexicographic
    // order is wrong across mixed precision ("…00.500Z" sorts
    // before "…01Z") and timezone offsets, which would mis-order
    // this newest-first accountability surface. Unparseable values
    // keep a deterministic string order.
    const aMs = Date.parse(a.when);
    const bMs = Date.parse(b.when);
    if (Number.isFinite(aMs) && Number.isFinite(bMs)) {
      if (aMs !== bMs) {
        return bMs - aMs;
      }
    } else if (a.when !== b.when) {
      return b.when.localeCompare(a.when);
    }
    return b.id.localeCompare(a.id);
  });
}

export function serializeActionLogEntry(entry: ActionLogEntry): JsonObject {
  return {
    id: entry.id,
    result: entry.result,
    userId: entry.userId,
    what: entry.what,
    when: entry.when,
    why: entry.why,
    ...(entry.objectiveId ? { objectiveId: entry.objectiveId } : {}),
    ...(entry.detail ? { detail: entry.detail } : {})
  };
}

function isActionLogEntry(value: unknown): value is ActionLogEntry {
  if (!value || typeof value !== "object") {
    return false;
  }
  const e = value as ActionLogEntry;
  if (
    typeof e.id !== "string" ||
    typeof e.userId !== "string" ||
    typeof e.when !== "string" ||
    typeof e.what !== "string" ||
    typeof e.why !== "string"
  ) {
    return false;
  }
  return e.result === "performed" || e.result === "refused" || e.result === "failed";
}
