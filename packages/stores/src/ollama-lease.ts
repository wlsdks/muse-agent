/**
 * Cross-process Ollama lease — the foreground/background contention brake.
 *
 * An in-process mutex can't coordinate a SEPARATE-process Ollama, so a
 * foreground `muse ask`/`chat` and the background self-learning daemon could
 * both hit the local model at once and thrash a modest box. This is a tiny
 * filesystem lease (`~/.muse/ollama.lease`, pid + heartbeat) both honor: the
 * foreground holds it while it streams; the daemon SKIPS its LLM job while a
 * live foreground lease is held. FAIL-SAFE: any read/parse error ⇒ "not held"
 * (a missing/corrupt lease never blocks foreground work), and a dead-pid or
 * stale-heartbeat lease is ignored (auto-released) so a crashed holder can't
 * wedge the daemon forever. (PART A2 / B1 brake-first.)
 */
import { existsSync, readFileSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { atomicWriteFile } from "./atomic-file-store.js";

/** `~/.muse/ollama.lease` by default; override via `MUSE_OLLAMA_LEASE_FILE`. */
export function resolveOllamaLeaseFile(env: Record<string, string | undefined> = process.env): string {
  const override = env.MUSE_OLLAMA_LEASE_FILE?.trim();
  return override && override.length > 0 ? override : join(homedir(), ".muse", "ollama.lease");
}

interface LeaseRecord {
  readonly pid: number;
  readonly heartbeatMs: number;
}

/** Default staleness window: a lease older than this (no heartbeat) is ignored. */
export const DEFAULT_LEASE_STALE_MS = 2 * 60_000;

/** Write/refresh the lease for `pid` (best-effort; throws only on fs failure). */
export async function acquireOllamaLease(file: string, pid: number, nowMs: number): Promise<void> {
  await atomicWriteFile(file, `${JSON.stringify({ heartbeatMs: nowMs, pid } satisfies LeaseRecord)}\n`);
}

/** Release the lease IFF this `pid` owns it (someone else's lease is left alone). */
export async function releaseOllamaLease(file: string, pid: number): Promise<void> {
  const rec = readLease(file);
  if (rec?.pid === pid) {
    try {
      await unlink(file);
    } catch { /* already gone — fine */ }
  }
}

function readLease(file: string): LeaseRecord | undefined {
  try {
    if (!existsSync(file)) return undefined;
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<LeaseRecord>;
    if (typeof parsed.pid !== "number" || typeof parsed.heartbeatMs !== "number") return undefined;
    return { heartbeatMs: parsed.heartbeatMs, pid: parsed.pid };
  } catch {
    return undefined;
  }
}

function defaultIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Is the lease held by a DIFFERENT, live process with a fresh heartbeat?
 * The daemon calls this with its own pid: true ⇒ a foreground call is using
 * Ollama ⇒ defer. Fail-safe to false (never block on a missing/corrupt/stale/
 * dead lease). `isAlive`/`now` are injectable for tests.
 */
export function isOllamaLeaseHeldByOther(
  file: string,
  selfPid: number,
  options: { readonly staleMs?: number; readonly nowMs: number; readonly isAlive?: (pid: number) => boolean }
): boolean {
  const rec = readLease(file);
  if (!rec || rec.pid === selfPid) return false;
  const staleMs = options.staleMs ?? DEFAULT_LEASE_STALE_MS;
  if (options.nowMs - rec.heartbeatMs >= staleMs) return false; // stale → auto-released
  const isAlive = options.isAlive ?? defaultIsAlive;
  return isAlive(rec.pid);
}
