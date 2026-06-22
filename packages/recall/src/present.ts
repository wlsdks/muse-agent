import { readFile, stat } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";

import { citedSourcesIn, lexicalOverlap, lexicalTokens, neutralizeInjectionSpans, type ContradictionPair } from "@muse/agent-core";
import { escapeSystemPromptMarkers } from "./prompt-escape.js";
import { formatDueLocal } from "@muse/mcp-shared";
import { type PersistedReminder, type PersistedTask } from "@muse/stores";

/**
 * SB-1/G2: the most-recent watched-feed headlines across ALL feeds, newest
 * first, capped at `limit`. Feeds are time-ordered world-state (not embedded),
 * so we surface recent items directly — the second brain reaches your
 * subscribed knowledge ("what's new in X?"). Pure; unparseable dates sort last.
 */
export function recentFeedHeadlines(
  feeds: ReadonlyArray<{ readonly name: string; readonly entries: ReadonlyArray<{ readonly title: string; readonly publishedAt: string; readonly summary: string }> }>,
  limit: number
): Array<{ feedName: string; title: string; publishedAt: string; summary: string }> {
  if (limit <= 0) {
    return [];
  }
  return feeds
    .flatMap((feed) => feed.entries.map((e) => ({ feedName: feed.name, publishedAt: e.publishedAt, summary: e.summary, title: e.title })))
    .sort((a, b) => (Date.parse(b.publishedAt) || 0) - (Date.parse(a.publishedAt) || 0))
    .slice(0, limit);
}

/**
 * "Shows its work" made FOLLOWABLE: the openable-path footer for the notes a
 * `muse ask` answer actually CITED. Takes the post-gate answer (so only real
 * surviving `[from …]` citations count), dedups, and resolves each to a full
 * path the user can open to verify the receipt. Returns undefined when nothing
 * was cited (no footer). Pure → directly testable.
 */
export function formatSourcesFooter(answer: string, notesDir: string): string | undefined {
  const citedNotes = [...new Set(citedSourcesIn(answer))];
  if (citedNotes.length === 0) {
    return undefined;
  }
  const lines = citedNotes.map((src) => `   ${isAbsolute(src) ? src : join(notesDir, src)}`);
  return `\n📎 Sources (open to verify):\n${lines.join("\n")}\n`;
}

/** A short, whitespace-collapsed verbatim excerpt of a cited chunk. */
export function provenanceSnippet(text: string, max = 90): string {
  const flat = text.replace(/\s+/gu, " ").trim();
  return flat.length > max ? `${flat.slice(0, max).trimEnd()}…` : flat;
}

/**
 * The verbatim line of a cited chunk that best ANSWERS the query — the line
 * with the most query content-token overlap (reusing the recall lexical
 * primitives), so the receipt quotes "MTU 1380 …" rather than the note's "#
 * Heading". Falls back to the chunk's opening when nothing overlaps (or no
 * query), preserving the prior behaviour. Verbatim (then length-clamped), so
 * the gate's honesty is never touched.
 */
