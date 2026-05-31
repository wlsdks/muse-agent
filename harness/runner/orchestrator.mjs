// Execution integration — the orchestrator that actually DRIVES a task through
// the harness cycle (plan -> build -> evaluate -> complete), with every step
// gated by the deterministic runner in harness-runner.mjs. The model only ever
// reasons WITHIN a role; this code owns the control flow and the gates, and
// emits a trace of every decision.
//
// `callAgent` is injected so the harness stays portable and testable: pass a
// real LLM caller (run.mjs shells to `claude -p`) in production, or a
// contract-faithful fake in tests. Zero deps.

import { advance, planGate } from './harness-runner.mjs';

// callAgent(role, prompt) -> Promise<string>  (role: 'planner'|'worker'|'evaluator')
// The orchestrator parses planner/evaluator output as JSON; a malformed reply is
// treated as a fail-closed BLOCK, never an optimistic pass.

function parseJson(text) {
  if (typeof text !== 'string') return null;
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

export async function runCycle(task, opts = {}) {
  const { callAgent, maxRetries = 2, now = () => 0 } = opts;
  if (typeof callAgent !== 'function') throw new Error('callAgent is required');

  const trace = [];
  const log = (entry) => { trace.push({ t: now(), ...entry }); };
  const fail = (reason, state = 'BLOCKED') => { log({ event: 'blocked', state, reason }); return { ok: false, state, reason, trace }; };

  let state = 'REQUESTED';
  log({ event: 'start', task });

  // 1) PLAN — planner returns acceptance criteria.
  const planRaw = await callAgent('planner', task);
  const plan = parseJson(planRaw);
  const criteria = plan?.criteria;
  log({ event: 'plan', criteria, gate: planGate(criteria) });
  const planned = advance(state, 'plan', { criteria });
  if (!planned.ok) return fail(`plan gate: ${planned.reason}`);
  state = planned.state; // PLANNED

  let attempt = 0;
  let lastBuild = null;
  // BUILD <-> EVALUATE loop, bounded by the retry cap the runner enforces.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    // 2) BUILD
    state = advance(state, 'build').state; // PLANNED/BUILT -> BUILT
    const workerId = `worker#${attempt}`;
    const build = await callAgent('worker', `${task}\n\n[acceptance criteria]\n${JSON.stringify(criteria)}`);
    lastBuild = build;
    log({ event: 'build', workerId, build });

    // 3) EVALUATE — a DIFFERENT instance judges; the runner enforces maker != judge.
    const evaluatorId = `evaluator#${attempt}`;
    const evalRaw = await callAgent('evaluator', `[acceptance criteria]\n${JSON.stringify(criteria)}\n\n[build]\n${build}`);
    const verdictObj = parseJson(evalRaw);
    const verdict = verdictObj?.verdict;
    log({ event: 'evaluate', evaluatorId, verdict, reason: verdictObj?.reason });
    const evaluated = advance('BUILT', 'evaluate', { workerId, evaluatorId, verdict });
    if (!evaluated.ok) return fail(`evaluate gate: ${evaluated.reason}`);
    state = evaluated.state; // EVALUATED

    // 4) COMPLETION gate — only an evaluator PASS may finish.
    if (verdict === 'PASS') {
      const done = advance(state, 'complete', { verdict });
      if (!done.ok) return fail(`completion gate: ${done.reason}`);
      state = done.state; // DONE
      log({ event: 'done', build: lastBuild });
      return { ok: true, state, build: lastBuild, criteria, trace };
    }

    // FAIL -> bounded rebuild.
    const rebuild = advance(state, 'rebuild', { verdict, retries: attempt, maxRetries });
    if (!rebuild.ok) return fail(`retry cap: ${rebuild.reason}`);
    attempt += 1;
    state = rebuild.state; // BUILT (loop)
    log({ event: 'rebuild', attempt });
  }
}
