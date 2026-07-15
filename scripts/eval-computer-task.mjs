/**
 * eval:computer-task — the multi-step FILE computer-control chain on the live
 * local model.
 *
 * eval:tools proves one-shot SELECTION and eval:file-read proves the read tool
 * mechanics; this proves gemma4 can carry a real computer task across tool
 * rounds: locate a buggy source file (file_grep / file_read), then FIX it
 * (file_edit) so the code behaves correctly. Graded on the TERMINAL STATE, not
 * the path (agent-testing.md): the harness re-imports the edited module and
 * executes it, so a fabricated "I fixed it" cannot pass — add() must actually
 * return a + b — and the untouched sibling (multiply) must still work, asserting
 * no collateral damage (AppWorld class).
 *
 * LOCAL OLLAMA ONLY; skips (exit 0) when Ollama is unavailable.
 *   MUSE_EVAL_REPEAT=3 node scripts/eval-computer-task.mjs   # pass^k
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { createFileEditTool, createFileGrepTool, createFileReadTool } from "../packages/fs/dist/index.js";
import { createMuseRuntimeAssembly } from "../packages/autoconfigure/dist/index.js";
import { readTextOrDefault, runBestEffort } from "./best-effort.mjs";

const OLLAMA_BASE = (process.env.OLLAMA_BASE_URL ?? "http://127.0.0.1:11434").replace(/\/+$/, "");
const REPEAT = Math.max(1, Math.trunc(Number(process.env.MUSE_EVAL_REPEAT ?? "1")));

try {
  const probe = await fetch(`${OLLAMA_BASE}/api/version`, { signal: AbortSignal.timeout(3000) });
  if (!probe.ok) throw new Error(`status ${probe.status}`);
} catch (cause) {
  console.log(`SKIP: Ollama unreachable (${cause instanceof Error ? cause.message : cause})`);
  process.exit(0);
}

// The bug lives in ONE of several files so the model must actually search,
// not guess. Only math-utils.mjs is wrong (add subtracts); the rest are noise.
const BUGGY_ADD = `export function add(a, b) {
  return a - b;
}

export function multiply(a, b) {
  return a * b;
}
`;
const NOISE_STRING = `export function shout(text) {
  return String(text).toUpperCase();
}
`;
const NOISE_README = `# Demo project

A tiny utility package. The math helpers live in src/math-utils.mjs.
`;

const allow = () => ({ approved: true });
const logTool = (tool) => ({
  ...tool,
  execute: async (args, ctx) => {
    const result = await tool.execute(args, ctx);
    if (process.env.MUSE_TASK_DEBUG) {
      console.log(`  [tool] ${tool.definition.name}(${JSON.stringify(args).slice(0, 160)}) → ${JSON.stringify(result).slice(0, 160)}`);
    }
    return result;
  }
});

const TASK =
  "There is a bug in the math helpers of the project at PROJECT_DIR. The add(a, b) " +
  "function returns the wrong result — it subtracts instead of adding. Find the source " +
  "file that defines add and fix it so add(a, b) returns the sum a + b. Change nothing else.";

let failures = 0;
let dir;
try {
  for (let run = 1; run <= REPEAT; run += 1) {
    // A fresh project per run so a prior run's fix can't leak terminal state.
    if (dir) await runBestEffort(() => rm(dir, { force: true, recursive: true }), "previous run directory cleanup");
    dir = await mkdtemp(join(tmpdir(), "muse-computer-task-"));
    const src = join(dir, "src");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(src, { recursive: true });
    const mathFile = join(src, "math-utils.mjs");
    await writeFile(mathFile, BUGGY_ADD);
    await writeFile(join(src, "string-utils.mjs"), NOISE_STRING);
    await writeFile(join(dir, "README.md"), NOISE_README);

    // Read-before-edit grounding wired live: file_edit fail-closes unless the
    // model read the file first (it does — grep→read→edit), so this also asserts
    // the gate doesn't break the completion path.
    const readPaths = new Set();
    const readOpts = { baseDir: dir, docRoots: [dir], onPathRead: (p) => readPaths.add(p), roots: [dir] };
    const writeOpts = { approvalGate: allow, baseDir: dir, roots: [dir], wasPathRead: (p) => readPaths.has(p) };
    const assembly = createMuseRuntimeAssembly({
      extraTools: [
        createFileGrepTool(readOpts),
        createFileReadTool(readOpts),
        createFileEditTool(writeOpts)
      ].map(logTool)
    });
    if (!assembly.agentRuntime || !assembly.modelProvider) {
      console.log("SKIP: no agent runtime/model configured");
      process.exit(0);
    }

    const result = await assembly.agentRuntime.run({
      messages: [
        { content: "You are Muse. Use the file tools to do what the user asks, then briefly confirm what you changed.", role: "system" },
        { content: TASK.replace("PROJECT_DIR", dir), role: "user" }
      ],
      // localMode arms the write-risk file_edit (the CLI sets this under --actuators).
      metadata: { localMode: true, userId: "eval-computer-task" },
      model: assembly.defaultModel
    });
    const toolsUsed = result.toolsUsed ?? [];

    // TERMINAL STATE: re-import the edited module and run it. Cache-bust the
    // ESM loader with a per-run query so a prior import can't mask the result.
    const fixed = await readTextOrDefault(() => readFile(mathFile, "utf8"));
    let addWorks = false;
    let multiplyIntact = false;
    try {
      const mod = await import(`${pathToFileURL(mathFile).href}?v=${run.toString()}`);
      addWorks = typeof mod.add === "function" && mod.add(2, 3) === 5 && mod.add(10, 4) === 14;
      multiplyIntact = typeof mod.multiply === "function" && mod.multiply(2, 3) === 6;
    } catch {
      addWorks = false;
    }
    const noiseIntact = (await readTextOrDefault(() => readFile(join(src, "string-utils.mjs"), "utf8")) === NOISE_STRING);
    const ok = addWorks && multiplyIntact && noiseIntact;
    if (!ok) failures += 1;
    console.log(
      `run ${run.toString()}/${REPEAT.toString()}: ${ok ? "PASS" : "FAIL"}  ` +
      `add-works=${addWorks.toString()} multiply-intact=${multiplyIntact.toString()} ` +
      `no-collateral=${noiseIntact.toString()} tools=[${toolsUsed.join(",")}]`
    );
    if (!ok) console.log(`  edited file:\n${fixed.split("\n").map((l) => `    ${l}`).join("\n")}`);
  }
} finally {
  if (dir) await runBestEffort(() => rm(dir, { force: true, recursive: true }), "temporary eval directory cleanup");
}

if (failures > 0) {
  console.log(`\neval:computer-task FAIL — ${failures.toString()}/${REPEAT.toString()} runs failed`);
  process.exit(1);
}
console.log(`\neval:computer-task PASS (${REPEAT.toString()}/${REPEAT.toString()} runs — terminal state: code runs correctly, no collateral)`);
