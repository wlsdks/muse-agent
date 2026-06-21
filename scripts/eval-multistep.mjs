/**
 * eval:multistep — ONE regression gate over the three multi-step computer-task
 * batteries, so the FAIL→PASS gains (computer-control fires 40-51) can't silently
 * rot. agent-testing.md: "bundle the batteries as one CI gate; CI-gate it or it
 * rots", and pass^k via MUSE_EVAL_REPEAT.
 *
 *   pnpm eval:multistep
 *   MUSE_EVAL_REPEAT=3 pnpm eval:multistep   # pass^k reliability (all k must pass)
 *
 * Runs, against the LOCAL Ollama default model (never a cloud API):
 *   - eval-computer-task.mjs    (single-file grep→read→edit chain)
 *   - eval-multifile-fix.mjs    (find the buggy fn among many, fix, verify)
 *   - eval-edit-run-verify.mjs  (edit→run→verify agentic-persistence loop)
 *
 * Exit 0 when every battery passes (or SKIPs — Ollama/runner unavailable; a skip
 * is not a pass but keeps the gate green on a bare machine, same policy as
 * eval:self-improving / smoke:live). Exit 1 when ANY fails (regression-first: the
 * loop fixes it before new work). The sub-evals honour MUSE_EVAL_REPEAT
 * themselves, so it is passed straight through. LOCAL OLLAMA ONLY by policy.
 */

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const baseUrl = (process.env.OLLAMA_BASE_URL ?? "http://localhost:11434").replace(/\/$/, "");

const BATTERIES = [
  { file: "scripts/eval-computer-task.mjs", name: "computer-task" },
  { file: "scripts/eval-multifile-fix.mjs", name: "multifile-fix" },
  { file: "scripts/eval-edit-run-verify.mjs", name: "edit-run-verify" }
];

async function ollamaReachable() {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3_000);
    const response = await fetch(`${baseUrl}/api/tags`, { signal: controller.signal });
    clearTimeout(timer);
    return response.ok;
  } catch {
    return false;
  }
}

if (!(await ollamaReachable())) {
  console.log(
    `eval:multistep skipped — local Ollama not reachable at ${baseUrl}. ` +
      "A skip is not a pass; getting Ollama up is the priority (cloud APIs are never used by policy)."
  );
  process.exit(0);
}

const repeat = process.env.MUSE_EVAL_REPEAT ?? "1";
console.log(`eval:multistep — ${BATTERIES.length} multi-step batteries on local Ollama (${baseUrl}), MUSE_EVAL_REPEAT=${repeat}\n`);

const results = [];
for (const battery of BATTERIES) {
  process.stdout.write(`▶ ${battery.name} … `);
  const run = spawnSync("node", [battery.file], { cwd: rootDir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const ok = run.status === 0;
  results.push({ ...battery, ok, status: run.status });
  console.log(ok ? "PASS" : `FAIL (exit ${String(run.status)})`);
  if (!ok) {
    const tail = `${run.stdout ?? ""}${run.stderr ?? ""}`.trim().split("\n").slice(-12).join("\n");
    console.log(tail ? `${tail}\n` : "(no output)\n");
  }
}

const failed = results.filter((r) => !r.ok);
console.log(
  failed.length === 0
    ? `\nALL PASS — ${results.length}/${results.length} multi-step batteries green`
    : `\n${failed.length}/${results.length} FAILED: ${failed.map((r) => r.name).join(", ")} — fix the regression before new work`
);
process.exit(failed.length === 0 ? 0 : 1);
