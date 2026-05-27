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
import { dirname } from "node:path";

import type { JsonObject, JsonValue } from "@muse/shared";

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

export async function readEpisodes(file: string): Promise<readonly PersistedEpisode[]> {
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
  if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as { episodes?: unknown }).episodes)) {
    await quarantineCorruptStore(file);
    return [];
  }
  return (parsed as { episodes: unknown[] }).episodes.flatMap((entry): readonly PersistedEpisode[] =>
    isPersistedEpisode(entry) ? [entry] : []
  );
}

export async function writeEpisodes(file: string, episodes: readonly PersistedEpisode[]): Promise<void> {
  const payload = `${JSON.stringify({ episodes }, null, 2)}\n`;
  const tmp = `${file}.tmp-${process.pid.toString()}-${Date.now().toString()}`;
  await fs.mkdir(dirname(file), { recursive: true });
  await fs.writeFile(tmp, payload, { encoding: "utf8", mode: 0o600 });
  await fs.rename(tmp, file);
  await fs.chmod(file, 0o600).catch(() => undefined);
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
      : {})
  };
}

/**
 * Replace-by-id upsert. A re-summarise pass for the same session
 * (e.g. retry after a transient LLM failure) overwrites the prior
 * entry instead of duplicating.
 */
export async function upsertEpisode(file: string, episode: PersistedEpisode): Promise<void> {
  const existing = await readEpisodes(file);
  const filtered = existing.filter((entry) => entry.id !== episode.id);
  await writeEpisodes(file, [...filtered, episode]);
}

/** Drop a single episode by id. Returns true when the id was found, false otherwise. */
export async function removeEpisode(file: string, id: string): Promise<boolean> {
  const existing = await readEpisodes(file);
  const next = existing.filter((entry) => entry.id !== id);
  if (next.length === existing.length) {
    return false;
  }
  await writeEpisodes(file, next);
  return true;
}

/** Drop every episode in the file. The shape is preserved with an empty array. */
export async function clearEpisodes(file: string): Promise<void> {
  await writeEpisodes(file, []);
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

export async function vacuumEpisodes(file: string, maxEntries = DEFAULT_VACUUM_MAX_ENTRIES, nowMs: number = Date.now()): Promise<number> {
  // NaN slips past `Math.max(1, Math.trunc(NaN)) === NaN`, then
  // `existing.length <= NaN` is false, then `slice(0, NaN)` returns
  // `[]`, then `writeEpisodes(file, [])` WIPES THE ENTIRE FILE.
  // Fail safe to the documented default so a corrupt caller-supplied
  // cap can't destroy user episode history silently.
  const cap = Number.isFinite(maxEntries) && maxEntries > 0
    ? Math.max(1, Math.trunc(maxEntries))
    : DEFAULT_VACUUM_MAX_ENTRIES;
  const existing = await readEpisodes(file);
  if (existing.length <= cap) {
    return 0;
  }
  const kept = selectRetainedEpisodes(existing, cap, nowMs);
  await writeEpisodes(file, kept);
  return existing.length - kept.length;
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
  return true;
}
