import { Buffer } from "node:buffer";

import { admitAdminEnvelope } from "./attunegraph-admin-readonly-envelope.mjs";

export const ADMIN_PROTOCOL_VERSION = 1;
export const ADMIN_WORKER_ERROR_CODES = Object.freeze([
  "INVALID_INPUT",
  "INVALID_STATE",
  "REENTRY",
  "SOURCE_NOT_FOUND",
  "UNSUPPORTED_PROFILE",
  "CORRUPT_STORE",
  "FUTURE_STORE_STATE",
  "STORE_BUSY",
  "TIMED_OUT",
  "WORKER_FAILURE"
]);

/** @typedef {"initialize" | "inspectSummary" | "inspectHead" | "verifyIntegrity" | "close"} AdminRequestType */
/** @typedef {"INVALID_INPUT" | "INVALID_STATE" | "REENTRY" | "SOURCE_NOT_FOUND" | "UNSUPPORTED_PROFILE" | "CORRUPT_STORE" | "FUTURE_STORE_STATE" | "STORE_BUSY" | "TIMED_OUT" | "WORKER_FAILURE"} AdminWorkerErrorCode */
/** @typedef {Readonly<{sourceId: string, threadId: string}>} AdminScope */
/** @typedef {Readonly<{protocolVersion: 1, id: number, type: AdminRequestType, payload: Readonly<Record<string, unknown>>}>} AdminWorkerRequest */
/** @typedef {Readonly<{ready: true}> | Readonly<{applicationId: number, userVersion: 1, protocolVersion: 1, sqliteVersion: string, headRows: number, journalRows: number, maxGeneration: number}> | Readonly<{found: false}> | Readonly<{found: true, head: Readonly<{scope: AdminScope, generation: number, commitId: string, projectionFingerprint: string}>}> | Readonly<{verified: true}> | Readonly<{closed: true}>} AdminWorkerSuccessResult */
/** @typedef {Readonly<{protocolVersion: 1, id: number, ok: true, result: AdminWorkerSuccessResult}> | Readonly<{protocolVersion: 1, id: number, ok: false, error: Readonly<{code: AdminWorkerErrorCode}>}>} AdminWorkerResponse */

/** @returns {never} */
function invalidProtocol() {
  throw new TypeError("Invalid Admin protocol envelope");
}

/**
 * @param {unknown} value
 * @param {readonly string[]} fields
 * @returns {Record<string, unknown>}
 */
function exactRecord(value, fields) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return invalidProtocol();
  }
  const keys = Object.keys(value);
  if (
    keys.length !== fields.length
    || fields.some((field) => !Object.hasOwn(value, field))
  ) {
    return invalidProtocol();
  }
  return /** @type {Record<string, unknown>} */ (value);
}

/** @param {unknown} value @returns {number} */
function positiveSafeInteger(value) {
  if (!Number.isSafeInteger(value) || /** @type {number} */ (value) <= 0) {
    return invalidProtocol();
  }
  return /** @type {number} */ (value);
}

/** @param {unknown} value @returns {number} */
function nonNegativeSafeInteger(value) {
  if (!Number.isSafeInteger(value) || /** @type {number} */ (value) < 0) {
    return invalidProtocol();
  }
  return /** @type {number} */ (value);
}

/**
 * @param {unknown} value
 * @param {number} maximum
 * @param {boolean} allowEmpty
 * @returns {string}
 */
function boundedUtf8(value, maximum, allowEmpty) {
  if (
    typeof value !== "string"
    || (!allowEmpty && value.length === 0)
    || Buffer.byteLength(value, "utf8") > maximum
  ) {
    return invalidProtocol();
  }
  return value;
}

/** @param {unknown} value @returns {string} */
function boundedIdentity(value) {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > 512
  ) {
    return invalidProtocol();
  }
  return value;
}

/** @param {unknown} value @returns {AdminScope} */
function parseScope(value) {
  const scope = exactRecord(value, ["sourceId", "threadId"]);
  boundedIdentity(scope.sourceId);
  boundedIdentity(scope.threadId);
  return /** @type {AdminScope} */ (scope);
}

/** @param {unknown} value @returns {AdminRequestType} */
function requestType(value) {
  if (
    value !== "initialize"
    && value !== "inspectSummary"
    && value !== "inspectHead"
    && value !== "verifyIntegrity"
    && value !== "close"
  ) {
    return invalidProtocol();
  }
  return value;
}

/**
 * @param {AdminRequestType} type
 * @param {unknown} value
 * @returns {Readonly<Record<string, unknown>>}
 */
function parseRequestPayload(type, value) {
  if (type === "initialize") {
    const payload = exactRecord(value, ["databasePath"]);
    const databasePath = boundedUtf8(payload.databasePath, 4_096, false);
    if (databasePath.includes("\0")) invalidProtocol();
    return payload;
  }
  if (type === "inspectHead") {
    const payload = exactRecord(value, ["scope"]);
    parseScope(payload.scope);
    return payload;
  }
  return exactRecord(value, []);
}

/**
 * @param {unknown} value
 * @param {number} previousId
 * @returns {AdminWorkerRequest}
 */
