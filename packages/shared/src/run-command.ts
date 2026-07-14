import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";

export interface RunCommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly timedOut: boolean;
}

export interface RunCommandOptions {
  readonly command: string;
  readonly args?: readonly string[];
  readonly stdin?: string;
  readonly timeoutMs: number;
  readonly spawnImpl?: typeof spawn;
  readonly killSignal?: Parameters<ChildProcess["kill"]>[0];
  readonly encoding?: BufferEncoding;
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly maxStdoutBytes?: number;
  readonly maxStderrBytes?: number;
  readonly abortSignal?: AbortSignal;
}

interface StreamAccumulator {
  chunks: Buffer[];
  limit?: number;
  bytes: number;
}

function toBuffer(chunk: unknown): Buffer {
  if (Buffer.isBuffer(chunk)) {
    return chunk;
  }
  return Buffer.from(typeof chunk === "string" ? chunk : String(chunk));
}

function appendChunk(target: StreamAccumulator, chunk: unknown): void {
  const raw = toBuffer(chunk);
  const limit = target.limit;
  if (limit === undefined) {
    target.chunks.push(raw);
    target.bytes += raw.length;
    return;
  }

  const remaining = limit - target.bytes;
  if (remaining <= 0) {
    return;
  }
  if (raw.length <= remaining) {
    target.chunks.push(raw);
    target.bytes += raw.length;
    return;
  }

  target.chunks.push(raw.subarray(0, remaining));
  target.bytes += remaining;
}

function asError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause));
}

function abortError(reason: unknown): Error {
  return reason instanceof Error
    ? reason
    : new DOMException(
      typeof reason === "string" ? reason : "command execution was aborted",
      "AbortError"
    );
}

function createRunCommandResult(
  exitCode: number | null,
  signal: string | null,
  stdout: string,
  stderr: string,
  timedOut: boolean
): RunCommandResult {
  return { exitCode, signal, stdout, stderr, timedOut };
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly reject: (reason?: unknown) => void;
}

function createAbortDeferred<T>(): Deferred<T> {
  let reject: ((reason?: unknown) => void) | undefined;
  const promise = new Promise<T>((_, deferredReject) => {
    reject = deferredReject;
  });
  return {
    promise,
    reject(value: unknown): void {
      if (!reject) {
        return;
      }
      reject(value);
    }
  };
}

function exitCodePayload(child: ChildProcess, stdout: StreamAccumulator, stderr: StreamAccumulator, encoding: BufferEncoding): Promise<RunCommandResult> {
  return once(child, "close").then(([exitCode, signal]) => createRunCommandResult(
    exitCode,
    signal ?? null,
    Buffer.concat(stdout.chunks).toString(encoding),
    Buffer.concat(stderr.chunks).toString(encoding),
    false
  ));
}

export async function runCommandWithTimeout(options: RunCommandOptions): Promise<RunCommandResult> {
  const {
    command,
    args = [],
    stdin,
    timeoutMs,
    spawnImpl = spawn,
    killSignal = "SIGKILL",
    encoding = "utf8",
    cwd,
    env,
    maxStdoutBytes,
    maxStderrBytes,
    abortSignal
  } = options;

  if (abortSignal?.aborted) {
    throw abortError(abortSignal.reason);
  }

  const child = spawnImpl(command, [...args], {
    stdio: ["pipe", "pipe", "pipe"],
    ...(cwd !== undefined ? { cwd } : {}),
    ...(env !== undefined ? { env } : {})
  });
  const stdout: StreamAccumulator = {
    bytes: 0,
    chunks: [],
    ...(maxStdoutBytes !== undefined ? { limit: maxStdoutBytes } : {})
  };
  const stderr: StreamAccumulator = {
    bytes: 0,
    chunks: [],
    ...(maxStderrBytes !== undefined ? { limit: maxStderrBytes } : {})
  };

  const onStdoutData = (chunk: unknown): void => {
    appendChunk(stdout, chunk);
  };
  const onStderrData = (chunk: unknown): void => {
    appendChunk(stderr, chunk);
  };
  child.stdout.on("data", onStdoutData);
  child.stderr.on("data", onStderrData);
  child.stdout.on("error", () => undefined);
  child.stderr.on("error", () => undefined);
  child.stdin.on("error", () => undefined);

  if (stdin !== undefined) {
    child.stdin.write(stdin);
  }
  child.stdin.end();

  const closeResult = exitCodePayload(child, stdout, stderr, encoding);
  const errorResult = once(child, "error").then(([error]) => {
    throw asError(error);
  });
  const outcome = Promise.race([closeResult, errorResult]);

  const hasFiniteTimeout = Number.isFinite(timeoutMs) && timeoutMs > 0;

  const abortPromise = abortSignal
    ? (() => {
      const abortDeferred = createAbortDeferred<never>();
      const onAbort = (): void => {
        child.kill(killSignal);
        abortDeferred.reject(abortError(abortSignal.reason));
      };
      abortSignal.addEventListener("abort", onAbort, { once: true });
      void outcome.finally(() => {
        abortSignal.removeEventListener("abort", onAbort);
      });
      return abortDeferred.promise;
    })()
    : undefined;

  // If no positive timeout, keep previous semantics for callers that use this
  // helper with non-runtime bounded commands.
  if (!hasFiniteTimeout) {
    if (!abortPromise) {
      return outcome;
    }
    return await Promise.race([outcome, abortPromise]);
  }

  // Plain setTimeout, not node:timers/promises — vi.useFakeTimers() cannot
  // intercept timers/promises, and downstream watchdog tests drive this
  // timeout with fake timers.
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<RunCommandResult>((resolve) => {
    timeoutHandle = setTimeout(() => {
      child.kill(killSignal);
      resolve({
        exitCode: null,
        signal: typeof killSignal === "string" ? killSignal : null,
        stderr: Buffer.concat(stderr.chunks).toString(encoding),
        stdout: Buffer.concat(stdout.chunks).toString(encoding),
        timedOut: true
      });
    }, timeoutMs);
    timeoutHandle.unref?.();
  });

  try {
    return abortPromise
      ? await Promise.race([outcome, timeout, abortPromise])
      : await Promise.race([outcome, timeout]);
  } finally {
    child.stdout.off("data", onStdoutData);
    child.stderr.off("data", onStderrData);
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
  }
}
