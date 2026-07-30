import { expect, it } from "vitest";

import {
  MAX_ADMIN_ENVELOPE_BYTES,
  admitAdminEnvelope
} from "./attunegraph-admin-readonly-envelope.mjs";
import {
  ADMIN_WORKER_ERROR_CODES,
  createAdminWorkerRequest,
  parseAdminWorkerRequest,
  parseAdminWorkerResponse
} from "./attunegraph-admin-readonly-protocol.mjs";
import {
  AttuneGraphAdminReadonlyError,
  openAttuneGraphAdminReadonlySpineForQualification,
  type AdminClockForQualification,
  type AdminWorkerTransport
} from "./attunegraph-admin-readonly-spine.js";

class TestClock implements AdminClockForQualification {
  private nextId = 1;
  private readonly timers = new Map<number, {
    callback: () => void;
    milliseconds: number;
  }>();
  clearCount = 0;
  readonly delays: number[] = [];

  constructor(private readonly events: string[] = []) {}

  setTimeout(callback: () => void, milliseconds: number): unknown {
    const id = this.nextId++;
    this.delays.push(milliseconds);
    this.timers.set(id, { callback, milliseconds });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.clearCount += 1;
    this.events.push("clear-timer");
    this.timers.delete(handle as number);
  }

  expireNext(): void {
    const next = this.timers.entries().next().value as
      | [number, { callback: () => void; milliseconds: number }]
      | undefined;
    if (!next) throw new Error("no timer");
    this.timers.delete(next[0]);
    next[1].callback();
  }
}

class FakeTransport implements AdminWorkerTransport {
  readonly posts: unknown[] = [];
  removeCount = 0;
  terminateCount = 0;
  private message?: (value: unknown) => void;
  private messageError?: () => void;
  private error?: () => void;
  private exit?: (code: number) => void;
  onPost?: (value: unknown) => void;
  postError = false;
  terminateMode: "resolve" | "reject" | "throw" | "hang" = "resolve";

  constructor(private readonly events: string[] = []) {}

  postMessage(value: unknown): void {
    this.posts.push(value);
    if (this.postError) throw new Error("private transport detail");
    this.onPost?.(value);
  }

  onMessage(listener: (value: unknown) => void): void {
    this.message = listener;
  }

  onMessageError(listener: () => void): void {
    this.messageError = listener;
  }

  onError(listener: () => void): void {
    this.error = listener;
  }

  onExit(listener: (code: number) => void): void {
    this.exit = listener;
  }

  removeAllListeners(): void {
    this.removeCount += 1;
    this.events.push("remove-listeners");
  }

  terminate(): Promise<number> {
    this.terminateCount += 1;
    this.events.push("terminate");
    if (this.terminateMode === "throw") {
      throw new Error("private termination detail");
    }
    if (this.terminateMode === "reject") {
      return Promise.reject(new Error("private termination detail"));
    }
    if (this.terminateMode === "hang") {
      return new Promise(() => undefined);
    }
    return Promise.resolve(0);
  }

  respond(value: unknown): void {
    this.message?.(value);
  }

  emitMessageError(): void {
    this.messageError?.();
  }

  emitError(): void {
    this.error?.();
  }

  emitExit(code = 1): void {
    this.exit?.(code);
  }
}

async function openControlledApplication(events: string[] = []) {
  const clock = new TestClock(events);
  const transport = new FakeTransport(events);
  transport.onPost = (value) => {
    const request = value as { id: number; type: string };
    if (request.type === "initialize") {
      transport.respond({
        protocolVersion: 1,
        id: request.id,
        ok: true,
        result: { ready: true }
      });
    }
  };
  const application = await openAttuneGraphAdminReadonlySpineForQualification({
    transport,
    databasePath: "opaque.db",
    clock
  });
  transport.onPost = undefined;
  clock.clearCount = 0;
  events.length = 0;
  return { application, clock, transport };
}

function expectAdminError(
  cause: unknown,
  code: AttuneGraphAdminReadonlyError["code"],
  message: string
): asserts cause is AttuneGraphAdminReadonlyError {
  expect(cause).toBeInstanceOf(AttuneGraphAdminReadonlyError);
  expect(cause).toMatchObject({ code, message });
  expect(Object.isFrozen(cause)).toBe(true);
}

