/**
 * Pure data layer for episodic memory (`~/.muse/episodes.json`).
 *
 * Step 1 of `docs/design/episodic-memory.md`. The end-of-session
 * hook (later step) reads `last-chat.jsonl` from the most recent
 * `[SESSION_BOUNDARY]` sentinel to EOF, calls a summariser, and
 * persists the result here. The persona builder (later step) reads
 * the N most-recent entries and renders them as a system-prompt
 * section so a fresh `muse chat` doesn't start fully amnesiac.
 *
 * Storage shape mirrors personal-followups-store / personal-tasks-store:
 *   - atomic write via tmp+rename (no half-flushed JSON on crash)
 *   - tolerant read (missing file / bad JSON / wrong shape → [])
 *   - one append-only file, vacuumed by `vacuumEpisodes` when it
 *     grows past `maxEntries` (default 500 per the design doc's
 *     failure-modes section)
 *
 * NOT covered here: REPL boundary sentinel, summariser prompt,
 * persona rendering, CLI surface — those live in steps 2–5.
 */

import { promises as fs } from "node:fs";

import type { JsonObject, JsonValue } from "@muse/shared";

import { withFileMutationQueue } from "./atomic-file-store.js";
import { medianGap } from "@muse/mcp-shared";
import {
  decryptFileAtRest,
  encryptFileAtRest,
  isFileEncryptedAtRest,
  readMaybeEncrypted,
  withFileLock,
  writeMaybeEncrypted
} from "./encrypted-file.js";

const EMPTY_EPISODES_BODY = `${JSON.stringify({ episodes: [] }, null, 2)}\n`;

const DEFAULT_VACUUM_MAX_ENTRIES = 500;

export interface PersistedEpisode {
  readonly id: string;
  /** User the episode belongs to (resolves to ~/.muse subscriber bucket). */
  readonly userId: string;
  /** ISO timestamp the session began. */
  readonly startedAt: string;
  /** ISO timestamp the session ended (used as the recency key for retrieval + vacuum). */
  readonly endedAt: string;
  /**
   * 60-word-or-less compacted recap. Covers subject + decision +
   * any explicit follow-up the user asked for. Format defined by
   * the extraction prompt — this store does not validate the shape
   * beyond "is a non-empty string".
   */
  readonly summary: string;
  /** Topic labels extracted from the session. Optional — older entries may lack this field. */
  readonly topics?: readonly string[];
  /**
   * Write-time importance (1–10, Generative-Agents style) assigned by the
   * summariser. Used to keep a pivotal session in the persona even when a
   * recency cap would otherwise drop it. Optional — older entries lack it.
   */
  readonly importance?: number;
  /**
   * `false` when the session this episode summarises rested on UNTRUSTED sources
   * (tool/web/MCP/feed output the assistant surfaced). Recalled later as grounding
   * evidence it then carries the same `trusted:false` provenance bit feeds/tool
   * output do, so an answer resting SOLELY on it trips the untrusted-only
   * source-check cue instead of being laundered as "your own history" (the
   * MemoryGraft temporal-propagation vector, arXiv:2512.16962). Absent ⇒ trusted
   * (the user's own session); only stored when `false`, so clean/older entries
   * are unaffected.
   */
  readonly trusted?: boolean;
}

// Move a present-but-corrupt store aside so the next upsert
// starts fresh WITHOUT permanently destroying the user's prior
// episodic memory. Best-effort; the original bytes survive at
// `<file>.corrupt-<ts>` for manual recovery.
async function quarantineCorruptStore(file: string): Promise<void> {
  try {
    await fs.rename(file, `${file}.corrupt-${Date.now().toString()}`);
  } catch {
    // ignore — read still degrades to empty either way
  }
}

