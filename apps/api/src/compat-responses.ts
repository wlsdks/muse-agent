/**
 * Muse compat shared response shape helpers extracted from
 * compat-routes.ts. Owns the error envelope, validation
 * detail prefixing, the not-found / bad-request 404 + 400 helpers,
 * pagination clamp, and the ParseResult / ApiError types.
 */

import type { JsonObject } from "@muse/shared";
import type { FastifyReply } from "fastify";
import { nowIso } from "./compat-parsers.js";

export interface ApiError {
  readonly code: string;
  readonly message: string;
}

export type ParseResult<T> = { readonly ok: true; readonly value: T } | { readonly error: ApiError; readonly ok: false };

export function errorResponse(error: string): JsonObject {
  return {
    error,
    timestamp: nowIso()
  };
}

export function validationErrorResponse(details: JsonObject): JsonObject {
  return {
    details,
    error: "요청 형식이 올바르지 않습니다",
    timestamp: nowIso()
  };
}

export function prefixValidationDetails(prefix: string, details: JsonObject): JsonObject {
  return Object.fromEntries(
    Object.entries(details).map(([field, message]) => [`${prefix}.${field}`, message])
  );
}

export function notFound(reply: FastifyReply, code: string) {
  return reply.status(404).send({
    code,
    message: "Compatibility record was not found"
  });
}

export function badRequest(reply: FastifyReply, code: string, message: string) {
  return reply.status(400).send({ code, message });
}

export function clampLimit(limit: number): number {
  return Math.min(200, Math.max(1, limit));
}

export function invalid(code: string, message: string): ParseResult<never> {
  return {
    error: { code, message },
    ok: false
  };
}
