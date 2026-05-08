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

type SlackBotInstanceRow = Selectable<SlackBotInstanceTable>;
type SlackBotInstanceInsert = Insertable<SlackBotInstanceTable>;
type ChannelFaqRegistrationRow = Selectable<ChannelFaqRegistrationTable>;
type ChannelFaqRegistrationInsert = Insertable<ChannelFaqRegistrationTable>;
type SlackResponseTrackingRow = Selectable<SlackResponseTrackingTable>;
type SlackResponseTrackingInsert = Insertable<SlackResponseTrackingTable>;
type SlackFeedbackEventRow = Selectable<SlackFeedbackEventTable>;
type SlackFeedbackEventInsert = Insertable<SlackFeedbackEventTable>;

export class InMemorySlackBotInstanceStore implements SlackBotInstanceStore {
  private readonly bots = new Map<string, RequiredSlackBotInstance>();
  private readonly now: () => Date;

  constructor(options: { readonly now?: () => Date } = {}) {
    this.now = options.now ?? (() => new Date());
  }

  list(): readonly SlackBotInstance[] {
    return [...this.bots.values()].sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime());
  }

  listEnabled(): readonly SlackBotInstance[] {
    return this.list().filter((bot) => bot.enabled);
  }

  get(id: string): SlackBotInstance | undefined {
    return this.bots.get(id);
  }

  save(instance: SlackBotInstance): SlackBotInstance {
    const existing = this.bots.get(instance.id);
    const now = this.now();
    const normalized = normalizeSlackBotInstance(instance, {
      createdAt: existing?.createdAt ?? instance.createdAt ?? now,
      updatedAt: instance.updatedAt ?? now
    });

    this.bots.set(normalized.id, normalized);
    return normalized;
  }

  delete(id: string): boolean {
    return this.bots.delete(id);
  }
}

export class KyselySlackBotInstanceStore implements SlackBotInstanceStore {
  private readonly now: () => Date;

  constructor(
    private readonly db: Kysely<MuseDatabase>,
    options: { readonly now?: () => Date } = {}
  ) {
    this.now = options.now ?? (() => new Date());
  }

  async list(): Promise<readonly SlackBotInstance[]> {
    const rows = await this.db.selectFrom("slack_bot_instances").selectAll().orderBy("created_at", "asc").execute();
    return rows.map(mapSlackBotInstanceRow);
  }

  async listEnabled(): Promise<readonly SlackBotInstance[]> {
    const rows = await this.db
      .selectFrom("slack_bot_instances")
      .selectAll()
      .where("enabled", "=", true)
      .orderBy("created_at", "asc")
      .execute();
    return rows.map(mapSlackBotInstanceRow);
  }

  async get(id: string): Promise<SlackBotInstance | undefined> {
    const row = await this.db.selectFrom("slack_bot_instances").selectAll().where("id", "=", id).executeTakeFirst();
    return row ? mapSlackBotInstanceRow(row) : undefined;
  }

  async save(instance: SlackBotInstance): Promise<SlackBotInstance> {
    const existing = await this.get(instance.id);
    const row = await buildSlackBotInstanceUpsertQuery(this.db, instance, {
      createdAt: existing?.createdAt,
      now: this.now
    }).executeTakeFirstOrThrow();
    return mapSlackBotInstanceRow(row);
  }

  async delete(id: string): Promise<boolean> {
    const result = await this.db.deleteFrom("slack_bot_instances").where("id", "=", id).executeTakeFirst();
    return Number(result.numDeletedRows ?? 0) > 0;
  }
}

export class InMemoryChannelFaqRegistrationStore implements ChannelFaqRegistrationStore {
  private readonly registrations = new Map<string, RequiredChannelFaqRegistration>();
  private readonly now: () => Date;

  constructor(options: { readonly now?: () => Date } = {}) {
    this.now = options.now ?? (() => new Date());
  }

  save(registration: ChannelFaqRegistration): ChannelFaqRegistration {
    const existing = this.registrations.get(registration.channelId);
    const now = this.now();
    const normalized = normalizeChannelFaqRegistration(registration, {
      registeredAt: existing?.registeredAt ?? registration.registeredAt ?? now,
      updatedAt: registration.updatedAt ?? now
    });

    this.registrations.set(normalized.channelId, normalized);
    return normalized;
  }

