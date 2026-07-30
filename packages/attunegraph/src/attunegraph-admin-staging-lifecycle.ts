import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readdirSync,
  realpathSync,
  unlinkSync
} from "node:fs";
import { isAbsolute, join, normalize, parse, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { types as nodeTypes } from "node:util";

import type {
  AttuneGraphPortableDecoderValidationSink
} from "./attunegraph-portable-decoder.js";
import {
  createAttuneGraphPortableIndexedValidationSinkWithTerminalCloseOutcomeForInternalUse,
  createAttuneGraphPortableIndexedValidationSinkWithTerminalCloseOutcomeForQualification,
  AttuneGraphPortableIndexedValidationSinkError,
  type AttuneGraphPortableIndexedValidationFaultForInternalUse
} from "./attunegraph-portable-indexed-validation-sink.js";

const OPERATION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u;
const TARGET_PREFIX = "attunegraph-admin-validation-v1-";
const TARGET_SUFFIX = ".sqlite";
const PRIVATE_FILE_MODE = 0o600;
const PRIVATE_DIRECTORY_MASK = 0o077;
const EXPECTED_SIDECAR_SUFFIXES = ["", "-journal", "-wal", "-shm"] as const;
const objectFreeze = Object.freeze;
const objectGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
const reflectApply = Reflect.apply;
const reflectGetPrototypeOf = Reflect.getPrototypeOf;
const reflectOwnKeys = Reflect.ownKeys;
const databaseClose = DatabaseSync.prototype.close;
const processGetuid = typeof process.getuid === "function"
  ? process.getuid.bind(process)
  : undefined;

export type AttuneGraphAdminStagingLifecycleErrorCode =
  | "INVALID_INPUT"
  | "DESTINATION_EXISTS"
  | "UNSUPPORTED_PROFILE"
  | "OPERATION_FAILED"
  | "CLEANUP_PENDING"
  | "INVALID_STATE";

export type AttuneGraphAdminStagingTerminalState =
  | "closed-validated"
  | "cleanup-complete"
  | "cleanup-pending"
  | "toxic-residue";

export type AttuneGraphAdminStagingReasonCode =
  | "VALIDATED"
  | "ABORTED"
  | "PRE_COMMIT_FAILURE"
  | "OPEN_FAILURE"
  | "CLEANUP_FAILED"
  | "CLOSE_AMBIGUITY"
  | "COMMIT_CLOSE_AMBIGUITY"
  | "IDENTITY_MISMATCH"
  | "UNEXPECTED_ARTIFACT"
  | "VERIFICATION_FAILED";

export interface AttuneGraphAdminStagingFileIdentity {
  readonly path: string;
  readonly device: bigint;
  readonly inode: bigint;
}

export interface AttuneGraphAdminValidationStagingReceipt {
  readonly state: AttuneGraphAdminStagingTerminalState;
  readonly reasonCode: AttuneGraphAdminStagingReasonCode;
  readonly targetDevice: bigint;
  readonly targetInode: bigint;
  readonly ownedFiles: readonly AttuneGraphAdminStagingFileIdentity[];
}

export interface OpenAttuneGraphAdminValidationStagingOptions {
  readonly stagingDirectory: string;
  readonly operationId: string;
}

export interface AttuneGraphAdminValidationStaging {
  readonly sink: AttuneGraphPortableDecoderValidationSink;
  receipt(): AttuneGraphAdminValidationStagingReceipt;
}

type LifecyclePhase =
  | "reserved"
  | "opened"
  | "transferred"
  | AttuneGraphAdminStagingTerminalState;

type LifecycleFaultOperation =
  | "reserve"
  | "pre-open-verify"
  | "post-open-verify"
  | "transfer"
  | "reservation-fd-close"
  | "post-close-verify"
  | "sidecar-discovery"
  | "unlink"
  | "parent-fsync";

export interface AttuneGraphAdminStagingLifecycleFaultForInternalUse {
  readonly operation: LifecycleFaultOperation;
  readonly occurrence?: number;
  readonly payload: unknown;
  readonly beforeOperation?: (
    operation: LifecycleFaultOperation,
    targetPath: string
  ) => void;
}

export interface AttuneGraphAdminStagingProfileForInternalUse {
  readonly expectedUid: number;
}

interface FileIdentity extends AttuneGraphAdminStagingFileIdentity {
  readonly name: string;
}

class OwnedFileDiscoveryError extends Error {
  readonly files: readonly FileIdentity[];

  constructor(files: readonly FileIdentity[]) {
    super("owned file discovery failed");
    this.files = objectFreeze(files.slice(0, 4));
  }
}

interface CleanupContext {
  readonly directory: string;
  readonly directoryDevice: bigint;
  readonly directoryInode: bigint;
  readonly targetPath: string;
  readonly uid: number;
  readonly targetDevice: bigint;
  readonly targetInode: bigint;
  readonly fault: AttuneGraphAdminStagingLifecycleFaultForInternalUse | undefined;
  readonly faultCounts: Record<LifecycleFaultOperation, number>;
  remaining: readonly FileIdentity[];
  parentSyncPending: boolean;
  latestReceipt?: AttuneGraphAdminValidationStagingReceipt;
}

interface OpenContext {
  readonly directory: string;
  readonly directoryDevice: bigint;
  readonly directoryInode: bigint;
  readonly targetPath: string;
  readonly targetName: string;
  readonly uid: number;
  readonly fault: AttuneGraphAdminStagingLifecycleFaultForInternalUse | undefined;
  readonly faultCounts: Record<LifecycleFaultOperation, number>;
  phase: LifecyclePhase | undefined;
  reservationDescriptor: number | undefined;
  database: DatabaseSync | undefined;
  transferred: boolean;
  targetIdentity: FileIdentity | undefined;
}

export class AttuneGraphAdminStagingLifecycleError extends Error {
  readonly code: AttuneGraphAdminStagingLifecycleErrorCode;
  readonly receipt?: AttuneGraphAdminValidationStagingReceipt;

  constructor(
    code: AttuneGraphAdminStagingLifecycleErrorCode,
    receipt?: AttuneGraphAdminValidationStagingReceipt
  ) {
    super(messageForCode(code));
    this.name = "AttuneGraphAdminStagingLifecycleError";
    this.code = code;
    if (receipt !== undefined) {
      Object.defineProperty(this, "receipt", {
        configurable: false,
        enumerable: false,
        writable: false,
        value: receipt
      });
    }
  }
}

const receiptContexts = new WeakMap<
  AttuneGraphAdminValidationStagingReceipt,
  CleanupContext
>();

function messageForCode(code: AttuneGraphAdminStagingLifecycleErrorCode): string {
  switch (code) {
    case "INVALID_INPUT":
      return "admin staging input is invalid";
    case "DESTINATION_EXISTS":
      return "admin staging destination exists";
    case "UNSUPPORTED_PROFILE":
      return "admin staging runtime profile is unsupported";
    case "OPERATION_FAILED":
      return "admin staging operation failed";
    case "CLEANUP_PENDING":
      return "admin staging cleanup is pending";
    case "INVALID_STATE":
      return "admin staging lifecycle state is invalid";
  }
}

function lifecycleError(
  code: AttuneGraphAdminStagingLifecycleErrorCode,
  receipt?: AttuneGraphAdminValidationStagingReceipt
): AttuneGraphAdminStagingLifecycleError {
  return new AttuneGraphAdminStagingLifecycleError(code, receipt);
}

function exactDataRecord(
  value: unknown,
  keys: readonly string[]
): Record<string, unknown> {
  if (
    value === null
    || typeof value !== "object"
    || Array.isArray(value)
    || nodeTypes.isProxy(value)
    || (
      reflectGetPrototypeOf(value) !== Object.prototype
      && reflectGetPrototypeOf(value) !== null
    )
    || reflectOwnKeys(value).length !== keys.length
  ) {
    throw lifecycleError("INVALID_INPUT");
  }
  const output = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    const descriptor = objectGetOwnPropertyDescriptor(value, key);
    if (
      descriptor === undefined
      || !("value" in descriptor)
      || descriptor.enumerable !== true
    ) {
      throw lifecycleError("INVALID_INPUT");
    }
    output[key] = descriptor.value;
  }
  if (
    reflectOwnKeys(value).some((key) =>
      typeof key !== "string" || !keys.includes(key)
    )
  ) {
    throw lifecycleError("INVALID_INPUT");
  }
  return output;
}

