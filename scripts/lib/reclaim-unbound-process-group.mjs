import { readProcessTable } from "./process-lifecycle-diagnostics.mjs";

export async function reclaimUnboundDetachedProcessGroup({
  processGroupId,
  terminal,
  kill = process.kill,
  listProcesses = readProcessTable,
  termTimeoutMs = 2_000,
  killTimeoutMs = 5_000
}) {
  if (!Number.isSafeInteger(processGroupId) || processGroupId <= 1) {
    throw new RangeError("processGroupId must be an exact positive detached process-group ID");
  }
  if (!(terminal instanceof Promise)) {
    throw new TypeError("terminal must be the spawned root's terminal promise");
  }
  if (await waitForGroupExit(processGroupId, 0, listProcesses)) {
    await withTimeout(terminal, killTimeoutMs, "unbound root terminal event did not settle");
    return;
  }
  signalExactGroup(processGroupId, "SIGTERM", kill);
  if (!await waitForGroupExit(processGroupId, termTimeoutMs, listProcesses)) {
    signalExactGroup(processGroupId, "SIGKILL", kill);
    if (!await waitForGroupExit(processGroupId, killTimeoutMs, listProcesses)) {
      throw new Error(
        `Unbound detached process group ${processGroupId.toString()} remained after SIGKILL`
      );
    }
  }
  await withTimeout(terminal, killTimeoutMs, "unbound root terminal event did not settle");
}

function signalExactGroup(processGroupId, signal, kill) {
  try {
    kill(-processGroupId, signal);
  } catch (error) {
    if (!error || typeof error !== "object" || error.code !== "ESRCH") throw error;
  }
}

async function waitForGroupExit(processGroupId, timeoutMs, listProcesses) {
  const deadline = Date.now() + timeoutMs;
  do {
    const members = (await listProcesses()).filter((record) =>
      record.processGroupId === processGroupId
    );
    if (members.length === 0) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 50));
  } while (true);
}

function withTimeout(operation, timeoutMs, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  return Promise.race([operation, timeout]).finally(() => clearTimeout(timer));
}
