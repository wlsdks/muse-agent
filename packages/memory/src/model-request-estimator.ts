import { isWellFormedBase64, type ModelMessage, type ModelRequest, type ModelTool } from "@muse/model";

import type { TokenEstimator } from "./index.js";
import { createApproximateTokenEstimator } from "./token-estimator.js";

export const MODEL_MESSAGE_FRAMING_TOKENS = 4;
export const MODEL_TOOL_DEFINITION_FRAMING_TOKENS = 8;
export const MODEL_RESPONSE_FORMAT_FRAMING_TOKENS = 8;
export const MODEL_ATTACHMENT_FRAMING_TOKENS = 16;
const MAX_CANONICAL_JSON_CHARS = 16 * 1024 * 1024;
const MAX_CANONICAL_JSON_DEPTH = 64;

export class ModelRequestEstimateError extends Error {
  constructor() {
    super("model request token estimate is unavailable");
    this.name = "ModelRequestEstimateError";
  }
}

export interface ModelRequestTokenEstimate {
  readonly estimatedInputTokens: number;
  readonly messageTokens: number;
  readonly responseFormatTokens: number;
  readonly toolDefinitionTokens: number;
}

function add(left: number, right: number): number {
  if (!Number.isSafeInteger(left) || !Number.isSafeInteger(right) || left < 0 || right < 0) {
    return Number.MAX_SAFE_INTEGER;
  }
  return left > Number.MAX_SAFE_INTEGER - right ? Number.MAX_SAFE_INTEGER : left + right;
}

function canonicalize(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (depth > MAX_CANONICAL_JSON_DEPTH) throw new ModelRequestEstimateError();
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new ModelRequestEstimateError();
    return value;
  }
  if (typeof value !== "object") throw new ModelRequestEstimateError();
  if (seen.has(value)) throw new ModelRequestEstimateError();
  seen.add(value);
  try {
    if (Array.isArray(value)) return value.map((item) => canonicalize(item, depth + 1, seen));
    const source = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort(compareUnicodeCodePoints)) {
      result[key] = canonicalize(source[key], depth + 1, seen);
    }
    return result;
  } finally {
    seen.delete(value);
  }
}

function compareUnicodeCodePoints(left: string, right: string): number {
  const leftPoints = [...left].map((value) => value.codePointAt(0) ?? 0);
  const rightPoints = [...right].map((value) => value.codePointAt(0) ?? 0);
  const length = Math.min(leftPoints.length, rightPoints.length);
  for (let index = 0; index < length; index++) {
    const difference = (leftPoints[index] ?? 0) - (rightPoints[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return leftPoints.length - rightPoints.length;
}

export function canonicalModelJson(value: unknown): string {
  let serialized: string;
  try {
    serialized = JSON.stringify(canonicalize(value, 0, new WeakSet<object>()));
  } catch (error) {
    if (error instanceof ModelRequestEstimateError) throw error;
    throw new ModelRequestEstimateError();
  }
  if (serialized.length > MAX_CANONICAL_JSON_CHARS) throw new ModelRequestEstimateError();
  return serialized;
}

function textTokens(estimator: TokenEstimator, value: string | undefined): number {
  return value ? estimator.estimate(value) : 0;
}

function estimateAttachmentTokens(message: ModelMessage, estimator: TokenEstimator): number {
  let total = 0;
  for (const attachment of message.attachments ?? []) {
    if (attachment.url !== undefined || attachment.dataBase64 === undefined) throw new ModelRequestEstimateError();
    const normalized = attachment.dataBase64.replace(/\s+/gu, "");
    if (!isWellFormedBase64(normalized)) throw new ModelRequestEstimateError();
    total = add(total, MODEL_ATTACHMENT_FRAMING_TOKENS);
    total = add(total, textTokens(estimator, attachment.mimeType));
    // Deliberately charge every encoded code unit as one token. This is a
    // conservative admission bound, not a claim about provider image tokens.
    total = add(total, normalized.length);
  }
  return total;
}

export function estimateModelMessagesTokens(
  messages: readonly ModelMessage[],
  estimator: TokenEstimator = createApproximateTokenEstimator()
): number {
  let total = 0;
  for (const message of messages) {
    total = add(total, MODEL_MESSAGE_FRAMING_TOKENS);
    total = add(total, textTokens(estimator, message.role));
    total = add(total, textTokens(estimator, message.content));
    total = add(total, textTokens(estimator, message.name));
    total = add(total, textTokens(estimator, message.toolCallId));
    for (const toolCall of message.toolCalls ?? []) {
      total = add(total, textTokens(estimator, canonicalModelJson({
        arguments: toolCall.arguments,
        id: toolCall.id,
        name: toolCall.name
      })));
    }
    total = add(total, estimateAttachmentTokens(message, estimator));
  }
  return total;
}

export function estimateModelToolsTokens(
  tools: readonly ModelTool[] | undefined,
  estimator: TokenEstimator = createApproximateTokenEstimator()
): number {
  let total = 0;
  for (const tool of tools ?? []) {
    total = add(total, MODEL_TOOL_DEFINITION_FRAMING_TOKENS);
    total = add(total, textTokens(estimator, canonicalModelJson({
      description: tool.description,
      inputSchema: tool.inputSchema,
      name: tool.name
    })));
  }
  return total;
}

export function estimateModelRequestTokens(
  request: Pick<ModelRequest, "messages" | "responseFormat" | "tools">,
  estimator: TokenEstimator = createApproximateTokenEstimator()
): ModelRequestTokenEstimate {
  const messageTokens = estimateModelMessagesTokens(request.messages, estimator);
  const toolDefinitionTokens = estimateModelToolsTokens(request.tools, estimator);
  const responseFormatTokens = request.responseFormat === undefined
    ? 0
    : add(MODEL_RESPONSE_FORMAT_FRAMING_TOKENS, textTokens(estimator, canonicalModelJson(request.responseFormat)));
  return {
    estimatedInputTokens: add(add(messageTokens, toolDefinitionTokens), responseFormatTokens),
    messageTokens,
    responseFormatTokens,
    toolDefinitionTokens
  };
}
