/**
 * Loopback MCP tool wiring — extracted from
 * `createMuseRuntimeAssembly` so the main assembly file no longer
 * carries 95 LOC of nearly-identical `createXxxMcpServer + wrap`
 * blocks. Each personal store / registry that exposes an MCP
 * loopback surface gets a small builder here; the assembly
 * destructures the bundle and hands the tool arrays to the
 * `DynamicToolRegistry`.
 *
 * Pure refactor — every existing env flag, gate, and option
 * spread is preserved line-for-line. The `contextReference`
 * loopback stays inline in the assembly because it's `let`-mutated
 * later (assigned after `activeContextProvider` is built).
 */

import {
  createCalendarMcpServer,
  createEpisodesMcpServer,
  createFollowupsMcpServer,
  createHistoryMcpServer,
  createLoopbackMcpMuseTools,
  createMathMcpServer,
  createMessagingMcpServer,
  createNotesMcpServer,
  createNotesRegistryMcpServer,
  createPatternsMcpServer,
  createProactiveMcpServer,
  createRemindersMcpServer,
  createStatusMcpServer,
  createTasksMcpServer,
  createTasksRegistryMcpServer,
  createWebReadMcpServer,
  type MessageApprovalGate
} from "@muse/mcp";
import type { NotesProviderRegistry, TasksProviderRegistry } from "@muse/mcp";
import type { CalendarProviderRegistry } from "@muse/calendar";
import type { MessagingProviderRegistry } from "@muse/messaging";
import type { MuseTool } from "@muse/tools";
import type { ModelProvider } from "@muse/model";

import { parseBoolean, parseInteger } from "./env-parsers.js";
import type { MuseEnvironment } from "./index.js";

export interface LoopbackToolsDeps {
  readonly env: MuseEnvironment;
  /** Optional LLM provider for `mode: "llm-judge"` paths on notes / episodes search. */
  readonly modelProvider?: ModelProvider;
  readonly defaultModel?: string;
  // File paths the assembly already resolved.
  readonly notesDir: string;
  readonly tasksFile: string;
  readonly remindersFile: string;
  readonly reminderHistoryFile: string;
  readonly proactiveHistoryFile: string;
  readonly followupsFile: string;
  readonly episodesFile: string;
  readonly patternsFiredFile: string;
  // Registries the assembly already constructed.
  readonly notesRegistry: NotesProviderRegistry | undefined;
  readonly calendarRegistry: CalendarProviderRegistry;
  readonly tasksRegistry: TasksProviderRegistry | undefined;
  readonly messagingRegistry: MessagingProviderRegistry;
  readonly pollAll: (() => Promise<{
    readonly ingestedByProvider: Readonly<Record<string, number>>;
    readonly errors: readonly { readonly providerId: string; readonly message: string }[];
  }>) | undefined;
  readonly pollNow: ((providerId: string, source?: string) => Promise<{ ingested: number }>) | undefined;
  // Outbound-safety: lets `muse.messaging.send` action-log every send.
  readonly actionLogFile: string;
  readonly userId: string;
  /**
   * Draft-first approval gate for the agent's `muse.messaging.send`. When the
   * CLI runs interactively it passes a clack-confirm gate (show the exact draft,
   * fire only on confirm). Absent (server/daemon, non-interactive) → the send
   * tool fail-closes (it never auto-sends — outbound-safety, P41-11).
   */
  readonly messagingApprovalGate?: MessageApprovalGate;
}

export interface LoopbackToolsBundle {
  readonly notes: readonly MuseTool[];
  readonly notesRegistry: readonly MuseTool[];
  readonly calendar: readonly MuseTool[];
  readonly tasks: readonly MuseTool[];
  readonly tasksRegistry: readonly MuseTool[];
  readonly messaging: readonly MuseTool[];
  readonly reminders: readonly MuseTool[];
  readonly proactive: readonly MuseTool[];
  readonly followups: readonly MuseTool[];
  readonly episodes: readonly MuseTool[];
  readonly patterns: readonly MuseTool[];
  readonly history: readonly MuseTool[];
  readonly status: readonly MuseTool[];
  readonly webRead: readonly MuseTool[];
  readonly math: readonly MuseTool[];
}

