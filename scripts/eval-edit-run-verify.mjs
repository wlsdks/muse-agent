/**
 * eval:edit-run-verify — the FULL computer-control loop on the live local model.
 *
 * eval:computer-task proves find→fix; eval:run-command proves execute. This
 * proves the LOOP that matters: a failing test, and gemma4 must FIND the bug
 * (file_grep/file_read), FIX it (file_edit, under the read-before-edit gate),
 * and RUN the test (run_command) to CONFIRM — the edit→run→verify cycle a real
 * coding assistant lives in. Graded on TERMINAL STATE (agent-testing.md): the
 * harness re-runs the test itself, so a fabricated "it passes now" cannot win —
 * the test must actually exit 0 — and the sibling file must be untouched
 * (no collateral). The model must ALSO have run the test itself (run_command):
 * verifying is the capability under test, not incidental trajectory.
 *
 * LOCAL OLLAMA ONLY; skips (exit 0) when Ollama or the muse-runner binary is
 * unavailable.  MUSE_EVAL_REPEAT=3 node scripts/eval-edit-run-verify.mjs
 */
import { access, readFile, writeFile } from "node:fs/promises";
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
  console.log(skipLine("ollama-unreachable", "local provider unavailable"));
  console.log(completionLine({ status: "unverified", requested: REPEAT, executed: 0, reason: "ollama-unreachable" }));
  process.exit(0);
}
try {
  await access(RUNNER);
} catch {
  console.log(`SKIP: muse-runner binary not found at ${RUNNER} (cargo build --release)`);
  console.log(skipLine("runner-missing", "compiled runner unavailable"));
  console.log(completionLine({ status: "unverified", requested: REPEAT, executed: 0, reason: "runner-missing" }));
  process.exit(0);
}
const isolationSkip = resolveEvalRunnerIsolationSkip();
if (isolationSkip) {
  console.log(`SKIP: ${isolationSkip.message}`);
  console.log(skipLine(isolationSkip.code, isolationSkip.message));
  console.log(completionLine({ status: "unverified", requested: REPEAT, executed: 0, reason: isolationSkip.code }));
  process.exit(0);
}

const BUGGY_SUM = "export const sum = (a, b) => a - b;\n";
const NOISE = "export const product = (a, b) => a * b;\n";
const TEST = `import { sum } from "./sum.mjs";
if (sum(2, 3) === 5 && sum(10, 4) === 14) {
  console.log("TEST PASS");
  process.exit(0);
}
console.error("TEST FAIL");
process.exit(1);
`;

/** Run the test the SAME way a user would — independent of whatever the model did. */
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
      console.log(`  [tool] ${tool.definition.name}(${JSON.stringify(args).slice(0, 140)}) → ${JSON.stringify(result).slice(0, 140)}`);
    }
    return result;
  }
});

let failures = 0;
let completedRuns = 0;
let runtimeUnavailable = false;
let dir;
let trial;
try {
  for (let run = 1; run <= REPEAT; run += 1) {
    await trial?.dispose();
    trial = await createEvalTrialEnvironment({ prefix: "muse-edit-run-verify-" });
    dir = trial.fixtureDir;
    const sumPath = join(dir, "sum.mjs");
    const testPath = join(dir, "sum.test.mjs");
    await writeFile(sumPath, BUGGY_SUM);
    await writeFile(join(dir, "product.mjs"), NOISE);
    await writeFile(testPath, TEST);

    const readPaths = new Set();
    const readOpts = { baseDir: dir, docRoots: [dir], onPathRead: (p) => readPaths.add(p), roots: [dir] };
    const writeOpts = { approvalGate: () => ({ approved: true }), baseDir: dir, roots: [dir], wasPathRead: (p) => readPaths.has(p) };
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
      console.log(skipLine("runtime-unavailable", "agent runtime or model not configured"));
      console.log(completionLine({ status: "failed", requested: REPEAT, executed: completedRuns, reason: "runtime-unavailable" }));
      runtimeUnavailable = true;
      break;
    }

    const TASK =
      `The test at ${testPath} is failing. Run it to see the failure, fix the bug in the source file ` +
      "it tests so the test passes, then run the test again to confirm it passes. Change nothing else.";
    // The agentic-persistence lines shipped in the production --with-tools system
    // prompt (commands-ask.ts) — this eval is their agent-level check: they lift
    // the loop 1/3 → 3/3 by stopping the model quitting after the first tool call.
    const SYSTEM = [
      "You are Muse. Use the file and command tools to do what the user asks.",
      "When a task needs several steps (e.g. read a file, change it, run a command), keep taking the next action after each tool result until it is actually done — do not stop after a single tool call.",
      "If a command or test you run reports a failure, find the cause, fix it with your tools, and run it again to confirm it passes before you answer."
    ].join(" ");
    const result = await assembly.agentRuntime.run({
      messages: [
        { content: SYSTEM, role: "system" },
        { content: TASK, role: "user" }
      ],
      metadata: { localMode: true, userId: "eval-edit-run-verify" },
      model: assembly.defaultModel,
      toolApprovalGate: allowEvalToolCall,
      toolExposureAuthority: createEvalToolExposureAuthority("edit-run-verify")
    });
    const toolsUsed = result.toolsUsed ?? [];
    const modelRanTest = toolsUsed.includes("run_command");
    const testPasses = await runTest(testPath);
    const noiseIntact = (await readFile(join(dir, "product.mjs"), "utf8").catch(() => "")) === NOISE;
    const ok = testPasses && modelRanTest && noiseIntact;
    if (!ok) failures += 1;
    console.log(
      `run ${run.toString()}/${REPEAT.toString()}: ${ok ? "PASS" : "FAIL"}  ` +
      `test-passes=${testPasses.toString()} model-ran-test=${modelRanTest.toString()} ` +
      `no-collateral=${noiseIntact.toString()} tools=[${toolsUsed.join(",")}]`
    );
    if (!ok) console.log(`  sum.mjs now: ${JSON.stringify(await readFile(sumPath, "utf8").catch(() => ""))}`);
    completedRuns += 1;
  }
} finally {
  await trial?.dispose();
}

if (runtimeUnavailable) process.exit(0);

if (failures > 0) {
  console.log(`\neval:edit-run-verify FAIL — ${failures.toString()}/${REPEAT.toString()} runs failed`);
  console.log(completionLine({ status: "failed", requested: REPEAT, executed: completedRuns, reason: "terminal-state-failed" }));
  process.exit(1);
}
console.log(`\neval:edit-run-verify PASS (${REPEAT.toString()}/${REPEAT.toString()} runs — test passes after a real edit→run→verify loop)`);
console.log(completionLine({ status: "passed", requested: REPEAT, executed: completedRuns }));
