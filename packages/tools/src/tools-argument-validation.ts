/**
 * Deterministic tool-argument coercion + required-argument validation — the
 * "repair" half of tool-calling for a small local model. Split out of index.ts.
 */

import { isRecord, type JsonObject, type JsonValue } from "@muse/shared";

export interface ToolArgumentValidation {
  readonly ok: boolean;
  readonly missing: readonly string[];
}

/**
 * Deterministic pre-execute check of a model's tool arguments against the
 * tool's input schema. Enforces ONLY the schema's `required` list — the
 * highest-value, lowest-false-reject rule: a missing required argument would
 * otherwise reach the tool's `execute()` as `undefined` and crash or
 * misbehave (a top small-model failure mode). Anything else (extra props,
 * loose types) passes; the runtime returns the missing list to the model so it
 * re-calls correctly. A schema that isn't an object schema with a `required`
 * array imposes no constraint.
 */
/**
 * Lossless, unambiguous scalar coercion of a model's tool arguments to the
 * types the schema declares — the deterministic "repair" half of tool-calling
 * (Structured Reflection, arXiv:2509.18847: a right value in the wrong JSON
 * type invalidates an otherwise-correct call). Only safe, reversible cases:
 *   - number/integer param + clean numeric string → number ("5" → 5)
 *   - boolean param + "true"/"false" string → boolean
 *   - string param + number/boolean value → its string form
 * Everything else (objects, arrays, non-numeric strings, partial parses) is
 * left untouched, so a genuine mismatch still surfaces rather than being
 * masked by a lossy guess.
 */
export function coerceToolArguments(inputSchema: JsonValue | undefined, args: JsonObject): JsonObject {
  if (!isRecord(inputSchema) || inputSchema.type !== "object" || !isRecord(inputSchema.properties)) {
    return args;
  }
  const properties = inputSchema.properties;
  const out: Record<string, JsonValue> = { ...args };
  for (const [key, value] of Object.entries(args)) {
    const propSchema = properties[key];
    const declared = isRecord(propSchema) && typeof propSchema.type === "string" ? propSchema.type : undefined;
    if (declared === undefined) continue;
    const coerced = coerceScalar(value, declared);
    if (coerced !== undefined) out[key] = coerced;
  }
  return out;
}

function coerceScalar(value: JsonValue, declared: string): JsonValue | undefined {
  if ((declared === "number" || declared === "integer") && typeof value === "string") {
    const trimmed = value.trim();
    const pattern = declared === "integer" ? /^-?\d+$/u : /^-?\d+(\.\d+)?$/u;
    if (pattern.test(trimmed)) {
      const n = Number(trimmed);
      if (Number.isFinite(n)) return n;
    }
    return undefined;
  }
  if (declared === "boolean" && typeof value === "string") {
    const lower = value.trim().toLowerCase();
    if (lower === "true") return true;
    if (lower === "false") return false;
    return undefined;
  }
  if (declared === "string" && (typeof value === "number" || typeof value === "boolean")) {
    return String(value);
  }
  return undefined;
}

export function validateRequiredToolArguments(inputSchema: JsonValue | undefined, args: JsonObject): ToolArgumentValidation {
  if (!isRecord(inputSchema) || inputSchema.type !== "object" || !Array.isArray(inputSchema.required)) {
    return { missing: [], ok: true };
  }
  const missing = inputSchema.required.filter(
    (name): name is string => typeof name === "string" && (args[name] === undefined || args[name] === null)
  );
  return { missing, ok: missing.length === 0 };
}
