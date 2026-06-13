import { readFile, stat } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";

import { citedSourcesIn, lexicalOverlap, lexicalTokens, type ContradictionPair } from "@muse/agent-core";
import { escapeSystemPromptMarkers } from "./prompt-escape.js";
import { formatDueLocal, type PersistedReminder, type PersistedTask } from "@muse/mcp";

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
  notesDir: string
): string {
  if (chunks.length === 0) return "(no relevant notes found)";

  // Build a map: chunk index → 1-based label of the note it conflicts with.
  const conflictMarker = new Map<number, number>();
  for (const cp of contradictions) {
    conflictMarker.set(cp.aIndex, cp.bIndex + 1);
  }

  return chunks.map((r, i) => {
    const src = relativizeNoteSource(r.file, notesDir);
    const body = escapeSystemPromptMarkers(r.chunk.text);
    const otherNoteNum = conflictMarker.get(i);
    const marker = otherNoteNum !== undefined
      ? `\n[⚠ this note and note ${otherNoteNum.toString()} give DIFFERENT values for what looks like the same point — treat as possibly-conflicting; do not assume either is current]`
      : "";
    return `<<note ${(i + 1).toString()} — ${src}>>\n${body}${marker}\n[from ${src}]\n<<end>>`;
  }).join("\n\n");
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
      return `<<task ${(i + 1).toString()} — ${t.id}${urgent}>>\n${t.title}${due}\n[task: ${t.title}]\n<<end>>`;
    })
    .join("\n\n");
}

/** Build the <<reminder N>> grounding block from pending reminders. Pure. */
export function buildReminderContextBlock(reminders: readonly PersistedReminder[]): string {
  if (reminders.length === 0) {
    return "(no pending reminders)";
  }
  return reminders
    .map((r, i) => `<<reminder ${(i + 1).toString()} — ${r.id} (due ${formatDueLocal(r.dueAt)})>>\n${r.text}\n[reminder: ${r.text}]\n<<end>>`)
    .join("\n\n");
}

/** Build the <<command N>> grounding block from matched shell-history commands. Pure. */
export function buildShellContextBlock(commands: readonly string[]): string {
  if (commands.length === 0) {
    return "(no matching shell commands)";
  }
  return commands
    .map((cmd, i) => `<<command ${(i + 1).toString()}>>\n${cmd}\n<<end>>`)
    .join("\n\n");
}

/** Build the <<commit N>> grounding block from matched git commits. Pure. */
export function buildGitContextBlock(commits: readonly { readonly hash: string; readonly subject: string }[]): string {
  if (commits.length === 0) {
    return "(no matching git commits)";
  }
  return commits
    .map((c, i) => `<<commit ${(i + 1).toString()} — ${c.hash}>>\n${c.subject}\n[commit: ${c.subject}]\n<<end>>`)
    .join("\n\n");
}

/** Build the <<action N>> grounding block from matched action-log entries. Pure. */
export function buildActionContextBlock(actions: readonly { readonly when: string; readonly what: string; readonly result: string; readonly detail?: string }[]): string {
  if (actions.length === 0) {
    return "(no matching actions)";
  }
  return actions
    .map((a, i) => `<<action ${(i + 1).toString()} — ${a.when.slice(0, 10)}>>\n${a.what} — ${a.result}${a.detail ? ` (${a.detail})` : ""}\n<<end>>`)
    .join("\n\n");
}

/** Build the <<session N>> grounding block from ranked episode hits (untrusted summary escaped). Pure. */
export function buildEpisodeContextBlock(episodes: readonly { readonly id: string; readonly summary: string; readonly score: number }[]): string {
  if (episodes.length === 0) {
    return "(no relevant past sessions)";
  }
  return episodes
    .map((e, i) => `<<session ${(i + 1).toString()} — ${e.id} (score ${e.score.toFixed(3)})>>\n${escapeSystemPromptMarkers(e.summary)}\n<<end>>`)
    .join("\n\n");
}

/** Build the <<feed N>> grounding block from recent feed headlines (untrusted title/summary escaped). Pure. */
export function buildFeedContextBlock(headlines: readonly { readonly feedName: string; readonly title: string; readonly publishedAt: string; readonly summary: string }[]): string {
  if (headlines.length === 0) {
    return "(no recent feed headlines)";
  }
  return headlines
    .map((h, i) => `<<feed ${(i + 1).toString()} — ${h.feedName} (${h.publishedAt})>>\n${escapeSystemPromptMarkers(h.title)}${h.summary ? `\n${escapeSystemPromptMarkers(h.summary)}` : ""}\n[feed: ${h.feedName}]\n<<end>>`)
    .join("\n\n");
}
