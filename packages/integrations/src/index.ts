import { createHmac, timingSafeEqual } from "node:crypto";
import { createRunId, type JsonObject } from "@muse/shared";

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

export class FetchSlackWebApiMessageTransport implements SlackMessageTransport {
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
