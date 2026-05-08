import { createHmac, timingSafeEqual } from "node:crypto";
import type { AgentRunContext, HookStage } from "@muse/agent-core";
import type { ModelMessage, ModelResponse } from "@muse/model";
import type {
  CostAnomaly,
  CostAnomalyDetector,
  DriftAnomaly,
  FollowupSuggestionStore,
  MonthlyBudgetStatus,
  MonthlyBudgetTracker,
  PromptDriftDetector,
  SloAlertEvaluator,
  SloViolation
} from "@muse/observability";
import type {
  ChannelFaqRegistrationTable,
  MuseDatabase,
  SlackBotInstanceTable,
  SlackFeedbackEventTable,
  SlackResponseTrackingTable
} from "@muse/db";
import { createRunId, type JsonObject, type JsonValue } from "@muse/shared";
import type { Insertable, Kysely, Selectable } from "kysely";
import { formatSlackMrkdwn, formatSlackPayload } from "./slack-mrkdwn.js";
import { createWebhookHeaders } from "./slack-signature.js";

export type Awaitable<T> = T | Promise<T>;
export type IntegrationEventType = "before_start" | "after_complete" | "on_error" | "before_tool" | "after_tool";

export interface CommandEnvelope {
  readonly id: string;
  readonly source: string;
  readonly command: string;
  readonly text: string;
  readonly userId?: string;
  readonly channelId?: string;
  readonly workspaceId?: string;
  readonly responseUrl?: string;
  readonly metadata: JsonObject;
  readonly receivedAt: Date;
}

export interface CommandResponse {
  readonly text: string;
  readonly visibility?: "ephemeral" | "public";
  readonly metadata?: JsonObject;
}

export interface CommandHandler {
  handle(command: CommandEnvelope): Awaitable<CommandResponse>;
}

export interface SlackSlashCommandPayload {
  readonly command?: string;
  readonly text?: string;
  readonly user_id?: string;
  readonly channel_id?: string;
  readonly team_id?: string;
  readonly response_url?: string;
  readonly trigger_id?: string;
  readonly [key: string]: string | undefined;
}

export interface WebhookEvent {
  readonly id: string;
  readonly type: IntegrationEventType;
  readonly runId: string;
  readonly payload: JsonObject;
  readonly createdAt: Date;
}

export interface WebhookEndpoint {
  readonly id: string;
  readonly url: string;
  readonly events: readonly IntegrationEventType[];
  readonly secret?: string;
  readonly enabled: boolean;
}

export interface WebhookDelivery {
  readonly endpointId: string;
  readonly eventId: string;
  readonly status: "delivered" | "failed" | "skipped";
  readonly statusCode?: number;
  readonly error?: string;
}

export interface WebhookTransport {
  post(url: string, body: JsonObject, headers: Record<string, string>): Awaitable<{ readonly statusCode: number }>;
}

export interface WebhookNotificationDispatcher {
  dispatch(input: Omit<WebhookEvent, "createdAt" | "id"> & { readonly id?: string }): Awaitable<readonly WebhookDelivery[]>;
}

export interface WebhookNotificationHookOptions {
  readonly dispatcher: WebhookNotificationDispatcher;
  readonly id?: string;
  readonly outputPreviewLength?: number;
}

export interface ToolResponseSummary {
  readonly itemCount?: number;
  readonly outputPreview: string;
  readonly runId: string;
  readonly status: string;
  readonly toolCallId: string;
  readonly toolName: string;
}

export interface ToolResponseSummaryHookOptions {
  readonly id?: string;
  readonly onSummary: (summary: ToolResponseSummary) => Awaitable<void>;
  readonly previewLength?: number;
}

export interface RagIngestionCapturePolicy {
  readonly allowedChannels: readonly string[];
  readonly blockedPatterns: readonly string[];
  readonly enabled: boolean;
  readonly minQueryChars: number;
  readonly minResponseChars: number;
  readonly requireReview: boolean;
}

