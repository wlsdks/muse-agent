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

import { mergeModelKeysFromFile } from "@muse/autoconfigure";
import type { Command } from "commander";

import type { ProgramIO } from "./program.js";
import { readTrust } from "./commands-trust.js";

interface StatusOptions {
  readonly user?: string;
  readonly json?: boolean;
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

interface PersistedTask {
  readonly id: string;
  readonly title: string;
  readonly status: string;
  readonly dueAt?: string;
}

interface ProactiveHistoryEntry {
  readonly firedAtIso?: string;
  readonly status?: string;
  readonly kind?: string;
  readonly providerId?: string;
  readonly text?: string;
}

interface FollowupRow {
  readonly id?: unknown;
  readonly userId?: unknown;
  readonly scheduledFor?: unknown;
  readonly status?: unknown;
  readonly summary?: unknown;
}

interface EpisodeRow {
  readonly id?: unknown;
  readonly userId?: unknown;
  readonly endedAt?: unknown;
  readonly summary?: unknown;
}

interface PatternFiredRow {
  readonly patternId?: unknown;
  readonly firedAtMs?: unknown;
}

interface ReminderRow {
  readonly id?: unknown;
  readonly text?: unknown;
  readonly dueAt?: unknown;
  readonly status?: unknown;
}

async function collectStatus(userId: string) {
  const userMemoryFile = defaultUserMemoryFile();
  const tasksFile = defaultTasksFile();
  const historyFile = defaultProactiveHistoryFile();
  const logFile = defaultLogFile();

  const memoryDoc = await safeReadJson(userMemoryFile) as { users?: Record<string, unknown> } | undefined;
  const persona = (memoryDoc?.users?.[userId] ?? undefined) as
    | { facts?: Record<string, string>; preferences?: Record<string, string>; updatedAt?: string }
    | undefined;

  const trust = await readTrust(userId).catch(() => ({ blockedTools: [] as string[], trustedTools: [] as string[] }));
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

  const followupsDoc = await safeReadJson(defaultFollowupsFile()) as { followups?: readonly FollowupRow[] } | undefined;
  const followupsByStatus = summariseFollowups(followupsDoc?.followups ?? [], userId);

  const episodesDoc = await safeReadJson(defaultEpisodesFile()) as { episodes?: readonly EpisodeRow[] } | undefined;
  const episodesSummary = summariseEpisodes(episodesDoc?.episodes ?? [], userId);

  const patternsFiredDoc = await safeReadJson(defaultPatternsFiredFile()) as { fired?: readonly PatternFiredRow[] } | undefined;
  const patternsSummary = summarisePatternsFired(patternsFiredDoc?.fired ?? []);

  const remindersDoc = await safeReadJson(defaultRemindersFile()) as { reminders?: readonly ReminderRow[] } | undefined;
  const remindersSummary = summariseReminders(remindersDoc?.reminders ?? [], now);

  const logTail = await readLogTail(logFile, 1);
  const logBytes = await fileSize(logFile);

  return {
    model: envValue("MUSE_MODEL") ?? envValue("MUSE_DEFAULT_MODEL"),
    providers: summariseProviders(),
    persona: {
      factCount: persona?.facts ? Object.keys(persona.facts).length : 0,
      preferenceCount: persona?.preferences ? Object.keys(persona.preferences).length : 0,
      updatedAt: persona?.updatedAt,
      userId,
      vetoCount: persona?.preferences
        ? Object.keys(persona.preferences).filter((k) => k.startsWith("veto:")).length
        : 0,
      goalCount: persona?.preferences
        ? Object.keys(persona.preferences).filter((k) => k.startsWith("goal:")).length
        : 0
    },
    tasks: {
      file: tasksFile,
      totalOpen: allTasks.filter((task) => task.status === "open").length,
      due24h: due24h.map((task) => ({ id: task.id, title: task.title, dueAt: task.dueAt }))
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
    episodes: episodesSummary,
    patterns: patternsSummary,
    reminders: remindersSummary
  };
}

/**
 * Pull a `{ scheduled, fired, cancelled, total, nextScheduledFor }`
 * envelope out of `~/.muse/followups.json`. Filters to the active
 * userId so a shared-machine install doesn't surface other users'
 * queues.
 */
function summariseFollowups(rows: readonly FollowupRow[], userId: string) {
  let scheduled = 0;
  let fired = 0;
  let cancelled = 0;
  let nextScheduledForMs = Number.POSITIVE_INFINITY;
  let nextScheduledForIso: string | undefined;
  let nextScheduledSummary: string | undefined;
  let total = 0;
  for (const row of rows) {
    if (typeof row.userId !== "string" || row.userId !== userId) continue;
    total += 1;
    if (row.status === "scheduled") {
      scheduled += 1;
      if (typeof row.scheduledFor === "string") {
        const ms = Date.parse(row.scheduledFor);
        if (Number.isFinite(ms) && ms < nextScheduledForMs) {
          nextScheduledForMs = ms;
          nextScheduledForIso = row.scheduledFor;
          nextScheduledSummary = typeof row.summary === "string" ? row.summary : undefined;
        }
      }
    } else if (row.status === "fired") {
      fired += 1;
    } else if (row.status === "cancelled") {
      cancelled += 1;
    }
  }
  return {
    cancelled,
    fired,
    nextScheduledFor: nextScheduledForIso,
    nextScheduledSummary,
    scheduled,
    total
  };
}

/**
 * `{ total, lastEndedAt, lastSummary }` for the user's prior-session
 * memory store. Filters to the active userId to avoid cross-leak.
 */
function summariseEpisodes(rows: readonly EpisodeRow[], userId: string) {
  let total = 0;
  let lastEndedAt: string | undefined;
  let lastSummary: string | undefined;
  for (const row of rows) {
    if (typeof row.userId !== "string" || row.userId !== userId) continue;
    total += 1;
    if (typeof row.endedAt === "string" && (lastEndedAt === undefined || row.endedAt > lastEndedAt)) {
      lastEndedAt = row.endedAt;
      lastSummary = typeof row.summary === "string" ? row.summary : undefined;
    }
  }
  return { lastEndedAt, lastSummary, total };
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
 * `{ pending, fired, overdue, total, nextDueAt, nextText }` over
 * `~/.muse/reminders.json`. Reminders are single-user — there is no
 * userId field on the row, so unlike followups/episodes the filter
 * stays off. Overdue = pending && dueAt in the past; next = earliest
 * pending dueAt (regardless of whether it's already overdue, so the
 * report still points at the next thing to deal with).
 */
function summariseReminders(rows: readonly ReminderRow[], nowMs: number) {
  let pending = 0;
  let fired = 0;
  let overdue = 0;
  let total = 0;
  let nextDueAtMs = Number.POSITIVE_INFINITY;
  let nextDueAtIso: string | undefined;
  let nextText: string | undefined;
  for (const row of rows) {
    if (typeof row.id !== "string") continue;
    total += 1;
    if (row.status === "fired") {
      fired += 1;
      continue;
    }
    if (row.status !== "pending") continue;
    pending += 1;
    if (typeof row.dueAt !== "string") continue;
    const ms = Date.parse(row.dueAt);
    if (!Number.isFinite(ms)) continue;
    if (ms < nowMs) overdue += 1;
    if (ms < nextDueAtMs) {
      nextDueAtMs = ms;
      nextDueAtIso = row.dueAt;
      nextText = typeof row.text === "string" ? row.text : undefined;
    }
  }
  return {
    fired,
    nextDueAt: nextDueAtIso,
    nextText,
    overdue,
    pending,
    total
  };
}

/**
 * `{ total, lastFiredAtIso }` over the cooldown sidecar.
 * patternsFired.json doesn't carry a userId — it's a single-user
 * file by design.
 */
function summarisePatternsFired(rows: readonly PatternFiredRow[]) {
  let total = 0;
  let lastFiredMs = Number.NEGATIVE_INFINITY;
  for (const row of rows) {
    if (typeof row.patternId !== "string") continue;
    total += 1;
    if (typeof row.firedAtMs === "number" && Number.isFinite(row.firedAtMs) && row.firedAtMs > lastFiredMs) {
      lastFiredMs = row.firedAtMs;
    }
  }
  return {
    lastFiredAtIso: Number.isFinite(lastFiredMs) ? new Date(lastFiredMs).toISOString() : undefined,
    total
  };
}

export function registerStatusCommand(program: Command, io: ProgramIO): void {
  program
    .command("status")
    .description("JARVIS-style at-a-glance dashboard: persona + model + imminent tasks + last notice")
    .option("--user <id>", "User identity (default $MUSE_USER_ID or $USER)")
    .option("--json", "Emit structured JSON instead of the formatted report")
    .action(async (options: StatusOptions) => {
      const userId = options.user ?? defaultUserId();
      const snap = await collectStatus(userId);

      if (options.json) {
        io.stdout(`${JSON.stringify(snap, null, 2)}\n`);
        return;
      }

      io.stdout("Muse status:\n");
      io.stdout("\n");
      io.stdout(`  user: ${snap.persona.userId}\n`);
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
      io.stdout(`  model: ${snap.model ?? "(unset — set MUSE_MODEL or run muse setup model)"}\n`);
      if (snap.providers.total > 0) {
        io.stdout(`    providers: ${snap.providers.total.toString()} configured — ${snap.providers.configured.join(", ")}\n`);
      } else {
        io.stdout(`    providers: 0 configured — set GEMINI_API_KEY / ANTHROPIC_API_KEY / etc. or run muse setup model\n`);
      }
      io.stdout("\n");
      io.stdout(`  tasks: ${snap.tasks.totalOpen.toString()} open, ${snap.tasks.due24h.length.toString()} due in 24 h\n`);
      for (const task of snap.tasks.due24h.slice(0, 5)) {
        io.stdout(`    · ${task.title} (${task.dueAt ?? "no due"})\n`);
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
      if (snap.lastNotice) {
        io.stdout(`  last notice: [${snap.lastNotice.firedAtIso ?? "?"}] via ${snap.lastNotice.providerId ?? "?"}\n`);
        if (snap.lastNotice.text) {
          io.stdout(`    "${snap.lastNotice.text.slice(0, 120)}"\n`);
        }
      } else {
        io.stdout(`  last notice: (none yet — run 'muse proactive watch' to start delivering)\n`);
      }
      io.stdout("\n");
      io.stdout(`  notifications log: ${snap.notificationLog.file}${
        snap.notificationLog.bytes !== undefined ? ` (${snap.notificationLog.bytes.toString()} bytes)` : " (not yet created)"
      }\n`);
      if (snap.notificationLog.lastLine) {
        io.stdout(`    last: ${snap.notificationLog.lastLine}\n`);
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
    });
}