export function relevantSnippet(text: string, query: string | undefined, max = 90): string {
  const lines = text.split(/\r?\n/u).map((l) => l.trim()).filter((l) => l.length > 0);
  if (lines.length === 0) {
    return provenanceSnippet(text, max);
  }
  // A markdown heading (`# …`) is structure, never something the user "said" —
  // exclude it so the receipt quotes a content line (fall back to all lines
  // only if the note is nothing but headings).
  const content = lines.filter((l) => !/^#{1,6}(\s|$)/u.test(l));
  const candidates = content.length > 0 ? content : lines;
  const tokens = query ? lexicalTokens(query) : new Set<string>();
  if (tokens.size > 0) {
    let best = candidates[0]!;
    let bestScore = -1;
    for (const line of candidates) {
      const score = lexicalOverlap(tokens, line);
      if (score > bestScore) {
        bestScore = score;
        best = line;
      }
    }
    return provenanceSnippet(best, max);
  }
  return provenanceSnippet(candidates[0]!, max);
}

/** A `YYYY-MM-DD` date parsed from a note's filename, if present. */
export function provenanceDate(noteRef: string): string | undefined {
  return /(\d{4}-\d{2}-\d{2})/u.exec(noteRef)?.[1];
}

/**
 * S1 "citation-as-voice" (felt-experience, PART B2): render each cited note as
 * a MEMORY, not a filename — "from your note of 2026-03-03 — '…verbatim
 * snippet…'" + the openable path. Pure deterministic code (verbatim chunk text
 * + date parsed from the filename, NO second model call, the gate untouched),
 * so the receipt reads like Muse recalling WHERE you said it. Takes the
 * post-gate answer (only real surviving citations) + the grounded chunks;
 * undefined when nothing was cited (a refusal renders no receipt). Testable.
 */
/**
 * Verify a rendered snippet against the CURRENT on-disk file content (not the
 * retrieval-index copy it was drawn from). `provenanceSnippet` whitespace-flattens
 * and may append a `…` truncation marker, so compare the snippet core (sans `…`)
 * against the same whitespace-flattening of the disk content. A faithful note
 * round-trips; an edited/truncated-away line does not.
 */
function snippetOnDisk(snippet: string, diskContent: string): boolean {
  const core = snippet.replace(/…$/u, "").trim();
  if (core.length === 0) {
    return true;
  }
  return diskContent.replace(/\s+/gu, " ").includes(core);
}

export function formatSourceReceipts(
  answer: string,
  notesDir: string,
  chunks: ReadonlyArray<{ readonly file: string; readonly text: string }>,
  query?: string,
  verifyTargets?: ReadonlyMap<string, string | null>,
  diskContents?: ReadonlyMap<string, string | null>
): string | undefined {
  const cited = [...new Set(citedSourcesIn(answer))];
  if (cited.length === 0) {
    return undefined;
  }
  const hitFor = (note: string): { readonly file: string; readonly text: string } | undefined => {
    const base = note.split("/").pop();
    return chunks.find((c) => c.file === note || c.file.split("/").pop() === base);
  };
  const blocks = cited.map((note) => {
    const date = provenanceDate(note);
    // Show the SAME relative path the answer cited (`[from projects/vpn.md]`),
    // not just the basename — otherwise a user with `a/notes.md` and
    // `b/notes.md` can't tell which "from notes.md" receipt is which.
    const lead = date ? `from your note of ${date}` : `from ${note}`;
    const hit = hitFor(note);
    let snippet = hit ? relevantSnippet(hit.text, query) : undefined;
    // L4 (shows-its-work): the snippet above is drawn from the retrieval-INDEX
    // copy (`hit.text`). When the caller supplies the file's CURRENT disk content,
    // confirm the quote is still really there — a note edited or deleted after
    // indexing would otherwise get a confident verbatim quote the file no longer
    // contains (a fake citation). On drift, hide the stale quote and say why
    // instead of vouching for text that isn't on disk.
    let driftNote = "";
    if (snippet !== undefined && diskContents?.has(note)) {
      const content = diskContents.get(note);
      if (content === null || content === undefined) {
        snippet = undefined;
        driftNote = " (source no longer on disk — can't verify the quote)";
      } else if (!snippetOnDisk(snippet, content)) {
        snippet = undefined;
        driftNote = " (source changed since indexed — quote not shown)";
      }
    }
    // The "open to verify" target. An AD-HOC source supplies its own: the real
    // URL for a `--url` answer (openable in a browser), or `null` for an
    // ephemeral `--clipboard` answer (nothing to open — show no path rather than
    // a fabricated `.muse/notes/clipboard` the user can't open). A note / `--file`
    // is absent from the map and keeps its local path — preferring the matched
    // chunk's REAL path so an ad-hoc `--file` cited by basename still opens.
    const override = verifyTargets?.get(note);
    const target = override !== undefined
      ? override ?? undefined
      : hit && isAbsolute(hit.file) ? hit.file : isAbsolute(note) ? note : join(notesDir, note);
    return `   • ${lead}${snippet ? ` — "${snippet}"` : driftNote}${target ? `\n     ${target}` : ""}`;
  });
  return `\n📎 From your notes (open to verify):\n${blocks.join("\n")}\n`;
}

/** Coarse PAST age for a staleness hint — "9d ago" / "3w ago" / "8mo ago" / "2y ago". Pure. */
export function formatCoarseAge(ageMs: number): string {
  const days = Math.floor(ageMs / 86_400_000);
  if (days < 14) {
    return `${days.toString()}d ago`;
  }
  if (days < 60) {
    return `${Math.round(days / 7).toString()}w ago`;
  }
  if (days < 365) {
    return `${Math.round(days / 30).toString()}mo ago`;
  }
  const years = days / 365;
  return `${years.toFixed(years < 2 ? 1 : 0)}y ago`;
}

/**
 * Ages of the NOTE files an answer cited — so the caller can warn when a fact
 * was drawn from a stale note. Skips AD-HOC sources (--url/--clipboard carry
 * their own provenance) and DATED journal notes (the receipt already prints
 * "from your note of <date>", so recency is visible). A file that's gone is
 * skipped (never a false staleness claim). Mirrors `formatSourceReceipts`'s
 * note→path resolution.
 */
/**
 * Read the CURRENT on-disk content of each cited NOTE so `formatSourceReceipts`
 * can verify its quote against the file (L4: render-time disk-verify, not the
 * retrieval-index copy). A present note maps to its content, a gone/unreadable
 * one to `null` (the receipt then says "no longer on disk"). Ad-hoc sources
 * (`--url`/`--clipboard`/`--file` in `verifyTargets`) are skipped — they carry
 * their own provenance, not a local note to re-read. Mirrors the note→path
 * resolution of `collectCitedNoteAges`/`formatSourceReceipts` exactly.
 */
export async function buildDiskContents(
  answer: string,
  chunks: ReadonlyArray<{ readonly file: string; readonly text: string }>,
  notesDir: string,
  verifyTargets?: ReadonlyMap<string, string | null>
): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  for (const note of [...new Set(citedSourcesIn(answer))]) {
    if (verifyTargets?.has(note)) {
      continue;
    }
    const base = note.split("/").pop();
    const hit = chunks.find((c) => c.file === note || c.file.split("/").pop() === base);
    const filePath = hit && isAbsolute(hit.file) ? hit.file : isAbsolute(note) ? note : join(notesDir, note);
    try {
      out.set(note, await readFile(filePath, "utf8"));
    } catch {
      out.set(note, null);
    }
  }
  return out;
}

