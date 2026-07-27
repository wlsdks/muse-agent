import { spawn, execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  terminateOwnedBrowserProcess,
  waitForOwnedBrowserExit
} from "./lib/owned-browser-process.mjs";

const execFileAsync = promisify(execFile);
const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const artifactPath = join(rootDir, ".muse-dev", "evals", "personal-agent-roadmap", "task-040-c.json");
const cases = [
  { expectedCode: 0, faultCase: "pass", name: "pass" },
  { expectedCode: 1, faultCase: "assertion", name: "assertion-failure" },
  { expectedCode: 130, faultCase: "pause", name: "sigint", signal: "SIGINT" },
  { expectedCode: 143, faultCase: "pause", name: "timeout-sigterm", signal: "SIGTERM" }
];

const selectedCases = process.argv.includes("--signals-only")
  ? cases.filter((qualificationCase) => qualificationCase.signal !== undefined)
  : cases;
const results = [];
for (const qualificationCase of selectedCases) {
  console.log(`qualify:browser-cleanup ${qualificationCase.name}`);
  results.push(await runCase(qualificationCase));
}

if (selectedCases.length !== cases.length) {
  console.log(`qualify:browser-cleanup PASS (${results.length.toString()} signal cases)`);
  process.exitCode = 0;
} else {
  await writeArtifact(results);
  console.log(`qualify:browser-cleanup PASS (${results.length.toString()} cases)`);
}

async function writeArtifact(trials) {
  const head = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: rootDir, encoding: "utf8" })).stdout.trim();
  const inputFiles = [
    "packages/browser/src/puppeteer-controller.ts",
    "scripts/lib/owned-browser-process.mjs",
    "scripts/lib/owned-resource-scope.mjs",
    "scripts/lib/owned-resource-signals.mjs",
    "scripts/smoke-browser.mjs",
    "scripts/qualify-browser-cleanup.mjs"
  ];
  const inputHash = createHash("sha256");
  for (const file of inputFiles) {
    inputHash.update(file);
    inputHash.update(await readFile(join(rootDir, file)));
  }
  const artifact = {
    generatedAt: new Date().toISOString(),
    head,
    inputFiles,
    inputHash: inputHash.digest("hex"),
    result: "pass",
    taskId: "040-C",
    trials
  };
  await mkdir(dirname(artifactPath), { recursive: true });
  await writeFile(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
}

async function runCase({ expectedCode, faultCase, name, signal }) {
  const startedAt = new Date().toISOString();
  const child = spawn(process.execPath, ["scripts/smoke-browser.mjs"], {
    cwd: rootDir,
    env: {
      ...process.env,
      MUSE_BROWSER_SMOKE_FAULT_CASE: faultCase,
      ...(signal === undefined ? {} : { MUSE_BROWSER_SMOKE_SIGNAL_CLEANUP_DELAY_MS: "250" })
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let output = "";
  let receipt;
  const ready = Promise.withResolvers();
  const capture = (chunk) => {
    output = `${output}${chunk.toString()}`.slice(-1_000_000);
    for (const line of output.split("\n")) {
      const prefix = "smoke:browser ownership ";
      if (line.startsWith(prefix) && receipt === undefined) {
        receipt = JSON.parse(line.slice(prefix.length));
      }
      if (line === "smoke:browser fault-ready") ready.resolve();
    }
  };
  child.stdout.on("data", capture);
  child.stderr.on("data", capture);
  const exited = new Promise((resolve) => {
    child.once("exit", (code, exitSignal) => resolve({ code, exitSignal }));
  });

  if (signal !== undefined) {
    await withTimeout(ready.promise, 60_000, `${name} did not reach fault-ready`);
    child.kill(signal);
    await new Promise((resolve) => setTimeout(resolve, 25));
    child.kill(signal);
  }

  let terminal;
  try {
    terminal = await withTimeout(
      exited,
      faultCase === "pass" ? 600_000 : 30_000,
      `${name} did not terminate within its bound`
    );
  } catch (error) {
    child.kill("SIGKILL");
    if (receipt !== undefined) {
      await terminateOwnedBrowserProcess(receipt).catch(() => {});
      await waitForOwnedBrowserExit(receipt, { timeoutMs: 5_000 }).catch(() => {});
    }
    throw error;
  }

  if (terminal.code !== expectedCode || terminal.exitSignal !== null) {
    throw new Error(
      `${name} exited unexpectedly: code=${String(terminal.code)} signal=${String(terminal.exitSignal)}\n${output.slice(-4_000)}`
    );
  }
  if (receipt === undefined) {
    throw new Error(`${name} emitted no exact browser ownership receipt`);
  }
  await assertNoResidue(receipt);
  return {
    exitCode: terminal.code,
    finishedAt: new Date().toISOString(),
    launchId: receipt.launchId,
    name,
    osStartedAt: receipt.osStartedAt,
    pid: receipt.pid,
    processGroupId: receipt.processGroupId,
    startedAt,
    tempRoot: dirname(receipt.userDataDir)
  };
}

async function assertNoResidue(receipt) {
  await waitForOwnedBrowserExit(receipt, { timeoutMs: 5_000 });
  const tempRoot = dirname(receipt.userDataDir);
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const [tempExists, profileProcesses] = await Promise.all([
      access(tempRoot).then(() => true, () => false),
      exactProfileProcesses(receipt.userDataDir)
    ]);
    if (!tempExists && profileProcesses.length === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`owned browser residue remained for ${receipt.launchId}`);
}

async function exactProfileProcesses(userDataDir) {
  const { stdout } = await execFileAsync(
    "/bin/ps",
    ["-ax", "-ww", "-o", "pid=,args="],
    { encoding: "utf8", timeout: 2_000 }
  );
  const argument = `--user-data-dir=${userDataDir}`;
  return stdout
    .split("\n")
    .filter((line) => line.includes(argument));
}

function withTimeout(operation, timeoutMs, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  return Promise.race([operation, timeout]).finally(() => clearTimeout(timer));
}
