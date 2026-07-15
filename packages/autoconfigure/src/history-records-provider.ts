import type { HistoryRecord } from "@muse/recall";
import type { NotesProvider } from "@muse/domain-tools";
import type { UserMemoryStore } from "@muse/memory";
import { CHAT_CONTEXT_TURN_LIMIT, recentChatTurns, type Conversation, type ConversationSummary } from "@muse/stores";

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
  /**
   * Conversation summaries (CLI/web/Telegram alike — the shared conversation
   * store), newest-first. Paired with {@link listConversations}'s sibling
   * {@link getConversation}; either absent ⇒ no conversation records (mirrors
   * `notesProvider`'s absent-means-unconfigured contract).
   */
  readonly listConversations?: () => Promise<readonly ConversationSummary[]> | readonly ConversationSummary[];
  /** The full turn history for one conversation id, when configured. */
  readonly getConversation?: (id: string) => Promise<Conversation | undefined> | Conversation | undefined;
  /**
   * OPT-IN record embedder (same model/space as the tool's query embed). When
   * present, each record's text is embedded so `history_search` can fuse lexical
   * BM25 with embedding-cosine (a paraphrase is found, not just a term match).
   * Absent ⇒ records carry no embedding and the search stays pure lexical. Costs
   * one local Ollama call per record, so the runtime injects it only when hybrid
   * history search is opted in; per-record fail-soft (a thrown embed drops only
   * that record's vector, leaving it lexical-only — never blocks the search).
   */
  readonly embed?: (text: string) => Promise<readonly number[]>;
}

const DEFAULT_MAX_NOTE_CHARS = 4000;

/**
 * Cap on how many of the user's MOST RECENT conversations become searchable
 * records. Unlike episodes/notes/memory (one read call each), a conversation
 * record needs a `get()` per conversation on top of the `list()` — an
 * unbounded history would mean hydrating every conversation's full turn
 * array on every `history_search` call. 50 comfortably covers "recent"
 * without that cost; older threads stay findable via episode summaries.
 */
const DEFAULT_MAX_CONVERSATIONS = 50;

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
  const [episodes, notes, memory, conversations] = await Promise.all([
    resolveEpisodeRecords(deps),
    resolveNoteRecords(deps),
    resolveMemoryRecords(deps),
    resolveConversationRecords(deps)
  ]);
  const records = [...episodes, ...notes, ...memory, ...conversations];
  return deps.embed ? attachEmbeddings(records, deps.embed) : records;
}

/**
 * Best-effort embed each record's text for hybrid fusion. Per-record fail-soft:
 * a thrown embed leaves that record lexical-only (no embedding field), so an
 * Ollama hiccup never drops a record from the search — it just loses the
 * paraphrase-rescue for that one item.
 */
async function attachEmbeddings(
  records: readonly HistoryRecord[],
  embed: (text: string) => Promise<readonly number[]>
): Promise<readonly HistoryRecord[]> {
  return Promise.all(
    records.map(async (record): Promise<HistoryRecord> => {
      try {
        const embedding = await embed(record.text);
        return embedding.length > 0 ? { ...record, embedding } : record;
      } catch {
        return record;
      }
    })
  );
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

/**
 * Resolve the user's own CONVERSATIONS (CLI/web/Telegram alike — the shared
 * conversation store, see conversation-store.ts) into one {@link HistoryRecord}
 * PER CONVERSATION, so "what did I say in Telegram last week" is answerable by
 * `history_search`, not just by episode summaries. This is the same exposure
 * `muse chats` already gives the user (S3b made conversations cross-surface BY
 * DESIGN) — the memory-BUCKET scoping (`inbound-agent-run` `runUserId`) is
 * untouched here.
 *
 * `ref` is the conversation id itself (a real `muse chats resume <id>`
 * target); `text` is the title plus its last few turns so a search can match
 * on either. Fail-soft on both the list and any per-conversation get (mirrors
 * `resolveEpisodeRecords`): a broken store yields no conversation records and
 * never blocks the other sources.
 */
async function resolveConversationRecords(deps: HistoryRecordsProviderDeps): Promise<readonly HistoryRecord[]> {
  const listConversations = deps.listConversations;
  const getConversation = deps.getConversation;
  if (!listConversations || !getConversation) {
    return [];
  }
  const maxChars = deps.maxNoteChars ?? DEFAULT_MAX_NOTE_CHARS;
  let summaries: readonly ConversationSummary[];
  try {
    summaries = await listConversations();
  } catch {
    return [];
  }
  // `list()` is already newest-first, but the deps are an injected test seam —
  // sort defensively rather than trust caller order for the recency cap.
  const recent = [...summaries]
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, DEFAULT_MAX_CONVERSATIONS);
  const records = await Promise.all(
    recent.map(async (summary): Promise<HistoryRecord | undefined> => {
      let conversation: Conversation | undefined;
      try {
        conversation = await getConversation(summary.id);
      } catch {
        return undefined;
      }
      if (!conversation) {
        return undefined;
      }
      // Same read-side turn window every chat-history reader shares
      // (`CHAT_CONTEXT_TURN_LIMIT`) — a searchable record covers exactly the
      // span `muse chats resume` would show, capped further by `maxChars` so
      // a 200-turn conversation still yields a bounded record.
      const turns = recentChatTurns(conversation.turns, CHAT_CONTEXT_TURN_LIMIT);
      const turnLines = turns.map((turn) => `${turn.role}: ${turn.content}`).join("\n");
      const title = summary.title.trim();
      const text = (turnLines.length > 0 ? `${title}\n\n${turnLines}` : title).slice(0, maxChars);
      if (text.length === 0) {
        return undefined;
      }
      const updatedMs = Date.parse(summary.updatedAt);
      return {
        ref: summary.id,
        source: "conversations" as const,
        text,
        ...(Number.isFinite(updatedMs) ? { timestampMs: updatedMs } : {})
      };
    })
  );
  return records.filter((record): record is HistoryRecord => record !== undefined);
}