  get(channelId: string): ChannelFaqRegistration | undefined {
    return this.registrations.get(channelId);
  }

  list(options: { readonly enabledOnly?: boolean } = {}): readonly ChannelFaqRegistration[] {
    return [...this.registrations.values()]
      .filter((registration) => !options.enabledOnly || registration.enabled)
      .sort(compareFaqRegistrations);
  }

  delete(channelId: string): boolean {
    return this.registrations.delete(channelId);
  }

  updateIngestResult(input: {
    readonly channelId: string;
    readonly status: SlackFaqIngestStatus;
    readonly messageCount?: number | null;
    readonly chunkCount?: number | null;
    readonly error?: string | null;
  }): ChannelFaqRegistration | undefined {
    const existing = this.registrations.get(input.channelId);

    if (!existing) {
      return undefined;
    }

    return this.save({
      ...existing,
      lastChunkCount: input.chunkCount ?? null,
      lastError: input.error ?? null,
      lastIngestedAt: this.now(),
      lastMessageCount: input.messageCount ?? null,
      lastStatus: input.status
    });
  }
}

export class KyselyChannelFaqRegistrationStore implements ChannelFaqRegistrationStore {
  private readonly now: () => Date;

  constructor(
    private readonly db: Kysely<MuseDatabase>,
    options: { readonly now?: () => Date } = {}
  ) {
    this.now = options.now ?? (() => new Date());
  }

  async save(registration: ChannelFaqRegistration): Promise<ChannelFaqRegistration> {
    const existing = await this.get(registration.channelId);
    const row = await buildChannelFaqRegistrationUpsertQuery(this.db, registration, {
      registeredAt: existing?.registeredAt,
      now: this.now
    }).executeTakeFirstOrThrow();
    return mapChannelFaqRegistrationRow(row);
  }

  async get(channelId: string): Promise<ChannelFaqRegistration | undefined> {
    const row = await this.db
      .selectFrom("channel_faq_registrations")
      .selectAll()
      .where("channel_id", "=", channelId)
      .executeTakeFirst();
    return row ? mapChannelFaqRegistrationRow(row) : undefined;
  }

  async list(options: { readonly enabledOnly?: boolean } = {}): Promise<readonly ChannelFaqRegistration[]> {
    const rows = await this.db
      .selectFrom("channel_faq_registrations")
      .selectAll()
      .$if(Boolean(options.enabledOnly), (query) => query.where("enabled", "=", true))
      .orderBy("last_ingested_at", "asc")
      .orderBy("registered_at", "asc")
      .execute();
    return rows.map(mapChannelFaqRegistrationRow);
  }

  async delete(channelId: string): Promise<boolean> {
    const result = await this.db
      .deleteFrom("channel_faq_registrations")
      .where("channel_id", "=", channelId)
      .executeTakeFirst();
    return Number(result.numDeletedRows ?? 0) > 0;
  }

  async updateIngestResult(input: {
    readonly channelId: string;
    readonly status: SlackFaqIngestStatus;
    readonly messageCount?: number | null;
    readonly chunkCount?: number | null;
    readonly error?: string | null;
  }): Promise<ChannelFaqRegistration | undefined> {
    const row = await this.db
      .updateTable("channel_faq_registrations")
      .set({
        last_chunk_count: input.chunkCount ?? null,
        last_error: input.error ?? null,
        last_ingested_at: this.now(),
        last_message_count: input.messageCount ?? null,
        last_status: input.status,
        updated_at: this.now()
      })
      .where("channel_id", "=", input.channelId)
      .returningAll()
      .executeTakeFirst();
    return row ? mapChannelFaqRegistrationRow(row) : undefined;
  }
}

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

export class WebhookDispatcher {
  private readonly endpoints = new Map<string, WebhookEndpoint>();
  private readonly transport: WebhookTransport;
  private readonly now: () => Date;
  private readonly idFactory: () => string;

