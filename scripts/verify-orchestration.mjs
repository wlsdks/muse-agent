/**
 * eval:orchestration — the ONE live multi-agent battery (maturity review #5).
 *
 * Two real workers on the local model + one injected always-fails worker,
 * sequential mode. Asserts the MAST seams the unit suite can't prove on a
 * real model: (1) the injected failure PROPAGATES as a failed step (never
 * silently swallowed), (2) the run TERMINATES within a bounded wall-clock,
 * (3) the surviving workers' answers reach the fan-in response.
 *
 * LOCAL OLLAMA ONLY; skips (exit 0) when unreachable.
 */
import { OllamaProvider } from "../packages/model/dist/index.js";
import { MultiAgentOrchestrator, RuleBasedAgentWorker, createWorkerResult } from "../packages/multi-agent/dist/index.js";

const MODEL = process.env.MUSE_EVAL_MODEL ?? "gemma4:12b";
const OLLAMA_BASE = (process.env.OLLAMA_BASE_URL ?? "http://127.0.0.1:11434").replace(/\/+$/, "");
const WALL_CLOCK_CAP_MS = 180_000;

try {
  const resp = await fetch(`${OLLAMA_BASE}/api/tags`);
  if (!resp.ok) throw new Error(String(resp.status));
} catch {
  console.log(`eval:orchestration skipped — Ollama unreachable at ${OLLAMA_BASE}.`);
  process.exit(0);
}

const provider = new OllamaProvider({ defaultModel: MODEL });
const modelWorker = (id, instruction) =>
  new RuleBasedAgentWorker(id, `${id} worker`, ["plan"], async (input) => {
    const res = await provider.generate({
      maxOutputTokens: 80,
      messages: [{ content: `${instruction}\n\n${input.messages[input.messages.length - 1]?.content ?? ""}`, role: "user" }],
      model: MODEL,
      temperature: 0
    });
    return createWorkerResult(id, res.output ?? "", input);
  });

const orchestrator = new MultiAgentOrchestrator({
  workers: [
    modelWorker("draft", "Answer in ONE short sentence:"),
    new RuleBasedAgentWorker("broken", "always fails", ["plan"], async () => {
      throw new Error("injected failure (battery)");
    }),
    modelWorker("critic", "Name ONE risk of the plan in one short sentence:")
  ]
});

const startedAt = Date.now();
const result = await orchestrator.run(
  { messages: [{ content: "Plan a 30-minute morning run for tomorrow.", role: "user" }], model: MODEL },
  { mode: "sequential" }
);
const elapsedMs = Date.now() - startedAt;

const statuses = Object.fromEntries(result.results.map((step) => [step.workerId, step.status]));
const failures = [];
if (statuses.broken !== "failed") failures.push(`injected failure NOT propagated (broken=${statuses.broken})`);
if (statuses.draft !== "completed" || statuses.critic !== "completed") failures.push(`real workers did not complete (${JSON.stringify(statuses)})`);
if (elapsedMs >= WALL_CLOCK_CAP_MS) failures.push(`run exceeded the wall-clock cap (${elapsedMs}ms)`);
if (!result.response.output || result.response.output.trim().length === 0) failures.push("fan-in response is empty");

console.log(`eval:orchestration — ${result.results.length} steps in ${elapsedMs}ms; statuses=${JSON.stringify(statuses)}`);
if (failures.length > 0) {
  for (const failure of failures) console.error(`✗ ${failure}`);
  process.exit(1);
}
console.log("PASS — failure propagated, bounded termination, fan-in carries the survivors");
