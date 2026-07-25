// Tests for the observability tracer + its integration with the orchestrator
// and hooks. Run: node --test harness/runner/

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTracer, redactSecrets } from './tracer.mjs';
import { runCycle } from './orchestrator.mjs';
import { createHookPipeline, dispatchTool } from './hooks.mjs';

const VALID_PLAN = JSON.stringify({
  what: 'add two integers',
  why: 'the trace needs a completed cycle',
  passCriteria: ['a+b'],
  outOfScope: ['other arithmetic'],
  verificationCommands: ['node --test harness/runner/'],
  evidenceAccounting: 'one deterministic fixture',
  rollback: 'revert this slice',
});

test('every event carries a correlation id (runId) and a monotonic seq', () => {
  const tr = createTracer({ runId: 'r1', now: () => 7 });
  tr.add('start', { task: 't' });
  tr.add('done');
  assert.equal(tr.events.length, 2);
  assert.equal(tr.events[0].runId, 'r1');
  assert.equal(tr.events[1].runId, 'r1');
  assert.deepEqual(tr.events.map((e) => e.seq), [0, 1]);
  assert.equal(tr.events[0].t, 7);
});

test('summary rolls up counts, blocked, duration, and cost', () => {
  let clock = 0;
  const tr = createTracer({ runId: 'r2', now: () => clock });
  clock = 0; tr.add('start');
  clock = 10; tr.add('plan', { cost: 3 });
  clock = 25; tr.add('blocked', { cost: 2 });
  const s = tr.summary();
  assert.equal(s.runId, 'r2');
  assert.equal(s.total, 3);
  assert.equal(s.byEvent.plan, 1);
  assert.equal(s.blocked, 1);
  assert.equal(s.durationMs, 25);
  assert.equal(s.cost, 5);
});

test('redact strips secret-bearing fields before they are recorded', () => {
  const tr = createTracer({ redact: redactSecrets });
  tr.add('build', { api_key: 'sk-123', authorization: 'Bearer x', note: 'ok' });
  const e = tr.events[0];
  assert.equal(e.api_key, '[redacted]');
  assert.equal(e.authorization, '[redacted]');
  assert.equal(e.note, 'ok');
});

test('toJSON is a serializable record with events + summary', () => {
  const tr = createTracer({ runId: 'r3' });
  tr.add('start');
  const round = JSON.parse(JSON.stringify(tr.toJSON()));
  assert.equal(round.runId, 'r3');
  assert.equal(round.events.length, 1);
  assert.equal(round.summary.total, 1);
});

test('orchestrator emits a trace + summary through the tracer', async () => {
  const res = await runCycle('add two ints', {
    runId: 'cycle-1',
    callAgent: async (role) => ({
      planner: VALID_PLAN,
      worker: 'def add(a,b): return a+b',
      evaluator: '{"verdict":"PASS"}',
    })[role],
  });
  assert.equal(res.ok, true);
  assert.equal(res.summary.runId, 'cycle-1');
  assert.equal(res.summary.byEvent.done, 1);
  assert.equal(res.summary.blocked, 0);
  assert.ok(res.trace.every((e) => e.runId === 'cycle-1'));
});

test('a PostToolUse hook can feed the tracer (observability composes with hooks)', async () => {
  const tr = createTracer({ runId: 'tool-run' });
  const p = createHookPipeline();
  p.onPostToolUse((call, result) => tr.add('tool', { kind: call.kind, result }));
  await dispatchTool(p, { kind: 'read' }, async () => 'data');
  assert.equal(tr.events.length, 1);
  assert.equal(tr.events[0].event, 'tool');
  assert.equal(tr.events[0].result, 'data');
});
