/**
 * Reactor-compat Slack FAQ registration + ingest/probe/dry-run + stats
 * helpers extracted from reactor-compat-routes.ts.
 *
 * Each store helper dispatches to options.slackPersistence?.faqStore (a
 * ChannelFaqRegistration store) when configured, otherwise falls back to
 * file-private compat state via getStateSlackFaq /
 * getStateSlackFaqEvents accessors.
 */

import type { ChannelFaqRegistration } from "@muse/integrations";
import type { JsonObject } from "@muse/shared";
import type { FastifyReply, FastifyRequest } from "fastify";
import { listDocuments } from "./compat-document-store.js";
import {
  createRecord,
  dateOrNull,
  dateOrUndefined,
  findCompatRecord,
  getAllStateSlackFaqEvents,
  getStateSlackFaq,
  getStateSlackFaqEvents,
  jsonObjectField,
  nowIso,
  nullableNumberResponse,
  nullableStringResponse,
  readBodyString,
  readBoolean,
  readNumber,
  stringField,
  toBody,
  type CompatRecord,
  type ReactorCompatibilityRouteOptions
} from "./reactor-compat-routes.js";

export function validateSlackFaqChannelId(channelId: string | undefined, reply: FastifyReply) {
  if (!channelId || channelId.trim().length === 0 || channelId.length > 64) {
    return reply.status(400).send({ error: "channelId 가 유효하지 않습니다" });
  }

  return undefined;
}

export function slackFaqNotFound(reply: FastifyReply, channelId: string) {
  return reply.status(404).send({ error: `등록되지 않은 채널: ${channelId}` });
}

export function slackFaqAutoReplyMode(value: string | undefined): string {
  const normalized = value?.trim().toUpperCase();
  return normalized === "ALWAYS" || normalized === "OFF" ? normalized : "MENTION";
}

export async function saveSlackFaqRegistration(
  options: ReactorCompatibilityRouteOptions,
  record: JsonObject
): Promise<JsonObject> {
  if (options.slackPersistence?.faqStore) {
    const saved = await options.slackPersistence.faqStore.save(compatToSlackFaqRegistration(record));
    return slackFaqRegistrationToCompat(saved);
  }

  return createRecord(getStateSlackFaq(), record, "slack_faq");
}

export async function listSlackFaqRegistrations(options: ReactorCompatibilityRouteOptions): Promise<readonly JsonObject[]> {
  if (options.slackPersistence?.faqStore) {
    const registrations = await options.slackPersistence.faqStore.list();
    return registrations.map(slackFaqRegistrationToCompat);
  }

  return [...getStateSlackFaq().values()];
}

export async function getSlackFaqRegistration(
  options: ReactorCompatibilityRouteOptions,
  channelId: string
): Promise<JsonObject | undefined> {
  if (options.slackPersistence?.faqStore) {
    const registration = await options.slackPersistence.faqStore.get(channelId);
    return registration ? slackFaqRegistrationToCompat(registration) : undefined;
  }

  return findCompatRecord(getStateSlackFaq(), channelId);
}

export async function deleteSlackFaqRegistration(options: ReactorCompatibilityRouteOptions, channelId: string): Promise<boolean> {
  if (options.slackPersistence?.faqStore) {
    return options.slackPersistence.faqStore.delete(channelId);
  }

  return getStateSlackFaq().delete(channelId);
}

async function updateSlackFaqIngestResult(
  options: ReactorCompatibilityRouteOptions,
  channelId: string,
  status: "OK" | "FAILED" | "RUNNING",
  messageCount: number | null,
  chunkCount: number | null,
  error: string | null
): Promise<JsonObject | undefined> {
  if (options.slackPersistence?.faqStore) {
    const updated = await options.slackPersistence.faqStore.updateIngestResult({
      channelId,
      chunkCount,
      error,
      messageCount,
      status
    });
    return updated ? slackFaqRegistrationToCompat(updated) : undefined;
  }

  const existing = findCompatRecord(getStateSlackFaq(), channelId);

  if (!existing) {
    return undefined;
  }

  return createRecord(getStateSlackFaq(), {
    ...existing,
    lastChunkCount: chunkCount,
    lastError: error,
    lastIngestedAt: nowIso(),
    lastMessageCount: messageCount,
    lastStatus: status
  }, "slack_faq");
}

function compatToSlackFaqRegistration(record: JsonObject): ChannelFaqRegistration {
  return {
    autoReplyMode: slackFaqAutoReplyMode(stringField(record.autoReplyMode, "MENTION")) as "MENTION" | "ALWAYS" | "OFF",
    channelId: stringField(record.channelId, stringField(record.id, "")),
    channelName: nullableStringResponse(record.channelName),
    confidenceThreshold: readNumber(record.confidenceThreshold, 0.8),
    daysBack: readNumber(record.daysBack, 30),
    enabled: readBoolean(record.enabled, true),
    lastChunkCount: nullableNumberResponse(record.lastChunkCount),
    lastError: nullableStringResponse(record.lastError),
    lastIngestedAt: dateOrNull(record.lastIngestedAt),
    lastMessageCount: nullableNumberResponse(record.lastMessageCount),
    lastStatus: slackFaqIngestStatusValue(record.lastStatus),
    reIngestIntervalHours: readNumber(record.reIngestIntervalHours, 24),
    registeredAt: dateOrUndefined(record.registeredAt),
    registeredBy: nullableStringResponse(record.registeredBy),
    updatedAt: dateOrUndefined(record.updatedAt)
  };
}

