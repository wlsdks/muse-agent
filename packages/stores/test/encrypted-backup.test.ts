import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { encryptMemoryEnvelope } from "@muse/memory";

import {
  createEncryptedFileBackup,
  restoreEncryptedFileBackup,
  verifyEncryptedFileBackup
} from "../src/index.js";

const ENV = { MUSE_MEMORY_KEY: "backup-test-key" };
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

async function fixture(): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "muse-encrypted-backup-")));
  roots.push(root);
  return root;
}

async function writeEncryptedManifestBackup(
  backupFile: string,
  inner: unknown,
  outerExtra?: Record<string, unknown>
): Promise<void> {
  await writeFile(backupFile, JSON.stringify({
    format: "muse-encrypted-file-backup",
    manifest: encryptMemoryEnvelope(JSON.stringify(inner), ENV),
    version: 1,
    ...outerExtra
  }), { mode: 0o600 });
}

describe("one-file encrypted backup", () => {
  it("creates, verifies, and restores exact bytes owner-only without changing the source", async () => {
    const root = await fixture();
    const sourceFile = join(root, "source.bin");
    const backupFile = join(root, "backup.muse-backup");
    const targetDirectory = join(root, "restore");
    const sourceBytes = Buffer.from([0, 1, 2, 3, 255, 10, 42]);
    await writeFile(sourceFile, sourceBytes);
    await chmod(sourceFile, 0o640);

    const created = await createEncryptedFileBackup({
      backupFile,
      entryName: "state/source.bin",
      env: ENV,
      sourceFile
    });
    const verified = await verifyEncryptedFileBackup({ backupFile, env: ENV });
    const restored = await restoreEncryptedFileBackup({ backupFile, env: ENV, targetDirectory });

    expect(created).toEqual(verified);
    expect(restored).toEqual(verified);
    expect(verified).toMatchObject({
      byteSize: sourceBytes.byteLength,
      entryName: "state/source.bin",
      sha256: expect.stringMatching(/^[0-9a-f]{64}$/u)
    });
    expect(await readFile(join(targetDirectory, "state", "source.bin"))).toEqual(sourceBytes);
    expect((await stat(backupFile)).mode & 0o777).toBe(0o600);
    expect((await stat(join(targetDirectory, "state", "source.bin"))).mode & 0o777).toBe(0o600);
    expect(await readFile(sourceFile)).toEqual(sourceBytes);
    expect((await stat(sourceFile)).mode & 0o777).toBe(0o640);
    expect(await readFile(backupFile, "utf8")).not.toContain(sourceBytes.toString("base64"));
  });

  it("publishes exactly one winner when concurrent creators target the same absent backup", async () => {
    const root = await fixture();
    const firstSource = join(root, "first.txt");
    const secondSource = join(root, "second.txt");
    const backupFile = join(root, "backup.muse-backup");
    await writeFile(firstSource, "FIRST");
    await writeFile(secondSource, "SECOND");

    const attempts = await Promise.allSettled([
      createEncryptedFileBackup({
        backupFile,
        entryName: "source.txt",
        env: ENV,
        sourceFile: firstSource
      }),
      createEncryptedFileBackup({
        backupFile,
        entryName: "source.txt",
        env: ENV,
        sourceFile: secondSource
      })
    ]);
    const winners = attempts.filter((attempt): attempt is PromiseFulfilledResult<Awaited<ReturnType<typeof createEncryptedFileBackup>>> =>
      attempt.status === "fulfilled"
    );
    const losers = attempts.filter((attempt): attempt is PromiseRejectedResult => attempt.status === "rejected");

    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect(losers[0]!.reason).toMatchObject({ code: "BACKUP_EXISTS" });
    expect(await verifyEncryptedFileBackup({ backupFile, env: ENV })).toEqual(winners[0]!.value);
  });

  it("rejects a symlink in the backup destination ancestry without writing through it", async () => {
    const root = await fixture();
    const sourceFile = join(root, "source.json");
    const realDirectory = join(root, "real");
    const linkedDirectory = join(root, "linked");
    await writeFile(sourceFile, "PRIVATE_SOURCE");
    await mkdir(realDirectory);
    await symlink(realDirectory, linkedDirectory, "dir");

    await expect(createEncryptedFileBackup({
      backupFile: join(linkedDirectory, "backup.muse-backup"),
      entryName: "source.json",
      env: ENV,
      sourceFile
    })).rejects.toMatchObject({ code: "BACKUP_DESTINATION_UNSAFE" });
    await expect(readFile(join(realDirectory, "backup.muse-backup"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a symlink in the restore target ancestry without writing through it", async () => {
    const root = await fixture();
    const sourceFile = join(root, "source.json");
    const backupFile = join(root, "backup.muse-backup");
    const realDirectory = join(root, "real");
    const linkedDirectory = join(root, "linked");
    await writeFile(sourceFile, "PRIVATE_SOURCE");
    await mkdir(realDirectory);
    await symlink(realDirectory, linkedDirectory, "dir");
    await createEncryptedFileBackup({
      backupFile,
      entryName: "source.json",
      env: ENV,
      sourceFile
    });

    await expect(restoreEncryptedFileBackup({
      backupFile,
      env: ENV,
      targetDirectory: join(linkedDirectory, "restore")
    })).rejects.toMatchObject({ code: "RESTORE_TARGET_UNSAFE" });
    await expect(readFile(join(realDirectory, "restore", "source.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects symlink ancestry for source and backup input paths", async () => {
    const root = await fixture();
    const realDirectory = join(root, "real");
    const linkedDirectory = join(root, "linked");
    const sourceFile = join(realDirectory, "source.json");
    const backupFile = join(realDirectory, "backup.muse-backup");
    await mkdir(realDirectory);
    await writeFile(sourceFile, "PRIVATE_SOURCE");
    await symlink(realDirectory, linkedDirectory, "dir");

    await expect(createEncryptedFileBackup({
      backupFile,
      entryName: "source.json",
      env: ENV,
      sourceFile: join(linkedDirectory, "source.json")
    })).rejects.toMatchObject({ code: "SOURCE_UNSAFE" });
    await expect(stat(backupFile)).rejects.toMatchObject({ code: "ENOENT" });

    await createEncryptedFileBackup({
      backupFile,
      entryName: "source.json",
      env: ENV,
      sourceFile
    });
    await expect(verifyEncryptedFileBackup({
      backupFile: join(linkedDirectory, "backup.muse-backup"),
      env: ENV
    })).rejects.toMatchObject({ code: "BACKUP_UNSAFE" });
  });

  it("strictly rejects unsupported, unsafe, or inconsistent manifests before target mutation", async () => {
    const root = await fixture();
    const secret = Buffer.from("TOP_SECRET_BYTES");
    const validEntry = {
      byteSize: secret.byteLength,
      dataBase64: secret.toString("base64"),
      name: "state/source.bin",
      sha256: "c3c02b8d0242cd21bb5c330177e72f68fe46c8eb0522a3fde11d8cbc901a0eeb"
    };
    const cases: Array<{ inner: unknown; name: string; outerExtra?: Record<string, unknown> }> = [
      {
        inner: { entry: validEntry, format: "muse-encrypted-file-backup-manifest", version: 2 },
        name: "unknown-inner-version"
      },
      {
        inner: {
          entry: { ...validEntry, name: "../escaped.bin" },
          format: "muse-encrypted-file-backup-manifest",
          version: 1
        },
        name: "path-escape"
      },
      {
        inner: {
          entry: validEntry,
          extra: true,
          format: "muse-encrypted-file-backup-manifest",
          version: 1
        },
        name: "unexpected-inner-field"
      },
      {
        inner: {
          entry: { ...validEntry, extra: true },
          format: "muse-encrypted-file-backup-manifest",
          version: 1
        },
        name: "unexpected-entry-field"
      },
      {
        inner: { entry: validEntry, format: "muse-encrypted-file-backup-manifest", version: 1 },
        name: "unexpected-outer-field",
        outerExtra: { extra: true }
      }
    ];

    for (const testCase of cases) {
      const backupFile = join(root, `${testCase.name}.muse-backup`);
      const targetDirectory = join(root, `${testCase.name}-restore`);
      await writeEncryptedManifestBackup(backupFile, testCase.inner, testCase.outerExtra);
      let error: unknown;
      try {
        await restoreEncryptedFileBackup({ backupFile, env: ENV, targetDirectory });
      } catch (cause) {
        error = cause;
      }
      expect(error, testCase.name).toBeInstanceOf(Error);
      expect(String(error), testCase.name).not.toContain(secret.toString());
      await expect(stat(targetDirectory), testCase.name).rejects.toMatchObject({ code: "ENOENT" });
    }
  });

  it("fails closed on wrong keys and authenticated-envelope tampering without exposing sensitive values", async () => {
    const root = await fixture();
    const sourceFile = join(root, "source.txt");
    const backupFile = join(root, "backup.muse-backup");
    const secret = "TOP_SECRET_BYTES";
    await writeFile(sourceFile, secret);
    await createEncryptedFileBackup({ backupFile, entryName: "source.txt", env: ENV, sourceFile });

    const wrongKeyTarget = join(root, "wrong-key-restore");
    await expect(restoreEncryptedFileBackup({
      backupFile,
      env: { MUSE_MEMORY_KEY: "wrong-key" },
      targetDirectory: wrongKeyTarget
    })).rejects.toMatchObject({
      code: "BACKUP_DECRYPT_FAILED",
      message: expect.not.stringContaining(secret)
    });
    await expect(stat(wrongKeyTarget)).rejects.toMatchObject({ code: "ENOENT" });

    const outer = JSON.parse(await readFile(backupFile, "utf8")) as {
      manifest: { data: string };
    };
    outer.manifest.data = `${outer.manifest.data.startsWith("A") ? "B" : "A"}${outer.manifest.data.slice(1)}`;
    await writeFile(backupFile, JSON.stringify(outer), { mode: 0o600 });
    const tamperedTarget = join(root, "tampered-restore");
    await expect(restoreEncryptedFileBackup({
      backupFile,
      env: ENV,
      targetDirectory: tamperedTarget
    })).rejects.toMatchObject({
      code: "BACKUP_DECRYPT_FAILED",
      message: expect.not.stringContaining(ENV.MUSE_MEMORY_KEY)
    });
    await expect(stat(tamperedTarget)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects unexpected encrypted-envelope fields before decrypting", async () => {
    const root = await fixture();
    const sourceFile = join(root, "source.txt");
    const backupFile = join(root, "backup.muse-backup");
    await writeFile(sourceFile, "PRIVATE_SOURCE");
    await createEncryptedFileBackup({ backupFile, entryName: "source.txt", env: ENV, sourceFile });
    const outer = JSON.parse(await readFile(backupFile, "utf8")) as {
      manifest: Record<string, unknown>;
    };
    outer.manifest.extra = true;
    await writeFile(backupFile, JSON.stringify(outer), { mode: 0o600 });

    await expect(verifyEncryptedFileBackup({ backupFile, env: ENV }))
      .rejects.toMatchObject({ code: "BACKUP_VERSION_UNSUPPORTED" });
  });

  it("refuses to merge into or overwrite a non-empty restore target", async () => {
    const root = await fixture();
    const sourceFile = join(root, "source.txt");
    const backupFile = join(root, "backup.muse-backup");
    const targetDirectory = join(root, "restore");
    const sentinelFile = join(targetDirectory, "keep.txt");
    await writeFile(sourceFile, "SOURCE");
    await createEncryptedFileBackup({ backupFile, entryName: "source.txt", env: ENV, sourceFile });
    await mkdir(targetDirectory);
    await writeFile(sentinelFile, "KEEP");

    await expect(restoreEncryptedFileBackup({
      backupFile,
      env: ENV,
      targetDirectory
    })).rejects.toMatchObject({ code: "RESTORE_TARGET_NOT_EMPTY" });
    expect(await readFile(sentinelFile, "utf8")).toBe("KEEP");
    await expect(stat(join(targetDirectory, "source.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
