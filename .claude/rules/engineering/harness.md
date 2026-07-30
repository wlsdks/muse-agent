# Agent operating harness

The operating contract for multi-step agent work — roles, handoff, fail-closed
gates, verification — is [`.claude/harness/contract.md`](../../harness/contract.md).
**Read it before any non-trivial, multi-step task and follow it.** Muse's own
slice-selection loop is [`dev-loop.md`](../../harness/dev-loop.md).

Skip it for a one-line answer or a trivial single edit; it is overhead there.

This file stays deliberately short because it is loaded into every session. It
carries only the two things an agent must know *before* it decides whether to
open the contract at all.

## 1. Maker ≠ judge is never waived

The evaluator is a **different instance** from the worker. A self-graded PASS is
void; if separation is genuinely impossible, record `unseparated
self-evaluation` and ask for human review — never PASS.

## 2. When an independent evaluator is MANDATORY

Unconditionally required when the diff touches any of: user-visible
strings/i18n, an on-disk/persisted format (stores, checkpoints, credentials),
an advertised flag/CLI/API/UI contract, a security/permission/outbound path,
process/scheduler/concurrency, harness gates, release, or anything
irreversible.

Otherwise — internal refactors, type plumbing, pure test changes — a thinner
tier is enough: the builder runs an explicit adversarial self-check ("find an
input where this is wrong") and the controller skims the diff. **Record which
tier was used in the commit body.**

Evidence for the cost: in one session all 4 real evaluator catches were
**silent-failure classes** (data corruption, a dead locale string, a lying flag,
a timing bug) — exactly what a green test suite does not surface.
