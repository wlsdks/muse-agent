import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const LIFECYCLE_DIAGNOSTIC_PREFIX = "smoke:cli lifecycle ";

export function summarizeActiveResources({
  handles = getActiveHandles(),
  requests = getActiveRequests()
} = {}) {
  return {
    handles: handles.map(describeHandle),
    requests: requests.map((request) => ({ type: resourceType(request) }))
  };
}

export function parseProcessTable(output) {
  const records = [];
  for (const line of output.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.{24})\s+(.+?)\s*$/u.exec(line);
    if (match === null) continue;
    records.push({
      executable: executableIdentity(match[5]),
      osStartedAt: match[4],
      parentPid: Number(match[2]),
      pid: Number(match[1]),
      processGroupId: Number(match[3])
    });
  }
  return records;
}

export function parseLifecycleDiagnosticOutput(output) {
  const lines = output.split("\n");
  if (!output.endsWith("\n")) lines.pop();
  for (const line of lines.toReversed()) {
    if (line.startsWith(LIFECYCLE_DIAGNOSTIC_PREFIX)) {
      return JSON.parse(line.slice(LIFECYCLE_DIAGNOSTIC_PREFIX.length));
    }
  }
  return undefined;
}

export function selectProcessAncestry(records, { processGroupId, rootPid }) {
  const byPid = new Map(records.map((record) => [record.pid, record]));
  const selected = [];
  for (const record of records) {
    const lineage = lineageFor(record.pid, byPid);
    const rootIndex = lineage.indexOf(rootPid);
    const isRoot = record.pid === rootPid;
    const isDescendant = rootIndex !== -1 && !isRoot;
    const isGroupMember = record.processGroupId === processGroupId;
    if (!isRoot && !isDescendant && !isGroupMember) continue;
    selected.push({
      ...record,
      lineage: rootIndex === -1 ? [record.pid] : lineage.slice(rootIndex),
      relationship: isRoot ? "root" : isDescendant ? "descendant" : "process-group-member"
    });
  }
  return selected.sort((left, right) => left.pid - right.pid);
}

export function matchesProcessIdentity(receipt, observed) {
  return receipt !== undefined
    && observed !== undefined
    && receipt.pid === observed.pid
    && receipt.processGroupId === observed.processGroupId
    && receipt.osStartedAt === observed.osStartedAt
    && receipt.executable === observed.executable;
}

export async function captureProcessLifecycleDiagnostics({
  handles,
  requests,
  rootPid = process.pid
} = {}) {
  const records = await readProcessTable();
  const diagnosticProcessIds = new Set(
    records
      .filter((record) => record.parentPid === rootPid && record.executable === "/bin/ps")
      .map((record) => record.pid)
  );
  const observedHandles = handles ?? getActiveHandles();
  const filteredRecords = records.filter((record) => !diagnosticProcessIds.has(record.pid));
  const root = filteredRecords.find((record) => record.pid === rootPid);
  return {
    activeResources: summarizeActiveResources({
      handles: observedHandles.filter((handle) => !diagnosticProcessIds.has(handle?.pid)),
      requests
    }),
    processGroupId: root?.processGroupId ?? null,
    processes: selectProcessAncestry(filteredRecords, {
      processGroupId: root?.processGroupId,
      rootPid
    }),
    rootPid
  };
}

export async function readProcessTable() {
  const { stdout } = await execFileAsync(
    "/bin/ps",
    ["-ax", "-ww", "-o", "pid=,ppid=,pgid=,lstart=,comm="],
    { encoding: "utf8", timeout: 2_000 }
  );
  return parseProcessTable(stdout);
}

function describeHandle(handle) {
  const description = { type: resourceType(handle) };
  if (typeof handle?.hasRef === "function") {
    description.hasRef = Boolean(handle.hasRef());
  }
  for (const field of ["connecting", "destroyed", "readable", "writable", "killed"]) {
    if (typeof handle?.[field] === "boolean") {
      description[field] = handle[field];
    }
  }
  if (Number.isSafeInteger(handle?.pid) && handle.pid > 0) {
    description.pid = handle.pid;
  }
  for (const field of ["exitCode", "signalCode"]) {
    if (handle?.[field] === null || typeof handle?.[field] === "number" || typeof handle?.[field] === "string") {
      description[field] = handle[field];
    }
  }
  return description;
}

function getActiveHandles() {
  return typeof process._getActiveHandles === "function" ? process._getActiveHandles() : [];
}

function getActiveRequests() {
  return typeof process._getActiveRequests === "function" ? process._getActiveRequests() : [];
}

function lineageFor(pid, byPid) {
  const reversed = [];
  const visited = new Set();
  let cursor = byPid.get(pid);
  while (cursor !== undefined && !visited.has(cursor.pid)) {
    visited.add(cursor.pid);
    reversed.push(cursor.pid);
    cursor = byPid.get(cursor.parentPid);
  }
  return reversed.reverse();
}

function resourceType(resource) {
  const name = resource?.constructor?.name;
  return typeof name === "string" && name.length > 0 ? name : "Unknown";
}

function executableIdentity(raw) {
  return raw.trim().split(/\s+/u, 1)[0];
}
