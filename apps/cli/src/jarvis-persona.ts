/**
 * Build the JARVIS-style persona system prompt from a user-memory
 * snapshot. Two exports:
 *
 *   - `formatCurrentContextLine(now?)` — single-line "Current local
 *     context: YYYY-MM-DD HH:MM Weekday (TZ)." string. Injected by
 *     both `buildJarvisPersona` (when a persona exists) and the
 *     `muse ask` path (always, even with no persona) so the model
 *     never has to guess what "today" / "tomorrow" means.
 *
 *   - `buildJarvisPersona(memory, userId, options?)` — the full
 *     persona block: facts, plain preferences, vetoes, goals, and
 *     the 5 most-recent topics from prior sessions. Returns
 *     undefined when every section is empty so first-time users
 *     don't get a stub prompt.
 */

interface JarvisPersonaMemory {
  readonly facts: Readonly<Record<string, string>>;
  readonly preferences: Readonly<Record<string, string>>;
  readonly recentTopics?: readonly string[];
}

export function formatCurrentContextLine(now: Date = new Date()): string {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC";
  const dayOfWeek = now.toLocaleDateString("en-US", { weekday: "long", timeZone: tz });
  const dateStr = now.toLocaleDateString("en-CA", { timeZone: tz });
  const timeStr = now.toLocaleTimeString("en-GB", { hour: "2-digit", hour12: false, minute: "2-digit", timeZone: tz });
  return `Current local context: ${dateStr} ${timeStr} ${dayOfWeek} (${tz}).`;
}

export function buildJarvisPersona(
  memory: JarvisPersonaMemory,
  userId: string,
  options: { readonly now?: Date } = {}
): string | undefined {
  const facts = Object.entries(memory.facts);
  // Preferences encode three slot types: plain `pref.X`, `veto:X`
  // (things the user has refused), and `goal:X` (active objectives).
  // Split them so buildJarvisPersona renders each under its own
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
  if (facts.length === 0 && plainPrefs.length === 0 && vetoes.length === 0 && goals.length === 0 && recentTopics.length === 0) {
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
    for (const [key, value] of facts) lines.push(`  - ${key}: ${value}`);
  }
  if (plainPrefs.length > 0) {
    lines.push("");
    lines.push("Preferences:");
    for (const [key, value] of plainPrefs) lines.push(`  - ${key}: ${value}`);
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
  return lines.join("\n");
}

function dedupeNonEmpty(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of values) {
    const value = raw.trim();
    if (value.length === 0 || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}
