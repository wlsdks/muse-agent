# Agent-level testing — evaluating the AGENT, not just the code

Unit tests prove a function is correct; they do **not** prove the *agent*
is good — that the model picks the right tool in one shot, abstains when
it should, and reaches the real goal state *reliably*. That is
**evaluation (evals)** — ship it with every agent-facing capability. Full
method and sources live in the strategy doc below. The dated
Muse inventory, gaps, library decisions, and implementation order live in
[`../../../docs/development/ai-agent-testing-strategy.md`](../../../docs/development/ai-agent-testing-strategy.md).

**Three principles, if you read nothing else:** (1) **Error-analysis
FIRST, imagination never** — evals GROW from real misses. (2)
**Deterministic code is the GATE; the LLM-judge is a DEBUGGER** — code
decides pass/fail on the safety-load path, the judge never gates a
safety claim alone. (3) **Grade OUTCOMES, `pass^k`, all-pass** — score
terminal state not the path; reliability is every repeat passing.

## The non-negotiables (every agent capability)

1. **Agent-level check, not just a unit test.** A tool the model never
   SELECTS is not delivered — prove it live (`smoke:live`), not `tsc`.
2. **Grade the terminal state, not the exact path.** Assert the resulting
   world state + final answer; pin trajectory order only where a step
   genuinely depends on a prior one.
3. **No partial side-effects.** A failed/invalid action mutates
   **nothing**, and a write never damages *unrelated* state — the
   deny/invalid-arg/tool-failure test path asserts an unchanged store.
4. **Reliability is `pass^k`, not one green run.** Run a grounding- or
   safety-critical case k times, require **all k** to pass
   (`MUSE_EVAL_REPEAT`); pre-verify a new live case STABLE 3/3. Never
   report `pass@k` ("at least once") as reliability.
5. **Security/safety is CODE, never a passing prompt.** A must-refuse battery
   proves the model refuses; the deterministic gate (injection patterns,
   approval gate) is the real protection — doubly so where refusal is
   language-asymmetric (an observed KO/EN gap) — and gets the regression test.
6. **Tool-calling and multi-agent hand-offs get their own asserts** —
   run `pnpm eval:tools` after touching any tool schema/description
   (selection is the binding constraint on an 8B model); validate every
   multi-agent hand-off against a typed schema and assert bounded,
   verification-backed termination. Full breakdown: the strategy doc.

## The layered method (cheapest grader first)

| Layer | Proves | Grader |
|---|---|---|
| Unit | a function is correct | `vitest` (deterministic) |
| Tool-calling | model SELECTS + fills the right tool in one shot | `eval:tools` (deterministic) + `smoke:live` |
| Task-completion | terminal world state reached, no collateral damage | terminal-state/trajectory tests (deterministic) |
| Multi-agent seams | hand-offs validate, loop terminates, failures surface | schema parse + bounded-step asserts |
| Production | holds on REAL traces, not fixtures | human trace-reading → new golden cases |

(1) **deterministic scorers** — selected? args present? terminal state
matches? (`toolScorers` in `eval-harness.mjs`, every case). (2)
**LLM-as-judge only for what code can't grade** — binary PASS/FAIL at
T=0 (`llmJudge`); a 1–5 rubric is an anti-pattern. (3) **Human
trace-reading, regularly** — catches a broken eval before a scorer does.

**maker ≠ judge.** One local model means the judge IS the maker, so a
safety claim is never gated by the judge alone. Compensating controls:
deterministic graders own the safety verdict; `eval:judge` meta-evaluates
the judge first; verdicts are binary and must NAME a concrete violation
("seems off" is not grounds to reject); periodic fault-injection drills
prove the judge still rejects bad work. Evidence: the strategy doc.

