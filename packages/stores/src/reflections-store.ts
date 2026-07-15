/**
 * Persisted grounded reflections (Muse's "dreaming" — P32 of the-edge.md). When
 * the daemon is idle it synthesises higher-level insights about the user from
 * recent episodes; the GROUNDED ones (each citing the real episode ids it came
 * from) land here so `muse reflections` can surface them with their sources.
 *
 *   - `~/.muse/reflections.json` is the sidecar (FIFO-trimmed, atomic +
 *     mutation-queued write — same primitive as the trust ledger).
 *   - Dedup on the normalised insight so the same recurring theme isn't stored
 *     twice across passes.
 *   - Tolerant reads: missing / bad-JSON / wrong-shape → empty.
 */

import { withFileMutationQueue } from "./atomic-file-store.js";
import { isFileEncryptedAtRest, readMaybeEncrypted, writeMaybeEncrypted } from "./encrypted-file.js";

export interface StoredReflection {
  readonly id: string;
  readonly insight: string;
  /** The real episode/note ids this insight is grounded in. */
  readonly sourceIds: readonly string[];
  readonly supportCount: number;
  readonly createdAtMs: number;
}

export const MAX_REFLECTIONS = 500;

const DAY_MS_REFLECT = 24 * 60 * 60_000;
/** Half-life (days) of a stored reflection's recency term in the retention score. */
const REFLECTION_RETENTION_HALF_LIFE_DAYS = 30;
/** Weight of the salience (support) term relative to recency in the retention score. */
const REFLECTION_SALIENCE_WEIGHT = 1;
/** Support count at/above which a reflection's salience term saturates to 1. */
const REFLECTION_SALIENCE_FULL_SUPPORT = 5;

export interface ReflectionRetentionOptions {
  readonly halfLifeDays?: number;
  readonly salienceWeight?: number;
  readonly fullSupport?: number;
}

function toRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record: Record<string, unknown> = {};
  for (const [key, nestedValue] of Object.entries(value)) {
    if (typeof key === "string") {
      record[key] = nestedValue;
    }
  }
  return record;
}

/**
 * Retention score for cap-overflow eviction — Generative Agents (arXiv:2304.03442):
 * what survives a capped memory store is recency PLUS salience (importance), not
 * recency alone. `recency = 0.5^(ageDays/halfLife)` ∈ (0,1]; `salience =
 * min(1, supportCount/fullSupport)` (a recurring insight grounded in many
 * episodes is more important). With EQUAL support the salience term is constant
 * so eviction reduces to recency (legacy-identical); it only diverges to PROTECT
 * a high-support insight from being evicted for a thinner but newer one. Pure.
 */
export function scoreReflectionRetention(
  reflection: StoredReflection,
  nowMs: number,
  options: ReflectionRetentionOptions = {}
): number {
  const halfLife = Number.isFinite(options.halfLifeDays) && options.halfLifeDays! > 0 ? options.halfLifeDays! : REFLECTION_RETENTION_HALF_LIFE_DAYS;
  const weight = Number.isFinite(options.salienceWeight) ? Math.max(0, options.salienceWeight!) : REFLECTION_SALIENCE_WEIGHT;
  const full = Number.isFinite(options.fullSupport) && options.fullSupport! > 0 ? options.fullSupport! : REFLECTION_SALIENCE_FULL_SUPPORT;
  const ageDays = Math.max(0, (nowMs - reflection.createdAtMs) / DAY_MS_REFLECT);
  const recency = Math.pow(0.5, ageDays / halfLife);
  const support = Number.isFinite(reflection.supportCount) ? Math.max(0, reflection.supportCount) : 0;
  const salience = Math.min(1, support / full);
  return recency + weight * salience;
}

/**
 * The reflections that survive a cap: the `cap` highest-retention-score entries
 * (salience-weighted), ties broken by recency so it agrees with the newest-first
 * display order. A set at/under `cap` is returned unchanged. Pure.
 */
export function selectRetainedReflections(
  entries: readonly StoredReflection[],
  nowMs: number,
  cap: number = MAX_REFLECTIONS,
  options: ReflectionRetentionOptions = {}
): readonly StoredReflection[] {
  if (entries.length <= cap) return entries;
  return [...entries]
    .sort((a, b) => scoreReflectionRetention(b, nowMs, options) - scoreReflectionRetention(a, nowMs, options) || b.createdAtMs - a.createdAtMs)
    .slice(0, cap);
}

