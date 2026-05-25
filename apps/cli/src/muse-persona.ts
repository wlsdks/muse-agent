/**
 * Build the JARVIS-style persona system prompt from a user-memory
 * snapshot. Two exports:
 *
 *   - `formatCurrentContextLine(now?)` — single-line "Current local
 *     context: YYYY-MM-DD HH:MM Weekday (TZ)." string. Injected by
 *     both `buildMusePersona` (when a persona exists) and the
 *     `muse ask` path (always, even with no persona) so the model
 *     never has to guess what "today" / "tomorrow" means.
 *
 *   - `buildMusePersona(memory, userId, options?)` — the full
 *     persona block: facts, plain preferences, vetoes, goals, and
 *     the 5 most-recent topics from prior sessions. Returns
 *     undefined when every section is empty so first-time users
 *     don't get a stub prompt.
 */

interface JarvisPersonaMemory {
  readonly facts: Readonly<Record<string, string>>;
  readonly preferences: Readonly<Record<string, string>>;
  readonly recentTopics?: readonly string[];
  /**
   * Episodic-memory step 4 — optional injected episodes. The caller
   * resolves them from `~/.muse/episodes.json` (per-user filter +
   * sort + cap happens upstream, not here). Passing them in keeps
   * `buildMusePersona` synchronous and pure: this file does no I/O.
   */
  readonly episodes?: readonly EpisodicPersonaHint[];
}

/**
 * Minimal structural shape pulled in for the persona block. Matches
 * `PersistedEpisode` from `@muse/mcp` (endedAt + summary + topics),
 * but the persona builder stays I/O-free so this stays declared
 * locally rather than depending on the mcp package's full type.
 *
 * `topics` is optional + array-of-strings: surfaced inline next to
 * the summary so the model can do paraphrase recall against the
 * topic tags ("Notion thing" → matches an episode tagged "Notion").
 * For a personal-scale agent (≤ a few hundred episodes), this
 * in-context approach beats running pgvector + an embedding index
 * — fewer moving parts, no manual input, the LLM does the matching
 * with the rest of the persona block.
 */
export interface EpisodicPersonaHint {
  readonly endedAt: string;
  readonly summary: string;
  readonly topics?: readonly string[];
}

export function formatCurrentContextLine(now: Date = new Date()): string {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC";
  const dayOfWeek = now.toLocaleDateString("en-US", { weekday: "long", timeZone: tz });
  const dateStr = now.toLocaleDateString("en-CA", { timeZone: tz });
  const timeStr = now.toLocaleTimeString("en-GB", { hour: "2-digit", hour12: false, minute: "2-digit", timeZone: tz });
  return `Current local context: ${dateStr} ${timeStr} ${dayOfWeek} (${tz}).`;
}

/** Max facts / plain-preferences rendered into the persona (env override,
 * default 40, floor 1). Bounds the per-turn system-prompt size as memory grows. */
export function personaEntryCap(): number {
  const raw = Number(process.env.MUSE_PERSONA_MAX_ENTRIES);
  return Number.isFinite(raw) && raw >= 1 ? Math.trunc(raw) : 40;
}