export function buildLoopbackTools(deps: LoopbackToolsDeps): LoopbackToolsBundle {
  const { env } = deps;
  const llmJudge = deps.modelProvider && deps.defaultModel
    ? { model: deps.defaultModel, modelProvider: deps.modelProvider }
    : {};

  const notes = parseBoolean(env.MUSE_NOTES_ENABLED, true)
    ? createLoopbackMcpMuseTools(createNotesMcpServer({
        notesDir: deps.notesDir,
        // LLM-judge search mode opts in only when modelProvider +
        // defaultModel are wired (same gate as episodes). Substring
        // mode keeps working without a model.
        ...llmJudge
      }))
    : [];

  // Notes registry MCP surface (`muse.notes-multi`): only registered
  // when the user opts into >1 provider via MUSE_NOTES_PROVIDERS.
  const notesRegistry = deps.notesRegistry && deps.notesRegistry.list().length >= 2
    ? createLoopbackMcpMuseTools(createNotesRegistryMcpServer({ registry: deps.notesRegistry }))
    : [];

  const calendar = parseBoolean(env.MUSE_CALENDAR_ENABLED, true) && deps.calendarRegistry.list().length > 0
    ? createLoopbackMcpMuseTools(createCalendarMcpServer({ registry: deps.calendarRegistry, remindersFile: deps.remindersFile }))
    : [];

  const tasks = parseBoolean(env.MUSE_TASKS_ENABLED, true)
    ? createLoopbackMcpMuseTools(
        createTasksMcpServer({ file: deps.tasksFile, maxListEntries: parseInteger(env.MUSE_TASKS_LIST_MAX, 12) })
      )
    : [];

  // Tasks registry MCP surface (`muse.tasks-multi`): symmetric with
  // notesRegistry — only when the user opts into >1 provider.
  const tasksRegistry = deps.tasksRegistry && deps.tasksRegistry.list().length >= 2
    ? createLoopbackMcpMuseTools(createTasksRegistryMcpServer({ registry: deps.tasksRegistry }))
    : [];

  // Messaging loopback: only registered when at least one provider
  // is configured, so the LLM doesn't see a tool that always
  // errors with "no providers configured".
  const messaging = deps.messagingRegistry.list().length > 0 && deps.pollAll && deps.pollNow
    ? createLoopbackMcpMuseTools(createMessagingMcpServer({
        actionLogFile: deps.actionLogFile,
        ...(deps.messagingApprovalGate ? { approvalGate: deps.messagingApprovalGate } : {}),
        pollAll: deps.pollAll,
        pollNow: deps.pollNow,
        registry: deps.messagingRegistry,
        userId: deps.userId
      }))
    : [];

  // Reminders loopback: always registered. The store self-creates
  // on first write; the file may be absent on fresh installs.
  const reminders = createLoopbackMcpMuseTools(
    createRemindersMcpServer({
      file: deps.remindersFile,
      historyFile: deps.reminderHistoryFile,
      maxListEntries: parseInteger(env.MUSE_REMINDERS_LIST_MAX, 12)
    })
  );

  // Proactive audit loopback — `muse.proactive.history`.
  const proactive = createLoopbackMcpMuseTools(
    createProactiveMcpServer({ historyFile: deps.proactiveHistoryFile })
  );

  // Self-followup loopback — list / cancel / snooze the agent's
  // own captured promises.
  const followups = createLoopbackMcpMuseTools(
    createFollowupsMcpServer({ file: deps.followupsFile })
  );

  // Episode loopback — read-shaped tools plus user-revocable
  // remove/clear. No agent-side `add` (capture is automatic at
  // REPL exit; manual add would let the LLM lie about history).
  const episodes = createLoopbackMcpMuseTools(
    createEpisodesMcpServer({
      file: deps.episodesFile,
      ...llmJudge
    })
  );

  // Pattern loopback — run detectors on demand, audit fired
  // history, reset cooldown. The daemon stays the sole firer.
  const patterns = createLoopbackMcpMuseTools(
    createPatternsMcpServer({
      file: deps.patternsFiredFile,
      notesDir: deps.notesDir,
      tasksFile: deps.tasksFile
    })
  );

  // Unified activity-feed loopback — `muse.history.recent`.
  // Mirrors the `muse history` CLI; lets a chat-REPL or external
  // agent answer "what did you do last night?" without fanning
  // out across muse.reminders.history / muse.proactive.history /
  // muse.followups.list / etc.
  const history = createLoopbackMcpMuseTools(
    createHistoryMcpServer({
      episodesFile: deps.episodesFile,
      followupsFile: deps.followupsFile,
      patternsFiredFile: deps.patternsFiredFile,
      proactiveHistoryFile: deps.proactiveHistoryFile,
      reminderHistoryFile: deps.reminderHistoryFile
    })
  );

  // JARVIS self-observability loopback — `muse.status.snapshot`.
  // The `model` field is the autoconfigure-resolved defaultModel
  // (which already merges ~/.muse/models.json's suggestedModel),
  // so an external Claude-Desktop agent calling this tool sees the
  // same model the runtime actually uses — not the env-only view
  // that previously misreported "null" for wizard-only setups.
  // Passes every dashboard store-path resolved by autoconfigure so
  // the snapshot covers the same surface as `muse status` CLI
  // (reminders + followups + episodes + patterns). userMemoryFile
  // + trustFile fall back to ~/.muse/*.json inside the loopback
  // server.
  const status = createLoopbackMcpMuseTools(
    createStatusMcpServer({
      episodesFile: deps.episodesFile,
      followupsFile: deps.followupsFile,
      historyFile: deps.proactiveHistoryFile,
      patternsFiredFile: deps.patternsFiredFile,
      remindersFile: deps.remindersFile,
      tasksFile: deps.tasksFile,
      ...(deps.defaultModel ? { model: deps.defaultModel } : {})
    })
  );

  // Readable web-page reader — `muse.web.read`. Default-on perception so
  // "summarize this URL" works without a running Chrome or a per-host
  // fetch allowlist; SSRF-guarded to public hosts inside the server.
  const webRead = parseBoolean(env.MUSE_WEB_READ_ENABLED, true)
    ? createLoopbackMcpMuseTools(createWebReadMcpServer())
    : [];

  // Deterministic arithmetic — `muse.math.evaluate`. Default-on: a local 8B is
  // unreliable at digits, so any answer that depends on a calculation should go
  // through the exact evaluator. Dependency-free + input-validated (never an
  // always-erroring tool), so it's always safe to expose.
  const math = parseBoolean(env.MUSE_MATH_ENABLED, true)
    ? createLoopbackMcpMuseTools(createMathMcpServer())
    : [];

  return {
    calendar,
    episodes,
    followups,
    history,
    math,
    messaging,
    notes,
    notesRegistry,
    patterns,
    proactive,
    reminders,
    status,
    tasks,
    tasksRegistry,
    webRead
  };
}
