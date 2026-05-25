import { describe, expect, it } from "vitest";

import { sanitizeGeminiSchema } from "../src/provider-gemini.js";

// sanitizeGeminiSchema runs on tool inputSchemas, which are in-memory objects
// that may be pathologically deep or self-referential. Unguarded recursion
// threw RangeError (Maximum call stack size exceeded) and poisoned the whole
// generate request. These pin the depth + cycle guards.
describe("sanitizeGeminiSchema — recursion safety on hostile schemas", () => {
  it("does not overflow on a very deeply nested schema", () => {
    let deep: Record<string, unknown> = { type: "object", properties: { x: { type: "string" } } };
    for (let i = 0; i < 200_000; i += 1) {
      deep = { type: "object", additionalProperties: false, properties: { nested: deep } };
    }
    expect(() => sanitizeGeminiSchema(deep)).not.toThrow();
  });

  it("does not overflow on a self-referential (circular) schema and stays JSON-serializable", () => {
    const circular: Record<string, unknown> = { type: "object", properties: {} };
    (circular.properties as Record<string, unknown>).self = circular;
    let result: unknown;
    expect(() => { result = sanitizeGeminiSchema(circular); }).not.toThrow();
    expect(() => JSON.stringify(result)).not.toThrow();
  });

  it("still strips rejected keywords and preserves real properties (no regression)", () => {
    const sanitized = sanitizeGeminiSchema({
      type: "object",
      $schema: "https://json-schema.org/draft/2020-12/schema",
      additionalProperties: false,
      properties: {
        name: { type: "string", exclusiveMinimum: 0 },
        items: { type: "array", items: { type: "number" } }
      }
    }) as Record<string, unknown>;

    expect("additionalProperties" in sanitized).toBe(false);
    expect("$schema" in sanitized).toBe(false);
    const props = sanitized.properties as Record<string, Record<string, unknown>>;
    expect(props.name?.type).toBe("string");
    expect("exclusiveMinimum" in props.name!).toBe(false);
    expect(props.items?.type).toBe("array");
  });

  it("passes through primitives unchanged", () => {
    expect(sanitizeGeminiSchema("str")).toBe("str");
    expect(sanitizeGeminiSchema(42)).toBe(42);
    expect(sanitizeGeminiSchema(null)).toBe(null);
  });
});