export interface RagIngestionCaptureCandidate {
  readonly channel?: string | null;
  readonly query: string;
  readonly response: string;
  readonly runId: string;
  readonly sessionId?: string | null;
  readonly status?: "PENDING" | "REJECTED" | "INGESTED";
  readonly userId: string;
}

export interface RagIngestionCaptureHookOptions {
  readonly candidateStore: {
    save(candidate: RagIngestionCaptureCandidate): Awaitable<unknown>;
  };
  readonly id?: string;
  readonly policyStore: {
    getOrNull(): Awaitable<RagIngestionCapturePolicy | undefined>;
  };
  readonly userIdFallback?: string;
}

export interface FeedbackMetadataCaptureHookOptions {
  readonly feedbackStore: {
    save(record: JsonObject): Awaitable<unknown>;
  };
  readonly id?: string;
}

export interface UserMemoryInjectionMemory {
  readonly facts: Readonly<Record<string, string>>;
  readonly preferences: Readonly<Record<string, string>>;
  readonly recentTopics?: readonly string[];
  readonly userId: string;
}

export interface UserMemoryInjectionHookOptions {
  readonly id?: string;
  readonly maxEntries?: number;
  readonly memoryStore: {
    findByUserId(userId: string): Awaitable<UserMemoryInjectionMemory | undefined>;
  };
}

export interface SlackCommandAckResponse {
  readonly response_type: "ephemeral" | "in_channel";
  readonly text: string;
}

export interface SlackSignatureVerificationResult {
  readonly ok: boolean;
  readonly reason?: string;
}

export interface SlackResponseUrlTransport {
  post(url: string, body: JsonObject): Awaitable<{ readonly statusCode: number }>;
}

export interface SlackMessagePostInput {
  readonly channelId: string;
  readonly text: string;
  readonly threadTs?: string;
}

export interface SlackMessageTransport {
  postMessage(input: SlackMessagePostInput): Awaitable<{
    readonly ok: boolean;
    readonly statusCode: number;
    readonly error?: string;
    readonly ts?: string;
  }>;
}

export interface SlackAssistantThreadStatusInput {
  readonly channelId: string;
  readonly threadTs: string;
  readonly status: string;
}

export interface SlackAssistantThreadStatusResult {
  readonly ok: boolean;
  readonly statusCode: number;
  readonly error?: string;
}

export interface SlackAssistantThreadStatusTransport {
  setStatus(input: SlackAssistantThreadStatusInput): Awaitable<SlackAssistantThreadStatusResult>;
}

export interface SlackProgressHookOptions {
  readonly transport: SlackAssistantThreadStatusTransport;
  readonly id?: string;
  readonly minUpdateIntervalMs?: number;
  readonly friendlyNames?: Readonly<Record<string, string>>;
  readonly now?: () => number;
  readonly onError?: (error: unknown) => void;
}

export interface SlackSocketModeTransport {
  send(payload: JsonObject): Awaitable<void>;
}

export interface SlackSocketModeGatewayOptions {
  readonly commandHandler: CommandHandler;
  readonly maxRememberedEnvelopeIds?: number;
  readonly now?: () => Date;
  readonly transport: SlackSocketModeTransport;
}

export interface SlackSocketModeEnvelope {
  readonly envelope_id?: string;
  readonly payload?: unknown;
  readonly type?: string;
}

export type SlackInteractionType = "block_actions" | "view_submission";

export interface SlackInteractionPayload {
  readonly type: SlackInteractionType;
  readonly actionId: string;
  readonly value?: string;
  readonly userId: string;
  readonly channelId?: string;
  readonly messageTs?: string;
  readonly triggerId?: string;
  readonly responseUrl?: string;
  readonly privateMetadata?: string;
  readonly viewValues?: JsonObject;
}

export interface SlackInteractionHandler {
  readonly actionIdPrefix: string;
  handle(payload: SlackInteractionPayload): Awaitable<boolean>;
}

export interface SlackInteractionDispatchResult {
  readonly dispatched: boolean;
  readonly reason?: "parse_failed" | "no_handler" | "handler_rejected";
  readonly payload?: SlackInteractionPayload;
}

