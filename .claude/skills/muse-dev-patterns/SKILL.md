---
name: muse-dev-patterns
description: The distilled per-slice engineering discipline of the Muse repo — how to triage a failing gate, probe the live path, prove a test isn't vacuous, calibrate a constant from measurement, and land a slice with the right writeback. Use this whenever working on Muse code — especially when a gate/test/battery fails and you must decide "my bug, stale expectation, or pre-existing rot?", when adding or tuning any threshold constant, when writing a test for a fix, when creating a live eval battery, or when landing/committing a slice. Also use it when a claim like "X works" needs verification — it says which proof is the cheapest sufficient one.
---

# muse-dev-patterns — the recurring slice discipline

Distilled from real failures, the backlog's dedup ledger, and live sessions.
Use this as the bounded maintenance flow for existing behavior and as the HOW
for product slices — without creating another selection loop or artifact tree.

## 1. When a gate/test fails: triage BEFORE fixing

A red gate has exactly three causes. Fixing before classifying produces the
worst class of bug — "fixing" the assertion when the product regressed, or
"fixing" the product when the assertion went stale.

1. **Reproduce and read the determinism.** Run the failing case k=3–5
   times. `0/5 with the identical wrong output` is STRUCTURAL (something in
   the path changed); `3/5` is stochastic (model variance, load, race).
   Structural failures deserve root-cause; stochastic ones deserve
   `MUSE_EVAL_REPEAT` and a look at thresholds/timeouts.
2. **Is it pre-existing? Prove it without touching the owner's worktree.**
   Reproduce on a fresh disposable worktree at the base HEAD. Never stash,
   reset, or rewrite another session's dirty changes to obtain a clean state.
   If it fails there, it is base-branch rot, not your change; keep it out of
   the current slice unless it blocks acceptance.
3. **Date the flip.** `git log --format='%ci %h %s' -S '<changed token>' --
   <file>` finds WHEN the behavior changed and WHICH commit did it. Read
   that commit's intent before touching anything.
4. **Classify: bug vs stale expectation.** If the flip commit was a
   DELIBERATE product improvement, the assertion is what's stale — update
   the expectation and say so in the commit body. Real case: the smoke
   NATURAL tool-selection case asked for Seoul's weekday, then a deliberate
   change put the Seoul wall-clock+weekday into `[Active Context]` — the
   model answering without the tool became CORRECT behavior, and the right
   fix was pointing the case at a fact outside the injected context (Los
   Angeles, across the date line), not prompt-tweaking the model back into
   a now-redundant tool call.

## 2. Probe the real path — never argue from code you can boot

When behavior is in question, the cheapest decisive evidence is a live
probe, not code reading. The repo's standing pattern:

- Put the ONE failing-case probe in an OS temporary directory created with
  `mktemp -d`, clean it when the probe ends, and boot the API server with
  temp stores, a diagnostic or local model, a free port, and a `/health`
  wait. Never create repo-root `scratchpad/`, `harness/`, or other ad-hoc
  artifact directories.
  A full battery re-run costs 6–8 min; a single-case probe costs 30–60 s
  per trial and gives per-trial visibility.
- A/B attribution: flip ONE variable per arm (a prompt layer, a constant,
  a commit) and re-probe. If you can't cheaply flip it in-process, measure
  the competing hypothesis instead (e.g., ask a question the suspected
  context CAN'T answer — if the tool fires there, the "model got lazy"
  hypothesis is dead).
- Trust `smoke:live` / `eval:*` output over reasoning about what the code
  "should" do — but only if the gate actually RAN (see §6).

## 3. Tests: narrowest rung, mutation-RED, outcome-graded

- Per edit run `pnpm test:changed` (vitest `related`), not a package suite.
  Escalate only to the single rung that exposes YOUR change
  (`../../rules/verification/testing.md` has the ladder).
