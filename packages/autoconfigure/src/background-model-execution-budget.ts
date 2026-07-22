import { performance } from "node:perf_hooks";

import {
  ModelProviderError,
  type ModelEvent,
  type ModelProvider,
  type ModelRequest,
  type ModelResponse
} from "@muse/model";

export const DEFAULT_BACKGROUND_MODEL_MAX_CONCURRENCY = 1;
export const DEFAULT_BACKGROUND_MODEL_MAX_QUEUE = 2;
export const DEFAULT_BACKGROUND_MODEL_MAX_INPUT_BYTES = 65_536;
export const DEFAULT_BACKGROUND_MODEL_MAX_OUTPUT_TOKENS = 512;

const MAX_BACKGROUND_MODEL_MAX_CONCURRENCY = 4;
const MAX_BACKGROUND_MODEL_MAX_QUEUE = 32;
const MIN_BACKGROUND_MODEL_MAX_INPUT_BYTES = 1_024;
const MAX_BACKGROUND_MODEL_MAX_INPUT_BYTES = 1_048_576;
const MAX_BACKGROUND_MODEL_MAX_OUTPUT_TOKENS = 4_096;

export type BackgroundModelExecutionBudgetErrorCode =
  | "INPUT_TOO_LARGE"
  | "QUEUE_FULL"
  | "REQUEST_ABORTED";

export class BackgroundModelExecutionBudgetError extends ModelProviderError {
  readonly code: BackgroundModelExecutionBudgetErrorCode;

  constructor(providerId: string, code: BackgroundModelExecutionBudgetErrorCode, message: string) {
    super(providerId, message, false);
    this.name = "BackgroundModelExecutionBudgetError";
    this.code = code;
  }
}

export interface BackgroundModelExecutionBudgetOptions {
  readonly maxConcurrency?: number;
  readonly maxQueue?: number;
  readonly maxInputBytes?: number;
  readonly maxOutputTokens?: number;
  /** Monotonic milliseconds. */
  readonly now?: () => number;
}

export interface ResolvedBackgroundModelExecutionBudgetOptions {
  readonly maxConcurrency: number;
  readonly maxQueue: number;
  readonly maxInputBytes: number;
  readonly maxOutputTokens: number;
}

export interface BackgroundModelExecutionBudgetSnapshot {
  readonly activeForeground: number;
  readonly activeBackground: number;
  readonly queuedBackground: number;
  readonly pendingBackgroundSettlements: number;
  readonly started: number;
  readonly completed: number;
  readonly failed: number;
  readonly cancelled: number;
  readonly rejected: number;
  readonly preemptions: number;
  readonly lastCancellationSettleMs: number;
}

export interface BackgroundModelExecutionBudgetProviders {
  readonly foreground: ModelProvider;
  readonly background: ModelProvider;
  readonly snapshot: () => BackgroundModelExecutionBudgetSnapshot;
}

type BudgetEnv = Readonly<Record<string, string | undefined>>;

