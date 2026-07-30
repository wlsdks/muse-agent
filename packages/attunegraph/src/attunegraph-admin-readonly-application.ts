import { types as nodeTypes } from "node:util";
import { Worker } from "node:worker_threads";

import type { AttuneGraphScope } from "./attunegraph-contracts.js";
import {
  type AdminClockForQualification,
  type AdminWorkerTransport,
  type AttuneGraphAdminErrorCode,
  type AttuneGraphAdminHeadResult,
  type AttuneGraphAdminReadonlyApplication,
  AttuneGraphAdminReadonlyError,
  type AttuneGraphAdminStoreSummary,
  openAttuneGraphAdminReadonlySpine,
  openAttuneGraphAdminReadonlySpineForQualification
} from "./attunegraph-admin-readonly-spine.js";
import {
  acquireAttuneGraphAdminReadonlySnapshot,
  readAttuneGraphAdminReadonlySnapshotFailure,
  startAttuneGraphAdminReadonlySnapshotQualification
} from "./attunegraph-admin-readonly-snapshot.mjs";

export interface OpenAttuneGraphAdminReadonlyApplicationOptions {
  readonly databasePath: string;
  readonly sourceState: "closed-quiescent";
}

type ApplicationQualificationFault =
  | "spawn-failure"
  | "initialize-timeout"
  | "forced-exit-before-ready"
  | "forced-exit-on-summary"
  | "idle-exit-while-ready"
  | "delayed-plane-b-exit"
  | "nonzero-exit-after-close-response"
  | "initialize-timeout-with-release-failure"
  | "release-failure-after-clean-close";

export type ApplicationQualificationStage =
  | "snapshot:acquire:start"
  | "snapshot:acquire:success"
  | "snapshot:acquire:failure"
  | "worker:spawn:start"
  | "worker:spawn:success"
  | "worker:spawn:failure"
  | "spine:initialize:start"
  | "spine:initialize:success"
  | "spine:initialize:failure"
  | "operation:failure"
  | "close:start"
  | "close:response"
  | "close:failure"
  | "plane-a:terminal"
  | "e1:error:recovered"
  | "worker:terminate"
  | "worker:exit"
  | "lease:release:start"
  | "lease:release:success"
  | "lease:release:failure"
  | "terminal:settled";

export interface ApplicationQualificationAudit {
  readonly primaryCode?: AttuneGraphAdminErrorCode;
  readonly snapshotAcquireAttempts: number;
  readonly leasesAcquired: number;
  readonly workerSpawnAttempts: number;
  readonly workersSpawned: number;
  readonly spineInitializeSettlements: number;
  readonly closeResponses: number;
  readonly spineCloseSettlements: number;
  readonly planeATerminalCallbacks: number;
  readonly pinnedErrorRecoveries: number;
  readonly workerTerminateCalls: number;
  readonly workerExitSettlements: number;
  readonly workerExitCode?: number;
  readonly leaseReleaseAttempts: number;
  readonly leaseReleaseSettlements: number;
  readonly leaseReleaseFailures: number;
  readonly exactPinnedErrorPreserved: boolean;
  readonly terminalAuditSettlements: 1;
  readonly trace: readonly ApplicationQualificationStage[];
}

interface SnapshotLease {
  readonly snapshotDatabasePath: string;
  release(): Promise<void>;
}

interface AuditState {
  primaryCode?: AttuneGraphAdminErrorCode;
  snapshotAcquireAttempts: number;
  leasesAcquired: number;
  workerSpawnAttempts: number;
  workersSpawned: number;
  spineInitializeSettlements: number;
  closeResponses: number;
  spineCloseSettlements: number;
  planeATerminalCallbacks: number;
  pinnedErrorRecoveries: number;
  workerTerminateCalls: number;
  workerExitSettlements: number;
  workerExitCode?: number;
  leaseReleaseAttempts: number;
  leaseReleaseSettlements: number;
  leaseReleaseFailures: number;
  exactPinnedErrorPreserved: boolean;
  settled: boolean;
  trace: ApplicationQualificationStage[];
  resolve: (audit: Readonly<ApplicationQualificationAudit>) => void;
  terminalAudit: Promise<Readonly<ApplicationQualificationAudit>>;
}

interface PlaneAListeners {
  message?: (value: unknown) => void;
  messageError?: () => void;
  error?: () => void;
  exit?: (code: number) => void;
}

interface WorkerAdapter {
  readonly transport: AdminWorkerTransport;
  readonly exit: Promise<number>;
  forceIdleExit(): void;
}

