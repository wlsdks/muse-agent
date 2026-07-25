import { join } from "node:path";

import {
  parseResidentDaemonHeartbeatReceipt,
  RESIDENT_DAEMON_HEARTBEAT_VERSION,
  type ResidentDaemonHeartbeatReceipt
} from "@muse/runtime-state";
import { atomicWriteFile } from "@muse/stores";

export const RESIDENT_DAEMON_HEARTBEAT_FILE = "proactive-heartbeat-daemon-loop.json";
export const RESIDENT_DAEMON_HEARTBEAT_WRITE_FAILED = "resident-heartbeat-write-failed";

export interface ResidentDaemonHeartbeatWriter {
  readonly file: string;
  recordLiveness(): Promise<ResidentDaemonHeartbeatReceipt>;
  recordProgress(): Promise<ResidentDaemonHeartbeatReceipt>;
}

export interface ResidentDaemonHeartbeatWriterOptions {
  readonly acquiredAtMs: number;
  readonly directory: string;
  readonly expectedCadenceMs: number;
  readonly generation: string;
  readonly now?: () => Date;
  readonly pid: number;
  readonly writeFile?: (file: string, text: string) => Promise<void>;
}

/**
 * Create the sole resident heartbeat writer for one lease generation.
 *
 * Sequence is process-local and strictly increasing. A new writer authority
 * gets a new lease-backed generation and safely restarts sequence at one.
 */
export function createResidentDaemonHeartbeatWriter(
  options: ResidentDaemonHeartbeatWriterOptions
): ResidentDaemonHeartbeatWriter {
  const file = join(options.directory, RESIDENT_DAEMON_HEARTBEAT_FILE);
  const now = options.now ?? (() => new Date());
  const writeFile = options.writeFile
    ?? ((target: string, text: string) => atomicWriteFile(target, text, { mode: 0o600 }));
  let sequence = 0;
  let lastWrittenAtMs = options.acquiredAtMs;
  let lastProgressAtMs = options.acquiredAtMs;
  let writeTail: Promise<unknown> = Promise.resolve();

  const record = (progress: boolean): Promise<ResidentDaemonHeartbeatReceipt> => {
    const operation = writeTail.then(async () => {
      const observedAtMs = now().getTime();
      if (!Number.isFinite(observedAtMs)) {
        throw new Error("resident daemon heartbeat clock is invalid");
      }
      lastWrittenAtMs = Math.max(lastWrittenAtMs, observedAtMs);
      if (progress) lastProgressAtMs = Math.max(lastProgressAtMs, lastWrittenAtMs);
      sequence += 1;
      const receipt: ResidentDaemonHeartbeatReceipt = {
        at: new Date(lastWrittenAtMs).toISOString(),
        expectedCadenceMs: options.expectedCadenceMs,
        generation: options.generation,
        lastProgressAt: new Date(lastProgressAtMs).toISOString(),
        pid: options.pid,
        sequence,
        version: RESIDENT_DAEMON_HEARTBEAT_VERSION
      };
      if (!parseResidentDaemonHeartbeatReceipt(JSON.stringify(receipt))) {
        throw new Error("resident daemon heartbeat configuration is invalid");
      }
      await writeFile(file, `${JSON.stringify(receipt)}\n`);
      return receipt;
    });
    // A failed authority receipt poisons later writes for this generation.
    writeTail = operation;
    return operation;
  };

  return {
    file,
    recordLiveness: () => record(false),
    recordProgress: () => record(true)
  };
}
