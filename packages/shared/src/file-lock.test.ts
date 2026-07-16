import { access, mkdtemp, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { withFileLock } from "./file-lock.js";

describe("withFileLock", () => {
  it("does not let a stale former holder remove a successor's lock", async () => {
    const dir = await mkdtemp(join(tmpdir(), "muse-file-lock-"));
    const file = join(dir, "state.json");
    const firstEntered = Promise.withResolvers<void>();
    const releaseFirst = Promise.withResolvers<void>();
    const secondEntered = Promise.withResolvers<void>();
    const releaseSecond = Promise.withResolvers<void>();
    try {
      const first = withFileLock(file, async () => {
        firstEntered.resolve();
        await releaseFirst.promise;
      });
      await firstEntered.promise;
      const lockPath = `${file}.lock`;
      const stale = new Date(Date.now() - 60_000);
      await utimes(lockPath, stale, stale);

      const second = withFileLock(file, async () => {
        secondEntered.resolve();
        await releaseSecond.promise;
      });
      await secondEntered.promise;
      releaseFirst.resolve();
      await first;

      await expect(access(lockPath)).resolves.toBeUndefined();
      releaseSecond.resolve();
      await second;
      await expect(access(lockPath)).rejects.toThrow();
    } finally {
      releaseFirst.resolve();
      releaseSecond.resolve();
    }
  });

  it("rejects non-positive timeout options before acquiring a lock", async () => {
    const file = join(await mkdtemp(join(tmpdir(), "muse-file-lock-options-")), "state.json");
    await expect(withFileLock(file, async () => undefined, { giveUpMs: 0 })).rejects.toThrow(RangeError);
    await expect(withFileLock(file, async () => undefined, { staleMs: Number.NaN })).rejects.toThrow(RangeError);
  });
});
