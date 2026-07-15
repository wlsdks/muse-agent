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
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createFileEditTool, createFileGrepTool, createFileReadTool } from "../packages/fs/dist/index.js";
import { createRustRunnerTool } from "../packages/tools/dist/index.js";
import { createMuseRuntimeAssembly } from "../packages/autoconfigure/dist/index.js";
import { readTextOrDefault, runBestEffort } from "./best-effort.mjs";

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
let dir;
try {
  for (let run = 1; run <= REPEAT; run += 1) {
    if (dir) await runBestEffort(() => rm(dir, { force: true, recursive: true }), "previous run directory cleanup");
    dir = await mkdtemp(join(tmpdir(), "muse-two-edit-fix-"));
    await mkdir(join(dir, "src"), { recursive: true });
    const testPath = join(dir, "test.mjs");
    await writeFile(join(dir, "src", "alpha.mjs"), ALPHA);
    await writeFile(join(dir, "src", "beta.mjs"), BETA);
    await writeFile(join(dir, "src", "noise.mjs"), NOISE);
    await writeFile(testPath, TEST);

    const readPaths = new Set();
    const readOpts = { baseDir: dir, docRoots: [dir], onPathRead: (p) => readPaths.add(p), roots: [dir] };
    const writeOpts = { approvalGate: () => ({ approved: true }), baseDir: dir, checkEditIntegrity: true, roots: [dir], wasPathRead: (p) => readPaths.has(p) };
    const assembly = createMuseRuntimeAssembly({
      extraTools: [
        createFileGrepTool(readOpts),
        createFileReadTool(readOpts),
        createFileEditTool(writeOpts),
        createRustRunnerTool({ runnerPath: RUNNER })
      ].map(logTool)
    });
    if (!assembly.agentRuntime || !assembly.modelProvider) {
      console.log("SKIP: no agent runtime/model configured");
      process.exit(0);
    }

    const TASK =
      `The test at ${testPath} is failing. Run it, fix EVERY bug in the source files it tests so the ` +
      "test passes, then run it again to confirm. Change only what is necessary.";
    const result = await assembly.agentRuntime.run({
      messages: [
        { content: SYSTEM, role: "system" },
        { content: TASK, role: "user" }
      ],
      metadata: { localMode: true, userId: "eval-two-edit-fix" },
      model: assembly.defaultModel
    });
    const toolsUsed = result.toolsUsed ?? [];
    const testPasses = await runTest(testPath);
    const noiseIntact = (await readTextOrDefault(() => readFile(join(dir, "src", "noise.mjs"), "utf8")) === NOISE;
    // OUTCOME grade: the test passes ONLY if BOTH bugs were fixed (alpha→2, beta→20);
    // the noise file must be untouched. The harness verifies testPasses itself, so
    // the model self-running is reported (ran-test) but not gated (agent-testing.md).
    const ok = testPasses && noiseIntact;
    if (!ok) failures += 1;
    const alphaNow = (await readTextOrDefault(() => readFile(join(dir, "src", "alpha.mjs"), "utf8")) !== ALPHA;
    const betaNow = (await readTextOrDefault(() => readFile(join(dir, "src", "beta.mjs"), "utf8")) !== BETA;
    console.log(
      `run ${run.toString()}/${REPEAT.toString()}: ${ok ? "PASS" : "FAIL"}  ` +
      `test-passes=${testPasses.toString()} alpha-edited=${alphaNow.toString()} beta-edited=${betaNow.toString()} ` +
      `noise-intact=${noiseIntact.toString()} ran-test=${toolsUsed.includes("run_command").toString()} tools=[${toolsUsed.join(",")}]`
    );
  }
} finally {
  if (dir) await runBestEffort(() => rm(dir, { force: true, recursive: true }), "temporary eval directory cleanup");
}

if (failures > 0) {
  console.log(`\neval:two-edit-fix FAIL — ${failures.toString()}/${REPEAT.toString()} runs failed (a model that fixed only one file fails: completeness battery)`);
  process.exit(1);
}
console.log(`\neval:two-edit-fix PASS (${REPEAT.toString()}/${REPEAT.toString()} runs — both files fixed, no collateral, verified)`);
