/**
 * eval:two-edit-fix — the multi-step COMPLETENESS battery: a task that needs TWO
 * edits across TWO files. The test passes ONLY when BOTH bugs are fixed, so a
 * model that stops after one edit (the dominant early-stop / step-repetition
 * failure class, fires 48-51) FAILs. Raises the bar past the existing evals
 * (which each need a single edit). Graded on TERMINAL STATE (the harness re-runs
 * the test): both functions corrected + the noise file untouched.
 *
 * LOCAL OLLAMA ONLY; skips (exit 0) when Ollama or the muse-runner binary is
 * unavailable.  MUSE_EVAL_REPEAT=3 node scripts/eval-two-edit-fix.mjs
 */
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { execFileSync, spawn } from "node:child_process";
import { performance } from "node:perf_hooks";
import { join, relative } from "node:path";

import { createFileEditTool, createFileGrepTool, createFileReadTool } from "../packages/fs/dist/index.js";
import { completionLine, skipLine } from "./eval-skip.mjs";
import { createEvalRunnerTool, resolveEvalRunnerIsolationSkip } from "./lib/eval-runner-isolation.mjs";
import { createEvalTrialEnvironment } from "./lib/eval-trial-environment.mjs";
import { allowEvalToolCall, createEvalToolExposureAuthority } from "./lib/eval-tool-authority.mjs";
import {
  createEffectBudgetGate,
  createObservedBaselineTool,
  createSingleAgentBaselineArtifact,
  createSingleAgentBaselineContract,
  summarizeSingleAgentRun,
  writeSingleAgentBaselineArtifact
} from "./lib/multi-agent-baseline.mjs";

const OLLAMA_BASE = (process.env.OLLAMA_BASE_URL ?? "http://127.0.0.1:11434").replace(/\/+$/, "");
const REPEAT = Math.max(1, Math.trunc(Number(process.env.MUSE_EVAL_REPEAT ?? "1")));
const RUNNER = process.env.MUSE_RUNNER_PATH ?? join(process.cwd(), "target", "release", "muse-runner");
const BASELINE_ARTIFACT = process.argv.includes("--baseline-artifact");
const BASELINE_BUDGET = Object.freeze({
  maxEffects: 6,
  repeatCount: REPEAT,
  wallclockMs: 120_000
});

try {
  const probe = await fetch(`${OLLAMA_BASE}/api/version`, { signal: AbortSignal.timeout(3000) });
  if (!probe.ok) throw new Error(`status ${probe.status}`);
} catch (cause) {
  console.log(`SKIP: Ollama unreachable (${cause instanceof Error ? cause.message : cause})`);
  process.exit(BASELINE_ARTIFACT ? 4 : 0);
}
try {
  await access(RUNNER);
} catch {
  console.log(`SKIP: muse-runner binary not found at ${RUNNER} (cargo build --release)`);
  process.exit(BASELINE_ARTIFACT ? 4 : 0);
}
const isolationSkip = resolveEvalRunnerIsolationSkip();
if (isolationSkip) {
  console.log(`SKIP: ${isolationSkip.message}`);
  console.log(skipLine(isolationSkip.code, isolationSkip.message));
  console.log(completionLine({ status: "unverified", requested: REPEAT, executed: 0, reason: isolationSkip.code }));
  process.exit(BASELINE_ARTIFACT ? 4 : 0);
}

// Two independent bugs, one per file. The test sums both, so fixing ONLY ONE
// leaves it failing — the model must complete BOTH edits.
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
// A realistic failing test naming BOTH expectations + which file each lives in.
const TEST = `import { alpha } from "./src/alpha.mjs";
import { beta } from "./src/beta.mjs";
if (alpha() === 2 && beta() === 20) {
  console.log("TEST PASS");
  process.exit(0);
}
console.error(\`TEST FAIL: alpha() returned \${alpha()}, expected 2 (src/alpha.mjs); beta() returned \${beta()}, expected 20 (src/beta.mjs)\`);
process.exit(1);
`;

