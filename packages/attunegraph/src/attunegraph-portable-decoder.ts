import { Buffer } from "node:buffer";
import { createHash, type Hash } from "node:crypto";
import { TextDecoder, TextEncoder, types as nodeTypes } from "node:util";

import {
  canonicalizeImmutableEnvelope
} from "./canonical-immutable-envelope.js";
import type { AttuneGraphScope } from "./attunegraph-contracts.js";
import { normalizeAttuneGraphScope } from "./attunegraph-engine.js";
import { admitPortableProjectionForDecoder } from "./attunegraph-portable-admission.js";
import {
  AttuneGraphPortableFormatError,
  normalizeAttuneGraphPortableEncoderBudgetsForInternalUse,
  PRODUCTION_ATTUNEGRAPH_PORTABLE_BUDGETS_FOR_INTERNAL_USE,
  type AttuneGraphPortableEncoderBudgetsForInternalUse,
  type AttuneGraphPortableHeadIdentity,
  type AttuneGraphPortableProjectionIdentity,
  type AttuneGraphPortableSummary
} from "./attunegraph-portable-encoder.js";

const RECORD_SPEC = Object.freeze({
  hashDomain: "attunegraph.portable-record.v1",
  idField: "recordId",
  idPrefix: "attunegraph-portable-record:"
} as const);
const STATE_HASH_DOMAIN = "attunegraph.portable-state.v1\0";
const PORTABLE_ID = /^attunegraph-portable-record:[0-9a-f]{64}$/u;
const STORE_ID = /^attunegraph-store:[0-9a-f]{64}$/u;
const STATE_ID = /^attunegraph-state:[0-9a-f]{64}$/u;
const INCOMPATIBLE_FORMAT = new TextDecoder("utf8", { fatal: true }).decode(
  Uint8Array.of(109, 117, 115, 101, 45, 109, 97, 103, 45, 112, 111, 114, 116, 97, 98, 108, 101)
);
const textDecoder = new TextDecoder("utf8", { fatal: true });
const textEncoder = new TextEncoder();
const objectFreeze = Object.freeze;
const objectGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
const reflectApply = Reflect.apply;
const reflectGetPrototypeOf = Reflect.getPrototypeOf;
const reflectOwnKeys = Reflect.ownKeys;

export type AttuneGraphPortableDecoderErrorCode =
  | "INVALID_INPUT"
  | "INVALID_STATE"
  | "REENTRY"
  | "LIMIT_EXCEEDED"
  | "CORRUPT_PORTABLE_EXPORT"
  | "FUTURE_PORTABLE_EXPORT"
  | "INCOMPATIBLE_PORTABLE_FORMAT";

export class AttuneGraphPortableDecoderError extends Error {
  readonly code: AttuneGraphPortableDecoderErrorCode;

  constructor(
    code: AttuneGraphPortableDecoderErrorCode,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "AttuneGraphPortableDecoderError";
    this.code = code;
  }
}

export interface AttuneGraphPortableDecoderValidationSink {
  appendProjection(
    identity: AttuneGraphPortableProjectionIdentity
  ): void | Promise<void>;
  sealProjections(): void | Promise<void>;
  assertHead(identity: AttuneGraphPortableHeadIdentity): void | Promise<void>;
  finish(
    expectedScopeCount: number,
    expectedHeadCount: number
  ): void | Promise<void>;
  abort(cause: unknown): void | Promise<void>;
}

export interface AttuneGraphPortableDecoder {
  write(chunk: Uint8Array): Promise<void>;
  finish(): Promise<AttuneGraphPortableSummary>;
}

type DecoderPhase = "manifest" | "projections" | "heads" | "footer";
type SinkMethodName = keyof AttuneGraphPortableDecoderValidationSink;
type SinkMethods = {
  readonly [Name in SinkMethodName]: AttuneGraphPortableDecoderValidationSink[Name];
};
type JsonRecord = Record<string, unknown>;

function decoderError(
  code: AttuneGraphPortableDecoderErrorCode,
  message: string,
  options?: ErrorOptions
): never {
  throw new AttuneGraphPortableDecoderError(code, message, options);
}

function sanitizedCause(message: string): Error {
  const cause = new Error(message);
  cause.name = "AttuneGraphPortableDecoderValidationCause";
  return cause;
}

function corrupt(message: string): never {
  decoderError(
    "CORRUPT_PORTABLE_EXPORT",
    message,
    { cause: sanitizedCause("portable input validation failed") }
  );
}

