import type { HistoryRecord } from "@muse/recall";
import type { NotesProvider } from "@muse/domain-tools";
import type { UserMemoryStore } from "@muse/memory";

export interface EpisodeRecord {
  readonly id: string;
  readonly userId?: string;
  readonly summary: string;
  readonly endedAt?: string;
}

export interface HistoryRecordsProviderDeps {
  /** All episodes for the runtime; filtered to `userId` here. */
  readonly readEpisodes: () => Promise<readonly EpisodeRecord[]> | readonly EpisodeRecord[];
  /** The live notes provider (registry primary), when notes are configured. */
  readonly notesProvider?: NotesProvider;
  /** The runtime user-memory store, for remembered facts + preferences. */
  readonly userMemoryStore?: UserMemoryStore;
  readonly userId: string;
  /** Truncate each note body to bound CPU/snippet cost. Default 4000. */
  readonly maxNoteChars?: number;
}

const DEFAULT_MAX_NOTE_CHARS = 4000;

/**
 * Resolve the user's OWN searchable past into flat {@link HistoryRecord}s across
 * ALL three advertised sources — chat episodes, notes, and remembered facts —
 * each carrying its correct `source` label so a hit cites the real surface.
 * Wired so `history_search` actually searches what its description promises (no
 * "no note matched" without ever reading notes).
 *
 * Per-source fail-soft: one source throwing (or being unconfigured) yields no
 * records from THAT source and never blocks the others — the tool degrades to
 * fewer sources, never to a thrown loop. Resolved per call so freshly written
 * history is searchable without a restart.
 */
export async function buildHistoryRecords(deps: HistoryRecordsProviderDeps): Promise<readonly HistoryRecord[]> {
  const [episodes, notes, memory] = await Promise.all([
    resolveEpisodeRecords(deps),
    resolveNoteRecords(deps),
    resolveMemoryRecords(deps)
  ]);
  return [...episodes, ...notes, ...memory];
}

async function resolveEpisodeRecords(deps: HistoryRecordsProviderDeps): Promise<readonly HistoryRecord[]> {
  let episodes: readonly EpisodeRecord[];
  try {
    episodes = await deps.readEpisodes();
  } catch {
    return [];
  }
  return episodes
    .filter((episode) => episode.userId === deps.userId)
    .map((episode) => {
      const endedMs = episode.endedAt ? Date.parse(episode.endedAt) : NaN;
      return {
        ref: episode.id,
        source: "episodes" as const,
        text: episode.summary,
        ...(Number.isFinite(endedMs) ? { timestampMs: endedMs } : {})
      };
    });
}

async function resolveNoteRecords(deps: HistoryRecordsProviderDeps): Promise<readonly HistoryRecord[]> {
  const provider = deps.notesProvider;
  if (!provider) {
    return [];
  }
  const maxChars = deps.maxNoteChars ?? DEFAULT_MAX_NOTE_CHARS;
  let entries: readonly { readonly id: string; readonly title: string; readonly updatedAt?: Date }[];
  try {
    entries = await provider.list();
  } catch {
    return [];
  }
  const records = await Promise.all(
    entries.map(async (entry): Promise<HistoryRecord | undefined> => {
      let body: string | undefined;
      try {
        body = (await provider.read(entry.id))?.body?.trim();
      } catch {
        body = undefined;
      }
      const title = entry.title.trim();
      const text = body ? `${title}\n\n${body}`.slice(0, maxChars) : title;
      if (text.length === 0) {
        return undefined;
      }
      const updatedMs = entry.updatedAt instanceof Date ? entry.updatedAt.getTime() : NaN;
      return {
        ref: entry.id,
        source: "notes" as const,
        text,
        ...(Number.isFinite(updatedMs) ? { timestampMs: updatedMs } : {})
      };
    })
  );
  return records.filter((record): record is HistoryRecord => record !== undefined);
}

async function resolveMemoryRecords(deps: HistoryRecordsProviderDeps): Promise<readonly HistoryRecord[]> {
  const store = deps.userMemoryStore;
  if (!store) {
    return [];
  }
  let memory;
  try {
    memory = await store.findByUserId(deps.userId);
  } catch {
    return [];
  }
  if (!memory) {
    return [];
  }
  return [
    ...Object.entries(memory.facts).map(([key, value]) => toMemoryRecord("fact", key, value)),
    ...Object.entries(memory.preferences).map(([key, value]) => toMemoryRecord("preference", key, value))
  ];
}

function toMemoryRecord(kind: "fact" | "preference", key: string, value: string): HistoryRecord {
  return {
    ref: `${kind}:${key}`,
    source: "memory",
    text: `${key}: ${value}`
  };
}