export async function collectCitedNoteAges(
  answer: string,
  chunks: ReadonlyArray<{ readonly file: string; readonly text: string }>,
  notesDir: string,
  now: Date,
  verifyTargets?: ReadonlyMap<string, string | null>
): Promise<{ readonly note: string; readonly ageMs: number }[]> {
  const out: { note: string; ageMs: number }[] = [];
  for (const note of [...new Set(citedSourcesIn(answer))]) {
    if (verifyTargets?.has(note) || provenanceDate(note) !== undefined) {
      continue;
    }
    const base = note.split("/").pop();
    const hit = chunks.find((c) => c.file === note || c.file.split("/").pop() === base);
    const filePath = hit && isAbsolute(hit.file) ? hit.file : isAbsolute(note) ? note : join(notesDir, note);
    try {
      const stats = await stat(filePath);
      out.push({ ageMs: now.getTime() - stats.mtimeMs, note });
    } catch {
      // file gone / unreadable — skip rather than assert a false age
    }
  }
  return out;
}

/**
 * The "shows its work" staleness heads-up: when a grounded answer cited a note
 * last edited longer ago than `thresholdMs`, name it + how old it is so the user
 * can judge whether the fact still holds. Empty when every cited note is fresh.
 * Pure.
 */
export function formatStalenessWarning(ages: readonly { readonly note: string; readonly ageMs: number }[], thresholdMs: number): string {
  const stale = ages.filter((age) => age.ageMs > thresholdMs).sort((a, b) => b.ageMs - a.ageMs);
  if (stale.length === 0) {
    return "";
  }
  const parts = stale.map((age) => `${age.note} (${formatCoarseAge(age.ageMs)})`);
  return `\n⚠ Heads up — cited note${stale.length === 1 ? "" : "s"} last edited a while ago, so the fact may be out of date: ${parts.join(", ")}.\n`;
}

/**
 * Assemble the optional grounding sections of the `muse ask` prompt, OMITTING
 * any that have no content. An empty "(no pending reminders)" block both bloats
 * the small model's context (worsening lost-in-the-middle) and invites it to
 * parrot a spurious "[reminder: none]" citation — so a source the user has
 * nothing in this turn is left out entirely. The NOTES section is assembled
 * separately (always present — it's the primary surface). Pure + testable.
 */
export function groundingSectionLines(
  sections: ReadonlyArray<{ readonly header: string; readonly body: string; readonly footer: string; readonly present: boolean }>
): string[] {
  return sections.flatMap((section) => (section.present ? [section.header, section.body, section.footer, ""] : []));
}

/**
 * One optional grounding source: its rendered block, whether it has content this
 * turn, and an OPTIONAL relevance/priority key used to edge-place it in the
 * cross-block grounding order (highest → HEAD/TAIL, lowest → middle), per
 * lost-in-the-middle / attention-basin (arXiv:2307.03172, arXiv:2508.05128).
 * When `relevance` is absent the deterministic per-kind priority tier
 * (`OPTIONAL_GROUNDING_TIER`) is used instead, so output is always stable.
 */
export interface OptionalGroundingSource {
  readonly body: string;
  readonly present: boolean;
  readonly relevance?: number;
}

/** The optional grounding sources, keyed by surface, in no particular order (render order is fixed below). */
export interface OptionalGroundingSources {
  readonly tasks: OptionalGroundingSource;
  readonly calendar: OptionalGroundingSource;
  readonly reminders: OptionalGroundingSource;
  readonly contacts: OptionalGroundingSource;
  readonly memories: OptionalGroundingSource;
  readonly shell: OptionalGroundingSource;
  readonly git: OptionalGroundingSource;
  readonly actions: OptionalGroundingSource;
  readonly episodes: OptionalGroundingSource;
  readonly feeds: OptionalGroundingSource;
  readonly reflection: OptionalGroundingSource;
}

/**
 * Deterministic fallback priority per optional source KIND, used to edge-place a
 * block when it carries no per-turn `relevance` score. Higher = more important =
 * closer to an edge (head/tail) of the optional region. Fixed + explicit so the
 * cross-block prompt order is stable run-to-run (NO stochastic ordering). The
 * ranking favours time-sensitive/actionable surfaces (tasks, calendar,
 * reminders, told-me-to-remember facts) over background context (feeds,
 * reflection). These tiers DON'T touch the user-facing "(grounded on …)" banner,
 * which keeps its own fixed source order.
 */
