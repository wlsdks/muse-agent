/**
 * Goal 090 — episode semantic index.
 *
 * Mirrors the `notes-index.json` pipeline: a flat
 * `~/.muse/episodes-index.json` carrying each `PersistedEpisode`'s
 * summary embedded via Ollama nomic-embed-text (or whatever
 * `--embed-model` is). The shape:
 *
 *   { version: 1, model: <embed-model>, builtAtIso, entries: [
 *     { id, summary, startedAt, endedAt, userId, embedding }
 *   ] }
 *
 * Incremental: an existing entry with matching id + same summary
 * text + same model is reused (no re-embed). `version` mismatch
 * → full rebuild (mirrors goal 074).
 */

import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

import type { PersistedEpisode } from "@muse/mcp";

export const EPISODE_INDEX_SCHEMA_VERSION = 1;

export interface EpisodeIndexEntry {
  readonly id: string;
  readonly userId: string;
  readonly summary: string;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly embedding: number[];
}

export interface EpisodeIndex {
  readonly version: typeof EPISODE_INDEX_SCHEMA_VERSION;
  readonly model: string;
  readonly builtAtIso: string;
  readonly entries: readonly EpisodeIndexEntry[];
}

export function defaultEpisodeIndexFile(): string {
  const fromEnv = process.env.MUSE_EPISODES_INDEX_FILE?.trim();
  if (fromEnv && fromEnv.length > 0) return fromEnv;
  return join(homedir(), ".muse", "episodes-index.json");
}

/**
 * Tolerant reader — any IO / parse / shape / version mismatch
 * collapses to `undefined`, mirroring the notes-index loader so a
 * malformed index just triggers a clean rebuild on the next
 * `reindex` invocation.
 */
export async function loadEpisodeIndex(file: string): Promise<EpisodeIndex | undefined> {
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object") return undefined;
  const candidate = parsed as Partial<EpisodeIndex>;
  if (candidate.version !== EPISODE_INDEX_SCHEMA_VERSION) return undefined;
  if (typeof candidate.model !== "string" || !Array.isArray(candidate.entries)) return undefined;
  const builtAtIso = typeof candidate.builtAtIso === "string" ? candidate.builtAtIso : "";
  const entries = candidate.entries.filter(isValidEpisodeIndexEntry);
  return { version: EPISODE_INDEX_SCHEMA_VERSION, model: candidate.model, builtAtIso, entries };
}

function isValidEpisodeIndexEntry(raw: unknown): raw is EpisodeIndexEntry {
  if (!raw || typeof raw !== "object") return false;
  const e = raw as Partial<EpisodeIndexEntry>;
  if (typeof e.id !== "string" || e.id.length === 0) return false;
  if (typeof e.userId !== "string") return false;
  if (typeof e.summary !== "string") return false;
  if (typeof e.startedAt !== "string") return false;
  if (typeof e.endedAt !== "string") return false;
  if (!Array.isArray(e.embedding)) return false;
  return e.embedding.every((n) => typeof n === "number" && Number.isFinite(n));
}

export async function saveEpisodeIndex(file: string, index: EpisodeIndex): Promise<void> {
  await fs.mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid.toString()}-${Date.now().toString()}`;
  await fs.writeFile(tmp, `${JSON.stringify(index, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await fs.rename(tmp, file);
  await fs.chmod(file, 0o600).catch(() => undefined);
}

export interface ReindexEpisodesSummary {
  readonly embedded: number;
  readonly skipped: number;
  readonly indexPath: string;
  readonly index: EpisodeIndex;
}

/**
 * Goal 090 — pure reindex loop. Caller injects:
 *   - `episodes`           the source rows
 *   - `embedFn(text)`      the embedding HTTP call
 *   - `previous`           the prior index (or undefined)
 *   - `nowIso`             deterministic timestamp for tests
 *
 * Returns the new index + counters. Skip rule: existing entry
 * whose `id` + `summary` match the source row keeps its
 * embedding (no re-embed). Anything else gets embedded fresh.
 */
export async function buildEpisodeIndex(args: {
  readonly episodes: readonly PersistedEpisode[];
  readonly embedFn: (text: string) => Promise<number[]>;
  readonly previous: EpisodeIndex | undefined;
  readonly model: string;
  readonly nowIso: string;
  readonly force?: boolean;
}): Promise<{ readonly index: EpisodeIndex; readonly embedded: number; readonly skipped: number }> {
  const reusable = new Map<string, EpisodeIndexEntry>();
  if (!args.force && args.previous && args.previous.model === args.model) {
    for (const entry of args.previous.entries) {
      reusable.set(entry.id, entry);
    }
  }
  const entries: EpisodeIndexEntry[] = [];
  let embedded = 0;
  let skipped = 0;
  for (const ep of args.episodes) {
    const prior = reusable.get(ep.id);
    if (prior && prior.summary === ep.summary) {
      entries.push(prior);
      skipped += 1;
      continue;
    }
    const embedding = await args.embedFn(ep.summary);
    entries.push({
      id: ep.id,
      userId: ep.userId,
      summary: ep.summary,
      startedAt: ep.startedAt,
      endedAt: ep.endedAt,
      embedding
    });
    embedded += 1;
  }
  const index: EpisodeIndex = {
    version: EPISODE_INDEX_SCHEMA_VERSION,
    model: args.model,
    builtAtIso: args.nowIso,
    entries
  };
  return { index, embedded, skipped };
}
