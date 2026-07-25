import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, rm } from "node:fs/promises";
import { join } from "node:path";

import { atomicWriteFile } from "@muse/stores";

export const RESIDENT_DAEMON_INSTALL_RECEIPT_SCHEMA = "muse.daemon-install-receipt/v1";

export type ResidentDaemonInstallPhase =
  | "prepared"
  | "verified"
  | "rolled-back"
  | "rollback-failed";

export interface ResidentDaemonInstallReceipt {
  readonly artifactDigest: string;
  readonly artifactFile: string;
  readonly backupFile: string | null;
  readonly phase: ResidentDaemonInstallPhase;
  readonly previousDigest: string | null;
  readonly productVersion: string;
  readonly sequence: number;
  readonly updatedAt: string;
  readonly version: typeof RESIDENT_DAEMON_INSTALL_RECEIPT_SCHEMA;
}

export interface ResidentDaemonInstallTransactionResult {
  readonly changed: boolean;
  readonly ok: boolean;
  readonly reason?:
    | "receipt-invalid"
    | "downgrade-refused"
    | "backup-invalid"
    | "artifact-drift"
    | "activation-failed"
    | "rollback-failed"
    | "persistence-failed";
  readonly receipt?: ResidentDaemonInstallReceipt;
  readonly rolledBack?: boolean;
}

interface InstallStateFiles {
  readonly backupDir: string;
  readonly receiptFile: string;
}

export interface ResidentDaemonInstallTransactionOptions {
  readonly activate: () => Promise<boolean>;
  readonly artifactFile: string;
  readonly deactivate: () => Promise<void>;
  readonly desiredArtifact: string;
  readonly files: InstallStateFiles;
  readonly now?: () => Date;
  readonly productVersion: string;
  readonly readArtifact?: (file: string) => Promise<string | undefined>;
  readonly readPrivate?: (file: string) => Promise<string | undefined>;
  readonly removeArtifact?: (file: string) => Promise<void>;
  readonly writePrivate?: (file: string, contents: string) => Promise<void>;
}

function digest(contents: string): string {
  return createHash("sha256").update(contents).digest("hex");
}

function exactKeys(row: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(row).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
}

function canonicalInstant(value: unknown): value is string {
  return typeof value === "string"
    && Number.isFinite(Date.parse(value))
    && new Date(Date.parse(value)).toISOString() === value;
}

function digestValue(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/u.test(value);
}

function absolutePath(value: unknown): value is string {
  return typeof value === "string" && value.startsWith("/") && !value.includes("\0");
}

function productVersion(value: unknown): value is string {
  const identifier = "(?:0|[1-9]\\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)";
  return typeof value === "string"
    && new RegExp(
      `^(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)(?:-${identifier}(?:\\.${identifier})*)?$`,
      "u"
    ).test(value);
}

export function parseResidentDaemonInstallReceipt(
  text: string
): ResidentDaemonInstallReceipt | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    const row = parsed as Record<string, unknown>;
    if (!exactKeys(row, [
      "artifactDigest",
      "artifactFile",
      "backupFile",
      "phase",
      "previousDigest",
      "productVersion",
      "sequence",
      "updatedAt",
      "version"
    ])) return undefined;
    if (
      row.version !== RESIDENT_DAEMON_INSTALL_RECEIPT_SCHEMA
      || !digestValue(row.artifactDigest)
      || !absolutePath(row.artifactFile)
      || (row.backupFile !== null && !absolutePath(row.backupFile))
      || (
        row.phase !== "prepared"
        && row.phase !== "verified"
        && row.phase !== "rolled-back"
        && row.phase !== "rollback-failed"
      )
      || (row.previousDigest !== null && !digestValue(row.previousDigest))
      || !productVersion(row.productVersion)
      || !Number.isSafeInteger(row.sequence)
      || (row.sequence as number) <= 0
      || !canonicalInstant(row.updatedAt)
      || ((row.backupFile === null) !== (row.previousDigest === null))
    ) return undefined;
    return row as unknown as ResidentDaemonInstallReceipt;
  } catch {
    return undefined;
  }
}

function compareVersions(left: string, right: string): number {
  const parse = (value: string) => {
    const prereleaseAt = value.indexOf("-");
    const core = prereleaseAt === -1 ? value : value.slice(0, prereleaseAt);
    const prerelease = prereleaseAt === -1 ? undefined : value.slice(prereleaseAt + 1);
    return {
      core: core.split("."),
      prerelease: prerelease?.split(".")
    };
  };
  const compareNumeric = (leftPart: string, rightPart: string): number => {
    if (leftPart.length !== rightPart.length) return leftPart.length - rightPart.length;
    if (leftPart === rightPart) return 0;
    return leftPart < rightPart ? -1 : 1;
  };
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < 3; index += 1) {
    const delta = compareNumeric(
      a.core[index] ?? "0",
      b.core[index] ?? "0"
    );
    if (delta !== 0) return delta;
  }
  if (!a.prerelease && !b.prerelease) return 0;
  if (!a.prerelease) return 1;
  if (!b.prerelease) return -1;
  const width = Math.max(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < width; index += 1) {
    const leftPart = a.prerelease[index];
    const rightPart = b.prerelease[index];
    if (leftPart === undefined) return -1;
    if (rightPart === undefined) return 1;
    if (leftPart === rightPart) continue;
    const leftNumeric = /^\d+$/u.test(leftPart);
    const rightNumeric = /^\d+$/u.test(rightPart);
    if (leftNumeric && rightNumeric) return compareNumeric(leftPart, rightPart);
    if (leftNumeric) return -1;
    if (rightNumeric) return 1;
    return leftPart < rightPart ? -1 : 1;
  }
  return 0;
}

