import type { FastifyReply } from "fastify";
import { describe, expect, it } from "vitest";

import {
  badRequest,
  clampLimit,
  errorResponse,
  invalid,
  notFound,
  prefixValidationDetails,
  validationErrorResponse
} from "./compat-responses.js";

// Direct coverage for the compat response-shape helpers (untested module) — the
// error envelope, validation-detail prefixing, the 404/400 reply helpers, the
// pagination clamp, and the ParseResult invalid() constructor.

interface Captured { status: number | null; payload: unknown }
const reply = (): { r: FastifyReply; captured: Captured } => {
  const captured: Captured = { payload: null, status: null };
  return { captured, r: { status: (c: number) => { captured.status = c; return { send: (p: unknown) => { captured.payload = p; } }; } } as unknown as FastifyReply };
};

describe("clampLimit", () => {
  it("clamps the pagination limit to [1, 200]", () => {
    expect(clampLimit(0)).toBe(1);
    expect(clampLimit(-3)).toBe(1);
    expect(clampLimit(5)).toBe(5);
    expect(clampLimit(200)).toBe(200);
    expect(clampLimit(999)).toBe(200);
  });
});

describe("prefixValidationDetails", () => {
  it("dot-prefixes every field key, preserving the messages", () => {
    expect(prefixValidationDetails("body", { age: "too small", name: "required" }))
      .toEqual({ "body.age": "too small", "body.name": "required" });
  });
});

describe("invalid", () => {
  it("builds a failed ParseResult carrying the code + message", () => {
    expect(invalid("BAD_INPUT", "nope")).toEqual({ error: { code: "BAD_INPUT", message: "nope" }, ok: false });
  });
});

describe("errorResponse / validationErrorResponse", () => {
  it("errorResponse wraps the message with an ISO timestamp", () => {
    const result = errorResponse("boom");
    expect(result.error).toBe("boom");
    expect(typeof result.timestamp).toBe("string");
    expect(Number.isNaN(Date.parse(result.timestamp as string))).toBe(false);
  });

  it("validationErrorResponse carries the details and the standard message + timestamp", () => {
    const result = validationErrorResponse({ field: "bad" });
    expect(result.details).toEqual({ field: "bad" });
    expect(result.error).toBe("요청 형식이 올바르지 않습니다");
    expect(typeof result.timestamp).toBe("string");
  });
});

describe("notFound / badRequest reply helpers", () => {
  it("notFound replies 404 with the code + the standard not-found message", () => {
    const { captured, r } = reply();
    notFound(r, "RECORD_NF");
    expect(captured.status).toBe(404);
    expect(captured.payload).toEqual({ code: "RECORD_NF", message: "Compatibility record was not found" });
  });

  it("badRequest replies 400 with the code + the given message", () => {
    const { captured, r } = reply();
    badRequest(r, "BAD_REQ", "missing field x");
    expect(captured.status).toBe(400);
    expect(captured.payload).toEqual({ code: "BAD_REQ", message: "missing field x" });
  });
});