const WORKER_MODULE_URL = new URL("./attunegraph-admin-readonly-worker.mjs", import.meta.url);
const WORKER_NAME = "attunegraph-admin-readonly";
const PARENT_EXIT_DEADLINE_MS = 5_000;
const QUALIFICATION_EXIT_DEADLINE_MS = 10;
const QUALIFICATION_FAULTS: readonly ApplicationQualificationFault[] =
  Object.freeze([
    "spawn-failure",
    "initialize-timeout",
    "forced-exit-before-ready",
    "forced-exit-on-summary",
    "idle-exit-while-ready",
    "delayed-plane-b-exit",
    "nonzero-exit-after-close-response",
    "initialize-timeout-with-release-failure",
    "release-failure-after-clean-close"
  ]);

function applicationError(code: AttuneGraphAdminErrorCode): AttuneGraphAdminReadonlyError {
  return new AttuneGraphAdminReadonlyError(code);
}

function asApplicationError(cause: unknown): AttuneGraphAdminReadonlyError {
  return cause instanceof AttuneGraphAdminReadonlyError
    ? cause
    : applicationError("WORKER_FAILURE");
}

function snapshotError(cause: unknown): AttuneGraphAdminReadonlyError {
  return applicationError(
    readAttuneGraphAdminReadonlySnapshotFailure(cause) ?? "WORKER_FAILURE"
  );
}

function createAuditState(): AuditState {
  let resolve!: (audit: Readonly<ApplicationQualificationAudit>) => void;
  const terminalAudit = new Promise<Readonly<ApplicationQualificationAudit>>(
    (settle) => {
      resolve = settle;
    }
  );
  return {
    snapshotAcquireAttempts: 0,
    leasesAcquired: 0,
    workerSpawnAttempts: 0,
    workersSpawned: 0,
    spineInitializeSettlements: 0,
    closeResponses: 0,
    spineCloseSettlements: 0,
    planeATerminalCallbacks: 0,
    pinnedErrorRecoveries: 0,
    workerTerminateCalls: 0,
    workerExitSettlements: 0,
    leaseReleaseAttempts: 0,
    leaseReleaseSettlements: 0,
    leaseReleaseFailures: 0,
    exactPinnedErrorPreserved: true,
    settled: false,
    trace: [],
    resolve,
    terminalAudit
  };
}

function settleAudit(audit: AuditState): void {
  if (audit.settled) return;
  audit.settled = true;
  audit.trace.push("terminal:settled");
  audit.resolve(Object.freeze({
    primaryCode: audit.primaryCode,
    snapshotAcquireAttempts: audit.snapshotAcquireAttempts,
    leasesAcquired: audit.leasesAcquired,
    workerSpawnAttempts: audit.workerSpawnAttempts,
    workersSpawned: audit.workersSpawned,
    spineInitializeSettlements: audit.spineInitializeSettlements,
    closeResponses: audit.closeResponses,
    spineCloseSettlements: audit.spineCloseSettlements,
    planeATerminalCallbacks: audit.planeATerminalCallbacks,
    pinnedErrorRecoveries: audit.pinnedErrorRecoveries,
    workerTerminateCalls: audit.workerTerminateCalls,
    workerExitSettlements: audit.workerExitSettlements,
    workerExitCode: audit.workerExitCode,
    leaseReleaseAttempts: audit.leaseReleaseAttempts,
    leaseReleaseSettlements: audit.leaseReleaseSettlements,
    leaseReleaseFailures: audit.leaseReleaseFailures,
    exactPinnedErrorPreserved: audit.exactPinnedErrorPreserved,
    terminalAuditSettlements: 1,
    trace: Object.freeze([...audit.trace])
  }));
}

function note(audit: AuditState | undefined, stage: ApplicationQualificationStage): void {
  audit?.trace.push(stage);
}

function createInitializeTimeoutClock(): AdminClockForQualification {
  return Object.freeze({
    setTimeout(callback: () => void): unknown {
      return setTimeout(callback, 0);
    },
    clearTimeout(handle: unknown): void {
      clearTimeout(handle as ReturnType<typeof setTimeout>);
    }
  });
}

