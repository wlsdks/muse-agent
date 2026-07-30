import { Worker } from "node:worker_threads";

import { expect, it } from "vitest";

import {
  MAX_ENVELOPE_BYTES,
  createWorkerRequest,
  isTerminalRequestEnvelope,
  parseWorkerRequest,
  parseWorkerResponse
} from "./attunegraph-local-protocol.mjs";

const initialize = {
  protocolVersion: 1,
  id: 1,
  type: "initialize",
  payload: { databasePath: "/tmp/attunegraph.sqlite" }
};

it.each([
  ["missing field", { protocolVersion: 1, id: 1, type: "initialize" }],
  ["unknown field", { ...initialize, extra: true }],
  ["invalid id", { ...initialize, id: 0 }],
  ["unknown operation", { ...initialize, type: "unknown" }],
  ["non-monotonic id", { ...initialize }],
  ["oversized envelope", {
    ...initialize,
    payload: { databasePath: `/${"x".repeat(MAX_ENVELOPE_BYTES)}` }
  }]
])("rejects hostile request envelope: %s", (_name, envelope) => {
  const previousId = _name === "non-monotonic id" ? 1 : 0;
  expect(() => parseWorkerRequest(envelope, previousId)).toThrow();
});

it("rejects accessor and symbol protocol fields without invoking accessors", () => {
  let invoked = false;
  const accessor = {
    protocolVersion: 1,
    id: 1,
    type: "initialize"
  } as Record<string | symbol, unknown>;
  Object.defineProperty(accessor, "payload", {
    enumerable: true,
    get() {
      invoked = true;
      return { databasePath: "/tmp/attunegraph.sqlite" };
    }
  });
  expect(() => parseWorkerRequest(accessor, 0)).toThrow();
  expect(invoked).toBe(false);

  const symbol = { ...initialize, [Symbol("hidden")]: true };
  expect(() => parseWorkerRequest(symbol, 0)).toThrow();
});

it("never invokes nested request or response getters while sizing", () => {
  let requestInvocations = 0;
  const requestPayload = Object.create(null) as Record<string, unknown>;
  Object.defineProperty(requestPayload, "databasePath", {
    enumerable: true,
    get() {
      requestInvocations += 1;
      return "/tmp/attunegraph.sqlite";
    }
  });
  expect(() => parseWorkerRequest({ ...initialize, payload: requestPayload }, 0)).toThrow();
  expect(requestInvocations).toBe(0);

  let responseInvocations = 0;
  const closeResult = Object.create(null) as Record<string, unknown>;
  Object.defineProperty(closeResult, "closed", {
    enumerable: true,
    get() {
      responseInvocations += 1;
      return true;
    }
  });
  expect(() => parseWorkerResponse({
    protocolVersion: 1,
    id: 1,
    ok: true,
    result: closeResult
  }, "close")).toThrow();
  expect(responseInvocations).toBe(0);
});

it("rejects large sparse request and response arrays before length-proportional work", () => {
  let invocations = 0;
  const sparse = () => {
    const value: unknown[] = [];
    value.length = 30_000_000;
    Object.defineProperty(value, "0", {
      enumerable: true,
      get() {
        invocations += 1;
        return "not invoked";
      }
    });
    return value;
  };
  const request = {
    ...initialize,
    payload: {
      databasePath: "/tmp/attunegraph.sqlite",
      sparse: sparse()
    }
  };
  const response = {
    protocolVersion: 1,
    id: 1,
    ok: true,
    result: {
      closed: true,
      sparse: sparse()
    }
  };
  for (const operation of [
    () => parseWorkerRequest(request, 0),
    () => parseWorkerResponse(response, "close")
  ]) {
    try {
      operation();
      throw new Error("large sparse envelope unexpectedly passed");
    } catch (cause) {
      expect(cause).toMatchObject({ attuneGraphCode: "STORE_FAILURE" });
    }
  }
  expect(invocations).toBe(0);
});

it.each([
  ["initialize", {}],
  ["read", {}],
  ["compareAndSwap", { scope: { sourceId: "s", threadId: "t" } }],
  ["holdWriteLockForTesting", { durationMs: 1_099 }],
  ["inspectForTesting", { extra: true }],
  ["mutateForTesting", { mutation: "unknown" }],
  ["close", { extra: true }]
] as const)("rejects invalid %s payloads", (type, payload) => {
  expect(() => createWorkerRequest(1, type, payload)).toThrow();
});

