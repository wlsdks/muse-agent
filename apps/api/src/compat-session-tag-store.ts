/**
 * Reactor-compat session-tag store helpers extracted from
 * reactor-compat-routes.ts.
 *
 * Each helper dispatches to options.sessionTagStore (the configured
 * SessionTagStore) when present, otherwise falls back to the file-private
 * compat state via the getStateSessionTags accessor — a Map keyed by
 * sessionId pointing at an array of tag records.
 */

import type { SessionTag } from "@muse/runtime-state";
import type { FastifyRequest } from "fastify";
import {
  createRecord,
  getStateSessionTags,
  readAuthUserId,
  type CompatRecord,
  type ReactorCompatibilityRouteOptions
} from "./reactor-compat-routes.js";

export async function createSessionTag(
  options: ReactorCompatibilityRouteOptions,
  request: FastifyRequest,
  sessionId: string,
  label: string,
  comment: string | null
): Promise<CompatRecord> {
  if (options.sessionTagStore) {
    const tag = await options.sessionTagStore.create({
      comment,
      createdBy: readAuthUserId(request) ?? "admin",
      label,
      sessionId
    });

    return toSessionTagCompatRecord(tag);
  }

  const tag = createRecord(new Map(), {
    comment,
    label,
    sessionId
  }, "session_tag");
  const tags = getStateSessionTags().get(sessionId) ?? [];
  getStateSessionTags().set(sessionId, [...tags, tag]);
  return tag;
}

export async function listSessionTags(
  options: ReactorCompatibilityRouteOptions,
  sessionId: string
): Promise<readonly CompatRecord[]> {
  if (options.sessionTagStore) {
    const tags = await options.sessionTagStore.listBySession(sessionId);
    return tags.map(toSessionTagCompatRecord);
  }

  return getStateSessionTags().get(sessionId) ?? [];
}

export async function deleteSessionTag(
  options: ReactorCompatibilityRouteOptions,
  sessionId: string,
  tagId: string
): Promise<boolean> {
  if (options.sessionTagStore) {
    return options.sessionTagStore.delete(sessionId, tagId);
  }

  const tags = getStateSessionTags().get(sessionId) ?? [];
  const remaining = tags.filter((tag) => tag.id !== tagId);
  getStateSessionTags().set(sessionId, remaining);
  return remaining.length !== tags.length;
}

export async function deleteSessionTags(options: ReactorCompatibilityRouteOptions, sessionId: string): Promise<void> {
  if (options.sessionTagStore) {
    await options.sessionTagStore.deleteBySession(sessionId);
    return;
  }

  getStateSessionTags().delete(sessionId);
}

function toSessionTagCompatRecord(tag: SessionTag): CompatRecord {
  const createdAt = new Date(tag.createdAt).toISOString();

  return {
    comment: tag.comment ?? null,
    createdAt,
    id: tag.id,
    label: tag.label,
    sessionId: tag.sessionId,
    updatedAt: createdAt
  };
}
