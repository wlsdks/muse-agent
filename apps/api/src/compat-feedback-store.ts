/**
 * Reactor-compat feedback store helpers extracted from
 * reactor-compat-routes.ts.
 *
 * Each store helper dispatches to options.feedbackStore (the configured
 * runtime FeedbackStore) when present, otherwise falls back to the
 * file-private compat state via the getStateFeedback accessor. Pairs with
 * feedback-compat-routes.ts.
 */

import type { JsonObject } from "@muse/shared";
import type { FastifyRequest } from "fastify";
import {
  createRecord,
  epochMillisOrNull,
  findCompatRecord,
  getStateFeedback,
  nowIso,
  nullableStringResponse,
  readAuthUserId,
  readBodyString,
  readNullableNumber,
  readNullableStringField,
  readNumber,
  readQueryBoolean,
  readQueryInstantMillis,
  readQueryString,
  stringArrayField,
  stringField,
  toBody,
  toJsonObject,
  type CompatBody,
  type CompatRecord,
  type ReactorCompatibilityRouteOptions
} from "./reactor-compat-routes.js";

export async function createFeedback(request: FastifyRequest, options: ReactorCompatibilityRouteOptions): Promise<CompatRecord> {
  const body = toBody(request.body);
  return saveFeedback(options, {
    comment: readNullableStringField(body, "comment"),
    domain: readNullableStringField(body, "domain"),
    durationMs: readNullableNumber(body.durationMs) ?? null,
    intent: readNullableStringField(body, "intent"),
    model: readNullableStringField(body, "model"),
    promptVersion: readNullableNumber(body.promptVersion) ?? null,
    query: readBodyString(body, "query") ?? "",
    rating: feedbackRating(body.rating),
    response: readBodyString(body, "response") ?? "",
    reviewNote: null,
    reviewStatus: "inbox",
    reviewTags: [],
    reviewedAt: null,
    reviewedBy: null,
    runId: readNullableStringField(body, "runId"),
    sessionId: readNullableStringField(body, "sessionId"),
    tags: stringArrayField(body.tags, []),
    templateId: readNullableStringField(body, "templateId"),
    timestamp: nowIso(),
    toolsUsed: stringArrayField(body.toolsUsed, []),
    updatedAt: nowIso(),
    userId: readAuthUserId(request) ?? null,
    version: 1
  });
}

export function validateFeedbackSubmitBody(body: CompatBody): JsonObject | undefined {
  const stringChecks: Array<readonly [keyof CompatBody, number]> = [
    ["query", 10_000],
    ["response", 50_000],
    ["comment", 5_000],
    ["sessionId", 120],
    ["runId", 120],
    ["intent", 120],
    ["domain", 120],
    ["model", 120],
    ["templateId", 120]
  ];

  for (const [key, max] of stringChecks) {
    const value = body[key];

    if (typeof value === "string" && value.length > max) {
      return { [key]: `size must be between 0 and ${max}` };
    }
  }

  if (Array.isArray(body.toolsUsed) && body.toolsUsed.length > 50) {
    return { toolsUsed: "size must be between 0 and 50" };
  }

  if (Array.isArray(body.tags) && body.tags.length > 20) {
    return { tags: "size must be between 0 and 20" };
  }

  return undefined;
}

export function validateFeedbackReviewBody(body: CompatBody): JsonObject | undefined {
  if (Array.isArray(body.tags) && body.tags.length > 16) {
    return { tags: "size must be between 0 and 16" };
  }

  if (typeof body.note === "string" && body.note.length > 2000) {
    return { note: "size must be between 0 and 2000" };
  }

  return undefined;
}

