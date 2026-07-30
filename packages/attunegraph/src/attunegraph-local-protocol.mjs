import { Buffer } from "node:buffer";
import { types as nodeTypes } from "node:util";
import { parseProjection } from "./attunegraph-local-projection.mjs";
import { ATTUNEGRAPH_PHYSICAL_SCHEMA_V1 } from "./attunegraph-physical-schema-v1.mjs";
export const PROTOCOL_VERSION = 1;
export const MAX_ENVELOPE_BYTES = 2_097_152;
export const APPLICATION_ID = ATTUNEGRAPH_PHYSICAL_SCHEMA_V1.applicationId;
export const USER_VERSION = ATTUNEGRAPH_PHYSICAL_SCHEMA_V1.userVersion;
/** @typedef {"CORRUPT_STORE" | "FUTURE_STORE_STATE" | "INCOMPATIBLE_STORE_PROFILE" | "STORE_FAILURE" | "UNSUPPORTED_STORE_PROFILE"} SerializedErrorCode */
/** @typedef {"initialize" | "read" | "compareAndSwap" | "holdWriteLockForTesting" | "inspectForTesting" | "mutateForTesting" | "close"} WorkerRequestType */
/** @typedef {"future-user-version" | "wrong-application-id" | "malformed-projection-json" | "missing-journal-row" | "partial-bootstrap" | "oversized-projection-json" | "mismatched-head" | "quick-check-corruption"} TestMutation */
/** @typedef {import("./attunegraph-contracts.js").AttuneGraphScope} AttuneGraphScope */
/** @typedef {import("./attunegraph-contracts.js").AttuneGraphSnapshot} AttuneGraphSnapshot */
/** @typedef {import("./attunegraph-backend.js").AttuneGraphStoredProjection} AttuneGraphStoredProjection */
/** @typedef {null | boolean | number | string | readonly JsonData[] | { readonly [key: string]: JsonData }} JsonData */

/** @typedef {{ readonly databasePath: string }} InitializePayload */
/** @typedef {{ readonly scope: AttuneGraphScope }} ReadPayload */
/** @typedef {{ readonly scope: AttuneGraphScope, readonly expected: AttuneGraphSnapshot | null, readonly proposed: AttuneGraphStoredProjection }} CompareAndSwapPayload */
/** @typedef {{ readonly durationMs: number }} HoldWriteLockPayload */
/** @typedef {{ readonly mutation: TestMutation }} MutatePayload */
/** @typedef {Readonly<Record<never, never>>} EmptyPayload */

