import { finiteOr, truncateUtf16Safe } from "@muse/shared";
import { annotateNoteChunks, chunkText, classifyRetrievalConfidence, edgeLoadByRelevance, rankKnowledgeChunksWithHop, renderKnowledgeMatches, type KnowledgeChunk, type KnowledgeMatch } from "@muse/agent-core";
import type { NotesProvider, TasksProvider } from "@muse/domain-tools";
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

interface ContactLike {
  readonly id: string;
  readonly name: string;
  readonly email?: string;
  readonly handle?: string;
  readonly phone?: string;
  readonly aliases?: readonly string[];
}

export interface ContactsSource {
  list(): Promise<readonly ContactLike[]> | readonly ContactLike[];
}

export interface EmailMessageLike {
  readonly id: string;
  readonly from: string;
  readonly subject: string;
  readonly snippet: string;
  readonly date?: string;
}

export interface EmailMessageSource {
  listRecent(limit: number): Promise<readonly EmailMessageLike[]> | readonly EmailMessageLike[];
}

export interface ReminderLike {
  readonly id: string;
  readonly text: string;
  readonly dueAt?: string;
}

export interface RemindersSource {
  /** Pending reminders only — fired/cancelled ones aren't live context. */
  list(): Promise<readonly ReminderLike[]> | readonly ReminderLike[];
}

export interface FollowupLike {
  readonly id: string;
  readonly summary: string;
}

export interface FollowupsSource {
  /** Scheduled (still-pending) followups only — fired/cancelled ones aren't live context. */
  list(): Promise<readonly FollowupLike[]> | readonly FollowupLike[];
}

export interface ObjectiveLike {
  readonly id: string;
  readonly spec: string;
}

export interface ObjectivesSource {
  /** Live standing objectives only (active / escalated) — done/cancelled ones aren't live intent. */
  list(): Promise<readonly ObjectiveLike[]> | readonly ObjectiveLike[];
}

export interface FeedEntryLike {
  readonly id: string;
  readonly title: string;
  readonly summary: string;
  readonly publishedAt?: string;
  /** Human-readable feed name, e.g. "Hacker News" — prefixed into the chunk so a citation says which feed. */
  readonly feedName?: string;
}

export interface FeedsKnowledgeSource {
  /** Most-recent watched feed entries across all feeds, newest first. */
  recentEntries(limit: number): Promise<readonly FeedEntryLike[]> | readonly FeedEntryLike[];
}

export interface EpisodeSummaryLike {
  /** Stable id — the citation fallback when there's no date. */
  readonly id: string;
  /** When the session happened, surfaced in the citation, e.g. "2026-05-20". */
  readonly when?: string;
  /** The summarised session text. */
  readonly summary: string;
}

export interface EpisodesKnowledgeSource {
  /** Most-recent cross-session summaries, newest first. */
  recentEpisodes(limit: number): Promise<readonly EpisodeSummaryLike[]> | readonly EpisodeSummaryLike[];
}

interface UserMemoryFactLike {
  /** Stable key for the fact/preference, e.g. "dentist" — used in the citation. */
  readonly key: string;
  /** The remembered value. */
  readonly value: string;
  /** "fact" | "preference" | … — surfaced so a citation reads `memory/preference:tone`. */
  readonly kind?: string;
}

export interface UserMemoryKnowledgeSource {
  /** The user's auto-extracted + manually-saved facts/preferences. */
  facts(): Promise<readonly UserMemoryFactLike[]> | readonly UserMemoryFactLike[];
}

