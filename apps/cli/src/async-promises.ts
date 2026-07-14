import { setTimeout as sleepWithTimer } from "node:timers/promises";
import { once } from "node:events";
import type { ChildProcess } from "node:child_process";
import type { IncomingMessage } from "node:http";

export function sleep(milliseconds: number): Promise<void> {
  return sleepWithTimer(milliseconds);
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
