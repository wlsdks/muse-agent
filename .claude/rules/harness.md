# Agent operating harness

This repo ships a **portable, vendor-neutral agent harness** in the
top-level [`harness/`](../../harness/) folder. It is the operating system
for multi-step agent work: roles, handoff, fail-closed gates, and
verification. For any non-trivial, multi-step task, operate under it.

## When to use

- Multi-step build/fix/research where plan → build → judge separation
  matters, or where a wrong autonomous action would be costly.
- NOT for a one-line answer or a trivial single edit — the harness is
  overhead there; just answer.

## The contract (entrypoint: `harness/AGENTS.md`)

Read [`harness/AGENTS.md`](../../harness/AGENTS.md) first, then follow it:

1. **Two mandatory roles: worker (build) → independent evaluator
   (PASS/FAIL)**. Planner/curator are inline fields the worker or
   orchestrator fills (WHAT+WHY+acceptance-criteria up front in the
   handoff header; learnings/write-back in the commit body per
   `muse-dev-patterns` §8) — not separate passes, except for L-size or
   security-critical slices (`harness/core/team-roles.md` §1). **Maker ≠
   judge** always: the evaluator is a different instance from the worker.
2. **Hand off via one artifact** — the
   [`handoff-template`](../../harness/core/handoff-template.md) (5 fields:
   header, acceptance criteria, verification method, worker notes,
   evaluator verdict); each role fills only its section, the next role
   reads only that (context reset).
3. **Pass the gates (fail-closed)** — plan gate (no empty/contradictory
   criteria → no BUILD), completion gate (no evaluator PASS → not done),
   permission gate (outbound = draft-first + human confirm; banking =
   refused). Uncertain ⇒ stop, don't pass. See
   [`verification-and-guardrails`](../../harness/core/verification-and-guardrails.md)
   and [`permission-matrix`](../../harness/core/permission-matrix.md).
4. **Respect the foundations** — loop budget caps (2–3 retry max), memory
   write rules, compaction that preserves decisions+sources.
5. **Verify or it didn't happen** — golden-set + pass^k
   ([`harness-acceptance`](../../harness/reference/harness-acceptance.md)).

### Evaluator risk-tiering (when the independent evaluator is MANDATORY)

A separate-context independent evaluator is **mandatory** when the diff
touches any of: user-visible strings/i18n, an on-disk/persisted format
(stores, checkpoints, credentials), an advertised flag/contract/API
behavior, a security/permission/outbound path, or anything irreversible.
For internal refactors/type-plumbing/pure-test changes, a lighter tier is
enough: the builder runs an explicit adversarial self-check ("find an
input where this is wrong") + the orchestrator skims the diff. Record
which tier was used in the commit body — this is not optional ceremony.
Evidence: in one session, 4/4 real evaluator catches were **silent-failure
classes** (data corruption, a dead locale string, a lying flag, a timing
bug) — exactly the class a green test suite does not surface.

## Project mapping

How the abstract roles map to Muse's real runtime lives in
[`harness/host/muse-mapping.md`](../../harness/host/muse-mapping.md). When reusing
the harness in another project, that mapping file is the one thing you
rewrite; the rest of `harness/` is copied as-is
([`harness/INSTALL.md`](../../harness/INSTALL.md)).

This rule is a pointer; `harness/AGENTS.md` is the authority.