  constructor(options: WebhookDispatcherOptions) {
    for (const endpoint of options.endpoints ?? []) {
      this.endpoints.set(endpoint.id, endpoint);
    }

    this.transport = options.transport;
    this.now = options.now ?? (() => new Date());
    this.idFactory = options.idFactory ?? (() => createRunId("webhook_event"));
  }

  register(endpoint: WebhookEndpoint): void {
    this.endpoints.set(endpoint.id, endpoint);
  }

  unregister(endpointId: string): void {
    this.endpoints.delete(endpointId);
  }

  listEndpoints(): readonly WebhookEndpoint[] {
    return [...this.endpoints.values()].sort((left, right) => left.id.localeCompare(right.id));
  }

  async dispatch(
    input: Omit<WebhookEvent, "createdAt" | "id"> & { readonly id?: string }
  ): Promise<readonly WebhookDelivery[]> {
    const event: WebhookEvent = {
      createdAt: this.now(),
      id: input.id ?? this.idFactory(),
      payload: input.payload,
      runId: input.runId,
      type: input.type
    };
    const deliveries: WebhookDelivery[] = [];

    for (const endpoint of this.endpoints.values()) {
      if (!endpoint.enabled || !endpoint.events.includes(event.type)) {
        deliveries.push({ endpointId: endpoint.id, eventId: event.id, status: "skipped" });
        continue;
      }

      try {
        const body = eventToPayload(event);
        const headers = createWebhookHeaders(body, endpoint.secret);
        const response = await this.transport.post(endpoint.url, body, headers);
        deliveries.push({
          endpointId: endpoint.id,
          eventId: event.id,
          status: response.statusCode >= 200 && response.statusCode < 300 ? "delivered" : "failed",
          statusCode: response.statusCode
        });
      } catch (error) {
        deliveries.push({
          endpointId: endpoint.id,
          error: error instanceof Error ? error.message : "unknown webhook failure",
          eventId: event.id,
          status: "failed"
        });
      }
    }

    return deliveries;
  }
}

export function createWebhookNotificationHook(options: WebhookNotificationHookOptions): HookStage {
  const previewLength = Math.max(1, options.outputPreviewLength ?? 500);

  return {
    afterComplete: async (context, response) => {
      await options.dispatcher.dispatch({
        payload: {
          model: response.model,
          outputPreview: truncatePreview(response.output, previewLength),
          responseId: response.id
        },
        runId: context.runId,
        type: "after_complete"
      });
    },
    afterTool: async (context, toolCall, result) => {
      await options.dispatcher.dispatch({
        payload: {
          resultPreview: truncatePreview(result.output, previewLength),
          status: result.status,
          toolCallId: toolCall.id,
          toolName: toolCall.name
        },
        runId: context.runId,
        type: "after_tool"
      });
    },
    beforeStart: async (context) => {
      await options.dispatcher.dispatch({
        payload: runContextPayload(context),
        runId: context.runId,
        type: "before_start"
      });
    },
    beforeTool: async (context, toolCall) => {
      await options.dispatcher.dispatch({
        payload: {
          args: toolCall.arguments,
          toolCallId: toolCall.id,
          toolName: toolCall.name
        },
        runId: context.runId,
        type: "before_tool"
      });
    },
    id: options.id ?? "webhook-notification",
    onError: async (context, error) => {
      await options.dispatcher.dispatch({
        payload: errorPayload(error),
        runId: context.runId,
        type: "on_error"
      });
    }
  };
}

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

export interface CostAnomalyHookOptions {
  readonly detector: CostAnomalyDetector;
  readonly id?: string;
  readonly budgetTracker?: MonthlyBudgetTracker;
  readonly tenantIdFromContext?: (context: AgentRunContext) => string | undefined;
  readonly costFromResponse: (context: AgentRunContext, response: ModelResponse) => number | undefined;
  readonly notify?: (event: { readonly anomaly?: CostAnomaly; readonly budgetStatus?: MonthlyBudgetStatus; readonly tenantId?: string }) => Awaitable<void>;
  readonly logger?: (message: string, error?: unknown) => void;
}

