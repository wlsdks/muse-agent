import { createHash, type Hash } from "node:crypto";
import { TextEncoder, types as nodeTypes } from "node:util";

import {
  CanonicalImmutableEnvelopeError,
  mintCanonicalImmutableEnvelopeFromFrozenUnsignedForInternalUse
} from "./canonical-immutable-envelope.js";
import type { MagScope } from "./mag-contracts.js";
import { normalizeMagScope } from "./mag-engine.js";
import {
  admitPortableProjection
} from "./mag-portable-admission.js";

export interface MagPortableEncoderBudgetsForInternalUse {
  readonly maxProjections: number;
  readonly maxHeads: number;
  readonly maxScopes: number;
  readonly maxTotalRecords: number;
  readonly maxPortableLineBytes: number;
  readonly maxEdgeLineBytes: number;
  readonly maxArtifactBytes: number;
}

const BUDGET_KEYS = Object.freeze([
  "maxProjections",
  "maxHeads",
  "maxScopes",
  "maxTotalRecords",
  "maxPortableLineBytes",
  "maxEdgeLineBytes",
  "maxArtifactBytes"
] as const);
export const PRODUCTION_MAG_PORTABLE_BUDGETS_FOR_INTERNAL_USE = Object.freeze({
  maxProjections: 1_000_000,
  maxHeads: 1_000_000,
  maxScopes: 1_000_000,
  maxTotalRecords: 2_000_002,
  maxPortableLineBytes: 1_114_112,
  maxEdgeLineBytes: 16_384,
  maxArtifactBytes: 1_099_511_627_776
});

const RECORD_SPEC = Object.freeze({
  hashDomain: "muse.mag.portable-record.v1",
  idField: "recordId",
  idPrefix: "mag-portable-record:"
} as const);
const STATE_HASH_DOMAIN = "muse.mag.portable-state.v1\0";
const STORE_ID = /^mag-store:[0-9a-f]{64}$/u;

const objectFreeze = Object.freeze;
const objectGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
const reflectApply = Reflect.apply;
const reflectGetPrototypeOf = Reflect.getPrototypeOf;
const reflectOwnKeys = Reflect.ownKeys;
const textEncoder = new TextEncoder();

export interface MagPortableProjectionIdentity {
  readonly scope: MagScope;
  readonly generation: number;
  readonly commitId: string;
  readonly projectionId: `mag-store:${string}`;
}

export type MagPortableHeadIdentity = MagPortableProjectionIdentity;

export interface MagPortableEncoderIdentitySink {
  appendProjection(identity: MagPortableProjectionIdentity): void;
  sealProjections(): void;
  assertHead(head: MagPortableHeadIdentity): void;
  finish(expectedScopeCount: number, expectedHeadCount: number): void;
  abort(cause: unknown): void;
}

export interface MagPortableSummary {
  readonly format: "muse-mag-portable";
  readonly formatVersion: 1;
  readonly stateId: `mag-state:${string}`;
  readonly exportId: `mag-portable-record:${string}`;
  readonly scopes: number;
  readonly projections: number;
  readonly bytes: number;
}

export interface MagPortableEncoder {
  start(): Uint8Array;
  appendProjection(expectedScope: MagScope, projection: unknown): {
    readonly bytes: Uint8Array;
    readonly identity: MagPortableProjectionIdentity;
  };
  sealProjections(): void;
  appendHead(
    scope: MagScope,
    generation: number,
    commitId: string,
    projectionId: `mag-store:${string}`
  ): Uint8Array;
  finish(): {
    readonly bytes: Uint8Array;
    readonly report: MagPortableSummary;
  };
}

export type MagPortableFormatErrorCode =
  | "INVALID_INPUT"
  | "INVALID_STATE"
  | "INVALID_ORDER"
  | "LIMIT_EXCEEDED"
  | "REENTRY";

export class MagPortableFormatError extends Error {
  readonly code: MagPortableFormatErrorCode;

  constructor(code: MagPortableFormatErrorCode, message: string) {
    super(message);
    this.name = "MagPortableFormatError";
    this.code = code;
  }
}

type EncoderPhase = "idle" | "projections" | "heads" | "finished";
type SinkMethodName = keyof MagPortableEncoderIdentitySink;
type SinkMethods = {
  readonly [Name in SinkMethodName]: MagPortableEncoderIdentitySink[Name];
};