function validateOptions(
  value: unknown
): { readonly stagingDirectory: string; readonly operationId: string } {
  const input = exactDataRecord(value, ["stagingDirectory", "operationId"]);
  if (
    typeof input.stagingDirectory !== "string"
    || typeof input.operationId !== "string"
    || !OPERATION_ID.test(input.operationId)
    || input.operationId.includes("\0")
    || input.operationId.includes(sep)
  ) {
    throw lifecycleError("INVALID_INPUT");
  }
  return objectFreeze({
    stagingDirectory: input.stagingDirectory,
    operationId: input.operationId
  });
}

function validateFault(
  value: unknown
): AttuneGraphAdminStagingLifecycleFaultForInternalUse | undefined {
  if (value === undefined) return undefined;
  const input = exactDataRecord(
    value,
    ["operation", "occurrence", "payload", "beforeOperation"]
  );
  const operations: readonly LifecycleFaultOperation[] = [
    "reserve",
    "pre-open-verify",
    "post-open-verify",
    "transfer",
    "reservation-fd-close",
    "post-close-verify",
    "sidecar-discovery",
    "unlink",
    "parent-fsync"
  ];
  if (
    typeof input.operation !== "string"
    || !operations.includes(input.operation as LifecycleFaultOperation)
    || (
      input.occurrence !== undefined
      && (
        !Number.isSafeInteger(input.occurrence)
        || (input.occurrence as number) < 1
      )
    )
    || (
      input.beforeOperation !== undefined
      && typeof input.beforeOperation !== "function"
    )
  ) {
    throw lifecycleError("INVALID_INPUT");
  }
  return objectFreeze({
    operation: input.operation as LifecycleFaultOperation,
    occurrence: input.occurrence as number | undefined,
    payload: input.payload,
    beforeOperation: input.beforeOperation as
      | ((
        operation: LifecycleFaultOperation,
        targetPath: string
      ) => void)
      | undefined
  });
}

