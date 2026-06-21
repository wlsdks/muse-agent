import assert from "node:assert/strict";
import { test } from "node:test";

import { escalationRate, meanMs, scoreCascadeEval } from "./lib/cascade-eval.mjs";

test("meanMs averages finite latencies, ignores junk", () => {
  assert.equal(meanMs([100, 200, 300]), 200);
  assert.equal(meanMs([100, Number.NaN, 300]), 200);
  assert.equal(meanMs([]), 0);
});

test("escalationRate is the fraction that escalated", () => {
  assert.equal(escalationRate([{ escalated: true }, { escalated: false }, { escalated: false }]), 1 / 3);
  assert.equal(escalationRate([]), 0);
});

test("scoreCascadeEval: a real win — faster mean AND the gate fired correctly", () => {
  const perQuery = [
    // easy, confident → fast accepted (fast latency), no escalation
    { prompt: "capital of France?", cascadeMs: 200, heavyMs: 800, fastConfidence: -0.2, escalated: false },
    // hard, low-confidence → escalated to heavy (pays heavy latency)
    { prompt: "design a cache", cascadeMs: 820, heavyMs: 800, fastConfidence: -2.5, escalated: true }
  ];
  const r = scoreCascadeEval(perQuery);
  assert.equal(r.cascadeMean, 510); // (200+820)/2
  assert.equal(r.heavyMean, 800);
  assert.ok(r.latencyDeltaPct > 5); // ~36% faster
  assert.equal(r.latencyWin, true);
  assert.equal(r.gateCorrect, true); // confident→keep, low→escalate, both correct
  assert.deepEqual(r.gateViolations, []);
  assert.equal(r.escalationRate, 0.5);
});

test("scoreCascadeEval: gate violation — a LOW-confidence query that did NOT escalate (weak answer kept)", () => {
  const perQuery = [
    { prompt: "weak but kept", cascadeMs: 200, heavyMs: 800, fastConfidence: -3.0, escalated: false }
  ];
  const r = scoreCascadeEval(perQuery);
  assert.equal(r.gateCorrect, false);
  assert.deepEqual(r.gateViolations, ["weak but kept"]);
});

test("scoreCascadeEval: gate violation — a CONFIDENT query that needlessly escalated", () => {
  const perQuery = [
    { prompt: "confident but escalated", cascadeMs: 820, heavyMs: 800, fastConfidence: -0.1, escalated: true }
  ];
  const r = scoreCascadeEval(perQuery);
  assert.equal(r.gateCorrect, false);
});

test("scoreCascadeEval: undefined fast-confidence must escalate (safe direction)", () => {
  const escalated = scoreCascadeEval([{ prompt: "q", cascadeMs: 800, heavyMs: 800, fastConfidence: undefined, escalated: true }]);
  assert.equal(escalated.gateCorrect, true);
  const notEscalated = scoreCascadeEval([{ prompt: "q", cascadeMs: 200, heavyMs: 800, fastConfidence: undefined, escalated: false }]);
  assert.equal(notEscalated.gateCorrect, false); // undefined → MUST escalate
});

test("scoreCascadeEval: no latency win when cascade isn't faster", () => {
  const r = scoreCascadeEval([{ prompt: "q", cascadeMs: 800, heavyMs: 800, fastConfidence: -2.0, escalated: true }]);
  assert.equal(r.latencyWin, false); // 0% delta
});

test("scoreCascadeEval throws on empty input", () => {
  assert.throws(() => scoreCascadeEval([]), /at least one per-query/);
});
