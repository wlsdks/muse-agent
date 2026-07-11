/**
 * Type-only module — `ServerOptions` + nested types consumed by
 * `buildServer` in `server.ts`. Lifted out to give the
 * `server.ts` registrations room to breathe; the runtime stays
 * over there.
 */

import type { ActiveContextProvider, AgentInitiatedNoticeBroker, AgentRuntime } from "@muse/agent-core";
import type { AgentSpecRegistry } from "@muse/agent-specs";
import type { MuseAuth } from "@muse/auth";
import type { CalendarCredentialStore, CalendarProviderRegistry } from "@muse/calendar";
import type { NotesProviderRegistry, TasksProviderRegistry } from "@muse/domain-tools";
import type { MessagingProviderRegistry } from "@muse/messaging";
import type { ConversationSummaryStore, TaskMemoryMaintenance, UserMemoryStore } from "@muse/memory";
import type { ModelProvider } from "@muse/model";
import type { MuseObservabilitySnapshot, LatencyQuery, TokenCostQuery } from "@muse/observability";
import type { RuntimeSettings } from "@muse/runtime-settings";
import type {
  AgentRunHistoryStore,
  DebugReplayCaptureStore,
  SessionTagStore
} from "@muse/runtime-state";
import type { VoiceProviderRegistry } from "@muse/voice";

import type { InjectionDetectionCounter } from "@muse/policy";

import type { AdminRouteState } from "./admin-routes.js";
import type { McpRouteMcp } from "./mcp-routes.js";
import type { SchedulerRouteScheduler } from "./scheduler-routes.js";