export interface TrackedSlackBotResponse {
  readonly sessionId: string;
  readonly userPrompt: string;
  readonly response?: string;
  readonly expiresAt: number;
}

export interface SlackFeedbackInput {
  readonly channelId?: string;
  readonly messageTs?: string;
  readonly metadata?: JsonObject;
  readonly query: string;
  readonly rating: "thumbs_down" | "thumbs_up";
  readonly response: string;
  readonly sessionId: string;
  readonly userId: string;
}

export interface SlackResponseTrackingInput {
  readonly channelId: string;
  readonly messageTs: string;
  readonly sessionId: string;
  readonly userPrompt: string;
  readonly response?: string;
  readonly expiresAt: number;
}

export interface SlackResponseTrackerStore {
  track(input: SlackResponseTrackingInput): Awaitable<void>;
  lookup(channelId: string, messageTs: string, now?: number): Awaitable<TrackedSlackBotResponse | undefined>;
  purgeExpired(now?: number): Awaitable<number>;
}

export interface SlackFeedbackEvent extends SlackFeedbackInput {
  readonly id: string;
  readonly channelId: string;
  readonly createdAt: Date;
  readonly messageTs: string;
}

export interface SlackFeedbackEventStore {
  save(input: SlackFeedbackInput): Awaitable<SlackFeedbackEvent>;
  listBySession(sessionId: string): Awaitable<readonly SlackFeedbackEvent[]>;
}

export type SlackFaqAutoReplyMode = "MENTION" | "ALWAYS" | "OFF";
export type SlackFaqIngestStatus = "OK" | "FAILED" | "RUNNING";

export interface SlackBotInstance {
  readonly id: string;
  readonly name: string;
  readonly botToken: string;
  readonly appToken: string;
  readonly personaId: string;
  readonly defaultChannel?: string | null;
  readonly enabled?: boolean;
  readonly createdAt?: Date;
  readonly updatedAt?: Date;
}

export interface SlackBotInstanceStore {
  list(): Awaitable<readonly SlackBotInstance[]>;
  listEnabled(): Awaitable<readonly SlackBotInstance[]>;
  get(id: string): Awaitable<SlackBotInstance | undefined>;
  save(instance: SlackBotInstance): Awaitable<SlackBotInstance>;
  delete(id: string): Awaitable<boolean>;
}

export interface ChannelFaqRegistration {
  readonly channelId: string;
  readonly channelName?: string | null;
  readonly enabled?: boolean;
  readonly autoReplyMode?: SlackFaqAutoReplyMode;
  readonly confidenceThreshold?: number;
  readonly daysBack?: number;
  readonly reIngestIntervalHours?: number;
  readonly lastIngestedAt?: Date | null;
  readonly lastMessageCount?: number | null;
  readonly lastChunkCount?: number | null;
  readonly lastStatus?: SlackFaqIngestStatus | null;
  readonly lastError?: string | null;
  readonly registeredBy?: string | null;
  readonly registeredAt?: Date;
  readonly updatedAt?: Date;
}

export interface ChannelFaqRegistrationStore {
  save(registration: ChannelFaqRegistration): Awaitable<ChannelFaqRegistration>;
  get(channelId: string): Awaitable<ChannelFaqRegistration | undefined>;
  list(options?: { readonly enabledOnly?: boolean }): Awaitable<readonly ChannelFaqRegistration[]>;
  delete(channelId: string): Awaitable<boolean>;
  updateIngestResult(input: {
    readonly channelId: string;
    readonly status: SlackFaqIngestStatus;
    readonly messageCount?: number | null;
    readonly chunkCount?: number | null;
    readonly error?: string | null;
  }): Awaitable<ChannelFaqRegistration | undefined>;
}

export interface SlackSignatureVerifierOptions {
  readonly signingSecret: string;
  readonly timestampToleranceSeconds?: number;
  readonly nowSeconds?: () => number;
}

export interface WebhookDispatcherOptions {
  readonly endpoints?: readonly WebhookEndpoint[];
  readonly transport: WebhookTransport;
  readonly now?: () => Date;
  readonly idFactory?: () => string;
}

