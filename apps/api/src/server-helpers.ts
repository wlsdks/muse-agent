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
import {
  buildModelRequestWithWebSearch,
  guardAgainstUnbackedActionClaim,
  type AgentRunInput
} from "@muse/agent-core";
import { gateChatAnswerGrounding } from "@muse/recall";
import type { AgentSpecInput } from "@muse/agent-specs";
import type { RuntimeSettingType } from "@muse/runtime-settings";
import type { JsonObject, JsonValue } from "@muse/shared";

import type { ServerOptions } from "./server.js";

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

  const agentRuntime = options.agentRuntime;
  const parsed = parseAgentRunInput(body, options.defaultModel ?? "default", authUserId);

  if (!parsed.ok) {
    return reply.status(400).send(parsed.error);
  }

  const runInput = await applyWebSearchPolicy(parsed.value, body, options);

  try {
    const result = await agentRuntime.run(runInput);
    // Grounding parity with the CLI chat surface: gate the raw agent output before
    // it leaves, so a fabricated/uncited claim is dropped by code (fabrication=0)
    // while a properly grounded answer passes UNCHANGED. Evidence is what THIS turn
    // produced — the read-tool outputs / injected inbox in `groundingSources`.
    const question = lastUserQuestion(runInput.messages);
    const gate = gateChatAnswerGrounding({
      answer: result.response.output,
      evidence: [...(result.groundingSources ?? [])],
      question
    });
    const grounded = gate.gated
      ? { ...result, response: { ...result.response, output: gate.answer } }
      : result;
    // Honest-action gate (channel-reply parity, `honest-action-guard.ts`): the
    // model can claim a completed state-changing action ("일정을 등록했습니다")
    // while NO actuator tool ran. Bound to one clean-history retry (mirrors the
    // CLI's `runResistingFalseDone`); if the retry also fails to act, the claim
    // is replaced with a short honest notice rather than reaching the user.
    const honest = await guardAgainstUnbackedActionClaim({
      firstResult: grounded,
      query: question,
      retry: () => agentRuntime.run({ ...runInput, messages: cleanRetryMessages(runInput.messages) })
    });
    // A RECOVERED retry produces text the first gate never saw, so it must
    // re-enter the citation gate — otherwise the retry is a hole straight
    // through fabrication=0. Unchanged answers keep the original verdict.
    const finalGate = honest === grounded
      ? gate
      : gateChatAnswerGrounding({
          answer: honest.response.output,
          evidence: [...(honest.groundingSources ?? [])],
          question
        });
    const finalResult = finalGate.gated && finalGate.answer !== honest.response.output
      ? { ...honest, response: { ...honest.response, output: finalGate.answer } }
      : honest;
    return responseMode === "compat"
      ? toCompatChatResponse(finalResult, finalGate)
      : toExtendedChatResponse(finalResult, finalGate);
  } catch (error) {
    return sendAgentError(reply, error, responseMode);
  }
}

/** A CLEAN-history retry payload — system message(s) + only the latest user
 *  turn — so a poisoned prior "done" claim in history can't make the model
 *  skip the tool again (mirrors the CLI's `runResistingFalseDone` retry). */
function cleanRetryMessages(messages: AgentRunInput["messages"]): AgentRunInput["messages"] {
  const systemMessages = messages.filter((message) => message.role === "system");
  const lastUser = [...messages].reverse().find((message) => message.role === "user");
  return lastUser ? [...systemMessages, lastUser] : messages;
}

/** The user's own last turn — the question the grounding gate scores the answer
 *  against (a chat body always resolves to at least one user message). */
function lastUserQuestion(messages: AgentRunInput["messages"]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message?.role === "user" && typeof message.content === "string") {
      return message.content;
    }
  }
  return "";
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

  const runInput = await applyWebSearchPolicy(parsed.value, body, options);

  reply.header("content-type", "text/event-stream; charset=utf-8");
  reply.header("cache-control", "no-cache");
  // streamRawDeltas satisfies the AgentRunInput contract HERE: toSseStream
  // passes every delta through the live citation filter, and the grounding
  // frame it emits post-stream is the authoritative gated answer.
  return reply.send(
    Readable.from(
      toSseStream(options.agentRuntime.stream({ ...runInput, streamRawDeltas: true }), responseMode, {
        question: lastUserQuestion(runInput.messages)
      })
    )
  );
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
// Web search policy injection
// ---------------------------------------------------------------------------