function createWorkerAdapter(
  worker: Worker,
  fault: ApplicationQualificationFault | undefined,
  audit: AuditState | undefined,
  onTerminal: () => Promise<void>
): WorkerAdapter {
  let armed = true;
  let listeners: PlaneAListeners = {};
  let bufferedExit: number | undefined;
  let exitSettled = false;
  let closeRequested = false;
  let rawExitCode: number | undefined;
  let terminalHook: Promise<void> = Promise.resolve();
  let terminateTimer: ReturnType<typeof setTimeout> | undefined;
  let terminatePromise: Promise<number> | undefined;
  let resolveTerminate: ((code: number) => void) | undefined;
  let resolveExit!: (code: number) => void;
  const exit = new Promise<number>((resolve) => {
    resolveExit = resolve;
  });

  const reportedExitCode = (code: number): number => {
    if (
      fault === "forced-exit-before-ready"
      || fault === "forced-exit-on-summary"
      || fault === "idle-exit-while-ready"
      || fault === "delayed-plane-b-exit"
      || fault === "initialize-timeout"
      || fault === "initialize-timeout-with-release-failure"
      || (
        fault === "nonzero-exit-after-close-response"
        && closeRequested
      )
    ) return 1;
    return code;
  };
  const recordExit = (code: number): void => {
    if (exitSettled) return;
    exitSettled = true;
    if (terminateTimer !== undefined) {
      clearTimeout(terminateTimer);
      terminateTimer = undefined;
    }
    const admittedCode = reportedExitCode(code);
    if (audit !== undefined) {
      audit.workerExitSettlements += 1;
      audit.workerExitCode = admittedCode;
      note(audit, "worker:exit");
    }
    resolveTerminate?.(admittedCode);
    resolveExit(admittedCode);
  };
  const invokeRawTerminate = async (): Promise<number> => {
    if (audit !== undefined) {
      audit.workerTerminateCalls += 1;
      note(audit, "worker:terminate");
    }
    let code = 1;
    try {
      code = await worker.terminate();
    } catch {
    }
    if (fault === "delayed-plane-b-exit" && rawExitCode !== undefined) {
      recordExit(rawExitCode);
    }
    return code;
  };
  const scheduleTerminate = (): Promise<number> => {
    if (terminatePromise !== undefined) return terminatePromise;
    terminatePromise = new Promise<number>((resolve) => {
      resolveTerminate = resolve;
    });
    const delay = audit === undefined
      ? PARENT_EXIT_DEADLINE_MS
      : QUALIFICATION_EXIT_DEADLINE_MS;
    terminateTimer = setTimeout(() => {
      terminateTimer = undefined;
      void invokeRawTerminate().then((code) => {
        if (fault !== "delayed-plane-b-exit") resolveTerminate?.(code);
      });
    }, delay);
    return terminatePromise;
  };
  const afterPlaneA = async (): Promise<void> => {
    if (audit !== undefined) {
      audit.planeATerminalCallbacks += 1;
      note(audit, "plane-a:terminal");
    }
    await onTerminal();
  };
  const deliverExit = (code: number): void => {
    rawExitCode = code;
    if (armed && listeners.exit !== undefined) {
      listeners.exit(code);
      terminalHook = afterPlaneA();
      void terminalHook.then(() => {
        if (fault !== "delayed-plane-b-exit") recordExit(code);
      });
      return;
    }
    if (armed) {
      bufferedExit = code;
      return;
    }
    if (fault !== "delayed-plane-b-exit") {
      void terminalHook.then(() => recordExit(code));
    }
  };
  const terminalSignal = (listener: (() => void) | undefined): void => {
    if (!armed || listener === undefined) return;
    listener();
    terminalHook = afterPlaneA();
    void terminalHook;
  };

  worker.on("message", (value) => {
    if (armed) listeners.message?.(value);
  });
  worker.on("messageerror", () => terminalSignal(listeners.messageError));
  worker.on("error", () => terminalSignal(listeners.error));
  worker.on("exit", deliverExit);

  const transport: AdminWorkerTransport = Object.freeze({
    postMessage(value: unknown): void {
      const request = value as { readonly type?: unknown };
      if (
        fault === "forced-exit-before-ready"
        && request.type === "initialize"
      ) {
        void worker.terminate();
        return;
      }
      if (
        fault === "forced-exit-on-summary"
        && request.type === "inspectSummary"
      ) {
        void worker.terminate();
        return;
      }
      if (request.type === "close") closeRequested = true;
      worker.postMessage(value);
    },
    onMessage(listener: (value: unknown) => void): void {
      listeners.message = listener;
    },
    onMessageError(listener: () => void): void {
      listeners.messageError = listener;
    },
    onError(listener: () => void): void {
      listeners.error = listener;
    },
    onExit(listener: (code: number) => void): void {
      listeners.exit = listener;
      if (bufferedExit !== undefined) {
        const code = bufferedExit;
        bufferedExit = undefined;
        queueMicrotask(() => deliverExit(code));
      }
    },
    removeAllListeners(): void {
      armed = false;
      listeners = {};
    },
    terminate(): Promise<number> {
      return scheduleTerminate();
    }
  });
  return Object.freeze({
    transport,
    exit,
    forceIdleExit(): void {
      void worker.terminate();
    }
  });
}

