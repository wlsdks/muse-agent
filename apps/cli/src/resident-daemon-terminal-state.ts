import { randomUUID } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";

import {
  appendResidentDaemonFailure,
  beginResidentDaemonTerminalGeneration,
  markResidentDaemonStable,
  parseResidentDaemonTerminalStateReceipt,
  resolveResidentDaemonTerminalStateFilePath,
  validateResidentDaemonTerminalStatePath,
  type ResidentDaemonFailureContext,
  type ResidentDaemonStablePoint,
  type ResidentDaemonTerminalStateReceipt
} from "@muse/runtime-state";
import { atomicWriteFile } from "@muse/stores";

export const RESIDENT_DAEMON_TERMINAL_STATE_UNAVAILABLE =
  "resident-terminal-state-unavailable";

export class ResidentDaemonTerminalStateError extends Error {
  constructor() {
    super(RESIDENT_DAEMON_TERMINAL_STATE_UNAVAILABLE);
    this.name = "ResidentDaemonTerminalStateError";
    this.stack = `${this.name}: ${this.message}`;
  }
}

export interface ResidentDaemonTerminalStateJournal {
  readonly file: string;
  current(): ResidentDaemonTerminalStateReceipt;
  markStable(point: ResidentDaemonStablePoint): Promise<ResidentDaemonTerminalStateReceipt>;
  recordFailure(
    cause: unknown,
    context?: ResidentDaemonFailureContext
  ): Promise<ResidentDaemonTerminalStateReceipt>;
}

export interface OpenResidentDaemonTerminalStateOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly generation: string;
  readonly idFactory?: () => string;
  readonly now?: () => Date;
  readonly pid: number;
  readonly writeFile?: (file: string, text: string) => Promise<void>;
}

export function resolveResidentDaemonTerminalStateFile(
  env: Readonly<Record<string, string | undefined>> = process.env
): string {
  const file = resolveResidentDaemonTerminalStateFilePath(env);
  if (!file) throw new ResidentDaemonTerminalStateError();
  return file;
}

async function readPrevious(
  file: string,
  env: Readonly<Record<string, string | undefined>>
): Promise<
  | { readonly state: "missing" }
  | { readonly state: "corrupt" }
  | { readonly state: "valid"; readonly receipt: ResidentDaemonTerminalStateReceipt }
> {
  if (!await validateResidentDaemonTerminalStatePath(env, file)) {
    throw new ResidentDaemonTerminalStateError();
  }
  try {
    const stat = await lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new ResidentDaemonTerminalStateError();
    if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
      throw new ResidentDaemonTerminalStateError();
    }
    if (process.platform !== "win32" && (stat.mode & 0o777) !== 0o600) {
      throw new ResidentDaemonTerminalStateError();
    }
    const parsed = parseResidentDaemonTerminalStateReceipt(await readFile(file, "utf8"));
    return parsed ? { receipt: parsed, state: "valid" } : { state: "corrupt" };
  } catch (cause) {
    if (cause && typeof cause === "object" && "code" in cause && cause.code === "ENOENT") {
      return { state: "missing" };
    }
    if (cause instanceof ResidentDaemonTerminalStateError) throw cause;
    throw new ResidentDaemonTerminalStateError();
  }
}

/** Open the process-local terminal journal for one writer-lease generation. */
export async function openResidentDaemonTerminalStateJournal(
  options: OpenResidentDaemonTerminalStateOptions
): Promise<ResidentDaemonTerminalStateJournal> {
  const file = resolveResidentDaemonTerminalStateFile(options.env);
  const env = options.env ?? process.env;
  const previous = await readPrevious(file, env);
  const now = options.now ?? (() => new Date());
  const idFactory = options.idFactory ?? (() => randomUUID().replaceAll("-", ""));
  const writeFile = options.writeFile
    ?? ((target: string, text: string) => atomicWriteFile(target, text, { mode: 0o600 }));
  let receipt = beginResidentDaemonTerminalGeneration({
    generation: options.generation,
    now: now(),
    pid: options.pid,
    ...(previous.state === "valid" ? { previous: previous.receipt } : {})
  });
  if (previous.state === "corrupt") {
    receipt = appendResidentDaemonFailure(receipt, {
      cause: new SyntaxError("resident terminal state was corrupt"),
      context: { domain: "store" },
      id: idFactory(),
      now: now()
    });
  }
  await writeFile(file, `${JSON.stringify(receipt)}\n`).catch(() => {
    throw new ResidentDaemonTerminalStateError();
  });
  let tail: Promise<unknown> = Promise.resolve();

  const persist = (
    update: (current: ResidentDaemonTerminalStateReceipt) => ResidentDaemonTerminalStateReceipt
  ): Promise<ResidentDaemonTerminalStateReceipt> => {
    const operation = tail.then(async () => {
      const next = update(receipt);
      await writeFile(file, `${JSON.stringify(next)}\n`).catch(() => {
        throw new ResidentDaemonTerminalStateError();
      });
      receipt = next;
      return next;
    });
    tail = operation;
    return operation;
  };

  return {
    current: () => receipt,
    file,
    markStable: (point) => persist((current) => markResidentDaemonStable(current, point, now())),
    recordFailure: (cause, context) => persist((current) => appendResidentDaemonFailure(current, {
      cause,
      ...(context ? { context } : {}),
      id: idFactory(),
      now: now()
    }))
  };
}
