import { DatabaseSync } from "node:sqlite";
import { isMainThread, parentPort, workerData } from "node:worker_threads";

import {
  createAttuneGraphAdminReadOnlyInspector,
  readAttuneGraphAdminReadonlyInspectorFailure
} from "./attunegraph-admin-readonly-inspector.mjs";
import {
  ADMIN_PROTOCOL_VERSION,
  parseAdminWorkerRequest,
  parseAdminWorkerResponse
} from "./attunegraph-admin-readonly-protocol.mjs";

/** @typedef {"initialize" | "inspectSummary" | "inspectHead" | "verifyIntegrity" | "close"} RequestType */
/** @typedef {"INVALID_INPUT" | "INVALID_STATE" | "REENTRY" | "SOURCE_NOT_FOUND" | "UNSUPPORTED_PROFILE" | "CORRUPT_STORE" | "FUTURE_STORE_STATE" | "STORE_BUSY" | "TIMED_OUT" | "WORKER_FAILURE"} ErrorCode */

if (isMainThread || parentPort === null || workerData !== undefined) {
  throw new Error("Invalid Admin Worker startup");
}

const port = parentPort;
let previousRequestId = 0;
/** @type {DatabaseSync | undefined} */
let database;
/** @type {ReturnType<typeof createAttuneGraphAdminReadOnlyInspector> | undefined} */
let inspector;
/** @type {ErrorCode | undefined} */
let pinnedCode;
let databaseClosed = false;

function closeDatabaseOnce() {
  if (database === undefined || databaseClosed) return;
  databaseClosed = true;
  database.close();
}

function closeDatabaseAfterFailure() {
  try {
    closeDatabaseOnce();
  } catch {
  }
}

function closePort() {
  try {
    port.close();
  } catch {
  }
}

/**
 * @param {number} id
 * @param {RequestType} type
 * @param {unknown} result
 */
function postSuccess(id, type, result) {
  const response = parseAdminWorkerResponse({
    protocolVersion: ADMIN_PROTOCOL_VERSION,
    id,
    ok: true,
    result
  }, type);
  port.postMessage(response);
}

/** @param {unknown} cause @returns {ErrorCode} */
function failureCode(cause) {
  return readAttuneGraphAdminReadonlyInspectorFailure(cause) ?? "WORKER_FAILURE";
}

/**
 * @param {unknown} cause
 * @param {Readonly<{id: number, type: RequestType}> | undefined} request
 */
function fail(cause, request) {
  if (pinnedCode !== undefined) return;
  pinnedCode = failureCode(cause);
  closeDatabaseAfterFailure();
  if (request !== undefined) {
    try {
      const response = parseAdminWorkerResponse({
        protocolVersion: ADMIN_PROTOCOL_VERSION,
        id: request.id,
        ok: false,
        error: { code: pinnedCode }
      }, request.type);
      port.postMessage(response);
    } catch {
    }
  }
  closePort();
}

port.on("message", (value) => {
  if (pinnedCode !== undefined) return;
  /** @type {ReturnType<typeof parseAdminWorkerRequest>} */
  let request;
  try {
    request = parseAdminWorkerRequest(value, previousRequestId);
  } catch (cause) {
    fail(cause, undefined);
    return;
  }
  previousRequestId = request.id;
  const trusted = /** @type {Readonly<{id: number, type: RequestType}>} */ (request);
  try {
    if (request.type === "initialize") {
      if (database !== undefined) throw new Error("duplicate initialization");
      database = new DatabaseSync(
        /** @type {string} */ (request.payload.databasePath),
        {
          readOnly: true,
          allowExtension: false,
          defensive: true,
          enableDoubleQuotedStringLiterals: false,
          readBigInts: true,
          timeout: 250
        }
      );
      database.enableLoadExtension(false);
      inspector = createAttuneGraphAdminReadOnlyInspector(database);
      postSuccess(request.id, request.type, { ready: true });
      return;
    }
    if (inspector === undefined || database === undefined || databaseClosed) {
      throw new Error("Admin Worker is not initialized");
    }
    if (request.type === "inspectSummary") {
      postSuccess(request.id, request.type, inspector.inspectSummary());
      return;
    }
    if (request.type === "inspectHead") {
      postSuccess(
        request.id,
        request.type,
        inspector.inspectHead(request.payload.scope)
      );
      return;
    }
    if (request.type === "verifyIntegrity") {
      postSuccess(request.id, request.type, inspector.verifyIntegrity());
      return;
    }
    closeDatabaseOnce();
    postSuccess(request.id, request.type, { closed: true });
    closePort();
  } catch (cause) {
    fail(cause, trusted);
  }
});
