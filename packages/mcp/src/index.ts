import type { StdioServerParameters } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createRunId, type JsonObject, type JsonValue } from "@muse/shared";
import type { MuseTool, ToolRisk } from "@muse/tools";

export type Awaitable<T> = T | Promise<T>;
export type McpTransportType = "stdio" | "sse" | "streamable" | "http";
export type McpServerStatus = "pending" | "connecting" | "connected" | "disconnected" | "failed" | "disabled";
export type McpHealthStatus = "unknown" | "healthy" | "unhealthy";

export interface McpServer {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly transportType: McpTransportType;
  readonly config: JsonObject;
  readonly version?: string;
  readonly autoConnect: boolean;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface McpServerInput {
  readonly id?: string;
  readonly name: string;
  readonly description?: string | null;
  readonly transportType: McpTransportType;
  readonly config?: JsonObject;
  readonly version?: string | null;
  readonly autoConnect?: boolean;
  readonly createdAt?: Date;
  readonly updatedAt?: Date;
}

export interface McpServerStore {
  list(): Awaitable<readonly McpServer[]>;
  findByName(name: string): Awaitable<McpServer | undefined>;
  save(input: McpServerInput): Awaitable<McpServer>;
  update(name: string, input: McpServerInput): Awaitable<McpServer | undefined>;
  delete(name: string): Awaitable<void>;
}

export interface McpSecurityPolicy {
  readonly allowedServerNames: readonly string[];
  readonly maxToolOutputLength: number;
  readonly allowedStdioCommands: readonly string[];
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface McpSecurityPolicyInput {
  readonly allowedServerNames?: readonly string[];
  readonly maxToolOutputLength?: number;
  readonly allowedStdioCommands?: readonly string[];
}

export interface McpSecurityPolicyStore {
  getOrNull(): Awaitable<McpSecurityPolicy | undefined>;
  save(input: McpSecurityPolicyInput): Awaitable<McpSecurityPolicy>;
  delete(): Awaitable<boolean>;
}

export interface McpRemoteTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema?: JsonObject;
  readonly risk?: ToolRisk;
  /**
   * Context Engineering Phase 4 hint. When set, `createMcpMuseTool`
   * forwards this to `MuseToolDefinition.domain` so DefaultToolFilter
   * skips the name-prefix heuristic. Loopback servers tag their tools
   * explicitly; external MCP servers usually don't supply this and
   * fall back to the heuristic as before.
   */
  readonly domain?: string;
}

export interface McpConnection {
  listTools(): Awaitable<readonly McpRemoteTool[]>;
  callTool?(toolName: string, args: JsonObject): Awaitable<string | JsonValue>;
  close?(): Awaitable<void>;
}

export interface McpTransportConnector {
  connect(server: McpServer, policy: McpSecurityPolicy): Promise<McpConnection>;
}

export interface DefaultMcpTransportConnectorOptions {
  readonly clientName?: string;
  readonly clientVersion?: string;
  readonly requestTimeoutMs?: number;
  readonly allowPrivateAddresses?: boolean;
  readonly stderr?: StdioServerParameters["stderr"];
  /**
   * Filesystem paths exposed to MCP servers via the `roots/list`
   * request. When provided, the client advertises the `roots`
   * capability and answers server-issued `roots/list` calls with
   * these paths as `file://` URIs. When undefined or empty, the
   * client still advertises the capability (so spec-compliant MCP
   * servers stop logging `Client does not support MCP Roots`
   * warnings and fall back to argv-based directories) but returns
   * an empty roots list.
   *
   * Personal-JARVIS default: empty. The user opts in via
   * `MUSE_MCP_CLIENT_ROOTS` (comma-separated absolute paths) when
   * a specific external MCP server (filesystem, search, etc.)
   * needs broader directory access than its launch args allow.
   */
  readonly clientRoots?: readonly string[];
}

export interface McpServerValidationOptions {
  readonly allowPrivateAddresses?: boolean;
}

export interface McpManagerOptions {
  readonly connector?: McpTransportConnector;
  readonly reconnect?: Partial<McpReconnectPolicy>;
  readonly securityPolicyProvider?: McpSecurityPolicyProvider;
  readonly store?: McpServerStore;
  readonly validation?: McpServerValidationOptions;
  readonly now?: () => Date;
}

export interface McpReconnectPolicy {
  readonly enabled: boolean;
  readonly maxAttempts: number;
  readonly initialDelayMs: number;
  readonly maxDelayMs: number;
}

export interface McpHealthSnapshot {
  readonly serverName: string;
  readonly status: McpHealthStatus;
  readonly checkedAt?: Date;
  readonly error?: string;
  readonly reconnectAttempts: number;
  readonly nextReconnectAt?: Date;
  readonly toolCount: number;
}

export type McpPreflightCheckStatus = "pass" | "warn" | "fail";

export interface McpPreflightCheck {
  readonly code: string;
  readonly message: string;
  readonly status: McpPreflightCheckStatus;
}

export interface McpPreflightReport {
  readonly checks: readonly McpPreflightCheck[];
  readonly health: McpHealthSnapshot;
  readonly ok: boolean;
  readonly readyForProduction: boolean;
  readonly serverName: string;
  readonly status: McpServerStatus;
  readonly summary: {
    readonly failCount: number;
    readonly passCount: number;
    readonly warnCount: number;
  };
}

export interface InMemoryMcpServerStoreOptions {
  readonly idFactory?: () => string;
  readonly maxServers?: number;
  readonly now?: () => Date;
}

export interface InMemoryMcpSecurityPolicyStoreOptions {
  readonly initial?: McpSecurityPolicyInput;
  readonly now?: () => Date;
}

export interface KyselyMcpServerStoreOptions {
  readonly idFactory?: () => string;
  readonly now?: () => Date;
}

export interface KyselyMcpSecurityPolicyStoreOptions {
  readonly now?: () => Date;
}

const defaultAllowedStdioCommands = ["npx", "node", "python", "python3", "uvx", "uv", "docker", "deno", "bun"] as const;
const defaultMaxToolOutputLength = 50_000;
const defaultMcpReconnectPolicy: McpReconnectPolicy = {
  enabled: true,
  initialDelayMs: 1_000,
  maxAttempts: 3,
  maxDelayMs: 30_000
};
const minToolOutputLength = 1_024;
const maxToolOutputLength = 500_000;

export class InMemoryMcpServerStore implements McpServerStore {
  static readonly defaultMaxServers = 1_000;

