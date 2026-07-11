/** Pure analysis layer over episodic memory — retention scoring, theme/absence detection, consolidation planning. No I/O; the persistence layer (personal-episodes-store.ts) owns reads/writes and calls into this for vacuum. */

import { medianGap } from "@muse/mcp-shared";

import type { PersistedEpisode } from "./personal-episodes-store.js";

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
