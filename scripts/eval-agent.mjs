/**
 * eval:agent — the agent-eval CI GATE (agent-eval gap H).
 *
 * Runs every harness-based agent-eval battery as ONE pass and FAILS (exit 1) if
 * ANY regresses — so a tool-selection / argument / task / adversarial / shadow-
 * trial regression blocks the run, not just logs (Hamel: "an eval suite that
 * never gates a PR catches regressions late"). Mirrors `eval:self-improving`.
 *
 * Each battery already gates via its own exit code (1 = regression) and SKIPS
 * cleanly (exit 0) when local Ollama is unreachable, so this aggregate is also
 * LOCAL-OLLAMA-ONLY and a down environment skips rather than fails. Batteries
 * are spawned as child processes (model/tools are built once by the npm script
 * before this runs), so one failing battery can't abort the rest — all run,
 * then the gate is the OR of their failures.
 */

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const BATTERIES = [
  "eval-tool-selection.mjs", // tool selection + ArgumentCorrectness
  "eval-judge.mjs", // LLM-as-judge meta-eval
  "eval-adversarial.mjs", // must-refuse safety battery
  "eval-shadow-trial.mjs", // report-only promotion shadow trial
];

const results = [];
for (const battery of BATTERIES) {
  console.log(`\n=== eval:agent → ${battery} ===`);
  const r = spawnSync(process.execPath, [join(here, battery)], { encoding: "utf8", env: process.env, stdio: "inherit" });
  results.push({ battery, code: r.status ?? 1 });
}

const failed = results.filter((r) => r.code !== 0);
console.log("\n=== eval:agent summary ===");
for (const r of results) console.log(`  ${r.code === 0 ? "ok  " : "FAIL"}  ${r.battery}`);
if (failed.length > 0) {
  console.error(`eval:agent FAILED — ${failed.length}/${results.length} batteries regressed: ${failed.map((f) => f.battery).join(", ")}`);
  process.exit(1);
}
console.log(`eval:agent PASSED — ${results.length} batteries green (or skipped; local Ollama gates each)`);
