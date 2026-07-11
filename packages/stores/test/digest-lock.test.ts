import { randomUUID } from "node:crypto";
import { mkdtemp, rm, stat, utimes, writeFile } from "node:fs/promises";
import { promises as fsPromises } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DIGEST_LOCK_STALE_MS, withDigestLock, withProcessLock } from "../src/digest-lock.js";

let dir: string;
let sentFile: string;
let lockPath: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), `muse-digest-lock-${randomUUID()}-`));
  sentFile = join(dir, "digest-sent.json");
  lockPath = `${sentFile}.lock`;
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(dir, { force: true, recursive: true });
});

async function lockExists(): Promise<boolean> {
  try {
    await stat(lockPath);
    return true;
  } catch {
    return false;
  }
}

describe("withDigestLock", () => {
  it("acquires, runs fn, and releases the lock on success", async () => {
    const outcome = await withDigestLock(sentFile, async () => "done");
    expect(outcome).toEqual({ kind: "ran", value: "done" });
    expect(await lockExists()).toBe(false);
  });

  it("releases the lock even when fn throws (so the next tick can retry)", async () => {
    await expect(withDigestLock(sentFile, async () => {
      throw new Error("send failed");
    })).rejects.toThrow("send failed");
    expect(await lockExists()).toBe(false);
  });

  it("returns lock-held (without running fn) when a LIVE lock is already held", async () => {
    await writeFile(lockPath, "external-holder", "utf8");
    let ran = false;
    const outcome = await withDigestLock(sentFile, async () => { ran = true; });
    expect(outcome).toEqual({ kind: "lock-held" });
    expect(ran).toBe(false);
    // The externally-held lock is untouched — only its own holder may remove it.
    expect(await lockExists()).toBe(true);
  });

  it("does not spin waiting out a live holder — resolves promptly", async () => {
    await writeFile(lockPath, "external-holder", "utf8");
    const start = Date.now();
    await withDigestLock(sentFile, async () => undefined);
    expect(Date.now() - start).toBeLessThan(2000);
  });

  it("breaks a STALE lock (older than DIGEST_LOCK_STALE_MS) and proceeds", async () => {
    await writeFile(lockPath, "crashed-holder", "utf8");
    const staleMtime = new Date(Date.now() - DIGEST_LOCK_STALE_MS - 60_000);
    await utimes(lockPath, staleMtime, staleMtime);
    let ran = false;
    const outcome = await withDigestLock(sentFile, async () => { ran = true; return "ok"; });
    expect(outcome).toEqual({ kind: "ran", value: "ok" });
    expect(ran).toBe(true);
    expect(await lockExists()).toBe(false);
  });

  it("fails OPEN on a non-contention lock-acquisition error: fn still runs, unlocked", async () => {
    const weirdError = Object.assign(new Error("simulated EIO"), { code: "EIO" });
    vi.spyOn(fsPromises, "open").mockRejectedValueOnce(weirdError);
    let ran = false;
    const outcome = await withDigestLock(sentFile, async () => { ran = true; return "ok"; });
    expect(ran).toBe(true);
    expect(outcome.kind).toBe("ran");
    if (outcome.kind === "ran") {
      expect(outcome.value).toBe("ok");
      expect(outcome.lockError).toContain("simulated EIO");
    }
    expect(await lockExists()).toBe(false);
  });

  it("two concurrent acquirers against the SAME files: exactly one runs, the other gets lock-held", async () => {
    let concurrentRuns = 0;
    let maxConcurrent = 0;
    const runOnce = () => withDigestLock(sentFile, async () => {
      concurrentRuns += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrentRuns);
      await new Promise((resolve) => setTimeout(resolve, 30));
      concurrentRuns -= 1;
      return "ran";
    });
    const [a, b] = await Promise.all([runOnce(), runOnce()]);
    const kinds = [a.kind, b.kind].sort();
    expect(kinds).toEqual(["lock-held", "ran"]);
    expect(maxConcurrent).toBe(1);
  });
});

describe("withProcessLock heartbeat", () => {
  it("keeps a slow holder's lock alive past staleMs so a mid-work probe gets lock-held, not a steal", async () => {
    const staleMs = 300;
    let holderRan = false;
    const holderPromise = withProcessLock(lockPath, async () => {
      holderRan = true;
      await new Promise((resolve) => setTimeout(resolve, staleMs * 4));
      return "done";
    }, staleMs);

    // Midway through the holder's work — already past staleMs from acquisition
    // time, so WITHOUT a heartbeat this probe would see a stale lock and steal it.
    await new Promise((resolve) => setTimeout(resolve, staleMs * 2));
    let probeRan = false;
    const probeOutcome = await withProcessLock(lockPath, async () => { probeRan = true; }, staleMs);
    expect(probeOutcome).toEqual({ kind: "lock-held" });
    expect(probeRan).toBe(false);

    const holderOutcome = await holderPromise;
    expect(holderOutcome).toEqual({ kind: "ran", value: "done" });
    expect(holderRan).toBe(true);
    expect(await lockExists()).toBe(false);
  });

  it("stops the heartbeat timer once fn completes (finally clears it before the unlink)", async () => {
    const clearIntervalSpy = vi.spyOn(global, "clearInterval");
    const outcome = await withProcessLock(lockPath, async () => "ok", 300);
    expect(outcome).toEqual({ kind: "ran", value: "ok" });
    expect(clearIntervalSpy).toHaveBeenCalled();
  });

  it("stops touching (and never unlinks) a FOREIGN lock once it detects it lost the lock mid-fn", async () => {
    const staleMs = 240;
    const beatMs = Math.floor(staleMs / 3);
    const holderPromise = withProcessLock(lockPath, async () => {
      // Let at least one heartbeat land with OUR nonce first.
      await new Promise((resolve) => setTimeout(resolve, beatMs + 30));
      // Simulate: our lock was stale-broken and re-acquired by another holder.
      await writeFile(lockPath, "foreign-holder-nonce", "utf8");
      const foreignMtimeBefore = (await stat(lockPath)).mtimeMs;
      // Wait past another heartbeat interval — our heartbeat must see the
      // foreign nonce and skip the touch rather than extending it.
      await new Promise((resolve) => setTimeout(resolve, beatMs + 60));
      const foreignMtimeAfter = (await stat(lockPath)).mtimeMs;
      expect(foreignMtimeAfter).toBe(foreignMtimeBefore);
      return "done";
    }, staleMs);

    const outcome = await holderPromise;
    expect(outcome).toEqual({ kind: "ran", value: "done" });
    // finally's own nonce-check refuses to unlink a lock it no longer owns.
    expect(await lockExists()).toBe(true);
    expect(await fsPromises.readFile(lockPath, "utf8")).toBe("foreign-holder-nonce");
  });
});