function integerInRange(raw: string | undefined, fallback: number, min: number, max: number): number {
  const value = raw?.trim();
  if (!value || !/^(0|[1-9]\d*)$/u.test(value)) return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

function explicitIntegerInRange(raw: string | undefined, min: number, max: number): number | undefined {
  const value = raw?.trim();
  if (!value || !/^(0|[1-9]\d*)$/u.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= min && parsed <= max ? parsed : undefined;
}

/** Valid explicit owner overrides that may safely cross a resident launchd boundary. */
export function backgroundModelExecutionBudgetEnvironment(env: BudgetEnv): Readonly<Record<string, string>> {
  const variables: Record<string, string> = {};
  const concurrency = explicitIntegerInRange(env.MUSE_BACKGROUND_MODEL_MAX_CONCURRENCY, 1, MAX_BACKGROUND_MODEL_MAX_CONCURRENCY);
  const queue = explicitIntegerInRange(env.MUSE_BACKGROUND_MODEL_MAX_QUEUE, 0, MAX_BACKGROUND_MODEL_MAX_QUEUE);
  const inputBytes = explicitIntegerInRange(env.MUSE_BACKGROUND_MODEL_MAX_INPUT_BYTES, MIN_BACKGROUND_MODEL_MAX_INPUT_BYTES, MAX_BACKGROUND_MODEL_MAX_INPUT_BYTES);
  const outputTokens = explicitIntegerInRange(env.MUSE_BACKGROUND_MODEL_MAX_OUTPUT_TOKENS, 1, MAX_BACKGROUND_MODEL_MAX_OUTPUT_TOKENS);
  if (concurrency !== undefined) variables.MUSE_BACKGROUND_MODEL_MAX_CONCURRENCY = String(concurrency);
  if (queue !== undefined) variables.MUSE_BACKGROUND_MODEL_MAX_QUEUE = String(queue);
  if (inputBytes !== undefined) variables.MUSE_BACKGROUND_MODEL_MAX_INPUT_BYTES = String(inputBytes);
  if (outputTokens !== undefined) variables.MUSE_BACKGROUND_MODEL_MAX_OUTPUT_TOKENS = String(outputTokens);
  return variables;
}

export function resolveBackgroundModelExecutionBudgetOptions(
  env: BudgetEnv
): ResolvedBackgroundModelExecutionBudgetOptions {
  return {
    maxConcurrency: integerInRange(
      env.MUSE_BACKGROUND_MODEL_MAX_CONCURRENCY,
      DEFAULT_BACKGROUND_MODEL_MAX_CONCURRENCY,
      1,
      MAX_BACKGROUND_MODEL_MAX_CONCURRENCY
    ),
    maxQueue: integerInRange(
      env.MUSE_BACKGROUND_MODEL_MAX_QUEUE,
      DEFAULT_BACKGROUND_MODEL_MAX_QUEUE,
      0,
      MAX_BACKGROUND_MODEL_MAX_QUEUE
    ),
    maxInputBytes: integerInRange(
      env.MUSE_BACKGROUND_MODEL_MAX_INPUT_BYTES,
      DEFAULT_BACKGROUND_MODEL_MAX_INPUT_BYTES,
      MIN_BACKGROUND_MODEL_MAX_INPUT_BYTES,
      MAX_BACKGROUND_MODEL_MAX_INPUT_BYTES
    ),
    maxOutputTokens: integerInRange(
      env.MUSE_BACKGROUND_MODEL_MAX_OUTPUT_TOKENS,
      DEFAULT_BACKGROUND_MODEL_MAX_OUTPUT_TOKENS,
      1,
      MAX_BACKGROUND_MODEL_MAX_OUTPUT_TOKENS
    )
  };
}

function normalizeOptions(options: BackgroundModelExecutionBudgetOptions): ResolvedBackgroundModelExecutionBudgetOptions {
  const asEnv = (value: number | undefined): string | undefined =>
    value === undefined ? undefined : String(value);
  return resolveBackgroundModelExecutionBudgetOptions({
    MUSE_BACKGROUND_MODEL_MAX_CONCURRENCY: asEnv(options.maxConcurrency),
    MUSE_BACKGROUND_MODEL_MAX_QUEUE: asEnv(options.maxQueue),
    MUSE_BACKGROUND_MODEL_MAX_INPUT_BYTES: asEnv(options.maxInputBytes),
    MUSE_BACKGROUND_MODEL_MAX_OUTPUT_TOKENS: asEnv(options.maxOutputTokens)
  });
}

export function saturatingBackgroundBudgetIncrement(value: number): number {
  return value >= Number.MAX_SAFE_INTEGER ? Number.MAX_SAFE_INTEGER : value + 1;
}

export function clampBackgroundBudgetDuration(value: number): number {
  if (Number.isNaN(value) || value <= 0) return 0;
  if (value === Number.POSITIVE_INFINITY) return Number.MAX_SAFE_INTEGER;
  return Math.min(Number.MAX_SAFE_INTEGER, value);
}

function requestInputBytes(request: ModelRequest): number {
  try {
    const serialized = JSON.stringify({
      messages: request.messages,
      tools: request.tools,
      responseFormat: request.responseFormat
    });
    return serialized === undefined ? Number.POSITIVE_INFINITY : Buffer.byteLength(serialized, "utf8");
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function withOutputCap(request: ModelRequest, cap: number, signal: AbortSignal): ModelRequest {
  const requested = request.maxOutputTokens;
  const maxOutputTokens = requested === undefined ? cap : Math.min(requested, cap);
  return { ...request, maxOutputTokens, signal };
}

interface BackgroundLease {
  readonly signal: AbortSignal;
  cancel(): void;
  release(failed: boolean): void;
}

interface ActiveBackground {
  readonly controller: AbortController;
  readonly callerSignal?: AbortSignal;
  onCallerAbort?: () => void;
  cancellationRequestedAt?: number;
  preempted: boolean;
  released: boolean;
}

interface QueuedBackground {
  readonly callerSignal?: AbortSignal;
  readonly reject: (error: BackgroundModelExecutionBudgetError) => void;
  readonly resolve: (lease: BackgroundLease) => void;
  onCallerAbort?: () => void;
}

class BackgroundModelExecutionCoordinator {
  readonly #providerId: string;
  readonly #options: ResolvedBackgroundModelExecutionBudgetOptions;
  readonly #now: () => number;
  readonly #activeBackground = new Set<ActiveBackground>();
  readonly #queue: QueuedBackground[] = [];
  #activeForeground = 0;
  #pendingBackgroundSettlements = 0;
  #started = 0;
  #completed = 0;
  #failed = 0;
  #cancelled = 0;
  #rejected = 0;
  #preemptions = 0;
  #lastCancellationSettleMs = 0;

  constructor(providerId: string, options: BackgroundModelExecutionBudgetOptions) {
    this.#providerId = providerId;
    this.#options = normalizeOptions(options);
    this.#now = options.now ?? (() => performance.now());
  }

  enterForeground(): () => void {
    const wasIdle = this.#activeForeground === 0;
    this.#activeForeground += 1;
    if (wasIdle) {
      for (const active of this.#activeBackground) {
        this.#requestCancellation(active, true);
      }
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#activeForeground = Math.max(0, this.#activeForeground - 1);
      if (this.#activeForeground === 0) this.#pump();
    };
  }

  acquireBackground(callerSignal?: AbortSignal): Promise<BackgroundLease> {
    if (callerSignal?.aborted) {
      this.#rejected = saturatingBackgroundBudgetIncrement(this.#rejected);
      return Promise.reject(this.#abortedError());
    }
    if (this.#canStartBackground()) {
      return Promise.resolve(this.#startBackground(callerSignal));
    }
    if (this.#queue.length >= this.#options.maxQueue) {
      this.#rejected = saturatingBackgroundBudgetIncrement(this.#rejected);
      return Promise.reject(new BackgroundModelExecutionBudgetError(
        this.#providerId,
        "QUEUE_FULL",
        "background model execution queue is full"
      ));
    }
    return new Promise<BackgroundLease>((resolve, reject) => {
      const queued: QueuedBackground = { callerSignal, reject, resolve };
      if (callerSignal) {
        const onCallerAbort = (): void => {
          const index = this.#queue.indexOf(queued);
          if (index < 0) return;
          this.#queue.splice(index, 1);
          callerSignal.removeEventListener("abort", onCallerAbort);
          this.#rejected = saturatingBackgroundBudgetIncrement(this.#rejected);
          reject(this.#abortedError());
        };
        queued.onCallerAbort = onCallerAbort;
        callerSignal.addEventListener("abort", onCallerAbort, { once: true });
      }
      this.#queue.push(queued);
    });
  }

  rejectInput(): BackgroundModelExecutionBudgetError {
    this.#rejected = saturatingBackgroundBudgetIncrement(this.#rejected);
    return new BackgroundModelExecutionBudgetError(
      this.#providerId,
      "INPUT_TOO_LARGE",
      "background model request exceeds the configured input byte budget"
    );
  }

  snapshot(): BackgroundModelExecutionBudgetSnapshot {
    return {
      activeForeground: this.#activeForeground,
      activeBackground: this.#activeBackground.size,
      queuedBackground: this.#queue.length,
      pendingBackgroundSettlements: this.#pendingBackgroundSettlements,
      started: this.#started,
      completed: this.#completed,
      failed: this.#failed,
      cancelled: this.#cancelled,
      rejected: this.#rejected,
      preemptions: this.#preemptions,
      lastCancellationSettleMs: this.#lastCancellationSettleMs
    };
  }

  get options(): ResolvedBackgroundModelExecutionBudgetOptions {
    return this.#options;
  }

  #canStartBackground(): boolean {
    return this.#activeForeground === 0 && this.#activeBackground.size < this.#options.maxConcurrency;
  }

  #startBackground(callerSignal?: AbortSignal): BackgroundLease {
    const controller = new AbortController();
    const active: ActiveBackground = { callerSignal, controller, preempted: false, released: false };
    if (callerSignal) {
      const onCallerAbort = (): void => this.#requestCancellation(active, false);
      active.onCallerAbort = onCallerAbort;
      callerSignal.addEventListener("abort", onCallerAbort, { once: true });
    }
    this.#activeBackground.add(active);
    this.#started = saturatingBackgroundBudgetIncrement(this.#started);
    return {
      signal: controller.signal,
      cancel: (): void => this.#requestCancellation(active, false),
      release: (failed: boolean): void => {
        if (active.released) return;
        active.released = true;
        if (active.callerSignal && active.onCallerAbort) {
          active.callerSignal.removeEventListener("abort", active.onCallerAbort);
        }
        this.#activeBackground.delete(active);
        if (active.cancellationRequestedAt !== undefined) {
          this.#pendingBackgroundSettlements = Math.max(0, this.#pendingBackgroundSettlements - 1);
          this.#cancelled = saturatingBackgroundBudgetIncrement(this.#cancelled);
          this.#lastCancellationSettleMs = clampBackgroundBudgetDuration(this.#now() - active.cancellationRequestedAt);
        } else if (failed) {
          this.#failed = saturatingBackgroundBudgetIncrement(this.#failed);
        } else {
          this.#completed = saturatingBackgroundBudgetIncrement(this.#completed);
        }
        this.#pump();
      }
    };
  }

  #requestCancellation(active: ActiveBackground, preempted: boolean): void {
    if (active.released) return;
    if (preempted && !active.preempted) {
      active.preempted = true;
      this.#preemptions = saturatingBackgroundBudgetIncrement(this.#preemptions);
    }
    if (active.cancellationRequestedAt !== undefined) return;
    active.cancellationRequestedAt = this.#now();
    this.#pendingBackgroundSettlements = saturatingBackgroundBudgetIncrement(this.#pendingBackgroundSettlements);
    active.controller.abort(this.#abortedError());
  }

  #pump(): void {
    while (this.#queue.length > 0 && this.#canStartBackground()) {
      const queued = this.#queue.shift()!;
      if (queued.callerSignal && queued.onCallerAbort) {
        queued.callerSignal.removeEventListener("abort", queued.onCallerAbort);
      }
      if (queued.callerSignal?.aborted) {
        this.#rejected = saturatingBackgroundBudgetIncrement(this.#rejected);
        queued.reject(this.#abortedError());
        continue;
      }
      queued.resolve(this.#startBackground(queued.callerSignal));
    }
  }

  #abortedError(): BackgroundModelExecutionBudgetError {
    return new BackgroundModelExecutionBudgetError(
      this.#providerId,
      "REQUEST_ABORTED",
      "background model execution was cancelled"
    );
  }
}

async function* managedProviderStream(
  provider: ModelProvider,
  request: ModelRequest
): AsyncIterable<ModelEvent> {
  const iterator = provider.stream(request)[Symbol.asyncIterator]();
  let naturallyDone = false;
  try {
    while (true) {
      const next = await iterator.next();
      if (next.done) {
        naturallyDone = true;
        return;
      }
      yield next.value;
    }
  } finally {
    if (!naturallyDone && iterator.return) {
      await iterator.return();
    }
  }
}

async function* foregroundStream(
  provider: ModelProvider,
  coordinator: BackgroundModelExecutionCoordinator,
  request: ModelRequest
): AsyncIterable<ModelEvent> {
  const leave = coordinator.enterForeground();
  try {
    yield* managedProviderStream(provider, request);
  } finally {
    leave();
  }
}

async function runBackgroundGenerate(
  provider: ModelProvider,
  coordinator: BackgroundModelExecutionCoordinator,
  request: ModelRequest
): Promise<ModelResponse> {
  if (requestInputBytes(request) > coordinator.options.maxInputBytes) {
    throw coordinator.rejectInput();
  }
  const lease = await coordinator.acquireBackground(request.signal);
  let failed = true;
  try {
    const response = await provider.generate(withOutputCap(request, coordinator.options.maxOutputTokens, lease.signal));
    if (lease.signal.aborted) {
      throw new BackgroundModelExecutionBudgetError(provider.id, "REQUEST_ABORTED", "background model execution was cancelled");
    }
    failed = false;
    return response;
  } catch (error) {
    if (lease.signal.aborted && !(error instanceof BackgroundModelExecutionBudgetError)) {
      throw new BackgroundModelExecutionBudgetError(provider.id, "REQUEST_ABORTED", "background model execution was cancelled");
    }
    throw error;
  } finally {
    lease.release(failed);
  }
}

async function* backgroundStream(
  provider: ModelProvider,
  coordinator: BackgroundModelExecutionCoordinator,
  request: ModelRequest
): AsyncIterable<ModelEvent> {
  if (requestInputBytes(request) > coordinator.options.maxInputBytes) {
    throw coordinator.rejectInput();
  }
  const lease = await coordinator.acquireBackground(request.signal);
  let failed = true;
  let settled = false;
  let threw = false;
  try {
    for await (const event of managedProviderStream(
      provider,
      withOutputCap(request, coordinator.options.maxOutputTokens, lease.signal)
    )) {
      if (lease.signal.aborted) {
        throw new BackgroundModelExecutionBudgetError(provider.id, "REQUEST_ABORTED", "background model execution was cancelled");
      }
      yield event;
    }
    if (lease.signal.aborted) {
      throw new BackgroundModelExecutionBudgetError(provider.id, "REQUEST_ABORTED", "background model execution was cancelled");
    }
    failed = false;
    settled = true;
  } catch (error) {
    threw = true;
    if (lease.signal.aborted && !(error instanceof BackgroundModelExecutionBudgetError)) {
      throw new BackgroundModelExecutionBudgetError(provider.id, "REQUEST_ABORTED", "background model execution was cancelled");
    }
    throw error;
  } finally {
    if (!settled && !threw && !lease.signal.aborted) lease.cancel();
    lease.release(failed);
  }
}

export function createBackgroundModelExecutionBudgetProviders(
  provider: ModelProvider,
  options: BackgroundModelExecutionBudgetOptions = {}
): BackgroundModelExecutionBudgetProviders {
  const coordinator = new BackgroundModelExecutionCoordinator(provider.id, options);
  const foreground: ModelProvider = {
    id: provider.id,
    listModels: () => provider.listModels(),
    generate: async (request) => {
      const leave = coordinator.enterForeground();
      try {
        return await provider.generate(request);
      } finally {
        leave();
      }
    },
    stream: (request) => foregroundStream(provider, coordinator, request)
  };
  const background: ModelProvider = {
    id: provider.id,
    listModels: () => provider.listModels(),
    generate: (request) => runBackgroundGenerate(provider, coordinator, request),
    stream: (request) => backgroundStream(provider, coordinator, request)
  };
  return { background, foreground, snapshot: () => coordinator.snapshot() };
}
