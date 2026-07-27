#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import net from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { execFile } from "node:child_process";

import {
  bindOwnedProcessGroup,
  ownedProcessGroupMembers,
  signalOwnedProcessRoot,
  waitForOwnedProcessGroupExit
} from "./lib/owned-process-group.mjs";

const execFileAsync = promisify(execFile);
const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const runner = join(rootDir, "scripts", "run-personal-agent-e2e.mjs");
const artifactPath = join(
  rootDir,
  ".muse-dev",
  "evals",
  "personal-agent-roadmap",
  "task-046-d.json"
);
const inputFiles = [
  "apps/web/e2e/personal-agent/fixture-isolation.spec.ts",
  "apps/web/playwright.personal-agent.config.ts",
  "package.json",
  "scripts/qualify-personal-agent-e2e-lifecycle.mjs",
  "scripts/fixtures/personal-agent-embedding-stub.mjs",
  "scripts/run-personal-agent-e2e.mjs",
  "scripts/run-personal-agent-e2e.test.mjs",
  "scripts/test-changed.mjs"
];

const startHead = await gitHead();
const inputHashStart = await hashInputs();
const trials = [];
let primaryError;

try {
  trials.push(await runTrial("normal", {}, { expectedCode: 0 }));
  trials.push(await runTrial(
    "failure",
    { MUSE_PERSONAL_AGENT_E2E_FORCE_FAILURE: "1" },
    { expectedCode: 1 }
  ));
  trials.push(await runTrial("sigterm", {}, { expectedCode: 143, signal: "SIGTERM" }));
} catch (error) {
  primaryError = error;
}

const endHead = await gitHead();
const inputHashEnd = await hashInputs();
const result = primaryError === undefined
  && trials.length === 3
  && trials.every((trial) =>
    trial.apiPortClosed
    && trial.embedPortClosed
    && trial.ownedGroupResidue === 0
    && trial.stateRootResidue === 0
    && trial.webPortClosed
  )
  && startHead === endHead
  && inputHashStart === inputHashEnd
  ? "pass"
  : "fail";
await mkdir(dirname(artifactPath), { recursive: true });
await writeFile(artifactPath, `${JSON.stringify({
  generatedAt: new Date().toISOString(),
  inputFiles,
  inputHashEnd,
  inputHashStart,
  result,
  source: { endHead, startHead },
  taskId: "046-D",
  trials,
  ...(primaryError === undefined ? {} : { error: errorMessage(primaryError) })
}, null, 2)}\n`, "utf8");

if (result !== "pass") throw primaryError ?? new Error("Task046-D lifecycle qualification failed");
console.log("qualify:personal-agent-e2e-lifecycle PASS (normal/failure/SIGTERM; API/web/embed ports and temp/process residue 0)");

async function runTrial(name, envOverrides, contract) {
  const child = spawn(process.execPath, [runner], {
    cwd: rootDir,
    detached: true,
    env: {
      ...process.env,
      MUSE_PERSONAL_AGENT_E2E_LIFECYCLE_DIAGNOSTICS: "1",
      ...envOverrides
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  const terminal = new Promise((resolveTerminal) => {
    child.once("close", (code, signal) => resolveTerminal({ code, signal }));
  });
  const receipt = await bindOwnedProcessGroup(child.pid);
  const diagnostic = await waitForDiagnostic(() => stdout);
  if (contract.signal) {
    await signalOwnedProcessRoot(receipt, contract.signal);
  }
  const ended = await withTimeout(terminal, 180_000, `${name}: runner did not terminate`);
  assert(ended.signal === null, `${name}: runner ended by ${String(ended.signal)}`);
  assert(ended.code === contract.expectedCode, `${name}: exit ${String(ended.code)} != ${contract.expectedCode.toString()}`);
  await waitForOwnedProcessGroupExit(receipt, { timeoutMs: 10_000 });
  const [apiPortClosed, embedPortClosed, webPortClosed] = await Promise.all([
    waitForPortClosed(new URL(diagnostic.apiUrl)),
    waitForPortClosed(new URL(diagnostic.embedUrl)),
    waitForPortClosed(new URL(diagnostic.webUrl))
  ]);
  const stateRootResidue = await pathExists(diagnostic.stateRoot) ? 1 : 0;
  const ownedGroupResidue = (await ownedProcessGroupMembers(receipt)).length;
  assert(!stderr.includes("owner-secret"), `${name}: stderr exposed forbidden text`);
  return {
    apiPortClosed,
    code: ended.code,
    embedPortClosed,
    name,
    ownedGroupResidue,
    stateRootResidue,
    webPortClosed
  };
}

async function waitForDiagnostic(readStdout) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    for (const line of readStdout().split("\n")) {
      if (!line.includes('"type":"personal-agent-e2e-owned-state"')) continue;
      const parsed = JSON.parse(line);
      assert(typeof parsed.apiUrl === "string", "diagnostic missing apiUrl");
      assert(typeof parsed.embedUrl === "string", "diagnostic missing embedUrl");
      assert(typeof parsed.webUrl === "string", "diagnostic missing webUrl");
      assert(typeof parsed.stateRoot === "string", "diagnostic missing stateRoot");
      return parsed;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
  throw new Error("runner did not emit owned-state diagnostic");
}

async function waitForPortClosed(url) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (!await canConnect(url.hostname, Number(url.port))) return true;
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  return false;
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

async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") return false;
    throw error;
  }
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
