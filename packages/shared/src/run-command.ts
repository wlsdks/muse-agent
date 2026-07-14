import { spawn, type ChildProcess } from "node:child_process";
import { setTimeout as sleepWithTimer } from "node:timers/promises";

export interface RunCommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
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
}

function toBuffer(chunk: unknown): Buffer {
  if (Buffer.isBuffer(chunk)) {
    return chunk;
  }
  return Buffer.from(typeof chunk === "string" ? chunk : String(chunk));
}

export async function runCommandWithTimeout(options: RunCommandOptions): Promise<RunCommandResult> {
  const {
    command,
    args = [],
    stdin,
    timeoutMs,
    spawnImpl = spawn,
    killSignal = "SIGKILL",
    encoding = "utf8"
  } = options;

  const child = spawnImpl(command, [...args], { stdio: ["pipe", "pipe", "pipe"] });
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];

  const outcome = new Promise<RunCommandResult>((resolve, reject) => {
    child.stdout.on("data", (chunk: unknown) => {
      stdoutChunks.push(toBuffer(chunk));
    });
    child.stderr.on("data", (chunk: unknown) => {
      stderrChunks.push(toBuffer(chunk));
    });

    child.on("error", (error) => {
      reject(error instanceof Error ? error : new Error(String(error)));
    });

    child.on("close", (code) => {
      resolve({
        exitCode: code,
        stderr: Buffer.concat(stderrChunks).toString(encoding),
        stdout: Buffer.concat(stdoutChunks).toString(encoding),
        timedOut: false
      });
    });

    child.stdin.on("error", () => {
      // surfacing happens on `error`/`close`; don't emit unhandled stream errors
    });

    if (stdin !== undefined) {
      child.stdin.write(stdin);
    }
    child.stdin.end();
  });

  // If no positive timeout, keep previous semantics for callers that use this
  // helper with non-runtime bounded commands.
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return outcome;
  }

  const timeoutController = new AbortController();
  const timeout = sleepWithTimer(timeoutMs, undefined, {
    signal: timeoutController.signal,
    ref: false
  }).then(() => {
    child.kill(killSignal);
    return {
      exitCode: null,
      stderr: Buffer.concat(stderrChunks).toString(encoding),
      stdout: Buffer.concat(stdoutChunks).toString(encoding),
      timedOut: true
    };
  });
  timeout.catch(() => {
    return undefined;
  });

  outcome.catch(() => undefined);

  try {
    return await Promise.race([outcome, timeout]);
  } finally {
    timeoutController.abort();
  }
}