/**
 * Hook that records per-request cost into a `CostAnomalyDetector` (and an
 * optional per-tenant `MonthlyBudgetTracker`) and forwards anomalies / budget
 * transitions to the optional `notify` callback. Notify failures are swallowed
 * via the optional `logger` so the agent run never breaks on cost signaling.
 *
 * `costFromResponse` is the operator's adapter: derive the USD cost for the
 * completed run from the response (e.g. through token usage × model pricing).
 * Returning `undefined` skips recording for that run.
 */
export function createCostAnomalyHook(options: CostAnomalyHookOptions): HookStage {
  return {
    afterComplete: async (context, response) => {
      const cost = options.costFromResponse(context, response);
      if (cost === undefined) {
        return;
      }
      options.detector.recordCost(cost);
      const anomaly = options.detector.evaluate();
      const tenantId = options.tenantIdFromContext?.(context);
      let budgetStatus: MonthlyBudgetStatus | undefined;
      if (tenantId && options.budgetTracker) {
        budgetStatus = options.budgetTracker.recordCost(tenantId, cost);
      }
      if (!options.notify) {
        return;
      }
      if (anomaly === undefined && (budgetStatus === undefined || budgetStatus === "ok")) {
        return;
      }
      try {
        await options.notify({
          ...(anomaly ? { anomaly } : {}),
          ...(budgetStatus ? { budgetStatus } : {}),
          ...(tenantId ? { tenantId } : {})
        });
      } catch (error) {
        options.logger?.("CostAnomalyHook notify failed", error);
      }
    },
    id: options.id ?? "cost-anomaly"
  };
}

export interface PromptDriftHookOptions {
  readonly detector: PromptDriftDetector;
  readonly id?: string;
  readonly notify?: (anomalies: readonly DriftAnomaly[]) => Awaitable<void>;
  readonly logger?: (message: string, error?: unknown) => void;
}

/**
 * Hook that records the input prompt length on `beforeStart` and the output
 * response length on `afterComplete`, then forwards any new drift anomalies to
 * the optional `notify` callback. Notify failures are swallowed via the
 * optional `logger` so the agent run never breaks on drift signaling.
 */
export function createPromptDriftHook(options: PromptDriftHookOptions): HookStage {
  return {
    afterComplete: async (_context, response) => {
      options.detector.recordOutput(response.output?.length ?? 0);
      const anomalies = options.detector.evaluate();
      if (anomalies.length === 0 || !options.notify) {
        return;
      }
      try {
        await options.notify(anomalies);
      } catch (error) {
        options.logger?.("PromptDriftHook notify failed", error);
      }
    },
    beforeStart: async (context) => {
      const totalLength = context.input.messages.reduce(
        (sum, message) => sum + (message.content?.length ?? 0),
        0
      );
      options.detector.recordInput(totalLength);
    },
    id: options.id ?? "prompt-drift"
  };
}

export interface SloAlertHookOptions {
  readonly evaluator: SloAlertEvaluator;
  readonly id?: string;
  readonly notify?: (violations: readonly SloViolation[]) => Awaitable<void>;
  readonly now?: () => number;
  readonly logger?: (message: string, error?: unknown) => void;
}

/**
 * Hook that records latency + result outcomes into a `SloAlertEvaluator` and
 * fires the optional `notify` callback whenever a violation surfaces.
 *
 * Mirrors Reactor's `SloAlertHook` semantics:
 * - Records the wall-clock latency of each agent run on `afterComplete` and
 *   marks the result as successful.
 * - On `onError`, records elapsed latency and a failed result.
 * - Calls `notify` with any violations the evaluator returns; failures inside
 *   `notify` are swallowed via the optional `logger` so the run never breaks.
 *
 * The evaluator's cooldown logic still gates duplicate notifications.
 */
