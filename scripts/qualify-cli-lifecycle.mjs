import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { clearTimeout, setTimeout } from "node:timers";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  matchesProcessIdentity,
  parseLifecycleDiagnosticOutput,
  readProcessTable
} from "./lib/process-lifecycle-diagnostics.mjs";

const execFileAsync = promisify(execFile);
const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const artifactPath = join(rootDir, ".muse-dev", "evals", "personal-agent-roadmap", "task-041.json");
const trialCount = 3;
const trialTimeoutMs = 120_000;
const postSummaryExitGraceMs = 5_000;

console.log("qualify:cli-lifecycle build");
await execFileAsync("pnpm", ["--filter", "@muse/cli", "build"], {
  cwd: rootDir,
  encoding: "utf8",
  maxBuffer: 1_000_000,
  timeout: 120_000
});

const trials = [];
for (let trial = 1; trial <= trialCount; trial += 1) {
  console.log(`qualify:cli-lifecycle trial ${trial.toString()}/${trialCount.toString()}`);
  trials.push(await runTrial(trial));
}

const reproduced = trials.filter((trial) => trial.outcome === "post-summary-timeout").length;
const result = reproduced > 0 ? "reproduced-current" : "historical-failure-not-reproduced";
await writeArtifact({ result, trials });
console.log(
  reproduced > 0
    ? `qualify:cli-lifecycle PASS (reproduced ${reproduced.toString()}/${trialCount.toString()})`
    : `qualify:cli-lifecycle PASS (historical hang not reproduced, ${trialCount.toString()}/${trialCount.toString()} exited)`
);

