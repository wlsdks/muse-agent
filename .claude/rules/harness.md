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

1. **Split into roles** — planner (acceptance criteria) → worker (build)
   → evaluator (independent PASS/FAIL). **Maker ≠ judge** always: the
   evaluator is a different instance from the worker.
2. **Hand off via one artifact** — the
   [`handoff-template`](../../harness/handoff-template.md); each role fills
   only its section, the next role reads only that (context reset).
3. **Pass the gates (fail-closed)** — plan gate (no empty/contradictory
   criteria → no BUILD), completion gate (no evaluator PASS → not done),
   permission gate (outbound = draft-first + human confirm; banking =
   refused). Uncertain ⇒ stop, don't pass. See
   [`verification-and-guardrails`](../../harness/verification-and-guardrails.md)
   and [`permission-matrix`](../../harness/permission-matrix.md).
4. **Respect the foundations** — loop budget caps (2–3 retry max), memory
   write rules, compaction that preserves decisions+sources.
5. **Verify or it didn't happen** — golden-set + pass^k
   ([`harness-acceptance`](../../harness/harness-acceptance.md)).

## Project mapping

How the abstract roles map to Muse's real runtime lives in
[`harness/muse-mapping.md`](../../harness/muse-mapping.md). When reusing
the harness in another project, that mapping file is the one thing you
rewrite; the rest of `harness/` is copied as-is
([`harness/INSTALL.md`](../../harness/INSTALL.md)).

This rule is a pointer; `harness/AGENTS.md` is the authority.
