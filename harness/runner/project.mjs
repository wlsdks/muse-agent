// Multi-step orchestration — drives a LARGE task by decomposing it into ordered
// subtasks and running EACH through the single-cycle runner (plan->build->
// evaluate, fully gated), then composing. The project-level gate is fail-closed:
// no subtasks -> BLOCKED; any subtask that blocks stops the project (later
// subtasks don't run). This is the map-reduce-and-manage shape the 2026
// references converged on (Cognition; Anthropic three-agent harness): a manager
// splits work, each piece runs gated, the manager aggregates. Zero deps.

import { runCycle } from './orchestrator.mjs';
import { createTracer } from './tracer.mjs';
import { snapshot, deserializeSession } from './session.mjs';

function parseJson(text) {
  if (typeof text !== 'string') return null;
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

export async function runProject(task, opts = {}) {
  const { callAgent, now = () => 0, runId = 'project', redact, checkpoint, resume, ...cycleOpts } = opts;
  if (typeof callAgent !== 'function') throw new Error('callAgent is required');

  const tr = createTracer({ runId, now, redact });
  const log = ({ event, ...data }) => tr.add(event, data);
  const result = (extra) => ({ ...extra, trace: tr.events, summary: tr.summary() });
  log({ event: 'project-start', task });

  // 1) DECOMPOSE (or resume to the next undone subtask).
  let subtasks;
  let startIndex = 0;
  if (resume) {
    const r = deserializeSession(resume);
    subtasks = r.criteria; // subtask list is stored in the snapshot's criteria field
    startIndex = r.attempt || 0; // attempt = number of subtasks already done
    log({ event: 'resumed', completed: startIndex, count: Array.isArray(subtasks) ? subtasks.length : 0 });
  } else {
    const decompRaw = await callAgent('orchestrator', `Decompose this task into an ordered list of small, independently buildable subtasks. Output ONLY one JSON line: {"subtasks":["...","..."]}.\n\n[task]\n${task}`);
    subtasks = parseJson(decompRaw)?.subtasks;
    if (!Array.isArray(subtasks) || subtasks.length === 0) {
      return fail('decompose gate: no subtasks produced');
    }
    log({ event: 'decompose', count: subtasks.length, subtasks });
  }
  if (!Array.isArray(subtasks) || subtasks.length === 0) return fail('decompose gate: empty subtask list');

  // 2) Drive each subtask through the single-cycle runner (each fully gated).
  const results = [];
  for (let i = startIndex; i < subtasks.length; i++) {
    const sub = subtasks[i];
    log({ event: 'subtask-start', index: i, sub });
    const r = await runCycle(sub, { ...cycleOpts, callAgent, now, redact, runId: `${runId}.s${i}` });
    results.push({ index: i, ok: r.ok, state: r.state, build: r.build ?? null, reason: r.reason ?? null });
    if (!r.ok) {
      log({ event: 'subtask-blocked', index: i, reason: r.reason });
      return result({ ok: false, state: 'BLOCKED', reason: `subtask ${i} blocked: ${r.reason}`, subtasks: results });
    }
    log({ event: 'subtask-done', index: i });
    if (checkpoint) await checkpoint(snapshot({ runId, phase: 'SUBTASK', criteria: subtasks, attempt: i + 1 }));
  }

  // 3) Project-level completion gate: every subtask reached DONE.
  log({ event: 'project-done', count: subtasks.length });
  return result({ ok: true, state: 'DONE', subtasks: results });

  function fail(reason) { log({ event: 'project-blocked', reason }); return result({ ok: false, state: 'BLOCKED', reason }); }
}
