/**
 * precheck:grounding — the pre-push tripwire for the fabrication=0 invariant.
 *
 *   pnpm precheck:grounding            # MUSE_EVAL_REPEAT=2 (pass^k)
 *
 * Muse's identity is "it can't lie to you", and CLAUDE.md calls fabrication=0 a
 * release gate — yet the only git hook is the immutable-core commit-msg guard, so
 * a grounding regression could land on a green `pnpm check`. This runs the tight
 * fabrication-critical battery subset LIVE on the local model and fails the push
 * if any regresses. It is the behavioural complement to self-eval's deterministic
 * grounded-surface-count ratchet (a dropped surface) — this catches a degraded
 * surface that is still registered.
 *
 * Each battery is re-spawned MUSE_EVAL_REPEAT times and must pass EVERY run
 * (pass^k, the τ-bench reliability gate — a single flaky run fails the battery).
 *
 * Fail-open ONLY on a broken environment, never on a real regression:
 *   - local Ollama unreachable        → SKIP (exit 0); a skip is not a pass.
 *   - a battery exceeds its timeout    → SKIP that battery (exit 0 unless another
 *     battery actually FAILED). This is the loop-PC stall mitigation: a hung
 *     model path must not block every push forever, but a model that answers and
 *     fabricates MUST block. Only a battery that RUNS and FAILS blocks the push.
 *
 * LOCAL OLLAMA ONLY by policy (same as smoke:live / eval:self-improving).
 */

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const baseUrl = (process.env.OLLAMA_BASE_URL ?? "http://localhost:11434").replace(/\/$/, "");
const REPEAT = Math.max(1, Number(process.env.MUSE_EVAL_REPEAT ?? 2));
const PER_BATTERY_TIMEOUT_MS = Math.max(10_000, Number(process.env.MUSE_PRECHECK_TIMEOUT_MS ?? 150_000));

// The tightest fabrication-critical set: the scored faithfulness/false-refusal
// rates, the recall citation gate, and the MaTTS re-verification gate. These are
// the surfaces where a regression means Muse confidently asserts an ungrounded
// claim — the exact failure the product forbids.
const BATTERIES = [
  { file: "apps/cli/scripts/verify-faithfulness-rate.mjs", name: "faithfulness-rate" },
  { file: "apps/cli/scripts/verify-recall-citation-gate.mjs", name: "recall-citation-gate" },
  { file: "apps/cli/scripts/verify-rubric-reverify.mjs", name: "rubric-reverify" }
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
    `precheck:grounding skipped — local Ollama not reachable at ${baseUrl}. ` +
      "A skip is not a pass; getting Ollama up is the priority. (LOCAL OLLAMA ONLY; cloud APIs are never used.)"
  );
  process.exit(0);
}

console.log(
  `precheck:grounding — ${BATTERIES.length} fabrication-critical batteries × ${REPEAT} (pass^${REPEAT}) on ${baseUrl}\n`
);

/** Run one battery once. Returns "pass" | "fail" | "timeout". */
function runOnce(file) {
  const run = spawnSync("node", [file], {
    cwd: rootDir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: PER_BATTERY_TIMEOUT_MS
  });
  const timedOut = run.error?.code === "ETIMEDOUT" || (run.status === null && run.signal != null);
  if (timedOut) {
    return { outcome: "timeout", tail: "" };
  }
  const tail = `${run.stdout ?? ""}${run.stderr ?? ""}`.trim().split("\n").slice(-12).join("\n");
  return { outcome: run.status === 0 ? "pass" : "fail", tail };
}

const failed = [];
const skipped = [];

for (const battery of BATTERIES) {
  process.stdout.write(`▶ ${battery.name} … `);
  let outcome = "pass";
  let lastTail = "";
  for (let i = 0; i < REPEAT; i += 1) {
    const r = runOnce(battery.file);
    lastTail = r.tail || lastTail;
    if (r.outcome !== "pass") {
      outcome = r.outcome;
      break;
    }
  }
  if (outcome === "pass") {
    console.log(`PASS (${REPEAT}/${REPEAT})`);
  } else if (outcome === "timeout") {
    skipped.push(battery.name);
    console.log(`SKIP (timed out > ${String(Math.round(PER_BATTERY_TIMEOUT_MS / 1000))}s — environment stall, not counted as a pass)`);
  } else {
    failed.push(battery.name);
    console.log("FAIL");
    if (lastTail) {
      console.log(lastTail + "\n");
    }
  }
}

if (failed.length > 0) {
  console.log(
    `\n${failed.length}/${BATTERIES.length} FABRICATION-CRITICAL battery regressed: ${failed.join(", ")} — push blocked. ` +
      "Fix the grounding regression before pushing (or, in a genuine emergency, MUSE_SKIP_PREPUSH=1)."
  );
  process.exit(1);
}

if (skipped.length === BATTERIES.length) {
  console.log(
    `\nALL ${BATTERIES.length} batteries skipped on timeout — could NOT verify grounding (environment stall). ` +
      "Push allowed (a skip is not a pass), but this needs fixing."
  );
  process.exit(0);
}

console.log(
  `\nALL PASS — ${BATTERIES.length - skipped.length}/${BATTERIES.length} fabrication-critical batteries green at pass^${REPEAT}` +
    (skipped.length > 0 ? ` (${skipped.length} skipped on timeout)` : "")
);
process.exit(0);
