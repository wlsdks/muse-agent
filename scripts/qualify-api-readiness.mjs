#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { buildServer } from "../apps/api/src/server.ts";
import {
  createDisposableApiEnvironment,
  ensureDisposableApiDirectories
} from "./lib/in-process-api.mjs";

const execFileAsync = promisify(execFile);
const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const artifactPath = join(
  rootDir,
  ".muse-dev",
  "evals",
  "personal-agent-roadmap",
  "task-044-a.json"
);
const inputFiles = [
  "apps/api/src/api-readiness.test.ts",
  "apps/api/src/api-readiness.ts",
  "apps/api/src/routes-core-chat.ts",
  "apps/api/src/server-http-plumbing.ts",
  "apps/api/src/server-options.ts",
  "apps/api/src/server.ts",
  "apps/api/test/server-http-plumbing.test.ts",
  "apps/api/test/server.contract.test.ts",
  "scripts/check-api-boot.mjs",
  "scripts/check-api-boot.test.mjs",
  "scripts/qualify-api-readiness.mjs"
];

const startHead = await gitHead();
const inputHashStart = await hashInputs();
const trials = [];
let primaryError;

try {
  trials.push(await runTrial("ready-local", {
    expectedReadyStatus: 200,
    expectedReasons: [],
    options: {
      agentRuntime: {},
      defaultModel: "diagnostic/readiness",
      localOnly: true,
      modelProvider: {}
    }
  }));
  trials.push(await runTrial("no-model", {
    expectedReadyStatus: 503,
    expectedReasons: ["model-unconfigured", "agent-runtime-unavailable"],
    options: { localOnly: true }
  }));
  trials.push(await runTrial("no-network", {
    expectedReadyStatus: 503,
    expectedReasons: ["network-unavailable"],
    options: {
      agentRuntime: {},
      defaultModel: "cloud/readiness",
      dependencyReadiness: { network: "unavailable" },
      localOnly: false,
      modelProvider: {}
    }
  }));
  trials.push(await runTrial("no-stores", {
    expectedReadyStatus: 503,
    expectedReasons: ["stores-unavailable"],
    options: {
      agentRuntime: {},
      defaultModel: "diagnostic/readiness",
      dependencyReadiness: { stores: "unavailable" },
      localOnly: true,
      modelProvider: {}
    }
  }));
} catch (error) {
  primaryError = error;
}

const endHead = await gitHead();
const inputHashEnd = await hashInputs();
const result = primaryError === undefined
  && trials.length === 4
  && trials.every((trial) => trial.livenessStatus === 200 && trial.tempResidue === 0)
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
  taskId: "044-A",
  trials,
  ...(primaryError === undefined ? {} : { error: errorMessage(primaryError) })
}, null, 2)}\n`, "utf8");

if (result !== "pass") throw primaryError ?? new Error("Task044-A qualification failed");
console.log("qualify:api-readiness PASS (ready/no-model/no-network/no-stores; liveness 200; residue 0)");

async function runTrial(name, contract) {
  const disposableRoot = await mkdtemp(join(tmpdir(), `muse-api-readiness-${name}-`));
  const env = createDisposableApiEnvironment({
    purpose: `api-readiness-${name}`,
    rootDir: disposableRoot
  });
  ensureDisposableApiDirectories(env);
  const server = buildServer({
    ...contract.options,
    env,
    logger: false
  });
  let baseUrl;
  let trial;
  try {
    baseUrl = (await server.listen({ host: "127.0.0.1", port: 0 })).replace(/\/$/u, "");
    const [liveness, readiness, alias] = await Promise.all([
      fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(2_000) }),
      fetch(`${baseUrl}/ready`, { signal: AbortSignal.timeout(2_000) }),
      fetch(`${baseUrl}/api/ready`, { signal: AbortSignal.timeout(2_000) })
    ]);
    const [livenessBody, readinessBody, aliasBody] = await Promise.all([
      liveness.json(),
      readiness.json(),
      alias.json()
    ]);
    const responseBodies = JSON.stringify([livenessBody, readinessBody, aliasBody]);
    assert(liveness.status === 200, `${name}: /health did not remain 200`);
    assert(livenessBody.liveness?.status === "up", `${name}: liveness was not up`);
    assert(
      readiness.status === contract.expectedReadyStatus,
      `${name}: /ready status ${readiness.status.toString()} != ${contract.expectedReadyStatus.toString()}`
    );
    assert(alias.status === readiness.status, `${name}: /api/ready status drifted`);
    assert(
      JSON.stringify(readinessBody.readiness?.reasons) === JSON.stringify(contract.expectedReasons),
      `${name}: readiness reasons drifted`
    );
    assert(
      JSON.stringify(aliasBody.readiness) === JSON.stringify(readinessBody.readiness),
      `${name}: /api/ready body drifted`
    );
    if (contract.rejectedText) {
      assert(!responseBodies.includes(contract.rejectedText), `${name}: health response exposed rejected text`);
    }
    trial = {
      livenessStatus: liveness.status,
      name,
      readinessReasons: readinessBody.readiness?.reasons ?? [],
      readinessStatus: readiness.status
    };
  } finally {
    await server.close();
    await rm(disposableRoot, { force: true, recursive: true });
  }
  return {
    ...trial,
    tempResidue: await pathExists(disposableRoot) ? 1 : 0
  };
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

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
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
