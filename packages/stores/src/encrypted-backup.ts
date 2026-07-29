import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { dirname, isAbsolute, join, parse, posix, relative, resolve, sep, win32 } from "node:path";

import {
  decryptMemoryEnvelope,
  encryptMemoryEnvelope,
  isEncryptedMemoryEnvelope,
  type EncryptedMemoryEnvelope
} from "@muse/memory";

import { atomicWriteFile } from "./atomic-file-store.js";

const OUTER_FORMAT = "muse-encrypted-file-backup";
const INNER_FORMAT = "muse-encrypted-file-backup-manifest";
const BACKUP_VERSION = 1;

interface EncryptedBackupOuter {
  readonly format: typeof OUTER_FORMAT;
  readonly manifest: EncryptedMemoryEnvelope;
  readonly version: typeof BACKUP_VERSION;
}

interface EncryptedBackupInner {
  readonly entry: {
    readonly byteSize: number;
    readonly dataBase64: string;
    readonly name: string;
    readonly sha256: string;
  };
  readonly format: typeof INNER_FORMAT;
  readonly version: typeof BACKUP_VERSION;
}

export interface EncryptedFileBackupSummary {
  readonly byteSize: number;
  readonly entryName: string;
  readonly sha256: string;
}

export interface CreateEncryptedFileBackupOptions {
  readonly backupFile: string;
  readonly entryName: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly sourceFile: string;
}

export interface VerifyEncryptedFileBackupOptions {
  readonly backupFile: string;
  readonly env?: NodeJS.ProcessEnv;
}

export interface RestoreEncryptedFileBackupOptions extends VerifyEncryptedFileBackupOptions {
  readonly targetDirectory: string;
}

export class EncryptedFileBackupError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "EncryptedFileBackupError";
    this.code = code;
  }
}

export async function createEncryptedFileBackup(
  options: CreateEncryptedFileBackupOptions
): Promise<EncryptedFileBackupSummary> {
  assertSafeEntryName(options.entryName);
  await assertNoSymlinkInExistingAncestry(options.sourceFile, "SOURCE_UNSAFE");
  await assertRegularFile(options.sourceFile, "SOURCE_UNSAFE");
  await assertNoSymlinkInExistingAncestry(options.backupFile, "BACKUP_DESTINATION_UNSAFE");
  await assertAbsent(options.backupFile, "BACKUP_EXISTS");
  const bytes = await fs.readFile(options.sourceFile);
  const sha256 = digest(bytes);
  const inner: EncryptedBackupInner = {
    entry: {
      byteSize: bytes.byteLength,
      dataBase64: bytes.toString("base64"),
      name: options.entryName,
      sha256
    },
    format: INNER_FORMAT,
    version: BACKUP_VERSION
  };
  const outer: EncryptedBackupOuter = {
    format: OUTER_FORMAT,
    manifest: encryptMemoryEnvelope(JSON.stringify(inner), options.env),
    version: BACKUP_VERSION
  };
  await publishBackupNoReplace(options.backupFile, `${JSON.stringify(outer)}\n`);
  return { byteSize: bytes.byteLength, entryName: options.entryName, sha256 };
}

export async function verifyEncryptedFileBackup(
  options: VerifyEncryptedFileBackupOptions
): Promise<EncryptedFileBackupSummary> {
  const { inner } = await readVerifiedBackup(options);
  return summary(inner);
}

export async function restoreEncryptedFileBackup(
  options: RestoreEncryptedFileBackupOptions
): Promise<EncryptedFileBackupSummary> {
  const { bytes, inner } = await readVerifiedBackup(options);
  await assertNoSymlinkInExistingAncestry(options.targetDirectory, "RESTORE_TARGET_UNSAFE");
  await prepareEmptyTargetDirectory(options.targetDirectory);
  const targetFile = join(options.targetDirectory, ...inner.entry.name.split("/"));
  await fs.mkdir(dirname(targetFile), { mode: 0o700, recursive: true });
  await atomicWriteFile(targetFile, bytes, { mode: 0o600 });
  return summary(inner);
}

async function readVerifiedBackup(
  options: VerifyEncryptedFileBackupOptions
): Promise<{ readonly bytes: Buffer; readonly inner: EncryptedBackupInner }> {
  await assertNoSymlinkInExistingAncestry(options.backupFile, "BACKUP_UNSAFE");
  await assertRegularFile(options.backupFile, "BACKUP_UNSAFE");
  let parsed: unknown;
  try {
    parsed = JSON.parse(await fs.readFile(options.backupFile, "utf8"));
  } catch {
    throw failure("BACKUP_INVALID", "Encrypted backup is invalid or unreadable.");
  }
  if (!isOuter(parsed)) throw failure("BACKUP_VERSION_UNSUPPORTED", "Encrypted backup format is unsupported.");
  let innerValue: unknown;
  try {
    innerValue = JSON.parse(decryptMemoryEnvelope(parsed.manifest, options.env));
  } catch {
    throw failure("BACKUP_DECRYPT_FAILED", "Encrypted backup could not be authenticated.");
  }
  if (!isInner(innerValue)) throw failure("MANIFEST_INVALID", "Encrypted backup manifest is invalid.");
  assertSafeEntryName(innerValue.entry.name);
  const bytes = decodeBase64(innerValue.entry.dataBase64);
  if (bytes.byteLength !== innerValue.entry.byteSize || digest(bytes) !== innerValue.entry.sha256) {
    throw failure("BACKUP_INTEGRITY_FAILED", "Encrypted backup integrity verification failed.");
  }
  return { bytes, inner: innerValue };
}