  private readonly idFactory: () => string;
  private readonly maxServers: number;
  private readonly now: () => Date;
  private readonly servers = new Map<string, McpServer>();

  constructor(options: InMemoryMcpServerStoreOptions = {}) {
    this.idFactory = options.idFactory ?? (() => createRunId("mcp_server"));
    this.maxServers = options.maxServers ?? InMemoryMcpServerStore.defaultMaxServers;
    this.now = options.now ?? (() => new Date());
  }

  list(): readonly McpServer[] {
    return [...this.servers.values()].sort(compareServers);
  }

  findByName(name: string): McpServer | undefined {
    return this.servers.get(name);
  }

  save(input: McpServerInput): McpServer {
    if (this.servers.has(input.name)) {
      throw new McpRegistryError(`MCP server already exists: ${input.name}`);
    }

    const server = normalizeMcpServerInput(input, {
      id: input.id ?? this.idFactory(),
      now: this.now
    });

    this.servers.set(server.name, server);
    this.evictOverflow();
    return server;
  }

  update(name: string, input: McpServerInput): McpServer | undefined {
    const existing = this.servers.get(name);

    if (!existing) {
      return undefined;
    }

    const updated = normalizeMcpServerInput(
      {
        ...input,
        id: existing.id,
        name,
        createdAt: existing.createdAt
      },
      {
        id: existing.id,
        now: this.now
      }
    );

    this.servers.set(name, updated);
    return updated;
  }

  delete(name: string): void {
    this.servers.delete(name);
  }

  private evictOverflow(): void {
    while (this.servers.size > this.maxServers) {
      const oldest = this.list()[0];

      if (!oldest) {
        return;
      }

      this.servers.delete(oldest.name);
    }
  }
}

export class InMemoryMcpSecurityPolicyStore implements McpSecurityPolicyStore {
  private readonly now: () => Date;
  private policy?: McpSecurityPolicy;