async function readRegularFileNoFollow(
  file: string,
  privacy: "artifact" | "owner-only"
): Promise<string | undefined> {
  let handle;
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`${privacy} state is not a regular file`);
    }
    if (process.platform !== "win32") {
      if (typeof process.getuid !== "function" || stat.uid !== process.getuid()) {
        throw new Error(`${privacy} state is not owned by the current user`);
      }
      if (privacy === "owner-only" && (stat.mode & 0o077) !== 0) {
        throw new Error("private state permissions are not owner-only");
      }
      if (privacy === "artifact" && (stat.mode & 0o022) !== 0) {
        throw new Error("artifact state is writable by another principal");
      }
    }
    return await handle.readFile("utf8");
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw cause;
  } finally {
    await handle?.close();
  }
}

async function defaultReadArtifact(file: string): Promise<string | undefined> {
  return readRegularFileNoFollow(file, "artifact");
}

async function defaultReadPrivate(file: string): Promise<string | undefined> {
  return readRegularFileNoFollow(file, "owner-only");
}

async function defaultWritePrivate(file: string, contents: string): Promise<void> {
  await atomicWriteFile(file, contents, { mode: 0o600 });
}

export function resolveResidentDaemonInstallStateFiles(
  env: Readonly<Record<string, string | undefined>>
): InstallStateFiles {
  const home = env.HOME?.trim();
  if (!home || !home.startsWith("/") || home.includes("\0")) {
    throw new Error("resident install state requires an absolute owner HOME");
  }
  const root = join(home, ".muse", "daemon-install");
  return {
    backupDir: join(root, "backups"),
    receiptFile: join(root, "receipt.json")
  };
}

function receipt(input: {
  readonly artifactDigest: string;
  readonly artifactFile: string;
  readonly backupFile: string | null;
  readonly now: Date;
  readonly phase: ResidentDaemonInstallPhase;
  readonly previousDigest: string | null;
  readonly productVersion: string;
  readonly sequence: number;
}): ResidentDaemonInstallReceipt {
  const value: ResidentDaemonInstallReceipt = {
    artifactDigest: input.artifactDigest,
    artifactFile: input.artifactFile,
    backupFile: input.backupFile,
    phase: input.phase,
    previousDigest: input.previousDigest,
    productVersion: input.productVersion,
    sequence: input.sequence,
    updatedAt: input.now.toISOString(),
    version: RESIDENT_DAEMON_INSTALL_RECEIPT_SCHEMA
  };
  if (!parseResidentDaemonInstallReceipt(JSON.stringify(value))) {
    throw new TypeError("invalid resident daemon install receipt");
  }
  return value;
}

function validBackupReference(
  value: ResidentDaemonInstallReceipt,
  files: InstallStateFiles
): boolean {
  if (value.backupFile === null || value.previousDigest === null) {
    return value.backupFile === null && value.previousDigest === null;
  }
  return value.backupFile === join(files.backupDir, `${value.previousDigest}.artifact`);
}

