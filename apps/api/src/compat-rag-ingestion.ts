/**
 * Reactor-compat RAG ingestion policy + candidate review helpers extracted
 * from reactor-compat-routes.ts.
 *
 * Each store helper dispatches to options.ragIngestion.{policyStore,
 * candidateStore} when configured, otherwise falls back to file-private
 * compat state via accessors. The candidate review path also persists the
 * ingested document into the compat document store via saveDocumentRecord.
 */

import type {
  RagIngestionCandidateStatus,
  RagIngestionPolicy,
  StoredRagIngestionCandidate
} from "@muse/rag";
import { createRunId, type JsonObject } from "@muse/shared";
import type { FastifyReply, FastifyRequest } from "fastify";
import { saveDocumentRecord } from "./compat-document-store.js";
import {
  createRecord,
  epochMillisOrNull,
  errorResponse,
  findCompatRecord,
  getStateRagCandidatesMap,
  getStateRagIngestionPolicy,
  invalid,
  isStateRagIngestionPolicyStored,
  nowIso,
  nullableStringResponse,
  readAuthUserId,
  readBodyNullableString,
  readBoolean,
  readNumber,
  readStringSet,
  setStateRagIngestionPolicy,
  stringField,
  toBody,
  type ParseResult,
  type ReactorCompatibilityRouteOptions
} from "./reactor-compat-routes.js";

export function parseRagIngestionPolicy(value: unknown): ParseResult<JsonObject> {
  const body = toBody(value);
  const allowedChannels = readStringSet(body.allowedChannels);
  const blockedPatterns = readStringSet(body.blockedPatterns);

  if (allowedChannels.length > 300) {
    return invalid("INVALID_RAG_INGESTION_POLICY", "allowedChannels must not exceed 300 entries");
  }

  if (blockedPatterns.length > 200) {
    return invalid("INVALID_RAG_INGESTION_POLICY", "blockedPatterns must not exceed 200 entries");
  }

  const parsed: JsonObject = {
    allowedChannels: allowedChannels.map((channel) => channel.toLowerCase()),
    blockedPatterns,
    enabled: typeof body.enabled === "boolean" ? body.enabled : false,
    minQueryChars: Math.max(1, readNumber(body.minQueryChars, 10)),
    minResponseChars: Math.max(1, readNumber(body.minResponseChars, 20)),
    requireReview: typeof body.requireReview === "boolean" ? body.requireReview : true
  };
  const invalidPattern = blockedPatterns.find((pattern) =>
    pattern.length > 500 || !isValidRegex(pattern));

  if (invalidPattern) {
    return invalid("INVALID_RAG_INGESTION_POLICY", `Invalid blocked pattern: ${invalidPattern.slice(0, 30)}`);
  }

  return { ok: true, value: parsed };
}

export async function readStoredRagIngestionPolicy(options: ReactorCompatibilityRouteOptions): Promise<JsonObject | undefined> {
  const stored = await options.ragIngestion?.policyStore.getOrNull();

  if (stored) {
    return ragPolicyToCompat(stored);
  }

  return isStateRagIngestionPolicyStored() ? getStateRagIngestionPolicy() : undefined;
}

export async function saveRagIngestionPolicy(
  options: ReactorCompatibilityRouteOptions,
  policy: JsonObject
): Promise<JsonObject> {
  if (options.ragIngestion?.policyStore) {
    const saved = await options.ragIngestion.policyStore.save(compatToRagPolicy(policy));
    const compat = ragPolicyToCompat(saved);
    setStateRagIngestionPolicy(compat, true);
    return compat;
  }

  const timestamp = nowIso();
  return setStateRagIngestionPolicy({
    ...policy,
    createdAt: timestamp,
    updatedAt: timestamp
  }, true);
}

export async function clearRagIngestionPolicy(options: ReactorCompatibilityRouteOptions): Promise<void> {
  await options.ragIngestion?.policyStore.delete();
  setStateRagIngestionPolicy(defaultRagIngestionPolicy(), false);
}