export function parseSlackSlashCommand(
  payload: SlackSlashCommandPayload,
  now: () => Date = () => new Date()
): CommandEnvelope {
  return {
    channelId: blankToUndefined(payload.channel_id),
    command: payload.command?.trim() || "/muse",
    id: payload.trigger_id?.trim() || createRunId("command"),
    metadata: Object.fromEntries(
      Object.entries(payload).filter(([_, value]) => value !== undefined)
    ) as JsonObject,
    receivedAt: now(),
    responseUrl: blankToUndefined(payload.response_url),
    source: "slack",
    text: payload.text?.trim() ?? "",
    userId: blankToUndefined(payload.user_id),
    workspaceId: blankToUndefined(payload.team_id)
  };
}

export function parseSlackUrlEncodedBody(rawBody: string): SlackSlashCommandPayload {
  const params = new URLSearchParams(rawBody);
  const payload: Record<string, string> = {};

  for (const [key, value] of params) {
    payload[key] = value;
  }

  return payload;
}

export function toSlackCommandAck(response: CommandResponse): SlackCommandAckResponse {
  return {
    response_type: response.visibility === "public" ? "in_channel" : "ephemeral",
    text: formatSlackMrkdwn(response.text)
  };
}

export function commandEnvelopeFromText(
  text: string,
  options: {
    readonly command?: string;
    readonly source?: string;
    readonly userId?: string;
    readonly workspaceId?: string;
    readonly now?: () => Date;
  } = {}
): CommandEnvelope {
  return {
    command: options.command ?? "muse",
    id: createRunId("command"),
    metadata: {},
    receivedAt: options.now?.() ?? new Date(),
    source: options.source ?? "generic",
    text,
    userId: options.userId,
    workspaceId: options.workspaceId
  };
}

export class CommandRouter implements CommandHandler {
  private readonly handlers = new Map<string, CommandHandler>();

  register(command: string, handler: CommandHandler): void {
    this.handlers.set(command, handler);
  }

  async handle(envelope: CommandEnvelope): Promise<CommandResponse> {
    const handler = this.handlers.get(envelope.command) ?? this.handlers.get("*");

    if (!handler) {
      return {
        text: `No handler registered for command: ${envelope.command}`,
        visibility: "ephemeral"
      };
    }

    return handler.handle(envelope);
  }
}


// Slack bot-instance + channel-FAQ-registration stores live in
// packages/integrations/src/slack-bot-faq-store.ts.
export {
  buildChannelFaqRegistrationUpsertQuery,
  buildSlackBotInstanceUpsertQuery,
  createChannelFaqRegistrationInsert,
  createSlackBotInstanceInsert,
  InMemoryChannelFaqRegistrationStore,
  InMemorySlackBotInstanceStore,
  KyselyChannelFaqRegistrationStore,
  KyselySlackBotInstanceStore,
  mapChannelFaqRegistrationRow,
  mapSlackBotInstanceRow
} from "./slack-bot-faq-store.js";

export class SlackInteractionDispatcher {
  constructor(private readonly handlers: readonly SlackInteractionHandler[]) {}

  async dispatch(input: unknown): Promise<SlackInteractionDispatchResult> {
    const payload = parseSlackInteractionPayload(input);

    if (!payload) {
      return { dispatched: false, reason: "parse_failed" };
    }

    const prefix = payload.actionId.includes(".")
      ? payload.actionId.slice(0, payload.actionId.indexOf("."))
      : payload.actionId;
    const matched = this.handlers.filter((handler) =>
      handler.actionIdPrefix === prefix || payload.actionId.startsWith(`${handler.actionIdPrefix}_`)
    );

    if (matched.length === 0) {
      return { dispatched: false, payload, reason: "no_handler" };
    }

    for (const handler of matched) {
      try {
        if (await handler.handle(payload)) {
          return { dispatched: true, payload };
        }
      } catch {
        continue;
      }
    }

    return { dispatched: false, payload, reason: "handler_rejected" };
  }
}

