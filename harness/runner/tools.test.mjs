// Tests for the tool registry runtime. Run: node --test harness/runner/

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createToolRegistry } from './tools.mjs';
import { permissionGate } from './harness-runner.mjs';

const okTool = (over = {}) => ({
  name: 'knowledge_search',
  description: 'Search the user notes for a keyword.',
  inputSchema: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 50 } }, required: ['query'] },
  risk: 'read',
  ...over,
});

test('register accepts a well-formed tool; rejects malformed declarations', () => {
  const r = createToolRegistry();
  assert.equal(r.register(okTool()).ok, true);
  assert.throws(() => r.register(okTool()), /already registered/); // duplicate
  assert.throws(() => r.register(okTool({ name: 'search' })), /verb_noun/); // no underscore
  assert.throws(() => r.register(okTool({ name: 'Knowledge_Search' })), /verb_noun/); // uppercase
  assert.throws(() => r.register(okTool({ name: 'web_action', description: '' })), /description/);
  assert.throws(() => r.register(okTool({ name: 'web_action', inputSchema: null })), /inputSchema/);
  assert.throws(() => r.register(okTool({ name: 'web_action', risk: 'nuke' })), /unknown risk/);
});

test('denylist wins over allowlist; empty allowlist = everything allowed', () => {
  const r = createToolRegistry({ allow: ['a_one', 'b_two'], deny: ['b_two'] });
  r.register(okTool({ name: 'a_one' }));
  r.register(okTool({ name: 'b_two' })); // in both allow and deny -> deny wins
  r.register(okTool({ name: 'c_three' })); // not in allowlist -> blocked
  assert.equal(r.isAllowed('a_one'), true);
  assert.equal(r.isAllowed('b_two'), false); // denied despite allowlist
  assert.equal(r.isAllowed('c_three'), false); // allowlist excludes it

  const open = createToolRegistry({ deny: ['x_bad'] });
  open.register(okTool({ name: 'x_bad' }));
  open.register(okTool({ name: 'y_good' }));
  assert.equal(open.isAllowed('y_good'), true); // empty allowlist => allowed
  assert.equal(open.isAllowed('x_bad'), false); // denylist still wins
});

test('validateArgs returns actionable errors (required / type / enum / range)', () => {
  const r = createToolRegistry();
  r.register(okTool());
  assert.deepEqual(r.validateArgs('knowledge_search', { query: 'hi', limit: 5 }), { ok: true, errors: [] });
  assert.match(r.validateArgs('knowledge_search', {}).errors[0], /missing required 'query'/);
  assert.match(r.validateArgs('knowledge_search', { query: 9 }).errors[0], /'query' expected string/);
  assert.match(r.validateArgs('knowledge_search', { query: 'x', limit: 99 }).errors[0], /> max 50/);
  assert.match(r.validateArgs('nope_tool', {}).errors[0], /unknown tool/);

  const enumReg = createToolRegistry();
  enumReg.register(okTool({ name: 'set_mode', inputSchema: { type: 'object', properties: { mode: { type: 'string', enum: ['light', 'dark'] } }, required: ['mode'] } }));
  assert.match(enumReg.validateArgs('set_mode', { mode: 'neon' }).errors[0], /must be one of/);
});

test('expose returns a small projection capped at maxExposed and reports dropped', () => {
  const r = createToolRegistry({ maxExposed: 2 });
  r.register(okTool({ name: 'a_one' }));
  r.register(okTool({ name: 'b_two' }));
  r.register(okTool({ name: 'c_three' }));
  const e = r.expose();
  assert.equal(e.tools.length, 2);
  assert.equal(e.dropped, 1); // not silently capped
  assert.ok(e.tools[0].name && e.tools[0].description && e.tools[0].inputSchema);
});

test('expose can project a named subset; denied tools are excluded', () => {
  const r = createToolRegistry({ deny: ['b_two'] });
  r.register(okTool({ name: 'a_one' }));
  r.register(okTool({ name: 'b_two' }));
  const e = r.expose(['a_one', 'b_two']);
  assert.deepEqual(e.tools.map((t) => t.name), ['a_one']); // b_two denied
});

test("a tool's risk composes with the permission gate", () => {
  const r = createToolRegistry();
  r.register(okTool({ name: 'bank_transfer', description: 'move money', inputSchema: { type: 'object' }, risk: 'banking' }));
  r.register(okTool({ name: 'note_read', description: 'read a note', inputSchema: { type: 'object' }, risk: 'read' }));
  assert.equal(permissionGate({ kind: r.riskOf('bank_transfer') }).ok, false); // banking refused
  assert.equal(permissionGate({ kind: r.riskOf('note_read') }).ok, true); // read allowed
});