export function createSloAlertHook(options: SloAlertHookOptions): HookStage {
  const now = options.now ?? (() => Date.now());
  const startedAtByRun = new Map<string, number>();

  async function dispatch(violations: readonly SloViolation[]): Promise<void> {
    if (violations.length === 0 || !options.notify) {
      return;
    }
    try {
      await options.notify(violations);
    } catch (error) {
      options.logger?.("SloAlertHook notify failed", error);
    }
  }

  return {
    afterComplete: async (context) => {
      const startedAt = startedAtByRun.get(context.runId) ?? context.startedAt.getTime();
      startedAtByRun.delete(context.runId);
      options.evaluator.recordLatency(now() - startedAt);
      options.evaluator.recordResult(true);
      await dispatch(options.evaluator.evaluate());
    },
    beforeStart: async (context) => {
      startedAtByRun.set(context.runId, now());
    },
    id: options.id ?? "slo-alert",
    onError: async (context) => {
      const startedAt = startedAtByRun.get(context.runId) ?? context.startedAt.getTime();
      startedAtByRun.delete(context.runId);
      options.evaluator.recordLatency(now() - startedAt);
      options.evaluator.recordResult(false);
      await dispatch(options.evaluator.evaluate());
    }
  };
}

// createSlackProgressHook lives in packages/integrations/src/slack-progress-hook.ts.

export function createToolResponseSummaryHook(options: ToolResponseSummaryHookOptions): HookStage {
  const previewLength = Math.max(1, options.previewLength ?? 500);

  return {
    afterTool: async (context, toolCall, result) => {
      if (result.status !== "completed") {
        return;
      }

      await options.onSummary({
        ...(countJsonItems(result.output) !== undefined ? { itemCount: countJsonItems(result.output) } : {}),
        outputPreview: truncatePreview(result.output, previewLength),
        runId: context.runId,
        status: result.status,
        toolCallId: toolCall.id,
        toolName: toolCall.name
      });
    },
    id: options.id ?? "tool-response-summary"
  };
}

export function createRagIngestionCaptureHook(options: RagIngestionCaptureHookOptions): HookStage {
  return {
    afterComplete: async (context, response) => {
      const policy = await options.policyStore.getOrNull();

      if (!policy?.enabled) {
        return;
      }

      const query = firstUserMessage(context.input.messages);
      const channel = metadataString(context.input.metadata, "channel");
      const sessionId = metadataString(context.input.metadata, "sessionId");
      const userId = metadataString(context.input.metadata, "userId") ?? options.userIdFallback;

      if (!userId || !isEligibleRagCandidate(query, response.output, channel, policy)) {
        return;
      }

      await options.candidateStore.save({
        ...(channel ? { channel } : {}),
        query,
        response: response.output,
        runId: context.runId,
        ...(sessionId ? { sessionId } : {}),
        status: policy.requireReview ? "PENDING" : "INGESTED",
        userId
      });
    },
    id: options.id ?? "rag-ingestion-capture"
  };
}

export function createFeedbackMetadataCaptureHook(options: FeedbackMetadataCaptureHookOptions): HookStage {
  return {
    afterComplete: async (context, response) => {
      const query = firstUserMessage(context.input.messages);

      if (query.length === 0 || response.output.trim().length === 0) {
        return;
      }

      await options.feedbackStore.save({
        ...selectMetadata(context.input.metadata, [
          "channel",
          "domain",
          "intent",
          "sessionId",
          "templateId",
          "userId"
        ]),
        model: response.model,
        query,
        response: response.output,
        runId: context.runId,
        timestamp: context.startedAt.toISOString()
      });
    },
    id: options.id ?? "feedback-metadata-capture"
  };
}

export function createUserMemoryInjectionHook(options: UserMemoryInjectionHookOptions): HookStage {
  const maxEntries = Math.max(1, options.maxEntries ?? 12);

  return {
    beforeStart: async (context) => {
      const userId = metadataString(context.input.metadata, "userId");

      if (!userId) {
        return;
      }

      const memory = await options.memoryStore.findByUserId(userId);
      const memoryMessage = memory ? renderUserMemoryMessage(memory, maxEntries) : undefined;

      if (!memoryMessage) {
        return;
      }

      const input = context.input as {
        messages: readonly ModelMessage[];
      };
      input.messages = [memoryMessage, ...context.input.messages];
    },
    id: options.id ?? "user-memory-injection"
  };
}

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

