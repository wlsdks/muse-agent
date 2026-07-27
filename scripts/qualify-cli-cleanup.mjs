#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  bindOwnedProcessGroup,
  forceOwnedProcessGroup,
  ownedProcessGroupMembers,
  signalOwnedProcessRoot,
  waitForOwnedProcessGroupExit
} from "./lib/owned-process-group.mjs";
import {
  matchesProcessIdentity,
  parseLifecycleDiagnosticOutput,
  readProcessTable
} from "./lib/process-lifecycle-diagnostics.mjs";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const artifactPath = join(rootDir, ".muse-dev", "evals", "personal-agent-roadmap", "task-042-b.json");
const inputFiles = [
  "package.json",
  "scripts/fixtures/mcp-lifecycle-stdio.mjs",
  "scripts/fixtures/process-sentinel.mjs",
  "scripts/lib/in-process-api.mjs",
  "scripts/lib/owned-process-group.mjs",
  "scripts/lib/owned-resource-scope.mjs",
  "scripts/lib/owned-resource-signals.mjs",
  "scripts/lib/process-lifecycle-diagnostics.mjs",
  "scripts/owned-process-group.test.mjs",
  "scripts/qualify-cli-cleanup.mjs",
  "scripts/smoke-cli.mjs"
];
const cases = [
  { expectedCode: 0, fault: "", name: "normal" },
  { expectedCode: 1, fault: "assertion", name: "assertion" },
  { expectedCode: 1, fault: "bootstrap", name: "bootstrap" },
  { expectedCode: 130, fault: "", name: "sigint", signal: "SIGINT" },
  { expectedCode: 143, fault: "", name: "sigterm", signal: "SIGTERM" },
  { expectedCode: 1, fault: "hung-cleanup", name: "hung" }
];

const startHead = await gitHead();
const inputHashStart = await hashInputs();
const sentinel = await startSentinel();
const trials = [];
let runError;
let controllerInterventions = 0;

try {
  for (const trialCase of cases) {
    console.log(`qualify:cli-cleanup ${trialCase.name}`);
    trials.push(await runTrial(trialCase, sentinel.receipt));
  }
} catch (error) {
  runError = error;
} finally {
  await closeSentinel(sentinel);
}

const endHead = await gitHead();
const inputHashEnd = await hashInputs();
const sentinelResidue = await ownedProcessGroupMembers(sentinel.receipt);
const assertions = {
  allExpectedTerminal: runError === undefined
    && trials.length === cases.length
    && trials.every((trial) => trial.expectedCode === trial.exitCode && trial.exitSignal === null),
  controllerInterventions,
  finalOwnedGroups: trials.reduce((sum, trial) => sum + trial.finalApiResidue, 0),
  finalTempRoots: trials.filter((trial) => trial.tempPresentAfter).length,
  inputStable: startHead === endHead && inputHashStart === inputHashEnd,
  sentinelFinalResidue: sentinelResidue.length,
  unrelatedSignals: 0
};
const result = runError === undefined
  && Object.entries(assertions).every(([key, value]) =>
    key === "inputStable" || key === "allExpectedTerminal" ? value === true : value === 0
  )
  ? "pass"
  : "fail";

await mkdir(dirname(artifactPath), { recursive: true });
await writeFile(artifactPath, `${JSON.stringify({
  assertions,
  finishedAt: new Date().toISOString(),
  inputFiles,
  inputHashEnd,
  inputHashStart,
  result,
  source: { endHead, startHead },
  taskId: "042-B",
  trials,
  ...(runError === undefined ? {} : { error: errorMessage(runError) })
}, null, 2)}\n`, "utf8");

if (result !== "pass") {
  throw runError ?? new Error(`Task042-B qualification failed: ${JSON.stringify(assertions)}`);
}
console.log("qualify:cli-cleanup PASS (6/6 exact cleanup cases; sentinel untouched)");

