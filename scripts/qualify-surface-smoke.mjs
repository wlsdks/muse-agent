#!/usr/bin/env node

import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import net from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { waitForOwnedBrowserExit } from "./lib/owned-browser-process.mjs";
import {
  bindOwnedProcessGroup,
  forceOwnedProcessGroup,
  OwnedProcessGroupStillRunningError,
  ownedProcessGroupMembers,
  signalOwnedProcessRoot,
  waitForOwnedProcessGroupExit
} from "./lib/owned-process-group.mjs";
import {
  aggregateSurfacePass3,
  parseBrowserSmokeOutput,
  parseCliSmokeOutput,
  parsePersonalAgentE2eOutput,
  projectCleanProcessReport,
  TASK_048_REPORT_SCHEMA
} from "./lib/task-048-surface-pass3.mjs";
import {
  reclaimUnboundDetachedProcessGroup
} from "./lib/reclaim-unbound-process-group.mjs";

const execFileAsync = promisify(execFile);
const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const artifactPath = join(
  rootDir,
  ".muse-dev",
  "evals",
  "personal-agent-roadmap",
  "task-048.json"
);
const expectedPlaywrightTests = 2;
const k = 3;
const inputFiles = [
  "apps/web/e2e/personal-agent/fixture-isolation.spec.ts",
  "apps/web/e2e/personal-agent/surface-parity.spec.ts",
  "apps/web/playwright.personal-agent.config.ts",
  "package.json",
  "packages/browser/src/puppeteer-controller.ts",
  "scripts/fixtures/personal-agent-embedding-stub.mjs",
  "scripts/lib/in-process-api.mjs",
  "scripts/lib/owned-browser-process.mjs",
  "scripts/lib/owned-process-group.mjs",
  "scripts/lib/owned-resource-scope.mjs",
  "scripts/lib/owned-resource-signals.mjs",
  "scripts/lib/process-lifecycle-diagnostics.mjs",
  "scripts/lib/reclaim-unbound-process-group.mjs",
  "scripts/lib/task-048-surface-pass3.mjs",
  "scripts/qualify-surface-smoke.mjs",
  "scripts/reclaim-unbound-process-group.test.mjs",
  "scripts/run-personal-agent-e2e.mjs",
  "scripts/smoke-browser.mjs",
  "scripts/smoke-cli.mjs",
  "scripts/task-048-surface-pass3.test.mjs"
];

const startHead = await gitHead();
const inputHashStart = await hashInputs();
const reports = [];
let primaryError;

try {
  await buildSmokeInputs();
  for (let iteration = 1; iteration <= k; iteration += 1) {
    console.log(`qualify:surface-smoke pass ${iteration.toString()}/${k.toString()} browser`);
    reports.push(await runBrowserTrial(iteration));
    console.log(`qualify:surface-smoke pass ${iteration.toString()}/${k.toString()} cli`);
    reports.push(await runCliTrial(iteration));
    console.log(`qualify:surface-smoke pass ${iteration.toString()}/${k.toString()} api+web`);
    const shared = await runApiWebTrial(iteration);
    reports.push(shared.api, shared.web);
  }
} catch (error) {
  primaryError = error;
}

const endHead = await gitHead();
const inputHashEnd = await hashInputs();
const aggregate = aggregateSurfacePass3({
  inputHashEnd,
  inputHashStart,
  reports,
  source: { endHead, startHead }
});
const result = primaryError === undefined && aggregate.result === "pass"
  ? "pass"
  : "fail";
await mkdir(dirname(artifactPath), { recursive: true });
await writeFile(artifactPath, `${JSON.stringify({
  generatedAt: new Date().toISOString(),
  inputFiles,
  inputHashEnd,
  inputHashStart,
  k,
  aggregate,
  reports,
  result,
  schema: TASK_048_REPORT_SCHEMA,
  source: { endHead, startHead },
  taskId: "048",
  ...(primaryError === undefined ? {} : { error: errorMessage(primaryError) })
}, null, 2)}\n`, "utf8");

if (result !== "pass") {
  throw primaryError ?? new Error("Task048 surface smoke qualification failed");
}
console.log("qualify:surface-smoke PASS (Browser/CLI/API/Web pass^3; process/port/temp/profile residue 0)");

async function buildSmokeInputs() {
  for (const workspace of ["@muse/browser", "@muse/api", "@muse/cli"]) {
    await execFileAsync("pnpm", ["--filter", workspace, "build"], {
      cwd: rootDir,
      encoding: "utf8",
      maxBuffer: 2_000_000,
      timeout: 240_000
    });
  }
}

