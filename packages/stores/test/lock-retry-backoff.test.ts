import { randomUUID } from "node:crypto";
import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { computeLockRetryDelay, withFileLock } from "../src/encrypted-file.js";

describe("computeLockRetryDelay", () => {
  it("attempt 0 falls in the [12.5, 37.5) decorrelated-jitter range", () => {
    for (let i = 0; i < 500; i += 1) {
      const delay = computeLockRetryDelay(0);
      expect(delay).toBeGreaterThanOrEqual(12.5);
      expect(delay).toBeLessThan(37.5);
    }
  });

  it("grows in expectation across attempts before the cap", () => {
    const sampleAverage = (attempt: number, samples = 300): number => {
      let total = 0;
      for (let i = 0; i < samples; i += 1) {
        total += computeLockRetryDelay(attempt);
      }
      return total / samples;
    };
    const avg0 = sampleAverage(0);
    const avg1 = sampleAverage(1);
    const avg2 = sampleAverage(2);
    const avg3 = sampleAverage(3);
    expect(avg1).toBeGreaterThan(avg0);
    expect(avg2).toBeGreaterThan(avg1);
    expect(avg3).toBeGreaterThan(avg2);
  });

  it("never exceeds the cap widened by the maximum jitter factor (250ms * 1.5)", () => {
    for (const attempt of [4, 5, 8, 12, 20, 50]) {
      for (let i = 0; i < 200; i += 1) {
        expect(computeLockRetryDelay(attempt)).toBeLessThanOrEqual(250 * 1.5);
      }
    }
  });

  it("is always finite and non-negative, never NaN", () => {
    for (const attempt of [0, 1, 2, 3, 4, 10, 30, 100]) {
      const delay = computeLockRetryDelay(attempt);
      expect(Number.isNaN(delay)).toBe(false);
      expect(Number.isFinite(delay)).toBe(true);
      expect(delay).toBeGreaterThan(0);
    }
  });
});

describe("withFileLock — contended acquisition", () => {
  let dir: string;
  let targetFile: string;
  let lockPath: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), `muse-lock-backoff-${randomUUID()}-`));
    targetFile = join(dir, "store.json");
    lockPath = `${targetFile}.lock`;
  });

  afterEach(async () => {
    vi.useRealTimers();
    await rm(dir, { force: true, recursive: true });
  });

  it("acquires once a live holder releases within LOCK_GIVE_UP_MS (real fs, short hold)", async () => {
    await writeFile(lockPath, "external-holder", "utf8");
    const acquisition = withFileLock(targetFile, async () => "acquired");
    setTimeout(() => {
      void rm(lockPath, { force: true });
    }, 150);
    await expect(acquisition).resolves.toBe("acquired");
  }, 10_000);

  it("gives up with the documented error text once total wait exceeds LOCK_GIVE_UP_MS, even under rolling contention that never itself looks stale", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    try {
      await writeFile(lockPath, "rolling-holder", "utf8");
      const windowMs = 2_000;
      let virtualNow = 0;
      await utimes(lockPath, virtualNow / 1000, virtualNow / 1000);

      const acquisition = withFileLock(targetFile, async () => "unreachable");
      const rejection = expect(acquisition).rejects.toThrow(
        `${targetFile} is locked by another write in progress — retry shortly`
      );

      for (let window = 0; window < 20; window += 1) {
        // Advance a whole window while the lock's mtime stays pinned at the
        // START of the window — every probe inside sees an age <= windowMs
        // (well under LOCK_STALE_MS), so it never looks stale. THEN refresh
        // the mtime to "now" for the next window, simulating a rolling
        // holder that keeps the lock looking freshly-live forever while our
        // own elapsed wait keeps accumulating toward LOCK_GIVE_UP_MS.
        await vi.advanceTimersByTimeAsync(windowMs);
        virtualNow += windowMs;
        await utimes(lockPath, virtualNow / 1000, virtualNow / 1000);
      }

      await rejection;
    } finally {
      vi.useRealTimers();
    }
  }, 15_000);
});
