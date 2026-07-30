import { promises as fs } from "node:fs";

import {
  admitTriggerToJournal,
  createTriggerAdmissionJournal,
  parseTriggerAdmissionJournal,
  serializeTriggerAdmissionJournal,
  settleTriggerAdmission,
  type CreateTriggerAdmissionJournalInput,
  type JournalTriggerAdmissionInput,
  type JournalTriggerAdmissionResult,
  type SettleTriggerAdmissionInput,
  type TriggerAdmissionJournal
} from "@muse/shared";

import { atomicWriteFile, withFileLock, withFileMutationQueue } from "./atomic-file-store.js";

const DEFAULT_MAX_FILE_BYTES = 5 * 1024 * 1024;

export interface FileTriggerAdmissionJournalStoreOptions
  extends CreateTriggerAdmissionJournalInput {
  readonly file: string;
  readonly maxFileBytes?: number;
}

/**
 * Strict durable boundary for trigger admission and settlement.
 *
 * Missing state starts empty. Existing state never does: malformed, oversized,
 * symlinked, or non-regular files fail closed so a persistence problem cannot
 * reopen execution rights by silently replacing the journal with an empty one.
 */
export class FileTriggerAdmissionJournalStore {
  private readonly file: string;
  private readonly initial: CreateTriggerAdmissionJournalInput;
  private readonly maxFileBytes: number;

  constructor(options: FileTriggerAdmissionJournalStoreOptions) {
    if (options.file.trim().length === 0) {
      throw new TypeError("trigger admission journal file must not be blank");
    }
    if (options.maxFileBytes !== undefined
      && (!Number.isSafeInteger(options.maxFileBytes) || options.maxFileBytes <= 0)) {
      throw new TypeError("maxFileBytes must be a positive safe integer");
    }
    // Validate capacity options at construction, before any filesystem effect.
    createTriggerAdmissionJournal(options);
    this.file = options.file;
    this.initial = {
      maxEntries: options.maxEntries,
      maxPending: options.maxPending
    };
    this.maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  }

  read(): Promise<TriggerAdmissionJournal> {
    return this.readCurrent();
  }

  admit(input: JournalTriggerAdmissionInput): Promise<JournalTriggerAdmissionResult> {
    return this.mutate((journal) => {
      const result = admitTriggerToJournal(journal, input);
      return { journal: result.journal, result };
    });
  }

  settle(input: SettleTriggerAdmissionInput): Promise<TriggerAdmissionJournal> {
    return this.mutate((journal) => {
      const next = settleTriggerAdmission(journal, input);
      return { journal: next, result: next };
    });
  }

  private mutate<Result>(
    change: (journal: TriggerAdmissionJournal) => {
      readonly journal: TriggerAdmissionJournal;
      readonly result: Result;
    }
  ): Promise<Result> {
    return withFileMutationQueue(this.file, () => withFileLock(this.file, async () => {
      const current = await this.readCurrent();
      const mutation = change(current);
      if (mutation.journal.snapshotId !== current.snapshotId) {
        await atomicWriteFile(
          this.file,
          `${serializeTriggerAdmissionJournal(mutation.journal)}\n`,
          { mode: 0o600 }
        );
      }
      return mutation.result;
    }));
  }

  private async readCurrent(): Promise<TriggerAdmissionJournal> {
    let metadata: Awaited<ReturnType<typeof fs.lstat>>;
    try {
      metadata = await fs.lstat(this.file);
    } catch (error) {
      if (isNodeErrorCode(error, "ENOENT")) {
        return createTriggerAdmissionJournal(this.initial);
      }
      throw error;
    }
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      throw new TypeError("trigger admission journal must be a regular file");
    }
    if (metadata.size > this.maxFileBytes) {
      throw new TypeError("trigger admission journal exceeds maxFileBytes");
    }
    const raw = await fs.readFile(this.file, "utf8");
    if (Buffer.byteLength(raw, "utf8") > this.maxFileBytes) {
      throw new TypeError("trigger admission journal exceeds maxFileBytes");
    }
    try {
      return parseTriggerAdmissionJournal(raw);
    } catch (error) {
      throw new TypeError("invalid trigger admission journal; refusing access", { cause: error });
    }
  }
}

function isNodeErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error
    && "code" in error
    && (error as NodeJS.ErrnoException).code === code;
}