/**
 * Applies web search policy to the run input before it reaches the agent
 * runtime. Reads the per-request override from `body.metadata.tools.web_search`
 * and the server-side settings from `options.runtimeSettings` (with TTL cache).
 * Defaults to enabled=true, maxUses=5 when no settings store is wired.
 */
async function applyWebSearchPolicy(
  runInput: AgentRunInput,
  body: unknown,
  options: ServerOptions
): Promise<AgentRunInput> {
  const override = extractWebSearchOverride(body);
  const runtimeSettings = options.runtimeSettings;
  const webSearchSettings = runtimeSettings
    ? {
      enabled: await runtimeSettings.getBoolean("webSearch.enabled", true),
      maxUses: await runtimeSettings.getNumber("webSearch.maxUses", 5)
    }
    : { enabled: true, maxUses: 5 };
  const modelRequest = {
    messages: runInput.messages,
    metadata: runInput.metadata,
    model: runInput.model ?? "default"
  };
  const wrapped = buildModelRequestWithWebSearch(modelRequest, {
    env: process.env as Record<string, string | undefined>,
    override,
    settings: { webSearch: webSearchSettings }
  });
  return { ...runInput, metadata: wrapped.metadata };
}

function extractWebSearchOverride(body: unknown): boolean | undefined {
  if (!isRecord(body)) return undefined;
  const meta = body.metadata;
  if (!isRecord(meta)) return undefined;
  const tools = meta.tools;
  if (!isRecord(tools)) return undefined;
  const flag = tools.web_search;
  return typeof flag === "boolean" ? flag : undefined;
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
// Chat response builders — implementation in `./server-chat-response-builders.js`.
// Re-exported here so the existing import sites keep working.
// ---------------------------------------------------------------------------
import {
  toCompatChatResponse,
  toExtendedChatResponse
} from "./server-chat-response-builders.js";

export {
  toAdminRunSummary
} from "./server-chat-response-builders.js";

// ---------------------------------------------------------------------------
// Agent error handling — implementation in `./server-agent-error.js`.
// Re-exported here so the existing import sites keep working.
// ---------------------------------------------------------------------------
import { sendAgentError } from "./server-agent-error.js";

export { unwrapErrorMessage } from "./server-agent-error.js";

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

function invalid(code: string, message: string): ParseResult<never> {
  return {
    error: { code, message },
    ok: false
  };
}

// ---------------------------------------------------------------------------
// Generic input util — implementation in `./server-input-utils.js`.
// Imported here for the rest of `server-helpers.ts` to use AND
// re-exported so the existing import sites across the API package
// keep working without import-site edits.
// ---------------------------------------------------------------------------
import {
  isJsonObject,
  isRecord,
  optionalBoolean,
  optionalNullableString,
  optionalString,
  optionalStringArray,
  parseResponseLocales,
  parseRuntimeSettingType
} from "./server-input-utils.js";

export {
  isRecord,
  parseResponseLocales
};

// ---------------------------------------------------------------------------
// Multipart + SSE — implementation in `./server-multipart-sse.js`.
// Re-exported here so the existing import sites keep working.
// ---------------------------------------------------------------------------
import { toSseStream } from "./server-multipart-sse.js";

export { parseMultipartBody } from "./server-multipart-sse.js";

// ---------------------------------------------------------------------------
// HTTP plumbing — implementation in `./server-http-plumbing.js`. Re-exported
// here so the existing import sites across the API package keep working.
// ---------------------------------------------------------------------------
export {
  applyCompatWebContractHeaders,
  applyCorsHeaders,
  createOpenApiDocument,
  headerValue,
  isPublicRequest,
  routeMethods,
  supportedCompatApiVersions,
  toSpringPathTemplate
} from "./server-http-plumbing.js";

// ---------------------------------------------------------------------------
// Auth identity
// ---------------------------------------------------------------------------

export {
  attachAuthIdentity,
  getAuthIdentity,
  requireAuthenticated,
  toLoginResponse
} from "./server-auth-helpers.js";
