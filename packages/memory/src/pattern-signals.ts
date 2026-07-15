/**
 * Step 1 of `docs/design/pattern-detection.md` — gather the raw
 * signals the per-category detectors operate on. Pure data layer:
 * one shot reads three on-disk surfaces and returns a single
 * `PatternSignals` envelope.
 *
 * Sources:
 *   - `~/.muse/activity.jsonl` — append-only chat-bearing surface
 *     log written by the CLI (`commands-status`, `commands-ask`,
 *     etc. all stamp it). Each line is `{ kind, userId, tsIso }`.
 *   - `~/.muse/tasks.json` — task create/complete timestamps for
 *     the day-anchored detector (category 2 in the design doc).
 *     Parsed inline rather than re-using @muse/mcp's
 *     `readTasks` because @muse/memory must not depend on @muse/mcp
 *     (would invert the layering — memory sits below mcp).
 *   - `~/.muse/notes/**.md` — file mtimes from a recursive walk
 *     under the notes dir. Each entry carries the path-family
 *     (first directory segment under notes/, e.g. `journal` /
 *     `meeting-notes`) so the time-of-day detector can cluster
 *     by route without doing the slicing itself.
 *
 * Every source is independently tolerant:
 * missing path → empty array, malformed entry → silently dropped.
 * One corrupt task row does not sink the whole envelope.
 */

import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export interface ActivityEventSignal {
  readonly kind: string;
  readonly userId: string;
  readonly tsIso: string;
  /** Parsed for downstream convenience; not on disk. */
  readonly tsMs: number;
}

export interface TaskSignal {
  readonly id: string;
  readonly title: string;
  readonly status: "open" | "done";
  readonly createdAtMs: number;
  readonly completedAtMs?: number;
  readonly dueAtMs?: number;
}

export interface NoteMtimeSignal {
  /** Absolute path (or whatever the caller's `notesDir` resolves to). */
  readonly absPath: string;
  /** First directory segment under `notesDir` (e.g. "journal"). Empty when the note is at the root. */
  readonly pathFamily: string;
  readonly mtimeMs: number;
}

export interface PatternSignals {
  readonly activityEvents: readonly ActivityEventSignal[];
  readonly tasks: readonly TaskSignal[];
  readonly noteEdits: readonly NoteMtimeSignal[];
  /** Wall-clock the envelope was captured at; injected for deterministic tests. */
  readonly capturedAtMs: number;
}

export interface AggregateActivitySignalsOptions {
  /** Path to `activity.jsonl`. Falls back to `${homeDir}/.muse/activity.jsonl`. */
  readonly activityFile?: string;
  /** Path to `tasks.json`. Falls back to `${homeDir}/.muse/tasks.json`. */
  readonly tasksFile?: string;
  /** Directory containing `*.md` notes. Falls back to `${homeDir}/.muse/notes`. */
  readonly notesDir?: string;
  /** Used only when explicit paths are missing. Defaults to `process.env.HOME` (or `~`). */
  readonly homeDir?: string;
  /** Cut-off for retained events. Default: keep everything. */
  readonly sinceMs?: number;
  /** Injectable clock; defaults to `() => Date.now()`. */
  readonly now?: () => number;
}

const DEFAULT_NOTES_WALK_MAX_ENTRIES = 5_000;

export async function aggregateActivitySignals(options: AggregateActivitySignalsOptions = {}): Promise<PatternSignals> {
  const home = resolveAggregatorHome(options.homeDir);
  const activityFile = options.activityFile ?? path.join(home, ".muse", "activity.jsonl");
  const tasksFile = options.tasksFile ?? path.join(home, ".muse", "tasks.json");
  const notesDir = options.notesDir ?? path.join(home, ".muse", "notes");
  const now = options.now ?? (() => Date.now());
  const capturedAtMs = now();
  const sinceMs = options.sinceMs;

  const [activityEvents, tasks, noteEdits] = await Promise.all([
    readActivityEvents(activityFile, sinceMs),
    readTaskSignals(tasksFile, sinceMs),
    readNoteMtimes(notesDir, sinceMs)
  ]);

  return { activityEvents, capturedAtMs, noteEdits, tasks };
}

async function readActivityEvents(file: string, sinceMs?: number): Promise<readonly ActivityEventSignal[]> {
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch {
    return [];
  }
  const out: ActivityEventSignal[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    let parsed: unknown;
    try { parsed = JSON.parse(trimmed) as unknown; } catch { continue; }
    if (!parsed || typeof parsed !== "object") continue;
    const candidate = parsed as { kind?: unknown; userId?: unknown; tsIso?: unknown };
    if (typeof candidate.kind !== "string" || typeof candidate.userId !== "string" || typeof candidate.tsIso !== "string") {
      continue;
    }
    const tsMs = Date.parse(candidate.tsIso);
    if (!Number.isFinite(tsMs)) continue;
    if (sinceMs !== undefined && tsMs < sinceMs) continue;
    out.push({ kind: candidate.kind, tsIso: candidate.tsIso, tsMs, userId: candidate.userId });
  }
  return out;
}

