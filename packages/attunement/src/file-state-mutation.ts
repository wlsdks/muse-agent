import { withFileLock, withFileMutationQueue } from "@muse/stores";

/** Result of one locked file-state transition. */
export interface FileStateMutation<State, Result> {
  readonly changed: boolean;
  readonly result: Result;
  readonly state: State;
}

/**
 * Serializes a complete read-modify-write transition in-process and across
 * processes. Store-specific parsing and persistence stay at the call site;
 * this module owns only the shared concurrency invariant.
 */
export async function mutateFileState<State, Result>(
  file: string,
  read: (file: string) => Promise<State>,
  write: (file: string, state: State) => Promise<void>,
  mutate: (state: State) => FileStateMutation<State, Result> | Promise<FileStateMutation<State, Result>>
): Promise<Result> {
  return withFileMutationQueue(file, () => withFileLock(file, async () => {
    const state = await read(file);
    const mutation = await mutate(state);
    if (mutation.changed) {
      await write(file, mutation.state);
    }
    return mutation.result;
  }));
}
