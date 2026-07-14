/**
 * Muse compat user-memory + auth-identity helpers extracted from
 * compat-routes.ts.
 *
 * Each store helper dispatches to options.userMemoryStore (the configured
 * @muse/memory UserMemoryStore) when present, otherwise falls back to the
 * file-private compat state via getStateUserMemory.
 */

import { extractBearerToken, type AuthIdentity } from "@muse/auth";
import type { UserMemory } from "@muse/memory";
import type { FastifyReply, FastifyRequest } from "fastify";
import {
  errorResponse,
  getStateUserMemory,
  nowIso,
  readBodyString,
  toBody,
  type CompatibilityRouteOptions
} from "./compat-routes.js";
import { readRouteParam } from "./compat-parsers.js";

export async function updateUserMemory(
  request: FastifyRequest,
  reply: FastifyReply,
  key: "facts" | "preferences",
  options?: CompatibilityRouteOptions
) {
  const userId = readRouteParam(request, "userId");

  if (!userId) {
    return reply.status(400).send(errorResponse("Invalid userId"));
  }

  const body = toBody(request.body);
  const itemKey = readBodyString(body, "key")?.trim();
  const itemValue = readBodyString(body, "value")?.trim();

  if (!itemKey || !itemValue) {
    return reply.status(400).send(errorResponse("Body must include non-empty key and value"));
  }

  if (options?.userMemoryStore) {
    await (key === "facts"
      ? options.userMemoryStore.upsertFact(userId, itemKey, itemValue)
      : options.userMemoryStore.upsertPreference(userId, itemKey, itemValue));
    return { updated: true };
  }

  const store = getStateUserMemory();
  const existing = store.get(userId) ?? {
    facts: {},
    preferences: {},
    recentTopics: [],
    updatedAt: nowIso()
  };
  const updated = {
    facts: key === "facts" ? { ...existing.facts, [itemKey]: itemValue } : existing.facts,
    preferences: key === "preferences" ? { ...existing.preferences, [itemKey]: itemValue } : existing.preferences,
    recentTopics: existing.recentTopics,
    updatedAt: nowIso()
  };
  store.set(userId, updated);
  return { updated: true };
}

export async function readUserMemory(
  options: CompatibilityRouteOptions,
  userId: string
): Promise<UserMemory | {
  readonly facts: Record<string, string>;
  readonly preferences: Record<string, string>;
  readonly recentTopics: string[];
  readonly updatedAt: string;
} | undefined> {
  return await options.userMemoryStore?.findByUserId(userId) ?? getStateUserMemory().get(userId);
}

export async function deleteUserMemory(options: CompatibilityRouteOptions, userId: string): Promise<void> {
  await options.userMemoryStore?.deleteByUserId(userId);
  getStateUserMemory().delete(userId);
}

/**
 * Authorise a `/api/user-memory/:userId` request.
 *
 * When `options.authService` is undefined (the personal-use default with
 * auth disabled), every request to a non-empty / non-`anonymous` userId
 * is allowed — there's only one user. Previously this branch returned
 * false because `currentAuthIdentity` is also undefined, which 403'd
 * every personal-use call.
 *
 * When auth is configured, the caller must be authenticated AND target
 * their own userId.
 */
export async function canAccessUserMemory(
  request: FastifyRequest,
  options: CompatibilityRouteOptions,
  userId: string
): Promise<boolean> {
  if (userId.trim().length === 0 || userId.toLowerCase() === "anonymous") {
    return false;
  }

  if (!options.authService) {
    return true;
  }

  const identity = await currentAuthIdentity(request, options);
  return Boolean(identity?.userId && identity.userId === userId && identity.userId.toLowerCase() !== "anonymous");
}

async function currentAuthIdentity(
  request: FastifyRequest & { readonly auth?: AuthIdentity },
  options: CompatibilityRouteOptions
): Promise<AuthIdentity | undefined> {
  return request.auth
    ?? await options.authService?.authenticateBearer(extractBearerToken(request.headers.authorization));
}

export function toUserMemoryResponse(memory: {
  readonly facts: Record<string, string>;
  readonly preferences: Record<string, string>;
  readonly recentTopics: readonly string[];
  readonly updatedAt: string | Date;
}) {
  return {
    facts: memory.facts,
    preferences: memory.preferences,
    recentTopics: [...memory.recentTopics],
    updatedAt: memory.updatedAt instanceof Date ? memory.updatedAt.toISOString() : memory.updatedAt
  };
}

export function userForbidden(reply: FastifyReply) {
  return reply.status(403).send({
    error: "이 사용자 메모리에 접근할 권한이 없습니다",
    timestamp: nowIso()
  });
}

export function userMemoryNotFound(reply: FastifyReply, userId: string) {
  return reply.status(404).send({
    error: `User memory not found: ${userId}`,
    timestamp: nowIso()
  });
}
