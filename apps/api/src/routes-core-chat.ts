// Health/spec/openapi + chat (incl. rate-limit) registrars — split out of server-routes.ts (domain cohesion).

import { parseBoolean, resolveActionLogFile, resolvePendingApprovalsFile } from "@muse/autoconfigure";
import { isRecord } from "@muse/shared";
import type { FastifyInstance } from "fastify";

import { serverBuildId, serverStartedAtIso } from "./build-info.js";
import { denyChatApproval } from "./chat-approval-deny.js";
import { executeChatApproval } from "./chat-approval-execute.js";
import { ChatRateLimiter, clientKeyFromRequest } from "./chat-rate-limiter.js";
import { readRouteParam } from "./compat-parsers.js";
import {
  createOpenApiDocument,
  getAuthIdentity,
  runChat,
  runChatStream,
  runMultipartChat
} from "./server-helpers.js";
import type { ServerOptions } from "./server.js";

export function registerCoreRoutes(
  server: FastifyInstance,
  apiRouteMethods: ReadonlyMap<string, ReadonlySet<string>>
): void {
  const healthPayload = {
    pid: process.pid,
    service: "muse-api",
    startedAtIso: serverStartedAtIso(),
    status: "ok",
    version: serverBuildId()
  };
  server.get("/health", async () => healthPayload);
  server.get("/api/health", async () => healthPayload);

  server.get("/spec", async () => ({
    agentCore: "model-agnostic",
    database: "postgresql",
    runner: "rust",
    server: "fastify"
  }));
  server.get("/v3/api-docs", async () => createOpenApiDocument(apiRouteMethods));
  server.get("/api/openapi.json", async () => createOpenApiDocument(apiRouteMethods));
}

export function registerChatRoutes(server: FastifyInstance, options: ServerOptions): void {
  const rateLimiter = options.chatRateLimiter ?? buildDefaultChatRateLimiter();
  const enforce = (request: { ip?: string }, reply: { status(code: number): { send(body: unknown): unknown }; header(name: string, value: string): unknown }): boolean => {
    if (rateLimiter === undefined) return true;
    const verdict = rateLimiter.consume(clientKeyFromRequest(request));
    if (verdict.allowed) return true;
    reply.header("Retry-After", String(verdict.retryAfterSeconds ?? 60));
    reply.status(429).send({
      error: "rate limit exceeded — too many chat requests from this IP. Try again shortly.",
      retryAfterSeconds: verdict.retryAfterSeconds ?? 60
    });
    return false;
  };

  server.post("/chat", async (request, reply) => {
    if (!enforce(request, reply)) return reply;
    return runChat(request.body, reply, options, "extended", getAuthIdentity(request)?.userId);
  });
  server.post("/api/chat", async (request, reply) => {
    if (!enforce(request, reply)) return reply;
    return runChat(request.body, reply, options, "compat", getAuthIdentity(request)?.userId);
  });
  server.post("/chat/stream", async (request, reply) => {
    if (!enforce(request, reply)) return reply;
    return runChatStream(request.body, reply, options, "extended", getAuthIdentity(request)?.userId);
  });
  server.post("/api/chat/stream", async (request, reply) => {
    if (!enforce(request, reply)) return reply;
    return runChatStream(request.body, reply, options, "compat", getAuthIdentity(request)?.userId);
  });
  server.post("/api/chat/multipart", async (request, reply) => {
    if (!enforce(request, reply)) return reply;
    return runMultipartChat(request.body, reply, options, getAuthIdentity(request)?.userId);
  });
  // Confirm-execute for a draft-first chat write (outbound-safety): the ONLY
  // path that runs a captured write/execute action, and only after the user
  // POSTs its id. Fail paths (unknown/expired id, no resolver, unknown tool)
  // execute nothing; a successful run is cleared so a replay 404s.
  server.post("/api/chat/approvals/:id/approve", async (request, reply) => {
    if (!enforce(request, reply)) return reply;
    const id = readRouteParam(request, "id");
    const requestUserId = getAuthIdentity(request)?.userId;
    if (!id) {
      return reply.status(400).send({
        code: "INVALID_APPROVAL_ID",
        message: "Approval id is required"
      });
    }
    const result = await executeChatApproval({
      id,
      pendingFile: resolvePendingApprovalsFile(options.env ?? {}),
      ...(requestUserId ? { requestUserId } : {}),
      ...(options.approvalToolResolver ? { resolveTool: options.approvalToolResolver } : {})
    });
    return reply.status(result.statusCode).send(result.body);
  });
  // Confirm-deny for a draft-first chat write (outbound-safety fail-close
  // symmetry with approve): clears the pending entry and records a rationale-
  // bearing `refused` action-log entry, but never executes the tool — there is
  // no tool resolver on this path at all.
  server.post("/api/chat/approvals/:id/deny", async (request, reply) => {
    if (!enforce(request, reply)) return reply;
    const params = isRecord(request.params) ? request.params : {};
    const id = typeof params.id === "string" ? params.id : "";
    const requestUserId = getAuthIdentity(request)?.userId;
    const result = await denyChatApproval({
      actionLogFile: resolveActionLogFile(options.env ?? {}),
      id,
      pendingFile: resolvePendingApprovalsFile(options.env ?? {}),
      ...(requestUserId ? { requestUserId } : {})
    });
    return reply.status(result.statusCode).send(result.body);
  });
}

// Strict parse, not Number.parseInt: a typo'd `60x` / unit-slip
// `30s` env value must NOT silently become the numeric prefix and
// install the wrong rate-limit capacity. Whole-token decimal int
// only; everything else → fallback 60.
export function parseChatRateLimitCapacity(raw: string | undefined, fallback = 60): number {
  if (typeof raw !== "string") return fallback;
  const trimmed = raw.trim();
  if (!/^[+-]?\d+$/u.test(trimmed)) return fallback;
  const parsed = Number(trimmed);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * `MUSE_RATE_LIMIT_CHAT_DISABLED` accepts every standard truthy
 * spelling (true / 1 / yes / on, case-insensitive, trimmed). The
 * pre-fix `=== "true"` check only honored the exact literal — an
 * operator setting `=1` or `=on` saw rate limiting silently stay
 * active. Defaults to "not disabled" on undefined / unrecognised
 * so a typo'd kill switch keeps the limiter enabled (fail-safe
 * direction for a security-adjacent flag).
 */
export function isChatRateLimitDisabled(raw: string | undefined): boolean {
  return parseBoolean(raw, false);
}

function buildDefaultChatRateLimiter(): ChatRateLimiter | undefined {
  if (isChatRateLimitDisabled(process.env.MUSE_RATE_LIMIT_CHAT_DISABLED)) {
    return undefined;
  }
  const capacity = parseChatRateLimitCapacity(process.env.MUSE_RATE_LIMIT_CHAT_PER_MINUTE);
  return new ChatRateLimiter({ capacity, windowMs: 60_000 });
}