function qualificationEnvelope(byteLength: number) {
  const descriptor = {
    schemaVersion: 1,
    kind: "admin-envelope-boundary-qualification",
    payload: ""
  };
  const baseBytes = Buffer.byteLength(JSON.stringify(descriptor), "utf8");
  return {
    ...descriptor,
    payload: "x".repeat(byteLength - baseBytes)
  };
}

it("admits exactly 65,536 serialized UTF-8 bytes and rejects 65,537", () => {
  const accepted = admitAdminEnvelope(
    qualificationEnvelope(MAX_ADMIN_ENVELOPE_BYTES)
  );
  expect(accepted.byteLength).toBe(MAX_ADMIN_ENVELOPE_BYTES);
  expect(Object.isFrozen(accepted)).toBe(true);
  expect(Object.isFrozen(accepted.value)).toBe(true);
  expect(() =>
    admitAdminEnvelope(qualificationEnvelope(MAX_ADMIN_ENVELOPE_BYTES + 1))
  ).toThrow();
});

it("rejects hostile JSON data without invoking code or walking sparse lengths", () => {
  let calls = 0;
  const accessor = Object.create(null) as Record<string, unknown>;
  Object.defineProperty(accessor, "value", {
    enumerable: true,
    get() {
      calls += 1;
      return "secret";
    }
  });
  const proxy = new Proxy({}, {
    ownKeys() {
      calls += 1;
      return [];
    }
  });
  const sparse: unknown[] = [];
  sparse.length = 30_000_000;
  Object.defineProperty(sparse, "0", {
    enumerable: true,
    get() {
      calls += 1;
      return "secret";
    }
  });
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  const nonEnumerable = {};
  Object.defineProperty(nonEnumerable, "hidden", {
    enumerable: false,
    value: true
  });

  for (const value of [
    accessor,
    proxy,
    sparse,
    Object.create({ inherited: true }),
    cycle,
    { [Symbol("hidden")]: true },
    { value: 1n },
    { toJSON: () => ({ leaked: true }) },
    nonEnumerable,
    Number.NaN
  ]) {
    expect(() => admitAdminEnvelope(value)).toThrow();
  }
  expect(calls).toBe(0);
});

it("admits exact Admin request and pending-type response schemas", () => {
  const initialize = createAdminWorkerRequest(0, "initialize", {
    databasePath: "opaque.db"
  });
  expect(initialize).toEqual({
    protocolVersion: 1,
    id: 1,
    type: "initialize",
    payload: { databasePath: "opaque.db" }
  });
  expect(Object.isFrozen(initialize.payload)).toBe(true);

  const summary = parseAdminWorkerResponse({
    protocolVersion: 1,
    id: 2,
    ok: true,
    result: {
      applicationId: 0x41544731,
      userVersion: 1,
      protocolVersion: 1,
      sqliteVersion: "3.51.3",
      headRows: 2,
      journalRows: 3,
      maxGeneration: 4
    }
  }, "inspectSummary");
  expect(summary.ok).toBe(true);
  expect(Object.isFrozen(summary)).toBe(true);
  if (summary.ok) expect(Object.isFrozen(summary.result)).toBe(true);
});

it("admits every exact request, result, and code-only error schema", () => {
  const requests = [
    createAdminWorkerRequest(0, "initialize", { databasePath: "opaque.db" }),
    createAdminWorkerRequest(1, "inspectSummary", {}),
    createAdminWorkerRequest(2, "inspectHead", {
      scope: { sourceId: "source", threadId: "thread" }
    }),
    createAdminWorkerRequest(3, "verifyIntegrity", {}),
    createAdminWorkerRequest(4, "close", {})
  ];
  expect(requests.map((request) => request.id)).toEqual([1, 2, 3, 4, 5]);

  const results = [
    ["initialize", { ready: true }],
    ["inspectSummary", {
      applicationId: 0x41544731,
      userVersion: 1,
      protocolVersion: 1,
      sqliteVersion: "",
      headRows: 0,
      journalRows: 0,
      maxGeneration: 0
    }],
    ["inspectHead", { found: false }],
    ["inspectHead", {
      found: true,
      head: {
        scope: { sourceId: "source", threadId: "thread" },
        generation: 1,
        commitId: "commit",
        projectionFingerprint: "fingerprint"
      }
    }],
    ["verifyIntegrity", { verified: true }],
    ["close", { closed: true }]
  ] as const;
  for (const [type, result] of results) {
    expect(parseAdminWorkerResponse({
      protocolVersion: 1,
      id: 1,
      ok: true,
      result
    }, type)).toMatchObject({ ok: true });
  }
  for (const code of ADMIN_WORKER_ERROR_CODES) {
    expect(parseAdminWorkerResponse({
      protocolVersion: 1,
      id: 1,
      ok: false,
      error: { code }
    }, "inspectSummary")).toMatchObject({ ok: false, error: { code } });
  }
});

