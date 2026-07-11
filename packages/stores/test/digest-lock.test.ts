import { randomUUID } from "node:crypto";
import { mkdtemp, rm, stat, utimes, writeFile } from "node:fs/promises";
import { promises as fsPromises } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DIGEST_LOCK_STALE_MS, withDigestLock } from "../src/digest-lock.js";

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