function closedDataRecord(
  value: unknown,
  label: string,
  expectedKeys: readonly string[],
  code: "INVALID_INPUT" | "CORRUPT_PORTABLE_EXPORT"
): JsonRecord {
  if (
    value === null
    || typeof value !== "object"
    || nodeTypes.isProxy(value)
    || Array.isArray(value)
  ) {
    decoderError(code, `${label} must be a non-proxy record`);
  }
  const prototype = reflectGetPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    decoderError(code, `${label} must be a plain record`);
  }
  const keys = reflectOwnKeys(value);
  if (
    keys.length !== expectedKeys.length
    || keys.some((key) =>
      typeof key !== "string" || !expectedKeys.includes(key)
    )
  ) {
    decoderError(code, `${label} must have exactly the required fields`);
  }
  const output = Object.create(null) as JsonRecord;
  for (const key of expectedKeys) {
    const descriptor = objectGetOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor)) {
      decoderError(code, `${label}.${key} must be a data property`);
    }
    output[key] = descriptor.value;
  }
  return output;
}

function captureSink(value: unknown): {
  readonly receiver: AttuneGraphPortableDecoderValidationSink;
  readonly methods: SinkMethods;
} {
  const keys = [
    "appendProjection",
    "sealProjections",
    "assertHead",
    "finish",
    "abort"
  ] as const;
  const input = closedDataRecord(
    value,
    "portable decoder validation sink",
    keys,
    "INVALID_INPUT"
  );
  const methods = Object.create(null) as {
    -readonly [Name in SinkMethodName]: AttuneGraphPortableDecoderValidationSink[Name];
  };
  for (const key of keys) {
    const method = input[key];
    if (typeof method !== "function") {
      decoderError(
        "INVALID_INPUT",
        `portable decoder validation sink.${key} must be a function`
      );
    }
    methods[key] = method as never;
  }
  return objectFreeze({
    receiver: value as AttuneGraphPortableDecoderValidationSink,
    methods: objectFreeze(methods)
  });
}

function detachedChunk(value: unknown): Uint8Array {
  if (
    value === null
    || typeof value !== "object"
    || nodeTypes.isProxy(value)
    || !(value instanceof Uint8Array)
  ) {
    decoderError("INVALID_INPUT", "portable decoder chunk must be a Uint8Array");
  }
  const prototype = reflectGetPrototypeOf(value);
  if (prototype !== Uint8Array.prototype && !Buffer.isBuffer(value)) {
    decoderError(
      "INVALID_INPUT",
      "portable decoder chunk must not be an exotic byte view"
    );
  }
  let buffer: ArrayBufferLike;
  try {
    buffer = value.buffer;
  } catch {
    decoderError("INVALID_INPUT", "portable decoder chunk must be readable");
  }
  if (
    (
      typeof SharedArrayBuffer !== "undefined"
      && buffer instanceof SharedArrayBuffer
    )
    || (
      buffer instanceof ArrayBuffer
      && "resizable" in buffer
      && buffer.resizable
    )
  ) {
    decoderError(
      "INVALID_INPUT",
      "portable decoder chunk must use a fixed private ArrayBuffer"
    );
  }
  try {
    return reflectApply(Uint8Array.prototype.slice, value, []) as Uint8Array;
  } catch {
    decoderError("INVALID_INPUT", "portable decoder chunk must not be detached");
  }
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function canonicalRecord(
  bytes: Uint8Array,
  firstRecord: boolean
): JsonRecord {
  let text: string;
  try {
    text = textDecoder.decode(bytes);
  } catch {
    corrupt("portable record is not fatal UTF-8");
  }
  if (text.startsWith("\uFEFF")) {
    corrupt("portable export must not contain a UTF-8 BOM");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    corrupt("portable record is not valid JSON");
  }
  if (
    firstRecord
    && parsed !== null
    && typeof parsed === "object"
    && !Array.isArray(parsed)
  ) {
    const manifest = parsed as JsonRecord;
    if (
      manifest.kind === "manifest"
      && manifest.format === INCOMPATIBLE_FORMAT
    ) {
      decoderError(
        "INCOMPATIBLE_PORTABLE_FORMAT",
        "portable export uses an incompatible format identity"
      );
    }
    if (
      manifest.kind === "manifest"
      && manifest.format === "attunegraph-portable"
      && Number.isSafeInteger(manifest.formatVersion)
      && (manifest.formatVersion as number) > 1
    ) {
      decoderError(
        "FUTURE_PORTABLE_EXPORT",
        "portable export format version is newer than this decoder"
      );
    }
  }
  try {
    const canonical = canonicalizeImmutableEnvelope(
      parsed,
      "external-mutable",
      RECORD_SPEC
    );
    if (!sameBytes(textEncoder.encode(canonical.canonicalJson), bytes)) {
      corrupt("portable record is not exact canonical JSON");
    }
    return canonical.envelope as JsonRecord;
  } catch (cause) {
    if (cause instanceof AttuneGraphPortableDecoderError) throw cause;
    corrupt("portable record failed canonical identity validation");
  }
}

function safeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    corrupt(`${label} must be a non-negative safe integer`);
  }
  return value as number;
}