  constructor(options: InMemoryMcpSecurityPolicyStoreOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.policy = options.initial ? normalizeMcpSecurityPolicy(options.initial, this.now()) : undefined;
  }

  getOrNull(): McpSecurityPolicy | undefined {
    return this.policy;
  }

  save(input: McpSecurityPolicyInput): McpSecurityPolicy {
    const now = this.now();
    const saved = {
      ...normalizeMcpSecurityPolicy(input, now),
      createdAt: this.policy?.createdAt ?? now,
      updatedAt: now
    };

    this.policy = saved;
    return saved;
  }

  delete(): boolean {
    const existed = Boolean(this.policy);
    this.policy = undefined;
    return existed;
  }
}

export class McpSecurityPolicyProvider {
  constructor(
    private readonly store: McpSecurityPolicyStore = new InMemoryMcpSecurityPolicyStore(),
    private readonly defaults: McpSecurityPolicyInput = {}
  ) {}

  async currentPolicy(): Promise<McpSecurityPolicy> {
    const stored = await this.store.getOrNull();

    if (stored) {
      return normalizeMcpSecurityPolicy(stored, stored.updatedAt);
    }

    return this.configDefaultPolicy();
  }

  configDefaultPolicy(): McpSecurityPolicy {
    return normalizeMcpSecurityPolicy(this.defaults, new Date(0));
  }

  async isServerAllowed(serverName: string): Promise<boolean> {
    const policy = await this.currentPolicy();

    return policy.allowedServerNames.length === 0 || policy.allowedServerNames.includes(serverName);
  }
}

// McpManager runtime registry lives in `./manager.ts`.
// Re-export so external call-sites stay byte-identical.
export { McpManager } from "./manager.js";


// Transport connector + SDK connection adapter live in `./transport.ts`
//. Re-export so external call-sites stay byte-identical.
export { DefaultMcpTransportConnector } from "./transport.js";

// Kysely-backed persistence lives in `packages/mcp/src/server-stores.ts`
//. Re-export so existing call-sites stay byte-identical.
export { KyselyMcpSecurityPolicyStore, KyselyMcpServerStore } from "./server-stores.js";


export class McpRegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpRegistryError";
  }
}

export class McpConnectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpConnectionError";
  }
}

export function normalizeMcpServerInput(
  input: McpServerInput,
  options: {
    readonly id: string;
    readonly now: () => Date;
  }
): McpServer {
  const createdAt = input.createdAt ?? options.now();

  return {
    autoConnect: input.autoConnect ?? false,
    config: input.config ?? {},
    createdAt,
    description: input.description ?? undefined,
    id: options.id,
    name: input.name,
    transportType: input.transportType,
    updatedAt: input.updatedAt ?? createdAt,
    version: input.version ?? undefined
  };
}

export function normalizeMcpSecurityPolicy(input: McpSecurityPolicyInput, now: Date): McpSecurityPolicy {
  return {
    allowedServerNames: uniqueStrings(input.allowedServerNames ?? []),
    allowedStdioCommands: uniqueStrings(input.allowedStdioCommands ?? defaultAllowedStdioCommands),
    createdAt: "createdAt" in input && input.createdAt instanceof Date ? input.createdAt : now,
    maxToolOutputLength: clamp(
      input.maxToolOutputLength ?? defaultMaxToolOutputLength,
      minToolOutputLength,
      maxToolOutputLength
    ),
    updatedAt: "updatedAt" in input && input.updatedAt instanceof Date ? input.updatedAt : now
  };
}

export function normalizeReconnectPolicy(input: Partial<McpReconnectPolicy> | undefined): McpReconnectPolicy {
  return {
    enabled: input?.enabled ?? defaultMcpReconnectPolicy.enabled,
    initialDelayMs: positiveInteger(input?.initialDelayMs, defaultMcpReconnectPolicy.initialDelayMs),
    maxAttempts: positiveInteger(input?.maxAttempts, defaultMcpReconnectPolicy.maxAttempts),
    maxDelayMs: positiveInteger(input?.maxDelayMs, defaultMcpReconnectPolicy.maxDelayMs)
  };
}