export function buildSlackBotInstanceUpsertQuery(
  db: Kysely<MuseDatabase>,
  instance: SlackBotInstance,
  options: { readonly createdAt?: Date; readonly now: () => Date }
) {
  const row = createSlackBotInstanceInsert(instance, options);

  return db
    .insertInto("slack_bot_instances")
    .values(row)
    .onConflict((oc) => oc.column("id").doUpdateSet({
      app_token: row.app_token,
      bot_token: row.bot_token,
      default_channel: row.default_channel,
      enabled: row.enabled,
      name: row.name,
      persona_id: row.persona_id,
      updated_at: row.updated_at
    }))
    .returningAll();
}

export function createSlackBotInstanceInsert(
  instance: SlackBotInstance,
  options: { readonly createdAt?: Date; readonly now: () => Date }
): SlackBotInstanceInsert {
  const now = options.now();
  const normalized = normalizeSlackBotInstance(instance, {
    createdAt: options.createdAt ?? instance.createdAt ?? now,
    updatedAt: instance.updatedAt ?? now
  });

  return {
    app_token: normalized.appToken,
    bot_token: normalized.botToken,
    created_at: normalized.createdAt,
    default_channel: normalized.defaultChannel,
    enabled: normalized.enabled,
    id: normalized.id,
    name: normalized.name,
    persona_id: normalized.personaId,
    updated_at: normalized.updatedAt
  };
}

export function mapSlackBotInstanceRow(row: SlackBotInstanceRow | SlackBotInstanceInsert): SlackBotInstance {
  return {
    appToken: row.app_token ?? "",
    botToken: row.bot_token ?? "",
    createdAt: dateValue(row.created_at ?? null),
    defaultChannel: row.default_channel ?? null,
    enabled: row.enabled ?? true,
    id: row.id ?? "",
    name: row.name ?? "",
    personaId: row.persona_id ?? "",
    updatedAt: dateValue(row.updated_at ?? null)
  };
}

export function buildChannelFaqRegistrationUpsertQuery(
  db: Kysely<MuseDatabase>,
  registration: ChannelFaqRegistration,
  options: { readonly registeredAt?: Date; readonly now: () => Date }
) {
  const row = createChannelFaqRegistrationInsert(registration, options);

  return db
    .insertInto("channel_faq_registrations")
    .values(row)
    .onConflict((oc) => oc.column("channel_id").doUpdateSet({
      auto_reply_mode: row.auto_reply_mode,
      channel_name: row.channel_name,
      confidence_threshold: row.confidence_threshold,
      days_back: row.days_back,
      enabled: row.enabled,
      last_chunk_count: row.last_chunk_count,
      last_error: row.last_error,
      last_ingested_at: row.last_ingested_at,
      last_message_count: row.last_message_count,
      last_status: row.last_status,
      re_ingest_interval_hours: row.re_ingest_interval_hours,
      updated_at: row.updated_at
    }))
    .returningAll();
}

export function createChannelFaqRegistrationInsert(
  registration: ChannelFaqRegistration,
  options: { readonly registeredAt?: Date; readonly now: () => Date }
): ChannelFaqRegistrationInsert {
  const now = options.now();
  const normalized = normalizeChannelFaqRegistration(registration, {
    registeredAt: options.registeredAt ?? registration.registeredAt ?? now,
    updatedAt: registration.updatedAt ?? now
  });

  return {
    auto_reply_mode: normalized.autoReplyMode,
    channel_id: normalized.channelId,
    channel_name: normalized.channelName,
    confidence_threshold: normalized.confidenceThreshold,
    days_back: normalized.daysBack,
    enabled: normalized.enabled,
    last_chunk_count: normalized.lastChunkCount,
    last_error: normalized.lastError,
    last_ingested_at: normalized.lastIngestedAt,
    last_message_count: normalized.lastMessageCount,
    last_status: normalized.lastStatus,
    re_ingest_interval_hours: normalized.reIngestIntervalHours,
    registered_at: normalized.registeredAt,
    registered_by: normalized.registeredBy,
    updated_at: normalized.updatedAt
  };
}

