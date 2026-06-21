/**
 * eval:multifile-fix — the HARDER computer-control loop: locate the buggy
 * function among several across multiple files, fix it precisely, verify.
 *
 * Raises eval:edit-run-verify's difficulty in two ways a one-line fixture can't:
 *   1. The buggy `multiply` lives among add/subtract/divide in one of two source
 *      files — the model must FIND the right function, not the only function.
 *   2. `add` (correct) and `multiply` (buggy) share the body `return a + b;`, so
 *      a bare old_string "return a + b;" is AMBIGUOUS (2 matches) — the model
 *      must scope its edit to the multiply function or it fail-closes, and it
 *      must NOT "fix" the correct `add` (collateral).
 *
 * Graded on TERMINAL STATE (the harness re-runs the test): multiply fixed, add
 * still correct, the noise file untouched. Whether the model self-ran the test
 * is reported (ran-test) but NOT gated — the harness verifies the outcome, so
 * requiring run_command too would be redundant path-grading (agent-testing.md;
 * eval:edit-run-verify is where the run→verify chain is the graded capability).
 * Uses the SHIPPED agentic-persistence system lines (commands-ask.ts).
 *
 * LOCAL OLLAMA ONLY; skips (exit 0) when Ollama or the muse-runner binary is
 * unavailable.  MUSE_EVAL_REPEAT=3 node scripts/eval-multifile-fix.mjs
 */
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createFileEditTool, createFileGrepTool, createFileReadTool } from "../packages/fs/dist/index.js";
import { createRustRunnerTool } from "../packages/tools/dist/index.js";
import { createMuseRuntimeAssembly } from "../packages/autoconfigure/dist/index.js";

import { gradeMultifileFix } from "./lib/grade-multifile-fix.mjs";

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

// `multiply` is the bug (returns a + b); `add` legitimately returns a + b, so a
// bare old_string match is ambiguous and `add` must stay untouched.
const MATH = `export function add(a, b) {
  return a + b;
}

export function subtract(a, b) {
  return a - b;
}

export function multiply(a, b) {
  return a + b;
}

export function divide(a, b) {
  return a / b;
}
`;
const STRINGS = `export function upper(s) {
  return String(s).toUpperCase();
}
`;
// A REALISTIC failing test: it names the function and prints expected-vs-got, the
// diagnostic a real agent navigates from (an opaque "FAIL" with no detail is an
// unfair fixture — it hides the very signal debugging depends on).
const TEST = `import { add, multiply } from "./src/math.mjs";
if (multiply(3, 4) === 12 && multiply(2, 5) === 10 && add(1, 2) === 3) {
  console.log("TEST PASS");
  process.exit(0);
}
console.error(\`TEST FAIL: multiply(3, 4) returned \${multiply(3, 4)}, expected 12 (check the multiply function in src/math.mjs)\`);
process.exit(1);
`;

// The SHIPPED --with-tools persistence lines (commands-ask.ts) verbatim — this
// probe must measure PRODUCTION behavior. (An extra "use file_read, not the
// shell, to inspect" nudge was tried here and did NOT redirect the model — it
// kept reaching for cat/ls/find — so it is NOT shipped and NOT in this probe.)
const SYSTEM = [
  "You are Muse. Use the file and command tools to do what the user asks.",
  "When a task needs several steps (e.g. read a file, change it, run a command), keep taking the next action after each tool result until it is actually done — do not stop after a single tool call.",
  "If a command or test you run reports a failure, find the cause, fix it with your tools, and run it again to confirm it passes before you answer."
].join(" ");

function runTest(testPath) {
  return new Promise((resolve) => {
    const child = spawn("node", [testPath], { stdio: "ignore" });
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
  });
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
    if (dir) await rm(dir, { force: true, recursive: true }).catch(() => {});
    dir = await mkdtemp(join(tmpdir(), "muse-multifile-fix-"));
    await mkdir(join(dir, "src"), { recursive: true });
    const mathPath = join(dir, "src", "math.mjs");
    const testPath = join(dir, "test.mjs");
    await writeFile(mathPath, MATH);
    await writeFile(join(dir, "src", "strings.mjs"), STRINGS);
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
      `The test at ${testPath} is failing. Run it, find and fix the bug in the source it tests so the ` +
      "test passes, then run it again to confirm. Change only what is necessary.";
    const result = await assembly.agentRuntime.run({
      messages: [
        { content: SYSTEM, role: "system" },
        { content: TASK, role: "user" }
      ],
      metadata: { localMode: true, userId: "eval-multifile-fix" },
      model: assembly.defaultModel
    });
    const toolsUsed = result.toolsUsed ?? [];
    const testPasses = await runTest(testPath);
    const math = await readFile(mathPath, "utf8").catch(() => "");
    // Collateral: `add` and the noise file must be untouched; only multiply changed.
    const addIntact = /export function add\(a, b\) \{\s*return a \+ b;/u.test(math);
    const stringsIntact = (await readFile(join(dir, "src", "strings.mjs"), "utf8").catch(() => "")) === STRINGS;
    // Grade the OUTCOME (bug fixed + no collateral), not whether the model
    // self-ran the test — the harness verifies `testPasses` itself (agent-testing.md).
    const { ok, ranTest: modelRanTest } = gradeMultifileFix({ addIntact, ranTest: toolsUsed.includes("run_command"), stringsIntact, testPasses });
    if (!ok) failures += 1;
    console.log(
      `run ${run.toString()}/${REPEAT.toString()}: ${ok ? "PASS" : "FAIL"}  ` +
      `test-passes=${testPasses.toString()} ran-test=${modelRanTest.toString()} ` +
      `add-intact=${addIntact.toString()} noise-intact=${stringsIntact.toString()} tools=[${toolsUsed.join(",")}]`
    );
    if (!ok) console.log(`  math.mjs multiply now: ${JSON.stringify((math.match(/function multiply[\s\S]*?\}/u) ?? [""])[0])}`);
  }
} finally {
  if (dir) await rm(dir, { force: true, recursive: true }).catch(() => {});
}

if (failures > 0) {
  console.log(`\neval:multifile-fix FAIL — ${failures.toString()}/${REPEAT.toString()} runs failed`);
  process.exit(1);
}
console.log(`\neval:multifile-fix PASS (${REPEAT.toString()}/${REPEAT.toString()} runs — right function fixed, no collateral, verified)`);