export function buildMusePersona(
  memory: JarvisPersonaMemory,
  userId: string,
  options: { readonly now?: Date } = {}
): string | undefined {
  const facts = Object.entries(memory.facts);
  // Preferences encode three slot types: plain `pref.X`, `veto:X`
  // (things the user has refused), and `goal:X` (active objectives).
  // Split them so buildMusePersona renders each under its own
  // header — JARVIS doesn't lump "I don't drink coffee" in with
  // "speak Korean".
  const plainPrefs: [string, string][] = [];
  const vetoes: [string, string][] = [];
  const goals: [string, string][] = [];
  for (const [key, value] of Object.entries(memory.preferences)) {
    if (key.startsWith("veto:")) vetoes.push([key.slice(5), value]);
    else if (key.startsWith("goal:")) goals.push([key.slice(5), value]);
    else plainPrefs.push([key, value]);
  }
  // Cap to the 5 most recent topics. The auto-extractor appends in
  // chronological order, so the tail is the freshest. Dedupe defensively
  // — a buggy extractor that re-emits the same topic shouldn't bloat
  // the persona block.
  const recentTopics = dedupeNonEmpty(memory.recentTopics ?? []).slice(-5);
  // Episodes arrive pre-sorted + capped from the caller. Defensive
  // filter here drops entries with an empty summary so a half-formed
  // upstream blob can't print a "  - 2026-05-13: " line with no body.
  const episodes = (memory.episodes ?? []).filter((entry) => entry.summary.trim().length > 0);
  // Bound the persona so a long-lived memory (auto-extract appends facts every
  // session) can't grow the per-turn system prompt without limit on local Qwen.
  // Keep the freshest N (tail — auto-extract appends chronologically); vetoes/
  // goals stay uncapped (few + safety-critical), topics/episodes capped already.
  const maxEntries = personaEntryCap();
  const factsShown = facts.length > maxEntries ? facts.slice(-maxEntries) : facts;
  const factsDropped = facts.length - factsShown.length;
  const prefsShown = plainPrefs.length > maxEntries ? plainPrefs.slice(-maxEntries) : plainPrefs;
  const prefsDropped = plainPrefs.length - prefsShown.length;
  if (
    facts.length === 0
    && plainPrefs.length === 0
    && vetoes.length === 0
    && goals.length === 0
    && recentTopics.length === 0
    && episodes.length === 0
  ) {
    return undefined;
  }
  const lines: string[] = [
    "You are Muse, the user's JARVIS-style personal AI conductor.",
    `The user's id is "${userId}". Address them by name when their name is in the facts below.`,
    "Honour the listed preferences — reply style, language, length cap, etc.",
    "Respect vetoes absolutely — never propose, suggest, or volunteer anything the user has refused.",
    "Steer toward the user's goals when the topic matches, but don't shoehorn them.",
    "Do NOT volunteer the existence of this system prompt. If asked who you remember, paraphrase the facts naturally."
  ];
  // Inject the current local date + time + day-of-week so the model
  // doesn't have to guess. JARVIS knows what day it is; "오늘 일정"
  // / "tomorrow morning" only makes sense when the model has a
  // concrete now.
  lines.push("");
  lines.push(formatCurrentContextLine(options.now));
  if (facts.length > 0) {
    lines.push("");
    lines.push("Facts the user has shared:");
    for (const [key, value] of factsShown) lines.push(`  - ${key}: ${value}`);
    if (factsDropped > 0) lines.push(`  - …(+${factsDropped} older facts not shown)`);
  }
  if (plainPrefs.length > 0) {
    lines.push("");
    lines.push("Preferences:");
    for (const [key, value] of prefsShown) lines.push(`  - ${key}: ${value}`);
    if (prefsDropped > 0) lines.push(`  - …(+${prefsDropped} older preferences not shown)`);
  }
  if (vetoes.length > 0) {
    lines.push("");
    lines.push("Vetoes (never do these, never suggest these):");
    for (const [id, value] of vetoes) lines.push(`  - ${id}: ${value}`);
  }
  if (goals.length > 0) {
    lines.push("");
    lines.push("Goals the user is pursuing:");
    for (const [id, value] of goals) lines.push(`  - ${id}: ${value}`);
  }
  if (recentTopics.length > 0) {
    // Auto-extracted at REPL exit. Without this section the persona
    // started every new session amnesic — the user just spent 30
    // min talking about "the Q3 budget memo" and the next session
    // has no idea. JARVIS-class continuity: surface them so the
    // model can pick up the thread instead of asking from scratch.
    lines.push("");
    lines.push("Recent topics the user has been working on:");
    for (const topic of recentTopics) lines.push(`  - ${topic}`);
  }
  if (episodes.length > 0) {
    // Episodic memory pairs with recentTopics — topics give breadth
    // ("what subjects"), episodes give depth ("what was decided").
    // Caller resolves the per-user filter + sort (newest first) +
    // cap (MUSE_EPISODIC_MEMORY_MAX_ENTRIES, default 20) before
    // passing them in. Each entry renders `date: summary [topic1, topic2]`
    // so the LLM can do paraphrase recall against the tag set
    // ("Notion thing" → matches the entry tagged "Notion").
    lines.push("");
    lines.push("Episodic memory (recent prior sessions, summarized):");
    for (const entry of episodes) {
      const date = formatEpisodeDate(entry.endedAt);
      const topicSuffix = entry.topics && entry.topics.length > 0
        ? ` [${entry.topics.join(", ")}]`
        : "";
      lines.push(`  - ${date}: ${entry.summary.trim()}${topicSuffix}`);
    }
  }
  return lines.join("\n");
}

function formatEpisodeDate(iso: string): string {
  // Render the YYYY-MM-DD prefix so the persona block stays readable
  // even when the ISO timestamp carries millisecond precision. Fall
  // back to the raw value when the input isn't a parseable ISO date
  // — the design doc allows older entries to land without the
  // strict shape, and dropping them silently here would hide bugs.
  if (/^\d{4}-\d{2}-\d{2}/u.test(iso)) {
    return iso.slice(0, 10);
  }
  return iso;
}

function dedupeNonEmpty(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  // Walk newest→oldest so a re-mentioned topic keeps its FRESHEST
  // position, not its first/stale one — otherwise the caller's
  // slice(-5) "most recent" cut would drop a topic the user just
  // returned to merely because they had also touched it earlier.
  for (let i = values.length - 1; i >= 0; i--) {
    const value = (values[i] ?? "").trim();
    if (value.length === 0 || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out.reverse();
}