function slackFaqRegistrationToCompat(registration: ChannelFaqRegistration): JsonObject {
  return {
    autoReplyMode: registration.autoReplyMode ?? "MENTION",
    channelId: registration.channelId,
    channelName: registration.channelName ?? null,
    confidenceThreshold: registration.confidenceThreshold ?? 0.8,
    daysBack: registration.daysBack ?? 30,
    enabled: registration.enabled ?? true,
    id: registration.channelId,
    lastChunkCount: registration.lastChunkCount ?? null,
    lastError: registration.lastError ?? null,
    lastIngestedAt: registration.lastIngestedAt?.toISOString() ?? null,
    lastMessageCount: registration.lastMessageCount ?? null,
    lastStatus: registration.lastStatus ?? null,
    reIngestIntervalHours: registration.reIngestIntervalHours ?? 24,
    registeredAt: (registration.registeredAt ?? new Date()).toISOString(),
    registeredBy: registration.registeredBy ?? null,
    updatedAt: (registration.updatedAt ?? registration.registeredAt ?? new Date()).toISOString()
  };
}

function slackFaqIngestStatusValue(value: unknown): "OK" | "FAILED" | "RUNNING" | null {
  const normalized = typeof value === "string" ? value.trim().toUpperCase() : "";
  return normalized === "OK" || normalized === "FAILED" || normalized === "RUNNING" ? normalized : null;
}

export function toSlackFaqRegistration(record: JsonObject): JsonObject {
  return {
    autoReplyMode: slackFaqAutoReplyMode(stringField(record.autoReplyMode, "MENTION")),
    channelId: stringField(record.channelId, stringField(record.id, "")),
    channelName: nullableStringResponse(record.channelName),
    confidenceThreshold: readNumber(record.confidenceThreshold, 0.8),
    daysBack: readNumber(record.daysBack, 30),
    enabled: readBoolean(record.enabled, true),
    lastChunkCount: nullableNumberResponse(record.lastChunkCount),
    lastError: nullableStringResponse(record.lastError),
    lastIngestedAt: nullableStringResponse(record.lastIngestedAt),
    lastMessageCount: nullableNumberResponse(record.lastMessageCount),
    lastStatus: record.lastStatus === null ? null : stringField(record.lastStatus, ""),
    registeredAt: stringField(record.registeredAt, stringField(record.createdAt, nowIso())),
    registeredBy: nullableStringResponse(record.registeredBy),
    updatedAt: stringField(record.updatedAt, nowIso())
  };
}

export async function slackFaqIngest(
  request: FastifyRequest,
  reply: FastifyReply,
  options: ReactorCompatibilityRouteOptions
) {
  const { channelId } = request.params as { readonly channelId: string };
  const validation = validateSlackFaqChannelId(channelId, reply);
  if (validation) {
    return validation;
  }

  const existing = await getSlackFaqRegistration(options, channelId);
  if (!existing) {
    return slackFaqNotFound(reply, channelId);
  }

  const documentCount = (await slackFaqDocuments(options, channelId)).length;
  const result = {
    apiCalls: 0,
    channelId,
    chunkCount: documentCount,
    documentCount,
    messagesScanned: documentCount
  };
  await updateSlackFaqIngestResult(options, channelId, "OK", result.messagesScanned, result.chunkCount, null);
  return result;
}

export async function slackFaqProbe(
  request: FastifyRequest,
  reply: FastifyReply,
  options: ReactorCompatibilityRouteOptions
) {
  const { channelId } = request.params as { readonly channelId: string };
  const validation = validateSlackFaqChannelId(channelId, reply);
  if (validation) {
    return validation;
  }

  const query = readBodyString(request.body, "query");
  if (!query) {
    return reply.status(400).send({ error: "query 는 필수입니다" });
  }

  return {
    candidates: await slackFaqCandidates(options, channelId, query, readNumber(toBody(request.body).topK, 5)),
    channelId,
    query
  };
}

export async function slackFaqDryRun(
  request: FastifyRequest,
  reply: FastifyReply,
  options: ReactorCompatibilityRouteOptions
) {
  const { channelId } = request.params as { readonly channelId: string };
  const validation = validateSlackFaqChannelId(channelId, reply);
  if (validation) {
    return validation;
  }

  const query = readBodyString(request.body, "query");
  if (!query) {
    return reply.status(400).send({ error: "query 는 필수입니다" });
  }

  const registration = findCompatRecord(getStateSlackFaq(), channelId);
  const threshold = readNumber(registration?.confidenceThreshold, 0.8);
  const candidates = await slackFaqCandidates(options, channelId, query, 3);
  const matched = registration && readBoolean(registration.enabled, true)
    && slackFaqShouldTrigger(stringField(registration.autoReplyMode, "MENTION"), readBoolean(toBody(request.body).asMention, true))
    ? candidates
      .find((candidate) => readNumber(candidate.score, 0) >= threshold)
    : undefined;

  if (!matched) {
    return {
      channelId,
      matched: false,
      query,
      reason: "Responder 가 null 반환 (registration / mode / cooldown / confidence / 검색 결과 중 하나 실패). /stats 엔드포인트로 outcome breakdown 확인"
    };
  }

  return {
    channelId,
    matched: true,
    query,
    reply: {
      matchedDocIds: candidates.map((candidate) => stringField(candidate.id, "")),
      score: readNumber(matched.score, 0),
      text: slackFaqReplyText(matched, threshold)
    }
  };
}

