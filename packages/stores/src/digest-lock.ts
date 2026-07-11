/**
 * Cross-process mutual exclusion for the once-a-day digest flush
 * (`runDigestFlushIfDue`). Two SEPARATE daemons (the api server's tick and
 * the CLI daemon's tick) can both read `digestAlreadySentToday` as false
 * before either calls `markDigestSent` — `atomicWriteFile` makes each
 * individual write collision-free, but it is not mutual exclusion, so
 * without a real lock both daemons send the compiled digest.
 *
 * Mirrors `withFileLock`'s established convention (`encrypted-file.ts`): an
 * O_EXCL exclusive-create lock file, a nonce so a holder only ever unlinks
 * its OWN lock, and mtime-based stale-lock breaking so a crashed holder
 * can't wedge the digest forever. It deliberately does NOT spin/retry the
 * way `withFileLock` does — a digest tick that loses the race should not
 * block waiting for the other daemon to finish (that just delays a SECOND
 * send rather than preventing it); it returns "lock-held" on the first live
 * contention so the caller treats the other daemon as owning this flush.
 *
 * Fail-open: a lock-acquisition error that is NOT contention (a weird fs
 * failure — permissions, a read-only mount, …) runs `fn` UNLOCKED rather
 * than silencing the flush. A broken lock must degrade to today's known
 * duplicate-send risk, never to a digest that never sends.
 */

import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { dirname } from "node:path";

import { errorMessage } from "@muse/shared";

/** A lock older than this (no fresh holder) is treated as crashed and broken. */
export const DIGEST_LOCK_STALE_MS = 5 * 60_000;

/** Bounded — never spins waiting out a live holder; only retries past a stale/vanished lock. */
const MAX_ACQUIRE_ATTEMPTS = 3;

export type DigestLockOutcome<T> =
  | { readonly kind: "ran"; readonly value: T; readonly lockError?: string }
  | { readonly kind: "lock-held" };

type LockProbe = "live" | "stale" | "vanished";

// Deliberately REAL wall-clock time, not a caller-injectable `now` — a lock
// file's mtime is always OS-stamped in real time, so comparing it against a
// fictitious/injected "now" (the digest-hour test clock, for example) would
// misjudge a fresh lock as stale or vice versa. Mirrors `withFileLock`'s
// `Date.now()` convention (`encrypted-file.ts`) for the same reason.
async function probeLock(lockPath: string): Promise<LockProbe> {
  try {
    const mtimeMs = (await fs.stat(lockPath)).mtimeMs;
    return Date.now() - mtimeMs > DIGEST_LOCK_STALE_MS ? "stale" : "live";
  } catch (cause) {
    // ONLY ENOENT means "vanished between EEXIST and stat" — any other stat
    // error says nothing about the holder, so treat it as live (never steal
    // a lock we can't actually confirm is gone).
    return (cause as NodeJS.ErrnoException).code === "ENOENT" ? "vanished" : "live";
  }
}

async function lockHoldsNonce(lockPath: string, nonce: string): Promise<boolean> {
  try {
    return (await fs.readFile(lockPath, "utf8")) === nonce;
  } catch {
    return false;
  }
}

type AcquireAttempt = "acquired" | "contended" | { readonly error: unknown };

async function tryAcquireOnce(lockPath: string, nonce: string): Promise<AcquireAttempt> {
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(lockPath, "wx");
    await handle.writeFile(nonce, "utf8");
    return "acquired";
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException).code;
    // win32 can surface a concurrent unlink-vs-open race on the lock file as
    // EPERM/EACCES/EBUSY rather than EEXIST — same meaning: contended.
    const contended = code === "EEXIST" || code === "EPERM" || code === "EACCES" || code === "EBUSY";
    return contended ? "contended" : { error: cause };
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/**
 * Run `fn` holding the digest flush lock at `${sentFile}.lock`. Resolves to
 * `{ kind: "lock-held" }` immediately on a LIVE held lock (no spin) — the
 * caller should treat that as "another daemon owns this flush". Resolves to
 * `{ kind: "ran", value }` after breaking a stale/vanished lock or acquiring
 * cleanly; `lockError` is set (and `fn` still ran, UNLOCKED) when lock
 * acquisition itself failed for a non-contention reason.
 */
export async function withDigestLock<T>(sentFile: string, fn: () => Promise<T>): Promise<DigestLockOutcome<T>> {
  const lockPath = `${sentFile}.lock`;
  const nonce = `${process.pid.toString()}-${randomUUID()}`;

  try {
    await fs.mkdir(dirname(sentFile), { recursive: true });
  } catch (cause) {
    return { kind: "ran", lockError: errorMessage(cause), value: await fn() };
  }

  for (let attempt = 0; attempt < MAX_ACQUIRE_ATTEMPTS; attempt += 1) {
    const attemptResult = await tryAcquireOnce(lockPath, nonce);
    if (attemptResult === "acquired") {
      try {
        return { kind: "ran", value: await fn() };
      } finally {
        if (await lockHoldsNonce(lockPath, nonce)) {
          await fs.unlink(lockPath).catch(() => undefined);
        }
      }
    }
    if (typeof attemptResult === "object") {
      return { kind: "ran", lockError: errorMessage(attemptResult.error), value: await fn() };
    }
    // "contended" — decide whether the holder is stale/vanished (worth one
    // more attempt) or genuinely live (return lock-held, no spin).
    const probe = await probeLock(lockPath);
    if (probe === "live") {
      return { kind: "lock-held" };
    }
    if (probe === "stale") {
      await fs.unlink(lockPath).catch(() => undefined);
    }
    // "vanished" or a just-stolen "stale" lock — loop retries the open,
    // bounded by MAX_ACQUIRE_ATTEMPTS so a flapping lock can't spin forever.
  }
  return { kind: "lock-held" };
}