export function mapChannelFaqRegistrationRow(
  row: ChannelFaqRegistrationRow | ChannelFaqRegistrationInsert
): ChannelFaqRegistration {
  return {
    autoReplyMode: slackFaqAutoReplyMode(row.auto_reply_mode),
    channelId: row.channel_id ?? "",
    channelName: row.channel_name ?? null,
    confidenceThreshold: row.confidence_threshold ?? 0.8,
    daysBack: row.days_back ?? 30,
    enabled: row.enabled ?? true,
    lastChunkCount: row.last_chunk_count ?? null,
    lastError: row.last_error ?? null,
    lastIngestedAt: row.last_ingested_at ? dateValue(row.last_ingested_at) : null,
    lastMessageCount: row.last_message_count ?? null,
    lastStatus: slackFaqIngestStatus(row.last_status),
    reIngestIntervalHours: row.re_ingest_interval_hours ?? 24,
    registeredAt: dateValue(row.registered_at ?? null),
    registeredBy: row.registered_by ?? null,
    updatedAt: dateValue(row.updated_at ?? null)
  };
}

// Slack response-tracking + feedback-event row mappers live in
// slack-response-tracker.ts and slack-feedback-store.ts.

function normalizeSlackBotInstance(
  instance: SlackBotInstance,
  timestamps: { readonly createdAt: Date; readonly updatedAt: Date }
): RequiredSlackBotInstance {
  return {
    appToken: instance.appToken,
    botToken: instance.botToken,
    createdAt: timestamps.createdAt,
    defaultChannel: nullableString(instance.defaultChannel),
    enabled: instance.enabled ?? true,
    id: instance.id,
    name: instance.name.trim(),
    personaId: instance.personaId,
    updatedAt: timestamps.updatedAt
  };
}

function normalizeChannelFaqRegistration(
  registration: ChannelFaqRegistration,
  timestamps: { readonly registeredAt: Date; readonly updatedAt: Date }
): RequiredChannelFaqRegistration {
  return {
    autoReplyMode: slackFaqAutoReplyMode(registration.autoReplyMode),
    channelId: registration.channelId,
    channelName: nullableString(registration.channelName),
    confidenceThreshold: registration.confidenceThreshold ?? 0.8,
    daysBack: Math.max(1, Math.trunc(registration.daysBack ?? 30)),
    enabled: registration.enabled ?? true,
    lastChunkCount: registration.lastChunkCount ?? null,
    lastError: nullableString(registration.lastError),
    lastIngestedAt: registration.lastIngestedAt ?? null,
    lastMessageCount: registration.lastMessageCount ?? null,
    lastStatus: slackFaqIngestStatus(registration.lastStatus),
    reIngestIntervalHours: Math.max(1, Math.trunc(registration.reIngestIntervalHours ?? 24)),
    registeredAt: timestamps.registeredAt,
    registeredBy: nullableString(registration.registeredBy),
    updatedAt: timestamps.updatedAt
  };
}

function compareFaqRegistrations(left: RequiredChannelFaqRegistration, right: RequiredChannelFaqRegistration): number {
  const leftIngested = left.lastIngestedAt?.getTime() ?? 0;
  const rightIngested = right.lastIngestedAt?.getTime() ?? 0;
  return leftIngested - rightIngested || left.registeredAt.getTime() - right.registeredAt.getTime();
}

function nullableString(value: string | null | undefined): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function slackFaqAutoReplyMode(value: unknown): SlackFaqAutoReplyMode {
  const normalized = typeof value === "string" ? value.trim().toUpperCase() : "";
  return normalized === "ALWAYS" || normalized === "OFF" ? normalized : "MENTION";
}

function slackFaqIngestStatus(value: unknown): SlackFaqIngestStatus | null {
  const normalized = typeof value === "string" ? value.trim().toUpperCase() : "";
  return normalized === "OK" || normalized === "FAILED" || normalized === "RUNNING" ? normalized : null;
}