export function parseAdminWorkerRequest(value, previousId) {
  if (
    !Number.isSafeInteger(previousId)
    || previousId < 0
    || previousId >= Number.MAX_SAFE_INTEGER
  ) {
    return invalidProtocol();
  }
  const admitted = admitAdminEnvelope(value);
  const request = exactRecord(
    admitted.value,
    ["protocolVersion", "id", "type", "payload"]
  );
  if (request.protocolVersion !== ADMIN_PROTOCOL_VERSION) invalidProtocol();
  const id = positiveSafeInteger(request.id);
  if (id !== previousId + 1) invalidProtocol();
  const type = requestType(request.type);
  if ((id === 1) !== (type === "initialize")) invalidProtocol();
  parseRequestPayload(type, request.payload);
  return /** @type {AdminWorkerRequest} */ (request);
}

/**
 * @param {number} previousId
 * @param {AdminRequestType} type
 * @param {unknown} payload
 * @returns {AdminWorkerRequest}
 */
export function createAdminWorkerRequest(previousId, type, payload) {
  return parseAdminWorkerRequest({
    protocolVersion: ADMIN_PROTOCOL_VERSION,
    id: previousId + 1,
    type,
    payload
  }, previousId);
}

/** @param {unknown} value @returns {AdminWorkerErrorCode} */
function parseErrorCode(value) {
  if (
    typeof value !== "string"
    || !ADMIN_WORKER_ERROR_CODES.includes(value)
  ) {
    return invalidProtocol();
  }
  return /** @type {AdminWorkerErrorCode} */ (value);
}

/**
 * @param {unknown} value
 * @param {AdminRequestType} type
 * @returns {AdminWorkerSuccessResult}
 */
function parseSuccessResult(value, type) {
  if (type === "initialize") {
    const result = exactRecord(value, ["ready"]);
    if (result.ready !== true) invalidProtocol();
    return /** @type {Readonly<{ready: true}>} */ (result);
  }
  if (type === "inspectSummary") {
    const result = exactRecord(value, [
      "applicationId",
      "userVersion",
      "protocolVersion",
      "sqliteVersion",
      "headRows",
      "journalRows",
      "maxGeneration"
    ]);
    if (
      result.applicationId !== 0x41544731
      || result.userVersion !== 1
      || result.protocolVersion !== ADMIN_PROTOCOL_VERSION
    ) {
      return invalidProtocol();
    }
    boundedUtf8(result.sqliteVersion, 4_096, true);
    nonNegativeSafeInteger(result.headRows);
    nonNegativeSafeInteger(result.journalRows);
    nonNegativeSafeInteger(result.maxGeneration);
    return /** @type {AdminWorkerSuccessResult} */ (result);
  }
  if (type === "inspectHead") {
    const base = /** @type {Record<string, unknown>} */ (value);
    if (base?.found === false) {
      return /** @type {Readonly<{found: false}>} */ (
        exactRecord(value, ["found"])
      );
    }
    const result = exactRecord(value, ["found", "head"]);
    if (result.found !== true) invalidProtocol();
    const head = exactRecord(result.head, [
      "scope",
      "generation",
      "commitId",
      "projectionFingerprint"
    ]);
    parseScope(head.scope);
    positiveSafeInteger(head.generation);
    boundedIdentity(head.commitId);
    boundedIdentity(head.projectionFingerprint);
    return /** @type {AdminWorkerSuccessResult} */ (result);
  }
  if (type === "verifyIntegrity") {
    const result = exactRecord(value, ["verified"]);
    if (result.verified !== true) invalidProtocol();
    return /** @type {Readonly<{verified: true}>} */ (result);
  }
  const result = exactRecord(value, ["closed"]);
  if (result.closed !== true) invalidProtocol();
  return /** @type {Readonly<{closed: true}>} */ (result);
}

/**
 * @param {unknown} value
 * @param {AdminRequestType} pendingType
 * @returns {AdminWorkerResponse}
 */
export function parseAdminWorkerResponse(value, pendingType) {
  requestType(pendingType);
  const admitted = admitAdminEnvelope(value);
  if (
    admitted.value === null
    || typeof admitted.value !== "object"
    || Array.isArray(admitted.value)
  ) {
    return invalidProtocol();
  }
  const candidate = /** @type {Record<string, unknown>} */ (admitted.value);
  if (candidate.ok === true) {
    const response = exactRecord(candidate, [
      "protocolVersion",
      "id",
      "ok",
      "result"
    ]);
    if (response.protocolVersion !== ADMIN_PROTOCOL_VERSION) invalidProtocol();
    positiveSafeInteger(response.id);
    parseSuccessResult(response.result, pendingType);
    return /** @type {AdminWorkerResponse} */ (response);
  }
  if (candidate.ok === false) {
    const response = exactRecord(candidate, [
      "protocolVersion",
      "id",
      "ok",
      "error"
    ]);
    if (response.protocolVersion !== ADMIN_PROTOCOL_VERSION) invalidProtocol();
    positiveSafeInteger(response.id);
    const error = exactRecord(response.error, ["code"]);
    parseErrorCode(error.code);
    return /** @type {AdminWorkerResponse} */ (response);
  }
  return invalidProtocol();
}