export interface AssembleKnowledgeCorpusOptions {
  readonly notesProvider?: NotesProvider;
  /** Open tasks become corpus chunks sourced `task/<id>` — the user's todos hold key facts. */
  readonly tasksProvider?: TasksProvider;
  /** Recent + upcoming events become corpus chunks sourced `event/<id>`. */
  readonly calendarSource?: CalendarEventSource;
  /** Contacts become corpus chunks sourced `contact/<id>`. */
  readonly contactsSource?: ContactsSource;
  /** Recent emails become corpus chunks sourced `email/<id>` — "what did X mail me about Y". */
  readonly emailSource?: EmailMessageSource;
  /** Pending reminders become corpus chunks sourced `reminder/<text>` — "the dentist reminder". */
  readonly remindersSource?: RemindersSource;
  /** Scheduled followups become corpus chunks sourced `followup/<summary>` — the agent's own "check on X". */
  readonly followupsSource?: FollowupsSource;
  /** Live standing objectives become corpus chunks sourced `objective/<spec>` — "what am I working toward re: X". */
  readonly objectivesSource?: ObjectivesSource;
  /** Recent watched RSS/Atom feed entries become corpus chunks sourced `feed/<title>` — "any news about X?". */
  readonly feedsSource?: FeedsKnowledgeSource;
  /** Past cross-session summaries become corpus chunks sourced `episode/<when>` — "what did we discuss about X before?". */
  readonly episodesSource?: EpisodesKnowledgeSource;
  /** The user's remembered facts/preferences become corpus chunks sourced `memory/<key>` — "what have I told Muse about myself?". */
  readonly userMemorySource?: UserMemoryKnowledgeSource;
  readonly extraChunks?: readonly KnowledgeChunk[];
  /** Cap notes pulled into the corpus. Default 200. */
  readonly maxNotes?: number;
  /** Truncate each note body to bound prompt/CPU cost. Default 4000. */
  readonly maxCharsPerNote?: number;
  /** Calendar window: days back / days ahead. Defaults 7 / 30. */
  readonly calendarDaysBack?: number;
  readonly calendarDaysAhead?: number;
  /** Cap recent emails pulled into the corpus. Default 25. */
  readonly maxEmails?: number;
  /** Cap recent feed entries pulled into the corpus. Default 50. */
  readonly maxFeedEntries?: number;
  /** Cap recent session summaries pulled into the corpus. Default 50. */
  readonly maxEpisodes?: number;
  /** Injectable clock for the calendar window (test only). */
  readonly now?: () => number;
}

const DAY_MS = 86_400_000;


/**
 * Build a citation `source` label: the stable type prefix (kept so the
 * enricher's `excludeSourcePrefixes` still matches) plus a HUMAN-readable
 * name (subject / title / contact name) instead of an opaque id, so a
 * cited "[email/Your statement]" tells the user which item it came from.
 * Whitespace-collapsed + length-capped; falls back to the id when the
 * label is empty.
 */
function labelSource(prefix: string, label: string | undefined, fallbackId: string): string {
  const clean = (label ?? "").replace(/\s+/gu, " ").trim().slice(0, 60);
  return `${prefix}/${clean.length > 0 ? clean : fallbackId}`;
}

/**
 * Drop exact-duplicate passages (same trimmed text), keeping the FIRST
 * source. `read`-ingest-to-notes and PDF RAG can put the identical
 * passage in a note AND an ingested doc, and boilerplate recurs across
 * daily notes — without this the model sees the same text twice (wasting
 * the small local context), cites it twice, and it's embedded twice.
 * Deterministic EXACT match (whitespace-collapsed); near-duplicates are
 * left to MMR at rank time. Empty passages are dropped too.
 */
/**
 * Parse the remembered-fact KEY out of a corpus chunk's `source`, or `undefined`
 * if the chunk is not a `memory/`-sourced fact. Memory chunks are labelled
 * `memory/<kind>:<key>` (kind ∈ fact|preference) or `memory/<key>` (no kind), so
 * this strips the `memory/` prefix and a leading `fact:` / `preference:` kind
 * tag to recover the same key space `deriveFactProvenance` uses. Pure — the
 * inverse of `assembleKnowledgeCorpus`'s memory `labelSource` call.
 */
export function parseMemoryFactKey(source: string): string | undefined {
  const prefix = "memory/";
  if (!source.startsWith(prefix)) return undefined;
  const rest = source.slice(prefix.length).trim();
  if (rest.length === 0) return undefined;
  const colon = rest.indexOf(":");
  if (colon > 0) {
    const kind = rest.slice(0, colon);
    if (kind === "fact" || kind === "preference") {
      const key = rest.slice(colon + 1).trim();
      return key.length > 0 ? key : undefined;
    }
  }
  return rest;
}

