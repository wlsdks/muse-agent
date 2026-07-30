import type { MagScope } from "./mag-contracts.js";
import {
  createAdminWorkerRequest,
  parseAdminWorkerResponse
} from "./mag-admin-readonly-protocol.mjs";

export type MagAdminErrorCode =
  | "INVALID_INPUT"
  | "INVALID_STATE"
  | "REENTRY"
  | "SOURCE_NOT_FOUND"
  | "UNSUPPORTED_PROFILE"
  | "CORRUPT_STORE"
  | "FUTURE_STORE_STATE"
  | "STORE_BUSY"
  | "TIMED_OUT"
  | "WORKER_FAILURE";

export interface MagAdminStoreSummary {
  readonly applicationId: 0x4d414731;
  readonly userVersion: 1;
  readonly protocolVersion: 1;
  readonly sqliteVersion: string;
  readonly headRows: number;
  readonly journalRows: number;
  readonly maxGeneration: number;
}

export type MagAdminHeadResult =
  | Readonly<{ found: false }>
  | Readonly<{
      found: true;
      head: Readonly<{
        scope: MagScope;
        generation: number;
        commitId: string;
        projectionFingerprint: string;
      }>;
    }>;

export interface MagAdminReadonlyApplication {
  inspectSummary(): Promise<MagAdminStoreSummary>;
  inspectHead(scope: MagScope): Promise<MagAdminHeadResult>;
  verifyIntegrity(): Promise<Readonly<{ verified: true }>>;
  close(): Promise<void>;
  [Symbol.asyncDispose](): Promise<void>;
}

export interface AdminWorkerTransport {
  postMessage(value: unknown): void;
  onMessage(listener: (value: unknown) => void): void;
  onMessageError(listener: () => void): void;
  onError(listener: () => void): void;
  onExit(listener: (code: number) => void): void;
  removeAllListeners(): void;
  terminate(): Promise<number>;
}

export interface AdminClockForQualification {
  setTimeout(callback: () => void, milliseconds: number): unknown;
  clearTimeout(handle: unknown): void;
}

type RequestType =
  | "initialize"
  | "inspectSummary"
  | "inspectHead"
  | "verifyIntegrity"
  | "close";

type Lifecycle =
  | "constructing"
  | "initializing"
  | "ready"
  | "closing"
  | "closed"
  | "failed";

interface PendingRequest {
  readonly id: number;
  readonly type: RequestType;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: MagAdminReadonlyError) => void;
  timer: unknown | undefined;
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: MagAdminReadonlyError) => void;
}

const errorMessages: Readonly<Record<MagAdminErrorCode, string>> = Object.freeze({
  INVALID_INPUT: "Admin request is invalid",
  INVALID_STATE: "Admin application is not available",
  REENTRY: "Admin application already has an active operation",
  SOURCE_NOT_FOUND: "Admin source was not found",
  UNSUPPORTED_PROFILE: "Admin store profile is unsupported",
  CORRUPT_STORE: "Admin store is corrupt",
  FUTURE_STORE_STATE: "Admin store version is unsupported",
  STORE_BUSY: "Admin store is busy",
  TIMED_OUT: "Admin operation timed out",
  WORKER_FAILURE: "Admin worker failed"
});

const deadlines: Readonly<Record<RequestType, number>> = Object.freeze({
  initialize: 5_000,
  inspectSummary: 5_000,
  inspectHead: 5_000,
  verifyIntegrity: 30_000,
  close: 5_000
});

export class MagAdminReadonlyError extends Error {
  readonly code: MagAdminErrorCode;

  constructor(code: MagAdminErrorCode) {
    super(errorMessages[code]);
    this.name = "MagAdminReadonlyError";
    this.code = code;
    Object.freeze(this);
  }
}

const systemClock: AdminClockForQualification = Object.freeze({
  setTimeout(callback: () => void, milliseconds: number): unknown {
    return setTimeout(callback, milliseconds);
  },
  clearTimeout(handle: unknown): void {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  }
});

function applicationError(code: MagAdminErrorCode): MagAdminReadonlyError {
  return new MagAdminReadonlyError(code);
}

function deferred<T>(): Deferred<T> {
  let resolvePromise!: (value: unknown) => void;
  let rejectPromise!: (error: MagAdminReadonlyError) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve as (value: unknown) => void;
    rejectPromise = reject;
  });
  return {
    promise,
    resolve: resolvePromise,
    reject: rejectPromise
  };
}