function assertSupportedProfile(): number {
  if (
    process.platform === "win32"
    || processGetuid === undefined
    || fsConstants.O_NOFOLLOW === undefined
    || fsConstants.O_DIRECTORY === undefined
  ) {
    throw lifecycleError("UNSUPPORTED_PROFILE");
  }
  return processGetuid();
}

function qualificationUid(value: unknown, runtimeUid: number): number {
  if (value === undefined) return runtimeUid;
  const input = exactDataRecord(value, ["expectedUid"]);
  if (
    !Number.isSafeInteger(input.expectedUid)
    || (input.expectedUid as number) < 0
  ) {
    throw lifecycleError("INVALID_INPUT");
  }
  return input.expectedUid as number;
}

function assertPrivateCanonicalDirectory(
  path: string,
  uid: number
): {
  readonly path: string;
  readonly device: bigint;
  readonly inode: bigint;
} {
  if (
    path.length === 0
    || path.includes("\0")
    || !isAbsolute(path)
    || normalize(path) !== path
    || resolve(path) !== path
    || path.endsWith(sep)
  ) {
    throw lifecycleError("INVALID_INPUT");
  }
  let canonical: string;
  try {
    canonical = realpathSync.native(path);
  } catch {
    throw lifecycleError("INVALID_INPUT");
  }
  if (canonical !== path) throw lifecycleError("INVALID_INPUT");

  const root = parse(path).root;
  const relativeParts = path.slice(root.length).split(sep).filter(Boolean);
  let current = root;
  try {
    for (const part of relativeParts) {
      current = join(current, part);
      const component = lstatSync(current, { bigint: true });
      if (component.isSymbolicLink()) throw lifecycleError("INVALID_INPUT");
    }
    const directory = lstatSync(path, { bigint: true });
    if (
      !directory.isDirectory()
      || directory.isSymbolicLink()
      || directory.uid !== BigInt(uid)
      || (directory.mode & BigInt(PRIVATE_DIRECTORY_MASK)) !== 0n
    ) {
      throw lifecycleError("INVALID_INPUT");
    }
    return objectFreeze({
      path: canonical,
      device: directory.dev,
      inode: directory.ino
    });
  } catch (cause) {
    if (cause instanceof AttuneGraphAdminStagingLifecycleError) throw cause;
    throw lifecycleError("INVALID_INPUT");
  }
}

function targetName(operationId: string): string {
  const operationHash = createHash("sha256")
    .update(operationId, "utf8")
    .digest("hex");
  const randomSuffix = randomBytes(16).toString("hex");
  return `${TARGET_PREFIX}${operationHash}-${randomSuffix}${TARGET_SUFFIX}`;
}

function expectedPaths(directory: string, name: string): readonly string[] {
  return EXPECTED_SIDECAR_SUFFIXES.map((suffix) =>
    join(directory, `${name}${suffix}`)
  );
}

function pathExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (cause) {
    return (cause as NodeJS.ErrnoException)?.code !== "ENOENT";
  }
}

function assertNoCollision(directory: string, name: string): void {
  if (expectedPaths(directory, name).some(pathExists)) {
    throw lifecycleError("DESTINATION_EXISTS");
  }
}

function maybeFault(
  context: OpenContext,
  operation: LifecycleFaultOperation
): void {
  context.fault?.beforeOperation?.(operation, context.targetPath);
  context.faultCounts[operation] += 1;
  if (
    context.fault?.operation === operation
    && context.faultCounts[operation] === (context.fault.occurrence ?? 1)
  ) {
    throw context.fault.payload;
  }
}

function statIdentity(path: string, name: string, uid: number): FileIdentity {
  const stat = lstatSync(path, { bigint: true });
  if (
    !stat.isFile()
    || stat.isSymbolicLink()
    || stat.uid !== BigInt(uid)
    || (stat.mode & 0o777n) !== BigInt(PRIVATE_FILE_MODE)
  ) {
    throw lifecycleError("OPERATION_FAILED");
  }
  return objectFreeze({
    name,
    path,
    device: stat.dev,
    inode: stat.ino
  });
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.path === right.path
    && left.device === right.device
    && left.inode === right.inode;
}