async function runTrial(trial) {
  const child = spawn(process.execPath, ["scripts/smoke-cli.mjs"], {
    cwd: rootDir,
    detached: true,
    env: {
      ...process.env,
      MUSE_CLI_SMOKE_LIFECYCLE_DIAGNOSTICS: "1"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let output = "";
  const postSummaryDiagnosticReady = Promise.withResolvers();
  const capture = (chunk) => {
    output = `${output}${chunk.toString()}`.slice(-1_000_000);
    if (
      /(?:^|\n)10 passed, 0 failed(?:\n|$)/u.test(output)
      && parseLifecycleDiagnosticOutput(output) !== undefined
    ) {
      postSummaryDiagnosticReady.resolve();
    }
  };
  child.stdout.on("data", capture);
  child.stderr.on("data", capture);
  const terminalPromise = new Promise((resolveTerminal) => {
    child.once("exit", (code, signal) => resolveTerminal({ code, signal }));
  });
  const birth = await waitForBirth(child.pid);
  let terminal;
  let timedOut = false;
  const signals = [];
  try {
    terminal = await withTimeout(
      Promise.race([
        terminalPromise,
        postSummaryDiagnosticReady.promise.then(() => withTimeout(
          terminalPromise,
          postSummaryExitGraceMs,
          "post-summary-timeout"
        ))
      ]),
      trialTimeoutMs,
      "outer-timeout"
    );
  } catch (error) {
    if (!(error instanceof Error) || error.message !== "post-summary-timeout") {
      await terminateExactProcessGroup(birth, signals);
      throw error;
    }
    timedOut = true;
    await terminateExactProcessGroup(birth, signals);
    terminal = await withTimeout(terminalPromise, 10_000, "owned CLI smoke did not exit after exact cleanup");
  }

  const summaryPrinted = /(?:^|\n)10 passed, 0 failed(?:\n|$)/u.test(output);
  const diagnostic = parseLifecycleDiagnosticOutput(output);
  if (!timedOut && (terminal.code !== 0 || terminal.signal !== null)) {
    throw new Error(
      `CLI smoke trial ${trial.toString()} exited unexpectedly: code=${String(terminal.code)} signal=${String(terminal.signal)}`
    );
  }
  if (!summaryPrinted) {
    throw new Error(`CLI smoke trial ${trial.toString()} did not print its exact 10 PASS summary`);
  }
  if (diagnostic === undefined) {
    throw new Error(`CLI smoke trial ${trial.toString()} emitted no lifecycle diagnostic`);
  }
  const findingCount = diagnostic.activeResources.handles.length
    + diagnostic.activeResources.requests.length
    + diagnostic.processes.filter((processRecord) => processRecord.relationship !== "root").length;
  if (timedOut && findingCount === 0) {
    throw new Error(`CLI smoke trial ${trial.toString()} timed out after its summary without an exact lifecycle finding`);
  }

  const groupResidue = await processGroupMembers(birth.processGroupId);
  if (groupResidue.length > 0) {
    await terminateExactProcessGroup(birth, signals, { allowExitedRoot: true });
  }
  const tempResidueObserved = await pathExists(diagnostic.schedulerRoot);
  await removeExactSchedulerRoot(diagnostic.schedulerRoot);
  const finalGroupResidue = await processGroupMembers(birth.processGroupId);
  const finalTempResidue = await pathExists(diagnostic.schedulerRoot);
  if (finalGroupResidue.length > 0 || finalTempResidue) {
    throw new Error(`CLI smoke trial ${trial.toString()} left exact-owned process or temp residue`);
  }

  return {
    diagnostic,
    exitCode: terminal.code,
    exitSignal: terminal.signal,
    finishedAt: new Date().toISOString(),
    outcome: timedOut ? "post-summary-timeout" : "exited",
    ownedGroupResidueObserved: groupResidue.length,
    signals,
    summaryPrinted,
    tempResidueObserved,
    trial
  };
}

async function waitForBirth(pid) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const record = (await readProcessTable()).find((candidate) => candidate.pid === pid);
    if (record !== undefined) {
      if (record.processGroupId !== pid) {
        throw new Error(`CLI qualifier child ${pid.toString()} did not receive its exact process group`);
      }
      return Object.freeze({ ...record });
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
  throw new Error(`Could not bind CLI qualifier child ${pid.toString()} to its OS birth identity`);
}

async function terminateExactProcessGroup(receipt, signals, { allowExitedRoot = false } = {}) {
  const records = await readProcessTable();
  const root = records.find((record) => record.pid === receipt.pid);
  const members = records.filter((record) => record.processGroupId === receipt.processGroupId);
  if (root !== undefined && !matchesProcessIdentity(receipt, root)) {
    throw new Error(`CLI qualifier child ${receipt.pid.toString()} no longer matches its birth identity`);
  }
  if (root === undefined && (!allowExitedRoot || members.length === 0)) return;
  signalExactGroup(receipt.processGroupId, "SIGTERM", signals);
  if (await waitForGroupExit(receipt.processGroupId, 5_000)) return;
  signalExactGroup(receipt.processGroupId, "SIGKILL", signals);
  if (!(await waitForGroupExit(receipt.processGroupId, 5_000))) {
    throw new Error(`Exact-owned CLI process group ${receipt.processGroupId.toString()} remained after SIGKILL`);
  }
}

function signalExactGroup(processGroupId, signal, signals) {
  try {
    process.kill(-processGroupId, signal);
    signals.push({ processGroupId, signal });
  } catch (error) {
    if (!error || typeof error !== "object" || error.code !== "ESRCH") throw error;
  }
}

async function waitForGroupExit(processGroupId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await processGroupMembers(processGroupId)).length === 0) return true;
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  return (await processGroupMembers(processGroupId)).length === 0;
}

async function processGroupMembers(processGroupId) {
  return (await readProcessTable()).filter((record) => record.processGroupId === processGroupId);
}

async function removeExactSchedulerRoot(schedulerRoot) {
  const resolvedRoot = resolve(schedulerRoot);
  if (
    dirname(resolvedRoot) !== resolve(tmpdir())
    || !basename(resolvedRoot).startsWith("muse-smoke-cli-scheduler-")
  ) {
    throw new Error("Refusing to remove a scheduler path without the exact smoke-owned temp prefix");
  }
  await rm(resolvedRoot, { force: true, recursive: true });
}

async function pathExists(path) {
  return access(path).then(() => true, () => false);
}

async function writeArtifact({ result, trials }) {
  const head = (await execFileAsync("git", ["rev-parse", "HEAD"], {
    cwd: rootDir,
    encoding: "utf8"
  })).stdout.trim();
  const inputFiles = [
    "scripts/lib/process-lifecycle-diagnostics.mjs",
    "scripts/process-lifecycle-diagnostics.test.mjs",
    "scripts/qualify-cli-lifecycle.mjs",
    "scripts/smoke-cli.mjs"
  ];
  const inputHash = createHash("sha256");
  for (const file of inputFiles) {
    inputHash.update(file);
    inputHash.update(await readFile(join(rootDir, file)));
  }
  await mkdir(dirname(artifactPath), { recursive: true });
  await writeFile(artifactPath, `${JSON.stringify({
    generatedAt: new Date().toISOString(),
    head,
    inputFiles,
    inputHash: inputHash.digest("hex"),
    result,
    taskId: "041",
    trials
  }, null, 2)}\n`, "utf8");
}

function withTimeout(operation, timeoutMs, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  return Promise.race([operation, timeout]).finally(() => clearTimeout(timer));
}