it("rejects qualification descriptors and closed-schema protocol drift", () => {
  const qualification = qualificationEnvelope(MAX_ADMIN_ENVELOPE_BYTES);
  for (const operation of [
    () => parseAdminWorkerRequest(qualification, 0),
    () => parseAdminWorkerResponse(qualification, "close"),
    () => parseAdminWorkerRequest({
      protocolVersion: 1,
      id: 2,
      type: "inspectSummary",
      payload: {},
      extra: true
    }, 1),
    () => parseAdminWorkerRequest({
      protocolVersion: 1,
      id: 3,
      type: "inspectSummary",
      payload: {}
    }, 1),
    () => parseAdminWorkerRequest({
      protocolVersion: 1,
      id: 1,
      type: "inspectSummary",
      payload: {}
    }, 0),
    () => parseAdminWorkerResponse({
      protocolVersion: 1,
      id: 1,
      ok: true,
      result: { closed: true }
    }, "inspectSummary"),
    () => parseAdminWorkerResponse({
      protocolVersion: 1,
      id: 1,
      ok: false,
      error: { code: "WORKER_FAILURE", message: "leak" }
    }, "inspectSummary")
  ]) {
    expect(operation).toThrow();
  }
});

it("enforces strict IDs plus UTF-8 and UTF-16 field bounds", () => {
  for (const operation of [
    () => parseAdminWorkerRequest({
      protocolVersion: 1,
      id: 1,
      type: "initialize",
      payload: { databasePath: "" }
    }, 0),
    () => parseAdminWorkerRequest({
      protocolVersion: 1,
      id: 1,
      type: "initialize",
      payload: { databasePath: "bad\0path" }
    }, 0),
    () => createAdminWorkerRequest(0, "initialize", {
      databasePath: "😀".repeat(1_025)
    }),
    () => parseAdminWorkerRequest({
      protocolVersion: 1,
      id: 2,
      type: "inspectSummary",
      payload: {}
    }, 2),
    () => parseAdminWorkerRequest({
      protocolVersion: 1,
      id: 1,
      type: "initialize",
      payload: { databasePath: "opaque.db" }
    }, 1),
    () => parseAdminWorkerRequest({
      protocolVersion: 1,
      id: Number.MAX_SAFE_INTEGER + 1,
      type: "close",
      payload: {}
    }, Number.MAX_SAFE_INTEGER - 1),
    () => createAdminWorkerRequest(1, "inspectHead", {
      scope: { sourceId: "s".repeat(513), threadId: "thread" }
    }),
    () => parseAdminWorkerResponse({
      protocolVersion: 1,
      id: 1,
      ok: true,
      result: {
        applicationId: 0x41544731,
        userVersion: 1,
        protocolVersion: 1,
        sqliteVersion: "😀".repeat(1_025),
        headRows: 0,
        journalRows: 0,
        maxGeneration: 0
      }
    }, "inspectSummary"),
    () => parseAdminWorkerResponse({
      protocolVersion: 1,
      id: 1,
      ok: true,
      result: {
        found: true,
        head: {
          scope: { sourceId: "source", threadId: "thread" },
          generation: 0,
          commitId: "commit",
          projectionFingerprint: "fingerprint"
        }
      }
    }, "inspectHead")
  ]) {
    expect(operation).toThrow();
  }

  expect(createAdminWorkerRequest(0, "initialize", {
    databasePath: "😀".repeat(1_024)
  }).id).toBe(1);
  expect(createAdminWorkerRequest(1, "inspectHead", {
    scope: { sourceId: "s".repeat(512), threadId: "t".repeat(512) }
  }).id).toBe(2);
});

