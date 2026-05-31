// Red-team suite — adversarial attempts to BYPASS the gates. Every one must end
// BLOCKED (or denied). This guards the runner against gate-evasion, not just
// honest mistakes. Run: node --test harness/runner/

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { advance, permissionGate } from './harness-runner.mjs';

test('attack: jump straight to complete from BUILT (skip evaluation)', () => {
  assert.equal(advance('BUILT', 'complete', { verdict: 'PASS' }).state, 'BLOCKED');
});

test('attack: re-trigger work after DONE', () => {
  assert.equal(advance('DONE', 'build').state, 'BLOCKED');
  assert.equal(advance('DONE', 'complete', { verdict: 'PASS' }).state, 'BLOCKED');
});

test('attack: forge completion with a non-canonical verdict string', () => {
  // only the exact 'PASS' completes; 'pass', 'PASS ', 'PASS!' must not.
  for (const v of ['pass', 'PASS ', 'PASS!', 'Passed', 'OK', true, 1]) {
    assert.equal(advance('EVALUATED', 'complete', { verdict: v }).state, 'BLOCKED', `verdict=${String(v)}`);
  }
});

test('attack: empty criteria smuggled as whitespace/blank entries', () => {
  assert.equal(advance('REQUESTED', 'plan', { criteria: ['   ', '\t', ''] }).state, 'BLOCKED');
  assert.equal(advance('REQUESTED', 'plan', { criteria: [null, undefined] }).state, 'BLOCKED');
});

test('attack: same agent reviews its own build under different-looking ids that are equal', () => {
  assert.equal(advance('BUILT', 'evaluate', { workerId: 'agent-7', evaluatorId: 'agent-7', verdict: 'PASS' }).state, 'BLOCKED');
});

test('attack: outbound send claims confirmation but recipient unresolved', () => {
  assert.equal(permissionGate({ kind: 'outbound', confirmed: true, recipientResolved: false }).ok, false);
});

test('attack: privilege escalation via unknown action kind', () => {
  assert.equal(permissionGate({ kind: 'sudo' }).ok, false);
  assert.equal(permissionGate({ kind: 'execute' }).ok, false); // execute needs explicit trust
  assert.equal(permissionGate({}).ok, false);
});

test('attack: banking dressed up as a normal write', () => {
  assert.equal(permissionGate({ kind: 'banking', trusted: true, confirmed: true }).ok, false);
});

test('attack: bypass retry cap by claiming negative/huge retries', () => {
  // at/over the cap must block regardless of the claimed count shape
  assert.equal(advance('EVALUATED', 'rebuild', { verdict: 'FAIL', retries: 99, maxRetries: 3 }).state, 'BLOCKED');
});