export class SlackSocketModeGateway {
  private readonly envelopeIds = new Set<string>();
  private readonly maxRememberedEnvelopeIds: number;
  private readonly now: () => Date;

  constructor(private readonly options: SlackSocketModeGatewayOptions) {
    this.maxRememberedEnvelopeIds = Math.max(1, options.maxRememberedEnvelopeIds ?? 10_000);
    this.now = options.now ?? (() => new Date());
  }

  async handleEnvelope(envelope: SlackSocketModeEnvelope): Promise<void> {
    if (envelope.envelope_id) {
      await this.options.transport.send({ envelope_id: envelope.envelope_id });

      if (this.rememberedEnvelope(envelope.envelope_id)) {
        return;
      }
    }

    const command = socketEnvelopeToCommand(envelope.payload, this.now);

    if (command) {
      await this.options.commandHandler.handle(command);
    }
  }

  private rememberedEnvelope(envelopeId: string): boolean {
    if (this.envelopeIds.has(envelopeId)) {
      return true;
    }

    this.envelopeIds.add(envelopeId);

    while (this.envelopeIds.size > this.maxRememberedEnvelopeIds) {
      const oldest = this.envelopeIds.values().next().value as string | undefined;

      if (!oldest) {
        break;
      }

      this.envelopeIds.delete(oldest);
    }

    return false;
  }
}

// Slack response tracker primitives live in
// packages/integrations/src/slack-response-tracker.ts.
export {
  createSlackResponseTrackingInsert,
  InMemorySlackResponseTrackerStore,
  KyselySlackResponseTrackerStore,
  mapSlackResponseTrackingRow,
  SlackBotResponseTracker
} from "./slack-response-tracker.js";

// Slack feedback event primitives live in
// packages/integrations/src/slack-feedback-store.ts.
export {
  createSlackFeedbackEventInsert,
  InMemorySlackFeedbackEventStore,
  KyselySlackFeedbackEventStore,
  mapSlackFeedbackEventRow,
  SlackFeedbackButtonHandler
} from "./slack-feedback-store.js";

// WebhookDispatcher + createWebhookNotificationHook live in
// packages/integrations/src/webhook-dispatcher.ts.
export {
  createWebhookNotificationHook,
  WebhookDispatcher
} from "./webhook-dispatcher.js";

// Slack reminder primitives live in packages/integrations/src/slack-reminders.ts.
export {
  createSlackReminderPoller,
  handleSlackReminderCommand,
  InMemoryReminderStore,
  parseReminderTime,
  type InMemoryReminderStoreOptions,
  type ReminderStore,
  type ReminderTimeParseOptions,
  type SlackReminder,
  type SlackReminderCommandResult,
  type SlackReminderPoller,
  type SlackReminderPollerOptions,
  type SlackReminderTimeParseResult
} from "./slack-reminders.js";

// Slack follow-up suggestion primitives live in packages/integrations/src/slack-followup.ts.
export {
  createFollowupSuggestionInteractionHandler,
  extractFollowupCategory,
  followupActionId,
  FOLLOWUP_ACTION_PREFIX,
  FOLLOWUP_MAX_LABEL_LENGTH,
  FOLLOWUP_MAX_PER_MESSAGE,
  parseFollowupSuggestions,
  renderFollowupSuggestionBlocks,
  stripFollowupMarker,
  truncateFollowupLabel,
  type FollowupAgentReplyResult,
  type FollowupSuggestion,
  type FollowupSuggestionInteractionHandlerOptions
} from "./slack-followup.js";

// Slack assistant-thread progress hook lives in packages/integrations/src/slack-progress-hook.ts.
export {
  createSlackProgressHook,
  SLACK_PROGRESS_DEFAULT_FRIENDLY_NAMES,
  SLACK_PROGRESS_DEFAULT_MIN_UPDATE_MS,
  SLACK_PROGRESS_MAX_STATUS_LENGTH
} from "./slack-progress-hook.js";