function positiveSafeInteger(value: unknown, label: string): number {
  const result = safeInteger(value, label);
  if (result < 1) corrupt(`${label} must be positive`);
  return result;
}

function boundedText(value: unknown, label: string): string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value !== value.trim()
    || value.length > 512
  ) {
    corrupt(`${label} must be bounded non-empty text`);
  }
  return value;
}

function portableId(value: unknown, label: string): string {
  if (typeof value !== "string" || !PORTABLE_ID.test(value)) {
    corrupt(`${label} is invalid`);
  }
  return value;
}

function storeId(value: unknown, label: string): `attunegraph-store:${string}` {
  if (typeof value !== "string" || !STORE_ID.test(value)) {
    corrupt(`${label} is invalid`);
  }
  return value as `attunegraph-store:${string}`;
}

function stateId(value: unknown): `attunegraph-state:${string}` {
  if (typeof value !== "string" || !STATE_ID.test(value)) {
    corrupt("portable footer stateId is invalid");
  }
  return value as `attunegraph-state:${string}`;
}

function compareBytes(left: Uint8Array, right: Uint8Array): number {
  const length = Math.min(left.byteLength, right.byteLength);
  for (let index = 0; index < length; index += 1) {
    const difference = left[index]! - right[index]!;
    if (difference !== 0) return difference;
  }
  return left.byteLength - right.byteLength;
}

function compareScopes(left: AttuneGraphScope, right: AttuneGraphScope): number {
  return compareBytes(
    textEncoder.encode(left.sourceId),
    textEncoder.encode(right.sourceId)
  ) || compareBytes(
    textEncoder.encode(left.threadId),
    textEncoder.encode(right.threadId)
  );
}

function decoderBudgets(
  qualificationLimits: AttuneGraphPortableEncoderBudgetsForInternalUse | undefined
): AttuneGraphPortableEncoderBudgetsForInternalUse {
  if (qualificationLimits === undefined) {
    return PRODUCTION_ATTUNEGRAPH_PORTABLE_BUDGETS_FOR_INTERNAL_USE;
  }
  try {
    return normalizeAttuneGraphPortableEncoderBudgetsForInternalUse(
      qualificationLimits
    );
  } catch (cause) {
    if (
      cause instanceof AttuneGraphPortableFormatError
      && cause.code === "INVALID_INPUT"
    ) {
      decoderError("INVALID_INPUT", "portable decoder limits are invalid");
    }
    throw cause;
  }
}

