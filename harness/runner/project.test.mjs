// Tests for the multi-step project orchestrator (decompose -> per-subtask cycle
// -> aggregate), with fake agents. Proves multi-step composition + the
// project-level fail-closed gates. Run: node --test harness/runner/

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runProject } from './project.mjs';

// Fake agent set. `subtasks` is the decomposition JSON; `failAt` makes the
// evaluator FAIL for that subtask index. A planner-call counter tracks which
// subtask's cycle is running. `calls` records roles seen (for skip assertions).
function fakeAgents({ subtasks = '["s0","s1","s2"]', failAt = null, calls = [] } = {}) {
  let idx = -1;
  return async (role) => {
    calls.push(role);
    if (role === 'orchestrator') return `{"subtasks":${subtasks}}`;
    if (role === 'planner') { idx += 1; return '{"criteria":["c"]}'; }
    if (role === 'worker') return `build-${idx}`;
    if (role === 'evaluator') return failAt === idx ? '{"verdict":"FAIL","reason":"bug"}' : '{"verdict":"PASS"}';
    return '{}';
  };
}

test('happy path: decompose into 3 subtasks, each DONE -> project DONE', async () => {
  const res = await runProject('build a thing', { callAgent: fakeAgents() });
  assert.equal(res.ok, true);
  assert.equal(res.state, 'DONE');
  assert.equal(res.subtasks.length, 3);
  assert.ok(res.subtasks.every((s) => s.ok));
  assert.equal(res.trace.filter((e) => e.event === 'subtask-done').length, 3);
});

test('decompose gate: empty subtask list -> BLOCKED (fail-closed)', async () => {
  const res = await runProject('vague', { callAgent: fakeAgents({ subtasks: '[]' }) });
  assert.equal(res.ok, false);
  assert.equal(res.state, 'BLOCKED');
  assert.match(res.reason, /decompose gate/);
});

test('a blocked subtask stops the project; later subtasks never run', async () => {
  const calls = [];
  const res = await runProject('build', {
    maxRetries: 0,
    callAgent: fakeAgents({ failAt: 1, calls }), // subtask index 1 fails its evaluation
  });
  assert.equal(res.ok, false);
  assert.equal(res.state, 'BLOCKED');
  assert.match(res.reason, /subtask 1 blocked/);
  // subtask 0 done + subtask 1 attempted/blocked; subtask 2 must NOT have started
  assert.ok(res.trace.some((e) => e.event === 'subtask-done' && e.index === 0));
  assert.ok(res.trace.some((e) => e.event === 'subtask-blocked' && e.index === 1));
  assert.equal(res.trace.some((e) => e.event === 'subtask-start' && e.index === 2), false);
});

test('resume skips already-done subtasks (no re-decompose, no re-run of done work)', async () => {
  const calls = [];
  const res = await runProject('build', {
    resume: { v: 1, runId: 'project', phase: 'SUBTASK', criteria: ['s0', 's1', 's2'], attempt: 2, build: null, verdict: null },
    callAgent: fakeAgents({ calls }),
  });
  assert.equal(res.ok, true);
  assert.equal(res.state, 'DONE');
  assert.equal(calls.includes('orchestrator'), false); // did not re-decompose
  // only the last subtask (index 2) ran -> exactly one planner call
  assert.equal(calls.filter((c) => c === 'planner').length, 1);
  assert.ok(res.trace.some((e) => e.event === 'resumed'));
});

test('project trace carries one correlation id and a summary', async () => {
  const res = await runProject('build', { runId: 'proj-7', callAgent: fakeAgents() });
  assert.equal(res.summary.runId, 'proj-7');
  assert.ok(res.trace.every((e) => e.runId === 'proj-7'));
  assert.equal(res.summary.byEvent['project-done'], 1);
});