async function readTaskSignals(file: string, sinceMs?: number): Promise<readonly TaskSignal[]> {
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch {
    return [];
  }
  let parsed: unknown;
  try { parsed = JSON.parse(raw) as unknown; } catch { return []; }
  if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as { tasks?: unknown }).tasks)) return [];
  const out: TaskSignal[] = [];
  for (const entry of (parsed as { tasks: unknown[] }).tasks) {
    if (!entry || typeof entry !== "object") continue;
    const candidate = entry as {
      id?: unknown;
      title?: unknown;
      status?: unknown;
      createdAt?: unknown;
      completedAt?: unknown;
      dueAt?: unknown;
    };
    if (
      typeof candidate.id !== "string"
      || typeof candidate.title !== "string"
      || typeof candidate.createdAt !== "string"
      || (candidate.status !== "open" && candidate.status !== "done")
    ) {
      continue;
    }
    const createdAtMs = Date.parse(candidate.createdAt);
    if (!Number.isFinite(createdAtMs)) continue;
    if (sinceMs !== undefined && createdAtMs < sinceMs) {
      // A long-overdue task that was created before the window but
      // completed inside it is still interesting for category 3 (the
      // future sequence detector). Keep it if the completion is in
      // window; otherwise drop. The conservative behaviour for v0
      // is to drop — only category 1 ships now and that consumes
      // note mtimes, not task lifecycles.
      const completedAtMs = typeof candidate.completedAt === "string" ? Date.parse(candidate.completedAt) : NaN;
      if (!Number.isFinite(completedAtMs) || completedAtMs < sinceMs) continue;
    }
    const completedAtMs = typeof candidate.completedAt === "string" ? Date.parse(candidate.completedAt) : undefined;
    const dueAtMs = typeof candidate.dueAt === "string" ? Date.parse(candidate.dueAt) : undefined;
    out.push({
      createdAtMs,
      id: candidate.id,
      status: candidate.status,
      title: candidate.title,
      ...(completedAtMs !== undefined && Number.isFinite(completedAtMs) ? { completedAtMs } : {}),
      ...(dueAtMs !== undefined && Number.isFinite(dueAtMs) ? { dueAtMs } : {})
    });
  }
  return out;
}

async function readNoteMtimes(notesDir: string, sinceMs?: number): Promise<readonly NoteMtimeSignal[]> {
  let stats: import("node:fs").Stats;
  try {
    stats = await fs.stat(notesDir);
  } catch {
    return [];
  }
  if (!stats.isDirectory()) {
    return [];
  }
  const out: NoteMtimeSignal[] = [];
  await walkNotes(notesDir, notesDir, out, sinceMs);
  // Sort newest-first so cluster windows see the freshest entry first.
  out.sort((left, right) => right.mtimeMs - left.mtimeMs);
  return out;
}

async function walkNotes(
  notesDir: string,
  current: string,
  out: NoteMtimeSignal[],
  sinceMs: number | undefined
): Promise<void> {
  if (out.length >= DEFAULT_NOTES_WALK_MAX_ENTRIES) return;
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(current, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (out.length >= DEFAULT_NOTES_WALK_MAX_ENTRIES) return;
    const full = path.join(current, entry.name);
    if (entry.isDirectory()) {
      // Skip dotfiles / hidden dirs — `.git`, `.obsidian`, etc.
      if (entry.name.startsWith(".")) continue;
      await walkNotes(notesDir, full, out, sinceMs);
      continue;
    }
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith(".md")) continue;
    let st: import("node:fs").Stats;
    try {
      st = await fs.stat(full);
    } catch {
      continue;
    }
    const mtimeMs = st.mtimeMs;
    if (sinceMs !== undefined && mtimeMs < sinceMs) continue;
    const rel = path.relative(notesDir, full);
    const segments = rel.split(path.sep);
    // First directory segment under notesDir IS the path family.
    // A note at the root (`notesDir/journal.md`) has `pathFamily: ""`
    // — explicit so callers can decide whether to fold it into a
    // pseudo-family or skip it.
    const pathFamily = segments.length > 1 ? segments[0]! : "";
    out.push({ absPath: full, mtimeMs, pathFamily });
  }
}

export function resolveAggregatorHome(explicit: string | undefined): string {
  const explicitTrimmed = typeof explicit === "string" ? explicit.trim() : "";
  if (explicitTrimmed.length > 0) return explicitTrimmed;
  const envHome = process.env.HOME?.trim();
  if (envHome && envHome.length > 0) return envHome;
  const sysHome = homedir().trim();
  if (sysHome.length > 0) return sysHome;
  throw new Error("Cannot resolve home directory for activity aggregator — HOME is empty and os.homedir() returned no value");
}
