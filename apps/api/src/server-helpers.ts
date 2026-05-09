/**
 * Standalone helpers extracted from server.ts.
 *
 * Three buckets, all pure (no Fastify closure state):
 *   1. Chat domain — body parsers, response builders, agent-error handler,
 *      SSE stream encoder, multipart parser. Centred on AgentRuntime
 *      input/output shapes.
 *   2. Other parsers — agent-spec / runtime-setting / auth credentials
 *      input validators that produce ParseResult<T>.
 *   3. HTTP plumbing — CORS / API-version / sensitive-path / public-route /
 *      OpenAPI document builder + small util predicates and option helpers.
 *
 * Keeps server.ts focused on `buildServer` route registration. The chat
 * runners (`runChat` / `runChatStream` / `runMultipartChat`) live here too
 * so the helper file owns the full input → AgentRuntime → response chain.
 */

import { Readable } from "node:stream";
import { randomUUID } from "node:crypto";
import {
  GuardBlockedError,
  OutputGuardBlockedError,
  PlanExecutionError,
  PlanValidationFailedError,
  type AgentRunInput,
  type AgentRuntime,
  type AgentRunResult
} from "@muse/agent-core";
import type { AgentSpecInput } from "@muse/agent-specs";
import type { AuthIdentity, LoginResult } from "@muse/auth";
import type { RuntimeSettingType } from "@muse/runtime-settings";
import type { AgentRunRecord } from "@muse/runtime-state";
import type { JsonObject, JsonValue } from "@muse/shared";

import type { CorsOptions, ServerOptions } from "./server.js";

export type ParseResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly error: ApiError; readonly ok: false };

export interface ApiError {
  readonly code: string;
  readonly message: string;
}

// ---------------------------------------------------------------------------
// Chat runners
// ---------------------------------------------------------------------------

export async function runChat(
  body: unknown,
  reply: { status(statusCode: number): { send(payload: unknown): void } },
  options: ServerOptions,
  responseMode: "extended" | "compat",
  authUserId?: string
) {
  if (!options.agentRuntime) {
    return reply.status(503).send({
      code: "AGENT_RUNTIME_UNAVAILABLE",
      message: "Agent runtime is not configured"
    });
  }

  const parsed = parseAgentRunInput(body, options.defaultModel ?? "default", authUserId);

  if (!parsed.ok) {
    return reply.status(400).send(parsed.error);
  }

  try {
    const result = await options.agentRuntime.run(parsed.value);
    return responseMode === "compat" ? toCompatChatResponse(result) : toExtendedChatResponse(result);
  } catch (error) {
    return sendAgentError(reply, error, responseMode);
  }
}

export async function runChatStream(
  body: unknown,
  reply: {
    header(name: string, value: string): unknown;
    status(statusCode: number): { send(payload: unknown): void };
    send(payload: unknown): unknown;
  },
  options: ServerOptions,
  responseMode: "extended" | "compat",
  authUserId?: string
) {
  if (!options.agentRuntime) {
    return reply.status(503).send({
      code: "AGENT_RUNTIME_UNAVAILABLE",
      message: "Agent runtime is not configured"
    });
  }

  const parsed = parseAgentRunInput(body, options.defaultModel ?? "default", authUserId);

  if (!parsed.ok) {
    return reply.status(400).send(parsed.error);
  }

  reply.header("content-type", "text/event-stream; charset=utf-8");
  reply.header("cache-control", "no-cache");
  return reply.send(Readable.from(toSseStream(options.agentRuntime.stream(parsed.value), responseMode)));
}

export async function runMultipartChat(
  body: unknown,
  reply: { status(statusCode: number): { send(payload: unknown): void } },
  options: ServerOptions,
  authUserId?: string
) {
  const parsed = parseMultipartChatBody(body);

  if (!parsed.ok) {
    return reply.status(400).send(parsed.error);
  }

  return runChat(parsed.value, reply, options, "compat", authUserId);
}

// ---------------------------------------------------------------------------
// Chat parsers
// ---------------------------------------------------------------------------