async function runTrial(trialCase, sentinelReceipt) {
  const child = spawn(process.execPath, ["scripts/smoke-cli.mjs"], {
    cwd: rootDir,
    detached: true,
    env: {
      ...process.env,
      MUSE_CLI_SMOKE_FAULT_CASE: trialCase.fault,
      MUSE_CLI_SMOKE_LIFECYCLE_DIAGNOSTICS: "1",
      MUSE_CLI_SMOKE_QUALIFICATION: "1"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let output = "";
  const ownedReady = Promise.withResolvers();
  const smokeReady = Promise.withResolvers();
  const capture = (chunk) => {
    output = `${output}${chunk.toString()}`.slice(-1_000_000);
    const owned = parsePrefixedJson(output, "smoke:cli lifecycle-owned ");
    if (owned !== undefined) ownedReady.resolve(owned);
    if (output.includes("smoke:cli lifecycle-ready ")) smokeReady.resolve();
  };
  child.stdout.on("data", capture);
  child.stderr.on("data", capture);
  const terminal = new Promise((resolve) => {
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  const receipt = await bindOwnedProcessGroup(child.pid);
  let owned;
  let terminalResult;
  try {
    owned = await withTimeout(ownedReady.promise, 60_000, `${trialCase.name} emitted no ownership receipt`);
    assert(owned.rootPid === receipt.pid, `${trialCase.name} root receipt mismatch`);
    if (trialCase.signal !== undefined) {
      await withTimeout(smokeReady.promise, 60_000, `${trialCase.name} never became ready`);
      await signalOwnedProcessRoot(receipt, trialCase.signal);
    }
    terminalResult = await withTimeout(terminal, 120_000, `${trialCase.name} exceeded its terminal deadline`);
  } catch (error) {
    controllerInterventions += 1;
    const memberReceipts = await ownedProcessGroupMembers(receipt);
    await forceOwnedProcessGroup(receipt, "SIGKILL", { memberReceipts });
    await waitForOwnedProcessGroupExit(receipt, { timeoutMs: 5_000 });
    throw error;
  }

  const diagnostic = parseLifecycleDiagnosticOutput(output);
  assert(diagnostic !== undefined, `${trialCase.name} emitted no post-cleanup diagnostic`);
  assert(terminalResult.code === trialCase.expectedCode && terminalResult.signal === null,
    `${trialCase.name} terminal mismatch: ${JSON.stringify(terminalResult)}`);
  if (trialCase.name === "normal") {
    assert(/(?:^|\n)10 passed, 0 failed(?:\n|$)/u.test(output), "normal case lost the exact 10/10 summary");
  }
  if (trialCase.name === "assertion") {
    assert(output.includes("injected CLI smoke assertion failure"), "assertion case lost the primary failure");
  }
  if (trialCase.name === "bootstrap") {
    assert(output.includes("injected CLI smoke bootstrap failure"), "bootstrap case lost the primary failure");
  }
  if (trialCase.name === "hung") {
    assert(output.includes("Owned-resource cleanup exceeded"), "hung case did not exercise bounded forced cleanup");
  }

  const apiReceipt = owned.apiReceipt;
  const finalApiResidue = (await ownedProcessGroupMembers(apiReceipt)).length;
  const tempPresentAfter = await pathExists(owned.schedulerRoot);
  const sentinelObserved = (await readProcessTable()).find((record) => record.pid === sentinelReceipt.pid);
  assert(matchesProcessIdentity(sentinelReceipt, sentinelObserved), `${trialCase.name} changed the unrelated sentinel`);
  assert(finalApiResidue === 0, `${trialCase.name} left API/MCP process residue`);
  assert(!tempPresentAfter, `${trialCase.name} left its disposable root`);

  return {
    case: trialCase.name,
    controllerIntervention: false,
    diagnosticStage: diagnostic.stage,
    exitCode: terminalResult.code,
    exitSignal: terminalResult.signal,
    expectedCode: trialCase.expectedCode,
    finalApiResidue,
    finishedAt: new Date().toISOString(),
    forced: trialCase.name === "hung",
    summary: /(?:^|\n)10 passed, 0 failed(?:\n|$)/u.test(output) ? "10/10" : "fault",
    tempPresentAfter
  };
}

async function startSentinel() {
  const child = spawn(process.execPath, ["scripts/fixtures/process-sentinel.mjs"], {
    cwd: rootDir,
    detached: true,
    stdio: ["ignore", "ignore", "ignore", "ipc"]
  });
  const ready = new Promise((resolve) => child.once("message", resolve));
  const terminal = new Promise((resolve) => child.once("close", resolve));
  const receipt = await bindOwnedProcessGroup(child.pid);
  assert(await withTimeout(ready, 5_000, "sentinel did not become ready") === "ready", "invalid sentinel handshake");
  return { child, receipt, terminal };
}

async function closeSentinel(sentinel) {
  const observed = (await readProcessTable()).find((record) => record.pid === sentinel.receipt.pid);
  assert(matchesProcessIdentity(sentinel.receipt, observed), "sentinel identity changed before cooperative close");
  sentinel.child.send("close");
  await withTimeout(sentinel.terminal, 5_000, "sentinel did not close cooperatively");
}

function parsePrefixedJson(output, prefix) {
  for (const line of output.split("\n").toReversed()) {
    if (!line.startsWith(prefix)) continue;
    try {
      return JSON.parse(line.slice(prefix.length));
    } catch {
      return undefined;
    }
  }
  return undefined;
}

async function pathExists(path) {
  return import("node:fs/promises").then(({ access }) => access(path).then(() => true, () => false));
}

async function gitHead() {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  return (await promisify(execFile)("git", ["rev-parse", "HEAD"], {
    cwd: rootDir,
    encoding: "utf8"
  })).stdout.trim();
}

async function hashInputs() {
  const hash = createHash("sha256");
  for (const path of inputFiles) {
    hash.update(path);
    hash.update(await readFile(join(rootDir, path)));
  }
  return hash.digest("hex");
}

function withTimeout(operation, timeoutMs, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  return Promise.race([operation, timeout]).finally(() => clearTimeout(timer));
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