const SYSTEM = [
  "You are Muse. Use the file and command tools to do what the user asks.",
  "When a task needs several steps (e.g. read a file, change it, run a command), keep taking the next action after each tool result until it is actually done — do not stop after a single tool call.",
  "If a command or test you run reports a failure, find the cause, fix it with your tools, and run it again to confirm it passes before you answer."
].join(" ");
const TASK_TEMPLATE =
  "The test at <TEST_PATH> is failing. Run it, fix EVERY bug in the source files it tests so the " +
  "test passes, then run it again to confirm. Change only what is necessary.";
const BASELINE_CONTRACT = createSingleAgentBaselineContract({
  budget: BASELINE_BUDGET,
  datasetSeed: "two-edit-fix-v1",
  fixture: {
    definition: { alpha: ALPHA, beta: BETA, noise: NOISE, system: SYSTEM, task: TASK_TEMPLATE, test: TEST },
    id: "two-edit-fix-v1"
  },
  rubric: {
    criteria: [
      "agent run reaches terminal completed state within the shared budget",
      "test.mjs exits zero",
      "alpha source changed from the buggy fixture",
      "beta source changed from the buggy fixture",
      "noise source remains byte-identical"
    ],
    id: "two-edit-terminal-state-v1"
  },
  taskFamily: "two-edit-fix"
});

function runTest(testPath) {
  const settled = Promise.withResolvers();
  const child = spawn("node", [testPath], { stdio: "ignore" });
  child.on("error", () => settled.resolve(false));
  child.on("close", (code) => settled.resolve(code === 0));
  return settled.promise;
}