export const OPTIONAL_GROUNDING_TIER: Readonly<Record<keyof OptionalGroundingSources, number>> = {
  tasks: 100,
  reminders: 95,
  calendar: 90,
  memories: 85,
  contacts: 70,
  actions: 60,
  git: 55,
  shell: 50,
  episodes: 40,
  feeds: 30,
  reflection: 20
};

/**
 * Blend a block's per-kind priority TIER with its actual per-turn recall score
 * onto ONE 0-1 scale, for `edgePlaceByPriority`'s `relevance` input. The tier is
 * normalized against the highest tier so both operands share a 0-1 range (never
 * the 20–100 tier vs 0–1 score mix that would make the tier dominate).
 *
 * - `perTurnScore` absent → the normalized tier alone, so a score-less turn
 *   orders BYTE-IDENTICALLY to the fixed tier-only ordering (production no-op).
 * - present → an equal (W=0.5) blend of normalized tier and the clamped score,
 *   so a high per-turn match lifts a normally-mid-tier block toward an edge.
 *
 * Deterministic + pure (no Date/random); same inputs → same number.
 */
export function optionalGroundingRelevance(tierKey: keyof OptionalGroundingSources, perTurnScore?: number): number {
  const maxTier = Math.max(...Object.values(OPTIONAL_GROUNDING_TIER));
  const normalizedTier = OPTIONAL_GROUNDING_TIER[tierKey] / maxTier;
  if (perTurnScore == null) {
    return normalizedTier;
  }
  const W = 0.5;
  const clampedScore = Math.min(1, Math.max(0, perTurnScore));
  return normalizedTier * W + clampedScore * (1 - W);
}

interface OptionalGroundingSpec {
  readonly header: string;
  readonly body: string;
  readonly footer: string;
  readonly present: boolean;
}

/**
 * Edge-place present grounding blocks by a priority key: highest-priority blocks
 * land at the HEAD and TAIL of the sequence, lower-priority ones sink toward the
 * middle. This is the lost-in-the-middle / attention-basin mitigation applied
 * ACROSS blocks (arXiv:2307.03172, arXiv:2508.05128) — the same interleave Muse
 * already uses within a block (`reorderForLongContext`). Pure, deterministic and
 * STABLE: ties keep input order (Array.prototype.sort is stable), so the same
 * present set always renders in the same order. Set-invariant: returns exactly
 * the input specs, each once, none added or dropped.
 */
function edgePlaceByPriority(
  specs: ReadonlyArray<{ readonly spec: OptionalGroundingSpec; readonly priority: number }>
): OptionalGroundingSpec[] {
  const sorted = specs.map((s, i) => ({ ...s, i })).sort((a, b) => b.priority - a.priority || a.i - b.i);
  const front: OptionalGroundingSpec[] = [];
  const back: OptionalGroundingSpec[] = [];
  sorted.forEach((entry, rank) => {
    (rank % 2 === 0 ? front : back).push(entry.spec);
  });
  return [...front, ...back.reverse()];
}

/**
 * The PRESENT optional grounding-prompt sections, edge-placed by relevance so the
 * highest-priority blocks sit at the head/tail of the optional region (lower ones
 * sink to the middle) — the cross-block lost-in-the-middle mitigation. Absent
 * sections are omitted entirely (an empty block bloats the small model's prompt
 * and invites a spurious "[reminder: none]"-style citation). Each spec carries
 * its own `relevance` when supplied, else a fixed per-kind tier
 * (`OPTIONAL_GROUNDING_TIER`); output is deterministic and stable. (The notes
 * section is always present, the anchored primary, and assembled separately — it
 * is NOT part of this reorder.) Feed to groundingSectionLines.
 */