export function toFeedbackResponse(record: JsonObject) {
  return {
    comment: nullableStringResponse(record.comment),
    domain: nullableStringResponse(record.domain),
    durationMs: readNullableNumber(record.durationMs) ?? null,
    feedbackId: stringField(record.id, ""),
    intent: nullableStringResponse(record.intent),
    model: nullableStringResponse(record.model),
    promptVersion: readNullableNumber(record.promptVersion) ?? null,
    query: stringField(record.query, ""),
    rating: feedbackRating(record.rating),
    response: stringField(record.response, ""),
    reviewNote: nullableStringResponse(record.reviewNote),
    reviewStatus: feedbackReviewStatus(record.reviewStatus),
    reviewTags: stringArrayField(record.reviewTags, []),
    reviewedAt: nullableStringResponse(record.reviewedAt),
    reviewedBy: nullableStringResponse(record.reviewedBy),
    runId: nullableStringResponse(record.runId),
    tags: stringArrayField(record.tags, []),
    templateId: nullableStringResponse(record.templateId),
    timestamp: stringField(record.timestamp, stringField(record.createdAt, nowIso())),
    toolsUsed: stringArrayField(record.toolsUsed, []),
    updatedAt: stringField(record.updatedAt, stringField(record.createdAt, nowIso())),
    version: readNumber(record.version, 1)
  };
}

export async function updateFeedbackReview(
  existing: CompatRecord,
  body: CompatBody,
  actor: string,
  options: ReactorCompatibilityRouteOptions
): Promise<CompatRecord> {
  const status = typeof body.status === "string" ? feedbackReviewStatus(body.status) : feedbackReviewStatus(existing.reviewStatus);
  const tags = updateTags(stringArrayField(existing.reviewTags, []), stringArrayField(body.tags, []), stringField(body.tagMode, "set"));
  return saveFeedback(options, {
    ...existing,
    reviewNote: typeof body.note === "string" ? body.note : existing.reviewNote ?? null,
    reviewStatus: status,
    reviewTags: tags,
    reviewedAt: nowIso(),
    reviewedBy: actor,
    version: readNumber(existing.version, 1) + 1
  });
}

function updateTags(existing: string[], incoming: string[], mode: string): string[] {
  if (incoming.length === 0) {
    return existing;
  }

  if (mode === "add") {
    return [...new Set([...existing, ...incoming])];
  }

  if (mode === "remove") {
    return existing.filter((tag) => !incoming.includes(tag));
  }

  return incoming;
}

async function saveFeedback(options: ReactorCompatibilityRouteOptions, input: JsonObject): Promise<CompatRecord> {
  const record = stringField(input.id, "").length > 0
    ? {
      ...input,
      updatedAt: nowIso()
    }
    : createRecord(new Map(), input, "feedback");

  if (options.feedbackStore) {
    const saved = await options.feedbackStore.save(record);
    return feedbackStoreRecordToCompat(saved);
  }

  return createRecord(getStateFeedback(), record, "feedback");
}

export async function listFeedback(options: ReactorCompatibilityRouteOptions): Promise<CompatRecord[]> {
  if (options.feedbackStore) {
    const rows = await options.feedbackStore.list();
    return rows.map(feedbackStoreRecordToCompat);
  }

  return [...getStateFeedback().values()];
}

export async function getFeedback(options: ReactorCompatibilityRouteOptions, id: string): Promise<CompatRecord | undefined> {
  if (options.feedbackStore) {
    const record = await options.feedbackStore.get(id);
    return record ? feedbackStoreRecordToCompat(record) : undefined;
  }

  return findCompatRecord(getStateFeedback(), id);
}

export async function deleteFeedback(options: ReactorCompatibilityRouteOptions, id: string): Promise<boolean> {
  if (options.feedbackStore) {
    return options.feedbackStore.delete(id);
  }

  const existing = findCompatRecord(getStateFeedback(), id);

  if (existing) {
    return getStateFeedback().delete(existing.id);
  }

  return false;
}

function feedbackStoreRecordToCompat(record: JsonObject): CompatRecord {
  return {
    ...record,
    createdAt: stringField(record.createdAt, stringField(record.timestamp, nowIso())),
    id: stringField(record.id, ""),
    updatedAt: stringField(record.updatedAt, stringField(record.timestamp, nowIso()))
  };
}