interface PreparedLine {
  readonly bytes: Uint8Array;
  readonly returnedBytes: Uint8Array;
  readonly recordId: `mag-portable-record:${string}`;
}

function formatError(
  code: MagPortableFormatErrorCode,
  message: string
): never {
  throw new MagPortableFormatError(code, message);
}

function closedDataRecord(
  value: unknown,
  label: string,
  expectedKeys: readonly string[]
): Record<string, unknown> {
  if (
    value === null
    || typeof value !== "object"
    || nodeTypes.isProxy(value)
  ) {
    formatError("INVALID_INPUT", `${label} must be a non-proxy record`);
  }
  const prototype = reflectGetPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    formatError("INVALID_INPUT", `${label} must be a plain record`);
  }
  const keys = reflectOwnKeys(value);
  if (
    keys.length !== expectedKeys.length
    || keys.some((key) => typeof key !== "string" || !expectedKeys.includes(key))
  ) {
    formatError("INVALID_INPUT", `${label} must have exactly the required fields`);
  }
  const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of expectedKeys) {
    const descriptor = objectGetOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor)) {
      formatError("INVALID_INPUT", `${label}.${key} must be a data property`);
    }
    output[key] = descriptor.value;
  }
  return output;
}

function captureSink(value: unknown): {
  readonly receiver: MagPortableEncoderIdentitySink;
  readonly methods: SinkMethods;
} {
  const keys = [
    "appendProjection",
    "sealProjections",
    "assertHead",
    "finish",
    "abort"
  ] as const;
  const input = closedDataRecord(value, "identity sink", keys);
  const methods = Object.create(null) as {
    -readonly [Name in SinkMethodName]: MagPortableEncoderIdentitySink[Name];
  };
  for (const key of keys) {
    const method = input[key];
    if (typeof method !== "function") {
      formatError("INVALID_INPUT", `identity sink.${key} must be a function`);
    }
    methods[key] = method as never;
  }
  return objectFreeze({
    receiver: value as MagPortableEncoderIdentitySink,
    methods: objectFreeze(methods)
  });
}

export function normalizeMagPortableEncoderBudgetsForInternalUse(
  value: unknown
): MagPortableEncoderBudgetsForInternalUse {
  if (
    value === null
    || typeof value !== "object"
    || nodeTypes.isProxy(value)
    || Array.isArray(value)
  ) {
    formatError("INVALID_INPUT", "portable encoder budgets must be a non-proxy record");
  }
  const prototype = reflectGetPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    formatError("INVALID_INPUT", "portable encoder budgets must be a plain record");
  }
  const keys = reflectOwnKeys(value);
  if (
    keys.length !== BUDGET_KEYS.length
    || keys.some((key) => typeof key !== "string" || !BUDGET_KEYS.includes(
      key as (typeof BUDGET_KEYS)[number]
    ))
  ) {
    formatError(
      "INVALID_INPUT",
      "portable encoder budgets must have exactly the required fields"
    );
  }
  const normalized = Object.create(null) as {
    -readonly [Key in keyof MagPortableEncoderBudgetsForInternalUse]: number;
  };
  for (const key of BUDGET_KEYS) {
    const descriptor = objectGetOwnPropertyDescriptor(value, key);
    if (
      descriptor === undefined
      || !descriptor.enumerable
      || !("value" in descriptor)
    ) {
      formatError(
        "INVALID_INPUT",
        `portable encoder budgets.${key} must be an enumerable data property`
      );
    }
    normalized[key] = positiveSafeInteger(
      descriptor.value,
      `portable encoder budgets.${key}`
    );
  }
  if (normalized.maxTotalRecords < 2) {
    formatError(
      "INVALID_INPUT",
      "portable encoder budgets.maxTotalRecords must be at least 2"
    );
  }
  return objectFreeze(normalized);
}