export async function applyResidentDaemonInstallTransaction(
  options: ResidentDaemonInstallTransactionOptions
): Promise<ResidentDaemonInstallTransactionResult> {
  const readArtifact = options.readArtifact ?? defaultReadArtifact;
  const readPrivate = options.readPrivate ?? defaultReadPrivate;
  const writePrivate = options.writePrivate ?? defaultWritePrivate;
  const removeArtifact = options.removeArtifact ?? (async (file) => {
    await rm(file, { force: true });
  });
  const now = options.now ?? (() => new Date());
  const desiredDigest = digest(options.desiredArtifact);
  let previousReceipt: ResidentDaemonInstallReceipt | undefined;
  let changed = false;
  const rollbackPrepared = async (
    prepared: ResidentDaemonInstallReceipt
  ): Promise<ResidentDaemonInstallTransactionResult> => {
    changed = true;
    let rollbackOk = false;
    try {
      await options.deactivate();
      if (prepared.backupFile && prepared.previousDigest) {
        let backup: string | undefined;
        try {
          backup = await readPrivate(prepared.backupFile);
        } catch {
          backup = undefined;
        }
        if (backup !== undefined && digest(backup) === prepared.previousDigest) {
          await writePrivate(options.artifactFile, backup);
          rollbackOk = await options.activate();
        }
      } else {
        await removeArtifact(options.artifactFile);
        rollbackOk = true;
      }
    } catch {
      rollbackOk = false;
    }
    const rolledBack = receipt({
      ...prepared,
      now: now(),
      phase: rollbackOk ? "rolled-back" : "rollback-failed",
      sequence: prepared.sequence + 1
    });
    await writePrivate(options.files.receiptFile, `${JSON.stringify(rolledBack)}\n`);
    return rollbackOk
      ? { changed: true, ok: false, reason: "activation-failed", receipt: rolledBack, rolledBack: true }
      : { changed: true, ok: false, reason: "rollback-failed", receipt: rolledBack, rolledBack: false };
  };
  try {
    let receiptText: string | undefined;
    try {
      receiptText = await readPrivate(options.files.receiptFile);
    } catch {
      return { changed: false, ok: false, reason: "receipt-invalid" };
    }
    if (receiptText !== undefined) {
      previousReceipt = parseResidentDaemonInstallReceipt(receiptText);
      if (
        !previousReceipt
        || previousReceipt.artifactFile !== options.artifactFile
        || !validBackupReference(previousReceipt, options.files)
      ) {
        return { changed: false, ok: false, reason: "receipt-invalid" };
      }
      if (previousReceipt.phase === "rollback-failed") {
        return { changed: false, ok: false, reason: "rollback-failed", receipt: previousReceipt };
      }
      if (compareVersions(previousReceipt.productVersion, options.productVersion) > 0) {
        return { changed: false, ok: false, reason: "downgrade-refused" };
      }
    }

    let currentArtifact: string | undefined;
    try {
      currentArtifact = await readArtifact(options.artifactFile);
    } catch {
      return { changed: false, ok: false, reason: "artifact-drift" };
    }
    const currentDigest = currentArtifact === undefined ? undefined : digest(currentArtifact);
    if (previousReceipt?.backupFile && previousReceipt.previousDigest) {
      let backup: string | undefined;
      try {
        backup = await readPrivate(previousReceipt.backupFile);
      } catch {
        return { changed: false, ok: false, reason: "backup-invalid" };
      }
      if (backup === undefined || digest(backup) !== previousReceipt.previousDigest) {
        return { changed: false, ok: false, reason: "backup-invalid" };
      }
    }
    if (
      previousReceipt?.phase === "verified"
      && currentDigest !== previousReceipt.artifactDigest
    ) return { changed: false, ok: false, reason: "artifact-drift" };
    if (
      previousReceipt?.phase === "rolled-back"
      && currentDigest !== (previousReceipt.previousDigest ?? undefined)
    ) return { changed: false, ok: false, reason: "artifact-drift" };
    if (previousReceipt?.phase === "prepared") {
      if (previousReceipt.artifactDigest !== desiredDigest) {
        return { changed: false, ok: false, reason: "artifact-drift" };
      }
      if (
        currentDigest !== previousReceipt.previousDigest
        && currentDigest !== previousReceipt.artifactDigest
      ) return { changed: false, ok: false, reason: "artifact-drift" };
    }

    const sequence = (previousReceipt?.sequence ?? 0) + 1;
    if (currentDigest === desiredDigest) {
      if (!await options.activate()) {
        if (previousReceipt?.phase === "prepared") {
          return await rollbackPrepared(previousReceipt);
        }
        return { changed: false, ok: false, reason: "activation-failed" };
      }
      const verified = receipt({
        artifactDigest: desiredDigest,
        artifactFile: options.artifactFile,
        backupFile: previousReceipt?.backupFile ?? null,
        now: now(),
        phase: "verified",
        previousDigest: previousReceipt?.previousDigest ?? null,
        productVersion: options.productVersion,
        sequence
      });
      changed = true;
      await writePrivate(options.files.receiptFile, `${JSON.stringify(verified)}\n`);
      return { changed: false, ok: true, receipt: verified };
    }

    const previousDigest = currentDigest ?? null;
    const backupFile = previousDigest === null
      ? null
      : join(options.files.backupDir, `${previousDigest}.artifact`);
    if (currentArtifact !== undefined && backupFile) {
      changed = true;
      await writePrivate(backupFile, currentArtifact);
    }
    const prepared = receipt({
      artifactDigest: desiredDigest,
      artifactFile: options.artifactFile,
      backupFile,
      now: now(),
      phase: "prepared",
      previousDigest,
      productVersion: options.productVersion,
      sequence
    });
    changed = true;
    await writePrivate(options.files.receiptFile, `${JSON.stringify(prepared)}\n`);

    changed = true;
    await options.deactivate();
    await writePrivate(options.artifactFile, options.desiredArtifact);
    if (await options.activate()) {
      const verified = receipt({
        ...prepared,
        now: now(),
        phase: "verified",
        sequence: prepared.sequence + 1
      });
      await writePrivate(options.files.receiptFile, `${JSON.stringify(verified)}\n`);
      return { changed: true, ok: true, receipt: verified };
    }

    return await rollbackPrepared(prepared);
  } catch {
    return { changed, ok: false, reason: "persistence-failed" };
  }
}

export function residentDaemonArtifactDigest(contents: string): string {
  return digest(contents);
}
