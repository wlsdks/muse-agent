import { createHmac, timingSafeEqual } from "node:crypto";
import type { AgentRunContext, HookStage } from "@muse/agent-core";
import type { ModelMessage } from "@muse/model";
import type { FollowupSuggestionStore } from "@muse/observability";
import type {
  ChannelFaqRegistrationTable,
  MuseDatabase,
  SlackBotInstanceTable,
  SlackFeedbackEventTable,
  SlackResponseTrackingTable
} from "@muse/db";
import { createRunId, type JsonObject, type JsonValue } from "@muse/shared";
import type { Insertable, Kysely, Selectable } from "kysely";

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

export class InMemorySlackResponseTrackerStore implements SlackResponseTrackerStore {
  private readonly entries = new Map<string, SlackResponseTrackingInput>();
  private readonly maxEntries: number;

  constructor(options: { readonly maxEntries?: number } = {}) {
    this.maxEntries = Math.max(1, options.maxEntries ?? 50_000);
  }

  track(input: SlackResponseTrackingInput): void {
    if (input.channelId.trim().length === 0 || input.messageTs.trim().length === 0) {
      return;
    }

    this.entries.set(slackResponseKey(input.channelId, input.messageTs), input);
    this.trim(input.expiresAt - 1);
  }

  lookup(channelId: string, messageTs: string, now: number = Date.now()): TrackedSlackBotResponse | undefined {
    const key = slackResponseKey(channelId, messageTs);
    const entry = this.entries.get(key);

    if (!entry) {
      return undefined;
    }

    if (entry.expiresAt <= now) {
      this.entries.delete(key);
      return undefined;
    }

    return {
      expiresAt: entry.expiresAt,
      response: entry.response,
      sessionId: entry.sessionId,
      userPrompt: entry.userPrompt
    };
  }

  purgeExpired(now: number = Date.now()): number {
    let deleted = 0;

    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) {
        this.entries.delete(key);
        deleted += 1;
      }
    }

    return deleted;
  }

  private trim(now: number): void {
    this.purgeExpired(now);

    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value as string | undefined;

      if (!oldest) {
        return;
      }

      this.entries.delete(oldest);
    }
  }
}

export class KyselySlackResponseTrackerStore implements SlackResponseTrackerStore {
  private readonly now: () => Date;

  constructor(
    private readonly db: Kysely<MuseDatabase>,
    options: { readonly now?: () => Date } = {}
  ) {
    this.now = options.now ?? (() => new Date());
  }

  async track(input: SlackResponseTrackingInput): Promise<void> {
    if (input.channelId.trim().length === 0 || input.messageTs.trim().length === 0) {
      return;
    }

    const row = createSlackResponseTrackingInsert(input, { now: this.now });
    await this.db
      .insertInto("slack_response_tracking")
      .values(row)
      .onConflict((oc) => oc.columns(["channel_id", "message_ts"]).doUpdateSet({
        expires_at: row.expires_at,
        response: row.response,
        session_id: row.session_id,
        updated_at: row.updated_at,
        user_prompt: row.user_prompt
      }))
      .executeTakeFirst();
  }

  async lookup(channelId: string, messageTs: string, now: number = Date.now()): Promise<TrackedSlackBotResponse | undefined> {
    const row = await this.db
      .selectFrom("slack_response_tracking")
      .selectAll()
      .where("channel_id", "=", channelId)
      .where("message_ts", "=", messageTs)
      .executeTakeFirst();

    if (!row) {
      return undefined;
    }

    const tracked = mapSlackResponseTrackingRow(row);

    if (tracked.expiresAt <= now) {
      await this.db
        .deleteFrom("slack_response_tracking")
        .where("channel_id", "=", channelId)
        .where("message_ts", "=", messageTs)
        .executeTakeFirst();
      return undefined;
    }

    return tracked;
  }

  async purgeExpired(now: number = Date.now()): Promise<number> {
    const result = await this.db
      .deleteFrom("slack_response_tracking")
      .where("expires_at", "<=", new Date(now))
      .executeTakeFirst();
    return Number(result.numDeletedRows ?? 0);
  }
}

export class SlackBotResponseTracker {
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly store: SlackResponseTrackerStore;

  constructor(options: {
    readonly maxEntries?: number;
    readonly now?: () => number;
    readonly store?: SlackResponseTrackerStore;
    readonly ttlMs?: number;
  } = {}) {
    this.now = options.now ?? (() => Date.now());
    this.store = options.store ?? new InMemorySlackResponseTrackerStore({ maxEntries: options.maxEntries });
    this.ttlMs = Math.max(1, options.ttlMs ?? 86_400_000);
  }

  track(
    channelId: string,
    messageTs: string,
    sessionId: string,
    userPrompt: string,
    response?: string
  ): Awaitable<void> {
    if (channelId.trim().length === 0 || messageTs.trim().length === 0) {
      return;
    }

    return this.store.track({
      channelId,
      expiresAt: this.now() + this.ttlMs,
      messageTs,
      response,
      sessionId,
      userPrompt
    });
  }

  lookup(channelId: string, messageTs: string): Awaitable<TrackedSlackBotResponse | undefined> {
    return this.store.lookup(channelId, messageTs, this.now());
  }

  purgeExpired(): Awaitable<number> {
    return this.store.purgeExpired(this.now());
  }
}

export class InMemorySlackFeedbackEventStore implements SlackFeedbackEventStore {
  private readonly events: SlackFeedbackEvent[] = [];
  private readonly idFactory: () => string;
  private readonly maxEvents: number;
  private readonly now: () => Date;

  constructor(options: {
    readonly idFactory?: () => string;
    readonly maxEvents?: number;
    readonly now?: () => Date;
  } = {}) {
    this.idFactory = options.idFactory ?? (() => createRunId("slack_feedback"));
    this.maxEvents = Math.max(1, options.maxEvents ?? 50_000);
    this.now = options.now ?? (() => new Date());
  }