function isOuter(value: unknown): value is EncryptedBackupOuter {
  if (!isRecord(value)) return false;
  return hasExactKeys(value, ["format", "manifest", "version"])
    && value.format === OUTER_FORMAT
    && value.version === BACKUP_VERSION
    && isRecord(value.manifest)
    && hasExactKeys(value.manifest, ["algorithm", "data", "iv", "salt", "tag", "version"])
    && isEncryptedMemoryEnvelope(value.manifest);
}

function isInner(value: unknown): value is EncryptedBackupInner {
  if (
    !isRecord(value)
    || !hasExactKeys(value, ["entry", "format", "version"])
    || value.format !== INNER_FORMAT
    || value.version !== BACKUP_VERSION
  ) return false;
  if (
    !isRecord(value.entry)
    || !hasExactKeys(value.entry, ["byteSize", "dataBase64", "name", "sha256"])
  ) return false;
  return typeof value.entry.name === "string"
    && typeof value.entry.dataBase64 === "string"
    && Number.isSafeInteger(value.entry.byteSize)
    && (value.entry.byteSize as number) >= 0
    && typeof value.entry.sha256 === "string"
    && /^[0-9a-f]{64}$/u.test(value.entry.sha256);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return actual.length === sortedExpected.length
    && actual.every((key, index) => key === sortedExpected[index]);
}

function decodeBase64(value: string): Buffer {
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value) {
    throw failure("MANIFEST_INVALID", "Encrypted backup manifest is invalid.");
  }
  return bytes;
}

function assertSafeEntryName(name: string): void {
  if (
    name.length === 0
    || name.includes("\\")
    || name.includes("\0")
    || isAbsolute(name)
    || win32.isAbsolute(name)
    || posix.normalize(name) !== name
    || name.split("/").some((part) => part.length === 0 || part === "." || part === "..")
  ) {
    throw failure("ENTRY_NAME_UNSAFE", "Encrypted backup entry name is unsafe.");
  }
}

async function assertRegularFile(file: string, code: string): Promise<void> {
  try {
    const metadata = await fs.lstat(file);
    if (!metadata.isFile() || metadata.isSymbolicLink()) throw failure(code, "Encrypted backup file boundary is unsafe.");
  } catch (cause) {
    if (cause instanceof EncryptedFileBackupError) throw cause;
    throw failure(code, "Encrypted backup file boundary is unsafe.");
  }
}

async function assertAbsent(file: string, code: string): Promise<void> {
  try {
    await fs.lstat(file);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return;
    throw failure(code, "Encrypted backup destination is unsafe.");
  }
  throw failure(code, "Encrypted backup destination already exists.");
}

/**
 * Publish a fully-written candidate without ever replacing an existing backup.
 * `link` is the atomic no-replace boundary: exactly one concurrent creator can
 * claim the destination, while every loser receives EEXIST and removes only
 * its own candidate.
 */
async function publishBackupNoReplace(file: string, contents: string): Promise<void> {
  const candidate = `${file}.candidate-${process.pid.toString()}-${randomUUID()}`;
  try {
    await atomicWriteFile(candidate, contents, { mode: 0o600 });
    try {
      await fs.link(candidate, file);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "EEXIST") {
        throw failure("BACKUP_EXISTS", "Encrypted backup destination already exists.");
      }
      throw cause;
    }
    await fs.chmod(file, 0o600).catch(() => undefined);
  } finally {
    await fs.rm(candidate, { force: true }).catch(() => undefined);
  }
}

async function assertNoSymlinkInExistingAncestry(file: string, code: string): Promise<void> {
  const absoluteParent = dirname(resolve(file));
  const root = parse(absoluteParent).root;
  const segments = relative(root, absoluteParent).split(sep).filter(Boolean);
  let current = root;
  for (const segment of segments) {
    current = join(current, segment);
    try {
      const metadata = await fs.lstat(current);
      if (metadata.isSymbolicLink()) {
        throw failure(code, "Encrypted backup path ancestry is unsafe.");
      }
    } catch (cause) {
      if (cause instanceof EncryptedFileBackupError) throw cause;
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") return;
      throw failure(code, "Encrypted backup path ancestry is unsafe.");
    }
  }
}

async function prepareEmptyTargetDirectory(targetDirectory: string): Promise<void> {
  try {
    const metadata = await fs.lstat(targetDirectory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw failure("RESTORE_TARGET_UNSAFE", "Restore target is unsafe.");
    }
    if ((await fs.readdir(targetDirectory)).length > 0) {
      throw failure("RESTORE_TARGET_NOT_EMPTY", "Restore target must be empty.");
    }
  } catch (cause) {
    if (cause instanceof EncryptedFileBackupError) throw cause;
    if ((cause as NodeJS.ErrnoException).code !== "ENOENT") {
      throw failure("RESTORE_TARGET_UNSAFE", "Restore target is unsafe.");
    }
    await fs.mkdir(targetDirectory, { mode: 0o700 });
  }
}

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function summary(inner: EncryptedBackupInner): EncryptedFileBackupSummary {
  return {
    byteSize: inner.entry.byteSize,
    entryName: inner.entry.name,
    sha256: inner.entry.sha256
  };
}

function failure(code: string, message: string): EncryptedFileBackupError {
  return new EncryptedFileBackupError(code, message);
}