export function optionalGroundingSections(
  sources: OptionalGroundingSources
): OptionalGroundingSpec[] {
  const all: Array<{ readonly kind: keyof OptionalGroundingSources; readonly spec: OptionalGroundingSpec; readonly source: OptionalGroundingSource }> = [
    { kind: "tasks", source: sources.tasks, spec: { body: sources.tasks.body, footer: "=== END TASKS ===", header: "=== USER OPEN TASKS (sorted by due date, most imminent first) ===", present: sources.tasks.present } },
    { kind: "calendar", source: sources.calendar, spec: { body: sources.calendar.body, footer: "=== END CALENDAR ===", header: "=== UPCOMING CALENDAR EVENTS (sorted chronologically) ===", present: sources.calendar.present } },
    { kind: "reminders", source: sources.reminders, spec: { body: sources.reminders.body, footer: "=== END REMINDERS ===", header: "=== PENDING REMINDERS (sorted by due date) ===", present: sources.reminders.present } },
    { kind: "contacts", source: sources.contacts, spec: { body: sources.contacts.body, footer: "=== END CONTACTS ===", header: "=== MATCHING CONTACTS (from your address book) ===", present: sources.contacts.present } },
    { kind: "memories", source: sources.memories, spec: { body: sources.memories.body, footer: "=== END REMEMBERED FACTS ===", header: "=== FACTS YOU TOLD MUSE TO REMEMBER (cite as [memory: <topic>]) ===", present: sources.memories.present } },
    { kind: "shell", source: sources.shell, spec: { body: sources.shell.body, footer: "=== END SHELL COMMANDS ===", header: "=== MATCHING SHELL COMMANDS (from your shell history) ===", present: sources.shell.present } },
    { kind: "git", source: sources.git, spec: { body: sources.git.body, footer: "=== END GIT COMMITS ===", header: "=== YOUR RECENT GIT COMMITS (from this repo, newest first) ===", present: sources.git.present } },
    { kind: "actions", source: sources.actions, spec: { body: sources.actions.body, footer: "=== END ACTIONS ===", header: "=== ACTIONS MUSE HAS TAKEN ON YOUR BEHALF (your audit log) ===", present: sources.actions.present } },
    { kind: "episodes", source: sources.episodes, spec: { body: sources.episodes.body, footer: "=== END PAST SESSIONS ===", header: "=== PAST SESSION SUMMARIES (your prior conversations) ===", present: sources.episodes.present } },
    { kind: "feeds", source: sources.feeds, spec: { body: sources.feeds.body, footer: "=== END FEED HEADLINES ===", header: "=== RECENT FEED HEADLINES (your watched RSS/Atom feeds, newest first) ===", present: sources.feeds.present } },
    { kind: "reflection", source: sources.reflection, spec: { body: sources.reflection.body, footer: "=== END NOTICED ===", header: "=== WHAT MUSE HAS NOTICED ABOUT YOU (high-level, from past sessions) ===", present: sources.reflection.present } }
  ];
  // `present` is set by the caller from a match-COUNT (e.g. matchedContacts.length > 0)
  // while `body` is a separately-rendered string — decoupled, so a present:true block
  // can still carry an empty/whitespace body, which would emit a grounding HEADER with no
  // citable content: wasted context (doctrine 4) AND a citable-looking header backing
  // nothing (doctrine 2). Drop it — no source is lost (there is no content to lose).
  const present = all.filter((entry) => entry.spec.present && entry.spec.body.trim().length > 0);
  return edgePlaceByPriority(
    present.map((entry) => ({
      priority: entry.source.relevance ?? optionalGroundingRelevance(entry.kind),
      spec: entry.spec
    }))
  );
}

/** Per-source counts for the "(grounded on …)" citation banner. */
export interface GroundedSourceCounts {
  /** Pre-built note-chunk summary (chunk count + file names + confidence), or null when no notes matched. */
  readonly notesPart: string | null;
  readonly openTasks: number;
  readonly upcomingEvents: number;
  readonly pendingReminders: number;
  readonly contacts: number;
  readonly memories: number;
  readonly shellCommands: number;
  readonly gitCommits: number;
  readonly loggedActions: number;
  readonly pastSessions: number;
  readonly feedHeadlines: number;
}

/**
 * The "(grounded on …)" citation-banner parts, in source order: the note-chunk
 * summary first (when present), then one "N <label>" part per non-empty source.
 * The notes part is built by the caller (it lists file names + a confidence
 * suffix); the count-labelled parts live here. Pure + testable.
 */
export function groundedSourceSummary(counts: GroundedSourceCounts): string[] {
  const parts: string[] = [];
  if (counts.notesPart) {
    parts.push(counts.notesPart);
  }
  if (counts.openTasks > 0) {
    parts.push(`${counts.openTasks.toString()} open task(s)`);
  }
  if (counts.upcomingEvents > 0) {
    parts.push(`${counts.upcomingEvents.toString()} upcoming event(s)`);
  }
  if (counts.pendingReminders > 0) {
    parts.push(`${counts.pendingReminders.toString()} pending reminder(s)`);
  }
  if (counts.contacts > 0) {
    parts.push(`${counts.contacts.toString()} contact(s)`);
  }
  if (counts.memories > 0) {
    parts.push(`${counts.memories.toString()} remembered fact(s)`);
  }
  if (counts.shellCommands > 0) {
    parts.push(`${counts.shellCommands.toString()} shell command(s)`);
  }
  if (counts.gitCommits > 0) {
    parts.push(`${counts.gitCommits.toString()} git commit(s)`);
  }
  if (counts.loggedActions > 0) {
    parts.push(`${counts.loggedActions.toString()} logged action(s)`);
  }
  if (counts.pastSessions > 0) {
    parts.push(`${counts.pastSessions.toString()} past session(s)`);
  }
  if (counts.feedHeadlines > 0) {
    parts.push(`${counts.feedHeadlines.toString()} feed headline(s)`);
  }
  return parts;
}