it.each([
  ["initialize request", () => createAdminWorkerRequest(
    0,
    "initialize",
    { databasePath: "opaque.db", extra: true }
  )],
  ["summary request", () => createAdminWorkerRequest(
    1,
    "inspectSummary",
    { extra: true }
  )],
  ["head request", () => createAdminWorkerRequest(
    1,
    "inspectHead",
    { sourceId: "source", threadId: "thread" }
  )],
  ["integrity request", () => createAdminWorkerRequest(
    1,
    "verifyIntegrity",
    { extra: true }
  )],
  ["close request", () => createAdminWorkerRequest(
    1,
    "close",
    { extra: true }
  )],
  ["initialize result", () => parseAdminWorkerResponse({
    protocolVersion: 1,
    id: 1,
    ok: true,
    result: {}
  }, "initialize")],
  ["summary result", () => parseAdminWorkerResponse({
    protocolVersion: 1,
    id: 1,
    ok: true,
    result: {
      applicationId: 0x41544731,
      userVersion: 1,
      protocolVersion: 1,
      sqliteVersion: "",
      headRows: 0,
      journalRows: 0
    }
  }, "inspectSummary")],
  ["head result", () => parseAdminWorkerResponse({
    protocolVersion: 1,
    id: 1,
    ok: true,
    result: { found: false, head: {} }
  }, "inspectHead")],
  ["integrity result", () => parseAdminWorkerResponse({
    protocolVersion: 1,
    id: 1,
    ok: true,
    result: { verified: false }
  }, "verifyIntegrity")],
  ["close result", () => parseAdminWorkerResponse({
    protocolVersion: 1,
    id: 1,
    ok: true,
    result: { closed: false }
  }, "close")]
] as const)("rejects missing, extra, or wrong fields in the %s schema", (_name, operation) => {
  expect(operation).toThrow();
});

it("detaches request and result data before returning frozen values", () => {
  const scope = { sourceId: "source", threadId: "thread" };
  const request = createAdminWorkerRequest(1, "inspectHead", { scope });
  scope.sourceId = "changed";
  expect((request.payload.scope as { sourceId: string }).sourceId).toBe("source");
  expect(Object.isFrozen(request.payload.scope)).toBe(true);

  const head = {
    scope: { sourceId: "source", threadId: "thread" },
    generation: 1,
    commitId: "commit",
    projectionFingerprint: "fingerprint"
  };
  const response = parseAdminWorkerResponse({
    protocolVersion: 1,
    id: 2,
    ok: true,
    result: { found: true, head }
  }, "inspectHead");
  head.commitId = "changed";
  if (!response.ok || !("head" in response.result)) {
    throw new Error("expected head");
  }
  expect(response.result.head.commitId).toBe("commit");
  expect(Object.isFrozen(response.result.head.scope)).toBe(true);
});

it("initializes at ID 1 and serves one detached summary request at ID 2", async () => {
  const clock = new TestClock();
  const transport = new FakeTransport();
  transport.onPost = (value) => {
    const request = value as { id: number; type: string };
    transport.respond(request.type === "initialize"
      ? {
          protocolVersion: 1,
          id: request.id,
          ok: true,
          result: { ready: true }
        }
      : {
          protocolVersion: 1,
          id: request.id,
          ok: true,
          result: {
            applicationId: 0x41544731,
            userVersion: 1,
            protocolVersion: 1,
            sqliteVersion: "3.51.3",
            headRows: 2,
            journalRows: 3,
            maxGeneration: 4
          }
        });
  };

  const application = await openAttuneGraphAdminReadonlySpineForQualification({
    transport,
    databasePath: "opaque.db",
    clock
  });
  const summary = await application.inspectSummary();
  expect(transport.posts.map((value) => (value as { id: number }).id)).toEqual([1, 2]);
  expect(summary.headRows).toBe(2);
  expect(Object.isFrozen(summary)).toBe(true);
});

