import { constants as fsConstants, promises as fs } from "node:fs";
import { dirname, resolve } from "node:path";

import {
  admitTriggerControl,
  cancelTriggerControlWork,
  claimTriggerControlWork,
  createTriggerControlState,
  parseTriggerControlState,
  resumeTriggerControlWork,
  serializeTriggerControlState,
  settleTriggerControlWork,
  withPrivateFileLock,
  type AdmitTriggerControlResult,
  type CancelTriggerWorkInput,
  type ClaimTriggerWorkInput,
  type CreateTriggerAdmissionJournalInput,
  type JournalTriggerAdmissionInput,
  type ResumeTriggerWorkInput,
  type SettleTriggerWorkInput,
  type TriggerControlState
} from "@muse/shared";
import {
  atomicWriteFile,
  withFileMutationQueue
} from "@muse/stores/atomic-file-store";

const MAX_TRIGGER_CONTROL_FILE_BYTES = 4 * 1024 * 1024;
const TRIGGER_CONTROL_LOCK_GIVE_UP_MS = 12_000;

export type TriggerControlFileStoreErrorCode =
  | "configuration-mismatch"
  | "corrupt-state"
  | "unsafe-file";

export class TriggerControlFileStoreError extends Error {
  constructor(readonly code: TriggerControlFileStoreErrorCode) {
    super(`Trigger control state is ${code.replaceAll("-", " ")}.`);
    this.name = "TriggerControlFileStoreError";
  }
}

type StateTransition<Result> = Readonly<{
  result: Result;
  state: TriggerControlState;
}>;

class ConcurrentTriggerControlReplace extends Error {}

/**
 * Durable host boundary for trigger admission and work settlement.
 *
 * The pure trigger-control reducer remains provider-neutral. This store adds
 * only owner-private I/O, cross-process serialization and crash-safe replace.
 * Scheduler dispatch wiring is intentionally a separate slice.
 */
export class TriggerControlFileStore {
  readonly file: string;
  private readonly initialState: TriggerControlState;

  constructor(
    file: string,
    initial: CreateTriggerAdmissionJournalInput
  ) {
    if (file.trim().length === 0) {
      throw new TypeError("trigger control file must be non-empty");
    }
    this.file = resolve(file);
    this.initialState = createTriggerControlState(initial);
  }

  async snapshot(): Promise<TriggerControlState> {
    await this.assertPrivateParent();
    return this.readState();
  }

  admit(input: JournalTriggerAdmissionInput): Promise<AdmitTriggerControlResult> {
    return this.transition((state) => {
      const result = admitTriggerControl(state, input);
      return { result, state: result.state };
    });
  }

  claim(input: ClaimTriggerWorkInput): Promise<TriggerControlState> {
    return this.transition((state) => {
      const next = claimTriggerControlWork(state, input);
      return { result: next, state: next };
    });
  }

  resume(input: ResumeTriggerWorkInput & { readonly dedupKey: string }): Promise<TriggerControlState> {
    return this.transition((state) => {
      const next = resumeTriggerControlWork(state, input);
      return { result: next, state: next };
    });
  }

  settle(input: SettleTriggerWorkInput & { readonly dedupKey: string }): Promise<TriggerControlState> {
    return this.transition((state) => {
      const next = settleTriggerControlWork(state, input);
      return { result: next, state: next };
    });
  }

  cancel(input: CancelTriggerWorkInput & { readonly dedupKey: string }): Promise<TriggerControlState> {
    return this.transition((state) => {
      const next = cancelTriggerControlWork(state, input);
      return { result: next, state: next };
    });
  }

  private async transition<Result>(
    apply: (state: TriggerControlState) => StateTransition<Result>
  ): Promise<Result> {
    return withFileMutationQueue(this.file, async () => {
      await this.assertPrivateParent();
      return withPrivateFileLock(`${this.file}.lock`, async () => {
        const current = await this.readState();
        const transition = apply(current);
        if (transition.state.stateId !== current.stateId) {
          await atomicWriteFile(
            this.file,
            `${serializeTriggerControlState(transition.state)}\n`,
            { mode: 0o600 }
          );
        }
        return transition.result;
      }, {
        giveUpMs: TRIGGER_CONTROL_LOCK_GIVE_UP_MS,
        reclaimDeadProcess: true
      });
    });
  }