/**
 * The "shows its work, FELT" receipt for the NON-note sources the answer cited
 * (S1 completion) — calendar / tasks / reminders / contacts / shell. Parses the
 * post-gate answer's `[event|task|reminder|contact|command: …]` markers (so only
 * real, surviving citations appear) and renders one grounded line each, grouped
 * by source. A source type with nothing configured this turn is skipped; a
 * refusal (citations already stripped) renders nothing. Pure (testable).
 */
export function formatNonNoteReceipts(
  answer: string,
  sources: {
    readonly events?: readonly string[];
    readonly tasks?: readonly string[];
    readonly reminders?: readonly string[];
    readonly contacts?: readonly string[];
    readonly commands?: readonly string[];
    readonly commits?: readonly string[];
    readonly memories?: readonly string[];
    readonly actions?: readonly string[];
    readonly feeds?: readonly string[];
    readonly sessions?: readonly string[];
  }
): string | undefined {
  const lines: string[] = [];
  const grab = (label: string, re: RegExp, allowed: readonly string[] | undefined): void => {
    if (!allowed || allowed.length === 0) {
      return;
    }
    const cited = new Set<string>();
    for (const match of answer.matchAll(re)) {
      const value = match[1]?.trim();
      if (value) {
        cited.add(value);
      }
    }
    for (const value of cited) {
      lines.push(`   ${label} ${value}`);
    }
  };
  grab("📅 from your calendar:", /\[event:\s*([^\]]+?)\s*\]/giu, sources.events);
  grab("✅ from your tasks:", /\[task:\s*([^\]]+?)\s*\]/giu, sources.tasks);
  grab("⏰ from your reminders:", /\[reminder:\s*([^\]]+?)\s*\]/giu, sources.reminders);
  grab("👤 from your contacts:", /\[contact:\s*([^\]]+?)\s*\]/giu, sources.contacts);
  grab("⌨️ from your shell history:", /\[command:\s*([^\]]+?)\s*\]/giu, sources.commands);
  grab("🔧 from your git commits:", /\[commit:\s*([^\]]+?)\s*\]/giu, sources.commits);
  grab("🧠 from what you told me:", /\[memory:\s*([^\]]+?)\s*\]/giu, sources.memories);
  grab("🤖 from your action log:", /\[action:\s*([^\]]+?)\s*\]/giu, sources.actions);
  grab("📰 from your feeds:", /\[feed:\s*([^\]]+?)\s*\]/giu, sources.feeds);
  grab("💬 from a past session:", /\[session:\s*([^\]]+?)\s*\]/giu, sources.sessions);
  if (lines.length === 0) {
    return undefined;
  }
  return `\n📎 Also grounded on:\n${lines.join("\n")}\n`;
}

/**
 * Relativize a note source against the notes dir so the form a recall answer is
 * ALLOWED to cite (the citation gate) EXACTLY matches the form the grounding
 * VERDICT validates against. A note on disk resolves to an ABSOLUTE path, but
 * the model is shown — and cites — the relative name; feeding the raw absolute
 * path to the verdict made citationValidity fail and falsely flagged a correct
 * cited answer "treat as unverified". One source of truth keeps gate + verdict
 * + receipt consistent.
 */
export function relativizeNoteSource(file: string, notesDir: string): string {
  if (!isAbsolute(file)) {
    return file;
  }
  const rel = relative(notesDir, file);
  // A path INSIDE the notes dir keeps its relative form (`projects/vpn.md`) so a
  // user with `a/notes.md` AND `b/notes.md` can tell the receipts apart. A path
  // that ESCAPES it (an ad-hoc `--file ~/work/RUNBOOK.md`) would otherwise cite
  // as `[from ../../../work/RUNBOOK.md]` — show the basename instead; the receipt
  // resolves the real openable path from the matched chunk's absolute file.
  return rel.startsWith("..") ? (file.split("/").pop() ?? rel) : rel;
}

/**
 * Keep only the note index files under a TOP-of-tree `scope` folder (relative to
 * the notes dir) — the engine behind `muse ask --scope work`, which grounds the
 * answer in just that collection instead of the whole corpus (less cross-domain
 * noise / false grounding). Matches a folder PREFIX (`work/…`), case-insensitive;
 * an empty scope returns everything. Pure.
 */
export function filterNotesByScope<T extends { readonly path: string }>(
  files: readonly T[],
  notesDir: string,
  scope: string
): readonly T[] {
  const norm = scope.trim().replace(/^[/\\]+|[/\\]+$/gu, "").replace(/\\/gu, "/").toLowerCase();
  if (norm.length === 0) {
    return files;
  }
  const prefix = `${norm}/`;
  return files.filter((file) => relativizeNoteSource(file.path, notesDir).replace(/\\/gu, "/").toLowerCase().startsWith(prefix));
}