export {
  isPrivateOrReservedHost,
  isPublicHttpUrl,
  validateMcpServer,
  validateStdioArgs,
  validateStdioCommand
} from "./validators.js";

export function createMcpMuseTool(serverName: string, tool: McpRemoteTool, connection: McpConnection): MuseTool {
  return {
    definition: {
      description: tool.description,
      ...(tool.domain ? { domain: tool.domain } : {}),
      inputSchema: tool.inputSchema ?? {},
      name: `${serverName}.${tool.name}`,
      risk: tool.risk ?? "read"
    },
    execute: async (args) => {
      if (!connection.callTool) {
        return `Error: MCP tool '${tool.name}' is not callable`;
      }

      return connection.callTool(tool.name, args);
    }
  };
}

// Row builders + mappers live in `./server-stores.ts`.
// Re-exported so external call-sites stay byte-identical.
export {
  createMcpSecurityPolicyInsert,
  createMcpServerInsert,
  createMcpServerUpdate,
  mapMcpSecurityPolicyRow,
  mapMcpServerRow
} from "./server-stores.js";


function compareServers(left: McpServer, right: McpServer): number {
  return left.createdAt.getTime() - right.createdAt.getTime() || left.name.localeCompare(right.name);
}

function uniqueStrings(values: readonly string[]): readonly string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isInteger(value) && value > 0 ? value : fallback;
}

export {
  createCryptoMcpServer,
  createDefaultLoopbackMcpServers,
  createCalendarMcpServer,
  createTasksMcpServer,
  createDiffMcpServer,
  createFetchMcpServer,
  createFilesystemMcpServer,
  describeBuiltinLoopbackMcpServers,
  createJsonMcpServer,
  createLoopbackMcpConnection,
  createLoopbackMcpMuseTools,
  createMathMcpServer,
  createNotesMcpServer,
  createRegexMcpServer,
  createSearchMcpServer,
  createTextUtilsMcpServer,
  createTimeMcpServer,
  createUrlMcpServer,
  type BuiltinLoopbackOptions,
  type FetchMcpServerOptions,
  type FilesystemMcpServerOptions,
  type LoopbackMcpCatalogEntry,
  type LoopbackMcpServer,
  type LoopbackMcpToolDefinition,
  type NotesMcpServerOptions,
  type SearchMcpServerOptions
} from "./loopback.js";

// Notes provider abstraction. LocalDir, Apple Notes (osascript), and
// Notion (api.notion.com) are all real adapters. The `muse.notes-multi`
// MCP server in `loopback-notes-registry.ts` routes between them via
// providerId.
export {
  createNotesRegistryMcpServer,
  type NotesRegistryMcpServerOptions
} from "./loopback-notes-registry.js";

// Tasks registry MCP server. Companion to muse.tasks
// (filesystem-only) — exposes `muse.tasks-multi.*` against any
// composed TasksProviderRegistry.
export {
  createTasksRegistryMcpServer,
  type TasksRegistryMcpServerOptions
} from "./loopback-tasks-registry.js";

// Relative-time phrase resolver (originally loopback-tasks-only).
// Re-exported so HTTP routes can mirror the MCP tool's dueAt parsing
// rather than duplicate semantics.
export { resolveRelativeTimePhrase } from "./loopback-relative-time.js";

// Personal task store — pure data layer shared between the MCP tool,
// the REST routes, and the CLI's --local mode.
export {
  compareTasksByDueDate,
  parseTaskDueAt,
  readTasks,
  readTaskStatusFilter,
  serializeTask,
  writeTasks,
  type PersistedTask,
  type TaskStatusFilter
} from "./personal-tasks-store.js";

// Personal followups store — agent-self-followup design doc step 2.
// The detector (`extractFollowupPromises` in @muse/agent-core)
// produces typed promises; this layer persists them to
// `~/.muse/followups.json` so the firing daemon (later step) can
// pick them up and honour them.
export {
  cancelFollowup,
  markFollowupFired,
  readFollowups,
  readFollowupStatusFilter,
  serializeFollowup,
  snoozeFollowup,
  upsertFollowup,
  writeFollowups,
  type FollowupStatus,
  type FollowupStatusFilter,
  type PersistedFollowup
} from "./personal-followups-store.js";