async function acquireSnapshot(
  options: OpenAttuneGraphAdminReadonlyApplicationOptions,
  fault: ApplicationQualificationFault | undefined,
  audit: AuditState | undefined
): Promise<SnapshotLease> {
  if (audit !== undefined) {
    audit.snapshotAcquireAttempts += 1;
    note(audit, "snapshot:acquire:start");
  }
  try {
    let lease: SnapshotLease;
    if (audit !== undefined) {
      const releaseFailure = fault === "initialize-timeout-with-release-failure"
        || fault === "release-failure-after-clean-close";
      const qualification = startAttuneGraphAdminReadonlySnapshotQualification({
        ...options,
        ...(releaseFailure ? { fault: "cleanup-first-failure" as const } : {})
      });
      lease = await qualification.acquisition;
    } else {
      lease = await acquireAttuneGraphAdminReadonlySnapshot(options);
    }
    if (audit !== undefined) {
      audit.leasesAcquired += 1;
      note(audit, "snapshot:acquire:success");
    }
    return lease;
  } catch (cause) {
    if (audit !== undefined) note(audit, "snapshot:acquire:failure");
    throw snapshotError(cause);
  }
}

async function openInternal(
  options: OpenAttuneGraphAdminReadonlyApplicationOptions,
  fault?: ApplicationQualificationFault,
  audit?: AuditState
): Promise<AttuneGraphAdminReadonlyApplication> {
  let lease: SnapshotLease;
  try {
    lease = await acquireSnapshot(options, fault, audit);
  } catch (cause) {
    const error = asApplicationError(cause);
    if (audit !== undefined) {
      audit.primaryCode = error.code;
      settleAudit(audit);
    }
    throw error;
  }

  if (audit !== undefined) {
    audit.workerSpawnAttempts += 1;
    note(audit, "worker:spawn:start");
  }
  if (fault === "spawn-failure") {
    const error = applicationError("WORKER_FAILURE");
    if (audit !== undefined) {
      note(audit, "worker:spawn:failure");
      audit.primaryCode = error.code;
      audit.leaseReleaseAttempts += 1;
      note(audit, "lease:release:start");
    }
    try {
      await lease.release();
      note(audit, "lease:release:success");
    } catch {
      if (audit !== undefined) {
        audit.leaseReleaseFailures += 1;
        note(audit, "lease:release:failure");
      }
    } finally {
      if (audit !== undefined) {
        audit.leaseReleaseSettlements += 1;
        settleAudit(audit);
      }
    }
    throw error;
  }

  let worker: Worker;
  try {
    worker = new Worker(WORKER_MODULE_URL, {
      name: WORKER_NAME,
      execArgv: []
    });
  } catch {
    const error = applicationError("WORKER_FAILURE");
    if (audit !== undefined) {
      note(audit, "worker:spawn:failure");
      audit.primaryCode = error.code;
      audit.leaseReleaseAttempts += 1;
      note(audit, "lease:release:start");
    }
    try {
      await lease.release();
      note(audit, "lease:release:success");
    } catch {
      if (audit !== undefined) {
        audit.leaseReleaseFailures += 1;
        note(audit, "lease:release:failure");
      }
    } finally {
      if (audit !== undefined) {
        audit.leaseReleaseSettlements += 1;
        settleAudit(audit);
      }
    }
    throw error;
  }
  if (audit !== undefined) {
    audit.workersSpawned += 1;
    note(audit, "worker:spawn:success");
  }

  let spineApplication: AttuneGraphAdminReadonlyApplication | undefined;
  let spineOpening: Promise<AttuneGraphAdminReadonlyApplication> | undefined;
  let primaryError: AttuneGraphAdminReadonlyError | undefined;
  let terminalPromise: Promise<void> | undefined;
  let releasePromise: Promise<void> | undefined;

  const pin = (error: AttuneGraphAdminReadonlyError): AttuneGraphAdminReadonlyError => {
    if (primaryError === undefined) {
      primaryError = error;
      if (audit !== undefined) audit.primaryCode = error.code;
    }
    return primaryError;
  };
  const release = (): Promise<void> => {
    if (releasePromise !== undefined) return releasePromise;
    if (audit !== undefined) {
      audit.leaseReleaseAttempts += 1;
      note(audit, "lease:release:start");
    }
    releasePromise = lease.release().then(
      () => {
        note(audit, "lease:release:success");
      },
      (cause: unknown) => {
        if (audit !== undefined) {
          audit.leaseReleaseFailures += 1;
          note(audit, "lease:release:failure");
        }
        if (primaryError === undefined) pin(snapshotError(cause));
      }
    ).finally(() => {
      if (audit !== undefined) audit.leaseReleaseSettlements += 1;
    });
    return releasePromise;
  };
  const finishTerminal = (): Promise<void> => {
    if (terminalPromise !== undefined) return terminalPromise;
    terminalPromise = (async () => {
      const exitCode = await adapter.exit;
      if (primaryError === undefined && exitCode !== 0) {
        pin(applicationError("WORKER_FAILURE"));
      }
      await release();
      if (audit !== undefined) settleAudit(audit);
      if (primaryError !== undefined) throw primaryError;
    })();
    return terminalPromise;
  };
  const recoverPinned = async (): Promise<void> => {
    try {
      if (spineApplication !== undefined) {
        await spineApplication.close();
      } else if (spineOpening !== undefined) {
        await spineOpening;
        return;
      } else {
        return;
      }
    } catch (cause) {
      const recovered = pin(asApplicationError(cause));
      if (audit !== undefined) {
        audit.pinnedErrorRecoveries += 1;
        note(audit, "e1:error:recovered");
      }
      void finishTerminal().catch((terminalCause: unknown) => {
        if (terminalCause !== recovered && audit !== undefined) {
          audit.exactPinnedErrorPreserved = false;
        }
      });
    }
  };
  const adapter = createWorkerAdapter(worker, fault, audit, recoverPinned);

  if (audit !== undefined) note(audit, "spine:initialize:start");
  try {
    if (
      fault === "initialize-timeout"
      || fault === "initialize-timeout-with-release-failure"
    ) {
      spineOpening = openAttuneGraphAdminReadonlySpineForQualification({
        transport: adapter.transport,
        databasePath: lease.snapshotDatabasePath,
        clock: createInitializeTimeoutClock()
      });
    } else {
      spineOpening = openAttuneGraphAdminReadonlySpine(
        adapter.transport,
        lease.snapshotDatabasePath
      );
    }
    spineApplication = await spineOpening;
    if (audit !== undefined) {
      audit.spineInitializeSettlements += 1;
      note(audit, "spine:initialize:success");
    }
  } catch (cause) {
    const error = pin(asApplicationError(cause));
    if (audit !== undefined) {
      audit.spineInitializeSettlements += 1;
      note(audit, "spine:initialize:failure");
    }
    try {
      await finishTerminal();
    } catch (terminalCause) {
      if (terminalCause !== error && audit !== undefined) {
        audit.exactPinnedErrorPreserved = false;
      }
    }
    throw error;
  }

  let closePromise: Promise<void> | undefined;
  const rejectTerminal = async <T>(): Promise<T> => {
    try {
      await terminalPromise;
    } catch {
    }
    throw primaryError ?? applicationError("INVALID_STATE");
  };
  const run = async <T>(operation: () => Promise<T>): Promise<T> => {
    if (terminalPromise !== undefined) return rejectTerminal<T>();
    try {
      return await operation();
    } catch (cause) {
      if (
        cause instanceof AttuneGraphAdminReadonlyError
        && cause.code === "REENTRY"
      ) throw cause;
      note(audit, "operation:failure");
      const error = pin(asApplicationError(cause));
      try {
        await finishTerminal();
      } catch (terminalCause) {
        if (terminalCause !== error && audit !== undefined) {
          audit.exactPinnedErrorPreserved = false;
        }
      }
      throw error;
    }
  };

  const application: AttuneGraphAdminReadonlyApplication = Object.freeze({
    inspectSummary(): Promise<AttuneGraphAdminStoreSummary> {
      return run(() => spineApplication!.inspectSummary());
    },
    inspectHead(scope: AttuneGraphScope): Promise<AttuneGraphAdminHeadResult> {
      return run(() => spineApplication!.inspectHead(scope));
    },
    verifyIntegrity(): Promise<Readonly<{ verified: true }>> {
      return run(() => spineApplication!.verifyIntegrity());
    },
    close(): Promise<void> {
      if (closePromise !== undefined) return closePromise;
      note(audit, "close:start");
      closePromise = (async () => {
        try {
          await spineApplication!.close();
          if (audit !== undefined) {
            audit.closeResponses += 1;
            note(audit, "close:response");
          }
        } catch (cause) {
          if (audit !== undefined) {
            audit.spineCloseSettlements += 1;
            note(audit, "close:failure");
          }
          if (
            cause instanceof AttuneGraphAdminReadonlyError
            && cause.code === "REENTRY"
          ) {
            closePromise = undefined;
            throw cause;
          }
          const error = pin(asApplicationError(cause));
          try {
            await finishTerminal();
          } catch {
          }
          throw error;
        }
        if (audit !== undefined) audit.spineCloseSettlements += 1;
        try {
          await finishTerminal();
        } catch (cause) {
          throw primaryError ?? asApplicationError(cause);
        }
      })();
      return closePromise;
    },
    [Symbol.asyncDispose](): Promise<void> {
      return application.close();
    }
  });

  if (
    fault === "idle-exit-while-ready"
    || fault === "delayed-plane-b-exit"
  ) {
    queueMicrotask(() => adapter.forceIdleExit());
  }
  return application;
}