export function parseMultipartChatBody(value: unknown): ParseResult<JsonObject> {
  if (!isRecord(value) || !isRecord(value.fields) || !Array.isArray(value.files)) {
    return invalid("INVALID_MULTIPART_CHAT_REQUEST", "Body must be multipart form-data");
  }

  const message = optionalString(value.fields.message);

  if (!message) {
    return invalid("INVALID_MULTIPART_CHAT_REQUEST", "Multipart request must include message");
  }

  return {
    ok: true,
    value: {
      message,
      metadata: {
        channel: "web",
        media: value.files.filter(isJsonObject),
        ...(optionalString(value.fields.personaId) ? { personaId: optionalString(value.fields.personaId) } : {}),
        ...(optionalString(value.fields.sessionId) ? { sessionId: optionalString(value.fields.sessionId) } : {}),
        ...(optionalString(value.fields.userId) ? { userId: optionalString(value.fields.userId) } : {})
      },
      ...(optionalString(value.fields.model) ? { model: optionalString(value.fields.model) } : {}),
      ...(optionalString(value.fields.sessionId) ? { runId: optionalString(value.fields.sessionId) } : {}),
      ...(optionalString(value.fields.systemPrompt)
        ? { messages: [{ content: optionalString(value.fields.systemPrompt) ?? "", role: "system" }, { content: message, role: "user" }] }
        : {})
    }
  };
}

export function parseAgentRunInput(value: unknown, defaultModel: string, authUserId?: string): ParseResult<AgentRunInput> {
  if (!isRecord(value)) {
    return invalid("INVALID_CHAT_REQUEST", "Body must be an object");
  }

  const messages = parseMessages(value.messages, value.message, value.systemPrompt);

  if (!messages) {
    return invalid("INVALID_CHAT_REQUEST", "Body must include message or messages");
  }

  const metadata = compatChatMetadata(value, authUserId);

  return {
    ok: true,
    value: {
      messages,
      metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
      model: typeof value.model === "string" && value.model.trim().length > 0 ? value.model : defaultModel,
      runId: typeof value.runId === "string" && value.runId.trim().length > 0 ? value.runId : undefined
    }
  };
}

function parseMessages(
  messages: unknown,
  message: unknown,
  systemPrompt: unknown
): AgentRunInput["messages"] | undefined {
  if (Array.isArray(messages)) {
    const parsed = messages.flatMap((item) => {
      if (!isRecord(item) || typeof item.content !== "string" || !isModelRole(item.role)) {
        return [];
      }

      const toolCalls = parseToolCalls(item.toolCalls);

      if (item.toolCalls !== undefined && !toolCalls) {
        return [];
      }

      return [{
        content: item.content,
        name: optionalString(item.name),
        role: item.role,
        toolCallId: optionalString(item.toolCallId),
        toolCalls
      }];
    });

    if (parsed.length !== messages.length || parsed.length === 0) {
      return undefined;
    }

    return prependSystemPrompt(parsed, systemPrompt);
  }

  if (typeof message !== "string" || message.trim().length === 0) {
    return undefined;
  }

  return prependSystemPrompt([{ content: message, role: "user" }], systemPrompt);
}

function prependSystemPrompt(
  messages: AgentRunInput["messages"],
  systemPrompt: unknown
): AgentRunInput["messages"] {
  if (typeof systemPrompt !== "string" || systemPrompt.trim().length === 0) {
    return messages;
  }

  return messages[0]?.role === "system"
    ? messages
    : [{ content: systemPrompt, role: "system" }, ...messages];
}

function compatChatMetadata(value: Record<string, unknown>, authUserId?: string): JsonObject {
  const entries: Record<string, JsonValue> = isJsonObject(value.metadata) ? { ...value.metadata } : {};
  const userId = optionalString(value.userId) ?? optionalString(entries.userId) ?? authUserId;
  const personaId = optionalString(value.personaId);
  const promptTemplateId = optionalString(value.promptTemplateId);
  const responseFormat = optionalString(value.responseFormat);
  const responseSchema = optionalString(value.responseSchema);

  if (userId) {
    entries.userId = userId;
  }

  if (personaId) {
    entries.personaId = personaId;
  }

  if (promptTemplateId) {
    entries.promptTemplateId = promptTemplateId;
  }

  if (responseFormat) {
    entries.responseFormat = responseFormat;
  }

  if (responseSchema) {
    entries.responseSchema = responseSchema;
  }

  if (Array.isArray(value.mediaUrls)) {
    const mediaUrls = value.mediaUrls.filter(isJsonObject);

    if (mediaUrls.length === value.mediaUrls.length) {
      entries.mediaUrls = mediaUrls;
    }
  }

  return entries;
}