async function runBrowserTrial(iteration) {
  const command = "node scripts/smoke-browser.mjs";
  const run = await runOwnedCommand({
    args: ["scripts/smoke-browser.mjs"],
    command: process.execPath,
    env: {
      ...process.env,
      MUSE_BROWSER_SMOKE_FAULT_CASE: "pass",
      MUSE_BROWSER_SMOKE_QUALIFICATION: "1"
    },
    name: `browser-${iteration.toString()}`,
    timeoutMs: 600_000
  });
  const diagnostic = parseBrowserSmokeOutput(run.output);
  await Promise.all(diagnostic.browserReceipts.map((receipt) =>
    waitForOwnedBrowserExit(receipt, { timeoutMs: 5_000 })
  ));
  const ports = await observeClosedPorts(diagnostic.ports);
  const tempResidue = await countExistingPaths([diagnostic.tempRoot]);
  const profileResidue = await countExistingPaths(diagnostic.profiles);
  const portResidue = ports.filter((port) => !port.closed).length;
  assert(portResidue === 0, `browser-${iteration.toString()}: owned port remained open`);
  assert(tempResidue === 0, `browser-${iteration.toString()}: temp residue remained`);
  assert(profileResidue === 0, `browser-${iteration.toString()}: profile residue remained`);
  return projectCleanProcessReport({
    finishedAt: run.finishedAt,
    noSkip: true,
    provenance: {
      command,
      kind: "browser-smoke",
      runId: `task048-browser-${iteration.toString()}`
    },
    resources: {
      ownedProcessResidue: 0,
      ports,
      profileResidue,
      tempResidue
    },
    runId: `task048-browser-${iteration.toString()}`,
    startedAt: run.startedAt,
    surface: "browser",
    terminal: run.terminal,
    trial: iteration
  });
}

async function runCliTrial(iteration) {
  const command = "node scripts/smoke-cli.mjs";
  const run = await runOwnedCommand({
    args: ["scripts/smoke-cli.mjs"],
    command: process.execPath,
    env: {
      ...process.env,
      MUSE_CLI_SMOKE_LIFECYCLE_DIAGNOSTICS: "1",
      MUSE_CLI_SMOKE_QUALIFICATION: "1"
    },
    name: `cli-${iteration.toString()}`,
    timeoutMs: 120_000
  });
  const { owned } = parseCliSmokeOutput(run.output);
  const ports = await observeClosedPorts([{ name: "api", port: owned.apiPort }]);
  const portResidue = ports.filter((port) => !port.closed).length;
  const tempResidue = await countExistingPaths([owned.schedulerRoot]);
  assert(portResidue === 0, `cli-${iteration.toString()}: API port remained open`);
  assert(tempResidue === 0, `cli-${iteration.toString()}: scheduler root remained`);
  return projectCleanProcessReport({
    finishedAt: run.finishedAt,
    noSkip: true,
    provenance: {
      command,
      kind: "cli-smoke",
      runId: `task048-cli-${iteration.toString()}`
    },
    resources: {
      ownedProcessResidue: 0,
      ports,
      profileResidue: 0,
      tempResidue
    },
    runId: `task048-cli-${iteration.toString()}`,
    startedAt: run.startedAt,
    surface: "cli",
    terminal: run.terminal,
    trial: iteration
  });
}