function assertReservedIdentity(context: OpenContext): FileIdentity {
  if (
    context.reservationDescriptor === undefined
    || context.targetIdentity === undefined
  ) {
    throw lifecycleError("OPERATION_FAILED");
  }
  const descriptorStat = fstatSync(context.reservationDescriptor, {
    bigint: true
  });
  const pathIdentity = statIdentity(
    context.targetPath,
    context.targetName,
    context.uid
  );
  if (
    !descriptorStat.isFile()
    || descriptorStat.uid !== BigInt(context.uid)
    || (descriptorStat.mode & 0o777n) !== BigInt(PRIVATE_FILE_MODE)
    || descriptorStat.dev !== context.targetIdentity.device
    || descriptorStat.ino !== context.targetIdentity.inode
    || !sameIdentity(pathIdentity, context.targetIdentity)
  ) {
    throw lifecycleError("OPERATION_FAILED");
  }
  return pathIdentity;
}

function assertDirectoryIdentity(context: {
  readonly directory: string;
  readonly directoryDevice: bigint;
  readonly directoryInode: bigint;
  readonly uid: number;
}): void {
  const stat = lstatSync(context.directory, { bigint: true });
  if (
    !stat.isDirectory()
    || stat.isSymbolicLink()
    || stat.uid !== BigInt(context.uid)
    || (stat.mode & BigInt(PRIVATE_DIRECTORY_MASK)) !== 0n
    || stat.dev !== context.directoryDevice
    || stat.ino !== context.directoryInode
  ) {
    throw lifecycleError("OPERATION_FAILED");
  }
}

function transition(context: OpenContext, next: LifecyclePhase): void {
  const allowed: Readonly<Record<string, readonly LifecyclePhase[]>> = {
    none: ["reserved"],
    reserved: ["opened", "cleanup-pending", "cleanup-complete", "toxic-residue"],
    opened: ["transferred", "cleanup-pending", "cleanup-complete", "toxic-residue"],
    transferred: [
      "closed-validated",
      "cleanup-pending",
      "cleanup-complete",
      "toxic-residue"
    ]
  };
  const current = context.phase ?? "none";
  if (!allowed[current]?.includes(next)) throw lifecycleError("INVALID_STATE");
  context.phase = next;
}

function publicIdentity(file: FileIdentity): AttuneGraphAdminStagingFileIdentity {
  return objectFreeze({
    path: file.path,
    device: file.device,
    inode: file.inode
  });
}

function makeReceipt(
  context: CleanupContext,
  state: AttuneGraphAdminStagingTerminalState,
  reasonCode: AttuneGraphAdminStagingReasonCode,
  files: readonly FileIdentity[]
): AttuneGraphAdminValidationStagingReceipt {
  const receipt = objectFreeze({
    state,
    reasonCode,
    targetDevice: context.targetDevice,
    targetInode: context.targetInode,
    ownedFiles: objectFreeze(files.slice(0, 4).map(publicIdentity))
  });
  context.remaining = objectFreeze(files.slice(0, 4));
  context.latestReceipt = receipt;
  receiptContexts.set(receipt, context);
  return receipt;
}

function discoverOwnedFiles(
  context: OpenContext,
  requireSidecarsAbsent: boolean
): {
  readonly files: readonly FileIdentity[];
  readonly unexpected: boolean;
  readonly sidecarsPresent: boolean;
} {
  assertDirectoryIdentity(context);
  maybeFault(context, "sidecar-discovery");
  assertDirectoryIdentity(context);
  const entries = readdirSync(context.directory);
  assertDirectoryIdentity(context);
  const expectedNames = new Set(
    EXPECTED_SIDECAR_SUFFIXES.map((suffix) => `${context.targetName}${suffix}`)
  );
  const unexpected = entries.some((entry) =>
    entry.startsWith(context.targetName) && !expectedNames.has(entry)
  );
  const files: FileIdentity[] = [];
  for (const suffix of EXPECTED_SIDECAR_SUFFIXES) {
    const name = `${context.targetName}${suffix}`;
    const path = join(context.directory, name);
    if (!entries.includes(name)) continue;
    try {
      files.push(statIdentity(path, name, context.uid));
    } catch {
      throw new OwnedFileDiscoveryError(
        files.length === 0
          ? [context.targetIdentity!]
          : files
      );
    }
  }
  if (files.length === 0) {
    throw new OwnedFileDiscoveryError([context.targetIdentity!]);
  }
  if (!sameIdentity(files[0]!, context.targetIdentity!)) {
    throw new OwnedFileDiscoveryError([
      context.targetIdentity!,
      ...files.slice(1)
    ]);
  }
  assertDirectoryIdentity(context);
  return objectFreeze({
    files: objectFreeze(files),
    unexpected,
    sidecarsPresent: requireSidecarsAbsent && files.length !== 1
  });
}

