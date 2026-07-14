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

import { classifyOutcome, classifySkip } from "./eval-skip.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const BATTERIES = [
  "eval-tool-selection.mjs", // tool selection + ArgumentCorrectness
  "eval-judge.mjs", // LLM-as-judge meta-eval
  "eval-adversarial.mjs", // must-refuse safety battery
  "eval-shadow-trial.mjs", // report-only promotion shadow trial
  "eval-plan-quality.mjs", // PlanQuality: valid/complete/ordered/efficient plans
  "eval-whetstone.mjs", // Whetstone self-weakness loop: grounded remediation + BKT mastery gating (deterministic)
  "verify-orchestration.mjs", // live multi-agent: failure propagation + bounded termination + fan-in (MAST seams)
  "../apps/cli/scripts/verify-vision-actions.mjs", // grounded vision: image → routed action
  "verify-multihop.mjs", // second-hop AUGMENT: same-base inline+hop vs no-hop, fail-close on regression
  "eval-channel-rhythm.mjs", // channel delegation-ack quality + upstream casual fast-path
  "eval-council-floors.mjs", // live KO/EN calibration of the council screening floors (real embedder)
];

const results = [];
for (const battery of BATTERIES) {
  console.log(`\n=== eval:agent → ${battery} ===`);
  // Capture (not inherit) so the aggregate can tell a real PASS from an
  // exit-0 SKIP; the battery's own output is echoed back so nothing is hidden.
  const r = spawnSync(process.execPath, [join(here, battery)], { encoding: "utf8", env: process.env, stdio: ["ignore", "pipe", "pipe"] });
  const combined = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  process.stdout.write(combined);
  const skipCode = classifySkip(combined);
  const outcome = classifyOutcome({ exitCode: r.status ?? 1, skipCode });
  results.push({ battery, outcome, skipCode, code: r.status ?? 1 });
}

const failed = results.filter((r) => r.outcome === "fail");
const skipped = results.filter((r) => r.outcome === "skip");
const passed = results.filter((r) => r.outcome === "ok");
console.log("\n=== eval:agent summary ===");
for (const r of results) {
  const tag = r.outcome === "ok" ? "ok  " : r.outcome === "skip" ? "skip" : "FAIL";
  console.log(`  ${tag}  ${r.battery}${r.outcome !== "ok" && r.skipCode ? ` (${r.skipCode})` : ""}`);
}
if (failed.length > 0) {
  console.error(
    `eval:agent FAILED — ${failed.length}/${results.length} batteries regressed: ${failed
      .map((f) => (f.skipCode === "embed-model-missing" ? `${f.battery} (embed model not pulled — ollama pull nomic-embed-text-v2-moe)` : f.battery))
      .join(", ")}`
  );
  process.exit(1);
}
console.log(`eval:agent PASSED — ${passed.length} pass, ${skipped.length} skip, 0 fail across ${results.length} batteries`);