export function dedupeKnowledgeChunks(chunks: readonly KnowledgeChunk[]): KnowledgeChunk[] {
  const seen = new Set<string>();
  const out: KnowledgeChunk[] = [];
  for (const chunk of chunks) {
    const key = chunk.text.replace(/\s+/gu, " ").trim();
    if (key.length === 0 || seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(chunk);
  }
  return out;
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
      // away. A short note stays one chunk sourced `notes/<id>`. The
      // overlap (DPR-style sliding window, capped at ~5% of the chunk)
      // keeps a fact that straddles a chunk boundary whole in chunk i.
      const overlap = Math.min(200, Math.max(0, Math.floor(maxChars / 20)));
      const pieces = chunkText(body, maxChars, overlap);
      const annotated = annotateNoteChunks(`notes/${entry.id}`, body, pieces);
      pieces.forEach((piece, index) => {
        chunks.push({
          ...(annotated[index]?.embedText ? { embedText: annotated[index]!.embedText } : {}),
          source: pieces.length > 1 ? `notes/${entry.id}#${(index + 1).toString()}` : `notes/${entry.id}`,
          text: piece
        });
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
      chunks.push({ source: labelSource("task", task.title, task.id), text: text.length > maxChars ? text.slice(0, maxChars) : text });
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
      chunks.push({ source: labelSource("event", event.title, event.id), text: text.length > maxChars ? text.slice(0, maxChars) : text });
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
      if (contact.phone) parts.push(`phone ${contact.phone}`);
      if (contact.aliases && contact.aliases.length > 0) parts.push(`— also: ${contact.aliases.join(", ")}`);
      const text = parts.join(" ").trim();
      if (text.length === 0) {
        continue;
      }
      chunks.push({ source: labelSource("contact", contact.name, contact.id), text });
    }
  }

  if (options.emailSource) {
    const maxEmails = Math.max(1, Math.trunc(finiteOr(options.maxEmails, 25)));
    let emails: readonly EmailMessageLike[];
    try {
      emails = await options.emailSource.listRecent(maxEmails);
    } catch {
      emails = [];
    }
    for (const email of emails.slice(0, maxEmails)) {
      const header = email.date ? `From ${email.from} — ${email.subject} (${email.date})` : `From ${email.from} — ${email.subject}`;
      const text = `${header}\n${email.snippet}`.trim();
      if (text.length === 0) {
        continue;
      }
      chunks.push({ source: labelSource("email", email.subject || email.from, email.id), text: text.length > maxChars ? text.slice(0, maxChars) : text });
    }
  }

  if (options.remindersSource) {
    let reminders: readonly ReminderLike[];
    try {
      reminders = await options.remindersSource.list();
    } catch {
      reminders = [];
    }
    for (const reminder of reminders) {
      const text = reminder.dueAt ? `${reminder.text} (due ${reminder.dueAt})` : reminder.text;
      if (text.trim().length === 0) {
        continue;
      }
      chunks.push({ source: labelSource("reminder", reminder.text, reminder.id), text: text.length > maxChars ? text.slice(0, maxChars) : text });
    }
  }

  if (options.followupsSource) {
    let followups: readonly FollowupLike[];
    try {
      followups = await options.followupsSource.list();
    } catch {
      followups = [];
    }
    for (const followup of followups) {
      if (followup.summary.trim().length === 0) {
        continue;
      }
      const text = followup.summary.length > maxChars ? truncateUtf16Safe(followup.summary, maxChars) : followup.summary;
      chunks.push({ source: labelSource("followup", followup.summary, followup.id), text });
    }
  }

  if (options.objectivesSource) {
    let objectives: readonly ObjectiveLike[];
    try {
      objectives = await options.objectivesSource.list();
    } catch {
      objectives = [];
    }
    for (const objective of objectives) {
      if (objective.spec.trim().length === 0) {
        continue;
      }
      const text = objective.spec.length > maxChars ? objective.spec.slice(0, maxChars) : objective.spec;
      chunks.push({ source: labelSource("objective", objective.spec, objective.id), text });
    }
  }

  if (options.feedsSource) {
    const maxFeedEntries = Math.max(1, Math.trunc(finiteOr(options.maxFeedEntries, 50)));
    let entries: readonly FeedEntryLike[];
    try {
      entries = await options.feedsSource.recentEntries(maxFeedEntries);
    } catch {
      entries = [];
    }
    for (const entry of entries.slice(0, maxFeedEntries)) {
      const titled = entry.feedName ? `${entry.feedName}: ${entry.title}` : entry.title;
      const header = entry.publishedAt ? `${titled} (${entry.publishedAt})` : titled;
      const text = `${header}\n${entry.summary}`.trim();
      if (text.length === 0) {
        continue;
      }
      chunks.push({ source: labelSource("feed", entry.title || entry.feedName, entry.id), text: text.length > maxChars ? text.slice(0, maxChars) : text });
    }
  }

  if (options.episodesSource) {
    const maxEpisodes = Math.max(1, Math.trunc(finiteOr(options.maxEpisodes, 50)));
    let episodes: readonly EpisodeSummaryLike[];
    try {
      episodes = await options.episodesSource.recentEpisodes(maxEpisodes);
    } catch {
      episodes = [];
    }
    for (const episode of episodes.slice(0, maxEpisodes)) {
      const summary = episode.summary.trim();
      if (summary.length === 0) {
        continue;
      }
      const text = episode.when ? `(${episode.when}) ${summary}` : summary;
      chunks.push({ source: labelSource("episode", episode.when, episode.id), text: text.length > maxChars ? text.slice(0, maxChars) : text });
    }
  }

  if (options.userMemorySource) {
    let facts: readonly UserMemoryFactLike[];
    try {
      facts = await options.userMemorySource.facts();
    } catch {
      facts = [];
    }
    for (const fact of facts) {
      const value = fact.value.trim();
      if (value.length === 0) {
        continue;
      }
      const text = `${fact.key}: ${value}`;
      chunks.push({ source: labelSource("memory", fact.kind ? `${fact.kind}:${fact.key}` : fact.key, fact.key), text: text.length > maxChars ? text.slice(0, maxChars) : text });
    }
  }

  if (options.extraChunks?.length) {
    chunks.push(...options.extraChunks);
  }

  return dedupeKnowledgeChunks(chunks);
}

export interface KnowledgeEnricherOptions {
  readonly notesProvider?: NotesProvider;
  readonly tasksProvider?: TasksProvider;
  readonly calendarSource?: CalendarEventSource;
  readonly contactsSource?: ContactsSource;
  readonly emailSource?: EmailMessageSource;
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
      ...(options.contactsSource ? { contactsSource: options.contactsSource } : {}),
      ...(options.emailSource ? { emailSource: options.emailSource } : {})
    });
    const matches = await rankKnowledgeChunksWithHop(query, corpus, {
      embed: options.embed,
      hybrid: true,
      ...(process.env.MUSE_RECALL_BM25 === "true" ? { bm25: true } : {}),
      ...(process.env.MUSE_RECALL_SECOND_HOP === "true" ? { secondHop: true } : {}),
      topK: 5,
      ...(options.minScore !== undefined ? { minScore: options.minScore } : { minScore: 0.2 })
    });
    return selectEnricherLine(matches, options.excludeSourcePrefixes ?? []);
  };
}

