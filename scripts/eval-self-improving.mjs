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
 * smoke:live). LOCAL OLLAMA ONLY by policy.
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
  { axis: "① self-improve", file: "apps/cli/scripts/verify-playbook-merge.mjs", name: "playbook-merge" },
  { axis: "① self-improve: correction-decay polarity (sign-safe)", file: "apps/cli/scripts/verify-correction-polarity.mjs", name: "correction-polarity" },
  { axis: "① self-improve", file: "apps/cli/scripts/verify-background-review.mjs", name: "background-review" },
  { axis: "①②③ engine e2e", file: "apps/cli/scripts/verify-background-review-e2e.mjs", name: "background-review-e2e" },
  { axis: "① self-improve: cross-session experience-delta (A/B, empty vs primed store)", file: "apps/cli/scripts/verify-experience-delta.mjs", name: "experience-delta" },
  { axis: "★ WEDGE: cited recall", file: "apps/cli/scripts/verify-cited-recall.mjs", name: "cited-recall" },
  { axis: "★ WEDGE: conflict-surfacing (I-have-conflicting-notes)", file: "apps/cli/scripts/verify-conflict-surfacing.mjs", name: "conflict-surfacing" },
  { axis: "★ WEDGE: remember-honesty (won't lie about saving)", file: "apps/cli/scripts/verify-remember-honesty.mjs", name: "remember-honesty" },
  { axis: "★ WEDGE: due-date reasoning (local dates, not raw UTC ISO)", file: "apps/cli/scripts/verify-due-date-reasoning.mjs", name: "due-date-reasoning" },
  { axis: "★ WEDGE: recall citation gate", file: "apps/cli/scripts/verify-recall-citation-gate.mjs", name: "recall-citation-gate" },
  { axis: "★ WEDGE: rubric grounding gate", file: "apps/cli/scripts/verify-rubric-gate.mjs", name: "rubric-gate" },
  { axis: "★ WEDGE: rubric re-verification (MaTTS)", file: "apps/cli/scripts/verify-rubric-reverify.mjs", name: "rubric-reverify" },
  { axis: "★ WEDGE: scored faithfulness + false-refusal rates", file: "apps/cli/scripts/verify-faithfulness-rate.mjs", name: "faithfulness-rate" },
  { axis: "★ WEDGE: claim-level value grounding (wrong-value hole)", file: "apps/cli/scripts/verify-claim-grounding.mjs", name: "claim-grounding" },
  { axis: "★ WEDGE: misgrounding false-positive guard (grounded answer never mislabelled → clean flywheel fuel)", file: "apps/cli/scripts/verify-misgrounding.mjs", name: "misgrounding" },
  { axis: "★ WEDGE: attributed self-repair (constructive, fail-closed)", file: "apps/cli/scripts/verify-attributed-repair.mjs", name: "attributed-repair" },
  { axis: "★ NORTH STAR: gated proactive recall", file: "apps/cli/scripts/verify-proactive-recall-gate.mjs", name: "proactive-recall-gate" },
  { axis: "★ DREAMING: grounded reflection", file: "apps/cli/scripts/verify-reflection-synthesis.mjs", name: "reflection-synthesis" },
  { axis: "★ DREAMING: reflection RGV re-verify", file: "apps/cli/scripts/verify-reflection-grounding.mjs", name: "reflection-grounding" },
  { axis: "★ SWARM: grounded council synthesis", file: "apps/cli/scripts/verify-council.mjs", name: "council" },
  { axis: "★ SWARM: council RGV re-verify", file: "apps/cli/scripts/verify-council-grounding.mjs", name: "council-grounding" },
  { axis: "★ SWARM: council self-abstention (5th surface)", file: "apps/cli/scripts/verify-council-self-abstention.mjs", name: "council-self-abstention" },
  { axis: "⏰ ACTUATION: reminder local-time confirmation (no UTC misread)", file: "apps/cli/scripts/verify-reminder-local-time.mjs", name: "reminder-local-time" },
  { axis: "⏰ ACTUATION: task local-time confirmation (no UTC misread)", file: "apps/cli/scripts/verify-task-local-time.mjs", name: "task-local-time" },
  { axis: "⏰ ACTUATION: calendar local-time confirmation (no raw-ISO echo)", file: "apps/cli/scripts/verify-calendar-local-time.mjs", name: "calendar-local-time" },
  { axis: "★ VISION: grounding floor on the image surface (answer visible / abstain on absent)", file: "apps/cli/scripts/verify-vision-grounding.mjs", name: "vision-grounding" },
  { axis: "★ WEDGE: runGroundedRecall seam (the API-surface pipeline; fabrication stripped IN the seam)", file: "apps/cli/scripts/verify-grounded-recall-seam.mjs", name: "grounded-recall-seam" },
  { axis: "★ WEDGE: POST /api/ask SSE stream (real route; live citation filter holds delta-by-delta)", file: "apps/api/scripts/verify-sse-ask-stream.mjs", name: "sse-ask-stream" },
  { axis: "★ WEDGE: channel conversational reply (Telegram/Matrix runner; gate + pairing fail-close)", file: "apps/api/scripts/verify-channel-reply-grounding.mjs", name: "channel-reply-grounding" },
  { axis: "★ WEDGE: browsing cited recall (local history under the citation gate)", file: "apps/cli/scripts/verify-browsing-recall.mjs", name: "browsing-recall" },
  { axis: "★ WEDGE: cross-lingual feed rescue (KO query → EN headline out of the recency window)", file: "apps/cli/scripts/verify-feed-crosslingual.mjs", name: "feed-crosslingual" },
  { axis: "★ WEDGE: muse mcp serve grounding gate (muse_recall over the real MCP wire)", file: "apps/cli/scripts/verify-mcp-serve-grounding.mjs", name: "mcp-serve-grounding" },
  { axis: "★ WEDGE: compaction-preservation (fail-close post-compaction quality gate)", file: "apps/cli/scripts/verify-compaction-preservation.mjs", name: "compaction-preservation" },
  { axis: "★ WEDGE: evidence-gated objective completion (done = proven, never model say-so)", file: "apps/cli/scripts/verify-objective-completion.mjs", name: "objective-completion" },
  { axis: "★ IDENTITY: Muse persona holds on the local engine (no vendor leak, no sycophancy) — real /api/chat HTTP surface", file: "apps/api/scripts/verify-identity.mjs", name: "identity" }
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
