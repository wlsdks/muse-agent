import {
  matchesProcessIdentity,
  readProcessTable
} from "./process-lifecycle-diagnostics.mjs";

export class OwnedProcessGroupStillRunningError extends Error {
  constructor(processGroupId, timeoutMs) {
    super(`Owned process group ${processGroupId.toString()} remained live after ${timeoutMs.toString()}ms`);
    this.name = "OwnedProcessGroupStillRunningError";
    this.processGroupId = processGroupId;
    this.timeoutMs = timeoutMs;
  }
}

export class OwnedProcessGroupOwnershipMismatchError extends Error {
  constructor(pid, { observed, receipt } = {}) {
    const detail = observed && receipt
      ? ` (expected pgid=${String(receipt.processGroupId)} start=${String(receipt.osStartedAt)} exe=${String(receipt.executable)}; observed pgid=${String(observed.processGroupId)} start=${String(observed.osStartedAt)} exe=${String(observed.executable)})`
      : "";
    super(`Process ${pid.toString()} no longer matches its exact launch receipt${detail}`);
    this.name = "OwnedProcessGroupOwnershipMismatchError";
    this.pid = pid;
  }
}

/**
 * Bind a detached child PID to the OS-observed process birth identity.
 * Only a child leading its own process group can receive a group receipt.
 */
export async function bindOwnedProcessGroup(
  pid,
  {
    pollMs = 25,
    readProcesses = readProcessTable,
    timeoutMs = 2_000
  } = {}
) {
  requirePositiveInteger(pid, "pid");
  requirePositiveInteger(pollMs, "pollMs");
  requirePositiveInteger(timeoutMs, "timeoutMs");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const observed = (await readProcesses()).find((candidate) => candidate.pid === pid);
    if (observed !== undefined) {
      if (observed.processGroupId !== pid) {
        throw new OwnedProcessGroupOwnershipMismatchError(pid);
      }
      return Object.freeze({ ...observed });
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  throw new OwnedProcessGroupOwnershipMismatchError(pid);
}

export async function signalOwnedProcessRoot(
  receipt,
  signal = "SIGTERM",
  {
    readProcesses = readProcessTable,
    signalProcess = (pid, requestedSignal) => process.kill(pid, requestedSignal)
  } = {}
) {
  const observed = (await readProcesses()).find((candidate) => candidate.pid === receipt.pid);
  if (observed === undefined) return "already-exited";
  if (!matchesProcessIdentity(receipt, observed)) {
    throw new OwnedProcessGroupOwnershipMismatchError(receipt.pid, { observed, receipt });
  }
  signalProcess(receipt.pid, signal);
  return "signalled";
}

export async function forceOwnedProcessGroup(
  receipt,
  signal = "SIGKILL",
  {
    memberReceipts = [],
    readProcesses = readProcessTable,
    signalProcessGroup = (processGroupId, requestedSignal) =>
      process.kill(-processGroupId, requestedSignal)
  } = {}
) {
  const records = await readProcesses();
  const observedRoot = records.find((candidate) => candidate.pid === receipt.pid);
  const members = records.filter((candidate) => candidate.processGroupId === receipt.processGroupId);
  if (observedRoot !== undefined && !matchesProcessIdentity(receipt, observedRoot)) {
    throw new OwnedProcessGroupOwnershipMismatchError(receipt.pid, { observed: observedRoot, receipt });
  }
  if (observedRoot === undefined && members.length === 0) return "already-exited";
  if (
    observedRoot === undefined
    && !members.some((member) =>
      memberReceipts.some((captured) => matchesProcessIdentity(captured, member))
    )
  ) {
    throw new OwnedProcessGroupOwnershipMismatchError(receipt.pid, { receipt });
  }
  signalProcessGroup(receipt.processGroupId, signal);
  return "signalled";
}

export async function waitForOwnedProcessGroupExit(
  receipt,
  {
    pollMs = 50,
    readProcesses = readProcessTable,
    timeoutMs = 5_000
  } = {}
) {
  requirePositiveInteger(pollMs, "pollMs");
  requirePositiveInteger(timeoutMs, "timeoutMs");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const records = await readProcesses();
    assertRootIdentityIfPresent(receipt, records);
    if (!records.some((candidate) => candidate.processGroupId === receipt.processGroupId)) return;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  const finalRecords = await readProcesses();
  assertRootIdentityIfPresent(receipt, finalRecords);
  if (!finalRecords.some((candidate) => candidate.processGroupId === receipt.processGroupId)) return;
  throw new OwnedProcessGroupStillRunningError(receipt.processGroupId, timeoutMs);
}

export async function ownedProcessGroupMembers(
  receipt,
  { readProcesses = readProcessTable } = {}
) {
  const records = await readProcesses();
  assertRootIdentityIfPresent(receipt, records);
  return records.filter((candidate) => candidate.processGroupId === receipt.processGroupId);
}

function assertRootIdentityIfPresent(receipt, records) {
  const observedRoot = records.find((candidate) => candidate.pid === receipt.pid);
  if (observedRoot !== undefined && !matchesProcessIdentity(receipt, observedRoot)) {
    throw new OwnedProcessGroupOwnershipMismatchError(receipt.pid, { observed: observedRoot, receipt });
  }
}

function requirePositiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
}