function discoveryFailureFiles(
  cause: unknown,
  target: FileIdentity
): readonly FileIdentity[] {
  return cause instanceof OwnedFileDiscoveryError
    ? cause.files
    : objectFreeze([target]);
}

function closeReservation(context: OpenContext): void {
  if (context.reservationDescriptor === undefined) return;
  const descriptor = context.reservationDescriptor;
  context.reservationDescriptor = undefined;
  let injected: unknown;
  try {
    maybeFault(context, "reservation-fd-close");
  } catch (cause) {
    injected = cause;
  }
  try {
    closeSync(descriptor);
  } catch (cause) {
    if (injected === undefined) injected = cause;
  }
  if (injected !== undefined) throw injected;
}

function bestEffortCloseUntransferred(context: OpenContext): boolean {
  if (context.database === undefined || context.transferred) return true;
  try {
    reflectApply(databaseClose, context.database, []);
    context.database = undefined;
    return true;
  } catch {
    return false;
  }
}

function fsyncParent(context: CleanupContext): void {
  assertDirectoryIdentity(context);
  const descriptor = openSync(
    context.directory,
    fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW
  );
  try {
    assertDirectoryIdentity(context);
    const descriptorStat = fstatSync(descriptor, { bigint: true });
    if (
      !descriptorStat.isDirectory()
      || descriptorStat.dev !== context.directoryDevice
      || descriptorStat.ino !== context.directoryInode
    ) {
      throw lifecycleError("OPERATION_FAILED");
    }
    const openContext = cleanupOpenContext(context);
    maybeFault(openContext, "parent-fsync");
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function cleanupOpenContext(context: CleanupContext): OpenContext {
  return {
    directory: context.directory,
    directoryDevice: context.directoryDevice,
    directoryInode: context.directoryInode,
    targetPath: context.targetPath,
    targetName: context.remaining[0]?.name ?? "",
    uid: context.uid,
    fault: context.fault,
    faultCounts: context.faultCounts,
    phase: "cleanup-pending",
    reservationDescriptor: undefined,
    database: undefined,
    transferred: true,
    targetIdentity: context.remaining[0]
  };
}

function performCleanup(
  context: CleanupContext,
  reasonCode: AttuneGraphAdminStagingReasonCode
): AttuneGraphAdminValidationStagingReceipt {
  const remaining: FileIdentity[] = [];
  let failed = false;
  let toxic = false;
  const openContext = cleanupOpenContext(context);
  try {
    assertDirectoryIdentity(openContext);
  } catch {
    return makeReceipt(
      context,
      "toxic-residue",
      "IDENTITY_MISMATCH",
      context.remaining
    );
  }
  for (let index = 0; index < context.remaining.length; index += 1) {
    const expected = context.remaining[index]!;
    try {
      assertDirectoryIdentity(openContext);
    } catch {
      toxic = true;
      remaining.push(...context.remaining.slice(index));
      break;
    }
    try {
      maybeFault(openContext, "unlink");
    } catch {
      failed = true;
      remaining.push(expected);
      continue;
    }
    let actual: FileIdentity;
    try {
      actual = statIdentity(
        expected.path,
        expected.name,
        context.uid
      );
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException)?.code === "ENOENT") continue;
      toxic = true;
      try {
        const unsafe = lstatSync(expected.path, { bigint: true });
        if (
          unsafe.dev === expected.device
          && unsafe.ino === expected.inode
        ) {
          remaining.push(expected);
        }
      } catch {
        // An absent or substituted current path is never authorized.
      }
      remaining.push(...context.remaining.slice(index + 1));
      break;
    }
    if (!sameIdentity(actual, expected)) {
      toxic = true;
      remaining.push(...context.remaining.slice(index + 1));
      break;
    }
    let unlinked = false;
    try {
      assertDirectoryIdentity(openContext);
      unlinkSync(expected.path);
      unlinked = true;
      assertDirectoryIdentity(openContext);
      if (pathExists(expected.path)) {
        toxic = true;
        remaining.push(...context.remaining.slice(index + 1));
        break;
      }
    } catch {
      if (unlinked) {
        toxic = true;
        remaining.push(...context.remaining.slice(index + 1));
        break;
      } else {
        failed = true;
        remaining.push(expected);
      }
    }
  }
  if (toxic) {
    context.remaining = objectFreeze(remaining);
    return makeReceipt(context, "toxic-residue", "IDENTITY_MISMATCH", remaining);
  }
  if (remaining.length > 0 || failed) {
    context.remaining = objectFreeze(remaining);
    return makeReceipt(context, "cleanup-pending", "CLEANUP_FAILED", remaining);
  }
  try {
    fsyncParent(context);
    context.parentSyncPending = false;
    return makeReceipt(context, "cleanup-complete", reasonCode, []);
  } catch {
    context.remaining = objectFreeze([]);
    context.parentSyncPending = true;
    return makeReceipt(context, "cleanup-pending", "CLEANUP_FAILED", []);
  }
}

