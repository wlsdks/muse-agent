// Tests for the PreToolUse/PostToolUse hook pipeline. Proves hooks are
// non-bypassable and fail-closed. Run: node --test harness/runner/

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHookPipeline, permissionHook, dispatchTool } from './hooks.mjs';

test('PreToolUse deny blocks the call — execute never runs', async () => {
  const p = createHookPipeline();
  p.onPreToolUse(() => ({ allow: false, reason: 'nope' }));
  let ran = false;
  const r = await dispatchTool(p, { kind: 'read' }, async () => { ran = true; return 'x'; });
  assert.equal(r.ok, false);
  assert.equal(r.blocked, true);
  assert.equal(ran, false);
});

test('PreToolUse allow -> execute runs -> PostToolUse observes', async () => {
  const p = createHookPipeline();
  let observed = null;
  p.onPostToolUse((call, result) => { observed = result; return 'logged'; });
  const r = await dispatchTool(p, { kind: 'read' }, async () => 'result-42');
  assert.equal(r.ok, true);
  assert.equal(r.result, 'result-42');
  assert.equal(observed, 'result-42');
  assert.deepEqual(r.observations, ['logged']);
});

test('fail-closed: a throwing PreToolUse hook blocks the call', async () => {
  const p = createHookPipeline();
  p.onPreToolUse(() => { throw new Error('boom'); });
  let ran = false;
  const r = await dispatchTool(p, { kind: 'read' }, async () => { ran = true; return 'x'; });
  assert.equal(r.ok, false);
  assert.match(r.reason, /hook threw/);
  assert.equal(ran, false);
});

test('first deny wins among multiple PreToolUse hooks', async () => {
  const p = createHookPipeline();
  let secondRan = false;
  p.onPreToolUse(() => ({ allow: false, reason: 'first blocks', by: 'a' }));
  p.onPreToolUse(() => { secondRan = true; return { allow: true }; });
  const r = await dispatchTool(p, { kind: 'read' }, async () => 'x');
  assert.equal(r.ok, false);
  assert.match(r.reason, /first blocks/);
  assert.equal(secondRan, false); // short-circuited
});

test('permissionHook as a built-in PreToolUse: banking + unconfirmed outbound blocked, read allowed', async () => {
  const p = createHookPipeline();
  p.onPreToolUse(permissionHook);
  assert.equal((await dispatchTool(p, { kind: 'banking' }, async () => 'x')).ok, false);
  assert.equal((await dispatchTool(p, { kind: 'outbound', recipientResolved: true, confirmed: false }, async () => 'x')).ok, false);
  assert.equal((await dispatchTool(p, { kind: 'read' }, async () => 'ok')).ok, true);
  assert.equal((await dispatchTool(p, { kind: 'outbound', recipientResolved: true, confirmed: true }, async () => 'sent')).ok, true);
});

test('a throwing PostToolUse hook cannot block or corrupt a successful result', async () => {
  const p = createHookPipeline();
  p.onPostToolUse(() => { throw new Error('observer broke'); });
  const r = await dispatchTool(p, { kind: 'read' }, async () => 'good');
  assert.equal(r.ok, true);
  assert.equal(r.result, 'good');
});
