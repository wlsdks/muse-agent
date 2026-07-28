#!/usr/bin/env node
// CLI entrypoint: drive a real task through the harness with REAL agents.
//
//   node harness/runner/run.mjs "build a function that reverses a string"
//
// Each role is a separate `claude -p` invocation (a fresh context per role =
// the maker != judge separation in practice). The deterministic gates in
// harness-runner.mjs decide whether each transition is allowed; this file only
// shells out and parses. A trace is written to harness/runner/last-trace.json.
//
// Portability: the agent binary is `claude` on PATH, or set CLAUDE_BIN. Swap in
// any other agent CLI by editing callAgent or pointing CLAUDE_BIN at it.

import { execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { runCycle } from './orchestrator.mjs';
import { redactSecrets } from './tracer.mjs';
import { createFileStore } from './session.mjs';

const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';
const here = dirname(fileURLToPath(import.meta.url));
const execFileAsync = promisify(execFile);

const ROLE_FRAMING = {
  planner:
    'You are the PLANNER. Produce a complete acceptance slice for the task. ' +
    'Output ONLY one JSON line with every required field: ' +
    '{"what":"...","why":"...","passCriteria":["..."],"outOfScope":["..."],' +
    '"verificationCommands":["..."],"evidenceAccounting":"...","rollback":"...",' +
    '"activeBudgetMinutes":20,"commandTimeoutMinutes":12,"validationMinutes":6}. No prose.',
  worker:
    'You are the WORKER. Implement code that satisfies the acceptance criteria. ' +
    'Output only the implementation.',
  evaluator:
    'You are the EVALUATOR and you did NOT write this build. Check each acceptance ' +
    'criterion, testing edge cases; if any is violated it is not PASS. Output ONLY ' +
    'one JSON line: {"verdict":"PASS|FAIL","reason":"..."}. No prose.',
};

async function claude(prompt) {
  try {
    const { stdout } = await execFileAsync(CLAUDE_BIN, ['-p', prompt, '--output-format', 'text'], {
      timeout: 120_000,
      maxBuffer: 10 * 1024 * 1024
    });
    return String(stdout || '');
  } catch (error) {
    if (error && typeof error === "object" && "stdout" in error && String(error.stdout || "") !== "") {
      return String(error.stdout);
    }
    throw error;
  }
}

const callAgent = (role, body) => claude(`${ROLE_FRAMING[role]}\n\n${body}`);

async function main() {
  const task = process.argv.slice(2).join(' ').trim();
  if (!task) {
    console.error('usage: node harness/runner/run.mjs "<task>"');
    process.exit(2);
  }
  const start = Date.now();
  const runId = `run-${start}`;
  // Checkpoint each phase so a crashed/paused run can resume without redoing
  // completed steps (load the snapshot and pass it back as opts.resume).
  const sessions = createFileStore(join(here, 'sessions'));
  const res = await runCycle(task, {
    callAgent,
    now: () => Date.now() - start,
    runId,
    redact: redactSecrets,
    checkpoint: (s) => sessions.save(s),
  });
  await writeFile(join(here, 'last-trace.json'), JSON.stringify({ events: res.trace, summary: res.summary }, null, 2));
  console.log(JSON.stringify({ ok: res.ok, state: res.state, reason: res.reason ?? null, summary: res.summary }));
  process.exit(res.ok ? 0 : 1);
}

main().catch((e) => { console.error('runner error:', e.message); process.exit(1); });
