// Conformance test for the harness runner — proves the runner-spec §7 matrix:
// the DENY paths, not just the happy path. A runner that only passes the happy
// path is not delivered. Zero-dep: run with `node --test harness/runner/`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { advance, planGate, permissionGate, createRun } from './harness-runner.mjs';

// ---- Happy path: a full cycle reaches DONE ----
test('happy path: REQUESTED -> PLANNED -> BUILT -> EVALUATED(PASS) -> DONE', () => {
  let s = 'REQUESTED';
  s = advance(s, 'plan', { criteria: ['returns the sum of two ints'] }).state;
  assert.equal(s, 'PLANNED');
  s = advance(s, 'build').state;
  assert.equal(s, 'BUILT');
  const e = advance(s, 'evaluate', { workerId: 'w1', evaluatorId: 'e1', verdict: 'PASS' });
  assert.equal(e.state, 'EVALUATED');
  s = advance(e.state, 'complete', { verdict: 'PASS' }).state;
  assert.equal(s, 'DONE');
});

// ---- §7 deny matrix ----
test('deny: skip a step (BUILD without PLAN)', () => {
  const r = advance('REQUESTED', 'build');
  assert.equal(r.state, 'BLOCKED');
  assert.equal(r.ok, false);
});

test('deny: empty acceptance criteria at the plan gate', () => {
  assert.equal(advance('REQUESTED', 'plan', { criteria: [] }).state, 'BLOCKED');
  assert.equal(advance('REQUESTED', 'plan', { criteria: ['   ', ''] }).state, 'BLOCKED');
  assert.equal(advance('REQUESTED', 'plan', {}).state, 'BLOCKED');
});

test('deny: complete without an evaluator PASS (unevaluated merge)', () => {
  assert.equal(advance('EVALUATED', 'complete', { verdict: 'FAIL' }).state, 'BLOCKED');
  assert.equal(advance('EVALUATED', 'complete', {}).state, 'BLOCKED');
});

test('deny: self-grading (maker == judge)', () => {
  const r = advance('BUILT', 'evaluate', { workerId: 'a', evaluatorId: 'a', verdict: 'PASS' });
  assert.equal(r.state, 'BLOCKED');
});

test('deny: evaluator returns a non-verdict (corrupt form)', () => {
  assert.equal(advance('BUILT', 'evaluate', { workerId: 'w', evaluatorId: 'e', verdict: 'maybe' }).state, 'BLOCKED');
});

test('deny: unknown state / event (fail-closed default)', () => {
  assert.equal(advance('WAT', 'plan').state, 'BLOCKED');
  assert.equal(advance('PLANNED', 'teleport').state, 'BLOCKED');
});

test('deny: retry cap on rebuild loop', () => {
  assert.equal(advance('EVALUATED', 'rebuild', { verdict: 'FAIL', retries: 3, maxRetries: 3 }).state, 'BLOCKED');
  assert.equal(advance('EVALUATED', 'rebuild', { verdict: 'FAIL', retries: 1, maxRetries: 3 }).state, 'BUILT');
});

// ---- permission gate (permission-matrix §4) ----
test('permission: banking is always refused', () => {
  assert.equal(permissionGate({ kind: 'banking' }).ok, false);
});

test('permission: outbound needs resolved recipient AND confirmation', () => {
  assert.equal(permissionGate({ kind: 'outbound', recipientResolved: false, confirmed: true }).ok, false);
  assert.equal(permissionGate({ kind: 'outbound', recipientResolved: true, confirmed: false }).ok, false);
  assert.equal(permissionGate({ kind: 'outbound', recipientResolved: true, confirmed: true }).ok, true);
});

test('permission: write/execute need trust; unknown kinds denied', () => {
  assert.equal(permissionGate({ kind: 'write' }).ok, false);
  assert.equal(permissionGate({ kind: 'write', trusted: true }).ok, true);
  assert.equal(permissionGate({ kind: 'read' }).ok, true);
  assert.equal(permissionGate({ kind: 'mystery' }).ok, false);
});

test('plan gate is the source of truth for empty-criteria blocking', () => {
  assert.equal(planGate(['ok']).ok, true);
  assert.equal(planGate([]).ok, false);
  assert.equal(planGate(undefined).ok, false);
});

// ---- idempotent resume ----
test('idempotent resume: replaying the same transition id applies once', () => {
  const run = createRun('REQUESTED');
  const first = run.apply('t1', 'plan', { criteria: ['x'] });
  assert.equal(first.state, 'PLANNED');
  assert.equal(run.state, 'PLANNED');
  const replay = run.apply('t1', 'plan', { criteria: ['x'] });
  assert.deepEqual(replay, first);
  assert.equal(run.state, 'PLANNED'); // not advanced twice
});
