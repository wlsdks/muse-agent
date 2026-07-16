export type JsonPrimitive = string | number | boolean | null;

export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];

export interface JsonObject {
  readonly [key: string]: JsonValue;
}

export type JsonPredicate<T> = (value: unknown) => value is T;

export function parseJson(raw: string): unknown | undefined {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

export function parseJsonWith<T>(raw: string, predicate: JsonPredicate<T>): T | undefined {
  const parsed = parseJson(raw);
  return parsed !== undefined && predicate(parsed) ? parsed : undefined;
}

/** Type guard for a non-null, non-array object (the canonical shape-inspection helper). */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
