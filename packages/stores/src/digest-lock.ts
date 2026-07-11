/**
 * Cross-process mutual exclusion, originally built for the once-a-day
 * digest flush (`runDigestFlushIfDue`) and generalized (`withProcessLock`)
 * for any other select→act→mark critical section shared by TWO SEPARATE
 * daemons (the api server's tick and the CLI daemon's tick) reading/writing
 * the same store file — `atomicWriteFile` makes each individual write
 * collision-free, but it is not mutual exclusion, so without a real lock
 * both daemons can read the same "not yet done" state and both act on it.
 *
 * Mirrors `withFileLock`'s established convention (`encrypted-file.ts`): an
 * O_EXCL exclusive-create lock file, a nonce so a holder only ever unlinks
 * its OWN lock, and mtime-based stale-lock breaking so a crashed holder
 * can't wedge the critical section forever. It deliberately does NOT
 * spin/retry the way `withFileLock` does — a tick that loses the race
 * should not block waiting for the other daemon to finish (that just
 * delays a SECOND action rather than preventing it); it returns
 * "lock-held" on the first live contention so the caller treats the other
 * daemon as owning this tick.
 *
 * Fail-open: a lock-acquisition error that is NOT contention (a weird fs
 * failure — permissions, a read-only mount, …) runs `fn` UNLOCKED rather
 * than silencing the action. A broken lock must degrade to today's known
 * duplicate-action risk, never to an action that never runs.
 *
 * Heartbeat: unlike `withFileLock`'s millisecond critical sections, a
 * `withProcessLock` holder can run for minutes (several queued model calls),
 * so the mtime is refreshed on an unref'd interval (`staleMs / 3`) for as
 * long as `fn` runs — otherwise a legitimately slow holder can cross the
 * stale window and have its own lock stolen mid-work.
 */

import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { dirname } from "node:path";

import { errorMessage } from "@muse/shared";

/** Default staleness window for `withProcessLock` — a lock older than this
 *  (no fresh holder) is treated as crashed and broken. */
const DEFAULT_STALE_MS = 5 * 60_000;

/** Back-compat name for the digest flush's stale window — same value as
 *  `withProcessLock`'s default, kept as its own export since `digest-lock.test.ts`
 *  and other pre-generalization call sites already reference it. */
export const DIGEST_LOCK_STALE_MS = DEFAULT_STALE_MS;

/** Bounded — never spins waiting out a live holder; only retries past a stale/vanished lock. */
const MAX_ACQUIRE_ATTEMPTS = 3;

export type ProcessLockOutcome<T> =
  | { readonly kind: "ran"; readonly value: T; readonly lockError?: string }
  | { readonly kind: "lock-held" };

/** Back-compat alias — pre-generalization callers/tests import this name. */
export type DigestLockOutcome<T> = ProcessLockOutcome<T>;

type LockProbe = "live" | "stale" | "vanished";

// Deliberately REAL wall-clock time, not a caller-injectable `now` — a lock
// file's mtime is always OS-stamped in real time, so comparing it against a
// fictitious/injected "now" (the digest-hour test clock, for example) would
// misjudge a fresh lock as stale or vice versa. Mirrors `withFileLock`'s
// `Date.now()` convention (`encrypted-file.ts`) for the same reason.
async function probeLock(lockPath: string, staleMs: number): Promise<LockProbe> {
  try {
    const mtimeMs = (await fs.stat(lockPath)).mtimeMs;
    return Date.now() - mtimeMs > staleMs ? "stale" : "live";
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

// Refresh the lock's mtime while `fn` is still running, so a legitimately
// slow holder (several queued model calls under contention) never crosses
// the stale-window and gets its lock stolen mid-work — the exact double-fire
// bug the lock exists to prevent. Read-nonce-then-touch has a TOCTOU window
// (the lock could be stale-broken and re-acquired by someone else between the
// read and the utimes call) — same accepted residual as the unlink guard
// below; the fix scope here is "never touch a KNOWN foreign lock", not "make
// the touch atomic with the read".
async function touchOwnLock(lockPath: string, nonce: string): Promise<void> {
  try {
    if (!(await lockHoldsNonce(lockPath, nonce))) {
      return;
    }
    const now = new Date();
    await fs.utimes(lockPath, now, now);
  } catch {
    // Best-effort heartbeat — a failed touch just falls back to today's
    // stamp-once-at-acquisition behavior for this beat.
  }
}

function startLockHeartbeat(lockPath: string, nonce: string, staleMs: number): NodeJS.Timeout {
  const intervalMs = Math.max(1, Math.floor(staleMs / 3));
  const timer = setInterval(() => {
    void touchOwnLock(lockPath, nonce);
  }, intervalMs);
  // Never keeps the process alive on its own — the lock's own logic (fn
  // completing) is what should end the process, not this housekeeping timer.
  timer.unref();
  return timer;
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
 * Run `fn` holding an exclusive lock at `lockPath`. Resolves to
 * `{ kind: "lock-held" }` immediately on a LIVE held lock (no spin) — the
 * caller should treat that as "another daemon owns this tick". Resolves to
 * `{ kind: "ran", value }` after breaking a stale/vanished lock or acquiring
 * cleanly; `lockError` is set (and `fn` still ran, UNLOCKED) when lock
 * acquisition itself failed for a non-contention reason.
 */
export async function withProcessLock<T>(
  lockPath: string,
  fn: () => Promise<T>,
  staleMs: number = DEFAULT_STALE_MS
): Promise<ProcessLockOutcome<T>> {
  const nonce = `${process.pid.toString()}-${randomUUID()}`;

  try {
    await fs.mkdir(dirname(lockPath), { recursive: true });
  } catch (cause) {
    return { kind: "ran", lockError: errorMessage(cause), value: await fn() };
  }

  for (let attempt = 0; attempt < MAX_ACQUIRE_ATTEMPTS; attempt += 1) {
    const attemptResult = await tryAcquireOnce(lockPath, nonce);
    if (attemptResult === "acquired") {
      const heartbeat = startLockHeartbeat(lockPath, nonce, staleMs);
      try {
        return { kind: "ran", value: await fn() };
      } finally {
        clearInterval(heartbeat);
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
    const probe = await probeLock(lockPath, staleMs);
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

/** Thin wrapper over `withProcessLock` at the digest flush's established
 *  path (`${sentFile}.lock`) and stale window — kept so fire-10's call
 *  sites and tests didn't need to change when the lock generalized. */
export async function withDigestLock<T>(sentFile: string, fn: () => Promise<T>): Promise<DigestLockOutcome<T>> {
  return withProcessLock(`${sentFile}.lock`, fn, DIGEST_LOCK_STALE_MS);
}
