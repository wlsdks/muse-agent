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

import type { JsonObject, JsonValue } from "@muse/shared";

import { withFileMutationQueue } from "./atomic-file-store.js";
import {
  decryptFileAtRest,
  encryptFileAtRest,
  isFileEncryptedAtRest,
  readMaybeEncrypted,
  withFileLock,
  writeMaybeEncrypted
} from "./encrypted-file.js";
import { quarantineCorruptStore } from "./store-quarantine.js";
import { selectRetainedEpisodes } from "./episode-analytics.js";

// Analysis over the episode bank (retention scoring, theme/absence detection,
// consolidation planning) lives in ./episode-analytics.js — re-exported here
// so the public surface (@muse/stores, direct imports) is unchanged.
export {
  computeEpisodeRetention,
  detectTopicAbsence,
  planEpisodeConsolidation,
  recurringThemes,
  selectRetainedEpisodes,
  type EpisodeConsolidation,
  type EpisodeRetentionOptions,
  type EpisodeTheme,
  type TopicAbsence
} from "./episode-analytics.js";

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
      ? { topics: episode.topics as JsonValue }
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