// LLM-fallback budget tracker — step 5 of agent-self-followup.md.
// Per-day counter so MUSE_FOLLOWUP_LLM_FALLBACK=true can't
// silently burn the user's quota.
export {
  formatLocalDay as formatFollowupLlmBudgetDay,
  incrementFollowupLlmBudget,
  isFollowupLlmBudgetExhausted,
  readFollowupLlmBudget,
  writeFollowupLlmBudget,
  type FollowupLlmBudgetRecord
} from "./personal-followup-llm-budget-store.js";

// Pattern-detection cooldown sidecar — step 4 of
// docs/design/pattern-detection.md. Tracks the last firing time
// per detector-assigned pattern id so a fired suggestion does not
// re-spam the user within MUSE_PROACTIVE_PATTERN_COOLDOWN_MS.
export {
  isPatternOnCooldown,
  readPatternsFired,
  recordPatternFired,
  writePatternsFired,
  type PatternFiredRecord
} from "./personal-patterns-fired-store.js";

// Pattern-detection firing engine — wiring half of step 4. The
// `apps/api/src/pattern-tick.ts` setInterval rider drives this on
// MUSE_PROACTIVE_PATTERN_TICK_MS; the engine itself is pure data
// over the messaging registry + cooldown sidecar so tests skip the
// daemon entirely.
export {
  runDuePatternNotices,
  type RunDuePatternNoticesOptions,
  type RunDuePatternNoticesSummary
} from "./pattern-firing-loop.js";
export { type AgentInitiatedNoticeBrokerLike } from "./proactive-notice-loop.js";

// Episodic memory store — step 1 of docs/design/episodic-memory.md.
// Pure CRUD over `~/.muse/episodes.json`; later steps add the
// session-boundary sentinel, end-of-session summariser hook,
// persona surfacing, and `muse episode` CLI.
export {
  clearEpisodes,
  readEpisodes,
  removeEpisode,
  serializeEpisode,
  upsertEpisode,
  vacuumEpisodes,
  writeEpisodes,
  type PersistedEpisode
} from "./personal-episodes-store.js";

// Self-followup firing engine — step 4 of agent-self-followup.md.
// Re-enters the model to compose the delivery message, sends via
// the messaging registry, marks the entry fired.
export {
  runDueFollowups,
  type RunDueFollowupsOptions,
  type RunDueFollowupsSummary
} from "./followup-firing-loop.js";

// Personal reminders store — passive reminder list shared between
// the REST routes, the CLI, and `muse today` (both surfaces).
export {
  filterReminders,
  fireReminder,
  parseReminderDueAt,
  parseReminderVia,
  readReminders,
  readReminderStatusFilter,
  serializeReminder,
  writeReminders,
  type PersistedReminder,
  type ReminderStatusFilter,
  type ReminderVia
} from "./personal-reminders-store.js";

export {
  appendReminderHistory,
  readReminderHistory,
  type AppendReminderHistoryOptions,
  type ReminderHistoryEntry
} from "./personal-reminder-history-store.js";

// Phase B firing engine — see docs/design/reminder-firing.md. The
// CLI's `muse remind run` and a future scheduler hook share this.
export {
  runDueReminders,
  type RunDueRemindersOptions,
  type RunDueRemindersSummary
} from "./reminder-firing-loop.js";

// Proactive surfacing (Phase A — calendar imminence, Phase B —
// tasks due-soon). See docs/design/proactive-surfacing.md.
export {
  readProactiveFired,
  runDueProactiveNotices,
  writeProactiveFired,
  type ProactiveActivitySource,
  type ProactiveAgentRuntimeLike,
  type ProactiveFiredEntry,
  type ProactiveFiredKind,
  type ProactiveModelProviderLike,
  type RunDueProactiveNoticesOptions,
  type RunDueProactiveNoticesSummary
} from "./proactive-notice-loop.js";
export {
  appendProactiveHistory,
  readProactiveHistory,
  type AppendProactiveHistoryOptions,
  type ProactiveHistoryEntry
} from "./personal-proactive-history-store.js";

