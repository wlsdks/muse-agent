import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";

export interface RunCommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly timedOut: boolean;
  /** Either stream exceeded its configured capture limit. */
  readonly truncated: boolean;
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
  /** Start a dedicated POSIX process group and terminate its whole tree on timeout/abort. */
  readonly killProcessGroup?: boolean;
}

interface StreamAccumulator {
  chunks: Buffer[];
  limit?: number;
  bytes: number;
  truncated: boolean;
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
    target.truncated ||= raw.length > 0;
    return;
  }
  if (raw.length <= remaining) {
    target.chunks.push(raw);
    target.bytes += raw.length;
    return;
  }

  target.chunks.push(raw.subarray(0, remaining));
  target.bytes += remaining;
  target.truncated = true;
}

function asError(cause: unknown): Error {
  const message = typeof cause === "string" ? cause : typeof cause === "object" && cause !== null && "message" in cause && typeof (cause as { message?: unknown }).message === "string" ? (cause as { message: string }).message : String(cause);
  return new Error(message);
}

function abortError(reason: unknown): Error {
  return new DOMException(
    typeof reason === "string" ? reason : asMessageFromValue(reason, "command execution was aborted"),
    "AbortError"
  );
}

function asMessageFromValue(cause: unknown, fallback: string): string {
  if (typeof cause === "string") {
    return cause;
  }

  if (cause !== null && typeof cause === "object" && "message" in cause) {
    const message = (cause as { message?: unknown }).message;
    if (typeof message === "string") {
      return message;
    }
  }

  return fallback;
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
    abortSignal,
    killProcessGroup = false
  } = options;

  if (abortSignal?.aborted) {
    throw abortError(abortSignal.reason);
  }

  const child = spawnImpl(command, [...args], {
    stdio: ["pipe", "pipe", "pipe"],
    ...(killProcessGroup && process.platform !== "win32" ? { detached: true } : {}),
    ...(cwd !== undefined ? { cwd } : {}),
    ...(env !== undefined ? { env } : {})
  });

  const terminateChild = (): void => {
    if (killProcessGroup && process.platform !== "win32" && child.pid !== undefined) {
      try {
        process.kill(-child.pid, killSignal);
        return;
      } catch {
        // The group may already have exited between the timeout and the signal.
      }
    }
    child.kill(killSignal);
  };
  const stdout: StreamAccumulator = {
    bytes: 0,
    chunks: [],
    truncated: false,
    ...(maxStdoutBytes !== undefined ? { limit: maxStdoutBytes } : {})
  };
  const stderr: StreamAccumulator = {
    bytes: 0,
    chunks: [],
    truncated: false,
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

  const outcome = Promise.race([
    once(child, "close").then(([exitCode, signal]) => ({
      exitCode,
      signal: signal ?? null,
      stderr: Buffer.concat(stderr.chunks).toString(encoding),
      stdout: Buffer.concat(stdout.chunks).toString(encoding),
      timedOut: false,
      truncated: stdout.truncated || stderr.truncated
    }) as RunCommandResult),
    once(child, "error").then(([error]) => {
      throw asError(error);
    })
  ]);

  const hasFiniteTimeout = Number.isFinite(timeoutMs) && timeoutMs > 0;

  const abortPromise = abortSignal
    ? (() => {
      const abortDeferred = Promise.withResolvers<never>();
      const onAbort = (): void => {
        terminateChild();
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
      terminateChild();
      resolve({
        exitCode: null,
        signal: typeof killSignal === "string" ? killSignal : null,
        stderr: Buffer.concat(stderr.chunks).toString(encoding),
        stdout: Buffer.concat(stdout.chunks).toString(encoding),
        timedOut: true,
        truncated: stdout.truncated || stderr.truncated
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