/**
 * CRAG (arXiv 2401.15884) gate for the ambient "Related:" line: surface the top
 * non-excluded match ONLY when the retrieval is CONFIDENT. The confidence check
 * MUST see the full candidate list (post-exclusion) — passing only `[top]` zeroes
 * the runner-up, which permanently disables `classifyRetrievalConfidence`'s
 * flat-distribution (margin) guard, so a near-tie ambiguous recall would ride
 * into the brief as if confident. Pure.
 */
export function selectEnricherLine(matches: readonly KnowledgeMatch[], excludeSourcePrefixes: readonly string[]): string | undefined {
  const candidates = matches.filter((match) => !excludeSourcePrefixes.some((prefix) => match.source.startsWith(prefix)));
  const top = candidates[0];
  if (!top || classifyRetrievalConfidence(candidates) !== "confident") {
    return undefined;
  }
  return `[${top.source}] ${top.text.replace(/\s+/gu, " ").trim()}`;
}

export interface NotesKnowledgeSearchToolOptions {
  readonly notesProvider?: NotesProvider;
  readonly tasksProvider?: TasksProvider;
  readonly calendarSource?: CalendarEventSource;
  readonly contactsSource?: ContactsSource;
  readonly emailSource?: EmailMessageSource;
  readonly remindersSource?: RemindersSource;
  readonly followupsSource?: FollowupsSource;
  readonly objectivesSource?: ObjectivesSource;
  readonly feedsSource?: FeedsKnowledgeSource;
  readonly episodesSource?: EpisodesKnowledgeSource;
  readonly userMemorySource?: UserMemoryKnowledgeSource;
  readonly embed: (text: string) => Promise<readonly number[]>;
  readonly topK?: number;
  readonly maxNotes?: number;
  readonly maxCharsPerNote?: number;
  readonly maxEmails?: number;
  readonly maxFeedEntries?: number;
  readonly maxEpisodes?: number;
  readonly extraChunks?: readonly KnowledgeChunk[];
  /**
   * Fail-soft recorder invoked with the fact KEYS of `memory/`-sourced chunks
   * that PASSED ranking (i.e. are in the returned top-N), plus the raw query.
   * Wired in production to record a FACT-recall hit into the SEPARATE
   * fact-recall-hits ledger (NOT the episode ledger) so the fact-promotion gate
   * can count demonstrated recall. Called at SURFACED-INTO-RESULTS time, never at
   * corpus assembly (assembly enumerates ALL facts). Absent ⇒ no recording. Any
   * throw is swallowed here so recording can never break the recall path.
   */
  readonly onFactRecall?: (memoryKeys: readonly string[], query: string) => void;
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
      description: "Search EVERYTHING the user has ever told Muse or saved — their notes, ingested documents, tasks, calendar, contacts, recent emails, reminders, follow-ups, standing objectives, watched news/RSS feeds, PAST CONVERSATIONS (earlier sessions), and the facts/preferences Muse has remembered about them — and return matching passages, each labelled with its [source] (cite the source you use). Use when the user asks what they know, have saved, have heard about, what they told you before, or what you remember about them ('what did we discuss about X', 'what do you know about my Y', 'any news about Z'). Do not use to open a NEW web page, or for general world facts the user never saved — answer those yourself.",
      inputSchema: {
        additionalProperties: false,
        properties: {
          query: {
            description: "What to look up, in natural language — e.g. 'my health insurance policy number', 'any news about the merger', or 'what did Sam email me about the launch'.",
            type: "string"
          }
        },
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
        ...(options.emailSource ? { emailSource: options.emailSource } : {}),
        ...(options.remindersSource ? { remindersSource: options.remindersSource } : {}),
        ...(options.followupsSource ? { followupsSource: options.followupsSource } : {}),
        ...(options.objectivesSource ? { objectivesSource: options.objectivesSource } : {}),
        ...(options.feedsSource ? { feedsSource: options.feedsSource } : {}),
        ...(options.episodesSource ? { episodesSource: options.episodesSource } : {}),
        ...(options.userMemorySource ? { userMemorySource: options.userMemorySource } : {}),
        ...(options.extraChunks ? { extraChunks: options.extraChunks } : {}),
        ...(options.maxNotes !== undefined ? { maxNotes: options.maxNotes } : {}),
        ...(options.maxCharsPerNote !== undefined ? { maxCharsPerNote: options.maxCharsPerNote } : {}),
        ...(options.maxEmails !== undefined ? { maxEmails: options.maxEmails } : {}),
        ...(options.maxFeedEntries !== undefined ? { maxFeedEntries: options.maxFeedEntries } : {}),
        ...(options.maxEpisodes !== undefined ? { maxEpisodes: options.maxEpisodes } : {})
      });
      const matches = await rankKnowledgeChunksWithHop(query, corpus, {
        diversify: true,
        embed: options.embed,
        hybrid: true,
        ...(process.env.MUSE_RECALL_BM25 === "true" ? { bm25: true } : {}),
        ...(process.env.MUSE_RECALL_SECOND_HOP === "true" ? { secondHop: true } : {}),
        ...(options.topK !== undefined ? { topK: options.topK } : {})
      });
      // Record a FACT-recall hit ONLY for a memory-sourced chunk that PASSED
      // ranking and is in the returned top-N (`matches`), NOT at corpus assembly
      // (which enumerates every fact). Fail-soft — recording must never break the
      // returned results.
      if (options.onFactRecall) {
        const factKeys = matches
          .map((match) => parseMemoryFactKey(match.source))
          .filter((key): key is string => key !== undefined);
        if (factKeys.length > 0) {
          try {
            options.onFactRecall(factKeys, query);
          } catch {
            // fail-soft: a recording error can never alter the recall path
          }
        }
      }
      return renderKnowledgeMatches(edgeLoadByRelevance(matches));
    }
  };
}
