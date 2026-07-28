import { CONTINUITY_CHANGE_LIMITS } from "./continuity-change-semantics.js";
import type { ContinuityProjectionScope } from "./continuity-projection.js";

export type ContinuityChangeQueryErrorCode =
  | "INVALID_INPUT"
  | "SOURCE_BUDGET_EXCEEDED"
  | "RAW_DELTA_BUDGET_EXCEEDED";

export class ContinuityChangeQueryError extends Error {
  readonly code: ContinuityChangeQueryErrorCode;
  readonly details: Readonly<Record<string, number | string>>;

  constructor(
    code: ContinuityChangeQueryErrorCode,
    message: string,
    details: Readonly<Record<string, number | string>> = {}
  ) {
    super(message);
    this.name = "ContinuityChangeQueryError";
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

export interface ContinuityDataInspection {
  readonly descriptors: number;
  readonly stringBytes: number;
}

export function queryError(
  code: ContinuityChangeQueryErrorCode,
  message: string,
  details: Readonly<Record<string, number | string>> = {}
): never {
  throw new ContinuityChangeQueryError(code, message, details);
}

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

export function inspectContinuityData(
  value: unknown,
  label: string,
  maxDescriptors: number = CONTINUITY_CHANGE_LIMITS.maxDescriptors,
  maxStringBytes: number = CONTINUITY_CHANGE_LIMITS.maxAggregateStringBytes
): ContinuityDataInspection {
  let descriptors = 0;
  let stringBytes = 0;
  const active = new WeakSet<object>();

  const countString = (text: string): void => {
    const bytes = utf8Bytes(text);
    if (bytes > CONTINUITY_CHANGE_LIMITS.maxStringBytes) {
      queryError("SOURCE_BUDGET_EXCEEDED", `${label} contains an oversized string`, {
        bytes,
        limit: CONTINUITY_CHANGE_LIMITS.maxStringBytes
      });
    }
    stringBytes += bytes;
    if (stringBytes > maxStringBytes) {
      queryError("SOURCE_BUDGET_EXCEEDED", `${label} exceeds its string-byte budget`, {
        bytes: stringBytes,
        limit: maxStringBytes
      });
    }
  };

  const visit = (current: unknown, depth: number): void => {
    if (typeof current === "string") {
      countString(current);
      return;
    }
    if (
      current === null
      || typeof current === "boolean"
      || typeof current === "number"
      || current === undefined
    ) {
      return;
    }
    if (typeof current !== "object") {
      queryError("INVALID_INPUT", `${label} must contain only plain data`);
    }
    if (depth > CONTINUITY_CHANGE_LIMITS.maxNestingDepth) {
      queryError("SOURCE_BUDGET_EXCEEDED", `${label} exceeds its nesting budget`, {
        depth,
        limit: CONTINUITY_CHANGE_LIMITS.maxNestingDepth
      });
    }
    const object = current as object;
    if (active.has(object)) {
      queryError("INVALID_INPUT", `${label} must not contain cycles`);
    }
    const prototype = Object.getPrototypeOf(object);
    if (
      !Array.isArray(object)
      && prototype !== Object.prototype
      && prototype !== null
    ) {
      queryError("INVALID_INPUT", `${label} must contain only plain objects and arrays`);
    }
    active.add(object);
    const keys = Reflect.ownKeys(object);
    for (const key of keys) {
      if (typeof key !== "string") {
        queryError("INVALID_INPUT", `${label} must not contain symbol keys`);
      }
      countString(key);
      descriptors += 1;
      if (descriptors > maxDescriptors) {
        queryError("SOURCE_BUDGET_EXCEEDED", `${label} exceeds its descriptor budget`, {
          descriptors,
          limit: maxDescriptors
        });
      }
      const descriptor = Object.getOwnPropertyDescriptor(object, key);
      if (!descriptor || !("value" in descriptor)) {
        queryError("INVALID_INPUT", `${label} must not contain accessors`);
      }
      visit(descriptor.value, depth + 1);
    }
    active.delete(object);
  };

  visit(value, 0);
  return Object.freeze({ descriptors, stringBytes });
}

export function continuityDataObject(
  value: unknown,
  label: string,
  allowed: readonly string[],
  required: readonly string[] = allowed
): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    queryError("INVALID_INPUT", `${label} must be a plain object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    queryError("INVALID_INPUT", `${label} must be a plain object`);
  }
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== "string")) {
    queryError("INVALID_INPUT", `${label} must not contain symbol keys`);
  }
  const names = keys as string[];
  if (
    names.some((key) => !allowed.includes(key))
    || required.some((key) => !names.includes(key))
  ) {
    queryError("INVALID_INPUT", `${label} has missing or unknown fields`);
  }
  const output: Record<string, unknown> = {};
  for (const name of names) {
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    if (!descriptor || !("value" in descriptor)) {
      queryError("INVALID_INPUT", `${label}.${name} must be a data property`);
    }
    output[name] = descriptor.value;
  }
  return output;
}

export function continuityDataArray(
  value: unknown,
  label: string
): readonly unknown[] {
  if (!Array.isArray(value)) queryError("INVALID_INPUT", `${label} must be an array`);
  return value;
}

export function continuityDataString(value: unknown, label: string): string {
  if (typeof value !== "string") queryError("INVALID_INPUT", `${label} must be text`);
  return value;
}

export function continuityCanonicalInstant(
  value: unknown,
  label: string
): string {
  const text = continuityDataString(value, label);
  const date = new Date(text);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== text) {
    queryError("INVALID_INPUT", `${label} must be a canonical ISO instant`);
  }
  return text;
}

export function parseContinuityProjectionScope(
  value: unknown,
  label: string
): ContinuityProjectionScope {
  const record = continuityDataObject(value, label, ["sourceId", "threadId"]);
  const sourceId = continuityDataString(record.sourceId, `${label}.sourceId`);
  const threadId = continuityDataString(record.threadId, `${label}.threadId`);
  return Object.freeze({ sourceId, threadId });
}
