import { isProxy } from "node:util/types";

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

/**
 * Rejects accessors, proxies, symbols, exotic prototypes, cycles, and
 * non-JSON values without reading caller-owned properties. Use this before
 * JSON.stringify at an untrusted object boundary.
 */
export function assertPlainDataTree(value: unknown, label = "value"): asserts value is JsonValue {
  const seen = new WeakSet<object>();
  let nodes = 0;

  const visit = (current: unknown, path: string, depth: number): void => {
    nodes += 1;
    if (nodes > 262_144) throw new TypeError(`${label} exceeds the node limit`);
    if (depth > 32) throw new TypeError(`${label} exceeds the depth limit`);
    if (current === null || typeof current === "string" || typeof current === "boolean") return;
    if (typeof current === "number") {
      if (!Number.isFinite(current)) throw new TypeError(`${path} must be finite`);
      return;
    }
    if (typeof current !== "object" || isProxy(current)) {
      throw new TypeError(`${path} must be plain JSON data`);
    }
    if (seen.has(current)) throw new TypeError(`${path} must not be cyclic`);
    seen.add(current);

    if (Array.isArray(current)) {
      if (Object.getPrototypeOf(current) !== Array.prototype || current.length > 4_096) {
        throw new TypeError(`${path} must be a bounded plain array`);
      }
      const keys = Reflect.ownKeys(current);
      if (keys.some((key) => typeof key !== "string")
        || keys.length !== current.length + 1
        || !keys.includes("length")) {
        throw new TypeError(`${path} must not contain extra or sparse array properties`);
      }
      for (let index = 0; index < current.length; index += 1) {
        const key = String(index);
        const descriptor = Object.getOwnPropertyDescriptor(current, key);
        if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
          throw new TypeError(`${path}[${key}] must be an enumerable data property`);
        }
        visit(descriptor.value, `${path}[${key}]`, depth + 1);
      }
      return;
    }

    const prototype = Object.getPrototypeOf(current);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError(`${path} must have a plain prototype`);
    }
    const keys = Reflect.ownKeys(current);
    if (keys.length > 4_096 || keys.some((key) => typeof key !== "string")) {
      throw new TypeError(`${path} must contain bounded string keys`);
    }
    for (const key of keys as string[]) {
      const descriptor = Object.getOwnPropertyDescriptor(current, key);
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
        throw new TypeError(`${path}.${key} must be an enumerable data property`);
      }
      visit(descriptor.value, `${path}.${key}`, depth + 1);
    }
  };

  visit(value, label, 0);
}
