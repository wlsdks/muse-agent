// Session persistence — checkpoint a run's resumable state so a crashed or
// paused run continues across context windows WITHOUT redoing completed steps
// (control-plane "session persistence / persisting state across turns";
// Anthropic effective-harnesses: "consistent progress across multiple context
// windows"). The store is injectable so the harness stays portable; a memory
// store and a file store (Node fs — zero EXTERNAL deps) are provided.

import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

// A snapshot is the minimal state needed to resume: where we are (phase), the
// acceptance plan (a structured slice for new runs; a criteria array for
// backward-compatible v1 resumes), the retry attempt, and the latest
// build/verdict (so a produced build isn't rebuilt).
export function snapshot({ runId, phase, criteria = null, attempt = 0, build = null, verdict = null }) {
  if (!runId || !phase) throw new Error('snapshot needs runId + phase');
  return { v: 1, runId, phase, criteria, attempt, build, verdict };
}

export function serializeSession(s) { return JSON.stringify(s); }

export function deserializeSession(json) {
  const s = typeof json === 'string' ? JSON.parse(json) : json;
  if (!s || s.v !== 1 || typeof s.runId !== 'string' || typeof s.phase !== 'string') {
    throw new Error('invalid session snapshot');
  }
  return s;
}

export function createMemoryStore() {
  const m = new Map();
  return {
    async save(s) { m.set(s.runId, serializeSession(deserializeSession(s))); },
    async load(runId) { const j = m.get(runId); return j ? deserializeSession(j) : null; },
    async list() { return [...m.keys()]; },
  };
}

// One JSON file per runId. fs is a Node builtin, so this is still dependency-free.
export function createFileStore(dir) {
  const file = (id) => join(dir, `${id}.session.json`);
  return {
    async save(s) {
      const valid = deserializeSession(s);
      await mkdir(dir, { recursive: true });
      await writeFile(file(valid.runId), serializeSession(valid));
    },
    async load(runId) {
      try { return deserializeSession(await readFile(file(runId), 'utf8')); } catch { return null; }
    },
    async list() {
      try {
        return (await readdir(dir)).filter((f) => f.endsWith('.session.json')).map((f) => f.replace('.session.json', ''));
      } catch { return []; }
    },
  };
}