function cleanupContext(
  context: OpenContext,
  files: readonly FileIdentity[]
): CleanupContext {
  return {
    directory: context.directory,
    directoryDevice: context.directoryDevice,
    directoryInode: context.directoryInode,
    targetPath: context.targetPath,
    uid: context.uid,
    targetDevice: context.targetIdentity!.device,
    targetInode: context.targetIdentity!.inode,
    fault: context.fault,
    faultCounts: context.faultCounts,
    remaining: objectFreeze(files),
    parentSyncPending: false,
    latestReceipt: undefined
  };
}

function settleCleanup(
  context: OpenContext,
  reasonCode: AttuneGraphAdminStagingReasonCode
): AttuneGraphAdminValidationStagingReceipt {
  let discovered: ReturnType<typeof discoverOwnedFiles>;
  try {
    discovered = discoverOwnedFiles(context, false);
  } catch (cause) {
    transition(context, "toxic-residue");
    const files = discoveryFailureFiles(cause, context.targetIdentity!);
    const cleanup = cleanupContext(context, files);
    return makeReceipt(
      cleanup,
      "toxic-residue",
      "VERIFICATION_FAILED",
      files
    );
  }
  const cleanup = cleanupContext(context, discovered.files);
  if (discovered.unexpected) {
    transition(context, "toxic-residue");
    return makeReceipt(
      cleanup,
      "toxic-residue",
      "UNEXPECTED_ARTIFACT",
      discovered.files
    );
  }
  transition(context, "cleanup-pending");
  const receipt = performCleanup(cleanup, reasonCode);
  context.phase = receipt.state;
  return receipt;
}

function settleValidated(
  context: OpenContext
): AttuneGraphAdminValidationStagingReceipt {
  try {
    maybeFault(context, "post-close-verify");
    const discovered = discoverOwnedFiles(context, true);
    if (discovered.unexpected) {
      transition(context, "toxic-residue");
      const cleanup = cleanupContext(context, discovered.files);
      return makeReceipt(
        cleanup,
        "toxic-residue",
        "UNEXPECTED_ARTIFACT",
        discovered.files
      );
    }
    if (discovered.sidecarsPresent) {
      transition(context, "toxic-residue");
      const cleanup = cleanupContext(context, discovered.files);
      return makeReceipt(
        cleanup,
        "toxic-residue",
        "VERIFICATION_FAILED",
        discovered.files
      );
    }
    transition(context, "closed-validated");
    const cleanup = cleanupContext(context, discovered.files);
    return makeReceipt(
      cleanup,
      "closed-validated",
      "VALIDATED",
      discovered.files
    );
  } catch (cause) {
    transition(context, "toxic-residue");
    const files = discoveryFailureFiles(cause, context.targetIdentity!);
    const cleanup = cleanupContext(context, files);
    return makeReceipt(
      cleanup,
      "toxic-residue",
      "VERIFICATION_FAILED",
      files
    );
  }
}

function createFaultCounts(): Record<LifecycleFaultOperation, number> {
  return {
    reserve: 0,
    "pre-open-verify": 0,
    "post-open-verify": 0,
    transfer: 0,
    "reservation-fd-close": 0,
    "post-close-verify": 0,
    "sidecar-discovery": 0,
    unlink: 0,
    "parent-fsync": 0
  };
}

