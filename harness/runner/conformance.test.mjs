// Conformance test for the harness runner — proves the runner-spec §7 matrix:
// the DENY paths, not just the happy path. A runner that only passes the happy
// path is not delivered. Zero-dep: run with `node --test harness/runner/`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { advance, planGate, permissionGate, createRun } from './harness-runner.mjs';

const slice = (overrides = {}) => ({
  what: 'The user can add two integers',
  why: 'This proves the phase contract',
  passCriteria: ['returns the sum of two ints'],
  outOfScope: ['floating-point arithmetic'],
  verificationCommands: ['node --test harness/runner/'],
  evidenceAccounting: 'one deterministic example fixture',
  rollback: 'revert the task slice',
  activeBudgetMinutes: 20,
  commandTimeoutMinutes: 12,
  validationMinutes: 6,
  ...overrides,
});

// ---- Happy path: a full cycle reaches DONE ----
test('happy path: REQUESTED -> PLANNED -> BUILT -> EVALUATED(PASS) -> DONE', () => {
  let s = 'REQUESTED';
  s = advance(s, 'plan', { acceptanceSlice: slice() }).state;
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

test('deny: every missing or blank acceptance-slice field at the plan gate', () => {
  const blanks = {
    what: ' ',
    why: '',
    passCriteria: ['   ', ''],
    outOfScope: [],
    verificationCommands: undefined,
    evidenceAccounting: null,
    rollback: '   ',
  };
  for (const [field, value] of Object.entries(blanks)) {
    const result = advance('REQUESTED', 'plan', { acceptanceSlice: slice({ [field]: value }) });
    assert.equal(result.state, 'BLOCKED', `${field} must fail closed`);
    assert.match(result.reason, new RegExp(field));
  }
  assert.equal(advance('REQUESTED', 'plan', {}).state, 'BLOCKED');
});

test('deny: missing, non-numeric, or over-limit activation budgets at the plan gate', () => {
  const invalid = {
    activeBudgetMinutes: [undefined, '20', 0, 20.1, 21, Number.POSITIVE_INFINITY],
    commandTimeoutMinutes: [undefined, '12', 0, 12.1, 13, Number.NaN],
    validationMinutes: [undefined, '6', 0, 6.1, 7, Number.NEGATIVE_INFINITY],
  };
  for (const [field, values] of Object.entries(invalid)) {
    for (const value of values) {
      const result = advance('REQUESTED', 'plan', { acceptanceSlice: slice({ [field]: value }) });
      assert.equal(result.state, 'BLOCKED', `${field}=${String(value)} must fail closed`);
      assert.match(result.reason, new RegExp(field));
    }
  }
  assert.equal(planGate(slice()).ok, true, 'exact 20/12/6 limits must pass');
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
  assert.equal(planGate(slice()).ok, true);
  assert.equal(planGate(slice({ passCriteria: [] })).ok, false);
  assert.equal(planGate(undefined).ok, false);
});

// ---- idempotent resume ----
test('idempotent resume: replaying the same transition id applies once', () => {
  const run = createRun('REQUESTED');
  const first = run.apply('t1', 'plan', { acceptanceSlice: slice() });
  assert.equal(first.state, 'PLANNED');
  assert.equal(run.state, 'PLANNED');
  const replay = run.apply('t1', 'plan', { acceptanceSlice: slice() });
  assert.deepEqual(replay, first);
  assert.equal(run.state, 'PLANNED'); // not advanced twice
});