it("enforces one pending request and the exact close collision/cache matrix", async () => {
  const { application, transport } = await openControlledApplication();
  const summary = application.inspectSummary();
  const reentry = await application.inspectHead({
    sourceId: "source",
    threadId: "thread"
  }).catch((cause: unknown) => cause);
  expectAdminError(
    reentry,
    "REENTRY",
    "Admin application already has an active operation"
  );
  const closeCollision = await application.close().catch((cause: unknown) => cause);
  expectAdminError(
    closeCollision,
    "REENTRY",
    "Admin application already has an active operation"
  );
  transport.respond({
    protocolVersion: 1,
    id: 2,
    ok: true,
    result: {
      applicationId: 0x41544731,
      userVersion: 1,
      protocolVersion: 1,
      sqliteVersion: "3.51.3",
      headRows: 0,
      journalRows: 0,
      maxGeneration: 0
    }
  });
  await summary;

  let reentrantClose: Promise<void> | undefined;
  transport.onPost = (value) => {
    if ((value as { type: string }).type === "close") {
      reentrantClose = application.close();
    }
  };
  const close = application.close();
  const sameClose = application.close();
  expect(reentrantClose).toBe(close);
  expect(sameClose).toBe(close);
  const unavailable = await application.inspectSummary()
    .catch((cause: unknown) => cause);
  expectAdminError(
    unavailable,
    "INVALID_STATE",
    "Admin application is not available"
  );
  transport.respond({
    protocolVersion: 1,
    id: 3,
    ok: true,
    result: { closed: true }
  });
  await close;
  expect(application.close()).toBe(close);
  expect(transport.removeCount).toBe(1);
  expect(transport.terminateCount).toBe(0);
});

it.each([
  ["inspectSummary", 5_000],
  ["inspectHead", 5_000],
  ["verifyIntegrity", 30_000],
  ["close", 5_000]
] as const)("pins the fixed %s deadline at %i ms", async (type, milliseconds) => {
  const events: string[] = [];
  const { application, clock, transport } = await openControlledApplication(events);
  transport.terminateMode = "hang";
  const promise = type === "inspectSummary"
    ? application.inspectSummary()
    : type === "inspectHead"
      ? application.inspectHead({ sourceId: "source", threadId: "thread" })
      : type === "verifyIntegrity"
        ? application.verifyIntegrity()
        : application.close();
  expect(clock.delays.at(-1)).toBe(milliseconds);
  clock.expireNext();
  const error = await promise.catch((cause: unknown) => cause);
  expectAdminError(error, "TIMED_OUT", "Admin operation timed out");
  const later = await application.inspectSummary().catch((cause: unknown) => cause);
  expect(later).toBe(error);
  expect(clock.clearCount).toBe(1);
  expect(transport.removeCount).toBe(1);
  expect(transport.terminateCount).toBe(1);
  expect(events.slice(-3)).toEqual([
    "clear-timer",
    "remove-listeners",
    "terminate"
  ]);
});

it("pins the 5 second initialize deadline", async () => {
  const clock = new TestClock();
  const transport = new FakeTransport();
  transport.terminateMode = "reject";
  const opening = openAttuneGraphAdminReadonlySpineForQualification({
    transport,
    databasePath: "opaque.db",
    clock
  });
  expect(clock.delays).toEqual([5_000]);
  clock.expireNext();
  const error = await opening.catch((cause: unknown) => cause);
  expectAdminError(error, "TIMED_OUT", "Admin operation timed out");
  expect(transport.terminateCount).toBe(1);
});

it.each([
  ["INVALID_INPUT", "Admin request is invalid"],
  ["INVALID_STATE", "Admin application is not available"],
  ["REENTRY", "Admin application already has an active operation"],
  ["SOURCE_NOT_FOUND", "Admin source was not found"],
  ["UNSUPPORTED_PROFILE", "Admin store profile is unsupported"],
  ["CORRUPT_STORE", "Admin store is corrupt"],
  ["FUTURE_STORE_STATE", "Admin store version is unsupported"],
  ["STORE_BUSY", "Admin store is busy"],
  ["TIMED_OUT", "Admin operation timed out"],
  ["WORKER_FAILURE", "Admin worker failed"]
] as const)("pins valid Worker error %s with fixed parent text", async (code, message) => {
  const events: string[] = [];
  const { application, clock, transport } = await openControlledApplication(events);
  const pending = application.inspectSummary();
  transport.respond({
    protocolVersion: 1,
    id: 2,
    ok: false,
    error: { code }
  });
  const error = await pending.catch((cause: unknown) => cause);
  expectAdminError(error, code, message);
  const later = await application.verifyIntegrity().catch((cause: unknown) => cause);
  expect(later).toBe(error);
  expect(clock.clearCount).toBe(1);
  expect(transport.removeCount).toBe(1);
  expect(transport.terminateCount).toBe(1);
  expect(events.slice(-3)).toEqual([
    "clear-timer",
    "remove-listeners",
    "terminate"
  ]);
});

