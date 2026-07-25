// Execution integration — the orchestrator that actually DRIVES a task through
// the harness cycle (plan -> build -> evaluate -> complete), with every step
// gated by the deterministic runner in harness-runner.mjs. The model only ever
// reasons WITHIN a role; this code owns the control flow and the gates, records
// every decision through the tracer (observability), and can checkpoint/resume
// across context windows without redoing completed steps (session persistence).
//
// `callAgent` is injected so the harness stays portable and testable: pass a
// real LLM caller (run.mjs shells to `claude -p`) in production, or a
// contract-faithful fake in tests. Zero deps.

import { advance, planGate } from './harness-runner.mjs';
import { createTracer } from './tracer.mjs';
import { snapshot, deserializeSession } from './session.mjs';

function parseJson(text) {
  if (typeof text !== 'string') return null;
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

function legacyCriteriaGate(criteria) {
  const usable = criteria
    .map((entry) => String(entry ?? '').trim())
    .filter(Boolean);
  return usable.length > 0
    ? { ok: true }
    : { ok: false, reason: 'empty legacy acceptance criteria (fail-closed)' };
}

export async function runCycle(task, opts = {}) {
  const { callAgent, maxRetries = 2, now = () => 0, runId = 'run', redact, checkpoint, resume } = opts;
  if (typeof callAgent !== 'function') throw new Error('callAgent is required');

  const tr = createTracer({ runId, now, redact });
  const log = ({ event, ...data }) => tr.add(event, data);
  const result = (extra) => ({ ...extra, trace: tr.events, summary: tr.summary() });
  const fail = (reason, state = 'BLOCKED') => { log({ event: 'blocked', state, reason }); return result({ ok: false, state, reason }); };
  const save = async (phase, extra) => { if (checkpoint) await checkpoint(snapshot({ runId, phase, ...extra })); };

  let state = 'REQUESTED';
  let acceptanceSlice;
  let criteria;
  let attempt = 0;
  let pendingBuild = null; // a build restored from a checkpoint: evaluate it without rebuilding
  log({ event: 'start', task });

  if (resume) {
    // Resume: restore criteria/attempt/build and skip the steps already done.
    const r = deserializeSession(resume);
    if (Array.isArray(r.criteria)) {
      // Backward compatibility for v1 snapshots created before structured
      // acceptance slices existed. The plan already passed the old gate, so
      // enforce that gate's nonblank invariant before resuming, without
      // inventing missing structured fields or re-planning.
      const legacyPlan = legacyCriteriaGate(r.criteria);
      if (!legacyPlan.ok) return fail(`legacy resume plan gate: ${legacyPlan.reason}`);
      criteria = r.criteria;
    } else {
      acceptanceSlice = r.criteria;
      const resumedPlan = planGate(acceptanceSlice);
      if (!resumedPlan.ok) return fail(`resume plan gate: ${resumedPlan.reason}`);
      criteria = acceptanceSlice.passCriteria;
    }
    attempt = r.attempt || 0;
    if (r.build != null) pendingBuild = r.build;
    state = 'PLANNED';
    log({ event: 'resumed', fromPhase: r.phase, attempt, hasBuild: r.build != null });
  } else {
    // 1) PLAN — planner returns the complete acceptance slice.
    const planRaw = await callAgent('planner', task);
    acceptanceSlice = parseJson(planRaw);
    const gate = planGate(acceptanceSlice);
    criteria = acceptanceSlice?.passCriteria;
    log({ event: 'plan', acceptanceSlice, gate });
    const planned = advance(state, 'plan', { acceptanceSlice });
    if (!planned.ok) return fail(`plan gate: ${planned.reason}`);
    state = planned.state; // PLANNED
    await save('PLANNED', { criteria: acceptanceSlice });
  }

  const acceptanceContext = acceptanceSlice ?? { legacyCriteria: criteria };
  let lastBuild = null;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    // 2) BUILD (or reuse a checkpointed build on the first resumed iteration)
    state = advance(state, 'build').state; // -> BUILT
    const workerId = `worker#${attempt}`;
    let build;
    if (pendingBuild != null) {
      build = pendingBuild; pendingBuild = null;
      log({ event: 'build', workerId, build, resumed: true });
    } else {
      build = await callAgent('worker', `${task}\n\n[acceptance slice]\n${JSON.stringify(acceptanceContext)}`);
      log({ event: 'build', workerId, build });
      await save('BUILT', { criteria: acceptanceSlice ?? criteria, attempt, build });
    }
    lastBuild = build;

    // 3) EVALUATE — a DIFFERENT instance judges; the runner enforces maker != judge.
    const evaluatorId = `evaluator#${attempt}`;
    const evalRaw = await callAgent('evaluator', `[acceptance slice]\n${JSON.stringify(acceptanceContext)}\n\n[build]\n${build}`);
    const verdictObj = parseJson(evalRaw);
    const verdict = verdictObj?.verdict;
    log({ event: 'evaluate', evaluatorId, verdict, reason: verdictObj?.reason });
    const evaluated = advance('BUILT', 'evaluate', { workerId, evaluatorId, verdict });
    if (!evaluated.ok) return fail(`evaluate gate: ${evaluated.reason}`);
    state = evaluated.state; // EVALUATED
    await save('EVALUATED', { criteria: acceptanceSlice ?? criteria, attempt, build, verdict });

    // 4) COMPLETION gate — only an evaluator PASS may finish.
    if (verdict === 'PASS') {
      const done = advance(state, 'complete', { verdict });
      if (!done.ok) return fail(`completion gate: ${done.reason}`);
      state = done.state; // DONE
      log({ event: 'done', build: lastBuild });
      await save('DONE', { criteria: acceptanceSlice ?? criteria, attempt, build: lastBuild, verdict });
      return result({ ok: true, state, build: lastBuild, criteria, acceptanceSlice: acceptanceSlice ?? null });
    }

    // FAIL -> bounded rebuild.
    const rebuild = advance(state, 'rebuild', { verdict, retries: attempt, maxRetries });
    if (!rebuild.ok) return fail(`retry cap: ${rebuild.reason}`);
    attempt += 1;
    state = rebuild.state; // BUILT (loop)
    log({ event: 'rebuild', attempt });
  }
}
