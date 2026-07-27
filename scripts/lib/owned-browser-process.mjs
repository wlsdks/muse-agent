import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export class OwnedBrowserProcessStillRunningError extends Error {
  constructor(pid, timeoutMs) {
    super(`Owned browser process ${pid.toString()} remained live after ${timeoutMs.toString()}ms`);
    this.name = "OwnedBrowserProcessStillRunningError";
    this.pid = pid;
    this.timeoutMs = timeoutMs;
  }
}

export class OwnedBrowserOwnershipMismatchError extends Error {
  constructor(pid) {
    super(`Browser process ${pid.toString()} no longer matches its exact launch receipt`);
    this.name = "OwnedBrowserOwnershipMismatchError";
    this.pid = pid;
  }
}

/**
 * Bind the controller's spawn receipt to the OS process birth identity before
 * it can become eligible for forced cleanup.
 */
export async function bindOwnedBrowserProcess(receipt, { observe = observeOwnedBrowserProcess } = {}) {
  const observed = await observe(receipt);
  if (
    observed === undefined ||
    !matchesSpawnedBrowserProcess(receipt, observed) ||
    (receipt.osStartedAt !== undefined && receipt.osStartedAt !== observed.osStartedAt)
  ) {
    throw new OwnedBrowserOwnershipMismatchError(receipt.pid);
  }
  return Object.freeze({ ...receipt, osStartedAt: observed.osStartedAt });
}

export function matchesOwnedBrowserProcess(receipt, observed) {
  return typeof receipt?.osStartedAt === "string"
    && receipt.osStartedAt === observed?.osStartedAt
    && matchesSpawnedBrowserProcess(receipt, observed);
}

export async function observeOwnedBrowserProcess(receipt, { runPs = defaultRunPs } = {}) {
  const record = await runPs(receipt.pid);
  if (record === undefined) return undefined;
  return parsePsRecord(record);
}

export async function terminateOwnedBrowserProcess(
  receipt,
  {
    observe = observeOwnedBrowserProcess,
    signalProcessGroup = (processGroupId, signal) => process.kill(-processGroupId, signal)
  } = {}
) {
  const observed = await observe(receipt);
  if (observed === undefined) return "already-exited";
  if (!matchesOwnedBrowserProcess(receipt, observed)) {
    throw new OwnedBrowserOwnershipMismatchError(receipt.pid);
  }
  signalProcessGroup(receipt.processGroupId, "SIGTERM");
  return "signalled";
}

export async function waitForOwnedBrowserExit(
  receipt,
  {
    observe = observeOwnedBrowserProcess,
    pollMs = 50,
    timeoutMs = 5_000
  } = {}
) {
  requirePositiveTimeout(pollMs, "pollMs");
  requirePositiveTimeout(timeoutMs, "timeoutMs");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const observed = await observe(receipt);
    if (observed === undefined || !matchesOwnedBrowserProcess(receipt, observed)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  throw new OwnedBrowserProcessStillRunningError(receipt.pid, timeoutMs);
}

export function parsePsRecord({ args, executablePath, metadata }) {
  const match = /^(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\d+\s+[0-9:]+\s+\d{4})$/u.exec(metadata.trim());
  if (
    !match ||
    typeof executablePath !== "string" ||
    executablePath.trim().length === 0 ||
    typeof args !== "string" ||
    args.trim().length === 0
  ) {
    throw new Error("Could not parse the owned browser process record");
  }
  return {
    args: args.trim(),
    executablePath: executablePath.trim(),
    osStartedAt: match[3],
    pid: Number(match[1]),
    processGroupId: Number(match[2])
  };
}

function matchesSpawnedBrowserProcess(receipt, observed) {
  if (!receipt || !observed) return false;
  if (
    observed.pid !== receipt.pid ||
    receipt.processGroupId === undefined ||
    observed.processGroupId !== receipt.processGroupId ||
    observed.executablePath !== receipt.executablePath
  ) {
    return false;
  }
  return hasExactArgument(observed.args, `--user-data-dir=${receipt.userDataDir}`)
    && hasExactArgument(observed.args, `--muse-launch-id=${receipt.launchId}`);
}

function hasExactArgument(args, expected) {
  const escaped = expected.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`(?:^|\\s)${escaped}(?=\\s|$)`, "u").test(args);
}

async function defaultRunPs(pid) {
  const options = { encoding: "utf8", timeout: 2_000 };
  try {
    const metadataBefore = await execFileAsync(
      "/bin/ps",
      ["-ww", "-p", String(pid), "-o", "pid=,pgid=,lstart="],
      options
    );
    const [executablePath, args] = await Promise.all([
      execFileAsync("/bin/ps", ["-ww", "-p", String(pid), "-o", "comm="], options),
      execFileAsync("/bin/ps", ["-ww", "-p", String(pid), "-o", "args="], options)
    ]);
    const metadataAfter = await execFileAsync(
      "/bin/ps",
      ["-ww", "-p", String(pid), "-o", "pid=,pgid=,lstart="],
      options
    );
    if (
      metadataBefore.stdout.trim().length === 0 ||
      metadataBefore.stdout.trim() !== metadataAfter.stdout.trim() ||
      executablePath.stdout.trim().length === 0 ||
      args.stdout.trim().length === 0
    ) {
      return undefined;
    }
    return {
      args: args.stdout,
      executablePath: executablePath.stdout,
      metadata: metadataBefore.stdout
    };
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === 1) {
      return undefined;
    }
    throw error;
  }
}

function requirePositiveTimeout(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
}