export async function filterFeedback(request: FastifyRequest, options: ReactorCompatibilityRouteOptions): Promise<CompatRecord[]> {
  const rating = readQueryString(request, "rating");
  const status = readQueryString(request, "status");
  const tag = readQueryString(request, "tag");
  const q = readQueryString(request, "q");
  const hasComment = readQueryBoolean(request, "hasComment", false);
  const hasCommentProvided = readQueryString(request, "hasComment") !== undefined;
  const domain = readQueryString(request, "domain");
  const intent = readQueryString(request, "intent");
  const from = readQueryInstantMillis(request, "from");
  const to = readQueryInstantMillis(request, "to");
  return (await listFeedback(options)).filter((feedback) => {
    if (rating && feedbackRating(feedback.rating) !== feedbackRating(rating)) {
      return false;
    }

    if (status && feedbackReviewStatus(feedback.reviewStatus) !== feedbackReviewStatus(status)) {
      return false;
    }

    if (tag && !stringArrayField(feedback.reviewTags, []).includes(tag)) {
      return false;
    }

    if (hasCommentProvided) {
      const comment = nullableStringResponse(feedback.comment);
      const matches = comment !== null && comment.trim().length > 0;

      if (matches !== hasComment) {
        return false;
      }
    }

    if (domain && nullableStringResponse(feedback.domain) !== domain) {
      return false;
    }

    if (intent && nullableStringResponse(feedback.intent) !== intent) {
      return false;
    }

    const timestamp = epochMillisOrNull(feedback.timestamp);

    if (from !== undefined && (timestamp === null || timestamp < from)) {
      return false;
    }

    if (to !== undefined && (timestamp === null || timestamp > to)) {
      return false;
    }

    return !q || JSON.stringify(feedback).toLowerCase().includes(q.toLowerCase());
  });
}

export function toFeedbackExportItem(record: JsonObject): JsonObject {
  return toJsonObject(toFeedbackResponse(record));
}

export function feedbackRating(value: unknown): string {
  if (typeof value === "number") {
    return value >= 4 ? "thumbs_up" : "thumbs_down";
  }

  if (typeof value !== "string") {
    return "thumbs_down";
  }

  const normalized = value.trim().toLowerCase();
  return normalized === "thumbs_up" || normalized === "positive" || normalized === "up" || normalized === "5"
    ? "thumbs_up"
    : "thumbs_down";
}

export function parseFeedbackRating(value: unknown): "thumbs_down" | "thumbs_up" | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim().toLowerCase();

  if (normalized === "thumbs_up") {
    return "thumbs_up";
  }

  return normalized === "thumbs_down" ? "thumbs_down" : undefined;
}

export function feedbackReviewStatus(value: unknown): string {
  return typeof value === "string" && value.trim().toLowerCase() === "done" ? "done" : "inbox";
}

export function parseFeedbackReviewStatus(value: unknown): "done" | "inbox" | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim().toLowerCase();

  if (normalized === "done") {
    return "done";
  }

  return normalized === "inbox" ? "inbox" : undefined;
}

export function isUnreviewedNegativeFeedback(record: JsonObject): boolean {
  return feedbackRating(record.rating) === "thumbs_down" && feedbackReviewStatus(record.reviewStatus) === "inbox";
}

export function feedbackStats(items: readonly CompatRecord[]) {
  const positive = items.filter((item) => feedbackRating(item.rating) === "thumbs_up").length;
  const negative = items.length - positive;
  const done = items.filter((item) => feedbackReviewStatus(item.reviewStatus) === "done").length;
  return {
    byDay: [],
    commentRate: items.length > 0 ? items.filter((item) => item.comment !== null).length / items.length : 0,
    doneCount: done,
    inboxCount: items.length - done,
    negative,
    negativeChange: 0,
    negativeThisPeriod: negative,
    period: { from: null, to: null },
    positive,
    positiveRate: items.length > 0 ? positive / items.length : 0,
    previousPeriodNegative: 0,
    previousPeriodRate: 0,
    topNegativeDomains: [],
    topNegativeIntents: [],
    topNegativeTools: [],
    total: items.length
  };
}