function openLifecycle(
  optionsInput: unknown,
  faultInput: unknown,
  indexedFault: AttuneGraphPortableIndexedValidationFaultForInternalUse | undefined,
  qualificationMode: boolean,
  profileInput?: unknown
): AttuneGraphAdminValidationStaging {
  const options = validateOptions(optionsInput);
  const runtimeUid = assertSupportedProfile();
  const uid = qualificationMode
    ? qualificationUid(profileInput, runtimeUid)
    : runtimeUid;
  const directoryIdentity = assertPrivateCanonicalDirectory(
    options.stagingDirectory,
    uid
  );
  let name: string;
  try {
    name = targetName(options.operationId);
  } catch {
    throw lifecycleError("OPERATION_FAILED");
  }
  const context: OpenContext = {
    directory: directoryIdentity.path,
    directoryDevice: directoryIdentity.device,
    directoryInode: directoryIdentity.inode,
    targetPath: join(directoryIdentity.path, name),
    targetName: name,
    uid,
    fault: qualificationMode ? validateFault(faultInput) : undefined,
    faultCounts: createFaultCounts(),
    phase: undefined,
    reservationDescriptor: undefined,
    database: undefined,
    transferred: false,
    targetIdentity: undefined
  };

  try {
    assertDirectoryIdentity(context);
    assertNoCollision(context.directory, name);
    maybeFault(context, "reserve");
    assertDirectoryIdentity(context);
    assertNoCollision(context.directory, name);
    try {
      context.reservationDescriptor = openSync(
        context.targetPath,
        fsConstants.O_CREAT
          | fsConstants.O_EXCL
          | fsConstants.O_RDWR
          | fsConstants.O_NOFOLLOW,
        PRIVATE_FILE_MODE
      );
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException)?.code === "EEXIST") {
        throw lifecycleError("DESTINATION_EXISTS");
      }
      throw cause;
    }
    context.targetIdentity = statIdentity(
      context.targetPath,
      context.targetName,
      uid
    );
    transition(context, "reserved");
    maybeFault(context, "pre-open-verify");
    assertDirectoryIdentity(context);
    assertReservedIdentity(context);

    context.database = new DatabaseSync(context.targetPath, { timeout: 1_000 });
    transition(context, "opened");
    maybeFault(context, "post-open-verify");
    assertDirectoryIdentity(context);
    assertReservedIdentity(context);
    maybeFault(context, "transfer");
    closeReservation(context);

    context.transferred = true;
    const indexedCreation = qualificationMode && indexedFault !== undefined
      ? createAttuneGraphPortableIndexedValidationSinkWithTerminalCloseOutcomeForQualification(
        context.database,
        indexedFault
      )
      : createAttuneGraphPortableIndexedValidationSinkWithTerminalCloseOutcomeForInternalUse(
        context.database
      );
    const indexedSink = indexedCreation.sink;
    transition(context, "transferred");
    const methods = objectFreeze({
      appendProjection: indexedSink.appendProjection,
      sealProjections: indexedSink.sealProjections,
      assertHead: indexedSink.assertHead,
      finish: indexedSink.finish,
      abort: indexedSink.abort
    });
    let operationActive = false;
    let terminalReceipt: AttuneGraphAdminValidationStagingReceipt | undefined;

    const requireActive = (): void => {
      if (operationActive || terminalReceipt !== undefined) {
        throw lifecycleError("INVALID_STATE", terminalReceipt);
      }
      operationActive = true;
    };
    const finishOperation = (): void => {
      operationActive = false;
    };
    const observedCloseOutcome = (): "closed" | "unknown" => {
      try {
        return reflectApply(
          indexedCreation.terminalCloseOutcome,
          indexedCreation,
          []
        );
      } catch {
        return "unknown";
      }
    };
    const settleCloseAmbiguity = (): AttuneGraphAdminValidationStagingReceipt => {
      transition(context, "toxic-residue");
      const cleanup = cleanupContext(context, [context.targetIdentity!]);
      return makeReceipt(
        cleanup,
        "toxic-residue",
        "CLOSE_AMBIGUITY",
        [context.targetIdentity!]
      );
    };
    const failPreCommit = async (
      cause: unknown
    ): Promise<never> => {
      try {
        await reflectApply(methods.abort, indexedSink, [cause]);
      } catch {
        // The transferred handle's terminal close outcome remains unknown.
      }
      if (observedCloseOutcome() === "closed") {
        terminalReceipt = settleCleanup(context, "PRE_COMMIT_FAILURE");
        throw lifecycleError(
          terminalReceipt.state === "cleanup-pending"
            ? "CLEANUP_PENDING"
            : "OPERATION_FAILED",
          terminalReceipt
        );
      } else {
        terminalReceipt = settleCloseAmbiguity();
        throw lifecycleError("OPERATION_FAILED", terminalReceipt);
      }
    };

    const sink: AttuneGraphPortableDecoderValidationSink = {
      async appendProjection(identity) {
        requireActive();
        try {
          await reflectApply(methods.appendProjection, indexedSink, [identity]);
        } catch (cause) {
          return failPreCommit(cause);
        } finally {
          finishOperation();
        }
      },
      async sealProjections() {
        requireActive();
        try {
          await reflectApply(methods.sealProjections, indexedSink, []);
        } catch (cause) {
          return failPreCommit(cause);
        } finally {
          finishOperation();
        }
      },
      async assertHead(identity) {
        requireActive();
        try {
          await reflectApply(methods.assertHead, indexedSink, [identity]);
        } catch (cause) {
          return failPreCommit(cause);
        } finally {
          finishOperation();
        }
      },
      async finish(scopeCount, headCount) {
        requireActive();
        try {
          await reflectApply(methods.finish, indexedSink, [
            scopeCount,
            headCount
          ]);
          terminalReceipt = settleValidated(context);
          if (terminalReceipt.state !== "closed-validated") {
            throw lifecycleError("OPERATION_FAILED", terminalReceipt);
          }
        } catch (cause) {
          if (
            cause instanceof AttuneGraphAdminStagingLifecycleError
            && terminalReceipt !== undefined
          ) {
            throw cause;
          }
          if (
            cause instanceof AttuneGraphPortableIndexedValidationSinkError
            && cause.code !== "STORE_FAILURE"
          ) {
            return failPreCommit(cause);
          }
          transition(context, "toxic-residue");
          const cleanup = cleanupContext(context, [context.targetIdentity!]);
          terminalReceipt = makeReceipt(
            cleanup,
            "toxic-residue",
            "COMMIT_CLOSE_AMBIGUITY",
            [context.targetIdentity!]
          );
          throw lifecycleError("OPERATION_FAILED", terminalReceipt);
        } finally {
          finishOperation();
        }
      },
      async abort(cause) {
        requireActive();
        try {
          try {
            await reflectApply(methods.abort, indexedSink, [cause]);
          } catch {
            // The transferred handle's terminal close outcome remains unknown.
          }
          if (observedCloseOutcome() === "closed") {
            terminalReceipt = settleCleanup(context, "ABORTED");
            if (terminalReceipt.state === "cleanup-pending") {
              throw lifecycleError("CLEANUP_PENDING", terminalReceipt);
            }
            if (terminalReceipt.state === "toxic-residue") {
              throw lifecycleError("OPERATION_FAILED", terminalReceipt);
            }
          } else {
            terminalReceipt = settleCloseAmbiguity();
            throw lifecycleError("OPERATION_FAILED", terminalReceipt);
          }
        } finally {
          finishOperation();
        }
      }
    };
    const managed: AttuneGraphAdminValidationStaging = {
      sink: objectFreeze(sink),
      receipt() {
        if (operationActive || terminalReceipt === undefined) {
          throw lifecycleError("INVALID_STATE");
        }
        return terminalReceipt;
      }
    };
    return objectFreeze(managed);
  } catch (cause) {
    let reservationCloseFailed = false;
    try {
      closeReservation(context);
    } catch {
      reservationCloseFailed = true;
    }
    const databaseClosed = bestEffortCloseUntransferred(context);
    if (context.targetIdentity === undefined || context.phase === undefined) {
      if (cause instanceof AttuneGraphAdminStagingLifecycleError) throw cause;
      throw lifecycleError("OPERATION_FAILED");
    }
    if (reservationCloseFailed || !databaseClosed) {
      const cleanup = cleanupContext(context, [context.targetIdentity]);
      context.phase = "toxic-residue";
      const receipt = makeReceipt(
        cleanup,
        "toxic-residue",
        "OPEN_FAILURE",
        [context.targetIdentity]
      );
      throw lifecycleError("OPERATION_FAILED", receipt);
    }
    const receipt = settleCleanup(context, "OPEN_FAILURE");
    throw lifecycleError(
      receipt.state === "cleanup-pending"
        ? "CLEANUP_PENDING"
        : "OPERATION_FAILED",
      receipt
    );
  }
}

