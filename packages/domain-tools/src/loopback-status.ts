/**
 * `muse.status` loopback MCP server — JARVIS self-observability for
 * external clients (Codex / Claude Desktop) over the stdio bridge.
 *
 * Single `snapshot` tool returns the same structured data the
 * `muse status` CLI prints: persona counts (facts/prefs/vetoes/goals),
 * model, imminent tasks, last proactive notice, notification log
 * path + size, plus routine + trust summary. Pure file IO — no
 * model call, no daemon, sub-100ms.
 *
 * Lets an external AI agent ask "what does the Muse instance know
 * about its user?" without round-tripping through the REST API.
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join as pathJoin } from "node:path";

import type { JsonObject, JsonValue } from "@muse/shared";

import type { LoopbackMcpServer, LoopbackMcpToolDefinition } from "@muse/mcp";
import { readFollowups } from "@muse/stores";
import { readObjectives } from "@muse/stores";
import { readProactiveHistory } from "@muse/stores";
import { readReminders } from "@muse/stores";
import { readSessionLock } from "@muse/proactivity";
import {
  summariseEpisodesRows,
  summariseFollowupsRows,
  summariseObjectivesRows,
  summarisePatternsFiredRows,
  summariseRemindersRows
} from "./personal-status-summary.js";

export interface StatusMcpServerOptions {
  /** Override path for ~/.muse/user-memory.json. */
  readonly userMemoryFile?: string;
  /** Override path for ~/.muse/tasks.json. */
  readonly tasksFile?: string;
  /** Override path for ~/.muse/proactive-history.json. */
  readonly historyFile?: string;
  /** Override path for ~/.muse/notifications.log. */
  readonly logFile?: string;
  /** Override path for ~/.muse/trust.json. */
  readonly trustFile?: string;
  /** Override path for ~/.muse/reminders.json. */
  readonly remindersFile?: string;
  /** Override path for ~/.muse/followups.json. */
  readonly followupsFile?: string;
  /** Override path for ~/.muse/objectives.json. */
  readonly objectivesFile?: string;
  /** Override path for ~/.muse/session-lock.json. */
  readonly sessionLockFile?: string;
  /** Override path for ~/.muse/episodes.json. */
  readonly episodesFile?: string;
  /** Override path for ~/.muse/patterns-fired.json. */
  readonly patternsFiredFile?: string;
  /**
   * Resolved active model name (typically autoconfigure's
   * `defaultModel`, which already merges `~/.muse/models.json`'s
   * `suggestedModel` into env). When omitted the snapshot falls
   * back to `process.env.MUSE_MODEL` — kept for backward compat
   * but produces the same misleading "model: null" a wizard-only
   * user who skipped the shell export would see. New callers should
   * always pass `model`.
   */
  readonly model?: string;
}

function homeMuse(name: string): string {
  return pathJoin(homedir(), ".muse", name);
}

async function safeReadJson(path: string): Promise<unknown | undefined> {
  try {
    const raw = await readFile(path, "utf8");
    return JSON.parse(raw) as unknown;
  } catch { return undefined; }
}

async function fileSize(path: string): Promise<number | undefined> {
  try {
    const s = await stat(path);
    return s.size;
  } catch { return undefined; }
}

interface PersistedTask {
  readonly id?: string;
  readonly title?: string;
  readonly status?: string;
  readonly dueAt?: string;
  readonly urgent?: boolean;
}

interface TrustEntry {
  readonly trustedTools?: readonly string[];
  readonly blockedTools?: readonly string[];
}