function dateValue(value: Date | string | null): Date {
  return value instanceof Date ? value : new Date(value ?? 0);
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

function eventToPayload(event: WebhookEvent): JsonObject {
  return {
    createdAt: event.createdAt.toISOString(),
    id: event.id,
    payload: event.payload,
    runId: event.runId,
    type: event.type
  };
}

function runContextPayload(context: AgentRunContext): JsonObject {
  return {
    metadata: context.input.metadata ?? {},
    model: context.input.model,
    startedAt: context.startedAt.toISOString()
  };
}

function errorPayload(error: unknown): JsonObject {
  if (error instanceof Error) {
    return {
      error: error.message,
      name: error.name
    };
  }

  return {
    error: String(error),
    name: "Error"
  };
}

function truncatePreview(value: string, maxLength: number): string {
  return value.length > maxLength ? value.slice(0, maxLength) : value;
}

function countJsonItems(value: string): number | undefined {
  try {
    const parsed = JSON.parse(value) as unknown;

    if (Array.isArray(parsed)) {
      return parsed.length;
    }

    if (isJsonRecord(parsed)) {
      const firstArray = Object.values(parsed).find(Array.isArray);
      return firstArray?.length;
    }

    return undefined;
  } catch {
    return undefined;
  }
}

function firstUserMessage(messages: readonly { readonly content: string; readonly role: string }[]): string {
  return messages.find((message) => message.role === "user")?.content.trim() ?? "";
}

function isEligibleRagCandidate(
  query: string,
  response: string,
  channel: string | undefined,
  policy: RagIngestionCapturePolicy
): boolean {
  if (query.trim().length < policy.minQueryChars || response.trim().length < policy.minResponseChars) {
    return false;
  }

  if (policy.allowedChannels.length > 0 && (!channel || !policy.allowedChannels.includes(channel))) {
    return false;
  }

  const combined = `${query}\n${response}`;
  return !policy.blockedPatterns.some((pattern) => pattern.length > 0 && new RegExp(pattern, "iu").test(combined));
}

function selectMetadata(metadata: JsonObject | undefined, keys: readonly string[]): JsonObject {
  const selected: Record<string, JsonValue> = {};

  for (const key of keys) {
    const value = metadata?.[key];

    if (typeof value === "string" && value.trim().length > 0) {
      selected[key] = value;
    }
  }

  return selected as JsonObject;
}

function renderUserMemoryMessage(memory: UserMemoryInjectionMemory, maxEntries: number): ModelMessage | undefined {
  const lines: string[] = [];

  for (const [key, value] of Object.entries(memory.facts)) {
    if (value.trim().length > 0) {
      lines.push(`- Fact ${key}: ${value}`);
    }
  }

  for (const [key, value] of Object.entries(memory.preferences)) {
    if (value.trim().length > 0) {
      lines.push(`- Preference ${key}: ${value}`);
    }
  }

  for (const topic of memory.recentTopics ?? []) {
    if (topic.trim().length > 0) {
      lines.push(`- Recent topic: ${topic}`);
    }
  }

  if (lines.length === 0) {
    return undefined;
  }

  return {
    content: ["Relevant user memory:", ...lines.slice(0, maxEntries)].join("\n"),
    role: "system"
  };
}

function metadataString(metadata: JsonObject | undefined, key: string): string | undefined {
  const value = metadata?.[key];
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function blankToUndefined(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized && normalized.length > 0 ? normalized : undefined;
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


interface RequiredSlackBotInstance {
  readonly id: string;
  readonly name: string;
  readonly botToken: string;
  readonly appToken: string;
  readonly personaId: string;
  readonly defaultChannel: string | null;
  readonly enabled: boolean;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

interface RequiredChannelFaqRegistration {
  readonly channelId: string;
  readonly channelName: string | null;
  readonly enabled: boolean;
  readonly autoReplyMode: SlackFaqAutoReplyMode;
  readonly confidenceThreshold: number;
  readonly daysBack: number;
  readonly reIngestIntervalHours: number;
  readonly lastIngestedAt: Date | null;
  readonly lastMessageCount: number | null;
  readonly lastChunkCount: number | null;
  readonly lastStatus: SlackFaqIngestStatus | null;
  readonly lastError: string | null;
  readonly registeredBy: string | null;
  readonly registeredAt: Date;
  readonly updatedAt: Date;
}