// Outbound messaging loopback (Phase 3 of docs/design/messaging.md):
// the LLM can call `muse.messaging.{providers, send}` once the user
// has wired any provider via env tokens.
export {
  createMessagingMcpServer,
  type MessagingMcpServerOptions
} from "./loopback-messaging.js";

// Reminders loopback — the LLM can add/list/clear reminders against
// the same `~/.muse/reminders.json` the CLI / REST surface uses.
// Read-only at fire time; passive surfacing through `muse today`.
export {
  createRemindersMcpServer,
  type RemindersMcpServerOptions
} from "./loopback-reminders.js";

// Followup loopback — agent introspection + control over its own
// self-captured follow-up promises. List/cancel/snooze only; capture
// is automatic via the runtime hook, firing is daemon-only.
export {
  createFollowupsMcpServer,
  type FollowupsMcpServerOptions
} from "./loopback-followups.js";

// Episode loopback — agent introspection over prior-session
// summaries. List / search / show / remove / clear; capture is
// automatic via the REPL exit hook, never agent-issued.
export {
  createEpisodesMcpServer,
  type EpisodesMcpServerOptions
} from "./loopback-episodes.js";

// Pattern loopback — agent-driven audit + cooldown reset. The
// daemon stays the sole firer (no `fire`/`record` tool here).
export {
  createPatternsMcpServer,
  type PatternsMcpServerOptions
} from "./loopback-patterns.js";

// Proactive surfacing audit loopback — `muse.proactive.history`
// over ~/.muse/proactive-history.json.
export {
  createProactiveMcpServer,
  type ProactiveMcpServerOptions
} from "./loopback-proactive.js";

// JARVIS self-observability loopback — `muse.status.snapshot` for
// external clients (Codex / Claude Desktop) to read persona +
// tasks + last notice + trust in one structured call.
export {
  createStatusMcpServer,
  type StatusMcpServerOptions
} from "./loopback-status.js";

// Unified activity-feed loopback — `muse.history.recent` merges
// the five personal audit stores so an agent can answer
// "what did you do for me?" in one call instead of fanning out
// across muse.reminders.history / muse.proactive.history / etc.
export {
  createHistoryMcpServer,
  type HistoryMcpServerOptions
} from "./loopback-history.js";

// Underlying helper, exported so the CLI's `muse history` command
// shares the merge logic instead of duplicating it.
export {
  ACTIVITY_KINDS,
  readActivityFeed,
  type ActivityEntry,
  type ActivityKind,
  type ReadActivityFeedOptions
} from "./personal-activity-feed.js";

// Context reference MCP server (Context Engineering 1.d
// foundation). `muse.context.fetch` / `muse.context.list` against an
// in-process ContextReferenceStore.
export {
  createContextReferenceMcpServer,
  type ContextReferenceMcpServerOptions
} from "./loopback-context.js";

export {
  AppleNotesProvider,
  LocalDirNotesProvider,
  NotesProviderError,
  NotesProviderRegistry,
  NotesValidationError,
  NotionNotesProvider,
  type AppleNotesProviderOptions,
  type LocalDirNotesProviderOptions,
  type NotesAppendInput,
  type NotesContent,
  type NotesEntry,
  type NotesProvider,
  type NotesProviderInfo,
  type NotesSaveInput,
  type NotesSearchHit,
  type NotionNotesProviderOptions
} from "./notes-providers.js";

// Tasks provider abstraction. Mirrors the notes-providers
// pattern. LocalFile + AppleReminders backends landed in rounds 152 +
// 153; Notion DB joined .
export {
  AppleRemindersProvider,
  LocalFileTasksProvider,
  NotionTasksProvider,
  TasksProviderError,
  TasksProviderRegistry,
  TasksValidationError,
  type AppleRemindersProviderOptions,
  type LocalFileTasksProviderOptions,
  type NotionTasksProviderOptions,
  type Task,
  type TaskInput,
  type TaskSearchHit,
  type TasksProvider,
  type TasksProviderInfo
} from "./tasks-providers.js";