function line(
  unsignedRecord: Readonly<Record<string, unknown>>,
  edge: boolean,
  budgets: MagPortableEncoderBudgetsForInternalUse
): PreparedLine {
  const max = edge
    ? budgets.maxEdgeLineBytes
    : budgets.maxPortableLineBytes;
  let minted;
  try {
    minted = mintCanonicalImmutableEnvelopeFromFrozenUnsignedForInternalUse(
      unsignedRecord,
      RECORD_SPEC,
      objectFreeze({
        maxCanonicalBodyBytes: max,
        maxEnvelopeBytes: max
      })
    );
  } catch (cause) {
    if (
      cause instanceof CanonicalImmutableEnvelopeError
      && cause.code === "BUDGET_EXCEEDED"
      && (
        cause.details.axis === "canonical-body-bytes"
        || cause.details.axis === "full-envelope-bytes"
      )
    ) {
      formatError("LIMIT_EXCEEDED", "portable record line exceeds its byte limit");
    }
    throw cause;
  }
  const bytes = textEncoder.encode(`${minted.canonicalJson}\n`);
  if (bytes.byteLength - 1 > max) {
    formatError("LIMIT_EXCEEDED", "portable record line exceeds its byte limit");
  }
  return objectFreeze({
    bytes,
    returnedBytes: bytes.slice(),
    recordId: minted.contentId as `mag-portable-record:${string}`
  });
}

function compareBytes(left: Uint8Array, right: Uint8Array): number {
  const length = Math.min(left.byteLength, right.byteLength);
  for (let index = 0; index < length; index += 1) {
    const difference = left[index]! - right[index]!;
    if (difference !== 0) return difference;
  }
  return left.byteLength - right.byteLength;
}

function compareScopes(left: MagScope, right: MagScope): number {
  const source = compareBytes(
    textEncoder.encode(left.sourceId),
    textEncoder.encode(right.sourceId)
  );
  return source === 0
    ? compareBytes(
      textEncoder.encode(left.threadId),
      textEncoder.encode(right.threadId)
    )
    : source;
}

function positiveSafeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    formatError("INVALID_INPUT", `${label} must be a positive safe integer`);
  }
  return value as number;
}

function boundedText(value: unknown, label: string): string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value !== value.trim()
    || value.length > 512
  ) {
    formatError("INVALID_INPUT", `${label} must be bounded non-empty text`);
  }
  return value;
}

function projectionId(value: unknown): `mag-store:${string}` {
  if (typeof value !== "string" || !STORE_ID.test(value)) {
    formatError("INVALID_INPUT", "head projectionId is invalid");
  }
  return value as `mag-store:${string}`;
}

function checkedTotal(
  current: number,
  added: number,
  maxArtifactBytes: number
): number {
  const total = current + added;
  if (!Number.isSafeInteger(total) || total > maxArtifactBytes) {
    formatError("LIMIT_EXCEEDED", "portable artifact exceeds its byte limit");
  }
  return total;
}

function stateHashWith(lineBytes: Uint8Array): Hash {
  return createHash("sha256").update(STATE_HASH_DOMAIN, "utf8").update(lineBytes);
}