  save(input: SlackFeedbackInput): SlackFeedbackEvent {
    const event = normalizeSlackFeedbackEvent(input, {
      createdAt: this.now(),
      id: this.idFactory()
    });

    this.events.push(event);

    while (this.events.length > this.maxEvents) {
      this.events.shift();
    }

    return event;
  }

  listBySession(sessionId: string): readonly SlackFeedbackEvent[] {
    return this.events.filter((event) => event.sessionId === sessionId);
  }
}

export class KyselySlackFeedbackEventStore implements SlackFeedbackEventStore {
  private readonly idFactory: () => string;
  private readonly now: () => Date;

  constructor(
    private readonly db: Kysely<MuseDatabase>,
    options: {
      readonly idFactory?: () => string;
      readonly now?: () => Date;
    } = {}
  ) {
    this.idFactory = options.idFactory ?? (() => createRunId("slack_feedback"));
    this.now = options.now ?? (() => new Date());
  }

  async save(input: SlackFeedbackInput): Promise<SlackFeedbackEvent> {
    const event = normalizeSlackFeedbackEvent(input, {
      createdAt: this.now(),
      id: this.idFactory()
    });
    const row = createSlackFeedbackEventInsert(event);

    const saved = await this.db
      .insertInto("slack_feedback_events")
      .values(row)
      .returningAll()
      .executeTakeFirstOrThrow();

    return mapSlackFeedbackEventRow(saved);
  }

  async listBySession(sessionId: string): Promise<readonly SlackFeedbackEvent[]> {
    const rows = await this.db
      .selectFrom("slack_feedback_events")
      .selectAll()
      .where("session_id", "=", sessionId)
      .orderBy("created_at", "desc")
      .execute();
    return rows.map(mapSlackFeedbackEventRow);
  }
}

export class SlackFeedbackButtonHandler implements SlackInteractionHandler {
  readonly actionIdPrefix = "feedback";

  constructor(private readonly options: {
    readonly messageTransport?: SlackMessageTransport;
    readonly onFeedback: (feedback: SlackFeedbackInput) => Awaitable<void>;
    readonly responseTransport?: SlackResponseUrlTransport;
    readonly feedbackStore?: SlackFeedbackEventStore;
    readonly tracker: SlackBotResponseTracker;
  }) {}

  async handle(payload: SlackInteractionPayload): Promise<boolean> {
    const rating = feedbackRatingFromAction(payload.actionId);

    if (!rating) {
      return true;
    }

    if (!payload.channelId || !payload.messageTs) {
      return true;
    }

    const tracked = await this.options.tracker.lookup(payload.channelId, payload.messageTs);

    if (!tracked) {
      if (payload.responseUrl && this.options.responseTransport) {
        await this.options.responseTransport.post(payload.responseUrl, {
          response_type: "ephemeral",
          text: "This message is expired or no longer tracked."
        });
      }

      return true;
    }

    const feedback = {
      channelId: payload.channelId,
      messageTs: payload.messageTs,
      metadata: {
        actionId: payload.actionId,
        responseUrl: payload.responseUrl ?? null,
        type: payload.type
      },
      query: tracked.userPrompt,
      rating,
      response: tracked.response ?? "",
      sessionId: tracked.sessionId,
      userId: payload.userId
    } satisfies SlackFeedbackInput;
    const saved = await toBooleanPromise((async () => {
      await this.options.feedbackStore?.save(feedback);
      await this.options.onFeedback(feedback);
    })());
    const ackText = saved
      ? rating === "thumbs_up"
        ? "Thanks for the feedback. I will keep improving."
        : "Thanks for the candid feedback. I will do better next time."
      : "Feedback was received, but saving failed.";

    await this.options.messageTransport?.postMessage({
      channelId: payload.channelId,
      text: ackText,
      threadTs: payload.messageTs
    });

    return true;
  }
}

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

export interface SlackReminder {
  readonly id: number;
  readonly text: string;
  readonly dueAt?: Date;
  readonly createdAt: Date;
}

export interface SlackReminderTimeParseResult {
  readonly cleanText: string;
  readonly dueAt?: Date;
}

const REMINDER_AT_TIME_PATTERN = /(?:^|\s)at\s+(\d{1,2}):(\d{2})(?:\s*$)/iu;
const REMINDER_KOREAN_TIME_PATTERN = /(?:^|\s)(\d{1,2})시(?:\s*(\d{1,2})분)?(?:\s*에?)(?:\s*$)/u;

export interface ReminderTimeParseOptions {
  readonly timezone?: string;
  readonly now?: () => Date;
}

export function parseReminderTime(
  text: string,
  options: ReminderTimeParseOptions = {}
): SlackReminderTimeParseResult {
  const timezone = options.timezone ?? "Asia/Seoul";
  const now = options.now ? options.now() : new Date();

  const atMatch = REMINDER_AT_TIME_PATTERN.exec(text);
  if (atMatch && atMatch[1] && atMatch[2]) {
    const hour = Number.parseInt(atMatch[1], 10);
    const minute = Number.parseInt(atMatch[2], 10);
    const dueAt = resolveReminderInstant(hour, minute, timezone, now);
    if (dueAt) {
      const cleanText = removeRange(text, atMatch.index, atMatch.index + atMatch[0].length).trim();
      return { cleanText: cleanText.length > 0 ? cleanText : text.trim(), dueAt };
    }
  }

  const koreanMatch = REMINDER_KOREAN_TIME_PATTERN.exec(text);
  if (koreanMatch && koreanMatch[1]) {
    const hour = Number.parseInt(koreanMatch[1], 10);
    const minute = koreanMatch[2] ? Number.parseInt(koreanMatch[2], 10) : 0;
    const dueAt = resolveReminderInstant(hour, minute, timezone, now);
    if (dueAt) {
      const cleanText = removeRange(text, koreanMatch.index, koreanMatch.index + koreanMatch[0].length).trim();
      return { cleanText: cleanText.length > 0 ? cleanText : text.trim(), dueAt };
    }
  }

  return { cleanText: text };
}

