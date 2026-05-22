import { chunkText, rankKnowledgeChunks, renderKnowledgeMatches, type KnowledgeChunk } from "@muse/agent-core";
import type { NotesProvider, TasksProvider } from "@muse/mcp";
import type { MuseTool } from "@muse/tools";

/**
 * Assemble a multi-document knowledge corpus from the user's LIVE
 * stores for `rankKnowledgeChunks` / `createKnowledgeSearchTool`
 * (P20 knowledge). Each note becomes one `KnowledgeChunk` sourced as
 * `notes/<id>`; `extraChunks` carries other sources (e.g. an ingested
 * document's text, sourced `docs/<name>`) so the corpus genuinely
 * spans notes + ingested docs.
 *
 * Lives in @muse/autoconfigure — the wiring layer that may depend on
 * both @muse/mcp (NotesProvider) and @muse/agent-core (KnowledgeChunk);
 * @muse/mcp itself deliberately does not depend on @muse/agent-core.
 *
 * Fail-open: a notes store that can't list / a note that can't be
 * read is skipped, never thrown — a partial corpus still grounds an
 * answer.
 */
/**
 * Minimal structural shape of a calendar source — the
 * `CalendarProviderRegistry` and any single `CalendarProvider`
 * satisfy it. Only the recent+upcoming window is pulled into the
 * corpus so ancient / far-future events don't add noise.
 */
export interface CalendarEventLike {
  readonly id: string;
  readonly title: string;
  readonly startsAt: Date;
  readonly location?: string;
  readonly notes?: string;
}

export interface CalendarEventSource {
  listEvents(range: { readonly from: Date; readonly to: Date }): Promise<readonly CalendarEventLike[]> | readonly CalendarEventLike[];
}

export interface ContactLike {
  readonly id: string;
  readonly name: string;
  readonly email?: string;
  readonly handle?: string;
  readonly aliases?: readonly string[];
}

export interface ContactsSource {
  list(): Promise<readonly ContactLike[]> | readonly ContactLike[];
}

export interface AssembleKnowledgeCorpusOptions {
  readonly notesProvider?: NotesProvider;
  /** Open tasks become corpus chunks sourced `task/<id>` — the user's todos hold key facts. */
  readonly tasksProvider?: TasksProvider;
  /** Recent + upcoming events become corpus chunks sourced `event/<id>`. */
  readonly calendarSource?: CalendarEventSource;
  /** Contacts become corpus chunks sourced `contact/<id>`. */
  readonly contactsSource?: ContactsSource;
  readonly extraChunks?: readonly KnowledgeChunk[];
  /** Cap notes pulled into the corpus. Default 200. */
  readonly maxNotes?: number;
  /** Truncate each note body to bound prompt/CPU cost. Default 4000. */
  readonly maxCharsPerNote?: number;
  /** Calendar window: days back / days ahead. Defaults 7 / 30. */
  readonly calendarDaysBack?: number;
  readonly calendarDaysAhead?: number;
  /** Injectable clock for the calendar window (test only). */
  readonly now?: () => number;
}

const DAY_MS = 86_400_000;