- **Mutation-RED or it proves nothing.** After writing the test, revert the
  fix (or inject the inverse mutation) and confirm the test goes RED, then
  restore. A test that passes with the fix removed is vacuous — the loop
  journals log this check on every fire (`RED → GREEN` / "뮤테이션 RED
  확인" [mutation RED confirmed]), and evaluator judges have repeatedly caught tests that skipped it.
  When the RED direction is deterministic by construction (the assertion
  literally names the value the mutation flips), reasoning it through is
  acceptable — say so explicitly instead of claiming a run.
- Grade OUTCOMES (terminal state, store contents, final answer), not the
  exact tool path; assert order only where a step truly depends on a prior
  one (`../../rules/verification/agent-testing.md`).
- A failed/denied/invalid action asserts an UNCHANGED store — no partial
  side-effects.

## 4. Constants: never pin a threshold to one side

Any floor/ceiling/limit (similarity floors, retry limits, caps) follows the
**separation-invariant** pattern:

1. MEASURE the two populations the constant must separate, on the real
   path (real embedder / real model / real store) with realistic KO **and**
   EN phrasings — synthetic fixtures (orthogonal/identical vectors) prove
   wiring, never calibration.
2. Place the constant strictly BETWEEN the bands **with margin on both
   sides**. A value touching either band is one phrasing/model drift from
   misclassifying (a live case: a paraphrase measured exactly 0.300 against
   a 0.3 floor — zero margin — and a "0.4" floor sat INSIDE the genuine
   agreement band, encoding false-drops as intended behavior).
3. Pin BOTH directions in the permanent battery: `min(want-keep) > floor`
   AND `max(want-drop) < floor`, plus the e2e keep/drop outcomes. Report
   measured values in the battery output so the next re-calibration has
   data.
4. Write the measured bands into the constant's WHY comment. "Tuned later"
   comments rot; measurements don't.

**A constant set from a plausible-sounding prior is a bug waiting to be
found — and priors travel in families.** A single measurement session
invalidated FIVE council constants that all rested on one unexamined belief
("semantically agreeing texts score cosine 0.6+"). The truth was the
opposite of the design: a value difference LOWERS the embedding cosine
because the embedding encodes the value, so a same-topic *disagreeing* peer
outscores a genuinely *agreeing* cross-lingual one. Consequences ranged from
dead code (a consensus gate whose bar sat above the entire agreement band —
it had never once fired) to inverted user-facing behaviour (a conflict
detector that flagged agreeing sources and missed real conflicts; a dissent
surfacer that published noise and silenced the minority view). **When you
find one miscalibrated threshold, grep for its siblings and measure them
all** — the same false prior almost certainly set them too. And check what
the signal actually measures: prose cosine answers "same subject", not "same
answer"; if you need the latter, compose a second signal that can decide it.

## 5. Live batteries (eval:*) — the house style

- LOCAL OLLAMA ONLY; unreachable ⇒ skip with exit 0 AND print "a skip is
  not a pass". Never let a battery require a cloud key.
- Deterministic paths (embeddings, pure gates) need one pass; stochastic
  paths (generation, tool selection) need `MUSE_EVAL_REPEAT` pass^k — k=3
  minimum for a new case (STABLE 3/3 before landing it).
- Import the PRODUCTION functions from `dist/` — a battery that reimplements
  the gate measures the reimplementation.
- Wire the new battery into its bundle (`eval:agent` / `eval:self-improving`)
  and add a `package.json` script; an unbundled battery rots.

## 6. Gates only tell the truth when they run

The most expensive failure class found in practice is not a wrong gate but
an UNRUN one: a dep added without `pnpm install`, a package's `dist/` gone
stale, a doc-drift checker nobody invoked — each silently disables the very
gate that would have caught the next regression.

- Before trusting "the battery was green last week", check the gate can
  still BOOT today (`pnpm check:api-boot` covers the API-server-based ones;
  `pnpm self-eval` runs the cheap deterministic set and the scoreboard
  fails closed on any drop).
- If you hit `ERR_MODULE_NOT_FOUND` on a workspace package → `pnpm install`.
  `does not provide an export named` → stale dist, `pnpm --filter <pkg>
  build` (tsc -b rebuilds stale upstream).
- After changing anything in the request/response path, run `smoke:live`
  yourself — the rule exists because three separate rots (stale install,
  stale dist, stale case) accumulated in two days of it not being run.

## 7. Independent judgment (maker ≠ judge)

- For a substantive slice, the builder does not grade their own work: spawn
  an independent evaluator (independent-evaluator subagent, or at minimum a
  fresh-context review of the diff + test evidence) before calling it done.
  **This is not ceremony.** In one session an evaluator failed 4/4 slices that
  had ALL shipped with green suites and a green live battery — including a
  zero-click security hole that defeated the gate it had just built (a
  "first-party" reader whose corpus secretly included Gmail), and a
  user-visible false "panel agreed" on a maximally disagreeing panel. A green
  battery means "green on the edges it covers"; the evaluator's job is to
  find the edges you did not think of, so give it the adversarial framing
  explicitly ("find an input where this is wrong") and a concrete list of
  invariants to attack.
- A FAIL verdict must name a concrete violation (which invariant, which
  input, what wrong output). A vague "seems off" is not grounds to rework;
  an unexplained PASS on safety-critical work is not grounds to ship.
- Multi-agent worker output is DATA until validated at the seam — parse it
  against the expected shape, spot-check a sample against the actual files,
  and reject rewordings that changed meaning (a live case: a comment
  reworder turned "this USED to run 16 sequential calls" into "this RUNS 16
  sequential calls" — present-tense false; the judge pass caught it).

## 8. Landing a slice

- **Commit body carries the verification evidence**: what was measured/run
  and its numbers ("battery 13/13 live; agent-core 3124/3124; probe 5/5"),
  plus the WHY of any expectation change. Conventional Commits, one
  coherent goal per commit, then the allowlisted verified normal push under the
  standing authorization (`../../rules/engineering/commits.md`).
- **Writeback**: when a slice resolves a backlog/journal entry, update THAT
  entry in place (✓ + commit hash + one-line resolution). Respect the
  ledger's "재제안 금지 / do NOT re-scout" markers — re-proposing a closed
  item wastes a future fire. When you discover the backlog is STALE (the
  code already shipped what an entry asks for), the writeback IS the slice.
- **Honest defer**: an item that turns out mis-scoped, blocked, or
  low-value-per-risk gets an explicit defer note (what was found, why
  deferred, what unblocks it) — never a silent drop, never a forced
  marginal ship. A stale 1.5-month branch with conflicts is retired with a
  salvage note, not force-merged.

## Quick reference — cheapest sufficient proof

| Claim | Proof |
|---|---|
| "this function is correct" | narrowest unit test + mutation-RED |
| "the agent picks this tool" | `eval:tools` case, STABLE 3/3 |
| "this constant is right" | measured separation bands + live battery pin |
| "the request path still works" | `smoke:live` (not `smoke:broad`) |
| "the gate itself is alive" | `self-eval` / `check:api-boot` |
| "nothing else broke" | `pnpm test:changed` (per edit) |
| "the slice is done" | independent evaluator PASS + commit evidence |