/** @typedef {{ readonly protocolVersion: 1, readonly id: number, readonly type: "initialize", readonly payload: InitializePayload }} InitializeRequest */
/** @typedef {{ readonly protocolVersion: 1, readonly id: number, readonly type: "read", readonly payload: ReadPayload }} ReadRequest */
/** @typedef {{ readonly protocolVersion: 1, readonly id: number, readonly type: "compareAndSwap", readonly payload: CompareAndSwapPayload }} CompareAndSwapRequest */
/** @typedef {{ readonly protocolVersion: 1, readonly id: number, readonly type: "holdWriteLockForTesting", readonly payload: HoldWriteLockPayload }} HoldWriteLockRequest */
/** @typedef {{ readonly protocolVersion: 1, readonly id: number, readonly type: "inspectForTesting", readonly payload: EmptyPayload }} InspectRequest */
/** @typedef {{ readonly protocolVersion: 1, readonly id: number, readonly type: "mutateForTesting", readonly payload: MutatePayload }} MutateRequest */
/** @typedef {{ readonly protocolVersion: 1, readonly id: number, readonly type: "close", readonly payload: EmptyPayload }} CloseRequest */
/** @typedef {InitializeRequest | ReadRequest | CompareAndSwapRequest | HoldWriteLockRequest | InspectRequest | MutateRequest | CloseRequest} WorkerRequest */
/** @typedef {{ readonly applicationId: number, readonly profileVersion: 1, readonly protocolVersion: 1, readonly sqliteVersion: string, readonly userVersion: 1 }} InitializeResult */
/** @typedef {{ readonly found: false } | { readonly found: true, readonly projection: AttuneGraphStoredProjection }} ReadResult */
/** @typedef {{ readonly committed: boolean }} CompareAndSwapResult */
/** @typedef {{ readonly acquired: true }} HoldWriteLockResult */
/** @typedef {{ readonly headRows: number, readonly journalRows: number, readonly maxGeneration: number }} InspectResult */
/** @typedef {{ readonly mutated: true }} MutateResult */
/** @typedef {{ readonly closed: true }} CloseResult */
/** @typedef {InitializeResult | ReadResult | CompareAndSwapResult | HoldWriteLockResult | InspectResult | MutateResult | CloseResult} WorkerResult */
/** @typedef {{ readonly code: SerializedErrorCode, readonly message: string }} SerializedError */
/** @typedef {{ readonly protocolVersion: 1, readonly id: number, readonly ok: true, readonly result: WorkerResult }} WorkerSuccessResponse */
/** @typedef {{ readonly protocolVersion: 1, readonly id: number, readonly ok: false, readonly error: SerializedError }} WorkerErrorResponse */
/** @typedef {WorkerSuccessResponse | WorkerErrorResponse} WorkerResponse */
const ERROR_CODES = /** @type {ReadonlySet<SerializedErrorCode>} */ (new Set([
  "CORRUPT_STORE",
  "FUTURE_STORE_STATE",
  "INCOMPATIBLE_STORE_PROFILE",
  "STORE_FAILURE",
  "UNSUPPORTED_STORE_PROFILE"
]));
const REQUEST_TYPES = /** @type {ReadonlySet<WorkerRequestType>} */ (new Set([
  "initialize",
  "read",
  "compareAndSwap",
  "holdWriteLockForTesting",
  "inspectForTesting",
  "mutateForTesting",
  "close"
]));
const TEST_MUTATIONS = /** @type {ReadonlySet<TestMutation>} */ (new Set([
  "future-user-version",
  "wrong-application-id",
  "malformed-projection-json",
  "missing-journal-row",
  "partial-bootstrap",
  "oversized-projection-json",
  "mismatched-head",
  "quick-check-corruption"
]));

export class AttuneGraphLocalProtocolError extends Error {
  /** @readonly @type {SerializedErrorCode} */
  attuneGraphCode;

  /**
   * @param {SerializedErrorCode} code
   * @param {string} message
   * @param {unknown} [cause]
   */
  constructor(code, message, cause) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "AttuneGraphLocalProtocolError";
    this.attuneGraphCode = code;
  }
}

/**
 * @param {SerializedErrorCode} code
 * @param {string} message
 * @param {unknown} [cause]
 * @returns {never}
 */
export function fail(code, message, cause) {
  throw new AttuneGraphLocalProtocolError(code, message, cause);
}
/**
 * @param {unknown} value
 * @param {string} label
 * @param {readonly string[]} allowed
 * @param {readonly string[]} [required]
 * @returns {Record<string, unknown>}
 */