export function createAttuneGraphPortableDecoder(
  validationSink: AttuneGraphPortableDecoderValidationSink,
  qualificationLimits?: AttuneGraphPortableEncoderBudgetsForInternalUse
): AttuneGraphPortableDecoder {
  const sink = captureSink(validationSink);
  const budgets = decoderBudgets(qualificationLimits);

  let phase: DecoderPhase = "manifest";
  let currentLine: number[] = [];
  let artifactBytes = 0;
  let priorByteLength = 0;
  let recordCount = 0;
  let projectionCount = 0;
  let headCount = 0;
  let manifestId: string | undefined;
  let stateHash: Hash | undefined;
  let lastProjection: AttuneGraphPortableProjectionIdentity | undefined;
  let lastHeadScope: AttuneGraphScope | undefined;
  let report: AttuneGraphPortableSummary | undefined;
  let apiFinished = false;

  let operationActive = false;
  let terminalPinned = false;
  let terminalFailure: unknown;
  let engaged = false;
  let abortPromise: Promise<void> | undefined;

  const abortOnce = (): Promise<void> => {
    if (!engaged) return Promise.resolve();
    abortPromise ??= (async () => {
      try {
        await reflectApply(
          sink.methods.abort,
          sink.receiver,
          [terminalFailure]
        );
      } catch {
        // The original decoder or sink failure remains authoritative.
      }
    })();
    return abortPromise;
  };

  const checkpoint = async (): Promise<void> => {
    if (terminalPinned) {
      await abortOnce();
      throw terminalFailure;
    }
  };

  const pinFailure = async (cause: unknown): Promise<never> => {
    if (!terminalPinned) {
      terminalPinned = true;
      terminalFailure = cause;
    }
    await abortOnce();
    throw terminalFailure;
  };

  const invokeSink = async <Name extends SinkMethodName>(
    name: Name,
    args: Parameters<AttuneGraphPortableDecoderValidationSink[Name]>
  ): Promise<void> => {
    await checkpoint();
    engaged = true;
    await reflectApply(sink.methods[name], sink.receiver, args);
    await checkpoint();
  };

  const sealIfNeeded = async (): Promise<void> => {
    if (phase !== "projections") return;
    await invokeSink("sealProjections", []);
    await checkpoint();
    phase = "heads";
  };

  const commitNonFooterLine = (
    lineWithLf: Uint8Array,
    nextHash: Hash
  ): void => {
    stateHash = nextHash;
    priorByteLength += lineWithLf.byteLength;
    recordCount += 1;
  };

  const processManifest = (record: JsonRecord, lineWithLf: Uint8Array): void => {
    const value = closedDataRecord(
      record,
      "portable manifest",
      [
        "canonicalization",
        "format",
        "formatVersion",
        "hashAlgorithm",
        "kind",
        "limitsProfile",
        "recordId",
        "schemaVersion",
        "sequence",
        "stateModel"
      ],
      "CORRUPT_PORTABLE_EXPORT"
    );
    if (
      value.canonicalization !== "attunegraph-canonical-json-utf16@1"
      || value.format !== "attunegraph-portable"
      || value.formatVersion !== 1
      || value.hashAlgorithm !== "sha-256"
      || value.kind !== "manifest"
      || value.limitsProfile !== "attunegraph-portable-limits@1"
      || value.schemaVersion !== 1
      || value.sequence !== 0
      || value.stateModel !== "projection-journal-head@1"
    ) {
      corrupt("portable manifest contract is invalid");
    }
    const nextManifestId = portableId(
      value.recordId,
      "portable manifest recordId"
    );
    manifestId = nextManifestId;
    stateHash = createHash("sha256")
      .update(STATE_HASH_DOMAIN, "utf8")
      .update(lineWithLf);
    priorByteLength = lineWithLf.byteLength;
    recordCount = 1;
    phase = "projections";
  };

  const processProjection = async (
    record: JsonRecord,
    lineWithLf: Uint8Array
  ): Promise<void> => {
    if (phase !== "projections") {
      corrupt("portable projection phase regressed");
    }
    if (projectionCount >= budgets.maxProjections) {
      decoderError(
        "LIMIT_EXCEEDED",
        "portable projection count exceeds its limit"
      );
    }
    const value = closedDataRecord(
      record,
      "portable projection record",
      [
        "kind",
        "projection",
        "projectionId",
        "recordId",
        "schemaVersion",
        "sequence"
      ],
      "CORRUPT_PORTABLE_EXPORT"
    );
    if (
      value.kind !== "projection"
      || value.schemaVersion !== 1
      || safeInteger(value.sequence, "portable projection sequence")
        !== recordCount
    ) {
      corrupt("portable projection record contract is invalid");
    }
    storeId(value.projectionId, "portable projection projectionId");
    let admitted;
    try {
      admitted = admitPortableProjectionForDecoder(value.projection);
    } catch {
      corrupt("portable projection failed exact Engine admission");
    }
    if (value.projectionId !== admitted.identity.projectionId) {
      corrupt("portable projection identity does not match its stored projection");
    }
    const identity = admitted.identity;
    if (lastProjection === undefined) {
      if (identity.generation !== 1) {
        corrupt("first portable projection generation must be 1");
      }
    } else {
      const scopeOrder = compareScopes(lastProjection.scope, identity.scope);
      if (scopeOrder > 0) corrupt("portable projection scope order regressed");
      if (
        scopeOrder === 0
          ? identity.generation !== lastProjection.generation + 1
          : identity.generation !== 1
      ) {
        corrupt("portable projection generations are not contiguous");
      }
    }
    const nextProjectionCount = projectionCount + 1;
    if (2 + nextProjectionCount + headCount > budgets.maxTotalRecords) {
      decoderError("LIMIT_EXCEEDED", "portable record count exceeds its limit");
    }
    const nextHash = stateHash!.copy().update(lineWithLf);
    await invokeSink("appendProjection", [identity]);
    await checkpoint();
    projectionCount = nextProjectionCount;
    lastProjection = identity;
    commitNonFooterLine(lineWithLf, nextHash);
  };

  const processHead = async (
    record: JsonRecord,
    lineWithLf: Uint8Array
  ): Promise<void> => {
    if (phase !== "projections" && phase !== "heads") {
      corrupt("portable head phase regressed");
    }
    if (headCount >= budgets.maxHeads) {
      decoderError("LIMIT_EXCEEDED", "portable head count exceeds its limit");
    }
    if (headCount >= budgets.maxScopes) {
      decoderError("LIMIT_EXCEEDED", "portable scope count exceeds its limit");
    }
    const value = closedDataRecord(
      record,
      "portable head record",
      [
        "commitId",
        "generation",
        "kind",
        "projectionId",
        "recordId",
        "schemaVersion",
        "scope",
        "sequence"
      ],
      "CORRUPT_PORTABLE_EXPORT"
    );
    if (
      value.kind !== "head"
      || value.schemaVersion !== 1
      || safeInteger(value.sequence, "portable head sequence") !== recordCount
    ) {
      corrupt("portable head record contract is invalid");
    }
    let scope: AttuneGraphScope;
    try {
      scope = normalizeAttuneGraphScope(
        value.scope,
        "portable decoder head scope",
        "CORRUPT_STORE"
      );
    } catch {
      corrupt("portable head scope is invalid");
    }
    if (
      lastHeadScope !== undefined
      && compareScopes(lastHeadScope, scope) >= 0
    ) {
      corrupt("portable head scopes must be unique and ordered");
    }
    const identity: AttuneGraphPortableHeadIdentity = objectFreeze({
      scope: objectFreeze({
        sourceId: scope.sourceId,
        threadId: scope.threadId
      }),
      generation: positiveSafeInteger(
        value.generation,
        "portable head generation"
      ),
      commitId: boundedText(value.commitId, "portable head commitId"),
      projectionId: storeId(
        value.projectionId,
        "portable head projectionId"
      )
    });
    const nextHeadCount = headCount + 1;
    if (2 + projectionCount + nextHeadCount > budgets.maxTotalRecords) {
      decoderError("LIMIT_EXCEEDED", "portable record count exceeds its limit");
    }
    const nextHash = stateHash!.copy().update(lineWithLf);
    await sealIfNeeded();
    await invokeSink("assertHead", [identity]);
    await checkpoint();
    headCount = nextHeadCount;
    lastHeadScope = identity.scope;
    commitNonFooterLine(lineWithLf, nextHash);
  };

  const processFooter = async (
    record: JsonRecord,
    lineBytes: Uint8Array
  ): Promise<void> => {
    if (phase !== "projections" && phase !== "heads") {
      corrupt("portable footer phase regressed");
    }
    if (lineBytes.byteLength > budgets.maxEdgeLineBytes) {
      decoderError(
        "LIMIT_EXCEEDED",
        "portable edge record line exceeds its byte limit"
      );
    }
    const value = closedDataRecord(
      record,
      "portable footer",
      [
        "headCount",
        "kind",
        "manifestId",
        "priorByteLength",
        "priorRecordCount",
        "projectionCount",
        "recordId",
        "schemaVersion",
        "scopeCount",
        "sequence",
        "stateId"
      ],
      "CORRUPT_PORTABLE_EXPORT"
    );
    const expectedStateId =
      `attunegraph-state:${stateHash!.copy().digest("hex")}` as const;
    const footerStateId = stateId(value.stateId);
    const footerHeadCount = safeInteger(
      value.headCount,
      "portable footer headCount"
    );
    const footerScopeCount = safeInteger(
      value.scopeCount,
      "portable footer scopeCount"
    );
    const priorRecordCount = 1 + projectionCount + headCount;
    if (
      value.kind !== "footer"
      || value.schemaVersion !== 1
      || safeInteger(value.sequence, "portable footer sequence") !== recordCount
      || portableId(value.manifestId, "portable footer manifestId") !== manifestId
      || safeInteger(
        value.priorRecordCount,
        "portable footer priorRecordCount"
      ) !== priorRecordCount
      || safeInteger(
        value.priorByteLength,
        "portable footer priorByteLength"
      ) !== priorByteLength
      || safeInteger(
        value.projectionCount,
        "portable footer projectionCount"
      ) !== projectionCount
      || footerHeadCount !== headCount
      || footerScopeCount !== headCount
      || footerHeadCount !== footerScopeCount
      || footerStateId !== expectedStateId
    ) {
      corrupt("portable footer contract is invalid");
    }
    if (recordCount + 1 > budgets.maxTotalRecords) {
      decoderError("LIMIT_EXCEEDED", "portable record count exceeds its limit");
    }
    const exportId = portableId(
      value.recordId,
      "portable footer recordId"
    ) as `attunegraph-portable-record:${string}`;
    await sealIfNeeded();
    await invokeSink("finish", [footerScopeCount, footerHeadCount]);
    await checkpoint();
    recordCount += 1;
    phase = "footer";
    report = objectFreeze({
      format: "attunegraph-portable",
      formatVersion: 1,
      stateId: footerStateId,
      exportId,
      scopes: footerScopeCount,
      projections: projectionCount,
      bytes: artifactBytes
    });
  };

  const processLine = async (lineBytes: Uint8Array): Promise<void> => {
    if (lineBytes.byteLength === 0) corrupt("portable export contains a blank line");
    const record = canonicalRecord(lineBytes, recordCount === 0);
    const kind = record.kind;
    const lineWithLf = new Uint8Array(lineBytes.byteLength + 1);
    lineWithLf.set(lineBytes);
    lineWithLf[lineBytes.byteLength] = 0x0a;
    if (recordCount === 0) {
      if (kind !== "manifest") corrupt("portable export must begin with a manifest");
      processManifest(record, lineWithLf);
      return;
    }
    if (kind === "projection") {
      await processProjection(record, lineWithLf);
      return;
    }
    if (kind === "head") {
      await processHead(record, lineWithLf);
      return;
    }
    if (kind === "footer") {
      await processFooter(record, lineBytes);
      return;
    }
    corrupt("portable record kind is invalid");
  };

  const processChunk = async (chunk: Uint8Array): Promise<void> => {
    for (let index = 0; index < chunk.byteLength; index += 1) {
      if (phase === "footer") {
        corrupt("portable export contains bytes after the footer");
      }
      if (artifactBytes >= budgets.maxArtifactBytes) {
        decoderError(
          "LIMIT_EXCEEDED",
          "portable artifact exceeds its byte limit"
        );
      }
      const byte = chunk[index]!;
      artifactBytes += 1;
      if (byte === 0x0a) {
        const line = Uint8Array.from(currentLine);
        await processLine(line);
        await checkpoint();
        currentLine = [];
        continue;
      }
      const maxLineBytes = recordCount === 0
        ? budgets.maxEdgeLineBytes
        : budgets.maxPortableLineBytes;
      if (currentLine.length >= maxLineBytes) {
        decoderError(
          "LIMIT_EXCEEDED",
          "portable record line exceeds its byte limit"
        );
      }
      currentLine.push(byte);
    }
  };

  const run = <Result>(
    operation: () => Promise<Result>
  ): Promise<Result> => {
    if (terminalPinned) return Promise.reject(terminalFailure);
    if (apiFinished) {
      return Promise.reject(new AttuneGraphPortableDecoderError(
        "INVALID_STATE",
        "portable decoder is already finished"
      ));
    }
    if (operationActive) {
      const failure = new AttuneGraphPortableDecoderError(
        "REENTRY",
        "portable decoder operation reentry is forbidden"
      );
      return pinFailure(failure);
    }
    operationActive = true;
    return (async () => {
      try {
        const result = await operation();
        await checkpoint();
        return result;
      } catch (cause) {
        return pinFailure(cause);
      } finally {
        operationActive = false;
      }
    })();
  };

  return objectFreeze({
    write(chunk: Uint8Array): Promise<void> {
      return run(async () => {
        const copy = detachedChunk(chunk);
        await processChunk(copy);
      });
    },

    finish(): Promise<AttuneGraphPortableSummary> {
      return run(async () => {
        await checkpoint();
        if (currentLine.length !== 0) {
          corrupt("portable export is missing its final LF");
        }
        if (report === undefined || phase !== "footer") {
          corrupt("portable export is empty or truncated");
        }
        await checkpoint();
        apiFinished = true;
        return report;
      });
    }
  });
}
