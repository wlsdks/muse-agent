import { parentPort } from "node:worker_threads";

import {
  errorResponse,
  isTerminalRequestEnvelope,
  parseWorkerRequest,
  successResponse
} from "./attunegraph-local-protocol.mjs";
import { dispatchSqliteRequest } from "./attunegraph-local-sqlite.mjs";

const port = parentPort;
if (!port) {
  throw new Error("local AttuneGraph SQLite worker requires a parent port");
}

let lastRequestId = 0;

port.on("message", async (message) => {
  let id = 0;
  let terminal = isTerminalRequestEnvelope(message);
  try {
    const request = parseWorkerRequest(message, lastRequestId);
    id = request.id;
    lastRequestId = id;
    terminal = request.type === "initialize" || request.type === "close";
    const result = await dispatchSqliteRequest(request);
    port.postMessage(successResponse(id, request.type, result));
    if (request.type === "close") port.close();
  } catch (cause) {
    port.postMessage(errorResponse(id, cause));
    if (terminal) port.close();
  }
});