function isModelRole(value: unknown): value is AgentRunInput["messages"][number]["role"] {
  return value === "system" || value === "user" || value === "assistant" || value === "tool";
}

function parseToolCalls(value: unknown): AgentRunInput["messages"][number]["toolCalls"] | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!Array.isArray(value)) {
    return undefined;
  }

  if (value.length === 0) {
    return [];
  }

  const parsed = value.flatMap((item) => {
    if (
      !isRecord(item) ||
      typeof item.id !== "string" ||
      typeof item.name !== "string" ||
      !isJsonObject(item.arguments)
    ) {
      return [];
    }

    return [{
      arguments: item.arguments,
      id: item.id,
      name: item.name
    }];
  });

  return parsed.length === value.length ? parsed : undefined;
}

// ---------------------------------------------------------------------------
// Chat response builders
// ---------------------------------------------------------------------------

export function toCompatChatResponse(result: AgentRunResult) {
  const tokenUsage = compatTokenUsage(result.response.usage);
  const metadata = compatResponseMetadata(result);

  return {
    blockReason: typeof metadata.blockReason === "string" ? metadata.blockReason : null,
    content: result.response.output,
    durationMs: null,
    errorCode: null,
    errorMessage: null,
    grounded: typeof metadata.grounded === "boolean" ? metadata.grounded : null,
    metadata,
    model: result.response.model,
    success: true,
    tokenUsage,
    toolsUsed: result.toolsUsed ?? [],
    verifiedSourceCount: typeof metadata.verifiedSourceCount === "number" ? metadata.verifiedSourceCount : null
  };
}

export function toAdminRunSummary(run: AgentRunRecord) {
  return {
    id: run.id,
    inputPreview: previewText(run.input, 120),
    model: run.model,
    provider: run.provider,
    status: run.status
  };
}

