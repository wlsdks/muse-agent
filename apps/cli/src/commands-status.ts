/**
 * `muse status` — at-a-glance JARVIS dashboard.
 *
 * Distinct from `muse doctor` (operator health-check) and
 * `muse setup` (config wizard): this one is for the user, every
 * morning, "is JARVIS watching me?". Pure disk reads, no model
 * call, so it returns in <100 ms even on a cold start.
 *
 * Sections:
 *   1. who Muse thinks you are (user id + persona snapshot)
 *   2. model + tools enabled by env
 *   3. imminent — open tasks due soon
 *   4. last proactive notice — when, what, how delivered
 *   5. notification log — file path + last line
 */

import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { evaluateLocalOnlyPosture, mergeModelKeysFromFile, resolveDefaultModel, type LocalOnlyStatusSnapshot } from "@muse/autoconfigure";
import { defaultBeliefProvenanceFile, FileUserMemoryStore, projectRecentlyLearned, readBeliefProvenance, selectRecentlyForgotten, summarizeRecentlyLearned } from "@muse/memory";
import {
  readFollowups,
  readObjectives,
  readReminders,
  readSessionLock,
  summariseEpisodesRows,
  summariseFollowupsRows,
  summariseObjectivesRows,
  summarisePatternsFiredRows,
  summariseRemindersRows
} from "@muse/mcp";
import type { Command } from "commander";

import {
  BUILTIN_PERSONAS,
  defaultPersonaFile,
  isBuiltinPersonaId,
  readPersonaStore,
  resolveActivePersonaPreamble
} from "./persona-store.js";
import { resolvePersona } from "./program-helpers.js";
import type { ProgramIO } from "./program.js";
import { readTrust } from "./commands-trust.js";

/**
 * Version marker for the `muse status --json` payload.
 * Bumped when fields are renamed or removed; additive changes
 * keep the existing value. Exported so jq pipelines + downstream
 * scripts (and the test suite) can pin the contract.
 */
export const MUSE_STATUS_SCHEMA_VERSION = 1;

interface StatusOptions {
  readonly user?: string;
  readonly json?: boolean;
  /**
   * When set, redraws the status snapshot on a fixed
   * cadence until Ctrl-C. `--json` short-circuits this (a watch
   * loop emitting JSON every tick is a stream consumer's job, not
   * status's) so the option is silently ignored when both are set.
   */
  readonly watch?: boolean;
  /** Seconds between renders in --watch mode. Defaults to 5. */
  readonly interval?: string;
  /**
   * Surface "you usually do X around this hour"
   * hints derived from patterns-fired. Silent when fewer than
   * 3 firings per pattern or when no pattern matches the
   * current hour.
   */
  readonly suggestions?: boolean;
}

function envValue(key: string): string | undefined {
  const v = process.env[key]?.trim();
  return v && v.length > 0 ? v : undefined;
}