export async function readEpisodes(
  file: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<readonly PersistedEpisode[]> {
  // A WRONG key THROWS here (fail-closed) — propagate it; an undecryptable store
  // is NOT corrupt and must NEVER be quarantined-to-empty (that would erase the
  // user's confided history on a key mismatch).
  const { text } = await readMaybeEncrypted(file, env);
  if (text === undefined) {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    await quarantineCorruptStore(file);
    return [];
  }
  if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as { episodes?: unknown }).episodes)) {
    await quarantineCorruptStore(file);
    return [];
  }
  return (parsed as { episodes: unknown[] }).episodes.flatMap((entry): readonly PersistedEpisode[] =>
    isPersistedEpisode(entry) ? [entry] : []
  );
}

export async function writeEpisodes(
  file: string,
  episodes: readonly PersistedEpisode[],
  env: NodeJS.ProcessEnv = process.env
): Promise<void> {
  const text = `${JSON.stringify({ episodes }, null, 2)}\n`;
  // Peek + write under the SAME cross-process lock the migration uses, so an
  // ordinary write can't race `encryptEpisodesAtRest` and clobber it with a
  // stale-format payload (the per-process `withFileMutationQueue` the mutators
  // use does NOT span processes). Format is preserved: once encrypted, stays
  // encrypted; once plaintext, stays plaintext.
  await withFileLock(file, async () => {
    const encrypted = await isFileEncryptedAtRest(file);
    await writeMaybeEncrypted(file, text, encrypted, env);
  });
}

export function serializeEpisode(episode: PersistedEpisode): JsonObject {
  return {
    endedAt: episode.endedAt,
    id: episode.id,
    startedAt: episode.startedAt,
    summary: episode.summary,
    userId: episode.userId,
    ...(episode.topics && episode.topics.length > 0
      ? { topics: episode.topics as unknown as JsonValue }
      : {}),
    ...(typeof episode.importance === "number" && Number.isFinite(episode.importance)
      ? { importance: episode.importance }
      : {}),
    // Only persisted when false (absent ⇒ trusted) — mirrors the KnowledgeMatch
    // `trusted` convention so clean/legacy episodes stay byte-identical.
    ...(episode.trusted === false ? { trusted: false } : {})
  };
}

/**
 * Replace-by-id upsert. A re-summarise pass for the same session
 * (e.g. retry after a transient LLM failure) overwrites the prior
 * entry instead of duplicating.
 */
export async function upsertEpisode(
  file: string,
  episode: PersistedEpisode,
  env: NodeJS.ProcessEnv = process.env
): Promise<void> {
  // Serialise the read-modify-write: concurrent upserts (overlapping
  // session-end summaries) otherwise read the same snapshot and the last write
  // clobbers the rest — a lost episode is a session the recall WEDGE can never
  // surface — and two writes in the same millisecond collided on the
  // tmp-${pid}-${Date.now()} path and threw ENOENT on rename.
  await withFileMutationQueue(file, async () => {
    const existing = await readEpisodes(file, env);
    const filtered = existing.filter((entry) => entry.id !== episode.id);
    await writeEpisodes(file, [...filtered, episode], env);
  });
}