export function openAttuneGraphAdminReadonlyApplication(
  options: OpenAttuneGraphAdminReadonlyApplicationOptions
): Promise<AttuneGraphAdminReadonlyApplication> {
  return openInternal(options);
}

function qualificationInput(
  input: unknown
): OpenAttuneGraphAdminReadonlyApplicationOptions & {
  readonly fault?: ApplicationQualificationFault;
} {
  if (
    input === null
    || typeof input !== "object"
    || nodeTypes.isProxy(input)
    || Array.isArray(input)
  ) throw applicationError("UNSUPPORTED_PROFILE");
  const prototype = Reflect.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) {
    throw applicationError("UNSUPPORTED_PROFILE");
  }
  const keys = Reflect.ownKeys(input);
  const allowed = ["databasePath", "sourceState", "fault"];
  if (
    keys.some((key) => typeof key !== "string" || !allowed.includes(key))
    || !keys.includes("databasePath")
    || !keys.includes("sourceState")
  ) throw applicationError("UNSUPPORTED_PROFILE");
  const detached: Record<string, unknown> = Object.create(null);
  for (const key of keys) {
    if (typeof key !== "string") throw applicationError("UNSUPPORTED_PROFILE");
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (
      descriptor === undefined
      || !descriptor.enumerable
      || !Object.hasOwn(descriptor, "value")
    ) throw applicationError("UNSUPPORTED_PROFILE");
    detached[key] = descriptor.value;
  }
  if (
    typeof detached.databasePath !== "string"
    || detached.sourceState !== "closed-quiescent"
    || (
      detached.fault !== undefined
      && (
        typeof detached.fault !== "string"
        || !QUALIFICATION_FAULTS.includes(
          detached.fault as ApplicationQualificationFault
        )
      )
    )
  ) throw applicationError("UNSUPPORTED_PROFILE");
  return {
    databasePath: detached.databasePath,
    sourceState: "closed-quiescent",
    ...(detached.fault === undefined
      ? {}
      : { fault: detached.fault as ApplicationQualificationFault })
  };
}

export function startAttuneGraphAdminReadonlyApplicationQualification(
  input: OpenAttuneGraphAdminReadonlyApplicationOptions & {
    readonly fault?: ApplicationQualificationFault;
  }
): {
  readonly opening: Promise<AttuneGraphAdminReadonlyApplication>;
  readonly terminalAudit: Promise<Readonly<ApplicationQualificationAudit>>;
} {
  const audit = createAuditState();
  let admitted: ReturnType<typeof qualificationInput>;
  try {
    if (process.env.NODE_ENV !== "test") {
      throw applicationError("UNSUPPORTED_PROFILE");
    }
    admitted = qualificationInput(input);
  } catch (cause) {
    const error = asApplicationError(cause);
    audit.primaryCode = error.code;
    settleAudit(audit);
    return Object.freeze({
      opening: Promise.reject(error),
      terminalAudit: audit.terminalAudit
    });
  }
  return Object.freeze({
    opening: openInternal({
      databasePath: admitted.databasePath,
      sourceState: admitted.sourceState
    }, admitted.fault, audit),
    terminalAudit: audit.terminalAudit
  });
}
