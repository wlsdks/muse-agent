import { lstat, readFile } from "node:fs/promises";

import {
  beginResidentDaemonRestartState,
  decideResidentDaemonRestartAdmission,
  parseResidentDaemonRestartStateReceipt,
  recordResidentDaemonRestartFailure,
  recordResidentDaemonRestartSuccess,
  resetResidentDaemonRestartState,
  resolveResidentDaemonRestartStateFilePath,
  validateResidentDaemonRestartStatePath,
  type ResidentDaemonRestartAdmission,
  type ResidentDaemonRestartPolicy,
  type ResidentDaemonRestartStateReceipt
} from "@muse/runtime-state";
import { atomicWriteFile } from "@muse/stores";

export const RESIDENT_DAEMON_RESTART_STATE_UNAVAILABLE =
  "resident-restart-state-unavailable";

export const DEFAULT_RESIDENT_DAEMON_RESTART_POLICY: ResidentDaemonRestartPolicy = {
  baseDelayMs: 1_000,
  failureThreshold: 3,
  failureWindowMs: 5 * 60_000,
  maxDelayMs: 60_000,
  openCooldownMs: 5 * 60_000
};

export class ResidentDaemonRestartStateError extends Error {
  constructor() {
    super(RESIDENT_DAEMON_RESTART_STATE_UNAVAILABLE);
    this.name = "ResidentDaemonRestartStateError";
    this.stack = `${this.name}: ${this.message}`;
  }
}

export interface ResidentDaemonRestartStateJournal {
  readonly file: string;
  current(): ResidentDaemonRestartStateReceipt;
  decideAdmission(generation: string): Promise<ResidentDaemonRestartAdmission>;
  recordFailure(failureSequence: number): Promise<ResidentDaemonRestartStateReceipt>;
  recordSuccess(generation: string): Promise<ResidentDaemonRestartStateReceipt>;
  reset(): Promise<ResidentDaemonRestartStateReceipt>;
}

export interface OpenResidentDaemonRestartStateOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly now?: () => Date;
  readonly policy?: ResidentDaemonRestartPolicy;
  readonly writeFile?: (file: string, text: string) => Promise<void>;
}

export function resolveResidentDaemonRestartStateFile(
  env: Readonly<Record<string, string | undefined>> = process.env
): string {
  const file = resolveResidentDaemonRestartStateFilePath(env);
  if (!file) throw new ResidentDaemonRestartStateError();
  return file;
}

async function readPrevious(
  file: string,
  env: Readonly<Record<string, string | undefined>>
): Promise<ResidentDaemonRestartStateReceipt | undefined> {
  if (!await validateResidentDaemonRestartStatePath(env, file)) {
    throw new ResidentDaemonRestartStateError();
  }
  try {
    const stat = await lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new ResidentDaemonRestartStateError();
    if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
      throw new ResidentDaemonRestartStateError();
    }
    if (process.platform !== "win32" && (stat.mode & 0o777) !== 0o600) {
      throw new ResidentDaemonRestartStateError();
    }
    const parsed = parseResidentDaemonRestartStateReceipt(await readFile(file, "utf8"));
    if (!parsed) throw new ResidentDaemonRestartStateError();
    return parsed;
  } catch (cause) {
    if (cause && typeof cause === "object" && "code" in cause && cause.code === "ENOENT") {
      return undefined;
    }
    if (cause instanceof ResidentDaemonRestartStateError) throw cause;
    throw new ResidentDaemonRestartStateError();
  }
}

/** Open the serialized, owner-only restart budget for the resident daemon. */
export async function openResidentDaemonRestartStateJournal(
  options: OpenResidentDaemonRestartStateOptions = {}
): Promise<ResidentDaemonRestartStateJournal> {
  const env = options.env ?? process.env;
  const file = resolveResidentDaemonRestartStateFile(env);
  const previous = await readPrevious(file, env);
  const now = options.now ?? (() => new Date());
  const writeFile = options.writeFile
    ?? ((target: string, text: string) => atomicWriteFile(target, text, { mode: 0o600 }));
  let receipt = previous
    ?? beginResidentDaemonRestartState(
      options.policy ?? DEFAULT_RESIDENT_DAEMON_RESTART_POLICY,
      now()
    );
  if (!previous) {
    await writeFile(file, `${JSON.stringify(receipt)}\n`).catch(() => {
      throw new ResidentDaemonRestartStateError();
    });
  }
  let tail: Promise<unknown> = Promise.resolve();

  const transition = <T>(
    update: (current: ResidentDaemonRestartStateReceipt) => {
      readonly receipt: ResidentDaemonRestartStateReceipt;
      readonly result: T;
    }
  ): Promise<T> => {
    const operation = tail.then(async () => {
      const next = update(receipt);
      if (next.receipt !== receipt) {
        await writeFile(file, `${JSON.stringify(next.receipt)}\n`).catch(() => {
          throw new ResidentDaemonRestartStateError();
        });
        receipt = next.receipt;
      }
      return next.result;
    });
    tail = operation;
    return operation;
  };

  return {
    current: () => receipt,
    decideAdmission: (generation) => transition((current) => {
      const decision = decideResidentDaemonRestartAdmission(current, {
        generation,
        now: now()
      });
      return { receipt: decision.receipt, result: decision.admission };
    }),
    file,
    recordFailure: (failureSequence) => transition((current) => {
      const next = recordResidentDaemonRestartFailure(current, {
        at: now(),
        failureSequence
      });
      return { receipt: next, result: next };
    }),
    recordSuccess: (generation) => transition((current) => {
      const next = recordResidentDaemonRestartSuccess(current, {
        generation,
        now: now()
      });
      return { receipt: next, result: next };
    }),
    reset: () => transition((current) => {
      const next = resetResidentDaemonRestartState(current, now());
      return { receipt: next, result: next };
    })
  };
}