function createMagPortableEncoderWithBudgets(options: {
  readonly identitySink: MagPortableEncoderIdentitySink;
}, budgets: MagPortableEncoderBudgetsForInternalUse): MagPortableEncoder {
  const normalizedOptions = closedDataRecord(
    options,
    "portable encoder options",
    ["identitySink"]
  );
  const sink = captureSink(normalizedOptions.identitySink);

  let phase: EncoderPhase = "idle";
  let sequence = 0;
  let projectionCount = 0;
  let headCount = 0;
  let byteLength = 0;
  let manifestId: `mag-portable-record:${string}` | undefined;
  let stateHash: Hash | undefined;
  let lastProjection: MagPortableProjectionIdentity | undefined;
  let lastHeadScope: MagScope | undefined;

  let engaged = false;
  let insideSinkCallback = false;
  let callbackReentryFailure: MagPortableFormatError | undefined;
  let terminalPinned = false;
  let pinnedFailure: unknown;
  let abortCalled = false;

  const terminal = (cause: unknown): never => {
    if (!terminalPinned) {
      terminalPinned = true;
      pinnedFailure = cause;
    }
    if (engaged && !abortCalled) {
      abortCalled = true;
      try {
        reflectApply(sink.methods.abort, sink.receiver, [pinnedFailure]);
      } catch {
        // The original failure remains authoritative.
      }
    }
    throw pinnedFailure;
  };

  const execute = <Result>(operation: () => Result): Result => {
    if (terminalPinned) throw pinnedFailure;
    if (insideSinkCallback) {
      const failure = new MagPortableFormatError(
        "REENTRY",
        "portable encoder callback reentry is forbidden"
      );
      callbackReentryFailure ??= failure;
      throw failure;
    }
    try {
      return operation();
    } catch (cause) {
      if (engaged) return terminal(cause);
      throw cause;
    }
  };

  const invokeSink = <Name extends SinkMethodName>(
    name: Name,
    args: Parameters<MagPortableEncoderIdentitySink[Name]>
  ): void => {
    engaged = true;
    insideSinkCallback = true;
    callbackReentryFailure = undefined;
    let threw = false;
    let sinkFailure: unknown;
    try {
      reflectApply(sink.methods[name], sink.receiver, args);
    } catch (cause) {
      threw = true;
      sinkFailure = cause;
    }
    insideSinkCallback = false;
    const reentryFailure = callbackReentryFailure;
    callbackReentryFailure = undefined;
    if (reentryFailure !== undefined) throw reentryFailure;
    if (threw) throw sinkFailure;
  };

  return objectFreeze({
    start(): Uint8Array {
      return execute(() => {
        if (phase !== "idle") {
          formatError("INVALID_STATE", "portable encoder may start only once");
        }
        const prepared = line(objectFreeze({
          canonicalization: "muse-canonical-json-utf16@1",
          format: "muse-mag-portable",
          formatVersion: 1,
          hashAlgorithm: "sha-256",
          kind: "manifest",
          limitsProfile: "mag-portable-limits@1",
          schemaVersion: 1,
          sequence: 0,
          stateModel: "projection-journal-head@1"
        }), true, budgets);
        const nextHash = stateHashWith(prepared.bytes);
        const nextByteLength = checkedTotal(
          0,
          prepared.bytes.byteLength,
          budgets.maxArtifactBytes
        );

        phase = "projections";
        sequence = 1;
        byteLength = nextByteLength;
        manifestId = prepared.recordId;
        stateHash = nextHash;
        return prepared.returnedBytes;
      });
    },

    appendProjection(expectedScope: MagScope, projection: unknown) {
      return execute(() => {
        if (phase !== "projections") {
          formatError("INVALID_STATE", "projection phase is not active");
        }
        if (projectionCount >= budgets.maxProjections) {
          formatError("LIMIT_EXCEEDED", "portable projection count exceeds its limit");
        }
        const admitted = admitPortableProjection(projection, expectedScope);
        const identity: MagPortableProjectionIdentity = objectFreeze({
          scope: objectFreeze({
            sourceId: admitted.identity.scope.sourceId,
            threadId: admitted.identity.scope.threadId
          }),
          generation: admitted.identity.generation,
          commitId: admitted.identity.commitId,
          projectionId: admitted.identity.projectionId
        });
        if (lastProjection === undefined) {
          if (identity.generation !== 1) {
            formatError("INVALID_ORDER", "first projection generation must be 1");
          }
        } else {
          const scopeOrder = compareScopes(lastProjection.scope, identity.scope);
          if (scopeOrder > 0) {
            formatError("INVALID_ORDER", "projection scope order regressed");
          }
          if (scopeOrder === 0) {
            if (identity.generation !== lastProjection.generation + 1) {
              formatError("INVALID_ORDER", "projection generations must be contiguous");
            }
          } else if (identity.generation !== 1) {
            formatError("INVALID_ORDER", "each projection scope must begin at generation 1");
          }
        }
        const prepared = line(objectFreeze({
          kind: "projection",
          projection: admitted.projection,
          projectionId: identity.projectionId,
          schemaVersion: 1,
          sequence
        }), false, budgets);
        const nextProjectionCount = projectionCount + 1;
        const nextSequence = sequence + 1;
        const nextByteLength = checkedTotal(
          byteLength,
          prepared.bytes.byteLength,
          budgets.maxArtifactBytes
        );
        const nextHash = stateHash!.copy().update(prepared.bytes);
        if (2 + nextProjectionCount + headCount > budgets.maxTotalRecords) {
          formatError("LIMIT_EXCEEDED", "portable record count exceeds its limit");
        }
        const result = objectFreeze({
          bytes: prepared.returnedBytes,
          identity
        });

        invokeSink("appendProjection", [identity]);

        projectionCount = nextProjectionCount;
        sequence = nextSequence;
        byteLength = nextByteLength;
        stateHash = nextHash;
        lastProjection = identity;
        return result;
      });
    },

    sealProjections(): void {
      execute(() => {
        if (phase !== "projections") {
          formatError("INVALID_STATE", "projection phase may be sealed only once");
        }
        invokeSink("sealProjections", []);
        phase = "heads";
      });
    },

    appendHead(
      scope: MagScope,
      generation: number,
      commitId: string,
      rawProjectionId: `mag-store:${string}`
    ): Uint8Array {
      return execute(() => {
        if (phase !== "heads") {
          formatError("INVALID_STATE", "head phase is not active");
        }
        if (headCount >= budgets.maxHeads) {
          formatError("LIMIT_EXCEEDED", "portable head count exceeds its limit");
        }
        if (headCount >= budgets.maxScopes) {
          formatError("LIMIT_EXCEEDED", "portable scope count exceeds its limit");
        }
        const normalizedScope = normalizeMagScope(scope, "portable head scope");
        const normalizedGeneration = positiveSafeInteger(
          generation,
          "portable head generation"
        );
        const normalizedCommitId = boundedText(commitId, "portable head commitId");
        const normalizedProjectionId = projectionId(rawProjectionId);
        const detachedScope = objectFreeze({
          sourceId: normalizedScope.sourceId,
          threadId: normalizedScope.threadId
        });
        if (
          lastHeadScope !== undefined
          && compareScopes(lastHeadScope, detachedScope) >= 0
        ) {
          formatError("INVALID_ORDER", "head scopes must be unique and ordered");
        }
        const identity: MagPortableHeadIdentity = objectFreeze({
          scope: detachedScope,
          generation: normalizedGeneration,
          commitId: normalizedCommitId,
          projectionId: normalizedProjectionId
        });
        const prepared = line(objectFreeze({
          commitId: normalizedCommitId,
          generation: normalizedGeneration,
          kind: "head",
          projectionId: normalizedProjectionId,
          schemaVersion: 1,
          scope: detachedScope,
          sequence
        }), false, budgets);
        const nextHeadCount = headCount + 1;
        const nextSequence = sequence + 1;
        const nextByteLength = checkedTotal(
          byteLength,
          prepared.bytes.byteLength,
          budgets.maxArtifactBytes
        );
        const nextHash = stateHash!.copy().update(prepared.bytes);
        if (2 + projectionCount + nextHeadCount > budgets.maxTotalRecords) {
          formatError("LIMIT_EXCEEDED", "portable record count exceeds its limit");
        }

        invokeSink("assertHead", [identity]);

        headCount = nextHeadCount;
        sequence = nextSequence;
        byteLength = nextByteLength;
        stateHash = nextHash;
        lastHeadScope = detachedScope;
        return prepared.returnedBytes;
      });
    },

    finish() {
      return execute(() => {
        if (phase !== "heads") {
          formatError("INVALID_STATE", "portable encoder may finish only after sealing");
        }
        const stateId =
          `mag-state:${stateHash!.copy().digest("hex")}` as const;
        const priorRecordCount = 1 + projectionCount + headCount;
        if (priorRecordCount + 1 > budgets.maxTotalRecords) {
          formatError("LIMIT_EXCEEDED", "portable record count exceeds its limit");
        }
        const prepared = line(objectFreeze({
          headCount,
          kind: "footer",
          manifestId: manifestId!,
          priorByteLength: byteLength,
          priorRecordCount,
          projectionCount,
          schemaVersion: 1,
          scopeCount: headCount,
          sequence,
          stateId
        }), true, budgets);
        const finalByteLength = checkedTotal(
          byteLength,
          prepared.bytes.byteLength,
          budgets.maxArtifactBytes
        );
        const report: MagPortableSummary = objectFreeze({
          format: "muse-mag-portable",
          formatVersion: 1,
          stateId,
          exportId: prepared.recordId,
          scopes: headCount,
          projections: projectionCount,
          bytes: finalByteLength
        });
        const result = objectFreeze({
          bytes: prepared.returnedBytes,
          report
        });

        invokeSink("finish", [headCount, headCount]);

        phase = "finished";
        return result;
      });
    }
  });
}

export function createMagPortableEncoder(options: {
  readonly identitySink: MagPortableEncoderIdentitySink;
}): MagPortableEncoder {
  return createMagPortableEncoderWithBudgets(
    options,
    PRODUCTION_MAG_PORTABLE_BUDGETS_FOR_INTERNAL_USE
  );
}

export function createMagPortableEncoderForQualification(
  options: {
    readonly identitySink: MagPortableEncoderIdentitySink;
  },
  budgets: MagPortableEncoderBudgetsForInternalUse
): MagPortableEncoder {
  return createMagPortableEncoderWithBudgets(
    options,
    normalizeMagPortableEncoderBudgetsForInternalUse(budgets)
  );
}
