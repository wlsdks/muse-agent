/**
 * Human-readable formatters for the personal-domain CLI commands.
 *
 * Default rendering when the user hasn't asked for `--json`. Mirrors
 * the style `muse today` already uses: short header, two-space
 * indentation, `[id-prefix]` labels, ISO timestamps trimmed to the
 * useful slice. ASCII only (no emojis — see CLAUDE.md).
 *
 * Each helper returns the full string ending in `\n` so the call
 * site can `io.stdout(formatted)` directly.
 */

import { isGoalKey, isVetoKey } from "@muse/recall";
import { isRecord } from "@muse/shared";

interface HumanTaskRow {
  readonly id: string;
  readonly title: string;
  readonly status?: string;
  readonly dueAt?: string;
  readonly completedAt?: string;
  readonly tags?: readonly string[];
  readonly urgent?: boolean;
}

export function formatTaskList(
  payload: { tasks: readonly HumanTaskRow[]; status?: string; total?: number },
  nowMs: number = Date.now()
): string {
  const tasks = payload.tasks;
  const status = payload.status ?? "open";
  if (tasks.length === 0) {
    return `Tasks (${status}): (none)\n`;
  }
  const header = `Tasks (${tasks.length} ${status}):\n`;
  const lines = tasks.map((task) => formatTaskRow(task, nowMs));
  return `${header}${lines.join("\n")}\n`;
}

export function formatTaskAdded(task: HumanTaskRow): string {
  const dueLabel = task.dueAt ? `, due ${shortDateTime(task.dueAt)}` : "";
  return `Added [${shortId(task.id)}] ${task.title}${dueLabel}\n`;
}

export function formatTaskCompleted(task: HumanTaskRow): string {
  return `Completed [${shortId(task.id)}] ${task.title}\n`;
}

export function formatProvidersList(label: string, providers: ReadonlyArray<{
  readonly id: string;
  readonly local?: boolean;
  readonly displayName?: string;
  readonly description?: string;
}>): string {
  if (providers.length === 0) {
    return `${label}: (none configured)\n`;
  }
  const header = `${label} (${providers.length}):\n`;
  const lines = providers.map((provider) => {
    const name = provider.displayName ?? provider.id;
    const localBadge = provider.local ? " [local]" : "";
    return `  - ${provider.id}${localBadge} — ${name}`;
  });
  return `${header}${lines.join("\n")}\n`;
}

interface HumanNoteListEntry {
  readonly name: string;
  readonly isDirectory: boolean;
  readonly sizeBytes?: number;
}

export function formatNotesList(payload: { dir: string; entries: readonly HumanNoteListEntry[]; truncated?: boolean }): string {
  const dirLabel = payload.dir.length > 0 ? payload.dir : "(notes root)";
  if (payload.entries.length === 0) {
    return `${dirLabel}: (empty)\n`;
  }
  const header = `${dirLabel}:\n`;
  const lines = payload.entries.map((entry) => {
    if (entry.isDirectory) {
      return `  ${entry.name}/`;
    }
    const size = typeof entry.sizeBytes === "number" ? ` (${formatBytes(entry.sizeBytes)})` : "";
    return `  ${entry.name}${size}`;
  });
  const tail = payload.truncated ? "\n  ... (truncated)" : "";
  return `${header}${lines.join("\n")}${tail}\n`;
}

export function formatNoteRead(payload: { content: string }): string {
  return payload.content.endsWith("\n") ? payload.content : `${payload.content}\n`;
}

export function formatNoteSearch(payload: { matches: readonly { path: string; line: number; snippet: string }[] }): string {
  if (payload.matches.length === 0) {
    return "No matches.\n";
  }
  const lines = payload.matches.map((match) => `${match.path}:${match.line}: ${match.snippet}`);
  return `${lines.join("\n")}\n`;
}

export function formatNoteSaved(payload: { path: string; sizeBytes?: number; created?: boolean }): string {
  const verb = payload.created ? "Created" : "Updated";
  const size = typeof payload.sizeBytes === "number" ? ` (${formatBytes(payload.sizeBytes)})` : "";
  return `${verb} ${payload.path}${size}\n`;
}