export async function listRagCandidates(
  options: ReactorCompatibilityRouteOptions,
  query: { readonly channel?: string; readonly limit: number; readonly status?: string }
): Promise<readonly JsonObject[]> {
  if (options.ragIngestion?.candidateStore) {
    const status = ragCandidateStatusValue(query.status);
    const candidates = await options.ragIngestion.candidateStore.list({
      channel: query.channel,
      limit: query.limit,
      ...(status ? { status } : {})
    });
    return candidates.map(ragCandidateToCompat);
  }

  return [...getStateRagCandidatesMap().values()]
    .filter((candidate) => !query.status || candidateStatus(candidate.status) === query.status)
    .filter((candidate) => !query.channel || nullableStringResponse(candidate.channel) === query.channel)
    .slice(0, query.limit);
}

async function findRagCandidate(
  options: ReactorCompatibilityRouteOptions,
  id: string
): Promise<JsonObject | undefined> {
  if (options.ragIngestion?.candidateStore) {
    const candidate = await options.ragIngestion.candidateStore.findById(id);
    return candidate ? ragCandidateToCompat(candidate) : undefined;
  }

  return findCompatRecord(getStateRagCandidatesMap(), id);
}

async function updateRagCandidateReview(
  options: ReactorCompatibilityRouteOptions,
  input: {
    readonly id: string;
    readonly status: Exclude<RagIngestionCandidateStatus, "PENDING">;
    readonly reviewedBy: string;
    readonly reviewComment?: string | null;
    readonly ingestedDocumentId?: string | null;
  }
): Promise<JsonObject | undefined> {
  if (options.ragIngestion?.candidateStore) {
    const candidate = await options.ragIngestion.candidateStore.updateReview(input);
    return candidate ? ragCandidateToCompat(candidate) : undefined;
  }

  const candidate = findCompatRecord(getStateRagCandidatesMap(), input.id);

  if (!candidate) {
    return undefined;
  }

  return createRecord(getStateRagCandidatesMap(), {
    ...candidate,
    ingestedDocumentId: input.ingestedDocumentId ?? null,
    reviewComment: input.reviewComment ?? null,
    reviewedAt: nowIso(),
    reviewedBy: input.reviewedBy,
    status: input.status
  }, "rag_candidate");
}

function compatToRagPolicy(policy: JsonObject): RagIngestionPolicy {
  return {
    allowedChannels: readStringSet(policy.allowedChannels),
    blockedPatterns: readStringSet(policy.blockedPatterns),
    enabled: readBoolean(policy.enabled, false),
    minQueryChars: readNumber(policy.minQueryChars, 10),
    minResponseChars: readNumber(policy.minResponseChars, 20),
    requireReview: readBoolean(policy.requireReview, true)
  };
}

function ragPolicyToCompat(policy: RagIngestionPolicy): JsonObject {
  return {
    allowedChannels: [...policy.allowedChannels],
    blockedPatterns: [...policy.blockedPatterns],
    createdAt: policy.createdAt?.toISOString() ?? nowIso(),
    enabled: policy.enabled,
    minQueryChars: policy.minQueryChars,
    minResponseChars: policy.minResponseChars,
    requireReview: policy.requireReview,
    updatedAt: policy.updatedAt?.toISOString() ?? nowIso()
  };
}

function ragCandidateToCompat(candidate: StoredRagIngestionCandidate): JsonObject {
  return {
    capturedAt: candidate.capturedAt.toISOString(),
    channel: candidate.channel,
    id: candidate.id,
    ingestedDocumentId: candidate.ingestedDocumentId,
    query: candidate.query,
    response: candidate.response,
    reviewComment: candidate.reviewComment,
    reviewedAt: candidate.reviewedAt?.toISOString() ?? null,
    reviewedBy: candidate.reviewedBy,
    runId: candidate.runId,
    sessionId: candidate.sessionId,
    status: candidate.status,
    userId: candidate.userId
  };
}

function ragCandidateStatusValue(value: string | undefined): RagIngestionCandidateStatus | undefined {
  return value === "PENDING" || value === "REJECTED" || value === "INGESTED" ? value : undefined;
}

