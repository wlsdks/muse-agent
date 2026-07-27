#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { execFile } from "node:child_process";

import {
  bindOwnedProcessGroup,
  forceOwnedProcessGroup,
  ownedProcessGroupMembers,
  waitForOwnedProcessGroupExit
} from "./lib/owned-process-group.mjs";
import {
  createDisposableApiEnvironment,
  ensureDisposableApiDirectories
} from "./lib/in-process-api.mjs";

const execFileAsync = promisify(execFile);
const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const cliEntry = join(rootDir, "apps", "cli", "dist", "index.js");
const artifactPath = join(rootDir, ".muse-dev", "evals", "personal-agent-roadmap", "task-043-a.json");
const inputFiles = [
  "apps/cli/src/cli-terminal-state.ts",
  "apps/cli/src/cli-terminal-state.test.ts",
  "apps/cli/src/commands-background.ts",
  "apps/cli/src/commands-background.test.ts",
  "apps/cli/src/commands-doctor.ts",
  "apps/cli/src/commands-qualify.ts",
  "apps/cli/src/commands-qualify.test.ts",
  "apps/cli/src/index.ts",
  "apps/cli/src/no-model-message.ts",
  "apps/cli/src/program-http.ts",
  "apps/cli/src/program.ts",
  "apps/cli/src/program-lazy.test.ts",
  "apps/cli/test/program.test.ts",
  "scripts/qualify-cli-terminal-contract.mjs",
  "scripts/smoke-cli.mjs"
];

const startHead = await gitHead();
const inputHashStart = await hashInputs();
const disposableRoot = await mkdtemp(join(tmpdir(), "muse-cli-terminal-contract-"));
const env = {
  ...createDisposableApiEnvironment({
    purpose: "cli-terminal-contract",
    rootDir: disposableRoot
  }),
  MUSE_CLI_CONFIG_FILE: join(disposableRoot, "config.json"),
  MUSE_MCP_CONFIG: join(disposableRoot, "mcp.json"),
  OLLAMA_BASE_URL: "http://127.0.0.1:1"
};
ensureDisposableApiDirectories(env);
let apiResponse = {
  body: { errorCode: "AGENT_RUN_FAILED", errorMessage: "synthetic internal failure" },
  status: 500
};
const server = createServer((_request, response) => {
  response.writeHead(apiResponse.status, { "content-type": "application/json" });
  response.end(JSON.stringify(apiResponse.body));
});
const trials = [];
let primaryError;

try {
  const baseUrl = await listen(server);

  trials.push(assertTrial("success-json", await runCli(["spec", "--json"], env), {
    code: 0,
    json: { agentCore: "model-agnostic" },
    stderr: ""
  }));

  const unknown = await runCli(["statu"], env);
  assert(unknown.code === 2, "unknown command did not exit with user-error code 2");
  assert(unknown.stdout === "", "human unknown command wrote stdout");
  assert(unknown.stderr.includes("Did you mean 'muse status'?"), "human unknown command lost grounded guidance");
  trials.push(summary("user-error-human", unknown, "user-error"));

  trials.push(assertTrial(
    "user-error-json",
    await runCli(["search", "x", "--site", "bad;site", "--json"], env),
    { code: 2, json: { ok: false, terminalState: "user-error", exitCode: 2 }, stderr: "" }
  ));

  apiResponse = {
    body: { errorCode: "GUARD_BLOCKED", errorMessage: "synthetic policy refusal" },
    status: 403
  };
  trials.push(assertTrial(
    "policy-block-json",
    await runCli(["--api-url", baseUrl, "mcp", "status", "--json"], env),
    {
      code: 3,
      json: {
        command: "mcp",
        ok: false,
        terminalState: "policy-block",
        exitCode: 3,
        error: { code: "GUARD_BLOCKED" }
      },
      stderr: ""
    }
  ));

  apiResponse = {
    body: { errorCode: "AGENT_RUN_FAILED", errorMessage: "synthetic internal failure" },
    status: 500
  };
  trials.push(assertTrial(
    "internal-failure-json",
    await runCli(["--api-url", baseUrl, "mcp", "status", "--json"], env),
    {
      code: 1,
      json: {
        command: "mcp",
        ok: false,
        terminalState: "internal-failure",
        exitCode: 1,
        error: { code: "AGENT_RUN_FAILED" }
      },
      stderr: ""
    }
  ));

  apiResponse = {
    body: { errorCode: "UPSTREAM_UNAVAILABLE", errorMessage: "synthetic dependency outage" },
    status: 503
  };
  trials.push(assertTrial(
    "dependency-unavailable-json",
    await runCli(["--api-url", baseUrl, "mcp", "status", "--json"], env),
    {
      code: 4,
      json: {
        command: "mcp",
        ok: false,
        terminalState: "unverified",
        exitCode: 4,
        error: { code: "UPSTREAM_UNAVAILABLE" }
      },
      stderr: ""
    }
  ));

  const unverified = await runCli(["doctor", "--grounding"], env);
  assert(unverified.code === 4, "required grounding skip did not exit with unverified code 4");
  assert(unverified.stderr === "", "unverified grounding wrote stderr");
  assert(unverified.stdout.includes("skipped") && unverified.stdout.includes("not a pass"),
    "unverified grounding lost its explicit skip report");
  trials.push(summary("unverified-human", unverified, "unverified"));
} catch (error) {
  primaryError = error;
} finally {
  await closeServer(server);
  await rm(disposableRoot, { force: true, recursive: true });
}