function previewText(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength - 1)}…`;
}

export function toExtendedChatResponse(result: AgentRunResult) {
  return {
    ...toCompatChatResponse(result),
    agentSpec: result.agentSpec,
    contextWindow: result.contextWindow,
    fromCache: result.fromCache ?? false,
    response: result.response.output,
    runId: result.runId,
    usage: result.response.usage
  };
}

function compatTokenUsage(usage: AgentRunResult["response"]["usage"]) {
  if (!usage) {
    return null;
  }

  const promptTokens = usage.inputTokens ?? 0;
  const completionTokens = usage.outputTokens ?? 0;
  return {
    cachedContentTokens: usage.cachedInputTokens ?? null,
    completionTokens,
    promptTokens,
    thoughtsTokens: usage.reasoningTokens ?? null,
    toolUsePromptTokens: null,
    totalTokens: promptTokens + completionTokens,
    trafficType: null
  };
}

function compatResponseMetadata(result: AgentRunResult): JsonObject {
  return {
    ...(result.agentSpec
      ? {
        agentSpec: {
          confidence: result.agentSpec.confidence,
          matchedKeywords: [...result.agentSpec.matchedKeywords],
          name: result.agentSpec.name,
          toolNames: [...result.agentSpec.toolNames]
        }
      }
      : {}),
    ...(result.contextWindow
      ? {
        contextWindow: {
          budgetTokens: result.contextWindow.budgetTokens,
          estimatedTokens: result.contextWindow.estimatedTokens,
          removedCount: result.contextWindow.removedCount,
          summaryInserted: result.contextWindow.summaryInserted
        }
      }
      : {}),
    fromCache: result.fromCache ?? false,
    runId: result.runId
  };
}

// ---------------------------------------------------------------------------
// Agent error handling
// ---------------------------------------------------------------------------

export function sendAgentError(
  reply: { status(statusCode: number): { send(payload: ApiError): void } },
  error: unknown,
  responseMode: "extended" | "compat"
) {
  if (error instanceof GuardBlockedError) {
    return reply.status(403).send(chatErrorResponse({
      blockReason: error.message,
      code: error.code ?? "GUARD_BLOCKED",
      errorCode: error.code ?? "GUARD_BLOCKED",
      errorMessage: error.message,
      message: error.message
    }, responseMode) as ApiError);
  }

  if (error instanceof OutputGuardBlockedError) {
    return reply.status(422).send(chatErrorResponse({
      blockReason: error.message,
      code: error.code ?? "OUTPUT_GUARD_BLOCKED",
      errorCode: error.code ?? "OUTPUT_GUARD_BLOCKED",
      errorMessage: error.message,
      message: error.message
    }, responseMode) as ApiError);
  }

  if (error instanceof PlanExecutionError) {
    return reply.status(422).send(chatErrorResponse({
      code: error.code,
      errorCode: error.code,
      errorMessage: error.message,
      message: error.message
    }, responseMode) as ApiError);
  }

  if (error instanceof PlanValidationFailedError) {
    return reply.status(422).send(chatErrorResponse({
      code: "PLAN_VALIDATION_FAILED",
      errorCode: "PLAN_VALIDATION_FAILED",
      errorMessage: error.message,
      message: error.message
    }, responseMode) as ApiError);
  }

  const message = unwrapErrorMessage(error);
  return reply.status(500).send(chatErrorResponse({
    code: "AGENT_RUN_FAILED",
    errorCode: "AGENT_RUN_FAILED",
    errorMessage: message,
    message
  }, responseMode) as ApiError);
}

/**
 * Unwrap nested error causes (RetryExhaustedError → ModelProviderError →
 * underlying fetch error) so an operator sees the actual upstream error
 * message instead of the generic retry-exhausted wrapper.
 */
export function unwrapErrorMessage(error: unknown): string {
  if (!(error instanceof Error)) {
    return "Agent run failed";
  }

  const seen = new Set<unknown>();
  const segments: string[] = [];
  let current: unknown = error;

  while (current instanceof Error && !seen.has(current)) {
    seen.add(current);
    segments.push(current.message);
    current = (current as Error & { readonly cause?: unknown }).cause;
  }

  return segments.join(" — ");
}

function chatErrorResponse(
  error: {
    readonly blockReason?: string;
    readonly code: string;
    readonly errorCode: string;
    readonly errorMessage: string;
    readonly message: string;
  },
  responseMode: "extended" | "compat"
) {
  const response = {
    blockReason: error.blockReason ?? null,
    content: null,
    durationMs: null,
    errorCode: error.errorCode,
    errorMessage: error.errorMessage,
    grounded: null,
    metadata: {},
    model: null,
    success: false,
    tokenUsage: null,
    toolsUsed: [],
    verifiedSourceCount: null
  };

  return responseMode === "compat"
    ? response
    : {
      ...response,
      code: error.code,
      message: error.message
    };
}

// ---------------------------------------------------------------------------
// Other parsers
// ---------------------------------------------------------------------------

export function parseAgentSpecInput(value: unknown): ParseResult<AgentSpecInput> {
  if (!isRecord(value) || typeof value.name !== "string" || value.name.trim().length === 0) {
    return invalid("INVALID_AGENT_SPEC", "Body must include a non-empty name");
  }

  return {
    ok: true,
    value: {
      description: optionalString(value.description),
      enabled: optionalBoolean(value.enabled),
      independentExecution: optionalBoolean(value.independentExecution),
      keywords: optionalStringArray(value.keywords),
      mode:
        value.mode === "standard" || value.mode === "plan_execute" || value.mode === "react"
          ? value.mode
          : undefined,
      name: value.name,
      systemPrompt: optionalNullableString(value.systemPrompt),
      toolNames: optionalStringArray(value.toolNames)
    }
  };
}

export function parseRuntimeSettingInput(
  key: string,
  value: unknown
): ParseResult<{
  readonly category?: string;
  readonly description?: string | null;
  readonly key: string;
  readonly type?: RuntimeSettingType;
  readonly updatedBy?: string | null;
  readonly value: string;
}> {
  if (!isRecord(value) || typeof value.value !== "string") {
    return invalid("INVALID_RUNTIME_SETTING", "Body must include a string value");
  }

  return {
    ok: true,
    value: {
      category: optionalString(value.category),
      description: optionalNullableString(value.description),
      key,
      type: parseRuntimeSettingType(value.type),
      updatedBy: optionalNullableString(value.updatedBy),
      value: value.value
    }
  };
}

export function parseAuthCredentials(
  value: unknown,
  mode: "login" | "register"
): ParseResult<{ readonly email: string; readonly name: string; readonly password: string }> {
  if (!isRecord(value) || typeof value.email !== "string" || typeof value.password !== "string") {
    return invalid("INVALID_AUTH_REQUEST", "Body must include email and password strings");
  }

  if (value.email.trim().length === 0 || value.password.length === 0) {
    return invalid("INVALID_AUTH_REQUEST", "Email and password must not be blank");
  }

  if (mode === "register" && (typeof value.name !== "string" || value.name.trim().length === 0)) {
    return invalid("INVALID_AUTH_REQUEST", "Registration requires a non-empty name");
  }

  return {
    ok: true,
    value: {
      email: value.email,
      name: typeof value.name === "string" ? value.name : value.email,
      password: value.password
    }
  };
}

export function invalid(code: string, message: string): ParseResult<never> {
  return {
    error: { code, message },
    ok: false
  };
}

// ---------------------------------------------------------------------------
// Generic input util
// ---------------------------------------------------------------------------

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function isJsonObject(value: unknown): value is NonNullable<AgentRunInput["metadata"]> {
  if (!isRecord(value)) {
    return false;
  }

  return Object.values(value).every(isJsonValue);
}

export function isJsonValue(value: unknown): boolean {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return true;
  }

  if (typeof value === "number") {
    return Number.isFinite(value);
  }

  if (Array.isArray(value)) {
    return value.every(isJsonValue);
  }

  return isRecord(value) && Object.values(value).every(isJsonValue);
}

export function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function optionalNullableString(value: unknown): string | null | undefined {
  return value === null || typeof value === "string" ? value : undefined;
}

export function optionalBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

export function optionalStringArray(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  return value.filter((item): item is string => typeof item === "string");
}

export function parseRuntimeSettingType(value: unknown): RuntimeSettingType | undefined {
  return value === "string" || value === "number" || value === "boolean" || value === "json"
    ? value
    : undefined;
}

export function parseResponseLocales(raw: string | undefined): readonly string[] {
  const fallback = ["ko", "en"];
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return fallback;
  }
  const parsed = raw
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry === "ko" || entry === "en");
  return parsed.length > 0 ? Array.from(new Set(parsed)) : fallback;
}

// ---------------------------------------------------------------------------
// Multipart + SSE
// ---------------------------------------------------------------------------

export function parseMultipartBody(contentType: string | string[] | undefined, body: Buffer): JsonObject {
  const header = Array.isArray(contentType) ? contentType[0] : contentType;
  const boundary = header?.match(/boundary=(?:"([^"]+)"|([^;]+))/iu)?.slice(1).find(Boolean);

  if (!boundary) {
    throw new Error("Multipart boundary is required");
  }

  const fields: Record<string, string> = {};
  const files: JsonObject[] = [];
  const raw = body.toString("latin1");

  for (const part of raw.split(`--${boundary}`)) {
    if (part.trim().length === 0 || part.trim() === "--") {
      continue;
    }

    const headerEnd = part.indexOf("\r\n\r\n");

    if (headerEnd < 0) {
      continue;
    }

    const headers = part.slice(0, headerEnd).toLowerCase();
    const disposition = headers.match(/content-disposition:[^\r\n]+/iu)?.[0] ?? "";
    const name = disposition.match(/name="([^"]+)"/iu)?.[1];

    if (!name) {
      continue;
    }

    const filename = disposition.match(/filename="([^"]*)"/iu)?.[1];
    const contentTypeValue = headers.match(/content-type:\s*([^\r\n]+)/iu)?.[1]?.trim();
    const rawContent = part.slice(headerEnd + 4).replace(/\r\n--$/u, "").replace(/\r\n$/u, "");
    const content = Buffer.from(rawContent, "latin1");

    if (filename !== undefined) {
      files.push({
        contentBase64: content.toString("base64"),
        contentType: contentTypeValue ?? "application/octet-stream",
        fieldName: name,
        filename,
        size: content.byteLength
      });
      continue;
    }

    fields[name] = content.toString("utf8");
  }

  return { fields, files };
}

function sseData(value: string): string {
  return value.split(/\r?\n/u).map((line) => line.length > 0 ? line : " ").join("\ndata: ");
}

async function* toSseStream(
  events: ReturnType<AgentRuntime["stream"]>,
  responseMode: "extended" | "compat"
): AsyncIterable<string> {
  for await (const event of events) {
    if (event.type === "text-delta") {
      yield `event: message\ndata: ${sseData(event.text)}\n\n`;
      continue;
    }

    if (event.type === "tool-call") {
      if (responseMode === "compat") {
        yield `event: tool_start\ndata: ${sseData(event.toolCall.name)}\n\n`;
        continue;
      }

      yield `event: tool_call\ndata: ${sseData(JSON.stringify(event.toolCall))}\n\n`;
      continue;
    }

    if (event.type === "tool-result") {
      if (responseMode === "compat") {
        yield `event: tool_end\ndata: ${sseData(event.toolCall.name)}\n\n`;
      }

      continue;
    }

    if (event.type === "error") {
      yield `event: error\ndata: ${sseData(event.error.message)}\n\n`;
      continue;
    }

    if (event.type === "plan-generated") {
      yield `event: plan_generated\ndata: ${sseData(JSON.stringify({ plan: event.plan, runId: event.runId }))}\n\n`;
      continue;
    }

    if (event.type === "plan-step-executing") {
      yield `event: plan_step_executing\ndata: ${sseData(
        JSON.stringify({ description: event.description, runId: event.runId, stepIndex: event.stepIndex, tool: event.tool })
      )}\n\n`;
      continue;
    }

    if (event.type === "plan-step-result") {
      yield `event: plan_step_result\ndata: ${sseData(
        JSON.stringify({ runId: event.runId, stepIndex: event.stepIndex, success: event.success })
      )}\n\n`;
      continue;
    }

    if (event.type === "synthesis-started") {
      yield `event: synthesis_started\ndata: ${sseData(JSON.stringify({ runId: event.runId }))}\n\n`;
      continue;
    }

    if (responseMode === "compat") {
      yield "event: done\ndata:\n\n";
      continue;
    }

    yield `event: done\ndata: ${sseData(JSON.stringify({
      model: event.response.model,
      response: event.response.output,
      runId: event.runId,
      usage: event.response.usage
    }))}\n\n`;
  }
}

// ---------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------

export function toSpringPathTemplate(path: string): string {
  return path.replace(/:([A-Za-z0-9_]+)/gu, "{$1}");
}

export function applyCompatWebContractHeaders(
  path: string,
  requestIdHeader: string | string[] | undefined,
  reply: {
    header(name: string, value: string): unknown;
  }
): void {
  reply.header("X-Request-ID", headerValue(requestIdHeader)?.trim() || randomUUID());
  reply.header("X-Content-Type-Options", "nosniff");
  reply.header("X-Frame-Options", "DENY");
  reply.header("Content-Security-Policy", isSwaggerPath(path)
    ? "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'"
    : "default-src 'self'");
  reply.header("X-XSS-Protection", "0");
  reply.header("Referrer-Policy", "strict-origin-when-cross-origin");
  reply.header("Strict-Transport-Security", "max-age=31536000; includeSubDomains; preload");
  reply.header("Permissions-Policy", "geolocation=(), camera=(), microphone=(), payment=()");
  reply.header("X-Muse-Api-Version", currentCompatApiVersion());
  reply.header("X-Muse-Api-Supported-Versions", supportedCompatApiVersions().join(","));

  if (isSensitivePath(path)) {
    reply.header("Cache-Control", "no-store");
  }
}

export function applyCorsHeaders(
  options: CorsOptions | undefined,
  originHeader: string | string[] | undefined,
  reply: {
    header(name: string, value: string): unknown;
  }
): void {
  if (!options) {
    return;
  }

  const origin = headerValue(originHeader)?.trim();
  const allowedOrigin = allowedCorsOrigin(origin, options.allowedOrigins ?? defaultCorsOrigins());

  if (!allowedOrigin) {
    return;
  }

  reply.header("Access-Control-Allow-Origin", allowedOrigin);
  reply.header("Vary", "Origin");
  reply.header("Access-Control-Allow-Methods", (options.allowedMethods ?? defaultCorsMethods()).join(","));
  reply.header("Access-Control-Allow-Headers", (options.allowedHeaders ?? defaultCorsHeaders()).join(","));

  if (options.allowCredentials) {
    reply.header("Access-Control-Allow-Credentials", "true");
  }

  if (options.maxAgeSeconds !== undefined) {
    reply.header("Access-Control-Max-Age", String(Math.max(0, Math.trunc(options.maxAgeSeconds))));
  }
}

function allowedCorsOrigin(origin: string | undefined, allowedOrigins: readonly string[]): string | undefined {
  if (!origin) {
    return undefined;
  }

  return allowedOrigins.includes("*") || allowedOrigins.includes(origin) ? origin : undefined;
}

function defaultCorsOrigins(): readonly string[] {
  return ["http://127.0.0.1:5173", "http://localhost:5173"];
}

function defaultCorsMethods(): readonly string[] {
  return ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"];
}

function defaultCorsHeaders(): readonly string[] {
  return ["authorization", "content-type", "x-request-id", "x-muse-api-version"];
}

export function currentCompatApiVersion(): string {
  return "1";
}

export function supportedCompatApiVersions(): readonly string[] {
  return [currentCompatApiVersion()];
}

function isSensitivePath(path: string): boolean {
  return path === "/api/chat"
    || path.startsWith("/api/chat/")
    || path === "/api/auth"
    || path.startsWith("/api/auth/");
}

function isSwaggerPath(path: string): boolean {
  return path.startsWith("/swagger-ui") || path.startsWith("/v3/api-docs") || path.startsWith("/webjars");
}

export function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export function routeMethods(method: string | readonly string[]): readonly string[] {
  return typeof method === "string" ? [method] : method;
}

export function createOpenApiDocument(apiRouteMethods: ReadonlyMap<string, ReadonlySet<string>>): JsonObject {
  return {
    info: {
      title: "Muse API",
      version: "0.0.0"
    },
    openapi: "3.1.0",
    paths: Object.fromEntries(
      [...apiRouteMethods.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([path, methods]) => [
          path,
          Object.fromEntries(
            [...methods]
              .filter((method) => method !== "head" && method !== "options")
              .sort()
              .map((method) => [
                method,
                {
                  responses: {
                    "200": {
                      description: "OK"
                    }
                  },
                  summary: `${method.toUpperCase()} ${path}`
                }
              ])
          )
        ])
    )
  };
}

export function isPublicRequest(method: string, url: string): boolean {
  const path = url.split("?")[0] ?? url;
  return (
    path === "/health" ||
    path === "/spec" ||
    path === "/v3/api-docs" ||
    path === "/api/openapi.json" ||
    path === "/.well-known/agent-card.json" ||
    path === "/api/muse/runtime" ||
    path === "/api/muse/loopback" ||
    (method === "POST" && (
      path === "/auth/login" ||
      path === "/auth/register" ||
      path === "/api/auth/login" ||
      path === "/api/auth/register" ||
      path === "/api/error-report"
    ))
  );
}

// ---------------------------------------------------------------------------
// Auth identity
// ---------------------------------------------------------------------------

export function attachAuthIdentity(request: unknown, identity: AuthIdentity | undefined): void {
  (request as { auth?: AuthIdentity }).auth = identity;
}

export function getAuthIdentity(request: unknown): AuthIdentity | undefined {
  return (request as { auth?: AuthIdentity }).auth;
}

export function toLoginResponse(login: LoginResult) {
  return {
    expiresAt: login.expiresAt.toISOString(),
    token: login.token,
    user: login.user
  };
}

/**
 * Per-route auth guard. Returns true to continue, or writes a 401 reply
 * and returns false. When `authEnabled` is false (the personal-use
 * default), every request passes — there's no separate role tier in
 * this 1-user codebase. Only the presence of an identity is checked
 * when auth is enabled.
 *
 * Was previously named `authorizeAdmin`; the "Admin" suffix was Reactor
 * multi-tenant residue (no admin role exists here).
 */
export function requireAuthenticated(
  request: unknown,
  reply: { status(statusCode: number): { send(payload: unknown): void } },
  authEnabled: boolean
): boolean {
  if (!authEnabled) {
    return true;
  }

  if (getAuthIdentity(request)) {
    return true;
  }

  reply.status(401).send({
    error: "인증이 필요합니다",
    timestamp: new Date().toISOString()
  });
  return false;
}
