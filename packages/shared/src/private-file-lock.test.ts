import { execFile } from "node:child_process";
import { constants, promises as fs } from "node:fs";
import { chmod, link, lstat, mkdir, mkdtemp, readFile, rename, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it, vi } from "vitest";

import { withPrivateFileLock } from "./private-file-lock.js";

const execFileAsync = promisify(execFile);

async function replaceOpenLockPath(lockFile: string, contents: string): Promise<void> {
  if (process.platform === "win32") {
    await rename(lockFile, `${lockFile}.displaced`);
  } else {
    await unlink(lockFile);
  }
  await writeFile(lockFile, contents, { mode: 0o600 });
  await chmod(lockFile, 0o600);
}

describe("withPrivateFileLock", () => {
  it("runs the operation and removes the privately-created direct lock file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "muse-private-lock-"));
    const lockFile = join(directory, "state.lock");

    const result = await withPrivateFileLock(lockFile, async () => {
      const stat = await lstat(lockFile);
      expect(stat.isFile()).toBe(true);
      if (process.platform !== "win32") expect(stat.mode & 0o777).toBe(0o600);
      expect((await readFile(lockFile, "utf8")).length).toBeGreaterThan(0);
      return "complete";
    });

    expect(result).toBe("complete");
    await expect(lstat(lockFile)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("times out on a valid existing private lock without reclaiming it", async () => {
    const directory = await mkdtemp(join(tmpdir(), "muse-private-lock-contention-"));
    const lockFile = join(directory, "state.lock");
    await writeFile(lockFile, "other-owner", { mode: 0o600 });
    await chmod(lockFile, 0o600);
    let ran = false;

    await expect(
      withPrivateFileLock(
        lockFile,
        async () => {
          ran = true;
        },
        {
          giveUpMs: 1,
          retryDelayMs: () => 1
        }
      )
    ).rejects.toMatchObject({ code: "PRIVATE_FILE_LOCK_CONTENDED" });

    expect(ran).toBe(false);
    expect(await readFile(lockFile, "utf8")).toBe("other-owner");
  });

  it("reclaims only an exact private v1 lock owned by a dead process", async () => {
    const directory = await mkdtemp(join(tmpdir(), "muse-private-lock-dead-owner-"));
    const lockFile = join(directory, "state.lock");
    await writeFile(
      lockFile,
      "v1:2147483647:00000000-0000-4000-8000-000000000000",
      { mode: 0o600 }
    );

    await expect(withPrivateFileLock(
      lockFile,
      async () => "recovered",
      { reclaimDeadProcess: true }
    )).resolves.toBe("recovered");
    await expect(lstat(lockFile)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not reclaim a valid private v1 lock owned by a live process", async () => {
    const directory = await mkdtemp(join(tmpdir(), "muse-private-lock-live-owner-"));
    const lockFile = join(directory, "state.lock");
    const contents = `v1:${process.pid.toString()}:00000000-0000-4000-8000-000000000000`;
    await writeFile(lockFile, contents, { mode: 0o600 });

    await expect(withPrivateFileLock(
      lockFile,
      async () => undefined,
      { giveUpMs: 1, reclaimDeadProcess: true, retryDelayMs: () => 0 }
    )).rejects.toMatchObject({ code: "PRIVATE_FILE_LOCK_CONTENDED" });
    expect(await readFile(lockFile, "utf8")).toBe(contents);
  });

  it.each(["before-reclaim-open", "before-path-validation"] as const)(
    "retries when a live lock vanishes during normal turnover: %s",
    async (releasePhase) => {
      const directory = await mkdtemp(join(tmpdir(), "muse-private-lock-released-"));
      const lockFile = join(directory, "state.lock");
      const releasedPath = `${lockFile}.released`;
      const contents = `v1:${process.pid.toString()}:00000000-0000-4000-8000-000000000000`;
      await writeFile(lockFile, contents, { mode: 0o600 });
      const originalOpen = fs.open.bind(fs);
      const originalLstat = fs.lstat.bind(fs);
      let reclaimOpened = false;
      let released = false;
      const openSpy = vi.spyOn(fs, "open").mockImplementation(async (...args) => {
        const opensExistingLock = args[0] === lockFile
          && typeof args[1] === "number"
          && (args[1] & constants.O_CREAT) === 0;
        if (!released && releasePhase === "before-reclaim-open" && opensExistingLock) {
          released = true;
          await unlink(lockFile);
        }
        const opened = await originalOpen(...args);
        if (opensExistingLock) reclaimOpened = true;
        return opened;
      });
      const lstatSpy = vi.spyOn(fs, "lstat").mockImplementation(async (...args) => {
        if (!released && releasePhase === "before-path-validation" && reclaimOpened && args[0] === lockFile) {
          released = true;
          if (process.platform === "win32") await rename(lockFile, releasedPath);
          else await unlink(lockFile);
        }
        return originalLstat(...args);
      });

      try {
        await expect(withPrivateFileLock(
          lockFile,
          async () => "complete",
          { reclaimDeadProcess: true, retryDelayMs: () => 0 }
        )).resolves.toBe("complete");
        expect(released).toBe(true);
        await expect(lstat(lockFile)).rejects.toMatchObject({ code: "ENOENT" });
      } finally {
        lstatSpy.mockRestore();
        openSpy.mockRestore();
        await unlink(releasedPath).catch(() => undefined);
      }
    }
  );

  it("rejects a replacement opened after the probe even if its path then vanishes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "muse-private-lock-replacement-turnover-"));
    const lockFile = join(directory, "state.lock");
    const originalPath = `${lockFile}.original`;
    const releasedPath = `${lockFile}.released`;
    const contents = `v1:${process.pid.toString()}:00000000-0000-4000-8000-000000000000`;
    await writeFile(lockFile, contents, { mode: 0o600 });
    const originalOpen = fs.open.bind(fs);
    const originalLstat = fs.lstat.bind(fs);
    let reclaimOpened = false;
    let replacementMoved = false;
    let replaced = false;
    let ran = false;
    const openSpy = vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      const opensExistingLock = args[0] === lockFile
        && typeof args[1] === "number"
        && (args[1] & constants.O_CREAT) === 0;
      if (!replaced && opensExistingLock) {
        replaced = true;
        await rename(lockFile, originalPath);
        await writeFile(lockFile, "replacement-owner", { mode: 0o600 });
        await chmod(lockFile, 0o600);
      }
      const opened = await originalOpen(...args);
      if (opensExistingLock) reclaimOpened = true;
      return opened;
    });
    const lstatSpy = vi.spyOn(fs, "lstat").mockImplementation(async (...args) => {
      if (!replacementMoved && reclaimOpened && args[0] === lockFile) {
        replacementMoved = true;
        if (process.platform === "win32") await rename(lockFile, releasedPath);
        else await unlink(lockFile);
      }
      return originalLstat(...args);
    });

    try {
      await expect(withPrivateFileLock(
        lockFile,
        async () => {
          ran = true;
        },
        { reclaimDeadProcess: true, retryDelayMs: () => 0 }
      )).rejects.toMatchObject({ code: "PRIVATE_FILE_LOCK_UNSAFE" });
      expect(ran).toBe(false);
      expect(replacementMoved).toBe(false);
      expect(await readFile(lockFile, "utf8")).toBe("replacement-owner");
    } finally {
      lstatSpy.mockRestore();
      openSpy.mockRestore();
      await Promise.all([
        unlink(lockFile).catch(() => undefined),
        unlink(originalPath).catch(() => undefined),
        unlink(releasedPath).catch(() => undefined)
      ]);
    }
  });

  it("does not reclaim a malformed dead-owner nonce that only has UUID length", async () => {
    const directory = await mkdtemp(join(tmpdir(), "muse-private-lock-malformed-owner-"));
    const lockFile = join(directory, "state.lock");
    const contents = "v1:2147483647:------------------------------------";
    await writeFile(lockFile, contents, { mode: 0o600 });

    await expect(withPrivateFileLock(
      lockFile,
      async () => undefined,
      { giveUpMs: 1, reclaimDeadProcess: true, retryDelayMs: () => 0 }
    )).rejects.toMatchObject({ code: "PRIVATE_FILE_LOCK_CONTENDED" });
    expect(await readFile(lockFile, "utf8")).toBe(contents);
  });

  it.skipIf(process.platform === "win32")("rejects a hard-linked lock even when dead-owner reclaim is enabled", async () => {
    const directory = await mkdtemp(join(tmpdir(), "muse-private-lock-hardlink-"));
    const target = join(directory, "target");
    const lockFile = join(directory, "state.lock");
    const contents = "v1:2147483647:00000000-0000-4000-8000-000000000000";
    await writeFile(target, contents, { mode: 0o600 });
    await link(target, lockFile);

    await expect(withPrivateFileLock(
      lockFile,
      async () => undefined,
      { reclaimDeadProcess: true }
    )).rejects.toMatchObject({ code: "PRIVATE_FILE_LOCK_UNSAFE" });
    expect(await readFile(lockFile, "utf8")).toBe(contents);
    expect(await readFile(target, "utf8")).toBe(contents);
  });

  it.skipIf(process.platform === "win32")("rejects and preserves an existing symlink without exposing its path", async () => {
    const directory = await mkdtemp(join(tmpdir(), "muse-private-lock-symlink-"));
    const lockFile = join(directory, "state.lock");
    const target = join(directory, "target");
    await writeFile(target, "do-not-touch", { mode: 0o600 });
    await symlink(target, lockFile);

    const failure = await withPrivateFileLock(lockFile, async () => undefined).catch((cause: unknown) => cause);

    expect(failure).toMatchObject({ code: "PRIVATE_FILE_LOCK_UNSAFE" });
    expect(String(failure)).not.toContain(directory);
    expect((failure as Error).stack).not.toContain(directory);
    expect((await lstat(lockFile)).isSymbolicLink()).toBe(true);
    expect(await readFile(target, "utf8")).toBe("do-not-touch");
  });

  it("rejects and preserves a non-regular lock path", async () => {
    const directory = await mkdtemp(join(tmpdir(), "muse-private-lock-directory-"));
    const lockFile = join(directory, "state.lock");
    await mkdir(lockFile);

    await expect(withPrivateFileLock(lockFile, async () => undefined)).rejects.toMatchObject({
      code: "PRIVATE_FILE_LOCK_UNSAFE"
    });
    expect((await lstat(lockFile)).isDirectory()).toBe(true);
  });

  it.skipIf(process.platform === "win32")("rejects and preserves an existing lock with non-private mode", async () => {
    const directory = await mkdtemp(join(tmpdir(), "muse-private-lock-mode-"));
    const lockFile = join(directory, "state.lock");
    await writeFile(lockFile, "other-owner", { mode: 0o644 });
    await chmod(lockFile, 0o644);

    await expect(withPrivateFileLock(lockFile, async () => undefined)).rejects.toMatchObject({
      code: "PRIVATE_FILE_LOCK_UNSAFE"
    });
    expect((await lstat(lockFile)).mode & 0o777).toBe(0o644);
    expect(await readFile(lockFile, "utf8")).toBe("other-owner");
  });

  it("does not remove a replacement lock even when it copies the original nonce", async () => {
    const directory = await mkdtemp(join(tmpdir(), "muse-private-lock-replaced-"));
    const lockFile = join(directory, "state.lock");
    let copiedNonce = "";

    await expect(
      withPrivateFileLock(lockFile, async () => {
        copiedNonce = await readFile(lockFile, "utf8");
        await replaceOpenLockPath(lockFile, copiedNonce);
      })
    ).rejects.toMatchObject({ code: "PRIVATE_FILE_LOCK_OWNERSHIP_LOST" });

    expect(await readFile(lockFile, "utf8")).toBe(copiedNonce);
  });

  it("sanitizes lock filesystem failures so owner paths are not exposed", async () => {
    const directory = await mkdtemp(join(tmpdir(), "muse-private-lock-sanitized-"));
    const parentFile = join(directory, "not-a-directory");
    const lockFile = join(parentFile, "state.lock");
    await writeFile(parentFile, "occupied", { mode: 0o600 });

    const failure = await withPrivateFileLock(lockFile, async () => undefined).catch((cause: unknown) => cause);

    expect(failure).toMatchObject({ code: "PRIVATE_FILE_LOCK_UNSAFE" });
    expect(String(failure)).not.toContain(directory);
    expect((failure as Error).stack).not.toContain(directory);
  });

  it("removes its lock and preserves the operation error when the operation fails", async () => {
    const directory = await mkdtemp(join(tmpdir(), "muse-private-lock-operation-"));
    const lockFile = join(directory, "state.lock");
    const operationFailure = new Error("operation failed");

    await expect(
      withPrivateFileLock(lockFile, async () => {
        throw operationFailure;
      })
    ).rejects.toBe(operationFailure);
    await expect(lstat(lockFile)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("requires an existing private parent instead of creating it", async () => {
    const directory = await mkdtemp(join(tmpdir(), "muse-private-lock-parent-"));
    const missingParent = join(directory, "missing");
    const lockFile = join(missingParent, "state.lock");

    await expect(withPrivateFileLock(lockFile, async () => undefined)).rejects.toMatchObject({
      code: "PRIVATE_FILE_LOCK_UNSAFE"
    });
    await expect(lstat(missingParent)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.skipIf(process.platform === "win32")("rejects a pre-existing FIFO without opening or consuming it", async () => {
    const directory = await mkdtemp(join(tmpdir(), "muse-private-lock-fifo-"));
    const lockFile = join(directory, "state.lock");
    await execFileAsync("mkfifo", [lockFile]);
    await chmod(lockFile, 0o600);

    await expect(withPrivateFileLock(lockFile, async () => undefined)).rejects.toMatchObject({
      code: "PRIVATE_FILE_LOCK_UNSAFE"
    });
    expect((await lstat(lockFile)).isFIFO()).toBe(true);
  });

  it.skipIf(process.platform === "win32")("accepts an owner directory without group or world write bits", async () => {
    const directory = await mkdtemp(join(tmpdir(), "muse-private-lock-parent-mode-"));
    const lockFile = join(directory, "state.lock");
    await chmod(directory, 0o755);

    await expect(withPrivateFileLock(lockFile, async () => "complete")).resolves.toBe("complete");
    await expect(lstat(lockFile)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.skipIf(process.platform === "win32")("rejects a parent with group or world write bits", async () => {
    const directory = await mkdtemp(join(tmpdir(), "muse-private-lock-parent-writable-"));
    const lockFile = join(directory, "state.lock");
    await chmod(directory, 0o722);

    await expect(withPrivateFileLock(lockFile, async () => undefined)).rejects.toMatchObject({
      code: "PRIVATE_FILE_LOCK_UNSAFE"
    });
    await expect(lstat(lockFile)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("removes its own inode when path verification fails after writing the nonce", async () => {
    const directory = await mkdtemp(join(tmpdir(), "muse-private-lock-acquire-failure-"));
    const lockFile = join(directory, "state.lock");
    const originalLstat = fs.lstat.bind(fs);
    let injected = false;
    const lstatSpy = vi.spyOn(fs, "lstat").mockImplementation(async (...args) => {
      if (!injected && args[0] === lockFile) {
        injected = true;
        throw Object.assign(new Error("injected verification failure"), { code: "EIO" });
      }
      return originalLstat(...args);
    });

    try {
      await expect(withPrivateFileLock(lockFile, async () => undefined)).rejects.toMatchObject({
        code: "PRIVATE_FILE_LOCK_UNSAFE"
      });
      await expect(lstat(lockFile)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      lstatSpy.mockRestore();
    }
  });

  it("removes its own inode when nonce writing fails after a partial write", async () => {
    const directory = await mkdtemp(join(tmpdir(), "muse-private-lock-partial-write-"));
    const lockFile = join(directory, "state.lock");
    const originalOpen = fs.open.bind(fs);
    let injected = false;
    const openSpy = vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      const opened = await originalOpen(...args);
      if (!injected && args[0] === lockFile) {
        injected = true;
        Object.defineProperty(opened, "writeFile", {
          configurable: true,
          value: async (data: unknown) => {
            const bytes = data as Buffer;
            await opened.write(bytes.subarray(0, 3), 0, 3, 0);
            throw Object.assign(new Error("injected partial write"), { code: "EIO" });
          }
        });
      }
      return opened;
    });

    try {
      await expect(withPrivateFileLock(lockFile, async () => undefined)).rejects.toMatchObject({
        code: "PRIVATE_FILE_LOCK_UNSAFE"
      });
      await expect(lstat(lockFile)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      openSpy.mockRestore();
    }
  });

  it("preserves a foreign replacement when nonce writing fails after creation", async () => {
    const directory = await mkdtemp(join(tmpdir(), "muse-private-lock-partial-replaced-"));
    const lockFile = join(directory, "state.lock");
    const originalOpen = fs.open.bind(fs);
    let injected = false;
    const openSpy = vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      const opened = await originalOpen(...args);
      if (!injected && args[0] === lockFile) {
        injected = true;
        Object.defineProperty(opened, "writeFile", {
          configurable: true,
          value: async () => {
            await replaceOpenLockPath(lockFile, "foreign-owner");
            throw Object.assign(new Error("injected replacement"), { code: "EIO" });
          }
        });
      }
      return opened;
    });

    try {
      await expect(withPrivateFileLock(lockFile, async () => undefined)).rejects.toMatchObject({
        code: "PRIVATE_FILE_LOCK_UNSAFE"
      });
      expect(await readFile(lockFile, "utf8")).toBe("foreign-owner");
    } finally {
      openSpy.mockRestore();
    }
  });
});