// CostAnomaly + PromptDrift + SloAlert hooks live in
// packages/integrations/src/observability-hooks.ts.
export {
  createCostAnomalyHook,
  createPromptDriftHook,
  createSloAlertHook,
  type CostAnomalyHookOptions,
  type PromptDriftHookOptions,
  type SloAlertHookOptions
} from "./observability-hooks.js";

// createSlackProgressHook lives in packages/integrations/src/slack-progress-hook.ts.

// Tool-response / RAG-ingestion / feedback-metadata / user-memory
// hooks live in packages/integrations/src/agent-lifecycle-hooks.ts.
export {
  createFeedbackMetadataCaptureHook,
  createRagIngestionCaptureHook,
  createToolResponseSummaryHook,
  createUserMemoryInjectionHook
} from "./agent-lifecycle-hooks.js";

// SlackSignatureVerifier + signing/verification helpers live in
// packages/integrations/src/slack-signature.ts.
export {
  createWebhookHeaders,
  signSlackRequestBody,
  signWebhookPayload,
  SlackSignatureVerifier,
  verifySlackSignature,
  verifyWebhookSignature
} from "./slack-signature.js";

export class FetchSlackResponseUrlTransport implements SlackResponseUrlTransport {
  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  async post(url: string, body: JsonObject): Promise<{ readonly statusCode: number }> {
    const slackBody = formatSlackPayload(body);
    const response = await this.fetchImpl(url, {
      body: JSON.stringify(slackBody),
      headers: {
        "content-type": "application/json"
      },
      method: "POST"
    });

    return { statusCode: response.status };
  }
}


export function parseSlackInteractionPayload(input: unknown): SlackInteractionPayload | undefined {
  const json = parseSlackInteractionJson(input);

  if (!json) {
    return undefined;
  }

  const type = readString(json, "type");

  if (type !== "block_actions" && type !== "view_submission") {
    return undefined;
  }

  const action = type === "block_actions"
    ? readRecordArray(json, "actions")[0]
    : readRecord(json, "view");

  if (!action) {
    return undefined;
  }

  const actionId = type === "view_submission"
    ? readString(action, "callback_id")
    : readString(action, "action_id");

  if (!actionId) {
    return undefined;
  }

  const viewState = type === "view_submission" ? readRecord(readRecord(action, "state") ?? {}, "values") : undefined;

  return {
    actionId,
    channelId: readString(readRecord(json, "channel") ?? {}, "id"),
    messageTs: readString(readRecord(json, "message") ?? {}, "ts"),
    privateMetadata: type === "view_submission" ? readString(action, "private_metadata") : undefined,
    responseUrl: readString(json, "response_url"),
    triggerId: readString(json, "trigger_id"),
    type,
    userId: readString(readRecord(json, "user") ?? {}, "id") ?? "",
    value: readString(action, "value"),
    viewValues: viewState as JsonObject | undefined
  };
}

function socketEnvelopeToCommand(payload: unknown, now: () => Date): CommandEnvelope | undefined {
  if (!isJsonRecord(payload) || payload.type !== "event_callback" || !isJsonRecord(payload.event)) {
    return undefined;
  }

  const event = payload.event;
  const type = readString(event, "type");

  if (type !== "app_mention" && type !== "message") {
    return undefined;
  }

  const text = stripBotMention(readString(event, "text") ?? "");
  const ts = readString(event, "ts") ?? createRunId("socket_event");

  return {
    channelId: blankToUndefined(readString(event, "channel")),
    command: type,
    id: ts,
    metadata: {
      eventTs: ts,
      socketMode: true,
      type
    },
    receivedAt: now(),
    source: "slack_socket_mode",
    text,
    userId: blankToUndefined(readString(event, "user")),
    workspaceId: blankToUndefined(readString(event, "team") ?? readString(payload, "team_id"))
  };
}

function stripBotMention(value: string): string {
  return value.replace(/^<@[^>]+>\s*/u, "").trim();
}

