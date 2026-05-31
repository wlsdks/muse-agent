#!/usr/bin/env node
// CLI: drive a LARGE multi-step task end-to-end with REAL agents. The
// orchestrator decomposes the task into subtasks; each subtask runs through the
// gated single-cycle runner; the project completes only if every subtask does.
//
//   node harness/runner/run-project.mjs "build an in-memory TODO module: add, list, complete"
//
// Portability: agent binary is `claude` on PATH, or set CLAUDE_BIN.

import { execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { runProject } from './project.mjs';
import { redactSecrets } from './tracer.mjs';

const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';
const here = dirname(fileURLToPath(import.meta.url));

const ROLE_FRAMING = {
  orchestrator:
    'You are the ORCHESTRATOR. Decompose the task into an ordered list of small, ' +
    'independently buildable subtasks. Output ONLY one JSON line: {"subtasks":["...","..."]}. No prose.',
  planner:
    'You are the PLANNER. Produce verifiable acceptance criteria for the subtask. ' +
    'Output ONLY one JSON line: {"criteria":["...","..."]}. No prose.',
  worker:
    'You are the WORKER. Implement code that satisfies the acceptance criteria. Output only the implementation.',
  evaluator:
    'You are the EVALUATOR and you did NOT write this build. Check each acceptance ' +
    'criterion, testing edge cases; if any is violated it is not PASS. Output ONLY ' +
    'one JSON line: {"verdict":"PASS|FAIL","reason":"..."}. No prose.',
};

function claude(prompt) {
  return new Promise((resolve, reject) => {
    const child = execFile(
      CLAUDE_BIN,
      ['-p', prompt, '--output-format', 'text'],
      { timeout: 120_000, maxBuffer: 10 * 1024 * 1024 },
      (err, stdout) => (err && !stdout ? reject(err) : resolve(String(stdout || ''))),
    );
    child.stdin.end();
  });
}

const callAgent = (role, body) => claude(`${ROLE_FRAMING[role]}\n\n${body}`);

async function main() {
  const task = process.argv.slice(2).join(' ').trim();
  if (!task) { console.error('usage: node harness/runner/run-project.mjs "<task>"'); process.exit(2); }
  const start = Date.now();
  const res = await runProject(task, {
    callAgent,
    now: () => Date.now() - start,
    runId: `project-${start}`,
    redact: redactSecrets,
  });
  await writeFile(join(here, 'last-project-trace.json'), JSON.stringify({ events: res.trace, summary: res.summary, subtasks: res.subtasks }, null, 2));
  console.log(JSON.stringify({ ok: res.ok, state: res.state, reason: res.reason ?? null, subtasks: (res.subtasks || []).length, summary: res.summary }));
  process.exit(res.ok ? 0 : 1);
}

main().catch((e) => { console.error('project runner error:', e.message); process.exit(1); });
