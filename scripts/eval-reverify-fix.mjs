/**
 * eval:reverify-fix — the multi-step RE-VERIFICATION battery: the test exits on
 * its FIRST failed assertion, so a SECOND bug stays HIDDEN until the first is
 * fixed. A model that fixes only the first reported error and declares done —
 * WITHOUT re-running to confirm — FAILs; only a model that re-runs after its fix,
 * sees the newly-surfaced second failure, and fixes that too passes. This probes
 * "don't trust the first error as the whole picture / re-verify after a fix"
 * (agent-testing.md), a dimension eval:two-edit-fix (which shows BOTH failures
 * upfront) does not cover.
 *
 * LOCAL OLLAMA ONLY; skips (exit 0) when Ollama or the muse-runner binary is
 * unavailable.  MUSE_EVAL_REPEAT=3 node scripts/eval-reverify-fix.mjs
 */
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { join } from "node:path";

import { createFileEditTool, createFileGrepTool, createFileReadTool } from "../packages/fs/dist/index.js";
import { completionLine, skipLine } from "./eval-skip.mjs";
import { createEvalRunnerTool, resolveEvalRunnerIsolationSkip } from "./lib/eval-runner-isolation.mjs";
import { createEvalTrialEnvironment } from "./lib/eval-trial-environment.mjs";
import { allowEvalToolCall, createEvalToolExposureAuthority } from "./lib/eval-tool-authority.mjs";

const OLLAMA_BASE = (process.env.OLLAMA_BASE_URL ?? "http://127.0.0.1:11434").replace(/\/+$/, "");
const REPEAT = Math.max(1, Math.trunc(Number(process.env.MUSE_EVAL_REPEAT ?? "1")));
const RUNNER = process.env.MUSE_RUNNER_PATH ?? join(process.cwd(), "target", "release", "muse-runner");

try {
  const probe = await fetch(`${OLLAMA_BASE}/api/version`, { signal: AbortSignal.timeout(3000) });
  if (!probe.ok) throw new Error(`status ${probe.status}`);
} catch (cause) {
  console.log(`SKIP: Ollama unreachable (${cause instanceof Error ? cause.message : cause})`);
  process.exit(0);
}
try {
  await access(RUNNER);
} catch {
  console.log(`SKIP: muse-runner binary not found at ${RUNNER} (cargo build --release)`);
  process.exit(0);
}
const isolationSkip = resolveEvalRunnerIsolationSkip();
if (isolationSkip) {
  console.log(`SKIP: ${isolationSkip.message}`);
  console.log(skipLine(isolationSkip.code, isolationSkip.message));
  console.log(completionLine({ status: "unverified", requested: REPEAT, executed: 0, reason: isolationSkip.code }));
  process.exit(0);
}

const ALPHA = `export function alpha() {
  return 1;
}
`;
const BETA = `export function beta() {
  return 10;
}
`;
const NOISE = `export function noise() {
  return "do not touch";
}
`;
// CRUCIAL: sequential checks that exit on the FIRST failure, so the beta bug is
// invisible in the test output until alpha is fixed AND the test is re-run. A
// model that fixes alpha and stops (no re-run) leaves beta broken.
const TEST = `import { alpha } from "./src/alpha.mjs";
import { beta } from "./src/beta.mjs";
if (alpha() !== 2) {
  console.error(\`TEST FAIL: alpha() returned \${alpha()}, expected 2 (src/alpha.mjs)\`);
  process.exit(1);
}
if (beta() !== 20) {
  console.error(\`TEST FAIL: beta() returned \${beta()}, expected 20 (src/beta.mjs)\`);
  process.exit(1);
}
console.log("TEST PASS");
process.exit(0);
`;

const SYSTEM = [
  "You are Muse. Use the file and command tools to do what the user asks.",
  "When a task needs several steps (e.g. read a file, change it, run a command), keep taking the next action after each tool result until it is actually done — do not stop after a single tool call.",
  "If a command or test you run reports a failure, find the cause, fix it with your tools, and run it again to confirm it passes before you answer."
].join(" ");

function runTest(testPath) {
  const settled = Promise.withResolvers();
  const child = spawn("node", [testPath], { stdio: "ignore" });
  child.on("error", () => settled.resolve(false));
  child.on("close", (code) => settled.resolve(code === 0));
  return settled.promise;
}