/** Drop a single episode by id. Returns true when the id was found, false otherwise. */
export async function removeEpisode(
  file: string,
  id: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<boolean> {
  return withFileMutationQueue(file, async () => {
    const existing = await readEpisodes(file, env);
    const next = existing.filter((entry) => entry.id !== id);
    if (next.length === existing.length) {
      return false;
    }
    await writeEpisodes(file, next, env);
    return true;
  });
}

/** Drop every episode in the file. The shape is preserved with an empty array. */
export async function clearEpisodes(file: string, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  await writeEpisodes(file, [], env);
}

/**
 * Encrypt the episodes store at rest (AES-256-GCM, key = `MUSE_MEMORY_KEY` or the
 * per-host fallback — the SAME key as user-memory, so one key covers the whole
 * confided life). Writes a plaintext backup first, runs under the cross-process
 * lock, and is idempotent. Encrypting an empty/absent store seeds an empty
 * encrypted file so future episodes stay encrypted.
 */
export async function encryptEpisodesAtRest(
  file: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<{ readonly alreadyEncrypted: boolean; readonly backupPath?: string }> {
  return encryptFileAtRest(file, env, { emptyContent: EMPTY_EPISODES_BODY });
}

/** Reverse the migration — rewrite the episodes store as plaintext. Throws fail-closed on a wrong key. */
export async function decryptEpisodesAtRest(
  file: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<{ readonly alreadyPlaintext: boolean }> {
  return decryptFileAtRest(file, env);
}

/** Format-only check (no key needed) — is the episodes store encrypted at rest? */
export async function isEpisodesEncrypted(file: string): Promise<boolean> {
  return isFileEncryptedAtRest(file);
}

/**
 * Keep the `maxEntries` most-recent episodes (by `endedAt` desc).
 * Returns the number of entries that were dropped. A no-op when
 * the current count is already at or below the cap. The design
 * doc's failure-modes section calls this the "end-of-day vacuum"
 * — call it from a scheduler tick or the end-of-session hook
 * after upsert.
 */
export interface EpisodeRetentionOptions {
  /** Base half-life in days for an unscored episode. Default 30. */
  readonly halfLifeDays?: number;
  /** How much importance EXTENDS the half-life: effective = base·(1 + w·imp/10). Default 2 (importance 10 ⇒ 3× slower fade). */
  readonly importanceWeight?: number;
}

const DEFAULT_RETENTION_HALF_LIFE_DAYS = 30;
const DEFAULT_RETENTION_IMPORTANCE_WEIGHT = 2;

/**
 * Retention score in (0, 1] (FadeMem, arXiv 2601.18642: biologically-inspired
 * forgetting — adaptive decay modulated by importance so salient memories
 * resist fading). `retention = exp(-ageDays / effectiveHalfLife)` where
 * `effectiveHalfLife = halfLifeDays · (1 + importanceWeight · importance/10)`,
 * so a high-importance episode decays slower. An episode with NO importance
 * uses the base half-life — making retention monotonic in age, so forgetting
 * stays purely chronological (back-compatible) until importance is present.
 * Unparseable `endedAt` ⇒ 0 (forgotten first, deterministically).
 */
export function computeEpisodeRetention(
  episode: Pick<PersistedEpisode, "endedAt" | "importance">,
  nowMs: number,
  options: EpisodeRetentionOptions = {}
): number {
  const endedMs = Date.parse(episode.endedAt);
  if (!Number.isFinite(endedMs)) {
    return 0;
  }
  const halfLifeDays = Math.max(0.01, options.halfLifeDays ?? DEFAULT_RETENTION_HALF_LIFE_DAYS);
  const importanceWeight = Math.max(0, options.importanceWeight ?? DEFAULT_RETENTION_IMPORTANCE_WEIGHT);
  const importance = typeof episode.importance === "number" && Number.isFinite(episode.importance)
    ? Math.min(10, Math.max(1, episode.importance))
    : 0;
  const effectiveHalfLife = halfLifeDays * (1 + importanceWeight * (importance / 10));
  const ageDays = (nowMs - endedMs) / 86_400_000;
  return Math.exp(-ageDays / effectiveHalfLife);
}

/**
 * Keep the `cap` highest-RETENTION episodes (FadeMem importance-modulated
 * forgetting), newest-then-id as the deterministic tie-break — so an important
 * old session survives a trivial recent one, while an unscored corpus is pruned
 * purely by recency exactly as before.
 */
export function selectRetainedEpisodes(
  episodes: readonly PersistedEpisode[],
  cap: number,
  nowMs: number,
  options: EpisodeRetentionOptions = {}
): readonly PersistedEpisode[] {
  return [...episodes]
    .map((episode) => ({ episode, retention: computeEpisodeRetention(episode, nowMs, options) }))
    .sort((a, b) =>
      b.retention - a.retention
      || b.episode.endedAt.localeCompare(a.episode.endedAt)
      || b.episode.id.localeCompare(a.episode.id)
    )
    .slice(0, cap)
    .map((entry) => entry.episode);
}

export interface EpisodeTheme {
  /** The topic label, in the casing of its first occurrence. */
  readonly topic: string;
  /** How many distinct episodes carry this topic. */
  readonly count: number;
  /** endedAt of the most recent episode carrying it. */
  readonly lastSeen: string;
}

/**
 * Reflect across the episode bank: surface the topics that RECUR over
 * multiple sessions (count >= minCount), most-frequent first. A
 * consolidation/reflection over stored memory rather than a single-episode
 * recall — it answers "what keeps coming up across my history". Pure: no
 * I/O, no model call. Topics are matched case-insensitively and counted once
 * per episode; blanks and topic-less episodes are ignored.
 *
 * Concept adapted from OpenClaw's memory-consolidation idea (surfacing what
 * recurs across sessions, MIT) — deterministic reimplementation for Muse, no
 * code copied. See THIRD_PARTY_NOTICES.md.
 */
export function recurringThemes(
  episodes: readonly PersistedEpisode[],
  options: { readonly minCount?: number; readonly limit?: number } = {}
): readonly EpisodeTheme[] {
  const minCount = Math.max(2, Math.trunc(options.minCount ?? 2));
  const limit = Math.max(1, Math.trunc(options.limit ?? 10));
  const byKey = new Map<string, { count: number; lastSeen: string; display: string }>();
  for (const episode of episodes) {
    const seenInEpisode = new Set<string>();
    for (const raw of episode.topics ?? []) {
      const topic = raw.trim();
      if (topic.length === 0) continue;
      const key = topic.toLowerCase();
      if (seenInEpisode.has(key)) continue;
      seenInEpisode.add(key);
      const entry = byKey.get(key);
      if (entry) {
        entry.count += 1;
        if (episode.endedAt > entry.lastSeen) entry.lastSeen = episode.endedAt;
      } else {
        byKey.set(key, { count: 1, lastSeen: episode.endedAt, display: topic });
      }
    }
  }
  return [...byKey.values()]
    .filter((entry) => entry.count >= minCount)
    .sort((a, b) => b.count - a.count || b.lastSeen.localeCompare(a.lastSeen) || a.display.localeCompare(b.display))
    .slice(0, limit)
    .map((entry) => ({ topic: entry.display, count: entry.count, lastSeen: entry.lastSeen }));
}

export interface TopicAbsence {
  /** The topic label, in the casing of its first occurrence. */
  readonly topic: string;
  /** How many episodes carried it — the cadence sample size. */
  readonly occurrences: number;
  /** endedAt of the most recent episode carrying it — the citation anchor. */
  readonly lastSeen: string;
  /** The 60-word recap of that most-recent episode — the cited evidence. */
  readonly lastSummary: string;
  /** Typical days between occurrences (the LEARNED baseline, median gap). */
  readonly typicalGapDays: number;
  /** Days since the last occurrence — how long it has been silent. */
  readonly silentDays: number;
}

const EPISODE_DAY_MS = 86_400_000;

/**
 * The INVERSE of `recurringThemes`: surface topics that USED to recur on a
 * regular cadence but have now gone SILENT for far longer than their own
 * baseline — "you used to discuss X every few days; nothing in three weeks". A
 * learned-habit ABSENCE signal (a deviation from a per-topic baseline, not a
 * hard due-date — the heads-up a passive list never gives). Needs enough history
 * to establish a cadence (`minOccurrences` episodes ⇒ that many timestamps); the
 * typical gap is the MEDIAN consecutive gap (robust to one outlier). A topic
 * fires only when the current silence is BOTH past an absolute floor
 * (`minSilentDays`, so a fast cadence can't fire on a single day's gap) AND
 * `staleFactor`× its own typical gap. Each result cites the most recent episode
 * (its date + summary). Pure: no I/O, no model. Topics matched
 * case-insensitively, counted once per episode.
 */
export function detectTopicAbsence(
  episodes: readonly PersistedEpisode[],
  options: {
    readonly now: Date;
    readonly minOccurrences?: number;
    readonly staleFactor?: number;
    readonly minSilentDays?: number;
    readonly limit?: number;
  }
): readonly TopicAbsence[] {
  const nowMs = options.now.getTime();
  const minOccurrences = Math.max(3, Math.trunc(options.minOccurrences ?? 3));
  const staleFactor = options.staleFactor && options.staleFactor > 1 ? options.staleFactor : 2.5;
  const minSilentMs = Math.max(0, options.minSilentDays ?? 10) * EPISODE_DAY_MS;
  const limit = Math.max(1, Math.trunc(options.limit ?? 5));
  const byKey = new Map<string, { times: number[]; lastSeen: string; lastSummary: string; display: string }>();
  for (const episode of episodes) {
    const t = Date.parse(episode.endedAt);
    if (!Number.isFinite(t)) continue;
    const seenInEpisode = new Set<string>();
    for (const raw of episode.topics ?? []) {
      const topic = raw.trim();
      if (topic.length === 0) continue;
      const key = topic.toLowerCase();
      if (seenInEpisode.has(key)) continue;
      seenInEpisode.add(key);
      const entry = byKey.get(key);
      if (entry) {
        entry.times.push(t);
        if (episode.endedAt > entry.lastSeen) {
          entry.lastSeen = episode.endedAt;
          entry.lastSummary = episode.summary;
        }
      } else {
        byKey.set(key, { display: topic, lastSeen: episode.endedAt, lastSummary: episode.summary, times: [t] });
      }
    }
  }
  const out: TopicAbsence[] = [];
  for (const entry of byKey.values()) {
    if (entry.times.length < minOccurrences) continue;
    const sorted = [...entry.times].sort((a, b) => a - b);
    const gaps: number[] = [];
    for (let i = 1; i < sorted.length; i += 1) {
      gaps.push(sorted[i]! - sorted[i - 1]!);
    }
    const typicalMs = medianGap(gaps);
    if (typicalMs <= 0) continue;
    const silentMs = nowMs - sorted[sorted.length - 1]!;
    if (silentMs >= minSilentMs && silentMs > staleFactor * typicalMs) {
      out.push({
        lastSeen: entry.lastSeen,
        lastSummary: entry.lastSummary,
        occurrences: entry.times.length,
        silentDays: Math.max(1, Math.round(silentMs / EPISODE_DAY_MS)),
        topic: entry.display,
        typicalGapDays: Math.max(1, Math.round(typicalMs / EPISODE_DAY_MS))
      });
    }
  }
  return out
    .sort((a, b) => b.silentDays / b.typicalGapDays - a.silentDays / a.typicalGapDays || b.silentDays - a.silentDays)
    .slice(0, limit);
}

export interface EpisodeConsolidation {
  /** Id of the episode kept (higher importance, then more recent). */
  readonly kept: string;
  /** Id of the near-duplicate to archive. */
  readonly archived: string;
  /** 0..1 summary similarity that paired them. */
  readonly similarity: number;
}

function summaryJaccard(a: string, b: string): number {
  const toks = (t: string): Set<string> =>
    new Set(t.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((x) => x.length >= 3));
  const sa = toks(a);
  const sb = toks(b);
  if (sa.size === 0 || sb.size === 0) return 0;
  let inter = 0;
  for (const x of sa) if (sb.has(x)) inter += 1;
  return inter / (sa.size + sb.size - inter);
}

/**
 * Plan a memory consolidation: pair episodes whose summaries are near-
 * duplicates (similarity >= threshold) and, for each pair, keep the higher-
 * importance episode (ties broken by recency) and mark the other for
 * archival. An id already marked archived is never paired again, so a cluster
 * of N dupes collapses to one keeper. Pure: returns the plan, mutates
 * nothing — the caller decides whether to apply it. A high default threshold
 * (0.85) means only genuinely redundant memories pair, not merely related ones.
 *
 * Concept adapted from OpenClaw's sleep/"dreaming" memory consolidation (MIT)
 * — deterministic reimplementation for Muse, no code copied. See THIRD_PARTY_NOTICES.md.
 */
export function planEpisodeConsolidation(
  episodes: readonly PersistedEpisode[],
  options: { readonly threshold?: number; readonly similarity?: (a: string, b: string) => number } = {}
): readonly EpisodeConsolidation[] {
  const threshold = typeof options.threshold === "number" && options.threshold > 0 ? options.threshold : 0.85;
  const sim = options.similarity ?? summaryJaccard;
  const archived = new Set<string>();
  const plan: EpisodeConsolidation[] = [];
  for (let i = 0; i < episodes.length; i += 1) {
    const a = episodes[i]!;
    if (archived.has(a.id)) continue;
    for (let j = i + 1; j < episodes.length; j += 1) {
      const b = episodes[j]!;
      if (archived.has(b.id)) continue;
      const score = sim(a.summary, b.summary);
      if (score < threshold) continue;
      const keepA =
        (a.importance ?? 0) > (b.importance ?? 0)
        || ((a.importance ?? 0) === (b.importance ?? 0) && a.endedAt >= b.endedAt);
      const keep = keepA ? a : b;
      const drop = keepA ? b : a;
      archived.add(drop.id);
      plan.push({ archived: drop.id, kept: keep.id, similarity: Math.round(score * 100) / 100 });
    }
  }
  return plan;
}

export async function vacuumEpisodes(
  file: string,
  maxEntries = DEFAULT_VACUUM_MAX_ENTRIES,
  nowMs: number = Date.now(),
  env: NodeJS.ProcessEnv = process.env
): Promise<number> {
  // NaN slips past `Math.max(1, Math.trunc(NaN)) === NaN`, then
  // `existing.length <= NaN` is false, then `slice(0, NaN)` returns
  // `[]`, then `writeEpisodes(file, [])` WIPES THE ENTIRE FILE.
  // Fail safe to the documented default so a corrupt caller-supplied
  // cap can't destroy user episode history silently.
  const cap = Number.isFinite(maxEntries) && maxEntries > 0
    ? Math.max(1, Math.trunc(maxEntries))
    : DEFAULT_VACUUM_MAX_ENTRIES;
  // Serialised with the upsert/remove path so a vacuum can't race a concurrent
  // upsert (read stale → write trimmed set that drops the just-added episode).
  return withFileMutationQueue(file, async () => {
    const existing = await readEpisodes(file, env);
    if (existing.length <= cap) {
      return 0;
    }
    const kept = selectRetainedEpisodes(existing, cap, nowMs);
    await writeEpisodes(file, kept, env);
    return existing.length - kept.length;
  });
}

function isPersistedEpisode(value: unknown): value is PersistedEpisode {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as PersistedEpisode;
  if (
    typeof candidate.id !== "string" ||
    typeof candidate.userId !== "string" ||
    typeof candidate.startedAt !== "string" ||
    typeof candidate.endedAt !== "string" ||
    typeof candidate.summary !== "string" ||
    candidate.summary.trim().length === 0
  ) {
    return false;
  }
  if (candidate.topics !== undefined) {
    if (!Array.isArray(candidate.topics)) return false;
    if (!candidate.topics.every((topic) => typeof topic === "string")) return false;
  }
  if (candidate.importance !== undefined && typeof candidate.importance !== "number") {
    return false;
  }
  if (candidate.trusted !== undefined && typeof candidate.trusted !== "boolean") {
    return false;
  }
  return true;
}
