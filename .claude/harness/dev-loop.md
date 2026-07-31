---
title: Development Loop — how one slice gets chosen, built and banked
audience: [AI agents]
purpose: The shared execution contract for one bounded maintenance or product-growth slice
updated: 2026-07-30
related: [contract.md, handoff.md]
---

# Development Loop

> **HOST-SPECIFIC.** This is Muse's own loop and it names real paths in this repository.
> Everything else under `.claude/harness/` is project-neutral; this file is not.

Where [`contract.md`](contract.md) governs *how one slice is executed* — roles, handoff, gates —
this file governs *how that slice is chosen, verified, and its learning banked*. Maintenance uses
`muse-dev-patterns`; new user-facing capability selection may use `grow-muse`. An honest no-action
result is valid when current evidence exposes no missing delta; never manufacture work to keep a
loop busy.

## 1. The three principles the stages encode

1. **Data picks the slice, not feelings.** Read traces, classify failures, rank by frequency. Until
   enough labels accumulate, the top backlog item substitutes — see the honest limit in §4.
2. **Improve by subtraction.** Contracts, skills and backlogs that only grow become noise the model
   skims. Add a line, prune a line. Deleting a tool, a rule or a doc is a real slice.
3. **Own the load-bearing pieces as code.** Policy, gates and the surface→battery map live in
   version control, never in a prompt or someone's head.

## 2. The loop — one verified slice per fire

Cheapest stage first, fail-closed.

0. **PRE-FLIGHT** — confirm Ollama is up (`curl -s localhost:11434/api/tags`); `git fetch` to
   reconcile with concurrent auto-push loops; rebuild dependency packages you touched, so stale
   dist does not masquerade as a bug.
1. **ORIENT (regression first)** — `pnpm self-eval`. If a previously passing gate dropped, fixing
   *that* is the entire fire. Stop here.
2. **FIND WORK (autonomous)** — climb the invoking skill's sourcing ladder. **Never ask the human
   "what should I build"** — probes and data pick.
3. **PLAN** — WHAT + WHY + the gate being strengthened, as the compact card in
   [`handoff.md`](handoff.md). Trivial (a typo, one line)? Skip to 5.
4. **BUILD** — one vertical slice, minimal scope, deterministic code rather than prompt text. Own
   the prompt, schema and control flow; strengthen one gate or add one `verb_noun` tool. No new
   framework abstraction.
5. **VERIFY (fail-closed)** — `node scripts/pick-evals.mjs` maps the diff to the exact eval/smoke
   subset and prints it (code, not memory; grounding and safety get `MUSE_EVAL_REPEAT=3`
   automatically), plus `pnpm test:changed`, lint 0/0, and `pnpm check` only when the change is
   cross-package. Grounding and safety are `pass^k`, k≥3. Independent verdict comes from the
   `independent-evaluator` subagent. Not green, not done.
6. **WRITE-BACK (completion gate)** — the fixed failure becomes a STABLE-3/3 golden case; a
   repeated correction from the owner becomes one line in `.claude/rules/`; chosen *and* discarded
   directions with their sources go to
   [`../../internal/goals/backlog.md`](../../internal/goals/backlog.md), and a durable fact about the
   owner or the project goes to the memory index. When a set grows, prune a
   stale line. `scripts/guard-writeback.mjs` enforces this at commit-msg time; `[writeback: n/a]`
   is the explicit escape.
7. **COMMIT + PUSH** — one Conventional Commit, then push **only when VERIFY is green**. On
   non-fast-forward, `git pull --rebase` and retry; never force. Report to the owner in Korean:
   what and why, before→after, residual risk.

## 3. Anti-patterns that ruin this loop

- **Ceremony on trivial work.** Orient→analyze→spec→handoff on a one-line fix is pure overhead, and
  a loop that always charges it gets bypassed until it dies. Stage 3 self-gates for this reason.
- **Error-analysis theater on thin data.** Turning four failures into a "taxonomy" is fake rigor.
  Below ~20–30 traces, read them by hand, fix the obvious one, fall back to the backlog.
- **Privacy leakage — the most Muse-specific risk.** Sending raw trace text to a cloud model, or
  committing it verbatim into a taxonomy, breaks the product's own promise. Cluster on the local
  model only; a taxonomy holds redacted labels and counts. Enforced in code, not asked for in a
  prompt.
- **Golden-suite overfitting.** If write-back only ever adds back-catalog, the suite ossifies and
  stops catching new drift. Re-sample fresh traces; grow the suite as a distribution.
- **Infinite harness polishing.** Scaffold gains compound early and saturate fast. Once the loop is
  tight, stop meta-engineering and go back to capability.

## 4. Honest limits

- **`MUSE_LOCAL_ONLY` blocks LLM and voice egress only.** Downloading a public eval dataset is
  allowed — but vendor it into `apps/cli/scripts/fixtures/`, pin checksums, and commit, so
  reproduction is offline. Without this clause an agent blocks itself on its own gate and stalls.
- **On one local model, maker = judge, so `eval:judge` is advisory.** The same model grading itself
  on toy fixtures carries almost no signal about this slice's truth. A fabrication-critical claim
  takes deterministic scorers first, otherwise a separate stronger-model evaluator with write tools
  removed. This is the irreducible "needs a stronger model or a human" point: a fixed local model
  cannot self-certify the grounding claim it just made.
- **Autonomy lasts only as long as the seed.** Write-back records the sources of *consumed* items
  but mints no new work, and "add a line, prune a line" caps growth. The durable refill is
  error-analysis, which needs trace outcome labels, and that fuel accumulates from the owner
  *using* Muse — not from dev fires. When `[open]` records run dry, a refill fire is itself the
  work. This makes verified slice execution cheap and cumulative; it is not unsupervised
  self-evolution.
