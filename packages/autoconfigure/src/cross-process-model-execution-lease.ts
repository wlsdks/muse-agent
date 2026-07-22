import {
  FileLocalModelExecutionLeaseCoordinator,
  LocalModelExecutionLeaseError,
  resolveLocalModelExecutionLeaseRoot,
  type LocalModelExecutionLease,
  type LocalModelExecutionRole
} from "@muse/stores";
import { ModelProviderError, type ModelEvent, type ModelProvider, type ModelRequest } from "@muse/model";
import { isAbsolute } from "node:path";

import { parseBoolean } from "./env-parsers.js";

export const DEFAULT_CROSS_PROCESS_MODEL_FOREGROUND_WAIT_MS = 15_000;
export const DEFAULT_CROSS_PROCESS_MODEL_BACKGROUND_WAIT_MS = 1_000;
export const DEFAULT_CROSS_PROCESS_MODEL_POLL_MS = 25;
export const DEFAULT_CROSS_PROCESS_MODEL_PREEMPT_POLL_MS = 100;

const MAX_FOREGROUND_WAIT_MS = 120_000;
const MAX_BACKGROUND_WAIT_MS = 15_000;
const MIN_POLL_MS = 5;
const MAX_POLL_MS = 1_000;
const MIN_PREEMPT_POLL_MS = 25;
const MAX_PREEMPT_POLL_MS = 2_000;

type Env = Readonly<Record<string, string | undefined>>;

export type CrossProcessModelExecutionLeaseErrorCode =
  | "QUEUE_TIMEOUT"
  | "REQUEST_ABORTED"
  | "STATE_UNAVAILABLE"
  | "LEASE_LOST";

export class CrossProcessModelExecutionLeaseError extends ModelProviderError {
  readonly code: CrossProcessModelExecutionLeaseErrorCode;

  constructor(providerId: string, code: CrossProcessModelExecutionLeaseErrorCode, message: string, retryable: boolean) {
    super(providerId, message, retryable);
    this.name = "CrossProcessModelExecutionLeaseError";
    this.code = code;
  }
}

export interface ResolvedCrossProcessModelExecutionLeaseOptions {
  readonly enabled: boolean;
  readonly root: string;
  readonly foregroundWaitMs: number;
  readonly backgroundWaitMs: number;
  readonly pollMs: number;
  readonly preemptPollMs: number;
}

export interface CrossProcessModelExecutionLeaseSnapshot {
  readonly enabled: boolean;
  readonly activeLocalRole: LocalModelExecutionRole | null;
  readonly lastObservedExternalDemandRole: LocalModelExecutionRole | null;
  readonly queuedLocalForeground: number;
  readonly queuedLocalBackground: number;
  readonly acquired: number;
  readonly completed: number;
  readonly preempted: number;
  readonly timedOut: number;
  readonly cancelled: number;
  readonly stateFailures: number;
  readonly lost: number;
  readonly maxWaitMs: number;
}

export interface CrossProcessModelExecutionLeaseProviders {
  readonly foreground: ModelProvider;
  readonly background: ModelProvider;
  readonly snapshot: () => CrossProcessModelExecutionLeaseSnapshot;
}