  private async assertPrivateParent(): Promise<void> {
    const parent = dirname(this.file);
    let pathStat: Awaited<ReturnType<typeof fs.lstat>>;
    let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
    try {
      pathStat = await fs.lstat(parent);
      if (
        pathStat.isSymbolicLink()
        || !pathStat.isDirectory()
        || !isOwnerPrivateDirectory(pathStat)
      ) {
        throw new TriggerControlFileStoreError("unsafe-file");
      }
      handle = await fs.open(
        parent,
        fsConstants.O_RDONLY
          | (process.platform === "win32"
            ? 0
            : fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW)
      );
      const opened = await handle.stat();
      if (
        !opened.isDirectory()
        || opened.dev !== pathStat.dev
        || opened.ino !== pathStat.ino
        || !isOwnerPrivateDirectory(opened)
      ) {
        throw new TriggerControlFileStoreError("unsafe-file");
      }
    } catch (cause) {
      if (cause instanceof TriggerControlFileStoreError) throw cause;
      throw new TriggerControlFileStoreError("unsafe-file");
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  private async readState(): Promise<TriggerControlState> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.readStateOnce();
      } catch (cause) {
        if (!(cause instanceof ConcurrentTriggerControlReplace) || attempt >= 2) throw cause;
      }
    }
  }

  private async readStateOnce(): Promise<TriggerControlState> {
    let pathStat: Awaited<ReturnType<typeof fs.lstat>>;
    try {
      pathStat = await fs.lstat(this.file);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") {
        return this.initialState;
      }
      throw new TriggerControlFileStoreError("unsafe-file");
    }
    if (
      pathStat.isSymbolicLink()
      || !pathStat.isFile()
      || pathStat.nlink !== 1
      || Number(pathStat.size) > MAX_TRIGGER_CONTROL_FILE_BYTES
      || !isOwnerPrivate(pathStat)
    ) {
      throw new TriggerControlFileStoreError("unsafe-file");
    }

    let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
    let raw: string;
    try {
      handle = await fs.open(
        this.file,
        fsConstants.O_RDONLY | (process.platform === "win32" ? 0 : fsConstants.O_NOFOLLOW)
      );
      const opened = await handle.stat();
      if (
        !opened.isFile()
        || opened.nlink !== 1
        || Number(opened.size) > MAX_TRIGGER_CONTROL_FILE_BYTES
        || !isOwnerPrivate(opened)
      ) {
        throw new TriggerControlFileStoreError("unsafe-file");
      }
      if (opened.dev !== pathStat.dev || opened.ino !== pathStat.ino) {
        throw new ConcurrentTriggerControlReplace();
      }
      raw = await handle.readFile("utf8");
    } catch (cause) {
      if (
        cause instanceof TriggerControlFileStoreError
        || cause instanceof ConcurrentTriggerControlReplace
      ) {
        throw cause;
      }
      throw new TriggerControlFileStoreError("unsafe-file");
    } finally {
      await handle?.close().catch(() => undefined);
    }

    let state: TriggerControlState;
    try {
      state = parseTriggerControlState(raw);
    } catch {
      throw new TriggerControlFileStoreError("corrupt-state");
    }
    if (
      state.journal.maxEntries !== this.initialState.journal.maxEntries
      || state.journal.maxPending !== this.initialState.journal.maxPending
    ) {
      throw new TriggerControlFileStoreError("configuration-mismatch");
    }
    return state;
  }
}

function isOwnerPrivate(stat: {
  readonly mode: number | bigint;
  readonly uid: number | bigint;
}): boolean {
  if (process.platform === "win32") return true;
  if ((Number(stat.mode) & 0o777) !== 0o600) return false;
  return typeof process.getuid !== "function" || Number(stat.uid) === process.getuid();
}

function isOwnerPrivateDirectory(stat: {
  readonly mode: number | bigint;
  readonly uid: number | bigint;
}): boolean {
  if (process.platform === "win32") return true;
  if ((Number(stat.mode) & 0o077) !== 0) return false;
  return typeof process.getuid !== "function" || Number(stat.uid) === process.getuid();
}
