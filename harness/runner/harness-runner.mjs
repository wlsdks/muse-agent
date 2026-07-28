// Deterministic harness runner — the code that ENFORCES the gates the rest of
// the harness only describes in prose. The model reasons WITHIN a state; this
// file decides whether a state transition is allowed. Fail-closed by default:
// anything not explicitly permitted is denied (BLOCKED), so a missing or
// ambiguous precondition can never advance the work.
//
// Zero dependencies (Node built-ins only) so harness/ stays self-contained and
// portable. Spec: ../runner-spec.md (§1 cycle, §3 gates, §7 conformance matrix).

export const STATES = ['REQUESTED', 'PLANNED', 'BUILT', 'EVALUATED', 'DONE', 'BLOCKED'];

// A gate returns { ok:true } or { ok:false, reason }. Gates are pure and
// deterministic — they are the unit-testable heart of the harness.

// Plan gate: no build may start from a claim-only plan. Every phase slice must
// state what changes, why, how PASS is observed, what stays outside the slice,
// how evidence is accounted, and how to recover. Missing or blank fields fail
// closed so a planner cannot smuggle ambiguity through a non-empty criteria
// array.
const TEXT_FIELDS = ['what', 'why', 'evidenceAccounting', 'rollback'];
const LIST_FIELDS = ['passCriteria', 'outOfScope', 'verificationCommands'];
export const ACTIVATION_BUDGET_LIMITS = Object.freeze({
  activeBudgetMinutes: 20,
  commandTimeoutMinutes: 12,
  validationMinutes: 6,
});

function hasText(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function hasTextList(value) {
  return Array.isArray(value)
    && value.length > 0
    && value.every((entry) => hasText(entry));
}

export function planGate(acceptanceSlice) {
  if (!acceptanceSlice || typeof acceptanceSlice !== 'object' || Array.isArray(acceptanceSlice)) {
    return { ok: false, reason: 'acceptanceSlice missing (fail-closed)' };
  }
  for (const field of TEXT_FIELDS) {
    if (!hasText(acceptanceSlice[field])) {
      return { ok: false, reason: `${field} missing or blank (fail-closed)` };
    }
  }
  for (const field of LIST_FIELDS) {
    if (!hasTextList(acceptanceSlice[field])) {
      return { ok: false, reason: `${field} missing, empty, or blank (fail-closed)` };
    }
  }
  for (const [field, limit] of Object.entries(ACTIVATION_BUDGET_LIMITS)) {
    const value = acceptanceSlice[field];
    if (!Number.isSafeInteger(value) || value <= 0 || value > limit) {
      return { ok: false, reason: `${field} missing, invalid, or over ${limit} minutes (fail-closed)` };
    }
  }
  return { ok: true };
}

// Permission gate: classify the action and apply the fail-closed policy from
// permission-matrix.md / outbound-safety. Banking is a permanent hard refusal;
// outbound needs a resolved recipient AND explicit human confirmation; write/
// execute need trust; unknown kinds are denied.
export function permissionGate(action) {
  const kind = action?.kind;
  switch (kind) {
    case 'banking':
      return { ok: false, reason: 'banking / payments are permanently out of scope' };
    case 'outbound':
      if (action.recipientResolved !== true) return { ok: false, reason: 'ambiguous recipient — clarify first' };
      if (action.confirmed !== true) return { ok: false, reason: 'outbound requires draft-first + human confirm' };
      return { ok: true };
    case 'read':
      return { ok: true };
    case 'write':
    case 'execute':
      return action?.trusted === true ? { ok: true } : { ok: false, reason: `${kind} requires trust/allowlist` };
    default:
      return { ok: false, reason: 'unknown action kind (fail-closed)' };
  }
}

function ok(next, extra = {}) { return { state: next, ok: true, ...extra }; }
function blocked(reason) { return { state: 'BLOCKED', ok: false, reason }; }

// The core transition function. Given the current state, an event, and context
// (criteria / verdict / worker & evaluator identity / retries), it returns the
// next state — or BLOCKED with a reason. Every illegal or ungated transition
// falls through to the fail-closed default.
export function advance(state, event, ctx = {}) {
  switch (`${state}:${event}`) {
    case 'REQUESTED:plan': {
      const g = planGate(ctx.acceptanceSlice);
      return g.ok ? ok('PLANNED') : blocked(g.reason);
    }
    case 'PLANNED:build':
      return ok('BUILT');
    case 'BUILT:evaluate': {
      // maker != judge: the evaluator must be a different instance than the worker.
      if (ctx.workerId != null && ctx.evaluatorId != null && ctx.workerId === ctx.evaluatorId)
        return blocked('maker == judge (evaluator must be a different instance)');
      if (ctx.verdict !== 'PASS' && ctx.verdict !== 'FAIL')
        return blocked('evaluator must return PASS or FAIL');
      return ok('EVALUATED', { verdict: ctx.verdict });
    }
    case 'EVALUATED:complete':
      // completion gate: only an evaluator PASS may finish the work.
      if (ctx.verdict !== 'PASS') return blocked('completion gate: no evaluator PASS');
      return ok('DONE');
    case 'EVALUATED:rebuild':
      // FAIL loops back to BUILD, bounded by a hard retry cap (loop-budget).
      if ((ctx.retries ?? 0) >= (ctx.maxRetries ?? 3)) return blocked('retry cap reached');
      return ok('BUILT');
    default:
      return blocked(`illegal transition ${state} --${event}--> (fail-closed)`);
  }
}

// Stateful wrapper that makes resume idempotent: each transition carries an id,
// and replaying an already-applied id returns the prior result without side
// effects (a crashed/resumed runner can't double-apply a step).
export function createRun(initial = 'REQUESTED') {
  let state = initial;
  const applied = new Map();
  return {
    get state() { return state; },
    apply(id, event, ctx = {}) {
      if (applied.has(id)) return applied.get(id);
      const res = advance(state, event, ctx);
      if (res.ok) state = res.state;
      applied.set(id, res);
      return res;
    },
  };
}