/**
 * Creates a validated-but-unpublished staging database for a future separate
 * Admin Worker. It never publishes into `./admin` and is not a serving-Worker
 * entry point.
 */
export function openAttuneGraphAdminValidationStaging(
  options: OpenAttuneGraphAdminValidationStagingOptions
): AttuneGraphAdminValidationStaging {
  return openLifecycle(options, undefined, undefined, false, undefined);
}

export function openAttuneGraphAdminValidationStagingForQualification(
  options: OpenAttuneGraphAdminValidationStagingOptions,
  fault: AttuneGraphAdminStagingLifecycleFaultForInternalUse,
  indexedFault?: AttuneGraphPortableIndexedValidationFaultForInternalUse,
  profile?: AttuneGraphAdminStagingProfileForInternalUse
): AttuneGraphAdminValidationStaging {
  if (process.env.NODE_ENV !== "test") {
    throw lifecycleError("INVALID_INPUT");
  }
  return openLifecycle(options, fault, indexedFault, true, profile);
}

export function cleanupAttuneGraphAdminValidationStaging(
  receipt: AttuneGraphAdminValidationStagingReceipt
): AttuneGraphAdminValidationStagingReceipt {
  if (
    receipt === null
    || typeof receipt !== "object"
    || nodeTypes.isProxy(receipt)
  ) {
    throw lifecycleError("INVALID_INPUT");
  }
  const context = receiptContexts.get(receipt);
  if (context === undefined) throw lifecycleError("INVALID_INPUT");
  if (context.latestReceipt !== receipt) {
    if (context.latestReceipt?.state === "cleanup-complete") {
      return context.latestReceipt;
    }
    throw lifecycleError("INVALID_STATE", context.latestReceipt);
  }
  if (receipt.state === "cleanup-complete") return receipt;
  if (receipt.state === "toxic-residue") {
    throw lifecycleError("INVALID_STATE", receipt);
  }
  const next = performCleanup(
    context,
    receipt.state === "closed-validated" ? "ABORTED" : "CLEANUP_FAILED"
  );
  if (next.state === "cleanup-pending") {
    throw lifecycleError("CLEANUP_PENDING", next);
  }
  if (next.state === "toxic-residue") {
    throw lifecycleError("OPERATION_FAILED", next);
  }
  return next;
}