function resolveReminderInstant(
  hour: number,
  minute: number,
  timezone: string,
  now: Date
): Date | undefined {
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    return undefined;
  }
  const tzOffsetMinutes = computeTimezoneOffsetMinutes(now, timezone);
  const localNow = new Date(now.getTime() + tzOffsetMinutes * 60_000);
  const localTarget = new Date(Date.UTC(
    localNow.getUTCFullYear(),
    localNow.getUTCMonth(),
    localNow.getUTCDate(),
    hour,
    minute,
    0,
    0
  ));
  let utcTarget = new Date(localTarget.getTime() - tzOffsetMinutes * 60_000);
  if (utcTarget.getTime() <= now.getTime()) {
    utcTarget = new Date(utcTarget.getTime() + 24 * 60 * 60 * 1000);
  }
  return utcTarget;
}

function computeTimezoneOffsetMinutes(at: Date, timezone: string): number {
  try {
    const formatter = new Intl.DateTimeFormat("en-US", {
      day: "2-digit",
      hour: "2-digit",
      hour12: false,
      minute: "2-digit",
      month: "2-digit",
      second: "2-digit",
      timeZone: timezone,
      year: "numeric"
    });
    const parts = formatter.formatToParts(at);
    const get = (type: string) => Number.parseInt(parts.find((part) => part.type === type)?.value ?? "0", 10);
    const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
    return Math.round((asUtc - at.getTime()) / 60_000);
  } catch {
    return 0;
  }
}

function removeRange(text: string, start: number, end: number): string {
  return `${text.slice(0, start)}${text.slice(end)}`;
}

export interface ReminderStore {
  add(userId: string, text: string): SlackReminder;
  list(userId: string): readonly SlackReminder[];
  done(userId: string, id: number): SlackReminder | undefined;
  clear(userId: string): number;
  collectDue(now?: Date): readonly { readonly userId: string; readonly reminder: SlackReminder }[];
}

export interface InMemoryReminderStoreOptions {
  readonly maxPerUser?: number;
  readonly timezone?: string;
  readonly now?: () => Date;
}

export class InMemoryReminderStore implements ReminderStore {
  readonly #maxPerUser: number;
  readonly #timezone: string;
  readonly #now: () => Date;
  readonly #remindersByUser = new Map<string, SlackReminder[]>();
  readonly #sequenceByUser = new Map<string, number>();

  constructor(options: InMemoryReminderStoreOptions = {}) {
    this.#maxPerUser = Math.max(1, options.maxPerUser ?? 50);
    this.#timezone = options.timezone ?? "Asia/Seoul";
    this.#now = options.now ?? (() => new Date());
  }

