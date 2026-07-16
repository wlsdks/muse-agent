import { once } from "node:events";
import type { ChildProcess } from "node:child_process";
import type { IncomingMessage } from "node:http";

// A plain `setTimeout`/`clearTimeout` wrapper — not `node:timers/promises` —
// so callers under `vi.useFakeTimers()` (watchdog timeout tests) can advance
// it deterministically; `timers/promises` isn't reliably intercepted by fake
// timers.
export function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
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

export interface WaitForChildProcessOptions {
  /**
   * Opt in only for a signal this caller successfully requested. This keeps
   * unexpected signal termination fail-closed while supporting workflows that
   * intentionally stop a child process after collecting its output.
   */
  readonly acceptsTerminationSignal?: (signal: string) => boolean;
}

export async function waitForChildProcessResult(
  child: ChildProcess,
  context: string,
  stderrChunks?: readonly Buffer[],
  options: WaitForChildProcessOptions = {}
): Promise<void> {
  const result = await Promise.race([
    once(child, "error").then(([cause]) => ({ kind: "error" as const, error: cause as Error })),
    once(child, "close").then(([code, signal]) => ({
      kind: "close" as const,
      code: typeof code === "number" ? code : null,
      signal: typeof signal === "string" ? signal : null
    }))
  ]);

  if (result.kind === "error") {
    throw result.error;
  }

  if (result.code === 0) {
    return;
  }

  if (result.code === null && result.signal !== null && options.acceptsTerminationSignal?.(result.signal)) {
    return;
  }

  const stderrMessage = stderrChunks?.length
    ? `: ${Buffer.concat([...stderrChunks]).toString("utf8").trim()}`
    : "";

  if (result.code !== null) {
    throw new Error(`${context} exited with code ${result.code.toString()}${stderrMessage}`);
  }

  throw new Error(`${context} terminated by ${result.signal ?? "an unknown signal"}${stderrMessage}`);
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
