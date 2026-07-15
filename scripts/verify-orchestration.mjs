/**
 * eval:orchestration — the live multi-agent battery (maturity review #5, extended).
 *
 * The deterministic MAST cases (step-repetition, unaware-of-termination) and the
 * capacity-refusal case need no model, so they run every time and are repeated
 * MUSE_EVAL_REPEAT times (pass^k) — a stochastic race against a timer deserves
 * more than one green run before it's trusted. The live model-worker case
 * (injected failure propagation + bounded wall-clock + fan-in) still needs
 * Ollama and skips independently, so a down Ollama never hides a deterministic
 * regression in the MAST/capacity cases.
 */
import { OllamaProvider } from "../packages/model/dist/index.js";
import { MultiAgentOrchestrator, RuleBasedAgentWorker, createWorkerResult } from "../packages/multi-agent/dist/index.js";

const MODEL = process.env.MUSE_EVAL_MODEL ?? "gemma4:12b";
const OLLAMA_BASE = (process.env.OLLAMA_BASE_URL ?? "http://127.0.0.1:11434").replace(/\/+$/, "");
const WALL_CLOCK_CAP_MS = 180_000;
// Floor at 1: a pass^k gate whose k parses to 0/NaN (`MUSE_EVAL_REPEAT=0`, "",
// "three") would run the cases ZERO times and still print "clean" — a gate that
// can be silently disabled. Coerce anything non-finite/<1 back to the default.
const parsedRepeat = Number(process.env.MUSE_EVAL_REPEAT ?? 3);
const REPEAT = Number.isFinite(parsedRepeat) && parsedRepeat >= 1 ? Math.floor(parsedRepeat) : 3;

const instructionInput = { messages: [{ content: "Plan a 30-minute morning run for tomorrow.", role: "user" }], model: MODEL };
const neverResolve = () => Promise.withResolvers().promise;

function ruleWorker(id, handler) {
  return new RuleBasedAgentWorker(id, `${id} worker`, ["plan"], handler);
}

function instantWorker(id) {
  return ruleWorker(id, async (input) => createWorkerResult(id, `${id} output`, input));
}

/** MAST step-repetition: every selected worker must execute EXACTLY once — no
 *  duplicated step, no worker dropped from the fan-out it was given. */
async function runStepRepetitionCase() {
  const ids = ["alpha", "beta", "gamma"];
  const orchestrator = new MultiAgentOrchestrator({ workers: ids.map((id) => instantWorker(id)) });
  const result = await orchestrator.run(instructionInput, { mode: "sequential" });
  const resultIds = result.results.map((step) => step.workerId);

  const failures = [];
  if (resultIds.length !== ids.length) failures.push(`expected ${ids.length.toString()} steps, got ${resultIds.length.toString()}`);
  if (new Set(resultIds).size !== resultIds.length) failures.push(`a worker executed more than once: ${JSON.stringify(resultIds)}`);
  if (JSON.stringify(resultIds) !== JSON.stringify(ids)) failures.push(`worker set/order drifted: ${JSON.stringify(resultIds)}`);
  return failures;
}

/** MAST unaware-of-termination: a hung worker under `workerTimeoutMs` must be
 *  explicitly terminated (failed with the deadline error), not left to hang —
 *  and the run must still finish, carrying the surviving worker. */
async function runTerminationCase() {
  const timeoutMs = 200;
  const hung = ruleWorker("hung", () => neverResolve());
  const fast = instantWorker("fast");
  const orchestrator = new MultiAgentOrchestrator({ workers: [hung, fast], workerTimeoutMs: timeoutMs });

  const startedAt = Date.now();
  const result = await orchestrator.run(instructionInput, { mode: "sequential" });
  const elapsedMs = Date.now() - startedAt;
  const steps = Object.fromEntries(result.results.map((step) => [step.workerId, step]));

  const failures = [];
  if (steps.hung?.status !== "failed") failures.push(`hung worker was not terminated (status=${String(steps.hung?.status)})`);
  if (!new RegExp(`exceeded the ${timeoutMs.toString()}ms deadline`).test(steps.hung?.error ?? "")) {
    failures.push(`hung worker's failure was not the deadline timeout (error=${String(steps.hung?.error)})`);
  }
  if (steps.fast?.status !== "completed") failures.push(`surviving worker did not complete (status=${String(steps.fast?.status)})`);
  if (elapsedMs >= 5_000) failures.push(`termination was not bounded (${elapsedMs.toString()}ms)`);
  return failures;
}

/** Capacity refusal: `maxWorkers` below the selected worker count must cap
 *  actual dispatch — the excess worker never runs, it isn't recorded as a failure. */
async function runCapacityRefusalCase() {
  const ids = ["one", "two", "three"];
  const maxWorkers = 2;
  const orchestrator = new MultiAgentOrchestrator({ workers: ids.map((id) => instantWorker(id)) });
  const result = await orchestrator.run(instructionInput, { mode: "sequential", maxWorkers });
  const resultIds = result.results.map((step) => step.workerId);

  const failures = [];
  if (result.results.length !== maxWorkers) failures.push(`expected ${maxWorkers.toString()} workers under the cap, got ${result.results.length.toString()}`);
  if (resultIds.includes("three")) failures.push(`excess worker "three" ran despite maxWorkers=${maxWorkers.toString()}`);
  return failures;
}

const deterministicFailures = [];
for (let iteration = 1; iteration <= REPEAT; iteration += 1) {
  const [stepRepetition, termination, capacity] = await Promise.all([
    runStepRepetitionCase(),
    runTerminationCase(),
    runCapacityRefusalCase()
  ]);
  for (const failure of stepRepetition) deterministicFailures.push(`[iteration ${iteration.toString()}] step-repetition: ${failure}`);
  for (const failure of termination) deterministicFailures.push(`[iteration ${iteration.toString()}] unaware-of-termination: ${failure}`);
  for (const failure of capacity) deterministicFailures.push(`[iteration ${iteration.toString()}] capacity-refusal: ${failure}`);
}

console.log(`eval:orchestration — MAST + capacity cases, pass^${REPEAT.toString()}: ${deterministicFailures.length === 0 ? "all iterations clean" : `${deterministicFailures.length.toString()} failures`}`);
if (deterministicFailures.length > 0) {
  for (const failure of deterministicFailures) console.error(`✗ ${failure}`);
  process.exit(1);
}

let ollamaReachable = true;
try {
  const resp = await fetch(`${OLLAMA_BASE}/api/tags`);
  if (!resp.ok) throw new Error(String(resp.status));
} catch {
  ollamaReachable = false;
}

if (!ollamaReachable) {
  console.log(`eval:orchestration — live model fan-in case skipped, Ollama unreachable at ${OLLAMA_BASE}. Deterministic MAST + capacity cases passed pass^${REPEAT.toString()}.`);
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
const result = await orchestrator.run(instructionInput, { mode: "sequential" });
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
console.log(`PASS — step-repetition, unaware-of-termination, capacity refusal (pass^${REPEAT.toString()}), failure propagated, bounded termination, fan-in carries the survivors`);