function slackFaqShouldTrigger(mode: string, isMention: boolean): boolean {
  switch (slackFaqAutoReplyMode(mode)) {
    case "ALWAYS":
      return true;
    case "OFF":
      return false;
    default:
      return isMention;
  }
}

function slackFaqReplyText(candidate: JsonObject, threshold: number): string {
  const preview = stringField(candidate.preview, "");
  const user = nullableStringResponse(candidate.user);
  const ts = nullableStringResponse(candidate.ts);
  const source = user || ts
    ? `\n\n_${user ? `게시자: <@${user}>` : ""}${user && ts ? " · " : ""}${ts ? `ts=${ts}` : ""}_`
    : "";
  return `*FAQ 매칭*\n${preview}${source}\n_신뢰도 ${readNumber(candidate.score, 0).toFixed(2)} (임계값 ${threshold.toFixed(2)})_`;
}

async function slackFaqCandidates(
  options: ReactorCompatibilityRouteOptions,
  channelId: string,
  query: string,
  topK: number
): Promise<JsonObject[]> {
  const clamped = Math.min(20, Math.max(1, Math.trunc(topK)));
  return (await slackFaqDocuments(options, channelId))
    .map((document) => {
      const metadata = jsonObjectField(document.metadata);
      return {
        id: stringField(document.id, ""),
        preview: stringField(document.content, "").slice(0, 200),
        score: slackFaqSimilarityScore(query, stringField(document.content, "")),
        ts: nullableStringResponse(metadata.ts),
        user: nullableStringResponse(metadata.user)
      };
    })
    .sort((left, right) => readNumber(right.score, 0) - readNumber(left.score, 0))
    .slice(0, clamped);
}

async function slackFaqDocuments(
  options: ReactorCompatibilityRouteOptions,
  channelId: string
): Promise<CompatRecord[]> {
  return (await listDocuments(options, { limit: 1000 })).filter((document) => {
    const metadata = jsonObjectField(document.metadata);
    const source = stringField(metadata.source, stringField(metadata.type, ""));
    const channel = stringField(metadata.channel_id, stringField(metadata.channelId, ""));
    return source === "slack-faq" && channel === channelId && document.deleted !== true;
  });
}

function slackFaqSimilarityScore(query: string, content: string): number {
  const queryTerms = new Set(query.toLowerCase().split(/\W+/).filter((term) => term.length > 1));
  if (queryTerms.size === 0) {
    return 0;
  }

  const contentTerms = new Set(content.toLowerCase().split(/\W+/).filter((term) => term.length > 1));
  let overlap = 0;
  for (const term of queryTerms) {
    if (contentTerms.has(term)) {
      overlap += 1;
    }
  }

  return overlap === 0 ? 0 : Math.min(1, overlap / queryTerms.size);
}

export function toSlackFaqEvent(event: JsonObject): JsonObject {
  return {
    matchedDocId: nullableStringResponse(event.matchedDocId),
    outcome: stringField(event.outcome, ""),
    query: nullableStringResponse(event.query),
    score: nullableNumberResponse(event.score),
    timestamp: readNumber(event.timestamp, Date.now())
  };
}

export function slackFaqStats(channelId?: string): JsonObject {
  const events = channelId
    ? getStateSlackFaqEvents(channelId)
    : getAllStateSlackFaqEvents();
  const hits = events.filter((event) => event.outcome === "hit").length;
  const errors = events.filter((event) => event.outcome === "error").length;
  const skipsByReason: Record<string, number> = {};
  let lastHitAt: number | null = null;
  let totalHitScore = 0;

  for (const event of events) {
    if (event.outcome === "hit") {
      const timestamp = readNumber(event.timestamp, 0);
      lastHitAt = lastHitAt === null ? timestamp : Math.max(lastHitAt, timestamp);
      totalHitScore += readNumber(event.score, 0);
      continue;
    }

    if (typeof event.outcome === "string" && event.outcome.startsWith("skip_")) {
      skipsByReason[event.outcome] = (skipsByReason[event.outcome] ?? 0) + 1;
    }
  }

  const total = hits + errors + Object.values(skipsByReason).reduce((sum, count) => sum + count, 0);
  return {
    avgHitScore: hits > 0 ? totalHitScore / hits : null,
    errors,
    hitRatio: total > 0 ? hits / total : 0,
    hits,
    lastHitAt,
    skipsByReason,
    total
  };
}