**Reliability discipline:** `MUSE_EVAL_REPEAT` (k=3 for local/self-hosted
reliability gates, k≥5 grounding/safety-critical), strict all-pass; T=0 is a
cheap gate, not a statistical guarantee. `eval:agent`/`eval:self-improving`
aggregate live local-Ollama batteries; they are not GitHub CI gates and a skip
is unverified. `self-eval` fails closed on regression. Error-analysis is FIRST — read
20–50 real traces before writing a scorer (Muse's "production" is n=1 dogfooding).

## Evaluation accounting vocabulary

Large synthetic corpora must keep semantic coverage separate from prompt volume.
A **semantic family** is one canonical objective/setup/expected/forbidden contract;
a **surface variant** changes factors or expression without becoming an independent
truth. Report both, and never relabel synthetic surface variants as independent
semantic cases.

Synthetic scale is not evidence quality. A **synthetic profile** shapes generated
conditions; a **journey** is an ordered state-linked sequence; a **turn** is one case
within it. Longitudinal transition coverage may be named `realismProxy.v1`, but that
proxy is neither organic usage nor proof of realistic user behavior.

Dataset accounting and agent-execution accounting are different ledgers:

- `generated = valid + invalid`; `sampled <= valid`. Generated/validated/sampled
  artifacts prove corpus integrity, **not** agent PASS.
- A **case** is one eval specification. A **trial** is one execution of a case. An
  **inference request** is one model request inside a trial; retries increase requests
  and may increase trials according to the runner contract, but never create cases.
- `pass^k` runs the same case for `k` trials and requires all `k` to pass. It increases
  trial and inference-request counts, not case, semantic-family, or surface-variant
  counts. Do not report it as `pass@k`.
- Until trials actually run, agent results remain `UNVERIFIED`/`NOT_RUN`; generated or
  validated data cannot be booked as agent passed/failed signal.
- Provenance and execution are independent axes. Immutable case `dataOrigin`
  (`synthetic | consented_trace_derived`) answers where a case came from;
  `executionEvidence` (`not_run | live_executed`) answers whether it ran. Never infer
  one from the other.
- **Controlled replay** exercises a public interface against synthetic state. It is
  not organic production evidence. `organic` authority is minted only by the
  production composition root; `unclassified` is fail-closed. A factual interaction
  receipt is not outcome feedback and cannot promote policy.

Every report names the ledger explicitly: semantic families, surface variants,
synthetic profiles/journeys/turns, immutable `dataOrigin`, independent
`executionEvidence`, controlled replay/organic evidence, generated/valid/invalid/sampled
cases, executed cases, trials, inference requests, and agent passed/failed/unverified.
Consented trace-derived promotion requires explicit consent and privacy validation;
live-executed organic evidence requires actual production execution. Reconciliation
identities are fail-closed.

## Where each gate lives (Muse mapping)

| Concern | Muse gate |
|---|---|
| Tool selection + args + irrelevance | `pnpm eval:tools` |
| Terminal-state / trajectory (deterministic) | `*-terminal-state.test.ts`, `*-trajectory.test.ts` (agent-core) |
| Plan quality (valid∧complete∧ordered∧efficient) | `pnpm eval:plan-quality` |
| LLM-judge + its meta-eval | `pnpm eval:judge` |
| Must-refuse + over-refusal controls | `pnpm eval:adversarial` |
| Memory/playbook promotion (report-only) | `pnpm eval:shadow-trial` |
| Self-improving LLM paths (one gate) | `pnpm eval:self-improving` |
| All harness batteries as one local/self-hosted aggregate | `pnpm eval:agent` |
| Real-LLM request/response round-trip | `pnpm smoke:live` |
| Regression scoreboard | `pnpm self-eval` |

**Anti-patterns (reject on sight):** skip-as-pass; vacuous stub (confirm
with MUTATION-RED); floor instead of ratchet (fail close on a DROP, not
just clearing a floor); counting code artifacts as agent signal;
`pass@k` reported as reliability; trajectory pinning over terminal-state
grading; same-family judge over-trust. Full rationale: the strategy doc.

Method and sources in full — the evidence behind every rule above, the named
anti-patterns, the multi-agent seam breakdown, and the reflection-schedule guard's
calibration data: [`ai-agent-testing-strategy.md`](../../../docs/development/ai-agent-testing-strategy.md).
