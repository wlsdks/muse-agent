// Tests the orchestrator against CONTRACT-FAITHFUL FAKE agents — no LLM needed.
// This proves the runner actually drives the cycle AND that the code gates fire
// on bad agent output (empty criteria, FAIL verdict, malformed reply), not just
// the happy path. Run: node --test harness/runner/

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runCycle } from './orchestrator.mjs';

// A fake agent built from canned per-role replies.
const agentOf = (replies) => async (role) => {
  const r = replies[role];
  return typeof r === 'function' ? r() : r;
};

test('happy path: drives plan->build->evaluate(PASS)->DONE with a trace', async () => {
  const res = await runCycle('add two ints', {
    callAgent: agentOf({
      planner: '{"criteria":["returns a+b for two ints"]}',
      worker: 'def add(a,b): return a+b',
      evaluator: '{"verdict":"PASS","reason":"matches"}',
    }),
  });
  assert.equal(res.ok, true);
  assert.equal(res.state, 'DONE');
  // trace records each real step
  const events = res.trace.map((e) => e.event);
  assert.deepEqual(events, ['start', 'plan', 'build', 'evaluate', 'done']);
});

test('gate fires: empty criteria from planner -> BLOCKED at plan gate (no build runs)', async () => {
  let workerCalled = false;
  const res = await runCycle('vague task', {
    callAgent: async (role) => {
      if (role === 'planner') return '{"criteria":[]}';
      if (role === 'worker') { workerCalled = true; return 'x'; }
      return '{"verdict":"PASS"}';
    },
  });
  assert.equal(res.ok, false);
  assert.equal(res.state, 'BLOCKED');
  assert.match(res.reason, /plan gate/);
  assert.equal(workerCalled, false); // build never ran — the gate stopped it
});

test('gate fires: FAIL verdict triggers bounded rebuild, then PASS completes', async () => {
  let builds = 0;
  const res = await runCycle('flaky build', {
    maxRetries: 2,
    callAgent: async (role) => {
      if (role === 'planner') return '{"criteria":["c"]}';
      if (role === 'worker') { builds += 1; return `build#${builds}`; }
      // first eval FAIL, then PASS
      return builds < 2 ? '{"verdict":"FAIL","reason":"bug"}' : '{"verdict":"PASS"}';
    },
  });
  assert.equal(res.ok, true);
  assert.equal(res.state, 'DONE');
  assert.equal(builds, 2); // rebuilt once
  assert.ok(res.trace.some((e) => e.event === 'rebuild'));
});

test('gate fires: persistent FAIL hits the retry cap -> BLOCKED (never falsely DONE)', async () => {
  const res = await runCycle('unbuildable', {
    maxRetries: 1,
    callAgent: agentOf({
      planner: '{"criteria":["c"]}',
      worker: 'broken',
      evaluator: '{"verdict":"FAIL","reason":"still wrong"}',
    }),
  });
  assert.equal(res.ok, false);
  assert.equal(res.state, 'BLOCKED');
  assert.match(res.reason, /retry cap/);
});

test('fail-closed: malformed evaluator reply is treated as a block, not a pass', async () => {
  const res = await runCycle('task', {
    callAgent: agentOf({
      planner: '{"criteria":["c"]}',
      worker: 'build',
      evaluator: 'the build looks fine to me!', // no JSON verdict
    }),
  });
  assert.equal(res.ok, false);
  assert.equal(res.state, 'BLOCKED');
  assert.match(res.reason, /evaluate gate/);
});