let failures = 0;
let runtimeUnavailable = false;
let dir;
let trial;
const baselineRuns = [];
let baselineModel = "unknown";
let baselineProvider = "unknown";
try {
  for (let run = 1; run <= REPEAT; run += 1) {
    await trial?.dispose();
    trial = await createEvalTrialEnvironment({
      overrides: BASELINE_ARTIFACT ? { MUSE_ANSWER_TEMPERATURE: "0" } : {},
      prefix: "muse-two-edit-fix-"
    });
    dir = trial.fixtureDir;
    await mkdir(join(dir, "src"), { recursive: true });
    const testPath = join(dir, "test.mjs");
    await writeFile(join(dir, "src", "alpha.mjs"), ALPHA);
    await writeFile(join(dir, "src", "beta.mjs"), BETA);
    await writeFile(join(dir, "src", "noise.mjs"), NOISE);
    await writeFile(testPath, TEST);

    const readPaths = new Set();
    const observedToolCalls = [];
    const baselineController = BASELINE_ARTIFACT ? new AbortController() : undefined;
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
      ].map((tool) => createObservedBaselineTool(tool, {
        onResult: (args, result) => {
          if (process.env.MUSE_TASK_DEBUG) {
            console.log(`  [tool] ${tool.definition.name}(${JSON.stringify(args).slice(0, 150)}) → ${JSON.stringify(result).slice(0, 120)}`);
          }
        },
        onSettled: (call) => observedToolCalls.push(call),
        ...(baselineController ? { signal: baselineController.signal } : {})
      }))
    });
    if (!assembly.agentRuntime || !assembly.modelProvider) {
      console.log("SKIP: no agent runtime/model configured");
      runtimeUnavailable = true;
      break;
    }

    const TASK = TASK_TEMPLATE.replace("<TEST_PATH>", testPath);
    const runId = BASELINE_ARTIFACT
      ? `core100-087-single-${Date.now().toString()}-${run.toString()}`
      : undefined;
    const startedAt = performance.now();
    const abortTimer = baselineController
      ? setTimeout(() => baselineController.abort(), BASELINE_BUDGET.wallclockMs)
      : undefined;
    abortTimer?.unref();
    let result;
    let runFailure;
    try {
      result = await assembly.agentRuntime.run({
        messages: [
          { content: SYSTEM, role: "system" },
          { content: TASK, role: "user" }
        ],
        metadata: { localMode: true, userId: "eval-two-edit-fix" },
        model: assembly.defaultModel,
        ...(runId ? { runId } : {}),
        ...(baselineController ? { signal: baselineController.signal } : {}),
        toolApprovalGate: BASELINE_ARTIFACT
          ? createEffectBudgetGate(BASELINE_BUDGET.maxEffects, allowEvalToolCall)
          : allowEvalToolCall,
        toolExposureAuthority: createEvalToolExposureAuthority("two-edit-fix")
      });
    } catch (error) {
      if (!BASELINE_ARTIFACT) throw error;
      runFailure = error;
    } finally {
      if (abortTimer) clearTimeout(abortTimer);
    }
    const latencyMs = performance.now() - startedAt;
    const toolsUsed = result?.toolsUsed ?? observedToolCalls.map((call) => call.name);
    const testPasses = await runTest(testPath);
    const noiseIntact = (await readFile(join(dir, "src", "noise.mjs"), "utf8").catch(() => "")) === NOISE;
    // OUTCOME grade: the test passes ONLY if BOTH bugs were fixed (alpha→2, beta→20);
    // the noise file must be untouched. The harness verifies testPasses itself, so
    // the model self-running is reported (ran-test) but not gated (agent-testing.md).
    let ok = runFailure === undefined && testPasses && noiseIntact;
    const alphaNow = (await readFile(join(dir, "src", "alpha.mjs"), "utf8").catch(() => "")) !== ALPHA;
    const betaNow = (await readFile(join(dir, "src", "beta.mjs"), "utf8").catch(() => "")) !== BETA;
    if (BASELINE_ARTIFACT) {
      const runRecord = await assembly.historyStore.findRun(runId);
      const summary = summarizeSingleAgentRun({
        latencyMs,
        quality: {
          alphaFixed: alphaNow,
          betaFixed: betaNow,
          noiseIntact,
          testPasses
        },
        runRecord,
        toolCalls: observedToolCalls,
        toolsUsed
      });
      baselineRuns.push(summary);
      ok = summary.quality.passed;
      baselineModel = assembly.defaultModel ?? "unknown";
      baselineProvider = assembly.modelProvider.id;
    }
    if (!ok) failures += 1;
    console.log(
      `run ${run.toString()}/${REPEAT.toString()}: ${ok ? "PASS" : "FAIL"}  ` +
      `test-passes=${testPasses.toString()} alpha-edited=${alphaNow.toString()} beta-edited=${betaNow.toString()} ` +
      `noise-intact=${noiseIntact.toString()} ran-test=${toolsUsed.includes("run_command").toString()} tools=[${toolsUsed.join(",")}]` +
      (runFailure ? ` reason=${runFailure instanceof Error ? runFailure.name : "runtime-error"}` : "")
    );
  }
} finally {
  await trial?.dispose();
}

if (runtimeUnavailable) process.exit(BASELINE_ARTIFACT ? 4 : 0);

if (BASELINE_ARTIFACT) {
  const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
  const artifact = createSingleAgentBaselineArtifact({
    contract: BASELINE_CONTRACT,
    generatedAt: new Date().toISOString(),
    model: baselineModel,
    provider: baselineProvider,
    runs: baselineRuns,
    source: {
      head: git("rev-parse", "HEAD"),
      tree: git("rev-parse", "HEAD^{tree}"),
      upstream: git("rev-parse", "@{upstream}"),
      worktree: git("status", "--porcelain").length === 0 ? "clean" : "dirty"
    }
  });
  const target = await writeSingleAgentBaselineArtifact({
    artifact,
    fileName: "single-agent-two-edit-fix-v1.json",
    resultsDir: process.env.MUSE_MULTI_AGENT_BASELINE_DIR
      ?? join(process.cwd(), ".muse-dev", "evals", "personal-agent-roadmap", "core100-087")
  });
  console.log(`baseline artifact: ${relative(process.cwd(), target)}`);
}

if (failures > 0) {
  console.log(`\neval:two-edit-fix FAIL — ${failures.toString()}/${REPEAT.toString()} runs failed (a model that fixed only one file fails: completeness battery)`);
  process.exit(1);
}
console.log(`\neval:two-edit-fix PASS (${REPEAT.toString()}/${REPEAT.toString()} runs — both files fixed, no collateral, verified)`);