async function runApiWebTrial(iteration) {
  const command = "node scripts/run-personal-agent-e2e.mjs";
  const runId = `task048-api-web-${iteration.toString()}`;
  const run = await runOwnedCommand({
    args: ["scripts/run-personal-agent-e2e.mjs"],
    command: process.execPath,
    env: {
      ...process.env,
      MUSE_PERSONAL_AGENT_E2E_LIFECYCLE_DIAGNOSTICS: "1",
      MUSE_PERSONAL_AGENT_E2E_RUN_ID: runId
    },
    name: runId,
    timeoutMs: 180_000
  });
  const { ownedState, qualification } = parsePersonalAgentE2eOutput(
    run.output,
    expectedPlaywrightTests
  );
  const playwrightResidue = (
    await ownedProcessGroupMembers(ownedState.playwrightReceipt)
  ).length;
  const ports = [
    { name: "api", port: Number(new URL(ownedState.apiUrl).port) },
    { name: "embed", port: Number(new URL(ownedState.embedUrl).port) },
    { name: "web", port: Number(new URL(ownedState.webUrl).port) }
  ];
  const observedPorts = await observeClosedPorts(ports);
  const portResidue = observedPorts.filter((port) => !port.closed).length;
  const tempResidue = await countExistingPaths([ownedState.stateRoot]);
  assert(playwrightResidue === 0, `${runId}: Playwright group residue remained`);
  assert(portResidue === 0, `${runId}: API/Web/embed port residue remained`);
  assert(tempResidue === 0, `${runId}: state/profile residue remained`);
  const shared = {
    command,
    kind: "personal-agent-e2e",
    playwright: qualification.playwright,
    runId,
    sharedSurfaces: ["api", "web"]
  };
  return {
    api: projectCleanProcessReport({
      finishedAt: run.finishedAt,
      noSkip: true,
      provenance: shared,
      resources: {
        ownedProcessResidue: playwrightResidue,
        ports: observedPorts.filter((port) => port.name !== "web"),
        profileResidue: 0,
        tempResidue
      },
      runId,
      startedAt: run.startedAt,
      surface: "api",
      terminal: run.terminal,
      trial: iteration
    }),
    web: projectCleanProcessReport({
      finishedAt: run.finishedAt,
      noSkip: true,
      provenance: shared,
      resources: {
        ownedProcessResidue: playwrightResidue,
        ports: observedPorts.filter((port) => port.name === "web"),
        profileResidue: 0,
        tempResidue
      },
      runId,
      startedAt: run.startedAt,
      surface: "web",
      terminal: run.terminal,
      trial: iteration
    })
  };
}

async function runOwnedCommand({ args, command, env, name, timeoutMs }) {
  const startedAt = new Date().toISOString();
  const child = spawn(command, args, {
    cwd: rootDir,
    detached: true,
    env,
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout = `${stdout}${chunk.toString()}`.slice(-4_000_000);
  });
  child.stderr.on("data", (chunk) => {
    stderr = `${stderr}${chunk.toString()}`.slice(-4_000_000);
  });
  const terminal = new Promise((resolveTerminal) => {
    child.once("close", (code, signal) => resolveTerminal({ code, signal }));
  });
  let receipt;
  try {
    receipt = await bindOwnedProcessGroup(child.pid);
    const ended = await withTimeout(
      terminal,
      timeoutMs,
      `${name}: command exceeded ${timeoutMs.toString()}ms`
    );
    assert(ended.code === 0, `${name}: exit ${String(ended.code)}\n${stderr.slice(-4_000)}`);
    assert(ended.signal === null, `${name}: signal ${String(ended.signal)}`);
    await waitForOwnedProcessGroupExit(receipt, { timeoutMs: 10_000 });
    return {
      finishedAt: new Date().toISOString(),
      output: `${stdout}\n${stderr}`,
      startedAt,
      terminal: {
        bounded: true,
        exitCode: ended.code,
        signal: ended.signal,
        timedOut: false,
        timeoutMs
      }
    };
  } finally {
    if (receipt !== undefined) {
      await reclaimOwnedGroup(receipt);
    } else {
      await reclaimUnboundDetachedProcessGroup({
        processGroupId: child.pid,
        terminal
      });
    }
  }
}

async function reclaimOwnedGroup(receipt) {
  const members = await ownedProcessGroupMembers(receipt);
  if (members.length === 0) return;
  await signalOwnedProcessRoot(receipt, "SIGTERM");
  try {
    await waitForOwnedProcessGroupExit(receipt, { timeoutMs: 5_000 });
  } catch (error) {
    if (!(error instanceof OwnedProcessGroupStillRunningError)) throw error;
    await forceOwnedProcessGroup(receipt, "SIGKILL", { memberReceipts: members });
    await waitForOwnedProcessGroupExit(receipt, { timeoutMs: 5_000 });
  }
}

async function observeClosedPorts(ports) {
  const states = await Promise.all(ports.map(({ port }) =>
    canConnect("127.0.0.1", port)
  ));
  return ports.map((port, index) => ({ ...port, closed: !states[index] }));
}

async function canConnect(host, port) {
  return await new Promise((resolveConnect) => {
    const socket = net.createConnection({ host, port });
    const finish = (value) => {
      socket.destroy();
      resolveConnect(value);
    };
    socket.setTimeout(250);
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.once("timeout", () => finish(false));
  });
}

async function countExistingPaths(paths) {
  const states = await Promise.all(paths.map((path) =>
    access(path).then(() => true, () => false)
  ));
  return states.filter(Boolean).length;
}

async function gitHead() {
  return (await execFileAsync("git", ["rev-parse", "HEAD"], {
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
