/**
 * Recall-hit sidecar — the "observe" half of weighted memory promotion
 * ("dreaming", after OpenClaw's promote-by-usefulness). Each time episodic
 * recall surfaces a past session, that session's id gets a hit recorded here;
 * the promotion pass (`selectPromotableMemories`) later weighs these hits to
 * graduate the most-recall-useful memories into the always-on persona.
 *
 *   - `~/.muse/recall-hits.json` is the on-disk sidecar.
 *   - `recordRecallHits(file, sessionIds, atMs)` increments each id's count and
 *     stamps `lastHitMs` (atomic write, FIFO-trimmed to MAX entries).
 *   - `readRecallHits(file)` is a tolerant read (missing / bad-JSON / wrong
 *     shape → empty array; one corrupt row doesn't sink the file).
 *
 * Pattern adapted from OpenClaw's dreaming / weighted-promotion (MIT) —
 * reimplemented for Muse, no code copied. See THIRD_PARTY_NOTICES.md.
 */

import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { dirname } from "node:path";

export interface RecallHitRecord {
  /** Stable key of the recalled memory — an episode `sessionId`. */
  readonly key: string;
  /** How many times this memory has been surfaced by recall. */
  readonly hits: number;
  /** Epoch ms of the most recent hit (drives recency-weighted scoring). */
  readonly lastHitMs: number;
  /**
   * The recalled memory's narrative, captured at hit time (latest wins,
   * truncated). Stored here so the promotion pass can render the memory
   * WITHOUT re-resolving it from the summary store — the recall snapshot
   * already had it.
   */
  readonly summary?: string;
  /**
   * Epoch-ms of the most recent accesses (chronological, oldest→newest), capped
   * at MAX_RECENT_ACCESS. The single `lastHitMs` only gives last-access recency;
   * this list lets the promotion pass compute ACT-R base-level activation
   * (B = ln(Σ tⱼ⁻ᵈ)) which needs EACH access age to capture spacing, not just
   * frequency. Optional so pre-existing records (written before this field) read
   * back fine.
   */
  readonly recentAccessMs?: readonly number[];
}

/** One memory surfaced by a recall: its stable key + (optionally) its narrative. */
export interface RecallHitInput {
  readonly key: string;
  readonly summary?: string;
}

const MAX_RECALL_HIT_ENTRIES = 5_000;
const MAX_SUMMARY_CHARS = 160;
const MAX_RECENT_ACCESS = 20;

export async function readRecallHits(file: string): Promise<readonly RecallHitRecord[]> {
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
  if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as { hits?: unknown }).hits)) {
    return [];
  }
  return (parsed as { hits: unknown[] }).hits.flatMap((entry): readonly RecallHitRecord[] =>
    isRecallHitRecord(entry) ? [normalizeRecord(entry)] : []
  );
}

export async function writeRecallHits(file: string, records: readonly RecallHitRecord[]): Promise<void> {
  // FIFO-ish trim — keep the most recently-hit N. Bounds pathological growth
  // without losing the records that matter (recent ones drive promotion).
  const trimmed = records.length > MAX_RECALL_HIT_ENTRIES
    ? [...records].sort((a, b) => b.lastHitMs - a.lastHitMs).slice(0, MAX_RECALL_HIT_ENTRIES)
    : records;
  const payload = `${JSON.stringify({ hits: trimmed }, null, 2)}\n`;
  // randomUUID (not pid+Date.now()): two same-ms concurrent writers picked an
  // identical tmp name, so the slower rename hit ENOENT (the file was already
  // renamed away) and crashed the recall path. Uniqueness here + the per-file
  // queue below makes concurrent recall recording crash-free and lossless.
  const tmp = `${file}.tmp-${process.pid.toString()}-${randomUUID()}`;
  await fs.mkdir(dirname(file), { recursive: true });
  await fs.writeFile(tmp, payload, "utf8");
  await fs.rename(tmp, file);
}

// Two recalls firing close together (parallel episodic lookups, a daemon tick
// overlapping a chat turn) each run read→increment→write; without serialisation
// the later write is built on a STALE read and silently drops the earlier hit's
// increment — exactly the lost-write seen under parallel test load. Serialise
// the whole read-modify-write per file (same posture as action-log /
// pending-approval).
const recordQueues = new Map<string, Promise<unknown>>();

/**
 * Read → increment-each → write, serialised per file. `entries` may repeat
 * across calls; each call bumps the count by the number of distinct ids passed
 * (a single recall surfacing the same session once = one hit).
 */
export async function recordRecallHits(file: string, entries: readonly RecallHitInput[], atMs: number): Promise<void> {
  const byInputKey = new Map<string, RecallHitInput>();
  for (const entry of entries) {
    const key = entry.key.trim();
    if (key.length === 0) continue;
    byInputKey.set(key, entry); // de-dupe within a single recall; latest summary wins
  }
  if (byInputKey.size === 0) return;
  const prior = recordQueues.get(file) ?? Promise.resolve();
  const op = async (): Promise<void> => {
    const existing = await readRecallHits(file);
    const byKey = new Map(existing.map((record) => [record.key, record]));
    for (const [key, input] of byInputKey) {
      const priorRecord = byKey.get(key);
      const summary = input.summary?.replace(/\s+/gu, " ").trim().slice(0, MAX_SUMMARY_CHARS) || priorRecord?.summary;
      const recentAccessMs = [...(priorRecord?.recentAccessMs ?? []), atMs].slice(-MAX_RECENT_ACCESS);
      byKey.set(key, {
        hits: (priorRecord?.hits ?? 0) + 1,
        key,
        lastHitMs: atMs,
        recentAccessMs,
        ...(summary ? { summary } : {})
      });
    }
    await writeRecallHits(file, [...byKey.values()]);
  };
  const next = prior.then(op, op);
  recordQueues.set(file, next.then(() => undefined, () => undefined));
  return next;
}

function normalizeRecord(record: RecallHitRecord): RecallHitRecord {
  const raw = (record as { recentAccessMs?: unknown }).recentAccessMs;
  if (!Array.isArray(raw)) return record;
  const cleaned = (raw as unknown[]).filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  if (cleaned.length === 0) {
    const out: Record<string, unknown> = { ...record };
    delete out["recentAccessMs"];
    return out as unknown as RecallHitRecord;
  }
  return { ...record, recentAccessMs: cleaned.slice(-MAX_RECENT_ACCESS) };
}

function isRecallHitRecord(value: unknown): value is RecallHitRecord {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<RecallHitRecord>;
  return typeof candidate.key === "string"
    && typeof candidate.hits === "number" && Number.isFinite(candidate.hits)
    && typeof candidate.lastHitMs === "number" && Number.isFinite(candidate.lastHitMs);
}