function createSpine(
  transport: AdminWorkerTransport,
  databasePath: string,
  clock: AdminClockForQualification
): Promise<MagAdminReadonlyApplication> {
  let lifecycle: Lifecycle = "constructing";
  let previousRequestId = 0;
  let pending: PendingRequest | undefined;
  let pinnedError: MagAdminReadonlyError | undefined;
  let closePromise: Promise<void> | undefined;
  let listenersRemoved = false;
  let terminationStarted = false;

  const removeListeners = (): void => {
    if (listenersRemoved) return;
    listenersRemoved = true;
    try {
      transport.removeAllListeners();
    } catch {
    }
  };

  const clearPendingTimer = (request: PendingRequest): void => {
    if (request.timer === undefined) return;
    const handle = request.timer;
    request.timer = undefined;
    try {
      clock.clearTimeout(handle);
    } catch {
    }
  };

  const terminateOnce = (): void => {
    if (terminationStarted) return;
    terminationStarted = true;
    try {
      void Promise.resolve(transport.terminate()).catch(() => undefined);
    } catch {
    }
  };

  const terminalFailure = (
    code: MagAdminErrorCode
  ): MagAdminReadonlyError => {
    if (pinnedError !== undefined) return pinnedError;
    const error = applicationError(code);
    pinnedError = error;
    lifecycle = "failed";
    const active = pending;
    if (active !== undefined) {
      active.reject(error);
      clearPendingTimer(active);
      pending = undefined;
    }
    removeListeners();
    terminateOnce();
    return error;
  };

  const handleMessage = (value: unknown): void => {
    if (lifecycle === "failed" || lifecycle === "closed") return;
    const active = pending;
    if (active === undefined) {
      terminalFailure("WORKER_FAILURE");
      return;
    }

    let response: ReturnType<typeof parseAdminWorkerResponse>;
    try {
      response = parseAdminWorkerResponse(value, active.type);
    } catch {
      terminalFailure("WORKER_FAILURE");
      return;
    }
    if (response.id !== active.id) {
      terminalFailure("WORKER_FAILURE");
      return;
    }
    if (!response.ok) {
      terminalFailure(response.error.code as MagAdminErrorCode);
      return;
    }

    active.resolve(response.result);
    clearPendingTimer(active);
    pending = undefined;
    if (active.type === "initialize") {
      lifecycle = "ready";
    } else if (active.type === "close") {
      removeListeners();
      lifecycle = "closed";
    }
  };

  const issue = <T>(
    type: RequestType,
    payload: unknown,
    existing?: Deferred<T>
  ): Promise<T> => {
    let request: ReturnType<typeof createAdminWorkerRequest>;
    try {
      request = createAdminWorkerRequest(previousRequestId, type, payload);
    } catch {
      const error = terminalFailure("INVALID_INPUT");
      if (existing !== undefined) {
        existing.reject(error);
        return existing.promise;
      }
      return Promise.reject(error);
    }
    previousRequestId = request.id;

    const requestDeferred = existing ?? deferred<T>();
    const active: PendingRequest = {
      id: request.id,
      type,
      resolve: requestDeferred.resolve,
      reject: requestDeferred.reject,
      timer: undefined
    };
    pending = active;
    try {
      active.timer = clock.setTimeout(
        () => terminalFailure("TIMED_OUT"),
        deadlines[type]
      );
    } catch {
      terminalFailure("WORKER_FAILURE");
      return requestDeferred.promise;
    }
    try {
      transport.postMessage(request);
    } catch {
      terminalFailure("WORKER_FAILURE");
    }
    return requestDeferred.promise;
  };

  const rejectUnavailable = <T>(): Promise<T> => {
    if (pinnedError !== undefined) return Promise.reject(pinnedError);
    return Promise.reject(applicationError("INVALID_STATE"));
  };

  const beginOperation = <T>(
    type: Exclude<RequestType, "initialize" | "close">,
    payload: unknown
  ): Promise<T> => {
    if (lifecycle !== "ready") return rejectUnavailable<T>();
    if (pending !== undefined) {
      return Promise.reject(applicationError("REENTRY"));
    }
    return issue<T>(type, payload);
  };

  const application: MagAdminReadonlyApplication = Object.freeze({
    inspectSummary() {
      return beginOperation<MagAdminStoreSummary>("inspectSummary", {});
    },
    inspectHead(scope: MagScope) {
      return beginOperation<MagAdminHeadResult>("inspectHead", { scope });
    },
    verifyIntegrity() {
      return beginOperation<Readonly<{ verified: true }>>(
        "verifyIntegrity",
        {}
      );
    },
    close() {
      if (closePromise !== undefined) return closePromise;
      if (pinnedError !== undefined) return Promise.reject(pinnedError);
      if (lifecycle !== "ready") return rejectUnavailable<void>();
      if (pending !== undefined) {
        return Promise.reject(applicationError("REENTRY"));
      }
      const closing = deferred<void>();
      closePromise = closing.promise;
      lifecycle = "closing";
      issue<void>("close", {}, {
        promise: closing.promise,
        resolve: () => closing.resolve(undefined),
        reject: closing.reject
      });
      return closePromise;
    },
    [Symbol.asyncDispose]() {
      return application.close();
    }
  });

  try {
    transport.onMessage(handleMessage);
    transport.onMessageError(() => terminalFailure("WORKER_FAILURE"));
    transport.onError(() => terminalFailure("WORKER_FAILURE"));
    transport.onExit(() => terminalFailure("WORKER_FAILURE"));
  } catch {
    return Promise.reject(terminalFailure("WORKER_FAILURE"));
  }
  lifecycle = "initializing";
  return issue<Readonly<{ ready: true }>>("initialize", { databasePath })
    .then(() => application);
}

export function openMagAdminReadonlySpine(
  transport: AdminWorkerTransport,
  databasePath: string
): Promise<MagAdminReadonlyApplication> {
  return createSpine(transport, databasePath, systemClock);
}

export function openMagAdminReadonlySpineForQualification(
  options: Readonly<{
    transport: AdminWorkerTransport;
    databasePath: string;
    clock: AdminClockForQualification;
  }>
): Promise<MagAdminReadonlyApplication> {
  return createSpine(options.transport, options.databasePath, options.clock);
}
