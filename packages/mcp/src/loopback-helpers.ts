import { errorMessage, isRecord, type JsonObject } from "@muse/shared";

export { errorMessage };

/**
 * Shared shape-readers for loopback MCP tool implementations.
 *
 * Each `loopback-*.ts` factory file used to inline its own copies
 * of these helpers; those copies have become
 * pure duplication — this module consolidates the 5 helpers that are
 * shared by 2 or more loopback factories. Module-specific helpers
 * (e.g. tasks' `readStatusFilter`, calendar's `parseIsoDate`) stay
 * private to their owners.
 */

export function readString(args: JsonObject, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" ? value : undefined;
}

export function readStringArray(args: JsonObject, key: string): readonly string[] | undefined {
  const value = args[key];
  if (!Array.isArray(value)) {
    return undefined;
  }
  return value.filter((entry): entry is string => typeof entry === "string");
}

export function readBoolean(args: JsonObject, key: string): boolean | undefined {
  const value = args[key];
  return typeof value === "boolean" ? value : undefined;
}

export function readJsonObject(args: JsonObject, key: string): Record<string, unknown> | undefined {
  const value = args[key];
  if (!isRecord(value)) {
    return undefined;
  }
  return value;
}

/**
 * Build a closed JSON-schema object literal for a loopback tool's
 * `inputSchema`. Every loopback tool repeats the same
 * `{type: "object", additionalProperties: false, properties, required?}`
 * shape — close to 70 sites before this helper landed. Wrapping it
 * means schema-shape changes (e.g. adding `unevaluatedProperties:
 * false` for stricter MCP compliance) become a one-line edit.
 *
 * Caller passes the `properties` map and optional `required` list.
 * Empty `required` lists are dropped so the emitted schema doesn't
 * carry a noisy `required: []` field.
 */
export function buildJsonToolSchema(
  properties: Record<string, JsonObject>,
  required?: readonly string[]
): JsonObject {
  return {
    additionalProperties: false,
    properties,
    type: "object",
    ...(required && required.length > 0 ? { required: [...required] } : {})
  } satisfies JsonObject;
}