export interface ServerOptions {
  readonly logger?: boolean;
  readonly cors?: CorsOptions;
  /**
   * Optional injection point for the chat-route per-IP rate
   * limiter. Tests pass a deterministic ChatRateLimiter
   * with a small capacity + injected clock. Production callers
   * leave this unset and the default 60-req/min limiter is built
   * inside `registerChatRoutes` (or skipped when
   * `MUSE_RATE_LIMIT_CHAT_DISABLED=true`).
   */
  readonly chatRateLimiter?: import("./chat-rate-limiter.js").ChatRateLimiter;
  readonly agentRuntime?: AgentRuntime;
  readonly admin?: AdminRouteState;
  readonly agentSpecRegistry?: AgentSpecRegistry;
  readonly authService?: MuseAuth;
  readonly debugReplayCaptureStore?: DebugReplayCaptureStore;
  readonly latencyQuery?: LatencyQuery;
  readonly tokenCostQuery?: TokenCostQuery;
  readonly historyStore?: AgentRunHistoryStore;
  readonly mcp?: McpRouteMcp;
  readonly modelProvider?: ModelProvider;
  readonly defaultModel?: string;
  readonly requireAuth?: boolean;
  readonly runtimeSettings?: RuntimeSettings;
  readonly scheduler?: SchedulerRouteScheduler;
  readonly sessionTagStore?: SessionTagStore;
  readonly taskMemoryMaintenance?: TaskMemoryMaintenance;
  readonly userMemoryStore?: UserMemoryStore;
  readonly conversationSummaryStore?: ConversationSummaryStore;
  readonly agentCardIdentity?: {
    readonly name?: string;
    readonly version?: string;
    readonly description?: string;
  };
  readonly agentCardToolProvider?: () => Promise<readonly { readonly name: string; readonly description: string; readonly inputSchema?: Record<string, unknown> | null }[]> | readonly { readonly name: string; readonly description: string; readonly inputSchema?: Record<string, unknown> | null }[];
  readonly toolCatalogProvider?: () => Promise<readonly ToolCatalogEntry[]> | readonly ToolCatalogEntry[];
  readonly museObservabilitySnapshot?: () => Promise<MuseObservabilitySnapshot>;
  readonly calendar?: CalendarProviderRegistry;
  readonly calendarCredentialStore?: CalendarCredentialStore;
  readonly tasksFile?: string;
  readonly tasksProviderRegistry?: TasksProviderRegistry;
  readonly notesDir?: string;
  readonly notesProviderRegistry?: NotesProviderRegistry;
  readonly voice?: VoiceProviderRegistry;
  /**
   * Context-Engineering Phase 1 provider. When set, the API
   * registers `GET /api/active-context` so the web console / curl /
   * scripts can read the same snapshot the agent loop injects.
   */
  readonly activeContextProvider?: ActiveContextProvider;
  /**
   * Phase D agent-initiated notice broker. When set, the API
   * registers `GET /api/agent-notices/stream` as the SSE consumer
   * surface that fans broker publishes to chat-stream clients.
   */
  readonly agentInitiatedNoticeBroker?: AgentInitiatedNoticeBroker;
  readonly messaging?: MessagingProviderRegistry;
  /**
   * On-demand poll dispatcher shared with `muse.messaging.poll_now`.
   * When set, the API registers `POST /api/messaging/poll` so the
   * web console / curl can trigger an off-cadence pull without going
   * through the LLM.
   */
  readonly messagingPollNow?: (providerId: string, source?: string) => Promise<{ ingested: number }>;
  /**
   * On-demand poll-everything dispatcher shared with
   * `muse.messaging.poll_all`. When set, the API registers
   * `POST /api/messaging/poll-all` so the web "Pull all" button
   * can trigger a one-shot pull across every wired provider.
   */
  readonly messagingPollAll?: () => Promise<{
    readonly ingestedByProvider: Readonly<Record<string, number>>;
    readonly errors: readonly { readonly providerId: string; readonly message: string }[];
  }>;
  readonly remindersFile?: string;
  /**
   * Optional reminder-history sidecar (default
   * ~/.muse/reminder-history.json). When configured, the daemon
   * appends each firing attempt so `muse.reminders.history` can
   * audit recent deliveries.
   */
  readonly reminderHistoryFile?: string;
  /**
   * Optional proactive-history sidecar (default
   * ~/.muse/proactive-history.json). When configured, the
   * proactive daemon appends each notice attempt so
   * `muse.proactive.history` / `GET /api/proactive/history` can
   * audit recent deliveries.
   */
  readonly proactiveHistoryFile?: string;
  /**
   * Path to the session-lock marker (default
   * `~/.muse/session-lock.json`). When set, the proactive tick
   * daemon reads it every cycle; an active lock skips firing and
   * surfaces a "skipped (locked until X)" log line instead of a
   * stream of zero-fire ticks.
   */
  readonly sessionLockFile?: string;
  /**
   * Path to the self-followup store (default ~/.muse/followups.json).
   * When set alongside MUSE_FOLLOWUP_DEFAULT_PROVIDER /
   * MUSE_FOLLOWUP_DEFAULT_DESTINATION and a wired modelProvider,
   * the followup-tick daemon synthesizes + delivers due promises.
   */
  readonly followupsFile?: string;
  /**
   * Path to the standing-objectives store (default
   * ~/.muse/objectives.json) and the situational-briefing
   * last-fired dedupe sidecar (default ~/.muse/briefing-fired.json).
   * When set alongside MUSE_BRIEFING_PROVIDER /
   * MUSE_BRIEFING_DESTINATION + a registered messaging provider,
   * the situational-briefing daemon periodically briefs
   * delegated-objective status.
   */
  readonly objectivesFile?: string;
  readonly weaknessesFile?: string;
  readonly playbookFile?: string;
  readonly authoredSkillsDir?: string;
  readonly skillRewardsFile?: string;
  readonly reflectionsFile?: string;
  readonly briefingSidecarFile?: string;
  /**
   * Path to the reviewable autonomous-action log (default
   * ~/.muse/action-log.json). When set, the objectives daemon's
   * actuator appends a rationale-bearing entry for every
   * autonomous objective action it takes (P6 accountability).
   */
  readonly actionLogFile?: string;
  /**
   * Path to the contacts store (default ~/.muse/contacts.json) and the
   * learned-avoidance veto store (default ~/.muse/vetoes.json). Read by
   * the accountability routes so the web can surface the same records
   * the CLI reads. Both fall back to the conventional resolver path
   * when unset.
   */
  readonly contactsFile?: string;
  readonly vetoesFile?: string;
  /**
   * Path to the pattern-detection cooldown sidecar (default
   * ~/.muse/patterns-fired.json). When set alongside
   * MUSE_PROACTIVE_PATTERN_ENABLED=true + provider/destination
   * env and a registered messaging provider, the pattern-tick
   * daemon scans activity / tasks / notes mtimes every cadence
   * and fires the strongest in-slot patterns.
   */
  readonly patternsFiredFile?: string;
  /**
   * Path to the episodes store (default ~/.muse/episodes.json).
   * Read by `/api/history` to surface prior-session summaries
   * alongside reminder / proactive / followup / pattern firings.
   */
  readonly episodesFile?: string;
  /**
   * Path to the persisted LINE inbox (default ~/.muse/line-inbox.json).
   * Combined with `MUSE_LINE_CHANNEL_SECRET` from env, enables the
   * `POST /api/messaging/webhooks/line` route.
   */
  readonly lineInboxFile?: string;
  /**
   * Path to the persisted Telegram inbox (default
   * ~/.muse/telegram-inbox.json). The polling daemon writes here on
   * each tick; the per-provider read API will consult this file in
   * a follow-up slice.
   */
  readonly telegramInboxFile?: string;
  /**
   * Path to the persisted Discord inbox (default
   * ~/.muse/discord-inbox.json). The Phase 2.c.3 polling daemon
   * writes here on each tick.
   */
  readonly discordInboxFile?: string;
  /**
   * Path to the persisted Slack inbox (default
   * ~/.muse/slack-inbox.json). The Phase 2.d.3 polling daemon
   * writes here on each tick.
   */
  readonly slackInboxFile?: string;
  /**
   * Path to the persisted Matrix inbox (default
   * ~/.muse/matrix-inbox.json). The Matrix sync daemon writes here
   * on each tick; the inbound reply daemon consumes it.
   */
  readonly matrixInboxFile?: string;
  /**
   * When set, `GET /api/admin/security/injection-counts`
   * exposes the snapshot for the ops dashboard. The guard layer
   * is responsible for bumping the counter on every firing
   * pattern; this option just routes the read.
   */
  readonly injectionDetectionCounter?: InjectionDetectionCounter;
}

interface ToolCatalogEntry {
  readonly name: string;
  readonly description: string;
  readonly risk: "read" | "write" | "execute";
  readonly inputSchema?: Record<string, unknown> | null;
  readonly keywords?: readonly string[];
  readonly scopes?: readonly string[];
  readonly dependsOn?: readonly string[];
}

export interface CorsOptions {
  readonly allowCredentials?: boolean;
  readonly allowedHeaders?: readonly string[];
  readonly allowedMethods?: readonly string[];
  readonly allowedOrigins?: readonly string[];
  readonly maxAgeSeconds?: number;
}
