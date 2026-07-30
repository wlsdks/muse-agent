import { Worker } from "node:worker_threads";

import type { MagStoreBackend, MagStoredProjection } from "./mag-backend.js";
import type { MagScope, MagSnapshot } from "./mag-contracts.js";
import { MagError, type MagErrorCode } from "./mag-error.js";

const PROTOCOL_VERSION = 1;
const MAX_ENVELOPE_BYTES = 2_097_152;
const REQUEST_TIMEOUT_MS = 5_000;
const CLOSE_TIMEOUT_MS = 5_000;
const SERIALIZED_ERROR_CODES: ReadonlySet<MagErrorCode> = new Set([
  "CORRUPT_STORE",
  "FUTURE_STORE_STATE",
  "STORE_FAILURE",
  "UNSUPPORTED_STORE_PROFILE"
]);

type WorkerRequestType =
  | "initialize"
  | "read"
  | "compareAndSwap"
  | "holdWriteLockForTesting"
  | "inspectForTesting"
  | "mutateForTesting"
  | "close";
export type SqliteMagTestFault =
  | "before-commit"
  | "after-commit-before-ack"
  | "hang-read"
  | "hang-close";
export type SqliteMagTestMutation =
  | "future-user-version"
  | "wrong-application-id"
  | "malformed-projection-json"
  | "missing-journal-row"
  | "partial-bootstrap"
  | "oversized-projection-json"
  | "mismatched-head"
  | "quick-check-corruption";

export interface SqliteMagTestInspection {
  readonly headRows: number;
  readonly journalRows: number;
  readonly maxGeneration: number;
}

interface WorkerRequest {
  readonly protocolVersion: 1;
  readonly id: number;
  readonly type: WorkerRequestType;
  readonly payload: unknown;
}

interface PendingRequest {
  readonly resolve: (value: unknown) => void;
  readonly reject: (cause: MagError) => void;
  readonly timeout: ReturnType<typeof setTimeout>;
  readonly type: WorkerRequestType;
}

export interface OpenSqliteMagStoreOptions {
  readonly databasePath: string;
  /** Internal deterministic crash fixture; never exported from the public local subpath. */
  readonly testFault?: SqliteMagTestFault;
  /** Internal physical-state fixture; never exported from the public local subpath. */
  readonly testFixtureMode?: true;
  /** Internal bounded deadline fixture; never exported from the public local subpath. */
  readonly testTimeoutMs?: number;
  /** Internal late-response fixture; never exported from the public local subpath. */
  readonly testResponseDelayMs?: number;
}

export interface OpenedSqliteMagStore {
  readonly backend: MagStoreBackend;
  close(): Promise<void>;
  dispose(): Promise<void>;
  /** Internal deterministic crash fixture; never exported from the public local subpath. */
  terminateForTesting(): Promise<number>;
  /** Internal physical-state fixture; never exported from the public local subpath. */
  mutateForTesting(mutation: SqliteMagTestMutation): Promise<void>;
  /** Internal lock-contention fixture; never exported from the public local subpath. */
  holdWriteLockForTesting(durationMs: number): Promise<void>;
  /** Internal physical-state fixture; never exported from the public local subpath. */
  inspectForTesting(): Promise<SqliteMagTestInspection>;
}

function storeFailure(message: string, cause?: unknown): MagError {
  return new MagError("STORE_FAILURE", message, cause === undefined ? undefined : { cause });
}

function serializedSize(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value), "utf8");
  } catch (cause) {
    throw storeFailure("local MAG protocol value is not serializable", cause);
  }
}