const logTool = (tool) => ({
  ...tool,
  execute: async (args, ctx) => {
    const result = await tool.execute(args, ctx);
    if (process.env.MUSE_TASK_DEBUG) {
      console.log(`  [tool] ${tool.definition.name}(${JSON.stringify(args).slice(0, 150)}) → ${JSON.stringify(result).slice(0, 120)}`);
    }
    return result;
  }
});

let failures = 0;
let runtimeUnavailable = false;
let dir;
let trial;
try {
  for (let run = 1; run <= REPEAT; run += 1) {
    await trial?.dispose();
    trial = await createEvalTrialEnvironment({ prefix: "muse-reverify-fix-" });
    dir = trial.fixtureDir;
    await mkdir(join(dir, "src"), { recursive: true });
    const testPath = join(dir, "test.mjs");
    await writeFile(join(dir, "src", "alpha.mjs"), ALPHA);
    await writeFile(join(dir, "src", "beta.mjs"), BETA);
    await writeFile(join(dir, "src", "noise.mjs"), NOISE);
    await writeFile(testPath, TEST);

    const readPaths = new Set();
    const readOpts = { baseDir: dir, docRoots: [dir], onPathRead: (p) => readPaths.add(p), roots: [dir] };
    const writeOpts = { approvalGate: () => ({ approved: true }), baseDir: dir, checkEditIntegrity: true, roots: [dir], wasPathRead: (p) => readPaths.has(p) };
    const { createMuseRuntimeAssembly } = await import("../packages/autoconfigure/dist/index.js");
    const assembly = createMuseRuntimeAssembly({
      env: trial.env,
      extraTools: [
        createFileGrepTool(readOpts),
        createFileReadTool(readOpts),
        createFileEditTool(writeOpts),
        createEvalRunnerTool({ fixtureRoot: dir, runnerPath: RUNNER })
      ].map(logTool)
    });
    if (!assembly.agentRuntime || !assembly.modelProvider) {
      console.log("SKIP: no agent runtime/model configured");
      runtimeUnavailable = true;
      break;
    }

    const TASK =
      `The test at ${testPath} is failing. Run it, fix the bug it reports, and KEEP going — run it ` +
      "again after each fix and resolve every failure until the test passes. Change only what is necessary.";
    const result = await assembly.agentRuntime.run({
      messages: [
        { content: SYSTEM, role: "system" },
        { content: TASK, role: "user" }
      ],
      metadata: { localMode: true, userId: "eval-reverify-fix" },
      model: assembly.defaultModel,
      toolApprovalGate: allowEvalToolCall,
      toolExposureAuthority: createEvalToolExposureAuthority("reverify-fix")
    });
    const toolsUsed = result.toolsUsed ?? [];
    const testPasses = await runTest(testPath);
    const noiseIntact = (await readFile(join(dir, "src", "noise.mjs"), "utf8").catch(() => "")) === NOISE;
    // OUTCOME grade: the test passes ONLY if BOTH the reported AND the hidden bug
    // were fixed — which requires re-running after the first fix to surface the second.
    const ok = testPasses && noiseIntact;
    if (!ok) failures += 1;
    const alphaFixed = (await readFile(join(dir, "src", "alpha.mjs"), "utf8").catch(() => "")) !== ALPHA;
    const betaFixed = (await readFile(join(dir, "src", "beta.mjs"), "utf8").catch(() => "")) !== BETA;
    const runCount = toolsUsed.filter((t) => t === "run_command").length;
    console.log(
      `run ${run.toString()}/${REPEAT.toString()}: ${ok ? "PASS" : "FAIL"}  ` +
      `test-passes=${testPasses.toString()} alpha-fixed=${alphaFixed.toString()} beta-fixed(hidden)=${betaFixed.toString()} ` +
      `run_command-calls=${runCount.toString()} noise-intact=${noiseIntact.toString()} tools=[${toolsUsed.join(",")}]`
    );
  }
} finally {
  await trial?.dispose();
}

if (runtimeUnavailable) process.exit(0);

if (failures > 0) {
  console.log(`\neval:reverify-fix FAIL — ${failures.toString()}/${REPEAT.toString()} runs failed (a model that fixed only the first reported bug, without re-running to surface the second, fails)`);
  process.exit(1);
}
console.log(`\neval:reverify-fix PASS (${REPEAT.toString()}/${REPEAT.toString()} runs — re-verified after the first fix, found + fixed the hidden second bug)`);
