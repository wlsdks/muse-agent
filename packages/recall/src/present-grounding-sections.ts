/**
 * Optional-grounding assembly for the `muse ask` prompt: which non-note
 * sources are offered, their tier ordering, and how the resulting source
 * counts are summarised back to the user. Pure and testable — no I/O.
 */

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
  readonly flows: OptionalGroundingSource;
  readonly memories: OptionalGroundingSource;
  readonly shell: OptionalGroundingSource;
  readonly git: OptionalGroundingSource;
  readonly actions: OptionalGroundingSource;
  readonly episodes: OptionalGroundingSource;
  readonly feeds: OptionalGroundingSource;
  readonly browsing: OptionalGroundingSource;
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
  flows: 65,
  actions: 60,
  git: 55,
  shell: 50,
  episodes: 40,
  feeds: 30,
  browsing: 35,
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
    { kind: "flows", source: sources.flows, spec: { body: sources.flows.body, footer: "=== END AUTOMATIONS ===", header: "=== YOUR AUTOMATIONS (Builder flows & scheduled jobs; cite as [flow: <name>]) ===", present: sources.flows.present } },
    { kind: "memories", source: sources.memories, spec: { body: sources.memories.body, footer: "=== END REMEMBERED FACTS ===", header: "=== FACTS YOU TOLD MUSE TO REMEMBER (cite as [memory: <topic>]) ===", present: sources.memories.present } },
    { kind: "shell", source: sources.shell, spec: { body: sources.shell.body, footer: "=== END SHELL COMMANDS ===", header: "=== MATCHING SHELL COMMANDS (from your shell history) ===", present: sources.shell.present } },
    { kind: "git", source: sources.git, spec: { body: sources.git.body, footer: "=== END GIT COMMITS ===", header: "=== YOUR RECENT GIT COMMITS (from this repo, newest first) ===", present: sources.git.present } },
    { kind: "actions", source: sources.actions, spec: { body: sources.actions.body, footer: "=== END ACTIONS ===", header: "=== ACTIONS MUSE HAS TAKEN ON YOUR BEHALF (your audit log) ===", present: sources.actions.present } },
    { kind: "episodes", source: sources.episodes, spec: { body: sources.episodes.body, footer: "=== END PAST SESSIONS ===", header: "=== PAST SESSION SUMMARIES (your prior conversations) ===", present: sources.episodes.present } },
    { kind: "feeds", source: sources.feeds, spec: { body: sources.feeds.body, footer: "=== END FEED HEADLINES ===", header: "=== RECENT FEED HEADLINES (your watched RSS/Atom feeds, newest first) ===", present: sources.feeds.present } },
    { kind: "browsing", source: sources.browsing, spec: { body: sources.browsing.body, footer: "=== END BROWSING HISTORY ===", header: "=== PAGES YOU VISITED (your local Chrome browsing history matching this question) ===", present: sources.browsing.present } },
    { kind: "reflection", source: sources.reflection, spec: { body: sources.reflection.body, footer: "=== END NOTICED ===", header: "=== WHAT MUSE HAS NOTICED ABOUT YOU (high-level, from past sessions) ===", present: sources.reflection.present } }
  ];
  // `present` is set by the caller from a match-COUNT (e.g. matchedContacts.length > 0)
  // while `body` is a separately-rendered string — decoupled, so a present:true block
  // can still carry an empty/whitespace body, which would emit a grounding HEADER with no
  // citable content: wasted context AND a citable-looking header backing
  // nothing. Drop it — no source is lost (there is no content to lose).
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
  readonly automationFlows: number;
  readonly memories: number;
  readonly shellCommands: number;
  readonly gitCommits: number;
  readonly loggedActions: number;
  readonly pastSessions: number;
  readonly feedHeadlines: number;
  readonly browsingVisits: number;
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
  if (counts.automationFlows > 0) {
    parts.push(`${counts.automationFlows.toString()} automation(s)`);
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
  if (counts.browsingVisits > 0) {
    parts.push(`${counts.browsingVisits.toString()} page(s) you visited`);
  }
  return parts;
}

/**
 * The "shows its work, FELT" receipt for the NON-note sources the answer cited
 * — calendar / tasks / reminders / contacts / shell. Parses the
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
    readonly flows?: readonly string[];
    readonly feeds?: readonly string[];
    readonly browsing?: readonly string[];
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
  grab("⚙️ from your automations:", /\[flow:\s*([^\]]+?)\s*\]/giu, sources.flows);
  grab("📰 from your feeds:", /\[feed:\s*([^\]]+?)\s*\]/giu, sources.feeds);
  grab("🌐 from pages you visited:", /\[browsing:\s*([^\]]+?)\s*\]/giu, sources.browsing);
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