export function createStatusMcpServer(options: StatusMcpServerOptions = {}): LoopbackMcpServer {
  const userMemoryFile = options.userMemoryFile ?? homeMuse("user-memory.json");
  const tasksFile = options.tasksFile ?? homeMuse("tasks.json");
  const historyFile = options.historyFile ?? homeMuse("proactive-history.json");
  const logFile = options.logFile ?? homeMuse("notifications.log");
  const trustFile = options.trustFile ?? homeMuse("trust.json");
  const remindersFile = options.remindersFile ?? homeMuse("reminders.json");
  const followupsFile = options.followupsFile ?? homeMuse("followups.json");
  const objectivesFile = options.objectivesFile ?? homeMuse("objectives.json");
  const sessionLockFile = options.sessionLockFile ?? homeMuse("session-lock.json");
  const episodesFile = options.episodesFile ?? homeMuse("episodes.json");
  const patternsFiredFile = options.patternsFiredFile ?? homeMuse("patterns-fired.json");

  const snapshotTool: LoopbackMcpToolDefinition = {
    description:
      "Return a JARVIS-style snapshot of what Muse knows about the given user: " +
      "persona summary (counts of facts/prefs/vetoes/goals + last-update), current model, " +
      "open tasks (with the next 5 due-in-24h), standing objectives (active/escalated/done " +
      "counts + the first escalated objective needing the user), Do-Not-Disturb state " +
      "(session.dnd + until — proactive notices are paused while active), last proactive " +
      "notice, notification-log path + size, and the per-user trust list (trusted/blocked tool counts). " +
      "Pure file IO; sub-100ms. Use this when the external agent needs to reason about " +
      "the user's current state — what they're working on, what's queued, what Muse just notified them about.",
    execute: async (args: Record<string, unknown>): Promise<JsonObject> => {
      const userId = typeof args["user_id"] === "string" && args["user_id"].length > 0
        ? args["user_id"] as string
        : (process.env.MUSE_USER_ID?.trim() || process.env.USER?.trim() || "default");

      const memoryDoc = await safeReadJson(userMemoryFile) as
        | { users?: Record<string, unknown> }
        | undefined;
      const persona = (memoryDoc?.users?.[userId] ?? undefined) as
        | { facts?: Record<string, string>; preferences?: Record<string, string>; updatedAt?: string }
        | undefined;
      const factCount = persona?.facts ? Object.keys(persona.facts).length : 0;
      const preferenceCount = persona?.preferences ? Object.keys(persona.preferences).length : 0;
      const vetoCount = persona?.preferences
        ? Object.keys(persona.preferences).filter((k) => k.startsWith("veto:")).length
        : 0;
      const goalCount = persona?.preferences
        ? Object.keys(persona.preferences).filter((k) => k.startsWith("goal:")).length
        : 0;

      const tasksDoc = await safeReadJson(tasksFile) as { tasks?: readonly PersistedTask[] } | undefined;
      const allTasks = tasksDoc?.tasks ?? [];
      const now = Date.now();
      const due24h = allTasks.filter((task) => {
        if (task.status !== "open" || !task.dueAt) return false;
        const due = new Date(task.dueAt).getTime();
        return Number.isFinite(due) && due >= now && due <= now + 86_400_000;
      });

      const history = await readProactiveHistory(historyFile, 1).catch(() => []);
      const lastNotice = history[history.length - 1];

      const logBytes = await fileSize(logFile);

      const trustDoc = await safeReadJson(trustFile) as
        | { users?: Record<string, TrustEntry> }
        | undefined;
      const trust = trustDoc?.users?.[userId];

      // Dashboard summarizers — same shape `muse status` CLI uses,
      // shared via `personal-status-summary.ts`. Each load is
      // fail-soft (missing file → empty rows → empty summary)
      // because a fresh install hasn't written any of these yet.
      const [reminders, followups, objectives, episodesDoc, patternsDoc] = await Promise.all([
        readReminders(remindersFile).catch(() => [] as const),
        readFollowups(followupsFile).catch(() => [] as const),
        readObjectives(objectivesFile).catch(() => [] as const),
        safeReadJson(episodesFile).catch(() => undefined),
        safeReadJson(patternsFiredFile).catch(() => undefined)
      ]);
      const remindersSummary = summariseRemindersRows(reminders, now);
      const followupsSummary = summariseFollowupsRows(followups, userId);
      const objectivesSummary = summariseObjectivesRows(objectives, userId);
      // Do-Not-Disturb: the proactive loop skips firing while a session
      // lock holds, so an agent reasoning about the user's state (or
      // whether to surface something) must see it. Active → `until`
      // string; expired/missing/corrupt → undefined.
      const sessionLockUntil = await readSessionLock(sessionLockFile, new Date(now)).catch(() => undefined);
      const episodesRows = (episodesDoc as { episodes?: readonly unknown[] } | undefined)?.episodes ?? [];
      const episodesSummary = summariseEpisodesRows(episodesRows, userId);
      const patternsRows = (patternsDoc as { fired?: readonly unknown[] } | undefined)?.fired ?? [];
      const patternsSummary = summarisePatternsFiredRows(patternsRows);

      const snapshot: JsonObject = {
        episodes: {
          last_ended_at: episodesSummary.lastEndedAt ?? null,
          last_summary: episodesSummary.lastSummary ?? null,
          total: episodesSummary.total
        } as unknown as JsonValue,
        followups: {
          cancelled: followupsSummary.cancelled,
          fired: followupsSummary.fired,
          next_scheduled_for: followupsSummary.nextScheduledFor ?? null,
          next_scheduled_summary: followupsSummary.nextScheduledSummary ?? null,
          scheduled: followupsSummary.scheduled,
          total: followupsSummary.total
        } as unknown as JsonValue,
        objectives: {
          active: objectivesSummary.active,
          cancelled: objectivesSummary.cancelled,
          done: objectivesSummary.done,
          escalated: objectivesSummary.escalated,
          escalated_sample: objectivesSummary.escalatedSample ?? null,
          total: objectivesSummary.total
        } as unknown as JsonValue,
        session: {
          dnd: sessionLockUntil !== undefined,
          until: sessionLockUntil ?? null
        } as unknown as JsonValue,
        patterns: {
          last_fired_at: patternsSummary.lastFiredAtIso ?? null,
          total: patternsSummary.total
        } as unknown as JsonValue,
        reminders: {
          fired: remindersSummary.fired,
          next_due_at: remindersSummary.nextDueAt ?? null,
          next_text: remindersSummary.nextText ?? null,
          overdue: remindersSummary.overdue,
          pending: remindersSummary.pending,
          total: remindersSummary.total
        } as unknown as JsonValue,
        log: {
          bytes: logBytes ?? null,
          file: logFile
        },
        last_notice: lastNotice ? ({
          fired_at: lastNotice.firedAtIso,
          kind: lastNotice.kind,
          provider_id: lastNotice.providerId,
          status: lastNotice.status,
          text: lastNotice.text,
          title: lastNotice.title
        } as unknown as JsonValue) : null,
        model: (options.model?.trim() || process.env.MUSE_MODEL?.trim() || null) as JsonValue,
        persona: {
          fact_count: factCount,
          goal_count: goalCount,
          preference_count: preferenceCount,
          updated_at: persona?.updatedAt ?? null,
          user_id: userId,
          veto_count: vetoCount
        } as unknown as JsonValue,
        tasks: {
          due_next_24h: due24h.slice(0, 5).map((task) => ({
            due_at: task.dueAt ?? null,
            id: task.id ?? null,
            title: task.title ?? null,
            urgent: task.urgent === true
          })) as unknown as JsonValue,
          total_open: allTasks.filter((task) => task.status === "open").length
        } as unknown as JsonValue,
        trust: {
          blocked_count: trust?.blockedTools?.length ?? 0,
          trusted_count: trust?.trustedTools?.length ?? 0,
          trusted_sample: (trust?.trustedTools ?? []).slice(0, 3) as unknown as JsonValue
        } as unknown as JsonValue
      };
      return snapshot;
    },
    inputSchema: {
      additionalProperties: false,
      properties: {
        user_id: {
          description: "User identity (default $MUSE_USER_ID or $USER). Persona slots are addressed as '<user>@<persona>'.",
          type: "string"
        }
      },
      type: "object"
    },
    domain: "tasks",
    name: "snapshot",
    risk: "read"
  };

  // Walk MUSE_NOTES_DIR for one-line "what notes does Muse hold?"
  const notesIndexTool: LoopbackMcpToolDefinition = {
    description: "List the Markdown files Muse considers personal notes (under MUSE_NOTES_DIR or ~/.muse/notes/). Returns relative path + size — no contents. Use this as a discovery surface before deciding to embed/search.",
    execute: async (): Promise<JsonObject> => {
      const fromEnv = process.env.MUSE_NOTES_DIR?.trim();
      const dir = fromEnv && fromEnv.length > 0 ? fromEnv : pathJoin(homedir(), ".muse", "notes");
      try {
        const entries = await readdir(dir, { withFileTypes: true });
        // The description promises "relative path + size"; stat each file for its
        // byte size (fileSize returns undefined on a TOCTOU delete, so one racing
        // file can't blank the whole index).
        const files = await Promise.all(
          entries
            .filter((e) => e.isFile() && /\.(md|markdown|txt)$/i.test(e.name))
            .map(async (e) => ({ name: e.name, size: await fileSize(pathJoin(dir, e.name)) }))
        );
        return {
          dir,
          files: files as unknown as JsonValue,
          total: files.length
        };
      } catch (cause) {
        return { dir, error: cause instanceof Error ? cause.message : String(cause) };
      }
    },
    inputSchema: { additionalProperties: false, properties: {}, type: "object" },
    domain: "tasks",
    name: "notes_index",
    risk: "read"
  };

  return {
    description:
      "JARVIS self-observability: snapshot of persona + tasks + last notice + trust, plus a notes-index list. " +
      "Loopback MCP — readonly. Pair with the muse.notes / muse.tasks / muse.calendar servers for full external agent access.",
    name: "muse.status",
    tools: [snapshotTool, notesIndexTool]
  };
}