export function defaultRagIngestionPolicy(): JsonObject {
  const timestamp = nowIso();
  return {
    allowedChannels: [],
    blockedPatterns: [],
    createdAt: timestamp,
    enabled: false,
    minQueryChars: 10,
    minResponseChars: 20,
    requireReview: true,
    updatedAt: timestamp
  };
}

export function toRagIngestionPolicyResponse(policy: JsonObject): JsonObject {
  return {
    allowedChannels: readStringSet(policy.allowedChannels),
    blockedPatterns: readStringSet(policy.blockedPatterns),
    createdAt: epochMillisOrNull(policy.createdAt) ?? Date.now(),
    enabled: readBoolean(policy.enabled, false),
    minQueryChars: readNumber(policy.minQueryChars, 10),
    minResponseChars: readNumber(policy.minResponseChars, 20),
    requireReview: readBoolean(policy.requireReview, true),
    updatedAt: epochMillisOrNull(policy.updatedAt) ?? Date.now()
  };
}

export async function reviewRagCandidate(
  request: FastifyRequest,
  reply: FastifyReply,
  options: ReactorCompatibilityRouteOptions,
  targetStatus: "INGESTED" | "REJECTED"
): Promise<JsonObject | FastifyReply> {
  const { id } = request.params as { readonly id: string };
  const candidate = await findRagCandidate(options, id);

  if (!candidate) {
    return reply.status(404).send(errorResponse(`Candidate not found: ${id}`));
  }

  if (candidateStatus(candidate.status) !== "PENDING") {
    return reply.status(409).send({
      error: "Candidate is already reviewed",
      timestamp: nowIso()
    });
  }

  const body = toBody(request.body);
  const comment = readBodyNullableString(body, "comment");

  if (typeof comment === "string" && comment.length > 500) {
    return reply.status(400).send(errorResponse("comment must not exceed 500 characters"));
  }

  const documentId = targetStatus === "INGESTED" ? createRunId("rag_document") : null;

  if (targetStatus === "INGESTED") {
    await saveDocumentRecord(options, {
      content: stringField(candidate.response, ""),
      id: documentId,
      metadata: {
        candidateId: id,
        channel: nullableStringResponse(candidate.channel),
        runId: stringField(candidate.runId, "")
      }
    });
  }

  const reviewed = await updateRagCandidateReview(options, {
    id,
    ingestedDocumentId: documentId,
    reviewComment: typeof comment === "string" ? comment.trim() : null,
    reviewedBy: readAuthUserId(request) ?? "admin",
    status: targetStatus
  });

  if (!reviewed) {
    return reply.status(404).send(errorResponse(`Candidate not found: ${id}`));
  }

  return toRagCandidateResponse(reviewed);
}

export function toRagCandidateResponse(candidate: JsonObject): JsonObject {
  return {
    capturedAt: epochMillisOrNull(candidate.capturedAt) ?? epochMillisOrNull(candidate.createdAt) ?? Date.now(),
    channel: nullableStringResponse(candidate.channel),
    id: stringField(candidate.id, ""),
    ingestedDocumentId: nullableStringResponse(candidate.ingestedDocumentId),
    query: stringField(candidate.query, ""),
    response: stringField(candidate.response, ""),
    reviewComment: nullableStringResponse(candidate.reviewComment),
    reviewedAt: epochMillisOrNull(candidate.reviewedAt),
    reviewedBy: nullableStringResponse(candidate.reviewedBy),
    runId: stringField(candidate.runId, ""),
    status: candidateStatus(candidate.status)
  };
}

function candidateStatus(value: unknown): string {
  const normalized = typeof value === "string" ? value.trim().toUpperCase() : "";
  return ["APPROVED", "INGESTED", "PENDING", "REJECTED"].includes(normalized) ? normalized : "PENDING";
}

function isValidRegex(pattern: string): boolean {
  try {
    new RegExp(pattern);
    return true;
  } catch {
    return false;
  }
}