export class FetchSlackWebApiMessageTransport
  implements SlackMessageTransport, SlackAssistantThreadStatusTransport
{
  constructor(
    private readonly botToken: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly apiBaseUrl = "https://slack.com/api"
  ) {}

  async postMessage(input: SlackMessagePostInput): Promise<{
    readonly ok: boolean;
    readonly statusCode: number;
    readonly error?: string;
    readonly ts?: string;
  }> {
    if (this.botToken.trim().length === 0) {
      return { error: "slack_bot_token_missing", ok: false, statusCode: 0 };
    }

    const body = formatSlackPayload({
      channel: input.channelId,
      text: input.text,
      ...(input.threadTs ? { thread_ts: input.threadTs } : {})
    });
    const response = await this.fetchImpl(`${this.apiBaseUrl}/chat.postMessage`, {
      body: JSON.stringify(body),
      headers: {
        authorization: `Bearer ${this.botToken}`,
        "content-type": "application/json; charset=utf-8"
      },
      method: "POST"
    });
    const parsed = await readSlackApiResponse(response);

    return {
      error: parsed.error,
      ok: response.ok && parsed.ok !== false,
      statusCode: response.status,
      ts: parsed.ts
    };
  }

  async setStatus(input: SlackAssistantThreadStatusInput): Promise<SlackAssistantThreadStatusResult> {
    if (this.botToken.trim().length === 0) {
      return { error: "slack_bot_token_missing", ok: false, statusCode: 0 };
    }

    const response = await this.fetchImpl(`${this.apiBaseUrl}/assistant.threads.setStatus`, {
      body: JSON.stringify({
        channel_id: input.channelId,
        thread_ts: input.threadTs,
        status: input.status
      }),
      headers: {
        authorization: `Bearer ${this.botToken}`,
        "content-type": "application/json; charset=utf-8"
      },
      method: "POST"
    });
    const parsed = await readSlackApiResponse(response);

    return {
      error: parsed.error,
      ok: response.ok && parsed.ok !== false,
      statusCode: response.status
    };
  }
}

// formatSlackMrkdwn + Slack/webhook signing helpers live in
// packages/integrations/src/slack-mrkdwn.ts and slack-signature.ts.
export { formatSlackMrkdwn, formatSlackPayload } from "./slack-mrkdwn.js";


function blankToUndefined(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized && normalized.length > 0 ? normalized : undefined;
}

function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseSlackInteractionJson(input: unknown): Record<string, unknown> | undefined {
  if (typeof input === "string") {
    return parseJsonObject(input);
  }

  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return undefined;
  }

  const record = input as Record<string, unknown>;
  const payload = record.payload;

  if (typeof payload === "string") {
    return parseJsonObject(payload);
  }

  return record;
}

function parseJsonObject(value: string): Record<string, unknown> | undefined {
  const parsed = safeJsonParse(value);
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : undefined;
}

function safeJsonParse(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

function readRecord(value: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const candidate = value[key];
  return candidate && typeof candidate === "object" && !Array.isArray(candidate)
    ? candidate as Record<string, unknown>
    : undefined;
}

function readRecordArray(value: Record<string, unknown>, key: string): Array<Record<string, unknown>> {
  const candidate = value[key];

  if (!Array.isArray(candidate)) {
    return [];
  }

  return candidate.filter((item): item is Record<string, unknown> =>
    Boolean(item) && typeof item === "object" && !Array.isArray(item)
  );
}

function readString(value: Record<string, unknown>, key: string): string | undefined {
  const candidate = value[key];
  return typeof candidate === "string" && candidate.trim().length > 0 ? candidate.trim() : undefined;
}

// formatSlackPayload lives in packages/integrations/src/slack-mrkdwn.ts.

async function readSlackApiResponse(response: Response): Promise<{
  readonly ok?: boolean;
  readonly error?: string;
  readonly ts?: string;
}> {
  const contentType = response.headers.get("content-type") ?? "";

  if (!contentType.includes("application/json")) {
    return {};
  }

  const value = await response.json().catch(() => undefined);

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  const record = value as Record<string, unknown>;

  return {
    error: typeof record.error === "string" ? record.error : undefined,
    ok: typeof record.ok === "boolean" ? record.ok : undefined,
    ts: typeof record.ts === "string" ? record.ts : undefined
  };
}