  add(userId: string, text: string): SlackReminder {
    const parsed = parseReminderTime(text.trim(), { now: this.#now, timezone: this.#timezone });
    const id = (this.#sequenceByUser.get(userId) ?? 0) + 1;
    this.#sequenceByUser.set(userId, id);
    const reminder: SlackReminder = {
      createdAt: this.#now(),
      ...(parsed.dueAt ? { dueAt: parsed.dueAt } : {}),
      id,
      text: parsed.cleanText
    };
    const list = this.#remindersByUser.get(userId) ?? [];
    list.push(reminder);
    while (list.length > this.#maxPerUser) {
      list.shift();
    }
    this.#remindersByUser.set(userId, list);
    return reminder;
  }

  list(userId: string): readonly SlackReminder[] {
    return [...(this.#remindersByUser.get(userId) ?? [])].sort((a, b) => a.id - b.id);
  }

  done(userId: string, id: number): SlackReminder | undefined {
    const list = this.#remindersByUser.get(userId);
    if (!list) {
      return undefined;
    }
    const index = list.findIndex((entry) => entry.id === id);
    if (index < 0) {
      return undefined;
    }
    const [removed] = list.splice(index, 1);
    return removed;
  }

  clear(userId: string): number {
    const list = this.#remindersByUser.get(userId);
    if (!list) {
      return 0;
    }
    const count = list.length;
    list.length = 0;
    return count;
  }

  collectDue(now: Date = this.#now()): readonly { readonly userId: string; readonly reminder: SlackReminder }[] {
    const result: { readonly userId: string; readonly reminder: SlackReminder }[] = [];
    for (const [userId, list] of this.#remindersByUser.entries()) {
      const due = list.filter((entry) => entry.dueAt !== undefined && entry.dueAt.getTime() <= now.getTime());
      if (due.length === 0) {
        continue;
      }
      this.#remindersByUser.set(
        userId,
        list.filter((entry) => !due.includes(entry))
      );
      for (const reminder of due) {
        result.push({ reminder, userId });
      }
    }
    return result;
  }
}

export interface SlackReminderPollerOptions {
  readonly store: ReminderStore;
  readonly messageTransport: SlackMessageTransport;
  readonly intervalMs?: number;
  readonly now?: () => Date;
  readonly logger?: (message: string, error?: unknown) => void;
}

export interface SlackReminderPoller {
  start(): void;
  stop(): void;
  tick(): Promise<void>;
}

export function createSlackReminderPoller(options: SlackReminderPollerOptions): SlackReminderPoller {
  const intervalMs = Math.max(1_000, options.intervalMs ?? 60_000);
  let timer: ReturnType<typeof setInterval> | undefined;

  const tick = async (): Promise<void> => {
    const due = options.store.collectDue(options.now ? options.now() : new Date());
    for (const entry of due) {
      try {
        await options.messageTransport.postMessage({
          channelId: entry.userId,
          text: `:bell: *Reminder #${entry.reminder.id}*\n${entry.reminder.text}`
        });
      } catch (error) {
        options.logger?.("SlackReminderPoller dispatch failed", error);
      }
    }
  };

  return {
    start: (): void => {
      if (timer !== undefined) {
        return;
      }
      timer = setInterval(() => {
        void tick();
      }, intervalMs);
    },
    stop: (): void => {
      if (timer !== undefined) {
        clearInterval(timer);
        timer = undefined;
      }
    },
    tick
  };
}

export interface SlackReminderCommandResult {
  readonly text: string;
}

export function handleSlackReminderCommand(
  store: ReminderStore,
  userId: string,
  args: string
): SlackReminderCommandResult {
  const trimmed = args.trim();
  if (trimmed.length === 0 || trimmed === "list") {
    const reminders = store.list(userId);
    if (reminders.length === 0) {
      return { text: "리마인더가 없어요." };
    }
    return {
      text: reminders
        .map((reminder) => formatReminderListEntry(reminder))
        .join("\n")
    };
  }

  const [command, ...rest] = trimmed.split(/\s+/u);
  const remaining = rest.join(" ").trim();

  if (command === "add") {
    if (remaining.length === 0) {
      return { text: "리마인더 내용을 입력하세요. 예: `/muse remind add 3시에 회의 준비`" };
    }
    const created = store.add(userId, remaining);
    if (created.dueAt) {
      return { text: `리마인더 #${created.id} 등록 (${created.dueAt.toISOString()}): ${created.text}` };
    }
    return { text: `리마인더 #${created.id} 등록 (시간 미지정): ${created.text}` };
  }

  if (command === "done") {
    const id = Number.parseInt(remaining, 10);
    if (!Number.isFinite(id)) {
      return { text: "리마인더 ID를 입력하세요. 예: `/muse remind done 3`" };
    }
    const removed = store.done(userId, id);
    return { text: removed ? `리마인더 #${removed.id} 완료 처리.` : `리마인더 #${id}을(를) 찾을 수 없어요.` };
  }

  if (command === "clear") {
    const removed = store.clear(userId);
    return { text: removed > 0 ? `리마인더 ${removed}건 삭제.` : "삭제할 리마인더가 없어요." };
  }

  return { text: "지원하는 명령: `add`, `list`, `done <id>`, `clear`" };
}

function formatReminderListEntry(reminder: SlackReminder): string {
  if (reminder.dueAt) {
    return `#${reminder.id} (${reminder.dueAt.toISOString()}): ${reminder.text}`;
  }
  return `#${reminder.id} (시간 미지정): ${reminder.text}`;
}

export interface FollowupSuggestion {
  readonly id: string;
  readonly label: string;
  readonly prompt: string;
  readonly category: string;
}

export const FOLLOWUP_ACTION_PREFIX = "followup";
export const FOLLOWUP_MAX_PER_MESSAGE = 5;
export const FOLLOWUP_MAX_LABEL_LENGTH = 75;

const FOLLOWUP_MARKER_PATTERN = /<!--\s*FOLLOWUPS\s*:\s*(\[[\s\S]*?\])\s*-->/u;

export function parseFollowupSuggestions(text: string): readonly FollowupSuggestion[] {
  const match = FOLLOWUP_MARKER_PATTERN.exec(text);
  if (!match || !match[1]) {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(match[1].trim());
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) {
    return [];
  }
  const suggestions: FollowupSuggestion[] = [];
  for (const entry of parsed) {
    if (suggestions.length >= FOLLOWUP_MAX_PER_MESSAGE) {
      break;
    }
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      continue;
    }
    const record = entry as Record<string, unknown>;
    const id = record["id"];
    const label = record["label"];
    const prompt = record["prompt"];
    const category = record["category"];
    if (
      typeof id !== "string" ||
      id.trim().length === 0 ||
      typeof label !== "string" ||
      label.trim().length === 0 ||
      typeof prompt !== "string" ||
      prompt.trim().length === 0 ||
      typeof category !== "string" ||
      category.trim().length === 0
    ) {
      continue;
    }
    suggestions.push({ category, id, label, prompt });
  }
  return suggestions;
}

export function stripFollowupMarker(text: string): string {
  return text.replace(FOLLOWUP_MARKER_PATTERN, "").trimEnd();
}

export function truncateFollowupLabel(label: string): string {
  if (label.length <= FOLLOWUP_MAX_LABEL_LENGTH) {
    return label;
  }
  return `${label.slice(0, FOLLOWUP_MAX_LABEL_LENGTH - 1)}…`;
}

export function followupActionId(suggestion: FollowupSuggestion): string {
  return `${FOLLOWUP_ACTION_PREFIX}.${suggestion.id}`;
}

export function extractFollowupCategory(suggestionId: string): string {
  const underscoreIndex = suggestionId.indexOf("_");
  if (underscoreIndex <= 0) {
    return "other";
  }
  return suggestionId.slice(0, underscoreIndex);
}

export function renderFollowupSuggestionBlocks(suggestions: readonly FollowupSuggestion[]): readonly JsonObject[] {
  if (suggestions.length === 0) {
    return [];
  }
  const limited = suggestions.slice(0, FOLLOWUP_MAX_PER_MESSAGE);
  return [
    {
      elements: limited.map((suggestion) => ({
        action_id: followupActionId(suggestion),
        text: { emoji: true, text: truncateFollowupLabel(suggestion.label), type: "plain_text" },
        type: "button",
        value: suggestion.prompt
      })),
      type: "actions"
    }
  ];
}

export interface FollowupAgentReplyResult {
  readonly text: string;
}

export interface FollowupSuggestionInteractionHandlerOptions {
  readonly store?: FollowupSuggestionStore;
  readonly runAgent: (input: {
    readonly prompt: string;
    readonly payload: SlackInteractionPayload;
    readonly suggestionId: string;
    readonly category: string;
  }) => Awaitable<FollowupAgentReplyResult | null>;
  readonly messageTransport?: SlackMessageTransport;
  readonly responseTransport?: SlackResponseUrlTransport;
  readonly now?: () => Date;
  readonly logger?: (message: string, error?: unknown) => void;
}

export function createFollowupSuggestionInteractionHandler(
  options: FollowupSuggestionInteractionHandlerOptions
): SlackInteractionHandler {
  return {
    actionIdPrefix: FOLLOWUP_ACTION_PREFIX,
    handle: async (payload: SlackInteractionPayload): Promise<boolean> => {
      const prompt = payload.value;
      const channelId = payload.channelId;
      if (!prompt || prompt.trim().length === 0 || !channelId) {
        return true;
      }
      const suggestionId = payload.actionId.startsWith(`${FOLLOWUP_ACTION_PREFIX}.`)
        ? payload.actionId.slice(FOLLOWUP_ACTION_PREFIX.length + 1)
        : payload.actionId;
      const category = extractFollowupCategory(suggestionId);

      try {
        options.store?.recordClick({
          category,
          channelId,
          ...(options.now ? { occurredAt: options.now() } : {}),
          suggestionId,
          userId: payload.userId,
          ...(payload.messageTs ? { messageTs: payload.messageTs } : {})
        });
      } catch (error) {
        options.logger?.("FollowupSuggestionHandler click record failed", error);
      }

      let reply: FollowupAgentReplyResult | null;
      try {
        reply = await options.runAgent({ category, payload, prompt, suggestionId });
      } catch (error) {
        options.logger?.("FollowupSuggestionHandler agent execution failed", error);
        return true;
      }

      if (!reply || reply.text.trim().length === 0) {
        return true;
      }

      try {
        await options.messageTransport?.postMessage({
          channelId,
          text: reply.text,
          ...(payload.messageTs ? { threadTs: payload.messageTs } : {})
        });
      } catch (error) {
        options.logger?.("FollowupSuggestionHandler message post failed", error);
      }

      return true;
    }
  };
}

export const SLACK_PROGRESS_DEFAULT_FRIENDLY_NAMES: Readonly<Record<string, string>> = Object.freeze({
  jira_search: "Jira 검색",
  jira_get_issue: "Jira 이슈 조회",
  jira_create_issue: "Jira 이슈 생성",
  jira_update_issue: "Jira 이슈 업데이트",
  jira_add_comment: "Jira 코멘트 작성",
  confluence_search_by_text: "Confluence 검색",
  confluence_get_page: "Confluence 페이지 조회",
  confluence_create_page: "Confluence 페이지 작성",
  bitbucket_list_prs: "Bitbucket PR 조회",
  bitbucket_get_pr: "Bitbucket PR 상세 조회",
  bitbucket_create_pr: "Bitbucket PR 생성",
  rag_search: "내부 문서 검색",
  web_search: "웹 검색"
});

export const SLACK_PROGRESS_DEFAULT_MIN_UPDATE_MS = 1500;
export const SLACK_PROGRESS_MAX_STATUS_LENGTH = 100;

export function createSlackProgressHook(options: SlackProgressHookOptions): HookStage {
  const minUpdateIntervalMs = options.minUpdateIntervalMs ?? SLACK_PROGRESS_DEFAULT_MIN_UPDATE_MS;
  const friendlyNames = options.friendlyNames ?? SLACK_PROGRESS_DEFAULT_FRIENDLY_NAMES;
  const now = options.now ?? (() => Date.now());
  const lastUpdateMsByRunId = new Map<string, number>();

  function readMetadataString(metadata: JsonObject | undefined, key: string): string | undefined {
    if (!metadata) {
      return undefined;
    }
    const value = metadata[key];
    return typeof value === "string" && value.length > 0 ? value : undefined;
  }

  function friendlyLabel(toolName: string): string {
    const override = friendlyNames[toolName];
    if (typeof override === "string" && override.length > 0) {
      return override;
    }
    return toolName
      .split(/[_\s]+/u)
      .filter((part) => part.length > 0)
      .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
      .join(" ");
  }

  function tryAcquireUpdateSlot(runId: string): boolean {
    const current = now();
    const last = lastUpdateMsByRunId.get(runId);
    if (last !== undefined && current - last < minUpdateIntervalMs) {
      return false;
    }
    lastUpdateMsByRunId.set(runId, current);
    return true;
  }

  async function updateStatus(context: AgentRunContext, status: string): Promise<void> {
    const channelId = readMetadataString(context.input.metadata, "slackChannelId");
    const threadTs = readMetadataString(context.input.metadata, "slackThreadTs");
    if (!channelId || !threadTs) {
      return;
    }

    if (!tryAcquireUpdateSlot(context.runId)) {
      return;
    }

    const truncated =
      status.length > SLACK_PROGRESS_MAX_STATUS_LENGTH
        ? status.slice(0, SLACK_PROGRESS_MAX_STATUS_LENGTH)
        : status;

    try {
      await options.transport.setStatus({ channelId, status: truncated, threadTs });
    } catch (error) {
      options.onError?.(error);
    }
  }

  return {
    afterComplete: async (context) => {
      lastUpdateMsByRunId.delete(context.runId);
    },
    afterTool: async (context, toolCall, result) => {
      const label = friendlyLabel(toolCall.name);
      const message =
        result.status === "completed"
          ? `✓ ${label} 완료 — 다음 단계 진행 중…`
          : `⚠️ ${label} 실패 — 복구 중…`;
      await updateStatus(context, message);
    },
    beforeTool: async (context, toolCall) => {
      await updateStatus(context, `🔍 ${friendlyLabel(toolCall.name)} 중…`);
    },
    id: options.id ?? "slack-progress",
    onError: async (context) => {
      lastUpdateMsByRunId.delete(context.runId);
    }
  };
}

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

export class SlackSignatureVerifier {
  private readonly signingSecret: string;
  private readonly timestampToleranceSeconds: number;
  private readonly nowSeconds: () => number;

  constructor(options: SlackSignatureVerifierOptions) {
    this.signingSecret = options.signingSecret;
    this.timestampToleranceSeconds = options.timestampToleranceSeconds ?? 300;
    this.nowSeconds = options.nowSeconds ?? (() => Math.floor(Date.now() / 1000));
  }

  verify(
    timestamp: string | undefined,
    signature: string | undefined,
    rawBody: string
  ): SlackSignatureVerificationResult {
    if (this.signingSecret.trim().length === 0) {
      return { ok: false, reason: "Signing secret is not configured" };
    }

    if (!timestamp || timestamp.trim().length === 0) {
      return { ok: false, reason: "Missing X-Slack-Request-Timestamp header" };
    }

    if (!signature || signature.trim().length === 0) {
      return { ok: false, reason: "Missing X-Slack-Signature header" };
    }

    const parsedTimestamp = Number.parseInt(timestamp, 10);

    if (!Number.isFinite(parsedTimestamp)) {
      return { ok: false, reason: "Invalid Slack request timestamp" };
    }

    if (Math.abs(this.nowSeconds() - parsedTimestamp) > this.timestampToleranceSeconds) {
      return { ok: false, reason: "Slack request timestamp is outside the allowed tolerance" };
    }

    return verifySlackSignature(rawBody, timestamp, signature, this.signingSecret)
      ? { ok: true }
      : { ok: false, reason: "Slack request signature mismatch" };
  }
}

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

export function createSlackResponseTrackingInsert(
  input: SlackResponseTrackingInput,
  options: { readonly now: () => Date }
): SlackResponseTrackingInsert {
  const now = options.now();

  return {
    channel_id: input.channelId,
    created_at: now,
    expires_at: new Date(input.expiresAt),
    message_ts: input.messageTs,
    response: input.response ?? null,
    session_id: input.sessionId,
    updated_at: now,
    user_prompt: input.userPrompt
  };
}

export function mapSlackResponseTrackingRow(
  row: SlackResponseTrackingRow | SlackResponseTrackingInsert
): TrackedSlackBotResponse {
  return {
    expiresAt: dateValue(row.expires_at ?? null).getTime(),
    response: row.response ?? undefined,
    sessionId: row.session_id ?? "",
    userPrompt: row.user_prompt ?? ""
  };
}

export function createSlackFeedbackEventInsert(event: SlackFeedbackEvent): SlackFeedbackEventInsert {
  return {
    channel_id: event.channelId,
    created_at: event.createdAt,
    id: event.id,
    message_ts: event.messageTs,
    metadata: event.metadata ?? {},
    query: event.query,
    rating: event.rating,
    response: event.response,
    session_id: event.sessionId,
    user_id: event.userId
  };
}

export function mapSlackFeedbackEventRow(row: SlackFeedbackEventRow | SlackFeedbackEventInsert): SlackFeedbackEvent {
  return {
    channelId: row.channel_id ?? "",
    createdAt: dateValue(row.created_at ?? null),
    id: row.id ?? "",
    messageTs: row.message_ts ?? "",
    metadata: jsonObjectValue(row.metadata),
    query: row.query ?? "",
    rating: row.rating === "thumbs_down" ? "thumbs_down" : "thumbs_up",
    response: row.response ?? "",
    sessionId: row.session_id ?? "",
    userId: row.user_id ?? ""
  };
}

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

function normalizeSlackFeedbackEvent(
  input: SlackFeedbackInput,
  generated: { readonly createdAt: Date; readonly id: string }
): SlackFeedbackEvent {
  return {
    channelId: input.channelId?.trim() || "unknown",
    createdAt: generated.createdAt,
    id: generated.id,
    messageTs: input.messageTs?.trim() || "unknown",
    metadata: input.metadata ?? {},
    query: input.query,
    rating: input.rating,
    response: input.response,
    sessionId: input.sessionId,
    userId: input.userId
  };
}

function slackResponseKey(channelId: string, messageTs: string): string {
  return `${channelId}:${messageTs}`;
}

function jsonObjectValue(value: unknown): JsonObject {
  if (typeof value === "string") {
    return (parseJsonObject(value) as JsonObject | undefined) ?? {};
  }

  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, JsonValue> : {};
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

export function createWebhookHeaders(body: JsonObject, secret: string | undefined): Record<string, string> {
  const serialized = JSON.stringify(body);
  const headers: Record<string, string> = {
    "content-type": "application/json"
  };

  if (secret) {
    headers["x-muse-signature"] = signWebhookPayload(serialized, secret);
  }

  return headers;
}

export function formatSlackMrkdwn(content: string): string {
  if (content.trim().length === 0) {
    return content;
  }

  return splitSlackCodeFenceSegments(content)
    .map((segment) => (segment.isCode ? segment.text : transformSlackNonCodeText(segment.text)))
    .join("");
}

export function signWebhookPayload(payload: string, secret: string): string {
  return `sha256=${createHmac("sha256", secret).update(payload).digest("hex")}`;
}

export function signSlackRequestBody(rawBody: string, timestamp: string, secret: string): string {
  return `v0=${createHmac("sha256", secret).update(`v0:${timestamp}:${rawBody}`).digest("hex")}`;
}

export function verifySlackSignature(
  rawBody: string,
  timestamp: string,
  signature: string | undefined,
  secret: string
): boolean {
  if (!signature) {
    return false;
  }

  const expected = Buffer.from(signSlackRequestBody(rawBody, timestamp, secret));
  const actual = Buffer.from(signature);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export function verifyWebhookSignature(payload: string, signature: string | undefined, secret: string): boolean {
  if (!signature) {
    return false;
  }

  const expected = Buffer.from(signWebhookPayload(payload, secret));
  const actual = Buffer.from(signature);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

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

function feedbackRatingFromAction(actionId: string): "thumbs_down" | "thumbs_up" | undefined {
  const subAction = actionId.startsWith("feedback.") ? actionId.slice("feedback.".length) : "";

  if (subAction === "up") {
    return "thumbs_up";
  }

  return subAction === "down" ? "thumbs_down" : undefined;
}

async function toBooleanPromise(input: Awaitable<void>): Promise<boolean> {
  try {
    await input;
    return true;
  } catch {
    return false;
  }
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

function formatSlackPayload(body: JsonObject): JsonObject {
  const text = body.text;

  if (typeof text !== "string") {
    return body;
  }

  return {
    ...body,
    text: formatSlackMrkdwn(text)
  };
}

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

const slackBoldPattern = /\*\*([^*\n]*[a-zA-Z0-9가-힣ㄱ-ㅎㅏ-ㅣ][^*\n]*)\*\*/gu;
const slackHeaderPattern = /^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/gmu;
const slackLinkPattern = /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/gu;
const slackHorizontalRulePattern = /^\s*([-*_])\1{2,}\s*$/gmu;
const slackExcessiveNewlinesPattern = /\n{3,}/gu;
const slackMultipleSpacesPattern = / {2,}/gu;
const slackLeadingSpacesPattern = /^ +/gmu;
const slackHeadingLinePattern = /^\s*\*[^*\n]{1,80}\*\s*$/u;
const slackBulletLinePattern = /^\s*[•\-*]\s+\S/u;
const slackTableSeparatorCellPattern = /^:?-{3,}:?$/u;
const slackInlineBacktickPattern = /`(?!U[A-Z0-9]{8,}`)[^`\n]{1,500}`/gu;
const slackInlineBacktickPlaceholderPattern = /\u0001BT(\d+)\u0001/gu;
const slackRawUserIdPattern = /(?<![@\w])`?(U[A-Z0-9]{8,})`?(?![A-Za-z0-9])/gu;
const slackSystemMetaLeakPattern =
  /^\s*(?:\[SYSTEM_META[^\n\]]*\][^\n]*|\(이 메시지의 발화자:[^)\n]*\)|\[현재 발화자=[^\n\]]*\][^\n]*)\s*$/gmu;
const slackLeadingGreetingPattern =
  /^(안녕하세요|안녕|반가워요|반갑습니다|반갑네요|하이)[,，]?\s*[^\n!?.]{0,25}[님씨][!?.]\s*/u;
const slackFollowupGreetingPattern = /^(반갑습니다|반가워요|반갑네요|좋은\s*아침이에요|좋은\s*저녁이에요)[!?.]\s*/u;
const slackInternalBrandPatterns: ReadonlyArray<readonly [RegExp, string]> = [
  [/\*\*?Reactor\s*\(\s*Reactor\s*\)\*\*?/gu, "*Reactor*"],
  [/Reactor\s*\(\s*Reactor\s*\)/gu, "Reactor"]
];
const slackDecorativeEmojis = [
  "📋",
  "💡",
  "🚀",
  "📌",
  "📄",
  "🔀",
  "📝",
  "✨",
  "🎯",
  "🎉",
  "😊",
  "😃",
  "😄",
  "😁",
  "🙂",
  "😉",
  "🥰",
  "🤗",
  "😇",
  "😂",
  "🤣",
  "😅",
  "😆",
  "😋",
  "😎",
  "😢",
  "😭",
  "😔",
  "😴",
  "🔥",
  "👏",
  "👍",
  "💪",
  "🙌",
  "🤝",
  "👀",
  "💭",
  "☀️",
  "⭐",
  "🌟",
  "🌈",
  "🎊",
  "🎁",
  "🙏",
  "🔍",
  "🤔",
  "🍶",
  "🍺",
  "🍻",
  "🍷",
  "🥃",
  "🍴",
  "🍽",
  "🍕",
  "🍔",
  "🍟",
  "🍗",
  "🍖",
  "🍚",
  "🍜",
  "🍝",
  "🍛",
  "🍙",
  "🍘",
  "🍢",
  "🍡",
  "☕",
  "🍵",
  "🥤",
  "🧋",
  "🍰",
  "🍩",
  "🍪",
  "🍫",
  "🍬",
  "🍭",
  "💬",
  "📱",
  "💻",
  "🖥",
  "⌨",
  "🖱",
  "🗂",
  "📊",
  "📈",
  "📉",
  "💨",
  "🏃",
  "🏃‍♂️",
  "🏃‍♀️",
  "🚶",
  "🏠",
  "🛋",
  "🛌",
  "⏰",
  "🎈",
  "💯",
  "💥",
  "🌸",
  "🎀",
  "💐",
  "🌺",
  "🌻"
] as const;

function transformSlackNonCodeText(text: string): string {
  const protectedBackticks: string[] = [];
  const hadTrailingNewline = text.endsWith("\n");
  let result = text.replace(slackInlineBacktickPattern, (match) => {
    protectedBackticks.push(match);
    return `\u0001BT${protectedBackticks.length - 1}\u0001`;
  });

  result = result.replace(slackSystemMetaLeakPattern, "");
  result = result.replace(slackLeadingGreetingPattern, "");
  result = result.replace(slackFollowupGreetingPattern, "");

  for (const [pattern, replacement] of slackInternalBrandPatterns) {
    result = result.replace(pattern, replacement);
  }

  result = result.replace(slackBoldPattern, (_match, inner: string) => `*${inner}*`);
  result = result.replace(slackHeaderPattern, (_match, inner: string) => `*${inner.replace(/^\*+|\*+$/gu, "").trim()}*`);
  result = convertSlackTables(result);
  result = result.replace(slackLinkPattern, (_match, label: string, url: string) => `<${url}|${label}>`);
  result = result.replace(slackHorizontalRulePattern, "");
  result = stripSlackDecorativeEmojis(result);
  result = result.replace(slackRawUserIdPattern, (_match, id: string) => `<@${id}>`);
  result = ensureSlackHeadingSpacing(result);
  result = result.replace(slackExcessiveNewlinesPattern, "\n\n").trim();
  if (hadTrailingNewline && result.length > 0) {
    result += "\n";
  }
  result = removeConsecutiveDuplicateSlackParagraphs(result);
  result = result.replace(slackInlineBacktickPlaceholderPattern, (match, index: string) => {
    const parsed = Number.parseInt(index, 10);
    return Number.isInteger(parsed) && parsed >= 0 && parsed < protectedBackticks.length
      ? protectedBackticks[parsed] ?? match
      : match;
  });

  return result;
}

function convertSlackTables(content: string): string {
  const lines = content.split("\n");
  const output: string[] = [];
  let index = 0;

  while (index < lines.length) {
    const headerLine = lines[index] ?? "";
    const separatorLine = lines[index + 1];

    if (isSlackTableRow(headerLine) && separatorLine !== undefined && isSlackTableSeparator(separatorLine)) {
      const headers = splitSlackTableCells(headerLine);
      let rowIndex = index + 2;

      while (rowIndex < lines.length && isSlackTableRow(lines[rowIndex] ?? "")) {
        const cells = splitSlackTableCells(lines[rowIndex] ?? "");
        const row = cells
          .map((cell, cellIndex) => {
            const value = cell.trim();
            const header = headers[cellIndex]?.trim() ?? "";

            if (value.length === 0) {
              return undefined;
            }

            return header.length > 0 ? `*${header}*: ${value}` : value;
          })
          .filter((cell): cell is string => cell !== undefined)
          .join(" — ");

        output.push(`• ${row}`);
        rowIndex += 1;
      }

      index = rowIndex;
      continue;
    }

    output.push(headerLine);
    index += 1;
  }

  return output.join("\n").replace(/\n+$/u, "");
}

function ensureSlackHeadingSpacing(text: string): string {
  const lines = text.split("\n");
  let output = "";

  lines.forEach((line, index) => {
    const isHeading = slackHeadingLinePattern.test(line);
    const isBullet = slackBulletLinePattern.test(line);
    const previousLine = index > 0 ? lines[index - 1] ?? "" : "";
    const previousIsBullet = slackBulletLinePattern.test(previousLine);

    if (isHeading && output.length > 0 && !output.endsWith("\n\n")) {
      output += output.endsWith("\n") ? "\n" : "\n\n";
    }

    if (isBullet && !previousIsBullet && previousLine.trim().length > 0 && output.length > 0 && !output.endsWith("\n\n")) {
      output += output.endsWith("\n") ? "\n" : "\n\n";
    }

    output += line;

    if (index < lines.length - 1) {
      output += "\n";
    }

    if (isHeading && index < lines.length - 1 && (lines[index + 1] ?? "").trim().length > 0) {
      output += "\n";
    }

    const nextLine = index < lines.length - 1 ? lines[index + 1] ?? "" : "";
    const nextIsBullet = slackBulletLinePattern.test(nextLine);

    if (isBullet && index < lines.length - 1 && !nextIsBullet && nextLine.trim().length > 0) {
      output += "\n";
    }
  });

  return output;
}

function stripSlackDecorativeEmojis(text: string): string {
  let result = text;

  for (const emoji of slackDecorativeEmojis) {
    result = result.split(`${emoji} `).join("");
    result = result.split(emoji).join("");
  }

  return result.replace(slackMultipleSpacesPattern, " ").replace(slackLeadingSpacesPattern, "");
}

function removeConsecutiveDuplicateSlackParagraphs(text: string): string {
  const paragraphs = text.split("\n\n");

  if (paragraphs.length < 2) {
    return text;
  }

  const output: string[] = [];
  let previousKey: string | undefined;

  for (const paragraph of paragraphs) {
    const key = paragraph.trim();

    if (key.length > 0 && key === previousKey) {
      continue;
    }

    output.push(paragraph);

    if (key.length > 0) {
      previousKey = key;
    }
  }

  return output.join("\n\n");
}

function isSlackTableRow(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith("|") && trimmed.endsWith("|") && countOccurrences(trimmed, "|") >= 3;
}

function isSlackTableSeparator(line: string): boolean {
  const trimmed = line.trim().replace(/^\|/u, "").replace(/\|$/u, "");

  if (trimmed.length === 0) {
    return false;
  }

  return trimmed.split("|").every((cell) => slackTableSeparatorCellPattern.test(cell.trim()));
}

function splitSlackTableCells(line: string): readonly string[] {
  return line.trim().replace(/^\|/u, "").replace(/\|$/u, "").split("|").map((cell) => cell.trim());
}

function countOccurrences(value: string, needle: string): number {
  return value.split(needle).length - 1;
}

function splitSlackCodeFenceSegments(content: string): Array<{ readonly isCode: boolean; readonly text: string }> {
  const segments: Array<{ readonly isCode: boolean; readonly text: string }> = [];
  const lines = content.split("\n");
  let buffer = "";
  let inCode = false;

  lines.forEach((line, index) => {
    const hasNextLine = index < lines.length - 1;

    if (line.trim().startsWith("```")) {
      if (buffer.length > 0) {
        segments.push({ isCode: inCode, text: buffer });
        buffer = "";
      }

      buffer += line;

      if (hasNextLine) {
        buffer += "\n";
      }

      segments.push({ isCode: true, text: buffer });
      buffer = "";
      inCode = !inCode;
      return;
    }

    buffer += line;

    if (hasNextLine) {
      buffer += "\n";
    }
  });

  if (buffer.length > 0) {
    segments.push({ isCode: inCode, text: buffer });
  }

  return segments;
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
