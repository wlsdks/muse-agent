/**
 * Unified activity feed — pure-data helper consumed by both the
 * `muse history` CLI command and the `muse.history` loopback MCP
 * server. Merges the five personal-JARVIS audit stores into one
 * chronological feed (newest first).
 *
 * Inputs are paths (so the helper stays env-agnostic). Each store
 * read is fail-soft — a missing file returns an empty array rather
 * than collapsing the whole feed.
 *
 * Includes-only rules:
 *   - reminder-history → every entry (status: delivered | failed)
 *   - proactive-history → every entry (status: delivered | failed)
 *   - followups → only rows with `status === "fired"` AND a `firedAt`
 *     timestamp (scheduled/cancelled rows belong to `muse.followups.list`)
 *   - patterns-fired → every row with a valid `firedAtMs`
 *   - episodes → every row with a valid `endedAt`
 *
 * Sort: most-recent first by parsed instant (not raw ISO string,
 * so mixed precision / offset across the merged sources still
 * orders correctly). Caller decides the post-sort cap.
 */

import { promises as fs } from "node:fs";

import { readFollowups, type PersistedFollowup } from "@muse/stores";
import { readProactiveHistory } from "@muse/stores";
import { readReminderHistory } from "@muse/stores";

export type ActivityKind = "reminder" | "proactive" | "followup" | "pattern" | "episode";

export interface ActivityEntry {
  readonly kind: ActivityKind;
  readonly whenIso: string;
  readonly summary: string;
  readonly status?: string;
  readonly providerId?: string;
  readonly destination?: string;
  readonly id?: string;
}

export interface ReadActivityFeedOptions {
  readonly reminderHistoryFile?: string;
  readonly proactiveHistoryFile?: string;
  readonly followupsFile?: string;
  readonly patternsFiredFile?: string;
  readonly episodesFile?: string;
  /** Restrict to a single source. Undefined → all five. */
  readonly kind?: ActivityKind;
  /** Drop entries older than this epoch-ms. Undefined → no floor. */
  readonly sinceMs?: number;
  /** Max entries returned. Caller validates the bound; helper just slices. */
  readonly limit?: number;
}

interface PatternFiredRow {
  readonly patternId?: unknown;
  readonly firedAtMs?: unknown;
  readonly suggestion?: unknown;
}

interface EpisodeRow {
  readonly id?: unknown;
  readonly endedAt?: unknown;
  readonly summary?: unknown;
}

async function safeReadJson(path: string): Promise<unknown | undefined> {
  try {
    const raw = await fs.readFile(path, "utf8");
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

async function readReminderActivity(file: string | undefined): Promise<readonly ActivityEntry[]> {
  if (!file) return [];
  const rows = await readReminderHistory(file).catch(() => [] as const);
  return rows.map((row): ActivityEntry => ({
    destination: row.destination,
    id: row.reminderId,
    kind: "reminder",
    providerId: row.providerId,
    status: row.status,
    summary: row.text,
    whenIso: row.firedAtIso
  }));
}

async function readProactiveActivity(file: string | undefined): Promise<readonly ActivityEntry[]> {
  if (!file) return [];
  const rows = await readProactiveHistory(file).catch(() => [] as const);
  return rows.map((row): ActivityEntry => ({
    destination: row.destination,
    id: row.itemId,
    kind: "proactive",
    providerId: row.providerId,
    status: row.status,
    summary: row.text || row.title,
    whenIso: row.firedAtIso
  }));
}

async function readFollowupActivity(file: string | undefined): Promise<readonly ActivityEntry[]> {
  if (!file) return [];
  const rows = await readFollowups(file).catch(() => [] as const);
  return rows
    .filter((row: PersistedFollowup) => row.status === "fired" && typeof row.firedAt === "string")
    .map((row): ActivityEntry => ({
      id: row.id,
      kind: "followup",
      status: "fired",
      summary: row.summary,
      whenIso: row.firedAt as string
    }));
}

async function readPatternActivity(file: string | undefined): Promise<readonly ActivityEntry[]> {
  if (!file) return [];
  const doc = await safeReadJson(file) as { fired?: readonly PatternFiredRow[] } | undefined;
  const rows = doc?.fired ?? [];
  return rows.flatMap((row): readonly ActivityEntry[] => {
    // Number.isFinite(firedAtMs) isn't enough: a finite but
    // out-of-range ms makes an Invalid Date whose toISOString()
    // throws, which would reject the whole feed's Promise.all.
    if (typeof row.patternId !== "string"
      || typeof row.firedAtMs !== "number"
      || !Number.isFinite(new Date(row.firedAtMs).getTime())) {
      return [];
    }
    return [{
      id: row.patternId,
      kind: "pattern",
      summary: typeof row.suggestion === "string" ? row.suggestion : `pattern ${row.patternId}`,
      whenIso: new Date(row.firedAtMs).toISOString()
    }];
  });
}

async function readEpisodeActivity(file: string | undefined): Promise<readonly ActivityEntry[]> {
  if (!file) return [];
  const doc = await safeReadJson(file) as { episodes?: readonly EpisodeRow[] } | undefined;
  const rows = doc?.episodes ?? [];
  return rows.flatMap((row): readonly ActivityEntry[] => {
    if (typeof row.id !== "string" || typeof row.endedAt !== "string" || typeof row.summary !== "string") {
      return [];
    }
    return [{
      id: row.id,
      kind: "episode",
      summary: row.summary,
      whenIso: row.endedAt
    }];
  });
}

export const ACTIVITY_KINDS: ReadonlySet<ActivityKind> = new Set([
  "reminder",
  "proactive",
  "followup",
  "pattern",
  "episode"
]);

export async function readActivityFeed(options: ReadActivityFeedOptions): Promise<readonly ActivityEntry[]> {
  const readers: ReadonlyArray<readonly [ActivityKind, () => Promise<readonly ActivityEntry[]>]> = [
    ["reminder", () => readReminderActivity(options.reminderHistoryFile)],
    ["proactive", () => readProactiveActivity(options.proactiveHistoryFile)],
    ["followup", () => readFollowupActivity(options.followupsFile)],
    ["pattern", () => readPatternActivity(options.patternsFiredFile)],
    ["episode", () => readEpisodeActivity(options.episodesFile)]
  ];
  const selected = options.kind
    ? readers.filter(([k]) => k === options.kind)
    : readers;
  const bundles = await Promise.all(selected.map(async ([, reader]) => reader()));
  const merged = bundles.flat().filter((entry) => {
    if (options.sinceMs === undefined) return true;
    const t = Date.parse(entry.whenIso);
    return Number.isFinite(t) && t >= options.sinceMs;
  });
  // Sort by parsed instant (newest first), NOT raw string: the
  // merged sources emit `whenIso` in heterogeneous ISO forms (raw
  // passthrough vs `toISOString()`), and lexicographic order is
  // wrong across mixed precision / timezone offsets — it would
  // interleave the feed out of true chronological order. Matches
  // the instant-based window filter just above. Unparseable values
  // keep the prior deterministic string order.
  merged.sort((left, right) => {
    const l = Date.parse(left.whenIso);
    const r = Date.parse(right.whenIso);
    if (Number.isFinite(l) && Number.isFinite(r)) {
      if (l !== r) {
        return r - l;
      }
    } else if (left.whenIso !== right.whenIso) {
      return right.whenIso.localeCompare(left.whenIso);
    }
    return 0;
  });
  return options.limit !== undefined ? merged.slice(0, options.limit) : merged;
}
