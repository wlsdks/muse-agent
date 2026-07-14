/**
 * Muse compat session/run helpers extracted from
 * compat-routes.ts.
 *
 * Wraps options.historyStore — the AgentRunHistoryStore — into the response
 * shapes the admin and Muse compat session routes expect:
 *   - sessionDetail / compatSessionDetail (per-session detail with auth gating)
 *   - toSessionResponse (paginated list item)
 *   - exportSession (admin or compat JSON / Markdown export)
 *   - listAllRuns / listAllToolCalls (admin observability primitives)
 *   - summarizeUsers (recent-activity user list)
 */

import type { AgentRunRecord, ConversationMessageRecord, ToolCallRecord } from "@muse/runtime-state";
import type { JsonObject } from "@muse/shared";
import type { FastifyReply, FastifyRequest } from "fastify";
import {
  errorResponse,
  isRecord,
  nowIso,
  readAuthUserId,
  readQueryString,
  sanitizeFilename,
  type CompatibilityRouteOptions
} from "./compat-routes.js";
import { readRouteParam } from "./compat-parsers.js";

export async function sessionDetail(
  request: FastifyRequest,
  reply: FastifyReply,
  options: CompatibilityRouteOptions
) {
  const sessionId = readRouteParam(request, "sessionId");

  if (!sessionId) {
    return reply.status(400).send(errorResponse("Invalid sessionId"));
  }

  if (!options.historyStore) {
    return reply.status(404).send({
      code: "RUN_HISTORY_UNAVAILABLE",
      message: "Run history store is not configured"
    });
  }

  const run = await options.historyStore.findRun(sessionId);

  if (!run) {
    return reply.status(404).send({
      code: "SESSION_NOT_FOUND",
      message: `Session not found: ${sessionId}`
    });
  }

  const [messages, toolCalls] = await Promise.all([
    options.historyStore.listMessages(sessionId),
    options.historyStore.listToolCalls(sessionId)
  ]);
  return { messages, run, session: run, toolCalls };
}

export async function compatSessionDetail(
  request: FastifyRequest,
  reply: FastifyReply,
  options: CompatibilityRouteOptions
) {
  const sessionId = readRouteParam(request, "sessionId");

  if (!sessionId) {
    return reply.status(400).send(errorResponse("Invalid sessionId"));
  }
  const userId = readAuthUserId(request);

  if (!userId) {
    return reply.status(401).send(errorResponse("인증이 필요합니다"));
  }

  if (!options.historyStore) {
    return reply.status(404).send(errorResponse("Run history store is not configured"));
  }

  const run = await options.historyStore.findRun(sessionId);

  if (!run) {
    return reply.status(404).send(errorResponse(`Session not found: ${sessionId}`));
  }

  const messages = await options.historyStore.listMessages(sessionId);
  return {
    messages: toSessionMessages(messages, run),
    sessionId: run.id
  };
}

export async function toSessionResponse(
  run: AgentRunRecord,
  options: CompatibilityRouteOptions
): Promise<JsonObject> {
  const messages = options.historyStore ? await options.historyStore.listMessages(run.id) : [];
  const synthesizedMessages = toSessionMessages(messages, run);

  return {
    lastActivity: run.updatedAt.getTime(),
    messageCount: synthesizedMessages.length,
    preview: run.input.slice(0, 120),
    sessionId: run.id
  };
}

function toSessionMessages(
  messages: readonly unknown[],
  run?: AgentRunRecord
): readonly JsonObject[] {
  if (messages.length > 0) {
    return messages
      .filter((message): message is ConversationMessageRecord => isRecord(message))
      .map((message) => ({
        content: message.content,
        role: message.role,
        timestamp: message.createdAt.getTime()
      }));
  }

  if (!run) {
    return [];
  }

  return [
    {
      content: run.input,
      role: "user",
      timestamp: run.createdAt.getTime()
    },
    ...(run.output
      ? [{
          content: run.output,
          role: "assistant",
          timestamp: (run.completedAt ?? run.updatedAt).getTime()
        }]
      : [])
  ];
}

export async function exportSession(
  request: FastifyRequest,
  reply: FastifyReply,
  options: CompatibilityRouteOptions,
  mode: "admin" | "compat" = "admin"
) {
  const detail = mode === "compat"
    ? await compatSessionDetail(request, reply, options)
    : await sessionDetail(request, reply, options);
  const sessionId = readRouteParam(request, "sessionId");

  if (!sessionId) {
    return reply.status(400).send(errorResponse("Invalid sessionId"));
  }

  if (!isRecord(detail) || !("messages" in detail)) {
    return detail;
  }

  const format = readQueryString(request, "format")?.toLowerCase();

  if (format === "markdown" || format === "md") {
    const messages = Array.isArray(detail.messages) ? detail.messages : [];
    reply.header("content-disposition", `attachment; filename="${sanitizeFilename(sessionId)}.md"`);
    reply.header("content-type", "text/markdown; charset=utf-8");

    if (mode === "compat") {
      return [
        `# Conversation: ${sessionId}`,
        "",
        ...messages.flatMap((message) => {
          if (!isRecord(message)) {
            return [];
          }

          return [`## ${String(message.role ?? "message")}`, "", String(message.content ?? ""), ""];
        })
      ].join("\n");
    }

    return [
      `# Session: ${sessionId}`,
      "",
      `Exported at: ${nowIso()}`,
      "",
      ...messages.flatMap((message) => {
        if (!isRecord(message)) {
          return [];
        }

        return [`## ${String(message.role ?? "message")}`, "", String(message.content ?? ""), ""];
      })
    ].join("\n");
  }

  reply.header(
    "content-disposition",
    `attachment; filename="${sanitizeFilename(sessionId)}.json"`
  );

  return {
    exportedAt: mode === "compat" ? Date.now() : nowIso(),
    ...detail,
    sessionId
  };
}

export async function listAllRuns(
  options: CompatibilityRouteOptions,
  listOptions: { readonly limit?: number; readonly offset?: number } = {}
): Promise<readonly AgentRunRecord[]> {
  return options.historyStore?.listRuns({
    limit: listOptions.limit === undefined ? undefined : Math.max(0, listOptions.limit),
    offset: listOptions.offset === undefined ? undefined : Math.max(0, listOptions.offset)
  }) ?? [];
}

export async function listAllToolCalls(options: CompatibilityRouteOptions): Promise<readonly ToolCallRecord[]> {
  const runs = await listAllRuns(options);
  const toolCalls: ToolCallRecord[] = [];

  for (const run of runs) {
    const calls = await (options.historyStore?.listToolCalls(run.id) ?? []);
    toolCalls.push(...calls.map((call) => ({ ...call, runId: run.id })));
  }

  return toolCalls;
}