it.each([
  ["malformed response", (transport: FakeTransport) => transport.respond({ bad: true })],
  ["message error", (transport: FakeTransport) => transport.emitMessageError()],
  ["transport error", (transport: FakeTransport) => transport.emitError()],
  ["premature exit", (transport: FakeTransport) => transport.emitExit()]
] as const)("maps %s to the terminal fixed Worker failure", async (_name, trigger) => {
  const events: string[] = [];
  const { application, clock, transport } = await openControlledApplication(events);
  transport.terminateMode = "throw";
  const pending = application.inspectSummary();
  trigger(transport);
  const error = await pending.catch((cause: unknown) => cause);
  expectAdminError(error, "WORKER_FAILURE", "Admin worker failed");
  transport.respond({
    protocolVersion: 1,
    id: 2,
    ok: true,
    result: {
      applicationId: 0x41544731,
      userVersion: 1,
      protocolVersion: 1,
      sqliteVersion: "private",
      headRows: 0,
      journalRows: 0,
      maxGeneration: 0
    }
  });
  expect(clock.clearCount).toBe(1);
  expect(transport.removeCount).toBe(1);
  expect(transport.terminateCount).toBe(1);
  expect(events.slice(-3)).toEqual([
    "clear-timer",
    "remove-listeners",
    "terminate"
  ]);
});

it("maps synchronous post throws and mismatched or late IDs to Worker failure", async () => {
  const events: string[] = [];
  const first = await openControlledApplication(events);
  first.transport.terminateMode = "reject";
  first.transport.postError = true;
  const postFailure = await first.application.inspectSummary()
    .catch((cause: unknown) => cause);
  expectAdminError(postFailure, "WORKER_FAILURE", "Admin worker failed");
  expect(first.clock.clearCount).toBe(1);
  expect(first.transport.removeCount).toBe(1);
  expect(first.transport.terminateCount).toBe(1);
  expect(events.slice(-3)).toEqual([
    "clear-timer",
    "remove-listeners",
    "terminate"
  ]);
  first.transport.emitError();
  expect(
    await first.application.verifyIntegrity().catch((cause: unknown) => cause)
  ).toBe(postFailure);
  expect(first.transport.terminateCount).toBe(1);

  const second = await openControlledApplication();
  const mismatched = second.application.inspectSummary();
  second.transport.respond({
    protocolVersion: 1,
    id: 99,
    ok: true,
    result: {
      applicationId: 0x41544731,
      userVersion: 1,
      protocolVersion: 1,
      sqliteVersion: "",
      headRows: 0,
      journalRows: 0,
      maxGeneration: 0
    }
  });
  expectAdminError(
    await mismatched.catch((cause: unknown) => cause),
    "WORKER_FAILURE",
    "Admin worker failed"
  );

  const third = await openControlledApplication();
  third.transport.respond({
    protocolVersion: 1,
    id: 1,
    ok: true,
    result: { ready: true }
  });
  expectAdminError(
    await third.application.inspectSummary().catch((cause: unknown) => cause),
    "WORKER_FAILURE",
    "Admin worker failed"
  );
});

it("supports idempotent async disposal without transport termination", async () => {
  const { application, transport } = await openControlledApplication();
  const disposing = application[Symbol.asyncDispose]();
  transport.respond({
    protocolVersion: 1,
    id: 2,
    ok: true,
    result: { closed: true }
  });
  await disposing;
  await application[Symbol.asyncDispose]();
  expect(transport.removeCount).toBe(1);
  expect(transport.terminateCount).toBe(0);
});
