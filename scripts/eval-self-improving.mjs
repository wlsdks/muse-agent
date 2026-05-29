/**
 * eval:self-improving — ONE regression gate over the four LLM live batteries
 * that back the self-improving frontiers, so those slices can't silently rot.
 *
 *   pnpm eval:self-improving
 *
 * Runs, against the LOCAL Ollama qwen (never a cloud API):
 *   - verify-pattern-suggestion.mjs  (③ proactive: grounded suggestion / no fabrication)
 *   - verify-preference-inference.mjs (② personalization: infer pref / NONE on one-off)
 *   - verify-skill-merge.mjs          (① self-improve: umbrella merge / NONE on unrelated)
 *   - verify-playbook-merge.mjs       (① self-improve: strategy merge / no force-merge)
 *
 * Exit 0 when every battery passes. Exit 1 when ANY fails (regression-first:
 * the loop fixes it before new work). Exit 0 with a SKIP when local Ollama is
 * unreachable — a skip is not a pass, but it keeps the gate green on a machine
 * with no model up (getting Ollama up is then the priority work, same policy as
 * smoke:live). LOCAL OLLAMA QWEN ONLY by policy.
 */

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const baseUrl = (process.env.OLLAMA_BASE_URL ?? "http://localhost:11434").replace(/\/$/, "");

const BATTERIES = [
  { axis: "③ proactive", file: "apps/cli/scripts/verify-pattern-suggestion.mjs", name: "pattern-suggestion" },
  { axis: "② personalization", file: "apps/cli/scripts/verify-preference-inference.mjs", name: "preference-inference" },
  { axis: "① self-improve", file: "apps/cli/scripts/verify-skill-merge.mjs", name: "skill-merge" },
  { axis: "① self-improve", file: "apps/cli/scripts/verify-playbook-merge.mjs", name: "playbook-merge" }
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
    `eval:self-improving skipped — local Ollama not reachable at ${baseUrl}. ` +
      "Start Ollama with a Qwen model (OLLAMA_BASE_URL to override; cloud APIs are never used by policy). A skip is not a pass."
  );
  process.exit(0);
}

console.log(`eval:self-improving — ${BATTERIES.length} live batteries on local Ollama (${baseUrl})\n`);

const results = [];
for (const battery of BATTERIES) {
  process.stdout.write(`▶ ${battery.name} (${battery.axis}) … `);
  const run = spawnSync("node", [battery.file], { cwd: rootDir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const ok = run.status === 0;
  results.push({ ...battery, ok, status: run.status });
  console.log(ok ? "PASS" : `FAIL (exit ${String(run.status)})`);
  if (!ok) {
    // Surface the failing battery's tail so the regression is actionable.
    const tail = `${run.stdout ?? ""}${run.stderr ?? ""}`.trim().split("\n").slice(-12).join("\n");
    console.log(tail ? `${tail}\n` : "(no output)\n");
  }
}

const failed = results.filter((r) => !r.ok);
console.log(
  failed.length === 0
    ? `\nALL PASS — ${results.length}/${results.length} self-improving batteries green`
    : `\n${failed.length}/${results.length} FAILED: ${failed.map((r) => r.name).join(", ")} — fix the regression before new work`
);
process.exit(failed.length === 0 ? 0 : 1);