export function plainRecord(value, label, allowed, required = allowed) {
  if (
    value === null
    || typeof value !== "object"
    || Array.isArray(value)
    || nodeTypes.isProxy(value)
  ) {
    fail("STORE_FAILURE", `${label} must be a plain object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    fail("STORE_FAILURE", `${label} must be a plain object`);
  }
  const ownKeys = Reflect.ownKeys(value);
  if (
    ownKeys.some((key) => typeof key !== "string" || !allowed.includes(key))
    || required.some((key) => !Object.hasOwn(value, key))
  ) {
    fail("STORE_FAILURE", `${label} has unknown or missing fields`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.values(descriptors).some((descriptor) =>
    !descriptor.enumerable || !Object.hasOwn(descriptor, "value")
  )) {
    fail("STORE_FAILURE", `${label} fields must be enumerable data properties`);
  }
  return /** @type {Record<string, unknown>} */ (value);
}

/**
 * Clones only descriptor-safe JSON data. No accessor, proxy trap, toJSON hook,
 * inherited value, sparse array hole, symbol, or exotic prototype is retained.
 * @param {unknown} value
 * @param {string} [label]
 * @param {WeakSet<object>} [ancestors]
 * @returns {JsonData}
 */
export function admitJsonData(value, label = "JSON value", ancestors = new WeakSet()) {
  if (
    value === null
    || typeof value === "string"
    || typeof value === "boolean"
  ) return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("STORE_FAILURE", `${label} contains a non-finite number`);
    return value;
  }
  if (typeof value !== "object" || nodeTypes.isProxy(value)) {
    fail("STORE_FAILURE", `${label} is not safe JSON data`);
  }
  if (ancestors.has(value)) fail("STORE_FAILURE", `${label} contains a cycle`);
  ancestors.add(value);
  try {
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const ownKeys = Reflect.ownKeys(value);
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) {
        fail("STORE_FAILURE", `${label} array has an unsupported prototype`);
      }
      const lengthDescriptor = descriptors.length;
      if (
        lengthDescriptor === undefined
        || !Object.hasOwn(lengthDescriptor, "value")
        || typeof lengthDescriptor.value !== "number"
      ) fail("STORE_FAILURE", `${label} array length is invalid`);
      const length = lengthDescriptor.value;
      const dataKeys = ownKeys.filter((key) => key !== "length");
      if (dataKeys.length !== length) {
        fail("STORE_FAILURE", `${label} array is sparse or has extra fields`);
      }
      return Object.freeze(dataKeys.map((key, index) => {
        if (key !== String(index)) {
          fail("STORE_FAILURE", `${label} array is sparse or has extra fields`);
        }
        const descriptor = descriptors[key];
        if (
          descriptor === undefined
          || !descriptor.enumerable
          || !Object.hasOwn(descriptor, "value")
        ) fail("STORE_FAILURE", `${label}[${key}] must be an enumerable data property`);
        return admitJsonData(descriptor.value, `${label}[${key}]`, ancestors);
      }));
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      fail("STORE_FAILURE", `${label} object has an unsupported prototype`);
    }
    /** @type {Record<string, JsonData>} */
    const clone = Object.create(null);
    for (const key of ownKeys) {
      if (typeof key !== "string") fail("STORE_FAILURE", `${label} contains a symbol field`);
      const descriptor = descriptors[key];
      if (
        descriptor === undefined
        || !descriptor.enumerable
        || !Object.hasOwn(descriptor, "value")
      ) fail("STORE_FAILURE", `${label}.${key} must be an enumerable data property`);
      clone[key] = admitJsonData(descriptor.value, `${label}.${key}`, ancestors);
    }
    return Object.freeze(clone);
  } finally {
    ancestors.delete(value);
  }
}

/**
 * @param {unknown} value
 * @returns {number}
 */
export function serializedSize(value) {
  try {
    const json = JSON.stringify(admitJsonData(value, "worker protocol envelope"));
    if (json === undefined) fail("STORE_FAILURE", "worker protocol envelope is not serializable");
    return Buffer.byteLength(json, "utf8");
  } catch (cause) {
    if (cause instanceof AttuneGraphLocalProtocolError) throw cause;
    fail("STORE_FAILURE", "worker protocol envelope is not serializable", cause);
  }
}

/**
 * @param {unknown} value
 * @returns {void}
 */
export function assertEnvelopeSize(value) {
  if (serializedSize(value) > MAX_ENVELOPE_BYTES) {
    fail("STORE_FAILURE", "worker protocol envelope is oversized");
  }
}

/**
 * @param {unknown} value
 * @param {string} [label]
 * @returns {AttuneGraphScope}
 */
export function parseScope(value, label = "scope") {
  const input = plainRecord(value, label, ["sourceId", "threadId"]);
  return Object.freeze({
    sourceId: boundedText(input.sourceId, `${label}.sourceId`),
    threadId: boundedText(input.threadId, `${label}.threadId`)
  });
}

/**
 * @param {unknown} value
 * @param {string} label
 * @param {number} [limit]
 * @param {SerializedErrorCode} [code]
 * @returns {string}
 */
export function boundedText(value, label, limit = 512, code = "STORE_FAILURE") {
  if (
    typeof value !== "string"
    || value.length === 0
    || value !== value.trim()
    || value.length > limit
  ) {
    fail(code, `${label} must be bounded non-empty text`);
  }
  return value;
}

/**
 * @param {unknown} value
 * @returns {value is WorkerRequestType}
 */
function isRequestType(value) {
  return typeof value === "string" && REQUEST_TYPES.has(/** @type {WorkerRequestType} */ (value));
}

/**
 * Fail-stop hint used only to decide whether a malformed terminal request must
 * close the Worker. It never invokes an accessor or treats the hint as valid.
 * @param {unknown} value
 * @returns {boolean}
 */
export function isTerminalRequestEnvelope(value) {
  if (value === null || typeof value !== "object" || nodeTypes.isProxy(value)) return false;
  const descriptor = Object.getOwnPropertyDescriptor(value, "type");
  return descriptor !== undefined
    && Object.hasOwn(descriptor, "value")
    && (descriptor.value === "initialize" || descriptor.value === "close");
}

/**
 * @param {unknown} value
 * @returns {value is TestMutation}
 */
function isTestMutation(value) {
  return typeof value === "string" && TEST_MUTATIONS.has(/** @type {TestMutation} */ (value));
}

/**
 * @param {unknown} value
 * @param {AttuneGraphScope} scope
 * @param {string} [label]
 * @returns {AttuneGraphSnapshot}
 */
export function parseSnapshot(value, scope, label = "snapshot") {
  const input = plainRecord(value, label, ["schemaVersion", "scope", "generation", "commitId"]);
  const snapshotScope = parseScope(input.scope, `${label}.scope`);
  if (
    input.schemaVersion !== 1
    || !Number.isSafeInteger(input.generation)
    || /** @type {number} */ (input.generation) < 1
    || snapshotScope.sourceId !== scope.sourceId
    || snapshotScope.threadId !== scope.threadId
  ) {
    fail("STORE_FAILURE", `${label} is invalid`);
  }
  return Object.freeze({
    schemaVersion: 1,
    scope: snapshotScope,
    generation: /** @type {number} */ (input.generation),
    commitId: boundedText(input.commitId, `${label}.commitId`)
  });
}

/**
 * @param {WorkerRequestType} type
 * @param {unknown} value
 * @returns {InitializePayload | ReadPayload | CompareAndSwapPayload | HoldWriteLockPayload | InspectRequest["payload"] | MutatePayload | CloseRequest["payload"]}
 */
export function parseRequestPayload(type, value) {
  switch (type) {
    case "initialize": {
      const input = plainRecord(value, "initialize payload", ["databasePath"]);
      if (typeof input.databasePath !== "string") fail("STORE_FAILURE", "databasePath must be text");
      return Object.freeze({ databasePath: input.databasePath });
    }
    case "read":
      return Object.freeze({ scope: parseScope(plainRecord(value, "read payload", ["scope"]).scope) });
    case "compareAndSwap": {
      const input = plainRecord(value, "compare-and-swap payload", ["scope", "expected", "proposed"]);
      const scope = parseScope(input.scope);
      return Object.freeze({
        scope,
        expected: input.expected === null ? null : parseSnapshot(input.expected, scope, "expected snapshot"),
        proposed: parseProjection(input.proposed, scope)
      });
    }
    case "holdWriteLockForTesting": {
      const input = plainRecord(value, "lock fixture payload", ["durationMs"]);
      if (
        !Number.isSafeInteger(input.durationMs)
        || /** @type {number} */ (input.durationMs) < 1_100
        || /** @type {number} */ (input.durationMs) > 5_000
      ) {
        fail("STORE_FAILURE", "lock fixture duration is invalid");
      }
      return Object.freeze({ durationMs: /** @type {number} */ (input.durationMs) });
    }
    case "mutateForTesting": {
      const input = plainRecord(value, "test mutation payload", ["mutation"]);
      if (!isTestMutation(input.mutation)) fail("STORE_FAILURE", "worker test mutation is unknown");
      return Object.freeze({ mutation: input.mutation });
    }
    case "inspectForTesting":
    case "close":
      plainRecord(value, `${type} payload`, []);
      return Object.freeze({});
  }
}

/**
 * @param {number} id
 * @param {WorkerRequestType} type
 * @param {unknown} payload
 * @returns {WorkerRequest}
 */
export function createWorkerRequest(id, type, payload) {
  if (!Number.isSafeInteger(id) || id < 1) {
    fail("STORE_FAILURE", "worker protocol request ID is invalid");
  }
  const parsedPayload = parseRequestPayload(type, payload);
  /** @type {WorkerRequest} */
  let request;
  switch (type) {
    case "initialize": request = { protocolVersion: PROTOCOL_VERSION, id, type, payload: /** @type {InitializePayload} */ (parsedPayload) }; break;
    case "read": request = { protocolVersion: PROTOCOL_VERSION, id, type, payload: /** @type {ReadPayload} */ (parsedPayload) }; break;
    case "compareAndSwap": request = { protocolVersion: PROTOCOL_VERSION, id, type, payload: /** @type {CompareAndSwapPayload} */ (parsedPayload) }; break;
    case "holdWriteLockForTesting": request = { protocolVersion: PROTOCOL_VERSION, id, type, payload: /** @type {HoldWriteLockPayload} */ (parsedPayload) }; break;
    case "inspectForTesting": request = { protocolVersion: PROTOCOL_VERSION, id, type, payload: /** @type {EmptyPayload} */ (parsedPayload) }; break;
    case "mutateForTesting": request = { protocolVersion: PROTOCOL_VERSION, id, type, payload: /** @type {MutatePayload} */ (parsedPayload) }; break;
    case "close": request = { protocolVersion: PROTOCOL_VERSION, id, type, payload: /** @type {EmptyPayload} */ (parsedPayload) }; break;
  }
  assertEnvelopeSize(request);
  return request;
}

/**
 * @param {unknown} value
 * @param {number} lastRequestId
 * @returns {WorkerRequest}
 */
export function parseWorkerRequest(value, lastRequestId) {
  const input = plainRecord(value, "worker request", ["protocolVersion", "id", "type", "payload"]);
  assertEnvelopeSize(input);
  if (
    input.protocolVersion !== PROTOCOL_VERSION
    || !Number.isSafeInteger(input.id)
    || /** @type {number} */ (input.id) < 1
    || /** @type {number} */ (input.id) <= lastRequestId
    || !isRequestType(input.type)
  ) {
    fail("STORE_FAILURE", "worker protocol request is invalid or non-monotonic");
  }
  return createWorkerRequest(
    /** @type {number} */ (input.id),
    input.type,
    input.payload
  );
}

/**
 * @param {unknown} value
 * @returns {SerializedError}
 */
export function parseSerializedError(value) {
  const input = plainRecord(value, "worker error", ["code", "message"]);
  if (
    typeof input.code !== "string"
    || !ERROR_CODES.has(/** @type {SerializedErrorCode} */ (input.code))
    || typeof input.message !== "string"
    || input.message.length === 0
    || input.message.length > 1_024
  ) {
    fail("STORE_FAILURE", "local AttuneGraph worker returned an invalid error envelope");
  }
  return Object.freeze({
    code: /** @type {SerializedErrorCode} */ (input.code),
    message: input.message
  });
}

/**
 * @param {WorkerRequestType} type
 * @param {unknown} value
 * @returns {WorkerResult}
 */
export function parseWorkerResult(type, value) {
  switch (type) {
    case "initialize": {
      const input = plainRecord(value, "worker handshake", [
        "applicationId", "profileVersion", "protocolVersion", "sqliteVersion", "userVersion"
      ]);
      if (
        input.applicationId !== APPLICATION_ID
        || input.profileVersion !== 1
        || input.protocolVersion !== PROTOCOL_VERSION
        || typeof input.sqliteVersion !== "string"
        || input.userVersion !== USER_VERSION
      ) fail("STORE_FAILURE", "local AttuneGraph worker handshake is unsupported");
      return Object.freeze({
        applicationId: APPLICATION_ID,
        profileVersion: 1,
        protocolVersion: PROTOCOL_VERSION,
        sqliteVersion: input.sqliteVersion,
        userVersion: USER_VERSION
      });
    }
    case "read": {
      const input = plainRecord(value, "worker read result", ["found", "projection"], ["found"]);
      if (input.found === false && !Object.hasOwn(input, "projection")) {
        return Object.freeze({ found: false });
      }
      if (input.found !== true || !Object.hasOwn(input, "projection")) {
        fail("STORE_FAILURE", "local AttuneGraph worker returned an invalid read result");
      }
      const projectionRecord = plainRecord(input.projection, "worker projection", [
        "schemaVersion", "snapshot", "observationId", "canonicalProjection",
        "projectionFingerprint", "observedAt", "sourceFreshness", "assertions"
      ]);
      const scope = parseScope(
        plainRecord(projectionRecord.snapshot, "worker projection snapshot", [
          "schemaVersion", "scope", "generation", "commitId"
        ]).scope,
        "worker projection scope"
      );
      return Object.freeze({ found: true, projection: parseProjection(input.projection, scope) });
    }
    case "compareAndSwap": {
      const input = plainRecord(value, "worker compare-and-swap result", ["committed"]);
      if (typeof input.committed !== "boolean") fail("STORE_FAILURE", "invalid compare-and-swap result");
      return Object.freeze({ committed: input.committed });
    }
    case "holdWriteLockForTesting":
      if (plainRecord(value, "worker lock result", ["acquired"]).acquired !== true) {
        fail("STORE_FAILURE", "invalid lock fixture result");
      }
      return Object.freeze({ acquired: true });
    case "inspectForTesting": {
      const input = plainRecord(value, "worker inspection result", [
        "headRows", "journalRows", "maxGeneration"
      ]);
      if (
        !Number.isSafeInteger(input.headRows)
        || !Number.isSafeInteger(input.journalRows)
        || !Number.isSafeInteger(input.maxGeneration)
        || /** @type {number} */ (input.headRows) < 0
        || /** @type {number} */ (input.journalRows) < 0
        || /** @type {number} */ (input.maxGeneration) < 0
      ) fail("STORE_FAILURE", "invalid inspection result");
      return Object.freeze({
        headRows: /** @type {number} */ (input.headRows),
        journalRows: /** @type {number} */ (input.journalRows),
        maxGeneration: /** @type {number} */ (input.maxGeneration)
      });
    }
    case "mutateForTesting":
      if (plainRecord(value, "worker mutation result", ["mutated"]).mutated !== true) {
        fail("STORE_FAILURE", "invalid mutation result");
      }
      return Object.freeze({ mutated: true });
    case "close":
      if (plainRecord(value, "worker close result", ["closed"]).closed !== true) {
        fail("STORE_FAILURE", "invalid close result");
      }
      return Object.freeze({ closed: true });
  }
}

/**
 * @param {unknown} value
 * @param {WorkerRequestType} expectedType
 * @returns {WorkerResponse}
 */
export function parseWorkerResponse(value, expectedType) {
  const input = plainRecord(
    value,
    "worker response",
    ["protocolVersion", "id", "ok", "result", "error"],
    ["protocolVersion", "id", "ok"]
  );
  assertEnvelopeSize(input);
  if (
    input.protocolVersion !== PROTOCOL_VERSION
    || !Number.isSafeInteger(input.id)
    || /** @type {number} */ (input.id) < 1
    || typeof input.ok !== "boolean"
  ) fail("STORE_FAILURE", "local AttuneGraph worker returned an invalid response");
  const id = /** @type {number} */ (input.id);
  if (input.ok) {
    if (!Object.hasOwn(input, "result") || Object.hasOwn(input, "error")) {
      fail("STORE_FAILURE", "local AttuneGraph success response is malformed");
    }
    return Object.freeze({
      protocolVersion: PROTOCOL_VERSION,
      id,
      ok: true,
      result: parseWorkerResult(expectedType, input.result)
    });
  }
  if (!Object.hasOwn(input, "error") || Object.hasOwn(input, "result")) {
    fail("STORE_FAILURE", "local AttuneGraph error response is malformed");
  }
  return Object.freeze({
    protocolVersion: PROTOCOL_VERSION,
    id,
    ok: false,
    error: parseSerializedError(input.error)
  });
}

/**
 * @param {number} id
 * @param {WorkerRequestType} type
 * @param {unknown} result
 * @returns {WorkerSuccessResponse}
 */
export function successResponse(id, type, result) {
  const response = /** @type {WorkerSuccessResponse} */ ({
    protocolVersion: PROTOCOL_VERSION,
    id,
    ok: true,
    result: parseWorkerResult(type, result)
  });
  assertEnvelopeSize(response);
  return response;
}

/**
 * @param {number} id
 * @param {unknown} cause
 * @returns {WorkerErrorResponse}
 */
export function errorResponse(id, cause) {
  const candidate = cause instanceof AttuneGraphLocalProtocolError ? cause.attuneGraphCode : "STORE_FAILURE";
  const code = ERROR_CODES.has(candidate) ? candidate : "STORE_FAILURE";
  const message = cause instanceof Error && cause.message.length > 0 && cause.message.length <= 1_024
    ? cause.message
    : "local AttuneGraph worker failed";
  return {
    protocolVersion: PROTOCOL_VERSION,
    id,
    ok: false,
    error: { code, message }
  };
}