function isReflection(value: unknown): value is StoredReflection {
  const r = toRecord(value);
  if (!r) return false;
  return typeof r.id === "string"
    && typeof r.insight === "string" && r.insight.length > 0
    && Array.isArray(r.sourceIds) && r.sourceIds.every((s) => typeof s === "string")
    && typeof r.supportCount === "number" && Number.isFinite(r.supportCount)
    && typeof r.createdAtMs === "number" && Number.isFinite(r.createdAtMs);
}

const normalize = (insight: string): string => insight.toLowerCase().replace(/\s+/gu, " ").trim();

export async function readReflections(file: string, env: NodeJS.ProcessEnv = process.env): Promise<readonly StoredReflection[]> {
  // Encryption-at-rest, format-preserving: reads a plaintext OR an encrypted file
  // transparently (fail-closed on a wrong key); a once-encrypted reflections store
  // stays encrypted. Reflections are "what Muse noticed about you" — personal.
  const { text } = await readMaybeEncrypted(file, env);
  if (text === undefined) {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  const record = toRecord(parsed);
  if (!record || !Array.isArray(record.reflections)) {
    return [];
  }
  return record.reflections.flatMap((r): readonly StoredReflection[] =>
    isReflection(r) ? [r] : []
  );
}

async function writeReflections(file: string, entries: readonly StoredReflection[], nowMs: number, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  // Trim to the cap by SALIENCE-weighted retention (recency + support), not pure
  // recency — a high-support recurring insight must not be evicted for a thinner
  // but newer one (Generative Agents arXiv:2304.03442). With equal support this
  // reduces to recency, ties broken by createdAtMs so it still agrees with the
  // newest-first display order.
  const trimmed = selectRetainedReflections(entries, nowMs, MAX_REFLECTIONS);
  // Preserve the file's current format (once encrypted, stays encrypted; plaintext
  // stays plaintext until the user runs the encrypt flow) — the proven per-store pattern.
  const encrypted = await isFileEncryptedAtRest(file);
  await writeMaybeEncrypted(file, `${JSON.stringify({ reflections: trimmed }, null, 2)}\n`, encrypted, env);
}

export interface NewReflection {
  readonly id: string;
  readonly insight: string;
  readonly sourceIds: readonly string[];
  readonly supportCount: number;
  readonly createdAtMs: number;
}

/**
 * Add new reflections, skipping any whose insight already exists (normalised).
 * Returns how many were actually added.
 */
export async function addReflections(
  file: string,
  incoming: readonly NewReflection[],
  options: { readonly nowMs?: number } = {},
  env: NodeJS.ProcessEnv = process.env
): Promise<number> {
  if (incoming.length === 0) return 0;
  const nowMs = Number.isFinite(options.nowMs) ? options.nowMs! : Date.now();
  return withFileMutationQueue(file, async () => {
    const existing = await readReflections(file, env);
    const seen = new Set(existing.map((r) => normalize(r.insight)));
    const fresh: StoredReflection[] = [];
    for (const r of incoming) {
      const key = normalize(r.insight);
      if (key.length === 0 || seen.has(key)) continue;
      seen.add(key);
      fresh.push({ createdAtMs: r.createdAtMs, id: r.id, insight: r.insight, sourceIds: [...r.sourceIds], supportCount: r.supportCount });
    }
    if (fresh.length > 0) await writeReflections(file, [...existing, ...fresh], nowMs, env);
    return fresh.length;
  });
}

/** Pure: reflections newest-first. For the user-facing `muse reflections` listing. */
export function listReflections(entries: readonly StoredReflection[]): readonly StoredReflection[] {
  return [...entries].sort((a, b) => b.createdAtMs - a.createdAtMs);
}

/**
 * Order reflections for the ASK-grounding RECALL surface by the SAME salience+recency
 * score that governs retention (`scoreReflectionRetention`), not pure recency. The
 * retention pass deliberately KEEPS a high-support old insight over a thinner newer
 * one — but `listReflections` (newest-first) would then bury that kept insight below
 * newer ones, so it never reaches the top-K injected into the prompt (retention ≠
 * display). This closes that gap: a recurring, well-grounded insight surfaces for
 * recall. Same sort as `selectRetainedReflections` (recency tie-break). Pure;
 * `listReflections` stays recency-ordered for the display path.
 */
export function selectReflectionsForRecall(
  entries: readonly StoredReflection[],
  nowMs: number,
  options: ReflectionRetentionOptions = {}
): readonly StoredReflection[] {
  return [...entries].sort(
    (a, b) => scoreReflectionRetention(b, nowMs, options) - scoreReflectionRetention(a, nowMs, options) || b.createdAtMs - a.createdAtMs
  );
}