it.each([
  ["success with error", {
    protocolVersion: 1,
    id: 1,
    ok: true,
    result: { closed: true },
    error: { code: "STORE_FAILURE", message: "no" }
  }],
  ["error with result", {
    protocolVersion: 1,
    id: 1,
    ok: false,
    result: { closed: true },
    error: { code: "STORE_FAILURE", message: "no" }
  }],
  ["unknown error code", {
    protocolVersion: 1,
    id: 1,
    ok: false,
    error: { code: "UNKNOWN", message: "no" }
  }],
  ["wrong operation result", {
    protocolVersion: 1,
    id: 1,
    ok: true,
    result: { committed: true }
  }]
])("rejects hostile response envelope: %s", (_name, response) => {
  expect(() => parseWorkerResponse(response, "close")).toThrow();
});

it.each([
  ["missing response field", { protocolVersion: 1, id: 1 }],
  ["unknown response field", {
    protocolVersion: 1, id: 1, ok: true, result: { closed: true }, unknown: true
  }],
  ["symbol response field", {
    protocolVersion: 1, id: 1, ok: true, result: { closed: true }, [Symbol("hidden")]: true
  }],
  ["oversized response", {
    protocolVersion: 1,
    id: 1,
    ok: true,
    result: { closed: true, padding: "x".repeat(MAX_ENVELOPE_BYTES) }
  }],
  ["zero response id", { protocolVersion: 1, id: 0, ok: true, result: { closed: true } }],
  ["negative response id", { protocolVersion: 1, id: -1, ok: true, result: { closed: true } }],
  ["unsafe response id", {
    protocolVersion: 1,
    id: Number.MAX_SAFE_INTEGER + 1,
    ok: true,
    result: { closed: true }
  }]
])("rejects closed response fields and IDs: %s", (_name, response) => {
  expect(() => parseWorkerResponse(response, "close")).toThrow();
});

it("rejects a top-level response accessor without invoking it", () => {
  let invoked = 0;
  const response = { protocolVersion: 1, id: 1, ok: true } as Record<string, unknown>;
  Object.defineProperty(response, "result", {
    enumerable: true,
    get() {
      invoked += 1;
      return { closed: true };
    }
  });
  expect(() => parseWorkerResponse(response, "close")).toThrow();
  expect(invoked).toBe(0);
});

it.each([
  ["initialize", { applicationId: 0, profileVersion: 1, protocolVersion: 1, sqliteVersion: "3.51.3", userVersion: 1 }],
  ["read", { found: true }],
  ["compareAndSwap", { committed: "yes" }],
  ["holdWriteLockForTesting", { acquired: false }],
  ["inspectForTesting", { headRows: -1, journalRows: 0, maxGeneration: 0 }],
  ["mutateForTesting", { mutated: false }],
  ["close", { closed: false }]
] as const)("rejects the invalid %s result shape", (type, result) => {
  expect(() => parseWorkerResponse({
    protocolVersion: 1,
    id: 1,
    ok: true,
    result
  }, type)).toThrow();
});

it("accepts exact initialize and close terminal envelopes", () => {
  expect(parseWorkerResponse({
    protocolVersion: 1,
    id: 1,
    ok: true,
    result: {
      applicationId: 0x41544731,
      profileVersion: 1,
      protocolVersion: 1,
      sqliteVersion: "3.51.3",
      userVersion: 1
    }
  }, "initialize")).toMatchObject({ ok: true, id: 1 });
  expect(parseWorkerResponse({
    protocolVersion: 1,
    id: 2,
    ok: true,
    result: { closed: true }
  }, "close")).toEqual({
    protocolVersion: 1,
    id: 2,
    ok: true,
    result: { closed: true }
  });
});

it.each(["initialize", "close"] as const)(
  "fails stopped after a malformed %s terminal request",
  async (type) => {
    const worker = new Worker(
      new URL("./attunegraph-local-worker.mjs", import.meta.url),
      { execArgv: [] }
    );
    const response = new Promise<unknown>((resolve) => worker.once("message", resolve));
    const exit = new Promise<number>((resolve) => worker.once("exit", resolve));
    const envelope = {
      protocolVersion: 1,
      id: 1,
      type,
      payload: {},
      unknown: true
    };
    expect(isTerminalRequestEnvelope(envelope)).toBe(true);
    worker.postMessage(envelope);
    await expect(response).resolves.toMatchObject({ ok: false });
    await expect(exit).resolves.toBe(0);
  }
);
