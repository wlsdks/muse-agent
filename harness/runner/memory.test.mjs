// Tests for the memory runtime component: write/read/consolidate/decay/promote.
// Run: node --test harness/runner/

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemory } from './memory.mjs';

test('write stores durable items; rejects empty; drops one-off (non-durable)', () => {
  const m = createMemory();
  assert.equal(m.write({ text: 'user prefers dark mode', kind: 'preference' }).stored, true);
  assert.throws(() => m.write({ text: '   ' }));
  const oneOff = m.write({ text: 'had kimbap for lunch today', durable: false });
  assert.equal(oneOff.stored, false); // transient not kept in long-term
  assert.equal(m.records.length, 1);
});

test('read retrieves by relevance and bumps recall', () => {
  const m = createMemory();
  m.write({ text: 'deploy is fixed to Tuesday 10am' });
  m.write({ text: 'no Friday deploys ever' });
  m.write({ text: 'favorite color is teal' });
  const hits = m.read('when is the deploy', { limit: 2 });
  assert.ok(hits.length >= 1);
  assert.match(hits[0].text, /deploy/);
  assert.equal(hits[0].recalls, 1); // recall bumped
  assert.deepEqual(m.read('', {}), []); // empty query -> nothing
});

test('consolidate merges duplicates, summing recalls and keeping max confidence', () => {
  const m = createMemory();
  m.write({ text: 'Dark mode', confidence: 0.5 });
  m.write({ text: 'dark mode', confidence: 0.9 });
  m.read('dark mode'); // bump both
  const { merged } = m.consolidate();
  assert.equal(merged, 1);
  assert.equal(m.records.length, 1);
  assert.equal(m.records[0].confidence, 0.9);
});

test('decay fades inferences by half-life and drops below floor; facts unaffected', () => {
  let clock = 0;
  const m = createMemory({ now: () => clock, halfLifeMs: 100, floor: 0.1 });
  m.write({ text: 'seems to like short answers', kind: 'inference', confidence: 1 });
  m.write({ text: 'lives in Seoul', kind: 'fact', confidence: 1 });
  clock = 100; // one half-life
  m.decay();
  const inf = m.records.find((r) => r.kind === 'inference');
  assert.ok(Math.abs(inf.confidence - 0.5) < 1e-9);
  assert.equal(m.records.find((r) => r.kind === 'fact').confidence, 1); // fact untouched
  clock = 1000; // many half-lives -> below floor
  const { dropped } = m.decay();
  assert.equal(dropped, 1);
  assert.equal(m.records.some((r) => r.kind === 'inference'), false);
});

test('promote marks often-recalled records as core', () => {
  const m = createMemory();
  m.write({ text: 'primary project is Muse' });
  m.read('Muse project'); m.read('Muse'); m.read('the Muse project'); // 3 recalls
  const { promoted } = m.promote({ minRecalls: 3 });
  assert.equal(promoted, 1);
  assert.equal(m.core().length, 1);
  assert.match(m.core()[0].text, /Muse/);
});
