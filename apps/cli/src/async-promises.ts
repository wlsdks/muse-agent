import { once } from "node:events";
import type { ChildProcess } from "node:child_process";
import type { IncomingMessage } from "node:http";

// A plain `setTimeout`/`clearTimeout` wrapper — not `node:timers/promises` —
// so callers under `vi.useFakeTimers()` (watchdog timeout tests) can advance
// it deterministically; `timers/promises` isn't reliably intercepted by fake
// timers.
export function sleep(milliseconds: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, milliseconds);
  return promise;
}

export async function withBestEffort<T, F>(promise: Promise<T>, fallback: F): Promise<T | F> {
  try {
    return await promise;
  } catch {
    return fallback;
  }
}

export async function waitForShutdownSignal(signals: readonly NodeJS.Signals[] = ["SIGINT", "SIGTERM"]): Promise<NodeJS.Signals> {
  const signal = await Promise.race(
    signals.map(async (signalName) => {
      await once(process, signalName);
      return signalName;
    })
  );
  return signal;
}

export async function waitForChildProcessClose(child: ChildProcess): Promise<void> {
  await once(child, "close");
}

export async function waitForChildProcessResult(
  child: ChildProcess,
  context: string,
  stderrChunks?: readonly Buffer[]
): Promise<void> {
  const result = await Promise.race([
    once(child, "error").then(([cause]) => ({ kind: "error" as const, error: normalizeChildError(cause) })),
    once(child, "close").then(([code, signal]) => ({ kind: "close" as const, code: code ?? 0, signal: signal ?? null }))
  ]);

  if (result.kind === "error") {
    throw result.error;
  }

  if (result.code === 0) {
    return;
  }

  const stderrMessage = stderrChunks?.length
    ? `: ${Buffer.concat([...stderrChunks]).toString("utf8").trim()}`
    : "";

  if (result.signal === null) {
    throw new Error(`${context} exited with code ${result.code.toString()}${stderrMessage}`);
  }

  throw new Error(`${context} terminated by ${result.signal} after code ${result.code.toString()}${stderrMessage}`);
}

function normalizeChildError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(typeof cause === "string" ? cause : "child process failed");
}

export async function readRequestBody(
  req: IncomingMessage,
  maxBytes = 64 * 1024
): Promise<string> {
  let received = 0;
  const chunks: Buffer[] = [];

  for await (const chunk of req) {
    const safeChunk = typeof chunk === "string" ? Buffer.from(chunk) : Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    received += safeChunk.length;
    if (received > maxBytes) {
      const cause = new Error("payload too large");
      req.destroy(cause);
      throw cause;
    }
    chunks.push(safeChunk);
  }

  return Buffer.concat(chunks).toString("utf8");
}
