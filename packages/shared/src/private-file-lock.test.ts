import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, readFile, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it, vi } from "vitest";

import { withPrivateFileLock } from "./private-file-lock.js";

const execFileAsync = promisify(execFile);

describe("withPrivateFileLock", () => {
  it("runs the operation and removes the privately-created direct lock file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "muse-private-lock-"));
    const lockFile = join(directory, "state.lock");

    const result = await withPrivateFileLock(lockFile, async () => {
      const stat = await lstat(lockFile);
      expect(stat.isFile()).toBe(true);
      expect(stat.mode & 0o777).toBe(0o600);
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
        await unlink(lockFile);
        await writeFile(lockFile, copiedNonce, { mode: 0o600 });
        await chmod(lockFile, 0o600);
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
            await unlink(lockFile);
            await writeFile(lockFile, "foreign-owner", { mode: 0o600 });
            await chmod(lockFile, 0o600);
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
