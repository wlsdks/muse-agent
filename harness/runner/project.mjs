// Multi-step orchestration — drives a LARGE task by decomposing it into ordered
// subtasks and running EACH through the single-cycle runner (plan->build->
// evaluate, fully gated), then composing. The project-level gate is fail-closed:
// no subtasks -> BLOCKED; any subtask that blocks stops the project (later
// subtasks don't run). This is the map-reduce-and-manage shape the 2026
// references converged on (Cognition; Anthropic three-agent harness): a manager
// splits work, each piece runs gated, the manager aggregates.
//
// Subtasks share context: each subtask receives the (bounded) outputs of the
// completed earlier subtasks, so a later step can build on an earlier one
// ("앞 결과를 뒤가 사용"). Set shareContext:false for fully independent subtasks.
// Zero deps.

import { runCycle } from './orchestrator.mjs';
import { createTracer } from './tracer.mjs';
import { snapshot, deserializeSession } from './session.mjs';

function parseJson(text) {
  if (typeof text !== 'string') return null;
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

// Build the prior-output context block a dependent subtask sees (bounded so it
// doesn't bloat the next step's window).
function priorContext(priorOutputs, perItemChars = 600) {
  if (!priorOutputs.length) return '';
  const lines = priorOutputs.map((p) => `- (${p.index}) ${p.sub}:\n${String(p.build ?? '').slice(0, perItemChars)}`);
  return `\n\n[이전 서브태스크 산출 — 이어서 사용]\n${lines.join('\n')}`;
}

export async function runProject(task, opts = {}) {
  const { callAgent, now = () => 0, runId = 'project', redact, checkpoint, resume, shareContext = true, ...cycleOpts } = opts;
  if (typeof callAgent !== 'function') throw new Error('callAgent is required');

  const tr = createTracer({ runId, now, redact });
  const log = ({ event, ...data }) => tr.add(event, data);
  const result = (extra) => ({ ...extra, trace: tr.events, summary: tr.summary() });
  const fail = (reason) => { log({ event: 'project-blocked', reason }); return result({ ok: false, state: 'BLOCKED', reason }); };
  log({ event: 'project-start', task });

  // 1) DECOMPOSE (or resume to the next undone subtask, restoring prior outputs).
  let subtasks;
  let startIndex = 0;
  let priorOutputs = [];
  if (resume) {
    const r = deserializeSession(resume);
    subtasks = r.criteria;
    startIndex = r.attempt || 0;
    priorOutputs = Array.isArray(r.build) ? r.build : []; // prior outputs persisted in snapshot.build
    log({ event: 'resumed', completed: startIndex, count: Array.isArray(subtasks) ? subtasks.length : 0 });
  } else {
    const decompRaw = await callAgent('orchestrator', `Decompose this task into an ordered list of small, independently buildable subtasks. Output ONLY one JSON line: {"subtasks":["...","..."]}.\n\n[task]\n${task}`);
    subtasks = parseJson(decompRaw)?.subtasks;
    if (!Array.isArray(subtasks) || subtasks.length === 0) return fail('decompose gate: no subtasks produced');
    log({ event: 'decompose', count: subtasks.length, subtasks });
  }
  if (!Array.isArray(subtasks) || subtasks.length === 0) return fail('decompose gate: empty subtask list');

  // 2) Drive each subtask through the single-cycle runner (each fully gated),
  //    feeding forward the completed subtasks' outputs.
  const results = [];
  for (let i = startIndex; i < subtasks.length; i++) {
    const sub = subtasks[i];
    const dependent = shareContext && priorOutputs.length > 0;
    log({ event: 'subtask-start', index: i, sub, dependsOnPrior: dependent });
    const subTask = dependent ? `${sub}${priorContext(priorOutputs)}` : sub;
    const r = await runCycle(subTask, { ...cycleOpts, callAgent, now, redact, runId: `${runId}.s${i}` });
    results.push({ index: i, ok: r.ok, state: r.state, build: r.build ?? null, reason: r.reason ?? null });
    if (!r.ok) {
      log({ event: 'subtask-blocked', index: i, reason: r.reason });
      return result({ ok: false, state: 'BLOCKED', reason: `subtask ${i} blocked: ${r.reason}`, subtasks: results });
    }
    if (shareContext) priorOutputs.push({ index: i, sub, build: r.build ?? null });
    log({ event: 'subtask-done', index: i });
    if (checkpoint) await checkpoint(snapshot({ runId, phase: 'SUBTASK', criteria: subtasks, attempt: i + 1, build: priorOutputs }));
  }

  // 3) Project-level completion gate: every subtask reached DONE.
  log({ event: 'project-done', count: subtasks.length });
  return result({ ok: true, state: 'DONE', subtasks: results });
}