function plainRecord(
  value: unknown,
  label: string,
  allowed: readonly string[],
  required: readonly string[] = allowed
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw storeFailure(`${label} must be a plain object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw storeFailure(`${label} must be a plain object`);
  }
  const keys = Object.keys(value);
  if (keys.length !== Reflect.ownKeys(value).length || keys.some((key) => !allowed.includes(key))) {
    throw storeFailure(`${label} has unknown fields`);
  }
  if (required.some((key) => !Object.hasOwn(value, key))) {
    throw storeFailure(`${label} has missing fields`);
  }
  return value as Record<string, unknown>;
}

function errorFromEnvelope(value: unknown): MagError {
  const input = plainRecord(value, "worker error", ["code", "message"]);
  if (
    typeof input.code !== "string"
    || !SERIALIZED_ERROR_CODES.has(input.code as MagErrorCode)
    || typeof input.message !== "string"
    || input.message.length === 0
    || input.message.length > 1_024
  ) {
    throw storeFailure("local MAG worker returned an invalid error envelope");
  }
  return new MagError(input.code as MagErrorCode, input.message);
}

function detachedProjection(value: unknown): MagStoredProjection {
  try {
    return JSON.parse(JSON.stringify(value)) as MagStoredProjection;
  } catch (cause) {
    throw storeFailure("local MAG worker returned an unserializable projection", cause);
  }
}

export async function openSqliteMagStore(
  options: OpenSqliteMagStoreOptions
): Promise<OpenedSqliteMagStore> {
  const input = plainRecord(
    options,
    "SQLite MAG options",
    [
      "databasePath",
      "testFault",
      "testFixtureMode",
      "testTimeoutMs",
      "testResponseDelayMs"
    ],
    ["databasePath"]
  );
  if (typeof input.databasePath !== "string") {
    throw new MagError(
      "UNSUPPORTED_STORE_PROFILE",
      "databasePath must be an explicit absolute path"
    );
  }
  if (
    input.testFault !== undefined
    && input.testFault !== "before-commit"
    && input.testFault !== "after-commit-before-ack"
    && input.testFault !== "hang-read"
    && input.testFault !== "hang-close"
  ) {
    throw new MagError("INVALID_INPUT", "SQLite MAG test fault is invalid");
  }
  if (input.testFault !== undefined && process.env.NODE_ENV !== "test") {
    throw new MagError(
      "INVALID_INPUT",
      "SQLite MAG test faults are available only under the test runtime"
    );
  }
  if (input.testFixtureMode !== undefined && input.testFixtureMode !== true) {
    throw new MagError("INVALID_INPUT", "SQLite MAG test fixture mode is invalid");
  }
  if (input.testFixtureMode === true && process.env.NODE_ENV !== "test") {
    throw new MagError(
      "INVALID_INPUT",
      "SQLite MAG test fixture mode is available only under the test runtime"
    );
  }
  if (
    input.testTimeoutMs !== undefined
    && (
      !Number.isSafeInteger(input.testTimeoutMs)
      || (input.testTimeoutMs as number) < 10
      || (input.testTimeoutMs as number) > 1_000
    )
  ) {
    throw new MagError("INVALID_INPUT", "SQLite MAG test timeout is invalid");
  }
  if (input.testTimeoutMs !== undefined && process.env.NODE_ENV !== "test") {
    throw new MagError(
      "INVALID_INPUT",
      "SQLite MAG test timeout is available only under the test runtime"
    );
  }
  if (
    input.testResponseDelayMs !== undefined
    && (
      !Number.isSafeInteger(input.testResponseDelayMs)
      || (input.testResponseDelayMs as number) < 1
      || (input.testResponseDelayMs as number) > 1_000
    )
  ) {
    throw new MagError("INVALID_INPUT", "SQLite MAG test response delay is invalid");
  }
  if (input.testResponseDelayMs !== undefined && process.env.NODE_ENV !== "test") {
    throw new MagError(
      "INVALID_INPUT",
      "SQLite MAG test response delay is available only under the test runtime"
    );
  }
  const requestTimeoutMs = (input.testTimeoutMs as number | undefined)
    ?? REQUEST_TIMEOUT_MS;
  const closeTimeoutMs = (input.testTimeoutMs as number | undefined)
    ?? CLOSE_TIMEOUT_MS;

  const worker = new Worker(new URL("./mag-local-worker.mjs", import.meta.url), {
    // This Worker is a self-contained emitted .mjs artifact. Parent invocation-only
    // flags such as --input-type/-e must not be inherited by a file-backed Worker.
    execArgv: [],
    name: "muse-mag-sqlite",
    workerData: input.testFault === undefined && input.testFixtureMode !== true
      ? undefined
      : {
          testFault: input.testFault,
          testFixtureMode: input.testFixtureMode === true
        }
  });
  const pending = new Map<number, PendingRequest>();
  let nextRequestId = 1;
  let lifecycle: "opening" | "open" | "closing" | "closed" | "failed" = "opening";
  let failure: MagError | undefined;
  let closePromise: Promise<void> | undefined;
  let inFlight = 0;
  let drainResolve: (() => void) | undefined;
  let exitResolve: (() => void) | undefined;
  let observedExit = false;
  let closeAcknowledged = false;
  let terminationPromise: Promise<void> | undefined;
  let failureCleanup: Promise<void> | undefined;
  const exitPromise = new Promise<void>((resolve) => {
    exitResolve = resolve;
  });

  const settlePending = (cause: MagError): void => {
    for (const request of pending.values()) {
      clearTimeout(request.timeout);
      request.reject(cause);
    }
    pending.clear();
  };

  const waitForWorkerTermination = (): Promise<void> => {
    if (observedExit) return Promise.resolve();
    if (!terminationPromise) {
      terminationPromise = worker
        .terminate()
        .then(() => undefined)
        .catch(() => exitPromise);
    }
    return terminationPromise;
  };

  const failStop = (cause: unknown): MagError => {
    if (failure) return failure;
    failure = cause instanceof MagError
      ? cause
      : storeFailure("local MAG worker failed", cause);
    lifecycle = "failed";
    const terminalFailure = failure;
    failureCleanup = waitForWorkerTermination().then(() => {
      settlePending(terminalFailure);
    });
    return failure;
  };

  const rejectAfterFailStop = async (cause: unknown): Promise<never> => {
    const terminalFailure = failStop(cause);
    await failureCleanup;
    throw terminalFailure;
  };

  const onMessage = (message: unknown): void => {
    if (failure) return;
    try {
      if (serializedSize(message) > MAX_ENVELOPE_BYTES) {
        throw storeFailure("local MAG worker returned an oversized response");
      }
      const response = plainRecord(
        message,
        "worker response",
        ["protocolVersion", "id", "ok", "result", "error"],
        ["protocolVersion", "id", "ok"]
      );
      if (
        response.protocolVersion !== PROTOCOL_VERSION
        || !Number.isSafeInteger(response.id)
        || (response.id as number) < 1
        || typeof response.ok !== "boolean"
      ) {
        throw storeFailure("local MAG worker returned an invalid response");
      }
      const request = pending.get(response.id as number);
      if (!request) {
        throw storeFailure("local MAG worker returned a duplicate or unknown response");
      }
      if (response.ok) {
        if (!Object.hasOwn(response, "result") || Object.hasOwn(response, "error")) {
          throw storeFailure("local MAG success response is malformed");
        }
        pending.delete(response.id as number);
        clearTimeout(request.timeout);
        if (request.type === "close") closeAcknowledged = true;
        request.resolve(response.result);
      } else {
        if (!Object.hasOwn(response, "error") || Object.hasOwn(response, "result")) {
          throw storeFailure("local MAG error response is malformed");
        }
        const typedError = errorFromEnvelope(response.error);
        if (request.type === "initialize" || request.type === "close") {
          failStop(typedError);
          return;
        }
        pending.delete(response.id as number);
        clearTimeout(request.timeout);
        request.reject(typedError);
      }
    } catch (cause) {
      failStop(cause);
    }
  };

  worker.on("message", (message) => {
    if (input.testResponseDelayMs === undefined) {
      onMessage(message);
      return;
    }
    setTimeout(
      () => onMessage(message),
      input.testResponseDelayMs as number
    ).unref();
  });
  worker.on("messageerror", (cause) => {
    failStop(storeFailure("local MAG worker response could not be deserialized", cause));
  });
  worker.on("error", (cause) => {
    failStop(storeFailure("local MAG worker emitted an unexpected error", cause));
  });
  worker.on("exit", (code) => {
    observedExit = true;
    exitResolve?.();
    if (!closeAcknowledged) {
      failStop(storeFailure(`local MAG worker exited unexpectedly with code ${code}`));
    } else if (code !== 0) {
      failStop(storeFailure(`local MAG worker close exited with code ${code}`));
    }
  });

  const request = (
    type: WorkerRequestType,
    payload: unknown,
    timeoutMs = requestTimeoutMs
  ): Promise<unknown> => {
    if (failure) return Promise.reject(failure);
    if (
      (type !== "initialize" && lifecycle !== "open" && type !== "close")
      || (type === "initialize" && lifecycle !== "opening")
      || (type === "close" && lifecycle !== "closing")
    ) {
      return Promise.reject(storeFailure("local MAG worker is not accepting requests"));
    }
    if (!Number.isSafeInteger(nextRequestId) || nextRequestId > Number.MAX_SAFE_INTEGER) {
      return rejectAfterFailStop(
        storeFailure("local MAG request ID space is exhausted")
      );
    }
    const id = nextRequestId;
    nextRequestId += 1;
    const envelope: WorkerRequest = {
      protocolVersion: PROTOCOL_VERSION,
      id,
      type,
      payload
    };
    if (serializedSize(envelope) > MAX_ENVELOPE_BYTES) {
      return rejectAfterFailStop(storeFailure("local MAG request is oversized"));
    }
    return new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (!pending.has(id)) return;
        failStop(storeFailure(`local MAG ${type} request timed out`));
      }, timeoutMs);
      timeout.unref();
      pending.set(id, { reject, resolve, timeout, type });
      try {
        worker.postMessage(envelope);
      } catch (cause) {
        if (pending.has(id)) {
          failStop(storeFailure("local MAG request could not be posted", cause));
        }
      }
    });
  };

  const begin = <T>(operation: () => Promise<T>): Promise<T> => {
    if (lifecycle !== "open") {
      return Promise.reject(
        failure ?? new MagError("CLOSED", "local MAG Store is closing or closed")
      );
    }
    inFlight += 1;
    return Promise.resolve()
      .then(operation)
      .finally(() => {
        inFlight -= 1;
        if (inFlight === 0) drainResolve?.();
      });
  };

  try {
    const handshake = await request(
      "initialize",
      { databasePath: input.databasePath },
      REQUEST_TIMEOUT_MS
    );
    const profile = plainRecord(handshake, "worker handshake", [
      "applicationId",
      "profileVersion",
      "protocolVersion",
      "sqliteVersion",
      "userVersion"
    ]);
    if (
      profile.applicationId !== 0x4d414731
      || profile.profileVersion !== 1
      || profile.protocolVersion !== PROTOCOL_VERSION
      || typeof profile.sqliteVersion !== "string"
      || profile.userVersion !== 1
    ) {
      throw failStop(storeFailure("local MAG worker handshake is unsupported"));
    }
    lifecycle = "open";
  } catch (cause) {
    failStop(cause);
    await failureCleanup;
    throw failure;
  }

  const backend: MagStoreBackend = Object.freeze({
    read(scope: MagScope): Promise<MagStoredProjection | undefined> {
      return begin(async () => {
        const response = plainRecord(
          await request("read", { scope }),
          "worker read result",
          ["found", "projection"],
          ["found"]
        );
        if (response.found === false && !Object.hasOwn(response, "projection")) return undefined;
        if (response.found !== true || !Object.hasOwn(response, "projection")) {
          return rejectAfterFailStop(
            storeFailure("local MAG worker returned an invalid read result")
          );
        }
        return detachedProjection(response.projection);
      });
    },
    compareAndSwap(
      scope: MagScope,
      expected: MagSnapshot | undefined,
      proposed: MagStoredProjection
    ): Promise<boolean> {
      return begin(async () => {
        const response = plainRecord(
          await request("compareAndSwap", {
            scope,
            expected: expected ?? null,
            proposed
          }),
          "worker compare-and-swap result",
          ["committed"]
        );
        if (typeof response.committed !== "boolean") {
          return rejectAfterFailStop(
            storeFailure("local MAG worker returned an invalid compare-and-swap result")
          );
        }
        return response.committed;
      });
    }
  });

  const close = (): Promise<void> => {
    if (closePromise) return closePromise;
    lifecycle = lifecycle === "failed" ? "failed" : "closing";
    closePromise = (async () => {
      if (failure) {
        await failureCleanup;
        throw failure;
      }
      if (inFlight > 0) {
        await new Promise<void>((resolve) => {
          drainResolve = resolve;
        });
      }
      await request("close", {}, closeTimeoutMs);
      if (!observedExit) {
        let exitTimeout: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            exitPromise,
            new Promise<never>((_, reject) => {
              exitTimeout = setTimeout(
                () => reject(storeFailure("local MAG worker did not exit after close")),
                closeTimeoutMs
              );
              exitTimeout.unref();
            })
          ]);
        } finally {
          if (exitTimeout) clearTimeout(exitTimeout);
        }
      }
      if (failure) throw failure;
      lifecycle = "closed";
    })().catch(async (cause) => {
      const terminalFailure = failStop(cause);
      await failureCleanup;
      throw terminalFailure;
    });
    return closePromise;
  };

  const terminateForTesting = (): Promise<number> => worker.terminate();
  const mutateForTesting = async (
    mutation: SqliteMagTestMutation
  ): Promise<void> => {
    if (input.testFixtureMode !== true) {
      throw new MagError("INVALID_INPUT", "SQLite MAG test fixture mode is disabled");
    }
    const response = plainRecord(
      await request("mutateForTesting", { mutation }),
      "worker test mutation result",
      ["mutated"]
    );
    if (response.mutated !== true) {
      return rejectAfterFailStop(
        storeFailure("local MAG worker returned an invalid test mutation")
      );
    }
  };
  const holdWriteLockForTesting = async (durationMs: number): Promise<void> => {
    if (input.testFixtureMode !== true) {
      throw new MagError("INVALID_INPUT", "SQLite MAG test fixture mode is disabled");
    }
    const response = plainRecord(
      await request("holdWriteLockForTesting", { durationMs }),
      "worker lock fixture result",
      ["acquired"]
    );
    if (response.acquired !== true) {
      return rejectAfterFailStop(
        storeFailure("local MAG worker returned an invalid lock fixture")
      );
    }
  };
  const inspectForTesting = async (): Promise<SqliteMagTestInspection> => {
    if (input.testFixtureMode !== true) {
      throw new MagError("INVALID_INPUT", "SQLite MAG test fixture mode is disabled");
    }
    const response = plainRecord(
      await request("inspectForTesting", {}),
      "worker inspection result",
      ["headRows", "journalRows", "maxGeneration"]
    );
    if (
      !Number.isSafeInteger(response.headRows)
      || !Number.isSafeInteger(response.journalRows)
      || !Number.isSafeInteger(response.maxGeneration)
    ) {
      return rejectAfterFailStop(
        storeFailure("local MAG worker returned an invalid inspection")
      );
    }
    return Object.freeze({
      headRows: response.headRows as number,
      journalRows: response.journalRows as number,
      maxGeneration: response.maxGeneration as number
    });
  };

  return Object.freeze({
    backend,
    close,
    dispose: close,
    terminateForTesting,
    mutateForTesting,
    holdWriteLockForTesting,
    inspectForTesting
  });
}
