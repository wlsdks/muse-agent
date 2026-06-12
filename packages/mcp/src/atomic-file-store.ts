/**
 * Shared atomic-file primitives for the on-disk personal sidecar stores.
 *
 * Every sidecar (objectives / reminders / tasks / followups / playbook /
 * recall-hits / action-log / pending-approval …) does the same two things and
 * had the same two latent concurrency bugs:
 *
 *   1. ATOMIC WRITE — write a tmp file then rename over the target so a reader
 *      never sees half-flushed JSON. The bug: a `${pid}-${Date.now()}` tmp name
 *      collides between two same-millisecond writers, so the slower `rename`
 *      hits ENOENT (the tmp was already renamed away) and CRASHES. Fix: a
 *      `randomUUID()` suffix — globally unique, no collision.
 *   2. READ-MODIFY-WRITE — read the list, change it, write it back. The bug:
 *      two concurrent callers each read the SAME snapshot and the later write
 *      clobbers the earlier one (last-writer-wins → silent data loss). Fix: a
 *      per-file mutation queue that serialises the whole read-modify-write.
 *
 * These were fixed inline in four stores already (pending-approval, action-log,
 * proposed-action, recall-hits); this module is the single shared
 * implementation so the remaining stores adopt it without re-deriving it.
 */

import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { dirname } from "node:path";

export interface AtomicWriteOptions {
  /** fsync the tmp file before rename (durable against a crash mid-rename). Default true. */
  readonly fsync?: boolean;
  /** File mode for the tmp + final file. Default 0o600 (owner-only — these hold personal data). */
  readonly mode?: number;
}

/**
 * Write `contents` to `file` atomically: a uniquely-named tmp in the same
 * directory, then `rename` over the target. The randomUUID tmp suffix makes
 * concurrent writers collision-free (no ENOENT rename crash).
 */
export async function atomicWriteFile(file: string, contents: string, options: AtomicWriteOptions = {}): Promise<void> {
  const mode = options.mode ?? 0o600;
  const tmp = `${file}.tmp-${process.pid.toString()}-${randomUUID()}`;
  await fs.mkdir(dirname(file), { recursive: true });
  try {
    const handle = await fs.open(tmp, "w", mode);
    try {
      await handle.writeFile(contents, "utf8");
      // fsync before rename: a crash can otherwise commit the rename pointing at
      // a zero-length / partial file (metadata and data journal separately).
      if (options.fsync !== false) await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(tmp, file);
    await fs.chmod(file, mode).catch(() => undefined);
  } catch (error) {
    // A write/fsync/rename failure must not leave the tmp as an orphan — it
    // would accumulate as `*.tmp-*` litter in the sidecar store dir. Best-effort
    // cleanup, then surface the original error.
    await fs.rm(tmp, { force: true }).catch(() => undefined);
    throw error;
  }
}

const mutationQueues = new Map<string, Promise<unknown>>();

/**
 * Serialise a read-modify-write `op` against `file` so concurrent callers run
 * one-at-a-time (no lost-update). Keyed by file path, so different files run
 * in parallel. A throwing op never wedges the queue — the chain swallows the
 * rejection for sequencing while still rejecting the returned promise.
 */
export async function withFileMutationQueue<T>(file: string, op: () => Promise<T>): Promise<T> {
  const prior = mutationQueues.get(file) ?? Promise.resolve();
  const next = prior.then(op, op);
  mutationQueues.set(file, next.then(() => undefined, () => undefined));
  return next;
}
