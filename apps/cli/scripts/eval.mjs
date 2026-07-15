/**
 * Muse local eval harness (#29) — one scored regression suite over the agent's
 * quality checks, instead of running each verify-*.mjs by hand. Runs a FAST
 * tier (deterministic, no model) always, and a LIVE tier (local qwen) unless
 * MUSE_EVAL_FAST=1. Prints a scorecard + exits non-zero if any check fails.
 *
 *   node apps/cli/scripts/eval.mjs            (full — fast + live qwen)
 *   MUSE_EVAL_FAST=1 node apps/cli/scripts/eval.mjs   (deterministic only, ~10s)
 *
 * Per 2026 best-practice: evaluate the agent, don't just unit-test it.
 */
import { fileURLToPath } from "node:url";
import path from "node:path";

import { parseBooleanFromEnv } from "@muse/shared";
import { runNodeCommand } from "./run-node-command.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const fast = parseBooleanFromEnv(process.env.MUSE_EVAL_FAST, false);

// name, script, args, tier. Reuses the existing single-purpose verifiers.
const CHECKS = [
  { name: "local-first (no cloud keys)", script: "verify-local-first.mjs", args: [], tier: "fast" },
  { name: "tool exposure (23 domain×intent×lang)", script: "verify-tool-exposure.mjs", args: [], tier: "fast" },
  { name: "tool selection (remember_fact)", script: "verify-tool-selection.mjs", args: ["remember my dentist is Dr. Kim", "remember_fact"], tier: "live" },
  { name: "structured output (schema-valid JSON)", script: "verify-structured-output.mjs", args: [], tier: "live" },
  { name: "memory safety + abstention", script: "verify-memory-safety.mjs", args: [], tier: "live" },
  { name: "reflection synthesis (grounded + neg)", script: "verify-reflection.mjs", args: [], tier: "live" },
  { name: "tool battery (domains × EN/KO × casual)", script: "verify-tool-battery.mjs", args: [], tier: "live" },
  { name: "tool-arg quality (key args filled, no fabricated via)", script: "verify-tool-args.mjs", args: [], tier: "live" }
];

function run(check) {
  return runNodeCommand({
    command: "node",
    args: [path.join(here, check.script), ...check.args],
    timeoutMs: 300_000
  }).then((result) => ({ ...check, code: result.exitCode }));
}

const selected = CHECKS.filter((c) => !fast || c.tier === "fast");
console.log(`Muse eval — ${selected.length} checks (${fast ? "FAST only" : "fast + live qwen"})\n`);

let pass = 0;
for (const check of selected) {
  process.stdout.write(`  … ${check.name} `);
  const r = await run(check);
  const ok = r.code === 0;
  if (ok) pass += 1;
  console.log(ok ? "✓ PASS" : `✗ FAIL (exit ${r.code}${r.code === 124 ? " timeout" : ""})`);
}

const score = Math.round((pass / selected.length) * 100);
console.log(`\nSCORE: ${pass}/${selected.length} (${score}%)`);
process.exit(pass === selected.length ? 0 : 1);