/**
 * Build the <<note N>> context block from ranked note chunks, annotating any
 * detected value-conflict pair so the model receives reconciliation as DATA
 * rather than relying on a prompt instruction alone (arXiv:2504.19413,
 * Chhikara et al. 2025 — Mem0 contradiction-resolution, applied read-time).
 *
 * ADDITIVE ONLY: both notes always appear; the aIndex note carries a neutral ⚠
 * marker referencing bIndex by 1-based position. No recency claim is made —
 * score reflects query relevance, not recency. Never drops, reorders, or
 * rewrites any note.
 *
 * `contradictions` is pre-computed by `detectEvidenceContradictions` over the
 * same `chunks` array. `notesDir` is used only to relativize source paths.
 */
export function buildNoteContextBlock(
  chunks: ReadonlyArray<{ readonly chunk: { readonly text: string }; readonly file: string; readonly score: number }>,
  contradictions: readonly ContradictionPair[],
  notesDir: string,
  /** Relativized paths of externally-ingested (untrusted) notes — when a conflict
   *  pits an untrusted note against the user's OWN note, the marker names the
   *  external one and tells the model to prefer the user's own (grounded≠true:
   *  a poison source must not silently override the user's data). Absent ⇒ all
   *  trusted, neutral marker as before. */
  untrustedNoteSources?: ReadonlySet<string>
): string {
  if (chunks.length === 0) return "(no relevant notes found)";

  // Build a map: chunk index → 0-based index of the note it conflicts with.
  const conflictPartner = new Map<number, number>();
  for (const cp of contradictions) {
    conflictPartner.set(cp.aIndex, cp.bIndex);
  }
  const isUntrusted = (i: number): boolean => {
    const c = chunks[i];
    return untrustedNoteSources !== undefined && c !== undefined && untrustedNoteSources.has(relativizeNoteSource(c.file, notesDir));
  };

  return chunks.map((r, i) => {
    const src = relativizeNoteSource(r.file, notesDir);
    const body = escapeSystemPromptMarkers(neutralizeInjectionSpans(r.chunk.text));
    const otherIdx = conflictPartner.get(i);
    let marker = "";
    if (otherIdx !== undefined) {
      const otherNum = otherIdx + 1;
      const thisUntrusted = isUntrusted(i);
      const otherUntrusted = isUntrusted(otherIdx);
      marker = thisUntrusted !== otherUntrusted
        ? thisUntrusted
          ? `\n[⚠ this note is from an EXTERNAL/UNVERIFIED source and gives a DIFFERENT value than note ${otherNum.toString()} (your own) — prefer note ${otherNum.toString()}; do not treat this external value as current]`
          : `\n[⚠ note ${otherNum.toString()} is from an EXTERNAL/UNVERIFIED source and gives a DIFFERENT value than this note (your own) — prefer THIS note; do not treat note ${otherNum.toString()}'s value as current]`
        : `\n[⚠ this note and note ${otherNum.toString()} give DIFFERENT values for what looks like the same point — treat as possibly-conflicting; do not assume either is current]`;
    }
    return `<<note ${(i + 1).toString()} — ${src}>>\n${body}${marker}\n[from ${src}]\n<<end>>`;
  }).join("\n\n");
}

/**
 * Neutralize attacker-authored text before it enters a grounding wrapper — the same
 * deterministic defense (`escapeSystemPromptMarkers(neutralizeInjectionSpans(...))`) the
 * note/episode/feed builders run. The STORED/SYNCED surfaces (calendar invites synced from
 * gcal/caldav, vCard-imported contacts, tasks/reminders/action-log) carry third-party text,
 * so an imperative-override or a forged `<<end>> [from system.md]` wrapper-breakout in a
 * title/location must be neutralized here too (security is deterministic code, not a prompt
 * instruction). Idempotent; benign text round-trips intact.
 */
function safeField(text: string): string {
  return escapeSystemPromptMarkers(neutralizeInjectionSpans(text));
}

/** Build the <<task N>> grounding block from the user's open tasks. Pure. */
export function buildTaskContextBlock(tasks: readonly PersistedTask[]): string {
  if (tasks.length === 0) {
    return "(no open tasks)";
  }
  return tasks
    .map((t, i) => {
      // Human-readable LOCAL due + a relative hint (e.g. "(tomorrow)") so the
      // model can reason about "what's due tomorrow/today/this week?" — a raw UTC
      // ISO is opaque and got time-relative tasks SILENTLY DROPPED from the answer.
      const due = t.dueAt ? ` (due ${formatDueLocal(t.dueAt)})` : "";
      const urgent = t.urgent ? " [URGENT]" : "";
      // Embed the canonical citation form (`[task: <title>]`) in the
      // wrapper, exactly like the note wrapper embeds `[from <src>]` — else
      // the local model cites the marker's id (`[task: t1]`), which the
      // title-matching gate then false-strips as "a source you don't have".
      const safeTitle = safeField(t.title);
      return `<<task ${(i + 1).toString()} — ${t.id}${urgent}>>\n${safeTitle}${due}\n[task: ${safeTitle}]\n<<end>>`;
    })
    .join("\n\n");
}