export function formatNoteAppended(payload: { path: string; sizeBytes?: number }): string {
  const size = typeof payload.sizeBytes === "number" ? ` (now ${formatBytes(payload.sizeBytes)})` : "";
  return `Appended to ${payload.path}${size}\n`;
}

interface HumanCalendarEvent {
  readonly id: string;
  readonly title: string;
  readonly startsAtIso: string;
  readonly endsAtIso?: string;
  readonly location?: string;
  readonly providerId?: string;
}

export function formatCalendarEvents(
  payload: { events: readonly HumanCalendarEvent[]; total?: number },
  timeZone?: string
): string {
  if (payload.events.length === 0) {
    return "Calendar: (no events in window)\n";
  }
  const groups = new Map<string, HumanCalendarEvent[]>();
  for (const event of payload.events) {
    const day = formatLocalDate(event.startsAtIso, timeZone);
    const bucket = groups.get(day);
    if (bucket) {
      bucket.push(event);
    } else {
      groups.set(day, [event]);
    }
  }
  const lines: string[] = [];
  for (const [day, events] of groups) {
    lines.push(`${day}`);
    for (const event of events) {
      const time = localClockOrEmpty(event.startsAtIso, timeZone);
      const endTime = event.endsAtIso ? localClockOrEmpty(event.endsAtIso, timeZone) : "";
      const end = endTime ? `–${endTime}` : "";
      const where = event.location ? `  @ ${event.location}` : "";
      const provider = event.providerId ? ` (${event.providerId})` : "";
      const id = event.id ? `[${event.id.slice(0, 8)}] ` : "";
      lines.push(`  ${id}${time}${end}  ${event.title}${where}${provider}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

/**
 * Local `HH:MM` for a timed ISO instant; empty for an all-day /
 * date-only event (no time component) so the renderer shows just
 * the title under its day, matching the prior `.slice(11,16)`
 * empty-on-date-only behaviour but in the host (or supplied) zone.
 */
function localClockOrEmpty(iso: string, timeZone?: string): string {
  if (!/T\d{2}:/u.test(iso)) {
    return "";
  }
  const clock = formatLocalTime(iso, timeZone);
  return /^\d{2}:\d{2}$/u.test(clock) ? clock : "";
}

interface HumanMemoryRecord {
  readonly userId?: string;
  readonly facts?: Record<string, string> | ReadonlyArray<{ readonly key: string; readonly value: string }>;
  readonly preferences?: Record<string, string> | ReadonlyArray<{ readonly key: string; readonly value: string }>;
  readonly recentTopics?: readonly string[];
  /**
   * Deterministic, source-cited lines of "what Muse recently learned about you"
   * (from @muse/memory's projectRecentlyLearned → renderRecentlyLearnedLines).
   * Each line carries its provenance citation; present only when the store has a
   * populated factHistory (the local/file path), absent on the server path.
   */
  readonly recentlyLearned?: readonly string[];
  /**
   * The FORGETS half: keys you had Muse forget at your correction
   * (from selectRecentlyForgotten over the recorded retraction markers), each
   * cited by the date. Present only on the local path; absent on the server path.
   */
  readonly recentlyForgotten?: readonly string[];
}

export function formatMemoryShow(record: HumanMemoryRecord | undefined | null): string {
  if (!record) {
    return "User memory: (empty)\n";
  }
  const lines: string[] = [`User memory${record.userId ? ` (${record.userId})` : ""}:`];
  appendKeyValueSection(lines, "Facts", record.facts);
  // Split preferences the way the persona block does: `veto:` and
  // `goal:` are not ordinary prefs — they're "never suggest this" and
  // "steer toward this". Lumping them under one raw-prefixed
  // "Preferences" heading meant the user couldn't audit what Muse will
  // REFUSE. Render each under its own heading with the prefix stripped.
  const prefEntries = record.preferences ? normalizeKeyValue(record.preferences) : [];
  const plainPrefs: { key: string; value: string }[] = [];
  const vetoes: { key: string; value: string }[] = [];
  const goals: { key: string; value: string }[] = [];
  for (const entry of prefEntries) {
    if (isVetoKey(entry.key)) {
      vetoes.push({ key: entry.key.slice(5), value: entry.value });
    } else if (isGoalKey(entry.key)) {
      goals.push({ key: entry.key.slice(5), value: entry.value });
    } else {
      plainPrefs.push(entry);
    }
  }
  appendKeyValueSection(lines, "Preferences", plainPrefs);
  appendKeyValueSection(lines, "Vetoes (never suggest)", vetoes);
  appendKeyValueSection(lines, "Goals", goals);
  if (record.recentTopics && record.recentTopics.length > 0) {
    lines.push("  Recent topics:");
    for (const topic of record.recentTopics) {
      lines.push(`    - ${topic}`);
    }
  }
  if (record.recentlyLearned && record.recentlyLearned.length > 0) {
    lines.push("  Recently learned about you:");
    for (const line of record.recentlyLearned) {
      lines.push(`    - ${line}`);
    }
  }
  if (record.recentlyForgotten && record.recentlyForgotten.length > 0) {
    lines.push("  Forgotten at your correction:");
    for (const line of record.recentlyForgotten) {
      lines.push(`    - ${line}`);
    }
  }
  if (lines.length === 1) {
    lines.push("  (empty)");
  }
  return `${lines.join("\n")}\n`;
}

function appendKeyValueSection(
  lines: string[],
  label: string,
  source: HumanMemoryRecord["facts"]
): void {
  if (!source) {
    return;
  }
  const entries = normalizeKeyValue(source);
  if (entries.length === 0) {
    return;
  }
  lines.push(`  ${label}:`);
  for (const entry of entries) {
    lines.push(`    ${entry.key}: ${entry.value}`);
  }
}

function normalizeKeyValue(
  source: NonNullable<HumanMemoryRecord["facts"]>
): readonly { key: string; value: string }[] {
  if (Array.isArray(source)) {
    return source.map((entry) => ({ key: entry.key, value: entry.value }));
  }
  if (!isRecord(source)) {
    return [];
  }
  const record = source;
  return Object.entries(record).map(([key, value]) => ({ key, value: String(value) }));
}

function formatTaskRow(task: HumanTaskRow, nowMs: number = Date.now()): string {
  const idTag = `[${shortId(task.id)}]`;
  const urgentBadge = task.urgent ? "⚠ " : "";
  const statusBadge = task.status === "done" ? " (done)" : "";
  // A not-done task past its dueAt is overdue — flag it so a late item is
  // scannable instead of blending in (parity with `muse remind list`).
  const dueMs = task.dueAt ? new Date(task.dueAt).getTime() : Number.NaN;
  const overdue = task.status !== "done" && Number.isFinite(dueMs) && dueMs < nowMs ? " (⚠ overdue)" : "";
  const dueLabel = task.dueAt ? `  due ${shortDateTime(task.dueAt)}${overdue}` : "";
  const tagsLabel = task.tags && task.tags.length > 0 ? `  #${task.tags.join(" #")}` : "";
  return `  - ${idTag} ${urgentBadge}${task.title}${statusBadge}${dueLabel}${tagsLabel}`;
}

function shortId(id: string): string {
  return id.length > 12 ? id.slice(0, 12) : id;
}

/**
 * Render a stored UTC ISO instant in the user's local timezone as
 * `YYYY-MM-DD HH:MM`. JARVIS UX: a user who types "tomorrow at 3pm"
 * in KST stores it as UTC internally — surfacing the UTC slice
 * ("2026-05-14 06:00") on the way out makes them re-do the
 * conversion in their head every time. We render local time so
 * what comes back matches what they said.
 *
 * `timeZone` overrides the host TZ (used by tests for determinism).
 * Precision-sensitive callers should pass `--json`.
 */
export function formatLocalDateTime(iso: string, timeZone?: string): string {
  if (iso.length < 16) {
    return iso;
  }
  const instant = new Date(iso);
  if (Number.isNaN(instant.getTime())) {
    return iso;
  }
  const parts = new Intl.DateTimeFormat("en-CA", {
    day: "2-digit",
    hour: "2-digit",
    hour12: false,
    minute: "2-digit",
    month: "2-digit",
    timeZone,
    year: "numeric"
  }).formatToParts(instant);
  const get = (type: Intl.DateTimeFormatPartTypes): string => parts.find((p) => p.type === type)?.value ?? "";
  const hour = get("hour") === "24" ? "00" : get("hour");
  return `${get("year")}-${get("month")}-${get("day")} ${hour}:${get("minute")}`;
}

/**
 * Date-only flavor of `formatLocalDateTime` — returns `YYYY-MM-DD`
 * in the host's local timezone. Useful for all-day events and
 * "Today:" headers where a UTC ISO date can be off by one day for
 * users west of GMT or east of the date line.
 */
// `formatLocalDateTime` passes an unparseable input straight
// through. A raw passthrough can be ≥10/≥16 chars too, so a
// length check would slice it into garbage ("not-a-date" /
// "strin"). Only carve the date/time out of the canonical
// `YYYY-MM-DD HH:MM` shape; otherwise degrade like the parent.
const CANONICAL_LOCAL_DATETIME = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/u;

export function formatLocalDate(iso: string, timeZone?: string): string {
  const dateTime = formatLocalDateTime(iso, timeZone);
  return CANONICAL_LOCAL_DATETIME.test(dateTime) ? dateTime.slice(0, 10) : dateTime;
}

/**
 * Time-only flavor of `formatLocalDateTime` — returns `HH:MM` in
 * the host's local timezone. Used for compact event-range and
 * reminder lines in `muse brief`.
 */
export function formatLocalTime(iso: string, timeZone?: string): string {
  const dateTime = formatLocalDateTime(iso, timeZone);
  return CANONICAL_LOCAL_DATETIME.test(dateTime) ? dateTime.slice(11, 16) : dateTime;
}

function shortDateTime(iso: string): string {
  return formatLocalDateTime(iso);
}

/**
 * Humanise an ISO timestamp relative to `now`.
 *
 *   ≤ 60 s   → "Ns ago"
 *   ≤ 60 min → "Nm ago"
 *   ≤ 24 h   → "Nh ago"
 *   ≤ 7 d    → "Nd ago"
 *   > 7 d    → the full local timestamp (falls back to
 *              `formatLocalDateTime` so the rest of the table
 *              stays consistent)
 *
 * Future timestamps mirror the structure with an "in N…" prefix
 * — useful for next-reminder hints. Invalid inputs are returned
 * verbatim so the caller still sees something.
 */
export function formatRelativeTime(iso: string, now: Date = new Date(), timeZone?: string): string {
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return iso;
  const diffMs = then.getTime() - now.getTime();
  const absSec = Math.abs(diffMs) / 1000;
  const past = diffMs < 0;

  const pick = (n: number, unit: string): string => `${past ? "" : "in "}${n.toString()}${unit}${past ? " ago" : ""}`;

  if (absSec < 5) return past ? "just now" : "in a moment";
  // Promote on the ROUNDED value, not the raw ratio: 59.6s must
  // read "1m ago", not "60s ago" (likewise 60m→1h, 24h→1d). A tier
  // whose rounded count hits its ceiling falls through to the next.
  const sec = Math.round(absSec);
  if (sec < 60) return pick(sec, "s");
  const min = Math.round(absSec / 60);
  if (min < 60) return pick(min, "m");
  const hr = Math.round(absSec / 3600);
  if (hr < 24) return pick(hr, "h");
  const day = Math.round(absSec / 86400);
  if (day <= 7) return pick(day, "d");
  // > 7 days: defer to the absolute formatter so the table stays
  // readable (we're not going to invent "2 weeks ago" precision
  // when the ISO is right there).
  return formatLocalDateTime(iso, timeZone);
}

export function formatCitations(
  citations: ReadonlyArray<{ url: string; title: string }> | undefined
): string {
  if (!citations || citations.length === 0) return "";
  const lines = citations.map((c, i) => `  [${i + 1}] ${c.title} — ${c.url}`);
  return `\n\nSources:\n${lines.join("\n")}`;
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) {
    return "size unknown";
  }
  if (bytes < 1024) {
    return `${bytes}B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)}KB`;
  }
  if (bytes < 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  }
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)}GB`;
}