async function safeReadJson(path: string): Promise<unknown | undefined> {
  try {
    const raw = await readFile(path, "utf8");
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

async function readLogTail(path: string, lines = 1): Promise<string | undefined> {
  try {
    const raw = await readFile(path, "utf8");
    const trimmed = raw.split("\n").filter((line) => line.length > 0);
    return trimmed.slice(-lines).join("\n");
  } catch {
    return undefined;
  }
}

async function fileSize(path: string): Promise<number | undefined> {
  try {
    const s = await stat(path);
    return s.size;
  } catch {
    return undefined;
  }
}

function defaultUserId(): string {
  return envValue("MUSE_USER_ID") ?? envValue("USER") ?? "default";
}

function defaultUserMemoryFile(): string {
  return envValue("MUSE_USER_MEMORY_FILE") ?? join(homedir(), ".muse", "user-memory.json");
}

function defaultTasksFile(): string {
  return envValue("MUSE_TASKS_FILE") ?? join(homedir(), ".muse", "tasks.json");
}

function defaultProactiveHistoryFile(): string {
  return envValue("MUSE_PROACTIVE_HISTORY_FILE") ?? join(homedir(), ".muse", "proactive-history.json");
}

function defaultFollowupsFile(): string {
  return envValue("MUSE_FOLLOWUPS_FILE") ?? join(homedir(), ".muse", "followups.json");
}

function defaultObjectivesFile(): string {
  return envValue("MUSE_OBJECTIVES_FILE") ?? join(homedir(), ".muse", "objectives.json");
}

function defaultEpisodesFile(): string {
  return envValue("MUSE_EPISODES_FILE") ?? join(homedir(), ".muse", "episodes.json");
}

function defaultPatternsFiredFile(): string {
  return envValue("MUSE_PATTERNS_FIRED_FILE") ?? join(homedir(), ".muse", "patterns-fired.json");
}

function defaultRemindersFile(): string {
  return envValue("MUSE_REMINDERS_FILE") ?? join(homedir(), ".muse", "reminders.json");
}

function defaultLogFile(): string {
  return envValue("MUSE_MESSAGING_LOG_FILE") ?? join(homedir(), ".muse", "notifications.log");
}

function defaultSessionLockFile(): string {
  return envValue("MUSE_SESSION_LOCK_FILE") ?? join(homedir(), ".muse", "session-lock.json");
}

/**
 * Optional path to a sidecar JSON the observability
 * snapshotter (or an operator's cron) writes daily-cost totals
 * into. Default `~/.muse/token-cost-today.json` so an off-the-
 * shelf write lands where `muse status` looks. Shape:
 * `{ totalUsd, totalTokens, runs, asOfIso }` — every field
 * optional so a partial / forward-compatible writer still
 * renders.
 */
function defaultTokenCostTodayFile(): string {
  return envValue("MUSE_TOKEN_COST_TODAY_FILE") ?? join(homedir(), ".muse", "token-cost-today.json");
}

function defaultNotesIndexFile(): string {
  return envValue("MUSE_NOTES_INDEX_FILE") ?? join(homedir(), ".muse", "notes-index.json");
}

/**
 * Offline RAG readiness for the dashboard glance. The embed
 * model is a first-class health concern; `muse status` should
 * show whether semantic recall over notes is actually wired
 * without needing a network probe
 * — just whether the notes index exists and which embed model
 * built it. Pure file read (same cost profile as the daily-cost
 * sidecar); exported for direct test coverage.
 */
export async function readRagStatus(
  path: string
): Promise<{ readonly indexed: boolean; readonly embedModel?: string; readonly files?: number }> {
  const parsed = await safeReadJson(path) as
    | { model?: unknown; files?: unknown }
    | undefined;
  if (!parsed || typeof parsed !== "object") {
    return { indexed: false };
  }
  const files = Array.isArray(parsed.files) ? parsed.files.length : 0;
  const embedModel = typeof parsed.model === "string" && parsed.model.trim().length > 0
    ? parsed.model.trim()
    : undefined;
  return embedModel
    ? { embedModel, files, indexed: files > 0 }
    : { files, indexed: files > 0 };
}

interface TokenCostTodayShape {
  readonly totalUsd?: number;
  readonly totalTokens?: number;
  readonly runs?: number;
  readonly asOfIso?: string;
}

/**
 * Read the daily-cost sidecar. Tolerant: any read /
 * parse / shape failure returns `{ available: false }` so the
 * status renderer prints a clear "(no cost data)" instead of
 * crashing. Exported for direct test coverage.
 */
export async function readTokenCostToday(path: string): Promise<{ readonly available: boolean } & TokenCostTodayShape> {
  const parsed = await safeReadJson(path) as TokenCostTodayShape | undefined;
  if (!parsed || typeof parsed !== "object") {
    return { available: false };
  }
  return { available: true, ...parsed };
}

/**
 * The compact "what Muse recently learned about you" one-liner for the status
 * dashboard, or undefined when there's nothing to surface. Reads the typed
 * user-memory (so factHistory dates parse), then runs the deterministic,
 * citation-bearing projectRecentlyLearned → summarizeRecentlyLearned — code, not
 * the model, picks what to show and the line carries its source citation.
 */
/** A status one-liner only counts a learning as "recent" within this window. */
const RECENTLY_LEARNED_WINDOW_MS = 30 * 24 * 60 * 60 * 1_000;

export async function readRecentlyLearnedLine(
  memoryFile: string,
  userId: string,
  nowMs: number = Date.now()
): Promise<string | undefined> {
  const memory = await new FileUserMemoryStore({ file: memoryFile }).findByUserId(userId);
  return memory
    ? summarizeRecentlyLearned(projectRecentlyLearned(memory, { sinceMs: nowMs - RECENTLY_LEARNED_WINDOW_MS }))
    : undefined;
}

/**
 * Compact one-line "what you had me forget" for `muse status` — the FORGETS half,
 * the sibling of `readRecentlyLearnedLine`. The most recent retraction within the
 * window plus a `(+N more)` count, cited by date; code selects from the recorded
 * retraction markers (`selectRecentlyForgotten`), never the model. Undefined when
 * nothing was forgotten, so the caller renders the line only when there's news.
 */
export async function readRecentlyForgottenLine(
  provenanceFile: string,
  nowMs: number = Date.now()
): Promise<string | undefined> {
  const forgotten = selectRecentlyForgotten(await readBeliefProvenance(provenanceFile), {
    now: nowMs,
    withinDays: RECENTLY_LEARNED_WINDOW_MS / (24 * 60 * 60 * 1_000)
  });
  const head = forgotten[0];
  if (head === undefined) {
    return undefined;
  }
  const line = `${head.key.replace(/_/gu, " ")} (forgotten ${head.forgottenAt.slice(0, 10)})`;
  return forgotten.length > 1 ? `${line} (+${(forgotten.length - 1).toString()} more)` : line;
}

interface PersistedTask {
  readonly id: string;
  readonly title: string;
  readonly status: string;
  readonly dueAt?: string;
  readonly urgent?: boolean;
}

interface ProactiveHistoryEntry {
  readonly firedAtIso?: string;
  readonly status?: string;
  readonly kind?: string;
  readonly providerId?: string;
  readonly text?: string;
}

async function collectStatus(userId: string) {
  const userMemoryFile = defaultUserMemoryFile();
  const tasksFile = defaultTasksFile();
  const historyFile = defaultProactiveHistoryFile();
  const logFile = defaultLogFile();

  // Resolve the slot BEFORE reading memory + trust, else the badge
  // shows the slot but facts/prefs/trust come from the bare
  // <user> record (silent divergence when MUSE_PERSONA is set).
  const slot = resolvePersona(undefined);
  const effectiveUserKey = slot ? `${userId}@${slot}` : userId;
  const personaStore = await readPersonaStore(defaultPersonaFile()).catch(() => undefined);
  const activeTemplateId = personaStore?.activeId ?? "default";
  const activePreamble = personaStore ? resolveActivePersonaPreamble(personaStore) : "";
  const builtinDescription = BUILTIN_PERSONAS.find((p) => p.id === activeTemplateId)?.description;

  const memoryDoc = await safeReadJson(userMemoryFile) as { users?: Record<string, unknown> } | undefined;
  const persona = (memoryDoc?.users?.[effectiveUserKey] ?? undefined) as
    | { facts?: Record<string, string>; preferences?: Record<string, string>; updatedAt?: string }
    | undefined;

  const recentlyLearnedLine = await readRecentlyLearnedLine(userMemoryFile, effectiveUserKey).catch(() => undefined);
  const recentlyForgottenLine = await readRecentlyForgottenLine(defaultBeliefProvenanceFile()).catch(() => undefined);

  const trust = await readTrust(effectiveUserKey).catch(() => ({ blockedTools: [] as string[], trustedTools: [] as string[] }));
  const routineHours = persona?.facts?.routine_active_hours;
  const routineDays = persona?.facts?.routine_active_days;

  const tasksDoc = await safeReadJson(tasksFile) as { tasks?: readonly PersistedTask[] } | undefined;
  const allTasks = tasksDoc?.tasks ?? [];
  const now = Date.now();
  const due24h = allTasks.filter((task) => {
    if (task.status !== "open" || !task.dueAt) return false;
    const due = new Date(task.dueAt).getTime();
    return Number.isFinite(due) && due >= now && due <= now + 24 * 60 * 60 * 1000;
  });

  const historyDoc = await safeReadJson(historyFile) as { entries?: readonly ProactiveHistoryEntry[] } | undefined;
  const lastNotice = historyDoc?.entries?.[historyDoc.entries.length - 1];

  const followups = await readFollowups(defaultFollowupsFile()).catch(() => [] as const);
  const followupsByStatus = summariseFollowupsRows(followups, userId);

  const episodesDoc = await safeReadJson(defaultEpisodesFile()) as { episodes?: readonly unknown[] } | undefined;
  const episodesSummary = summariseEpisodesRows(episodesDoc?.episodes ?? [], userId);

  const patternsFiredDoc = await safeReadJson(defaultPatternsFiredFile()) as { fired?: readonly unknown[] } | undefined;
  const patternsSummary = summarisePatternsFiredRows(patternsFiredDoc?.fired ?? []);
  // 1-3 "you usually do X around now" hints from the
  // patterns-fired sidecar.
  const suggestions = suggestPatternHints(patternsFiredDoc?.fired ?? [], new Date());

  const reminders = await readReminders(defaultRemindersFile()).catch(() => [] as const);
  const remindersSummary = summariseRemindersRows(reminders, now);

  const objectives = await readObjectives(defaultObjectivesFile()).catch(() => [] as const);
  const objectivesSummary = summariseObjectivesRows(objectives, userId);

  // Do-Not-Disturb: the proactive loop skips firing while a session
  // lock is active, so the dashboard must surface it — else a user
  // who locked DND glances here, sees no notices, and is confused.
  const sessionLockUntil = await readSessionLock(defaultSessionLockFile(), new Date()).catch(() => undefined);

  const logTail = await readLogTail(logFile, 1);
  const logBytes = await fileSize(logFile);

  const tokenCost = await readTokenCostToday(defaultTokenCostTodayFile());
  const rag = await readRagStatus(defaultNotesIndexFile());

  return {
    // Bump only on breaking field renames/removals (not additive
    // changes) — jq pipelines branch on this.
    schemaVersion: MUSE_STATUS_SCHEMA_VERSION,
    ...resolveModelInfo(),
    providers: summariseProviders(),
    localOnly: evaluateLocalOnlyPosture(process.env),
    persona: {
      factCount: persona?.facts ? Object.keys(persona.facts).length : 0,
      preferenceCount: persona?.preferences ? Object.keys(persona.preferences).length : 0,
      updatedAt: persona?.updatedAt,
      userId,
      ...(recentlyLearnedLine ? { recentlyLearned: recentlyLearnedLine } : {}),
      ...(recentlyForgottenLine ? { recentlyForgotten: recentlyForgottenLine } : {}),
      vetoCount: persona?.preferences
        ? Object.keys(persona.preferences).filter((k) => k.startsWith("veto:")).length
        : 0,
      goalCount: persona?.preferences
        ? Object.keys(persona.preferences).filter((k) => k.startsWith("goal:")).length
        : 0,
      // preferences-first, facts-fallback — matches active-context.ts.
      ...(typeof persona?.preferences?.["current_focus"] === "string" && persona.preferences["current_focus"].trim().length > 0
        ? { currentFocus: persona.preferences["current_focus"].trim() }
        : typeof persona?.facts?.["current_focus"] === "string" && persona.facts["current_focus"].trim().length > 0
          ? { currentFocus: persona.facts["current_focus"].trim() }
          : {}),
      // preferences-only (no facts fallback) — mirrors how
      // active-context.ts reads working_hours.
      ...(typeof persona?.preferences?.["working_hours"] === "string" && persona.preferences["working_hours"].trim().length > 0
        ? { workingHours: persona.preferences["working_hours"].trim() }
        : {}),
      // effectiveUserKey is the slot-composed key memory + trust
      // actually use — surfaced so callers don't recompose it.
      ...(slot
        ? { slot, slotSource: "MUSE_PERSONA" as const, effectiveUserKey }
        : {}),
      template: {
        activeId: activeTemplateId,
        isBuiltin: isBuiltinPersonaId(activeTemplateId),
        preambleBytes: activePreamble.length,
        ...(builtinDescription ? { description: builtinDescription } : {})
      }
    },
    tasks: {
      file: tasksFile,
      totalOpen: allTasks.filter((task) => task.status === "open").length,
      due24h: due24h.map((task) => ({ id: task.id, title: task.title, dueAt: task.dueAt, urgent: task.urgent === true }))
    },
    lastNotice: lastNotice
      ? {
          firedAtIso: lastNotice.firedAtIso,
          kind: lastNotice.kind,
          providerId: lastNotice.providerId,
          status: lastNotice.status,
          text: lastNotice.text
        }
      : undefined,
    notificationLog: {
      file: logFile,
      bytes: logBytes,
      lastLine: logTail
    },
    trust: {
      trustedCount: trust.trustedTools.length,
      blockedCount: trust.blockedTools.length,
      trustedSample: trust.trustedTools.slice(0, 3),
      blockedSample: trust.blockedTools.slice(0, 3)
    },
    routine: {
      activeHours: routineHours,
      activeDays: routineDays
    },
    followups: followupsByStatus,
    objectives: objectivesSummary,
    episodes: episodesSummary,
    patterns: patternsSummary,
    reminders: remindersSummary,
    session: { dnd: sessionLockUntil !== undefined, ...(sessionLockUntil ? { until: sessionLockUntil } : {}) },
    cost: tokenCost,
    rag,
    suggestions
  };
}

/**
 * Anticipatory hint generator. Groups firings by
 * `patternId`, computes the median firing hour of day (UTC), and
 * emits "you usually <pattern> around this hour" when the
 * current hour is within ±1 of the median. Cap at 3.
 *
 * Exported so the unit test can drive the matrix without
 * spinning up `muse status` itself.
 */
export interface PatternSuggestion {
  readonly patternId: string;
  readonly medianHourUtc: number;
  readonly firings: number;
}

/**
 * Formatted renderer for the `--suggestions` flag.
 * Silent when there are no hits so a fresh install with empty
 * patterns-fired doesn't show a useless "Suggestions (0):"
 * line.
 */
function renderSuggestions(io: ProgramIO, suggestions: readonly PatternSuggestion[]): void {
  if (suggestions.length === 0) return;
  io.stdout(`\nSuggestions (${suggestions.length.toString()}):\n`);
  for (const hint of suggestions) {
    io.stdout(
      `  * you usually ${hint.patternId} around ${hint.medianHourUtc.toString().padStart(2, "0")}:00 UTC ` +
      `(seen ${hint.firings.toString()}x)\n`
    );
  }
}
/**
 * Hour-of-day lives on a 24h circle, so a plain numeric median of
 * `[23, 0, 1]` is ~1 — wrong for a midnight-straddling habit, and
 * since the ±1 window check is circular the suggestion is then
 * silently missed. Pick the hour minimising total circular
 * distance (ties → earliest hour for determinism); for a
 * non-wrapping cluster this equals the ordinary medoid.
 */
function circularMedianHour(hours: readonly number[]): number {
  let bestHour = 0;
  let bestCost = Number.POSITIVE_INFINITY;
  for (let candidate = 0; candidate < 24; candidate += 1) {
    let cost = 0;
    for (const hour of hours) {
      const d = Math.abs(candidate - hour);
      cost += Math.min(d, 24 - d);
    }
    if (cost < bestCost) {
      bestCost = cost;
      bestHour = candidate;
    }
  }
  return bestHour;
}

export function suggestPatternHints(
  fired: readonly unknown[],
  now: Date,
  options: { readonly minFirings?: number; readonly maxHints?: number } = {}
): readonly PatternSuggestion[] {
  const minFirings = Math.max(1, options.minFirings ?? 3);
  const maxHints = Math.max(1, options.maxHints ?? 3);
  const nowHour = now.getUTCHours();

  const buckets = new Map<string, number[]>();
  for (const raw of fired) {
    if (!raw || typeof raw !== "object") continue;
    const entry = raw as { patternId?: unknown; firedAtIso?: unknown };
    if (typeof entry.patternId !== "string" || typeof entry.firedAtIso !== "string") continue;
    const t = Date.parse(entry.firedAtIso);
    if (!Number.isFinite(t)) continue;
    const hour = new Date(t).getUTCHours();
    const prior = buckets.get(entry.patternId) ?? [];
    prior.push(hour);
    buckets.set(entry.patternId, prior);
  }

  const candidates: PatternSuggestion[] = [];
  for (const [patternId, hours] of buckets) {
    if (hours.length < minFirings) continue;
    const medianHourUtc = circularMedianHour(hours);
    const delta = Math.min(
      Math.abs(nowHour - medianHourUtc),
      24 - Math.abs(nowHour - medianHourUtc)
    );
    if (delta <= 1) {
      candidates.push({ patternId, medianHourUtc, firings: hours.length });
    }
  }
  // Most-fired first (more evidence = higher confidence).
  return candidates.sort((a, b) => b.firings - a.firings || a.patternId.localeCompare(b.patternId)).slice(0, maxHints);
}

/**
 * `{ model, modelInferredFrom }` — what model the runtime will
 * actually invoke. Mirrors `resolveDefaultModel` from autoconfigure
 * so a user who has only `GEMINI_API_KEY` set (no `MUSE_MODEL`
 * export) sees the inferred `gemini/gemini-2.0-flash` instead of
 * the misleading "(unset)" the status command used to print when
 * it only read `process.env.MUSE_MODEL`.
 *
 * `modelInferredFrom` carries the env key name when the model came
 * from inference, so the formatted output can annotate the line —
 * matches the `muse doctor` warn-detail format
 * ("inferred from GEMINI_API_KEY").
 */
function resolveModelInfo(): { model?: string; modelInferredFrom?: string } {
  const merged = mergeModelKeysFromFile({ ...process.env });
  const explicit = (merged.MUSE_MODEL?.trim() || merged.MUSE_DEFAULT_MODEL?.trim() || "") || undefined;
  if (explicit) {
    return { model: explicit };
  }
  const resolved = resolveDefaultModel(merged);
  if (!resolved) {
    return {};
  }
  const inferredFrom = [
    "GEMINI_API_KEY",
    "GOOGLE_API_KEY",
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "OPENROUTER_API_KEY",
    "OLLAMA_BASE_URL"
  ].find((k) => typeof merged[k] === "string" && (merged[k] as string).trim().length > 0);
  return { model: resolved, modelInferredFrom: inferredFrom };
}

/**
 * `{ configured: ["gemini", "ollama"], total: 2 }` over the five
 * canonical provider env keys mirrored from
 * `personal-providers.ts`. Probes both `process.env` AND the
 * `~/.muse/models.json` credentials file written by `muse setup
 * model` — the runtime's `mergeModelKeysFromFile` does the same
 * merge, so status mirrors that surface. A user who configured
 * keys exclusively through the wizard (no shell export) used to
 * see "0 configured" — that bug shipped briefly and is closed
 * here.
 *
 * No token bytes are read or echoed; only `value !== undefined`
 * after the merge. The credentials file may legitimately not
 * exist on a fresh install (mergeModelKeysFromFile returns the
 * input env unchanged in that case).
 */
function summariseProviders() {
  const checks: ReadonlyArray<{ id: string; envKey: string }> = [
    { envKey: "GEMINI_API_KEY", id: "gemini" },
    { envKey: "ANTHROPIC_API_KEY", id: "anthropic" },
    { envKey: "OPENAI_API_KEY", id: "openai" },
    { envKey: "OPENROUTER_API_KEY", id: "openrouter" },
    { envKey: "OLLAMA_BASE_URL", id: "ollama" }
  ];
  const merged = mergeModelKeysFromFile({ ...process.env });
  const configured: string[] = [];
  for (const check of checks) {
    const v = merged[check.envKey];
    if (typeof v === "string" && v.trim().length > 0) {
      configured.push(check.id);
    }
  }
  return { configured, total: configured.length };
}

/**
 * One-line privacy posture for the at-a-glance dashboard — Muse's
 * core identity ("local by default"). The facts (on/off, healthy vs
 * degraded, egress possible) derive from the canonical
 * `evaluateLocalOnlyPosture` snapshot, so `muse status` and `muse
 * doctor` can never disagree about whether cloud egress is possible.
 * Wording is glance-sized and always names "local-only"; the precise
 * diagnosis (which cloud key, off-box embedder URL) stays in `muse
 * doctor`, which this line points at for any non-healthy posture.
 */
export function formatPrivacyPosture(posture: LocalOnlyStatusSnapshot): string {
  if (posture.enabled) {
    return posture.status === "ok"
      ? "🔒 local-only on (default) — cloud egress blocked"
      : "⚠ local-only on but degraded — run `muse doctor`";
  }
  return posture.status === "warn"
    ? "⚠ local-only OFF — cloud egress possible (run `muse doctor`)"
    : "local-only off — no cloud credentials configured";
}

/**
 * Parse `--interval <n>` (seconds) for `muse status --watch`.
 * Default 5s, clamped to [1, 3600] so a bad input can't lock the
 * loop into a single tick or starve the terminal with sub-second
 * refreshes. Exported for direct test coverage of the boundary
 * behavior.
 */
export function resolveStatusWatchIntervalMs(raw: string | undefined): number {
  const defaultMs = 5_000;
  if (!raw) return defaultMs;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return defaultMs;
  const seconds = Math.min(3600, Math.max(1, parsed));
  return Math.round(seconds * 1000);
}

function renderStatus(io: ProgramIO, snap: Awaited<ReturnType<typeof collectStatus>>): void {
  io.stdout("Muse status:\n");
      io.stdout("\n");
      io.stdout(`  user: ${snap.persona.userId}\n`);
      if (snap.persona.slot) {
        io.stdout(`    slot: ${snap.persona.slot} (from ${snap.persona.slotSource ?? "MUSE_PERSONA"})\n`);
      }
      if (snap.persona.template.activeId !== "default" || snap.persona.template.preambleBytes > 0) {
        const tag = snap.persona.template.isBuiltin ? "built-in" : "custom";
        io.stdout(`    template: ${snap.persona.template.activeId} (${tag}, ${snap.persona.template.preambleBytes.toString()}-byte preamble)\n`);
      }
      if (snap.persona.currentFocus) {
        io.stdout(`    current focus: ${snap.persona.currentFocus}\n`);
      }
      if (snap.persona.workingHours) {
        io.stdout(`    working hours: ${snap.persona.workingHours}\n`);
      }
      if (snap.persona.recentlyLearned) {
        io.stdout(`    recently learned: ${snap.persona.recentlyLearned}\n`);
      }
      if (snap.persona.recentlyForgotten) {
        io.stdout(`    recently forgotten: ${snap.persona.recentlyForgotten}\n`);
      }
      if (snap.persona.factCount + snap.persona.preferenceCount > 0) {
        const parts: string[] = [];
        if (snap.persona.factCount > 0) parts.push(`${snap.persona.factCount.toString()} fact(s)`);
        if (snap.persona.preferenceCount > 0) parts.push(`${snap.persona.preferenceCount.toString()} pref(s)`);
        if (snap.persona.vetoCount > 0) parts.push(`${snap.persona.vetoCount.toString()} veto(es)`);
        if (snap.persona.goalCount > 0) parts.push(`${snap.persona.goalCount.toString()} goal(s)`);
        io.stdout(`    persona: ${parts.join(", ")}\n`);
        if (snap.persona.updatedAt) {
          io.stdout(`    last update: ${snap.persona.updatedAt}\n`);
        }
      } else {
        io.stdout(`    persona: (empty — Muse hasn't learned anything about you yet)\n`);
        io.stdout(`    onboarding:\n`);
        io.stdout(`      muse remember "My name is ${snap.persona.userId} and I prefer concise Korean replies"\n`);
        io.stdout(`      muse memory set fact name "${snap.persona.userId}"   # no-LLM direct path\n`);
        io.stdout(`    once seeded, muse ask/chat/brief will address you by name and honour your preferences.\n`);
      }
      io.stdout("\n");
      const modelLine = snap.model
        ? snap.modelInferredFrom
          ? `${snap.model} (inferred from ${snap.modelInferredFrom})`
          : snap.model
        : "(unset — set MUSE_MODEL or run muse setup model)";
      io.stdout(`  model: ${modelLine}\n`);
      if (snap.providers.total > 0) {
        io.stdout(`    providers: ${snap.providers.total.toString()} configured — ${snap.providers.configured.join(", ")}\n`);
      } else {
        io.stdout(`    providers: 0 configured — set GEMINI_API_KEY / ANTHROPIC_API_KEY / etc. or run muse setup model\n`);
      }
      io.stdout(`    privacy: ${formatPrivacyPosture(snap.localOnly)}\n`);
      io.stdout("\n");
      if (snap.session.dnd) {
        io.stdout(`  (DND) proactive notices paused${snap.session.until ? ` until ${snap.session.until}` : ""} — \`muse session unlock\` to resume\n\n`);
      }
      io.stdout(`  tasks: ${snap.tasks.totalOpen.toString()} open, ${snap.tasks.due24h.length.toString()} due in 24 h\n`);
      for (const task of snap.tasks.due24h.slice(0, 5)) {
        io.stdout(`    · ${task.urgent ? "⚠ " : ""}${task.title} (${task.dueAt ?? "no due"})\n`);
      }
      io.stdout("\n");
      if (snap.followups.total > 0) {
        io.stdout(`  followups: ${snap.followups.scheduled.toString()} scheduled, ${snap.followups.fired.toString()} fired, ${snap.followups.cancelled.toString()} cancelled\n`);
        if (snap.followups.nextScheduledFor) {
          const summary = snap.followups.nextScheduledSummary
            ? ` — ${snap.followups.nextScheduledSummary.slice(0, 80)}`
            : "";
          io.stdout(`    next: ${snap.followups.nextScheduledFor}${summary}\n`);
        }
        io.stdout("\n");
      }
      if (snap.objectives.total > 0) {
        io.stdout(`  objectives: ${snap.objectives.active.toString()} active, ${snap.objectives.escalated.toString()} escalated, ${snap.objectives.done.toString()} done, ${snap.objectives.cancelled.toString()} cancelled\n`);
        if (snap.objectives.escalatedSample) {
          io.stdout(`    ⚠ needs you: ${snap.objectives.escalatedSample.slice(0, 80)}\n`);
        }
        io.stdout("\n");
      }
      if (snap.episodes.total > 0) {
        io.stdout(`  episodes: ${snap.episodes.total.toString()} captured`);
        io.stdout(snap.episodes.lastEndedAt ? `, last ${snap.episodes.lastEndedAt}\n` : "\n");
        if (snap.episodes.lastSummary) {
          io.stdout(`    last: ${snap.episodes.lastSummary.slice(0, 120)}\n`);
        }
        io.stdout("\n");
      }
      if (snap.patterns.total > 0) {
        io.stdout(`  patterns: ${snap.patterns.total.toString()} fired`);
        io.stdout(snap.patterns.lastFiredAtIso ? `, last ${snap.patterns.lastFiredAtIso}\n` : "\n");
        io.stdout("\n");
      }
      if (snap.reminders.total > 0) {
        const overdueClause = snap.reminders.overdue > 0 ? ` (${snap.reminders.overdue.toString()} overdue)` : "";
        io.stdout(`  reminders: ${snap.reminders.pending.toString()} pending${overdueClause}, ${snap.reminders.fired.toString()} fired\n`);
        if (snap.reminders.nextDueAt) {
          const text = snap.reminders.nextText ? ` — ${snap.reminders.nextText.slice(0, 80)}` : "";
          io.stdout(`    next: ${snap.reminders.nextDueAt}${text}\n`);
        }
        io.stdout("\n");
      }
      // Silent when the sidecar is absent so a fresh install
      // doesn't show a useless line.
      if (snap.cost.available) {
        const usd = typeof snap.cost.totalUsd === "number" ? `$${snap.cost.totalUsd.toFixed(4)}` : "(no usd)";
        const tokens = typeof snap.cost.totalTokens === "number" ? `${snap.cost.totalTokens.toString()} tokens` : "(no tokens)";
        const runs = typeof snap.cost.runs === "number" ? ` over ${snap.cost.runs.toString()} run(s)` : "";
        io.stdout(`  cost (today): ${usd}, ${tokens}${runs}\n`);
        if (snap.cost.asOfIso) {
          io.stdout(`    as of: ${snap.cost.asOfIso}\n`);
        }
        io.stdout("\n");
      }
      io.stdout(
        snap.rag.indexed
          ? `  rag: indexed — ${(snap.rag.files ?? 0).toString()} file(s)${snap.rag.embedModel ? `, ${snap.rag.embedModel}` : ""} (run \`muse doctor\` to confirm the embed model is pulled)\n\n`
          : `  rag: not indexed — run \`muse notes reindex\` for \`muse ask\` / \`muse recall\` grounding\n\n`
      );
      if (snap.lastNotice) {
        io.stdout(`  last notice: [${snap.lastNotice.firedAtIso ?? "?"}] via ${snap.lastNotice.providerId ?? "?"}\n`);
        if (snap.lastNotice.text) {
          io.stdout(`    "${snap.lastNotice.text.slice(0, 120)}"\n`);
        }
      } else {
        io.stdout(`  last notice: (none yet — run 'muse proactive watch' to start delivering)\n`);
      }
      io.stdout("\n");
      // The "log" messaging provider writes to ~/.muse/notifications.log
      // separately from ~/.muse/proactive-history.json. When the
      // history shows a delivery via "log" but the log file is
      // missing, the user has been bitten by a rotation / cleanup
      // / wrong-path mismatch — surface that explicitly so they
      // know to check (not just "(not yet created)" which implies
      // nothing ever fired).
      const logFile = snap.notificationLog.file;
      if (snap.notificationLog.bytes !== undefined) {
        io.stdout(`  notifications log: ${logFile} (${snap.notificationLog.bytes.toString()} bytes)\n`);
        if (snap.notificationLog.lastLine) {
          io.stdout(`    last: ${snap.notificationLog.lastLine}\n`);
        }
      } else if (snap.lastNotice?.providerId === "log") {
        io.stdout(`  notifications log: ${logFile} (file missing — proactive history shows a 'log' delivery on ${snap.lastNotice.firedAtIso ?? "?"}; may have been rotated, removed, or written to a different MUSE_MESSAGING_LOG_FILE)\n`);
      } else {
        io.stdout(`  notifications log: ${logFile} (not yet created — no 'log' messaging provider has fired)\n`);
      }
      io.stdout("\n");
      if (snap.routine.activeHours || snap.routine.activeDays) {
        io.stdout(`  routine: hours ${snap.routine.activeHours ?? "(none)"}, days ${snap.routine.activeDays ?? "(none)"}\n`);
      } else {
        io.stdout(`  routine: (run 'muse routine --user ${snap.persona.userId} --apply' after a few REPL sessions)\n`);
      }
      io.stdout("\n");
      io.stdout(`  trust: ${snap.trust.trustedCount.toString()} trusted, ${snap.trust.blockedCount.toString()} blocked\n`);
      if (snap.trust.trustedSample.length > 0) {
        io.stdout(`    + ${snap.trust.trustedSample.join(", ")}${snap.trust.trustedCount > 3 ? `, +${(snap.trust.trustedCount - 3).toString()} more` : ""}\n`);
      }
      if (snap.trust.blockedSample.length > 0) {
        io.stdout(`    × ${snap.trust.blockedSample.join(", ")}${snap.trust.blockedCount > 3 ? `, +${(snap.trust.blockedCount - 3).toString()} more` : ""}\n`);
      }
}

export function registerStatusCommand(program: Command, io: ProgramIO): void {
  program
    .command("status")
    .description("JARVIS-style at-a-glance dashboard: persona + model + imminent tasks + last notice")
    .option("--user <id>", "User identity (default $MUSE_USER_ID or $USER)")
    .option("--json", "Emit structured JSON instead of the formatted report")
    .option("--suggestions", "Append 'you usually do X around now' hints from patterns-fired")
    .option("--watch", "Redraw the dashboard on a fixed cadence until Ctrl-C")
    .option(
      "--interval <seconds>",
      "Refresh interval in seconds when --watch is set (default 5, clamped to [1, 3600])"
    )
    .action(async (options: StatusOptions) => {
      const userId = options.user ?? defaultUserId();

      if (options.json) {
        // --watch is ignored with --json (a watch loop emitting JSON
        // every tick is a stream consumer's job, not status's).
        const snap = await collectStatus(userId);
        io.stdout(`${JSON.stringify(snap, null, 2)}\n`);
        return;
      }

      if (!options.watch) {
        const snap = await collectStatus(userId);
        renderStatus(io, snap);
        if (options.suggestions) renderSuggestions(io, snap.suggestions);
        return;
      }

      // ANSI `ESC [ 2 J` clears the screen; `ESC [ H` parks the
      // cursor at home. Together they produce a stable, redrawable
      // viewport for the watch loop. We render first (so a Ctrl-C
      // before the first tick still shows a snapshot), then poll on
      // the parsed interval.
      const intervalMs = resolveStatusWatchIntervalMs(options.interval);
      let stopped = false;
      const sigintHandler = (): void => { stopped = true; };
      process.once("SIGINT", sigintHandler);
      try {
        while (!stopped) {
          io.stdout("\x1b[2J\x1b[H");
          const snap = await collectStatus(userId);
          renderStatus(io, snap);
          if (options.suggestions) renderSuggestions(io, snap.suggestions);
          io.stdout(`\n  (watching every ${(intervalMs / 1000).toString()}s — Ctrl-C to exit)\n`);
          if (stopped) break;
          await new Promise<void>((resolve) => {
            const handle = setTimeout(resolve, intervalMs);
            // If SIGINT fires mid-sleep, resolve immediately so the
            // loop check picks up `stopped` and exits cleanly.
            const earlyWake = (): void => {
              clearTimeout(handle);
              resolve();
            };
            process.once("SIGINT", earlyWake);
          });
        }
      } finally {
        process.off("SIGINT", sigintHandler);
      }
    });
}