function finiteOr(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export async function assembleKnowledgeCorpus(
  options: AssembleKnowledgeCorpusOptions
): Promise<KnowledgeChunk[]> {
  const maxNotes = Math.max(1, Math.trunc(finiteOr(options.maxNotes, 200)));
  const maxChars = Math.max(1, Math.trunc(finiteOr(options.maxCharsPerNote, 4_000)));
  const chunks: KnowledgeChunk[] = [];

  if (options.notesProvider) {
    let entries: readonly { readonly id: string }[];
    try {
      entries = await options.notesProvider.list();
    } catch {
      entries = [];
    }
    for (const entry of entries.slice(0, maxNotes)) {
      let body: string | undefined;
      try {
        body = (await options.notesProvider.read(entry.id))?.body?.trim();
      } catch {
        body = undefined;
      }
      if (!body) {
        continue;
      }
      // Chunk long notes / ingested docs so a passage past the first
      // `maxChars` is still retrievable + citable, instead of truncated
      // away. A short note stays one chunk sourced `notes/<id>`.
      const pieces = chunkText(body, maxChars);
      pieces.forEach((piece, index) => {
        chunks.push({ source: pieces.length > 1 ? `notes/${entry.id}#${(index + 1).toString()}` : `notes/${entry.id}`, text: piece });
      });
    }
  }

  if (options.tasksProvider) {
    let tasks: readonly { readonly id: string; readonly title: string; readonly notes?: string }[];
    try {
      tasks = await options.tasksProvider.list("open");
    } catch {
      tasks = [];
    }
    for (const task of tasks) {
      const text = task.notes && task.notes.trim().length > 0 ? `${task.title}\n\n${task.notes}` : task.title;
      if (text.trim().length === 0) {
        continue;
      }
      chunks.push({ source: `task/${task.id}`, text: text.length > maxChars ? text.slice(0, maxChars) : text });
    }
  }

  if (options.calendarSource) {
    const nowMs = options.now ? options.now() : Date.now();
    const daysBack = Math.max(0, finiteOr(options.calendarDaysBack, 7));
    const daysAhead = Math.max(0, finiteOr(options.calendarDaysAhead, 30));
    let events: readonly CalendarEventLike[];
    try {
      events = await options.calendarSource.listEvents({
        from: new Date(nowMs - daysBack * DAY_MS),
        to: new Date(nowMs + daysAhead * DAY_MS)
      });
    } catch {
      events = [];
    }
    for (const event of events) {
      const date = Number.isFinite(event.startsAt?.getTime?.()) ? event.startsAt.toISOString().slice(0, 10) : undefined;
      const head = `${event.title}${event.location ? ` @ ${event.location}` : ""}${date ? ` on ${date}` : ""}`;
      const text = event.notes && event.notes.trim().length > 0 ? `${head}\n\n${event.notes}` : head;
      if (text.trim().length === 0) {
        continue;
      }
      chunks.push({ source: `event/${event.id}`, text: text.length > maxChars ? text.slice(0, maxChars) : text });
    }
  }

  if (options.contactsSource) {
    let contacts: readonly ContactLike[];
    try {
      contacts = await options.contactsSource.list();
    } catch {
      contacts = [];
    }
    for (const contact of contacts) {
      const parts = [contact.name];
      if (contact.email) parts.push(`<${contact.email}>`);
      if (contact.handle) parts.push(`(${contact.handle})`);
      if (contact.aliases && contact.aliases.length > 0) parts.push(`— also: ${contact.aliases.join(", ")}`);
      const text = parts.join(" ").trim();
      if (text.length === 0) {
        continue;
      }
      chunks.push({ source: `contact/${contact.id}`, text });
    }
  }

  if (options.extraChunks?.length) {
    chunks.push(...options.extraChunks);
  }

  return chunks;
}

export interface KnowledgeEnricherOptions {
  readonly notesProvider?: NotesProvider;
  readonly tasksProvider?: TasksProvider;
  readonly calendarSource?: CalendarEventSource;
  readonly contactsSource?: ContactsSource;
  readonly embed: (text: string) => Promise<readonly number[]>;
  /** Minimum similarity for a "related" hit. Default 0.2 — surfaced unasked, so keep it relevant. */
  readonly minScore?: number;
  /**
   * Source prefixes to NOT surface (e.g. `["event/", "task/"]` for the
   * briefing, whose Upcoming already lists the imminent calendar /
   * task — surfacing it again as "Related" is a redundant echo). The
   * top non-excluded match is returned instead.
   */
  readonly excludeSourcePrefixes?: readonly string[];
}

/**
 * Builds a `relatedKnowledge` enricher for the situational briefing:
 * given a query (the top imminent item's title) it returns ONE compact
 * `[source] text` line for the best-matching corpus chunk, or
 * `undefined` if nothing is relevant. Reuses the unified corpus +
 * cosine ranking so the brief surfaces a note/task/event/contact the
 * user already has that bears on what's next.
 */
export function createKnowledgeEnricher(options: KnowledgeEnricherOptions): (query: string) => Promise<string | undefined> {
  return async (query: string) => {
    if (query.trim().length === 0) {
      return undefined;
    }
    const corpus = await assembleKnowledgeCorpus({
      ...(options.notesProvider ? { notesProvider: options.notesProvider } : {}),
      ...(options.tasksProvider ? { tasksProvider: options.tasksProvider } : {}),
      ...(options.calendarSource ? { calendarSource: options.calendarSource } : {}),
      ...(options.contactsSource ? { contactsSource: options.contactsSource } : {})
    });
    const matches = await rankKnowledgeChunks(query, corpus, {
      embed: options.embed,
      topK: 5,
      ...(options.minScore !== undefined ? { minScore: options.minScore } : { minScore: 0.2 })
    });
    const excluded = options.excludeSourcePrefixes ?? [];
    const top = matches.find((match) => !excluded.some((prefix) => match.source.startsWith(prefix)));
    return top ? `[${top.source}] ${top.text.replace(/\s+/gu, " ").trim()}` : undefined;
  };
}

export interface NotesKnowledgeSearchToolOptions {
  readonly notesProvider?: NotesProvider;
  readonly tasksProvider?: TasksProvider;
  readonly calendarSource?: CalendarEventSource;
  readonly contactsSource?: ContactsSource;
  readonly embed: (text: string) => Promise<readonly number[]>;
  readonly topK?: number;
  readonly maxNotes?: number;
  readonly maxCharsPerNote?: number;
  readonly extraChunks?: readonly KnowledgeChunk[];
}

/**
 * A read-only `knowledge_search` tool wired over the user's LIVE notes
 * store: each call re-assembles the corpus (so a note added since the
 * last query is searchable) then ranks + renders with source labels.
 * This is what makes the P20 knowledge engine reachable from a real
 * `muse ask --with-tools` run.
 */
export function createNotesKnowledgeSearchTool(options: NotesKnowledgeSearchToolOptions): MuseTool {
  return {
    definition: {
      description: "Search the user's personal notes (and ingested documents) for relevant passages. Returns each passage labelled with its [source] — cite the source you use.",
      inputSchema: {
        properties: { query: { type: "string" } },
        required: ["query"],
        type: "object"
      },
      name: "knowledge_search",
      risk: "read"
    },
    execute: async (args) => {
      const query = typeof (args as { query?: unknown }).query === "string" ? (args as { query: string }).query : "";
      const corpus = await assembleKnowledgeCorpus({
        ...(options.notesProvider ? { notesProvider: options.notesProvider } : {}),
        ...(options.tasksProvider ? { tasksProvider: options.tasksProvider } : {}),
        ...(options.calendarSource ? { calendarSource: options.calendarSource } : {}),
        ...(options.contactsSource ? { contactsSource: options.contactsSource } : {}),
        ...(options.extraChunks ? { extraChunks: options.extraChunks } : {}),
        ...(options.maxNotes !== undefined ? { maxNotes: options.maxNotes } : {}),
        ...(options.maxCharsPerNote !== undefined ? { maxCharsPerNote: options.maxCharsPerNote } : {})
      });
      const matches = await rankKnowledgeChunks(query, corpus, {
        embed: options.embed,
        ...(options.topK !== undefined ? { topK: options.topK } : {})
      });
      return renderKnowledgeMatches(matches);
    }
  };
}