function integer(raw: string | undefined, fallback: number, min: number, max: number): number {
  const value = raw?.trim();
  if (!value || !/^(0|[1-9]\d*)$/u.test(value)) return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

function explicitInteger(raw: string | undefined, min: number, max: number): number | undefined {
  const value = raw?.trim();
  if (!value || !/^(0|[1-9]\d*)$/u.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= min && parsed <= max ? parsed : undefined;
}

/** Valid explicit owner overrides that may safely cross a resident process boundary. */
export function crossProcessModelExecutionLeaseEnvironment(env: Env): Readonly<Record<string, string>> {
  const variables: Record<string, string> = {};
  const enabled = env.MUSE_CROSS_PROCESS_MODEL_LEASE_ENABLED?.trim().toLowerCase();
  if (enabled && ["true", "1", "yes", "on"].includes(enabled)) {
    variables.MUSE_CROSS_PROCESS_MODEL_LEASE_ENABLED = "true";
  } else if (enabled && ["false", "0", "no", "off"].includes(enabled)) {
    variables.MUSE_CROSS_PROCESS_MODEL_LEASE_ENABLED = "false";
  }
  const root = env.MUSE_CROSS_PROCESS_MODEL_LEASE_ROOT?.trim();
  if (root) {
    if (!isAbsolute(root) || root.includes("\0")) {
      throw new Error("MUSE_CROSS_PROCESS_MODEL_LEASE_ROOT must be an absolute path without NUL bytes");
    }
    variables.MUSE_CROSS_PROCESS_MODEL_LEASE_ROOT = root;
  }
  const foregroundWaitMs = explicitInteger(
    env.MUSE_CROSS_PROCESS_MODEL_FOREGROUND_WAIT_MS,
    1,
    MAX_FOREGROUND_WAIT_MS
  );
  const backgroundWaitMs = explicitInteger(
    env.MUSE_CROSS_PROCESS_MODEL_BACKGROUND_WAIT_MS,
    0,
    MAX_BACKGROUND_WAIT_MS
  );
  const pollMs = explicitInteger(env.MUSE_CROSS_PROCESS_MODEL_POLL_MS, MIN_POLL_MS, MAX_POLL_MS);
  const preemptPollMs = explicitInteger(
    env.MUSE_CROSS_PROCESS_MODEL_PREEMPT_POLL_MS,
    MIN_PREEMPT_POLL_MS,
    MAX_PREEMPT_POLL_MS
  );
  if (foregroundWaitMs !== undefined) {
    variables.MUSE_CROSS_PROCESS_MODEL_FOREGROUND_WAIT_MS = String(foregroundWaitMs);
  }
  if (backgroundWaitMs !== undefined) {
    variables.MUSE_CROSS_PROCESS_MODEL_BACKGROUND_WAIT_MS = String(backgroundWaitMs);
  }
  if (pollMs !== undefined) variables.MUSE_CROSS_PROCESS_MODEL_POLL_MS = String(pollMs);
  if (preemptPollMs !== undefined) {
    variables.MUSE_CROSS_PROCESS_MODEL_PREEMPT_POLL_MS = String(preemptPollMs);
  }
  return variables;
}

export function resolveCrossProcessModelExecutionLeaseOptions(
  env: Env
): ResolvedCrossProcessModelExecutionLeaseOptions {
  const explicitRoot = env.MUSE_CROSS_PROCESS_MODEL_LEASE_ROOT?.trim();
  return {
    enabled: parseBoolean(env.MUSE_CROSS_PROCESS_MODEL_LEASE_ENABLED, true),
    root: explicitRoot || resolveLocalModelExecutionLeaseRoot(env),
    foregroundWaitMs: integer(
      env.MUSE_CROSS_PROCESS_MODEL_FOREGROUND_WAIT_MS,
      DEFAULT_CROSS_PROCESS_MODEL_FOREGROUND_WAIT_MS,
      1,
      MAX_FOREGROUND_WAIT_MS
    ),
    backgroundWaitMs: integer(
      env.MUSE_CROSS_PROCESS_MODEL_BACKGROUND_WAIT_MS,
      DEFAULT_CROSS_PROCESS_MODEL_BACKGROUND_WAIT_MS,
      0,
      MAX_BACKGROUND_WAIT_MS
    ),
    pollMs: integer(
      env.MUSE_CROSS_PROCESS_MODEL_POLL_MS,
      DEFAULT_CROSS_PROCESS_MODEL_POLL_MS,
      MIN_POLL_MS,
      MAX_POLL_MS
    ),
    preemptPollMs: integer(
      env.MUSE_CROSS_PROCESS_MODEL_PREEMPT_POLL_MS,
      DEFAULT_CROSS_PROCESS_MODEL_PREEMPT_POLL_MS,
      MIN_PREEMPT_POLL_MS,
      MAX_PREEMPT_POLL_MS
    )
  };
}

function increment(value: number): number {
  return value >= Number.MAX_SAFE_INTEGER ? Number.MAX_SAFE_INTEGER : value + 1;
}

function leaseError(providerId: string, error: unknown): CrossProcessModelExecutionLeaseError {
  if (error instanceof CrossProcessModelExecutionLeaseError) return error;
  if (error instanceof LocalModelExecutionLeaseError) {
    switch (error.code) {
      case "QUEUE_TIMEOUT":
        return new CrossProcessModelExecutionLeaseError(providerId, error.code, error.message, true);
      case "LEASE_LOST":
        return new CrossProcessModelExecutionLeaseError(providerId, error.code, error.message, true);
      case "REQUEST_ABORTED":
        return new CrossProcessModelExecutionLeaseError(providerId, error.code, error.message, false);
      case "STATE_UNAVAILABLE":
        return new CrossProcessModelExecutionLeaseError(providerId, error.code, error.message, false);
    }
  }
  return new CrossProcessModelExecutionLeaseError(
    providerId,
    "STATE_UNAVAILABLE",
    "local model execution lease state is unavailable",
    false
  );
}

export function createCrossProcessModelExecutionLeaseProviders(
  provider: ModelProvider,
  options: ResolvedCrossProcessModelExecutionLeaseOptions
): CrossProcessModelExecutionLeaseProviders {
  let activeLocalRole: LocalModelExecutionRole | null = null;
  let lastObservedExternalDemandRole: LocalModelExecutionRole | null = null;
  let queuedLocalForeground = 0;
  let queuedLocalBackground = 0;
  let acquired = 0;
  let completed = 0;
  let preempted = 0;
  let timedOut = 0;
  let cancelled = 0;
  let stateFailures = 0;
  let lost = 0;
  let maxWaitMs = 0;

  const snapshot = (): CrossProcessModelExecutionLeaseSnapshot => ({
    enabled: options.enabled,
    activeLocalRole,
    lastObservedExternalDemandRole,
    queuedLocalForeground,
    queuedLocalBackground,
    acquired,
    completed,
    preempted,
    timedOut,
    cancelled,
    stateFailures,
    lost,
    maxWaitMs
  });

  if (!options.enabled) {
    return { background: provider, foreground: provider, snapshot };
  }

  const mapError = (error: unknown): CrossProcessModelExecutionLeaseError => {
    const mapped = leaseError(provider.id, error);
    if (mapped.code === "QUEUE_TIMEOUT") timedOut = increment(timedOut);
    else if (mapped.code === "REQUEST_ABORTED") cancelled = increment(cancelled);
    else if (mapped.code === "LEASE_LOST") lost = increment(lost);
    else stateFailures = increment(stateFailures);
    return mapped;
  };

  interface OperationScope {
    readonly request: ModelRequest;
    finish(success: boolean): Promise<CrossProcessModelExecutionLeaseError | undefined>;
  }

  const begin = async (role: LocalModelExecutionRole, request: ModelRequest): Promise<OperationScope> => {
    if (request.signal?.aborted) throw mapError(new LocalModelExecutionLeaseError(
      "REQUEST_ABORTED",
      "local model execution lease request was cancelled"
    ));
    if (role === "foreground") queuedLocalForeground = increment(queuedLocalForeground);
    else queuedLocalBackground = increment(queuedLocalBackground);
    let lease: LocalModelExecutionLease;
    try {
      lease = await new FileLocalModelExecutionLeaseCoordinator({
        backgroundWaitMs: options.backgroundWaitMs,
        foregroundWaitMs: options.foregroundWaitMs,
        pollMs: options.pollMs,
        root: options.root
      }).acquire(role, request.signal);
    } catch (error) {
      throw mapError(error);
    } finally {
      if (role === "foreground") queuedLocalForeground = Math.max(0, queuedLocalForeground - 1);
      else queuedLocalBackground = Math.max(0, queuedLocalBackground - 1);
    }
    acquired = increment(acquired);
    maxWaitMs = Math.max(maxWaitMs, Math.min(Number.MAX_SAFE_INTEGER, lease.waitMs));
    activeLocalRole = role;
    let valid: boolean;
    try {
      valid = await lease.validate();
    } catch (error) {
      try {
        await lease.release();
      } catch {
        activeLocalRole = null;
        throw mapError(new LocalModelExecutionLeaseError(
          "STATE_UNAVAILABLE",
          "local model execution lease state is unavailable"
        ));
      }
      activeLocalRole = null;
      throw mapError(error);
    }
    if (request.signal?.aborted || !valid) {
      try {
        await lease.release();
      } catch {
        activeLocalRole = null;
        throw mapError(new LocalModelExecutionLeaseError(
          "STATE_UNAVAILABLE",
          "local model execution lease state is unavailable"
        ));
      }
      activeLocalRole = null;
      throw mapError(new LocalModelExecutionLeaseError(
        request.signal?.aborted ? "REQUEST_ABORTED" : "LEASE_LOST",
        request.signal?.aborted
          ? "local model execution lease request was cancelled"
          : "local model execution lease ownership was lost"
      ));
    }
    const controller = new AbortController();
    let terminalCode: CrossProcessModelExecutionLeaseErrorCode | undefined;
    let closed = false;
    const onCallerAbort = (): void => {
      terminalCode ??= "REQUEST_ABORTED";
      controller.abort();
    };
    request.signal?.addEventListener("abort", onCallerAbort, { once: true });
    let checking = false;
    let preemptionTimer: ReturnType<typeof setInterval> | undefined;
    if (role === "background") {
      preemptionTimer = setInterval(() => {
        if (closed || checking || controller.signal.aborted) return;
        checking = true;
        void lease.hasForegroundWaiter(controller.signal)
          .then((waiting) => {
            if (closed || !waiting || controller.signal.aborted) return;
            lastObservedExternalDemandRole = "foreground";
            preempted = increment(preempted);
            terminalCode = "REQUEST_ABORTED";
            controller.abort();
          })
          .catch(() => {
            if (closed) return;
            if (terminalCode === "REQUEST_ABORTED" || controller.signal.aborted) return;
            terminalCode = "STATE_UNAVAILABLE";
            controller.abort();
          })
          .finally(() => { checking = false; });
      }, options.preemptPollMs);
    }

    let finished = false;
    return {
      request: { ...request, signal: controller.signal },
      finish: async (success) => {
        if (finished) return undefined;
        finished = true;
        closed = true;
        controller.abort();
        if (preemptionTimer !== undefined) clearInterval(preemptionTimer);
        request.signal?.removeEventListener("abort", onCallerAbort);
        try {
          if (!(await lease.validate())) terminalCode = "LEASE_LOST";
        } catch {
          terminalCode = "STATE_UNAVAILABLE";
        }
        try {
          await lease.release();
        } catch {
          terminalCode = "STATE_UNAVAILABLE";
        }
        activeLocalRole = null;
        if (terminalCode) {
          return mapError(new LocalModelExecutionLeaseError(
            terminalCode,
            terminalCode === "REQUEST_ABORTED"
              ? "local model execution lease request was cancelled"
              : terminalCode === "LEASE_LOST"
                ? "local model execution lease ownership was lost"
                : "local model execution lease state is unavailable"
          ));
        }
        if (success) completed = increment(completed);
        return undefined;
      }
    };
  };

  const generate = async (role: LocalModelExecutionRole, request: ModelRequest) => {
    const scope = await begin(role, request);
    let result;
    try {
      result = await provider.generate(scope.request);
    } catch (error) {
      const terminal = await scope.finish(false);
      throw terminal ?? error;
    }
    const terminal = await scope.finish(true);
    if (terminal) throw terminal;
    return result;
  };

  const stream = (role: LocalModelExecutionRole, request: ModelRequest): AsyncIterable<ModelEvent> =>
    (async function* (): AsyncIterable<ModelEvent> {
      const scope = await begin(role, request);
      let iterator: AsyncIterator<ModelEvent>;
      try {
        iterator = provider.stream(scope.request)[Symbol.asyncIterator]();
      } catch (error) {
        const terminal = await scope.finish(false);
        throw terminal ?? error;
      }
      let complete = false;
      let failure: unknown;
      let terminal: CrossProcessModelExecutionLeaseError | undefined;
      try {
        for (;;) {
          const next = await iterator.next();
          if (next.done) {
            complete = true;
            break;
          }
          yield next.value;
        }
      } catch (error) {
        failure = error;
      } finally {
        if (!complete && iterator.return) {
          try {
            await iterator.return();
          } catch (error) {
            failure ??= error;
          }
        }
        terminal = await scope.finish(complete && failure === undefined);
      }
      if (terminal) throw terminal;
      if (failure !== undefined) throw failure;
    })();

  const roleProvider = (role: LocalModelExecutionRole): ModelProvider => ({
    id: provider.id,
    listModels: () => provider.listModels(),
    generate: (request) => generate(role, request),
    stream: (request) => stream(role, request),
    ...(provider.resolveContextWindow
      ? { resolveContextWindow: (model: string) => provider.resolveContextWindow!(model) }
      : {})
  });

  return { background: roleProvider("background"), foreground: roleProvider("foreground"), snapshot };
}