/** Build the <<reminder N>> grounding block from pending reminders. Pure. */
export function buildReminderContextBlock(reminders: readonly PersistedReminder[]): string {
  if (reminders.length === 0) {
    return "(no pending reminders)";
  }
  return reminders
    .map((r, i) => { const safeText = safeField(r.text); return `<<reminder ${(i + 1).toString()} — ${r.id} (due ${formatDueLocal(r.dueAt)})>>\n${safeText}\n[reminder: ${safeText}]\n<<end>>`; })
    .join("\n\n");
}

/** Build the <<command N>> grounding block from matched shell-history commands. Pure. */
export function buildShellContextBlock(commands: readonly string[]): string {
  if (commands.length === 0) {
    return "(no matching shell commands)";
  }
  return commands
    .map((cmd, i) => `<<command ${(i + 1).toString()}>>\n${safeField(cmd)}\n<<end>>`)
    .join("\n\n");
}

/** Build the <<commit N>> grounding block from matched git commits. Pure. */
export function buildGitContextBlock(commits: readonly { readonly hash: string; readonly subject: string }[]): string {
  if (commits.length === 0) {
    return "(no matching git commits)";
  }
  return commits
    .map((c, i) => { const safeSubject = safeField(c.subject); return `<<commit ${(i + 1).toString()} — ${c.hash}>>\n${safeSubject}\n[commit: ${safeSubject}]\n<<end>>`; })
    .join("\n\n");
}

/** Build the <<action N>> grounding block from matched action-log entries. Pure. */
export function buildActionContextBlock(actions: readonly { readonly when: string; readonly what: string; readonly result: string; readonly detail?: string }[]): string {
  if (actions.length === 0) {
    return "(no matching actions)";
  }
  return actions
    .map((a, i) => `<<action ${(i + 1).toString()} — ${a.when.slice(0, 10)}>>\n${safeField(a.what)} — ${safeField(a.result)}${a.detail ? ` (${safeField(a.detail)})` : ""}\n<<end>>`)
    .join("\n\n");
}

/** Build the <<session N>> grounding block from ranked episode hits (untrusted summary escaped). Pure. */
export function buildEpisodeContextBlock(episodes: readonly { readonly id: string; readonly summary: string; readonly score: number }[]): string {
  if (episodes.length === 0) {
    return "(no relevant past sessions)";
  }
  return episodes
    .map((e, i) => `<<session ${(i + 1).toString()} — ${e.id} (score ${e.score.toFixed(3)})>>\n${escapeSystemPromptMarkers(neutralizeInjectionSpans(e.summary))}\n<<end>>`)
    .join("\n\n");
}

/** Build the <<feed N>> grounding block from recent feed headlines (untrusted title/summary escaped). Pure. */
export function buildFeedContextBlock(headlines: readonly { readonly feedName: string; readonly title: string; readonly publishedAt: string; readonly summary: string }[]): string {
  if (headlines.length === 0) {
    return "(no recent feed headlines)";
  }
  return headlines
    .map((h, i) => { const safeName = safeField(h.feedName); return `<<feed ${(i + 1).toString()} — ${safeName} (${h.publishedAt})>>\n${safeField(h.title)}${h.summary ? `\n${safeField(h.summary)}` : ""}\n[feed: ${safeName}]\n<<end>>`; })
    .join("\n\n");
}

/** Build the <<event N>> grounding block from upcoming calendar events. Pure. */
export function buildCalendarContextBlock(events: readonly { readonly title: string; readonly startsAt: Date; readonly endsAt: Date; readonly allDay: boolean; readonly location?: string; readonly providerId: string }[]): string {
  if (events.length === 0) {
    return "(no upcoming events)";
  }
  return events
    .map((e, i) => {
      // Show a HUMAN-readable local date, not the raw ISO: the small model
      // mis-derives the weekday from an ISO string (told the user the wrong
      // day), and its reformatted prose then fails the verdict's token
      // coverage. Hand it the rendered date it should echo (the system
      // locale/tz is the user's), keeping the ISO for unambiguous precision.
      const fmtWhen = (d: Date): string =>
        d.toLocaleString("en-US", { day: "numeric", hour: "numeric", minute: "2-digit", month: "long", weekday: "long", year: "numeric" });
      const when = e.allDay
        ? `${fmtWhen(e.startsAt)} (all-day, ${e.startsAt.toISOString().slice(0, 10)})`
        : `${fmtWhen(e.startsAt)} to ${fmtWhen(e.endsAt)} (${e.startsAt.toISOString()})`;
      const loc = e.location ? ` @ ${safeField(e.location)}` : "";
      const provider = `[${e.providerId}]`;
      const safeTitle = safeField(e.title);
      return `<<event ${(i + 1).toString()} — ${provider}>>\n${safeTitle}${loc}\n${when}\n[event: ${safeTitle}]\n<<end>>`;
    })
    .join("\n\n");
}