const endHead = await gitHead();
const inputHashEnd = await hashInputs();
const result = primaryError === undefined
  && trials.length === 7
  && trials.every((trial) => trial.ownedResidue === 0)
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
  taskId: "043-A",
  trials,
  ...(primaryError === undefined ? {} : { error: errorMessage(primaryError) })
}, null, 2)}\n`, "utf8");

if (result !== "pass") throw primaryError ?? new Error("Task043-A qualification failed");
console.log("qualify:cli-terminal-contract PASS (0/1/2/3/4; human + JSON; residue 0)");

async function runCli(args, childEnv) {
  const child = spawn(process.execPath, [cliEntry, ...args], {
    cwd: rootDir,
    detached: true,
    env: childEnv,
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
  const terminal = new Promise((resolve) => {
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  const receipt = await bindOwnedProcessGroup(child.pid);
  let terminalResult;
  try {
    terminalResult = await withTimeout(terminal, 60_000, `CLI trial timed out: ${args.join(" ")}`);
  } catch (error) {
    const memberReceipts = await ownedProcessGroupMembers(receipt);
    await forceOwnedProcessGroup(receipt, "SIGKILL", { memberReceipts });
    await waitForOwnedProcessGroupExit(receipt, { timeoutMs: 5_000 });
    throw error;
  }
  await waitForOwnedProcessGroupExit(receipt, { timeoutMs: 5_000 });
  const ownedResidue = (await ownedProcessGroupMembers(receipt)).length;
  assert(terminalResult.signal === null, `CLI trial ended by signal ${String(terminalResult.signal)}`);
  return { code: terminalResult.code, ownedResidue, stderr, stdout };
}

function assertTrial(name, trial, expected) {
  assert(trial.code === expected.code, `${name} exit ${String(trial.code)} != ${expected.code.toString()}`);
  assert(trial.stderr === expected.stderr, `${name} wrote unexpected stderr`);
  const parsed = JSON.parse(trial.stdout);
  assert(matchesSubset(parsed, expected.json), `${name} JSON did not match ${JSON.stringify(expected.json)}`);
  return summary(name, trial, expected.json.terminalState ?? "success");
}

function summary(name, trial, terminalState) {
  return {
    code: trial.code,
    name,
    ownedResidue: trial.ownedResidue,
    stderrBytes: Buffer.byteLength(trial.stderr),
    stdoutValues: trial.stdout.trim().length === 0 ? 0 : 1,
    terminalState
  };
}

function matchesSubset(actual, expected) {
  if (expected === null || typeof expected !== "object") return Object.is(actual, expected);
  if (actual === null || typeof actual !== "object") return false;
  return Object.entries(expected).every(([key, value]) => matchesSubset(actual[key], value));
}

async function listen(httpServer) {
  await new Promise((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(0, "127.0.0.1", resolve);
  });
  const address = httpServer.address();
  assert(typeof address === "object" && address !== null, "terminal qualifier server has no address");
  return `http://127.0.0.1:${address.port.toString()}`;
}

async function closeServer(httpServer) {
  if (!httpServer.listening) return;
  await new Promise((resolve, reject) => {
    httpServer.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
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
