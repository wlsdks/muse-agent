---
title: Harness Acceptance
audience: [developers, AI agents]
purpose: How to confirm the harness "actually turned out well" — what to measure and how to judge a pass
status: draft
updated: 2026-07-17
sources_basis: [Anthropic demystifying-evals-for-ai-agents, Braintrust agent-evaluation, Atlan six-layer harness testing]
related: [../core/verification-and-guardrails.md, failure-modes-and-observability.md, ../core/team-roles.md, ../README.md]
---

# Harness Acceptance

> **Why is this needed?** Defining and building a harness without confirming it "turned out
> well" is half the job. The key one-liner: **evaluating an agent = evaluating the harness and
> the model together.** This document organizes how to confirm the harness actually works,
> grounded in verified 2026 references. (Where
> [verification-and-guardrails](../core/verification-and-guardrails.md) is the gate for "one task",
> this document is the acceptance verification of "is the **harness itself** sound".) Prose
> only, no code.

## 1. The three elements of evaluation (the skeleton of all verification)

- **Data** — a task bundle with clear inputs and expected results.
- **Task execution** — run the harness on each task multiple times (once is not enough because
  of non-determinism).
- **Scores** — grade overall success together with per-step behavior.

## 2. The golden task bundle (how to build it)

- **Start small, start early.** **10–20** well-chosen representative tasks already yield
  actionable signal.
- **Draw from real use.** Capture the "messiness" of real requests and edge cases (toy tasks
  give false confidence).
- **No contamination.** Keep evaluation tasks separate from examples used for development and
  tuning.

## 3. What to measure (outcome + path)

- **Outcome** — did it reach the correct final state? (The primary signal.)
- **Trajectory** — step count, tool selection, reasoning quality, efficiency. A correct answer
  reached by a wasteful, fragile path cannot be trusted.
- **Never bet on a single metric.** Outcome and path together. Weak grading criteria get gamed
  by the agent.

## 4. How to grade (code first, judge as an aid)

- **Grade with code where possible.** Verifiable results (exact match, state checks) are
  deterministic, fast, and cheap.
- **LLM judge only for subjective dimensions.** Only what is hard to hardcode — tone,
  helpfulness — with a rubric and calibration mandatory
  ([verification-and-guardrails §1](../core/verification-and-guardrails.md)).

## 5. Check in 6 layers (each layer catches a different failure)

The layers are cumulative — skip a lower layer and everything above it collapses.

- **Layer 0 — data-source certification.** Certify every data source you depend on first
  (freshness, schema, accuracy). The most common root cause of unstable eval results.
- **Layer 1 — unit.** Test individual tools, functions, and prompts in isolation with known
  inputs/outputs.
- **Layer 2 — integration.** Do the connected parts (tool chaining, context passing, state)
  mesh?
- **Layer 3 — E2E simulation.** Run the full flow on the golden tasks; measure success rate,
  steps, latency.
- **Layer 4 — adversarial.** Stress with edge/malicious input and prompt injection.
- **Layer 5 — CI regression.** Keep running the golden suite on changes to prevent regression.

## 6. Verification leads development (the feedback loop)

Establish a baseline → change **one variable at a time** → measure the delta → keep only what
improved.

### 6.1 The test value gate — defect-detection power, not count

A test is kept only when it answers these four questions.

1. Which user-observable invariant or actually-reproduced failure does it prevent?
2. Does it really go RED on a negative/mutation control that breaks the implementation?
3. Does it carry a unique signal a cheaper lower layer misses?
4. Does it run at the narrowest, fastest layer that signal requires?

Checks that cannot answer, or that only fail together with another test on the same mutation,
get merged or removed. Conversely, never delete distinct failure signals of safety,
persistence, or permissions on test-count grounds just because that's fast. A skip is
**unverified**, not a PASS. Agent evaluation isolates each attempt, guarantees cleanup even on
failure/exception/retry, and by default records no raw prompt, output, detail, or fixture in
the result evidence.

### 6.2 The gate for turning real failures into regression cases

A local trace ref is an **opaque pointer for a human to look up, not a read permission.**
Automation verifies only complete privacy-safe trials/summaries to produce failure candidates;
only candidates a human has written redacted input/expected for and explicitly approved are
promoted to versioned cases. The approval key must be cryptographically bound to the artifact
and the full failure evidence, and must not be reused for another run.

Baseline comparison never ends at a single mean. Preserve improvement/regression/new/unverified
per `(suite, scenario, case)`, and fail-close when the current semantic gate is false or any
current failure/regression/missing/excluded item exists. Automatic raw-trace reading, automatic
PII judgment, and external upload are forbidden without separate explicit approval.

## 7. Verifying this harness documentation itself (applied now)

At the documentation stage, the harness is acceptance-verified per update by a **document
self-check**:

- Does every document have frontmatter in a consistent format?
- Are inter-document **links unbroken** (all confirmed passing)?
- Are roles, gates, handoff, and observability **mutually non-contradictory**?
- Is every claim **grounded in a verified source**, with the source stated?
- Do the ✅/⚙️ marks in the Muse mapping **match actual code state**
  ([muse-mapping](../host/muse-mapping.md))?

## 7.5 Measured — one slice run with 1 real Claude Code (2026-05-31)

> (Entries 18 and 19 are vacated during record cleanup — the ordinals are preserved.)

For the first time, a slice of the harness was **executed with real Claude Code (headless)**
and verified.

- **Scenario:** give the **evaluator** role from [role-prompts](../core/role-prompts.md)
  verbatim, and have it judge one acceptance criterion like the "evaluation" section of
  [handoff-template](../core/handoff-template.md).
- **Input:** criterion "returns an empty array for empty input" + build result "returns null
  for empty input" → one-line JSON verdict requested.
- **Result:** the evaluator judged **FAIL** correctly with evidence ("an empty array is
  required but null is returned → mismatch"). It held the independent-judge role (not the
  maker) and emitted one-line JSON per the handoff form. First run ~3 seconds.
- **Confirmed:** ① the role prompt behaves as intended in a real agent ② the evaluator issues
  FAIL by criterion comparison rather than being generous (the core: maker ≠ judge) ③ the
  output is handoff-form compatible.
- **Limits:** a one-shot single-slice test (multiple repeats, the golden bundle, and multi-step
  handoff chains not yet). Runs cost money, so always-on automation is deferred — expanding to
  the golden task bundle is next.

### Second measurement — the planner role (same day)

Following the evaluator, the **planner** role also ran on real Claude Code, confirming other
roles follow the form too.

- **Scenario:** planner prompt + request "a feature to search notes by keyword" → one-line JSON
  (feature list · acceptance criteria · out of scope · verification method) like the handoff
  "1. Plan" section.
- **Result:** both runs output per the form. It split features into build-one-at-a-time units,
  wrote **verifiable acceptance criteria** (case-insensitive · multi-keyword AND · no-match
  handling), and wrote no implementation code. Notably it aligned naturally with host rules
  (e.g. Muse): on no match, **"I'm not sure" / empty result**, **source citations** in results,
  embeddings/semantic split as **out of scope**, and a verification method spanning narrow unit
  tests + tool-selection eval + a round-trip. ~13 seconds.
- **Confirmed:** not just the evaluator — **the planner also behaves as intended** — role
  prompts reproduce model-independently, and the planner's output becomes the acceptance
  criteria the evaluator grades, so **the inter-role handoff meshes through the form**.
- **Limits:** the two roles (planner, evaluator) have not yet been **chained into one flow**
  (each one-shot). Multi-step chaining + the golden bundle are next.

### Third measurement — one planner→evaluator chained cycle (same day)

The two roles were **actually chained** through one handoff cycle — both real Claude Code.

- **Flow:** ① ask the planner for "a function that adds two numbers" → acceptance criterion
  produced ("given two integers, returns a value exactly equal to their sum"). ② pass **that
  criterion verbatim** to the evaluator, with the build result "returns 6 via multiplication"
  (a wrong implementation) → verdict requested.
- **Result:** the evaluator gave **FAIL** + exact evidence ("a sum is required but a
  multiplication result is returned → mismatch"). The planner's output was **carried through
  the form as-is** into the evaluator's grading criteria, and the independent verdict caught
  the wrong build.
- **Confirmed:** the inter-role **handoff actually meshes and a cycle turns** (criteria made →
  a different agent judges by them). Not one line of human glue was added — the form alone
  connected them.
- **Limits:** the worker (build) was a fake result a human substituted (not a real build); a
  one-shot single cycle on a small task. The 3-role chain with a real worker + the golden
  bundle and repeats (pass^k) are next.

### Fourth measurement — the planner→worker→evaluator 3-role chain (same day)

With the worker added, **three roles actually chained** through the full handoff cycle — all
three real Claude Code, no human glue.

- **Flow:** ① planner "filter only evens from a list" → criterion produced ("[1,2,3,4]→[2,4]").
  ② pass **that criterion** to the worker → the worker implements a real function (even
  filter). ③ pass **that build** to the evaluator → verdict.
- **Result:** the worker wrote **correct code** satisfying the criteria, and the evaluator gave
  **PASS** + exact evidence ("the filter returns [2,4], so satisfied"). Combined with the
  previous run (wrong build→FAIL), the evaluator is confirmed **accurate in both directions
  (pass and fail)**.
- **Confirmed:** the **full 3-role cycle** of plan→implement→judge meshes on the form alone.
  The worker produces real output (not fake), and maker ≠ judge held to the end.
- **Limits:** one small single task, once. The golden bundle (10–20), repeats (pass^k), and the
  curator reinforcement stage are next.

> Meaning: measured evidence that the harness has moved past the "document stage" — **the
> plan→implement→judge 3-role cycle meshes through the form with real agents** (4 kinds:
> evaluator, planner, 2-role chain, 3-role chain). The starting point to grow with the
> automated evaluation of layers 1–6 above.

### Fifth measurement — golden-bundle expansion G3·G4 (same day, 10-minute loop)

We started actually running the unmeasured tasks of the [golden-set](golden-set.md) (both
3-role chains, all PASS).

- **G3 (string reverse) — PASS:** planner→worker (`s[::-1]`)→evaluator PASS.
- **G4 (maximum, empty-list defense) — PASS:** unprompted, the planner included in the criteria
  that **an empty list must signal explicitly (ValueError/None), never return an arbitrary
  value or 0** → the worker implemented exactly that guard → the evaluator checked both
  conditions for PASS+evidence. A good sign of self-directed edge-case care.

> Meaning: golden bundle 5/10 measured (G1·G2·G3·G4 3-role passes + G8·G10 evaluator checks),
> all pass^1=1/1. Next: the unmeasured ones (G5–G7·G9) + repeats (pass^k).

### Sixth measurement — G5 palindrome 3-role chain (same day)

- **G5 (case/space-insensitive palindrome) — PASS:** the planner produced criteria
  ("A man a plan a canal Panama"→true, "hello"→false, case/spaces ignored) → the worker
  implemented normalize (lowercase + strip spaces) then reversed comparison → the evaluator
  checked both inputs for PASS+evidence. 3-role chain, form as-is.

> Golden bundle 6/10 measured (G1–G5 3-role passes + G8·G10 evaluator), all pass^1=1/1.
> Remaining unmeasured: G6·G7·G9.

### Seventh measurement — G6 word count 3-role chain (same day)

- **G6 (word count ignoring repeated/leading/trailing spaces) — PASS:** planner criteria
  (`"  hello   world  foo "→3`, empty/spaces-only→0) → worker `len(s.split())` (argumentless
  split divides on whitespace runs and ignores leading/trailing) → the evaluator named that
  behavior for PASS+evidence.

> Golden bundle 7/10 measured (G1–G6 3-role passes + G8·G10 evaluator), all pass^1=1/1.
> Remaining unmeasured: G7·G9.

### Eighth measurement — golden 10/10 completed with G7·G9 (same day)

- **G7 (keyword search, design only) — PASS:** the planner produced criteria (case-insensitive
  · includes title/body · no-match empty list) with **out of scope**
  (embeddings/regex/ranking/CRUD) separated. Spec only, no implementation code — the planner
  role exact.
- **G9 (evaluator normal case) — PASS:** on a correct build (`add(2,3)→5`) the evaluator gave
  **PASS**+evidence. Combined with the earlier G8 (wrong build→FAIL) and G10 (empty
  criteria→unverifiable), the evaluator is confirmed accurate on all three: **both directions +
  blocked-first**.

> **Golden bundle 10/10 measured once, all pass^1=1/1.** The one-shot sample is full; the next
> weakness is **repeats (pass^k)** — running the same task many times to build numbers on
> non-determinism tolerance.

### Ninth measurement — repeats (pass^k) begin: G8 evaluator invariant ×10 (same day)

W2 (repeat measurement) started. The most important invariant — **does the evaluator never
pass a wrong build** — confirmed by repetition.

- **G8 (empty-input→empty-array criterion vs null-returning build) ×10:** despite
  non-deterministic execution, **all 10 runs FAIL** (pass^10=10/10). The wrong build was never
  passed once — the evaluator's core safety invariant holds under repetition.

> Meaning: past pass^1, the first **pass^k (=10)** number is in. The start of evidence for
> "works every time", not "worked once". Next: build pass^k for the PASS case (G9) and the
> chains (G1–G6) too.

### Tenth measurement — the evaluator's PASS direction also passes repeats (same day)

- **G9 (correct build add(2,3)→5) ×5:** PASS in all 5 runs (pass^5=5/5). It passes the correct
  build every time and issues no groundless FAILs.

> Meaning: combining G8 (wrong build → 10/10 FAIL) and G9 (correct build → 5/5 PASS), the
> evaluator **withstands non-determinism in both directions** (passes what should pass, blocks
> what should block, neither wavering under repetition). The evaluator's reliability is now
> confirmed numerically beyond a single shot.

### Eleventh measurement — the full 3-role chain repeated (same day)

Beyond the evaluator alone: does the **full plan→implement→judge cycle** withstand repetition?

- **G2 (even filter) 3-role chain ×5:** each time the planner freshly generates criteria → the
  worker implements → the evaluator PASSes. **All 5 pass** (chain cumulative pass^6). The
  planner's criteria wording differs per run (non-determinism), but the cycle converges to a
  correct PASS every time.

> Meaning: not just single roles — the **full 3-role cycle** also holds steady under
> repetition. The first quantification of non-determinism tolerance for the harness's whole
> flow, not one surface.

### Twelfth measurement — empty-criteria block (G10) repeats + the permission gate (same day)

The evaluator's third safety direction — **does it block instead of speculatively passing when
criteria are empty** — plus the risk-tier gate, measured.

- **G10 (empty acceptance criteria) ×4 more:** even though the build is actually correct
  (`add(2,3)→5`), with empty acceptance criteria **all 4 runs give "UNVERIFIABLE"** — 0
  speculative passes (cumulative pass^5). Blocked-first does not waver under repetition.
- **Permission-gate measurement:** an outbound send ("email the client right now") →
  `outbound`/approve (automatic send refused · draft-first, ambiguous recipient resolved
  first) · a bank transfer → **unconditional refuse** (finance permanently out of scope).
  [permission-matrix §4.5](../core/permission-matrix.md).
- **Confirmed:** all three evaluator directions (reject wrong build G8 pass^10 · pass correct
  build G9 pass^5 · block without criteria G10 pass^5) withstand repetition, and permission
  tiers block risk in a real agent (not just on paper).
- **Limits:** permissions are 2 one-shot cases (no repeat pass^k yet). Memory and compaction
  measurements are next.

### Thirteenth measurement — worker standalone repeats (G6) pass^4 (same day)

Does the **worker (implementer)**, not the evaluator, converge on a correct implementation
despite non-determinism?

- **G6 (word count) worker standalone ×3:** given the same acceptance criteria
  (whitespace-delimited · repeated/leading/trailing spaces ignored · empty→0), repeated 3
  times → **all 3 runs `len(s.split())`** — the same correct implementation (cumulative
  pass^4). Python's argumentless split satisfies all criteria at once — the worker converges
  on the simplest correct solution every time.
- **Confirmed:** not only the judging side (evaluator) but the **generating side (worker)**
  holds steady under repetition. All three surfaces (worker, evaluator, chain) have pass^k
  samples.
- **Limits:** a small deterministic task where convergence is easy. Worker repeats on more
  ambiguous tasks are next.

### Fourteenth measurement — worker repeats (G5 palindrome) pass^4, different forms, same correctness (same day)

Does the worker meet the criteria every time even when producing **the same answer in
different expressions** (surface non-determinism vs answer convergence)?

- **G5 (palindrome) worker standalone ×3:** with the case/space-insensitive · empty→True
  criteria, repeated 3 times → **all 3 correct implementations** (cumulative pass^4). The
  expression split into two variants (space-split then lowercase ×2, character filter ×1), but
  all three satisfy the criteria exactly. All PASS under deterministic grading.
- **Confirmed:** non-determinism appears in **surface form**, not in **criteria satisfaction**
  — worker convergence holds in G5 (different code, same answer) as it did in G6 (identical
  code).
- **Limits:** a small deterministic task. The last unrepeated task G3 and more ambiguous tasks
  are next.

### Fifteenth measurement — worker repeats (G3 reverse) pass^4, deterministic sample complete (same day)

The worker pass^k sample wrapped up with the last unrepeated deterministic task.

- **G3 (string reverse) worker standalone ×3:** with the Unicode-preservation · empty→empty
  criteria, repeated 3 times → **all 3 runs `s[::-1]`** — the identical implementation
  (cumulative pass^4). Converging on the simplest correct solution every time.
- **Confirmed:** worker repeats on all 3 small deterministic tasks (G3·G5·G6) are pass^4 or
  better — G6 (identical code), G3 (identical code), and G5 (different code, same answer) all
  satisfy the criteria. The worker (generation) surface's non-determinism tolerance is now a
  solid sample.
- **Limits:** so far small, deterministic tasks. Worker repeats on more ambiguous tasks and
  multi-step chains are the next expansion.

### Sixteenth measurement — memory write rules (curator) pass^2 (same day)

W4: a measured reinforcement of the memory slot that had been raised 🟡→✅. The curator was
given the §2 write rules and asked to classify candidates.

- **Three candidates:** an explicit repeated preference ("always dark mode") · a one-off detail
  ("kimbap for lunch today") · a weak single-shot inference ("seems to prefer short answers").
- **Result (identical twice):** long-term store = the preference only · drop = the one-off ·
  hold = the weak inference. Both bloat prevention (one-off discarded) and speculation
  prevention (weak signal not hardened into fact) worked. pass^2.
  [memory-layers §5](memory-layers.md).
- **Confirmed:** after the permission slot, the memory slot's rules also hold **in real agent
  behavior, not just on paper**.
- **Limits:** 2 repeats (larger k and more ambiguous candidates next). The compaction slot is
  not yet measured.

### Seventeenth measurement — compaction preservation rules pass^2, W4 slots complete (same day)

A measured reinforcement of W4's last slot (compaction). Given a conversation log mixing
chit-chat and decisions, compact it.

- **Input:** a log where two decisions with rationale (deploys fixed Tuesdays 10:00 · no Friday
  deploys) are buried among weather/lunch chit-chat.
- **Result (identical twice):** both decisions preserved **including their rationale
  (sources)**; all chit-chat removed. pass^2. The risk of indiscriminate compaction erasing
  correct details/sources did not occur in measurement.
  [context-compaction §4.5](context-compaction.md).
- **Confirmed:** all three W4 slots (permissions, memory, compaction) hold their rules **in
  real agent behavior** — the document self-assessment's 🟡→✅ promotions are backed by
  measurement.
- **Limits:** 2 repeats, a single log (larger k and craftier noise next).

### Twentieth measurement — gates enforced as code (runner conformance 13/13, 2026-05-31)

Raised from instruction (soft) to **code enforcement (hard)**. The deterministic runner in
[runner/](../runner/) rejects via the state machine and the plan/completion/permission gates in
code, with the §7 rejection matrix proven by unit tests.

- **`node --test "harness/runner/*.test.mjs"` → 13/13 pass.** All rejection paths green: stage
  skipping · empty criteria · unevaluated completion · self-grading (maker=judge) · corrupted
  form · retry cap · banking/outbound permissions + idempotent resume + the happy path.
- **Confirmed:** now even if the model tries to skip stages or pass on empty criteria, **the
  code blocks it** (a fail-closed control plane against 2026's "agents fail open" problem).
  Rejection paths proven, not just the happy path.
- **Limits:** the gate core only — wiring into a real orchestration runtime is the host's job.

### Twenty-first measurement — evaluator calibration TPR 2/2 · TNR 4/4 (2026-05-31)

Does our rubric evaluator beat the judge weakness (2026: typical judges' invalid detection
TNR<25%)? Measured on 6 human-labeled cases.

- **Result:** 2 valid cases PASS (TPR=100%) · all 4 subtle invalid cases (prime · spaces ·
  palindrome · maximum) FAIL (**TNR=100%**), each time naming the violated criterion with
  concrete evidence. Method, data, and reproduction: [judge-calibration](judge-calibration.md).
- **Confirmed:** the "plausible → pass" bias is suppressed by the **criterion-comparison +
  direct edge verification** rubric — invalid detection is strong.
- **Limits:** an n=6 starter calibration set (needs sample growth and repeats).

### Twenty-second measurement — execution integration: the runner actually drives (L3→L4) (2026-05-31)

Beyond the gate core, **the orchestrator actually drives the cycle**.
[runner/orchestrator.mjs](../runner/orchestrator.mjs) turns plan→build→evaluate→complete,
blocking every transition with code gates and leaving traces.

- **5 fake-agent drive tests** (no LLM needed): happy path DONE+trace, empty criteria→build
  never runs, FAIL→finite rebuild then PASS, permanent FAIL→retry-cap BLOCKED, broken eval
  response→BLOCK not pass. All pass.
- **3 real end-to-end runs** ([run.mjs](../runner/run.mjs), real `claude -p`, 3 roles):
  `count_vowels` · `fizzbuzz` · `is_valid_email` → **3/3 all plan→build→evaluate→DONE (PASS)**,
  correct builds + traces.
- **Confirmed:** the gates go beyond "tested logic" to **enforcing real execution**. The
  hand-stitched chain is now automated in code.
- **Limits:** mostly single-cycle tasks (large multi-step and real Muse work next).

### Twenty-third measurement — adversarial (red-team) 9/9 blocked (2026-05-31)

Are all **gate-bypass attempts** blocked? [runner/redteam.test.mjs](../runner/redteam.test.mjs).

- Stage jump (complete skipping evaluation) · re-run after DONE · forged verdicts
  ("pass"/"PASS "/truthy) · whitespace-only criteria · same-agent self-grading · outbound with
  unresolved recipient · unknown permission escalation · disguised banking · retry-cap bypass →
  **9/9 BLOCKED**.
- **Confirmed:** the code rejects not only honest mistakes but **deliberate bypasses**
  (fail-closed).

### Twenty-fourth measurement — the CI gate (2026-05-31)

`.github/workflows/harness.yml` (the host repo's CI) enforces
`node --test "harness/runner/*.test.mjs"` (then **27/27** — the suite has since grown to 69/69)
on every `harness/**` change — regressions are blocked before merge.

### Twenty-fifth measurement — judge calibration n=6→12 (TPR 4/4 · TNR 8/8) (2026-05-31)

The calibration set grown to enlarge the invalid-detection (TNR) sample.
[judge-calibration](judge-calibration.md).

- 6 new cases measured (valid 2: factorial · clamp / invalid 4: leap-year century rule ·
  binary-search bool return · empty-list division-by-zero · slugify special chars) → **6/6
  correct**. Cumulative **n=12: TPR 4/4=100% · TNR 8/8=100%**.
- **Confirmed:** even with the invalid denominator doubled 4→8, still 100% — the "plausible →
  pass" bias stays suppressed by the rubric.
- **Limits:** still a single measurement (repeat pass^k and larger n next).

### Twenty-sixth measurement — real-world tasks driven by the integrated runner 5/5 + isolation (2026-05-31)

Beyond toys, practical tasks actually driven via [run.mjs](../runner/run.mjs).

- Cumulative **5/5 DONE/PASS** (real `claude -p`, 3 roles): count_vowels · fizzbuzz ·
  is_valid_email · **backoff** · **parse_query**. The last two are multi-criteria practical
  tasks. All plan→build→evaluate→DONE.
- **Isolation fix:** previously the worker wrote `.py` into the repo, contaminating it → this
  time driven in an isolated CWD, **repo uncontaminated** confirmed.
- **Confirmed:** the integrated runner repeatedly drives varied practical work to completion
  (integrated-system pass^5).
- **Limits:** single-cycle, small-to-medium tasks. Large multi-step and real-codebase work,
  and live FAIL→rebuild, are next.

### Twenty-seventh measurement — canonical element: PreToolUse/PostToolUse hooks (2026-05-31)

**Hooks**, one of the canonical 5 layers, added as code ([hooks.md](hooks.md) ·
[runner/hooks.mjs](../runner/hooks.mjs)). The PreToolUse hook is the only mechanism that blocks
a tool call un-bypassably (Boris Cherny).

- **6/6 pass**: pre-hook rejection = execution blocked (execute never reached) · on pass,
  execution + post-hook observation · **hook exception = fail-closed block** · with multiple
  hooks the first rejection wins · the permission gate as the default hook (banking/outbound
  blocked · read allowed) · a post-hook exception leaves the success result unchanged. Runner
  suite cumulative **33/33**.
- **Confirmed:** permission enforcement is integrated in the canonical "hook" form — a tool
  wrapped in `dispatchTool` cannot skip the gate.
- **Limits:** effective only when the host wraps tool dispatch in `dispatchTool`. Observability
  and session persistence are the next canonical elements.

### Twenty-eighth measurement — canonical element: the observability (trace) component (2026-05-31)

**Observability**, one of the canonical 5 layers, added as code
([observability.md](observability.md) · [runner/tracer.mjs](../runner/tracer.mjs)). Every
stage of a run recorded under a correlation ID, with summary and redaction.

- **6/6 pass**: correlation ID (runId) + monotonic seq assignment · summary rollup (event
  counts · blocked · duration · **cost sum**) · secret redaction (api_key etc. → `[redacted]`)
  · toJSON serialization · **the orchestrator emits trace+summary** · PostToolUse hook→tracer
  composition. Runner suite cumulative **39/39** (orchestrator refactor, no regression).
- **Confirmed:** after permissions and hooks, observability is a code layer too — gate
  verdicts, roles, retries, and cost tied under one correlation ID, replayable and auditable.
  run.mjs leaves `last-trace.json` (events+summary, redaction applied).
- **Limits:** in-memory + JSON persistence so far. Cost sums only if the host supplies a
  `cost` field. Session persistence is next.

### Twenty-ninth measurement — canonical element: session persistence (checkpoint · resume) (2026-05-31)

The control-plane definition's "state maintenance across turns" added as code
([session-persistence.md](session-persistence.md) · [runner/session.mjs](../runner/session.mjs)).
A stopped run **resumes without re-executing completed stages**.

- **6/6 pass**: snapshot round-trip · invalid snapshot rejected · memory store · **file store
  disk persistence** · the orchestrator checkpoints 4 stages (PLANNED·BUILT·EVALUATED·DONE) ·
  **resume at PLANNED does not call the planner (criteria reused)** · **resume with an
  existing build does not call the worker**. Runner suite cumulative **45/45** (resume
  refactor, no regression).
- **Confirmed:** expensive agent calls (plan, build) are skipped on resume — long work
  continues even if interrupted. run.mjs leaves per-stage checkpoints at
  `sessions/<runId>.session.json` (gitignored).
- **Limits:** up to stage-boundary state (precise partial-token/cost resume is the host's
  job). Remaining canonical element: the memory runtime.

### Thirtieth measurement — canonical element: the memory runtime component (2026-05-31)

The last spec-only slot of the canonical 5 layers (**memory**) as code
([memory-layers §runtime](memory-layers.md) · [runner/memory.mjs](../runner/memory.mjs)). The
model judges what to remember; the code stores/retrieves/consolidates/decays/promotes.

- **5/5 pass**: write (**one-off (durable:false) dropped** · empty rejected) · read (token
  relevance + recall increment) · consolidate (duplicate merge) · decay (**only inferences
  decay by half-life · floor drop, facts immutable**) · promote (frequently recalled → core).
  Runner suite cumulative **50/50**.
- **Confirmed:** of the canonical 5 layers, **permissions, hooks, observability, and memory —
  4 — are code** (tools still contract-only) + control-plane session persistence. Bloat
  prevention (one-off drop, duplicate merge) and speculation decay (inference half-life) are
  guaranteed by deterministic code.
- **Limits:** relevance retrieval is token overlap (not embeddings — deliberately
  deterministic). The host can plug in semantic search.

### Thirty-first measurement — canonical element: the tool registry → all 5 layers in code (2026-05-31)

The last spec-only slot (**tools**) as code ([tool-design §runtime](tool-design.md) ·
[runner/tools.mjs](../runner/tools.mjs)). Basis: Anthropic "writing tools for agents"
(namespacing · actionable errors · few tools), OpenAI Agents SDK (auto schema + validation),
the MCP registry (denylist precedence).

- **6/6 pass**: registration rejection (not verb_noun · duplicate · empty description · no
  schema · invalid risk) · **denylist beats allowlist** · empty allowlist = all allowed ·
  validateArgs (required/type/enum/range actionable errors) · expose cap + **dropped report**
  (no silent truncation) · risk tier→permission-gate composition (banking refused). Runner
  suite cumulative **56/56**.
- **Confirmed:** **all canonical 5 layers (permissions · hooks · observability · memory ·
  tools) enforced/recorded in code** + control-plane session persistence. Boris Cherny's 5
  layers filled by deterministic code, not documents.
- **Limits:** tool validation is a JSON-Schema subset (arbitrary $ref etc. unsupported,
  deliberately simple). One-shot selection rate is measured separately with the local model in
  `eval:tools` (this component owns registration, validation, gating).

### Thirty-second measurement — large multi-stage real-world e2e (2026-05-31)

Beyond a single cycle: **decompose a big task into subtasks → each through a gate cycle →
synthesize** ([runner/project.mjs](../runner/project.mjs)). Map-reduce-and-manage (Cognition ·
Anthropic 3-agent harness).

- **5 deterministic tests**: decompose→all 3 subtasks DONE · **empty decomposition blocked
  (fail-closed)** · when a middle subtask is blocked, **later subtasks never run** · resume
  skips completed ones (no re-decompose/re-run) · project correlation ID + summary. Runner
  suite cumulative **61/61**.
- **Real multi-stage e2e** ([run-project.mjs](../runner/run-project.mjs), real `claude -p`):
  "an in-memory TODO module" **decomposed into 4 subtasks (data structure · add · list ·
  complete) → all plan→build→evaluate→DONE**, project-done. Run in an isolated directory (repo
  uncontaminated).
- **Confirmed:** the integrated runner drives to completion not just single functions but
  **practical work that decomposes into multiple stages**. Each subtask is protected by the
  gates (maker≠judge · completion gate), and the project gate is fail-closed.
- **Limits:** subtasks assumed independent (sequential, isolated). Inter-subtask
  dependency/shared state and real-codebase scale are next.

### Thirty-third measurement — subtask dependencies (shared context) + scope correction (2026-05-31)

The multi-stage "later uses earlier results" as code
([runner/project.mjs](../runner/project.mjs)): completed subtask output passed
(volume-limited) to the next subtask. `shareContext` toggle, prior restored on resume.

- **+3 deterministic tests (total 64/64)**: a later subtask's worker receives the earlier
  output (`OUTPUT-0`) · independent when `shareContext:false` · prior restored from the
  snapshot on resume.
- **Real dependency e2e** (real claude): "c_to_f → batch_c_to_f (reusing the earlier
  function)" decomposed into 2 subtasks, **subtask 1 receiving the earlier output with
  dependsOnPrior=true** — both DONE. Isolated run (repo uncontaminated).
- **Scope correction (important):** this harness is **Claude-Code-only**, so sandbox
  isolation, real cost tracking, an MCP client, and a parallel subagent runtime are
  **delegated to Claude Code** (design, not gaps).
  [architecture §scope](architecture.md). On that basis, the remaining real code work was
  subtask dependencies (completed this round).
- **Limits:** shared context is sequential, cumulative summaries (not a full DAG dependency
  graph). Larger real-codebase scale is next.

### Thirty-fourth measurement — Claude Code native subagent integration (2026-05-31)

The harness roles composed as **real Claude Code subagent files**
([claude-code-integration.md](claude-code-integration.md)). Basis: the Claude Code
Subagents/Hooks official docs + the 2026-05 playbook.

- **4 subagents created & verified**: `.claude/agents/harness-{planner,worker,evaluator,curator}.md`
  — frontmatter 4/4 valid (lowercase-hyphen name · description · tools · model). Least
  privilege (evaluator = no writes → maker≠judge **enforced by tool permissions**),
  auto-delegation descriptions, model tiers (opus/sonnet/haiku).
- **Reference rules reflected**: parallel (independent) / sequential (dependent) = consistent
  with our `shareContext` · one-level delegation (only the main thread orchestrates) ·
  cross-communication = disk (the handoff file) · aggregation = the SubagentStop hook.
- **Confirmed:** "using Claude Code subagents/teams" exists beyond mapping/docs as **actually
  working subagent files**. Runner suite no regression (64/64).
- **Limits:** live verification of real in-session Task-tool delegation/parallel execution is
  confirmed inside a Claude Code session (structural validation is code).

### Thirty-fifth measurement — the Agent Teams guide (official Anthropic basis) (2026-05-31)

[claude-code-integration §6](claude-code-integration.md) reinforced with the **Agent Teams**
(collaborative, interdependent parallelism) guide. Full text of the Claude Code Agent Teams
**official docs** + the Anthropic multi-agent research system as basis.

- **Exact facts (official):** enable `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`
  (settings.json/env) · **v2.1.32+** · lead/teammates (independent sessions · isolated
  contexts) · **shared task list (file-lock claims · dependency tracking)** · **mailbox P2P**
  · usually 3–5 members. Includes the difference table vs subagents (central routing · single
  final message).
- **Harness binding (key finding):** Claude Code officially supports **reusing subagent
  definitions as teammates** → our `harness-{planner,worker,evaluator,curator}` are used
  as-is **both as subagents and as teammates**. Team hooks
  `TeammateIdle`/`TaskCreated`/`TaskCompleted` (exit-2 blocking) enforce our fail-closed gates
  at team level.
- **Cost discipline (Anthropic):** multi-agent ~15× tokens → high-value, highly parallel only,
  scaled to complexity. Delegation quality (goal · output · tools · boundaries) is the biggest
  leverage. Strong dependencies / same files = sequential (`shareContext`) instead of a team.
- **Confirmed:** "using Claude Code teams" documented with official facts and harness binding.
  0 broken links · runner 64/64 no regression.
- **Limits:** Agent Teams is an experimental runtime feature (not file-defined) · in-process
  `/resume` not restored · one team at a time.

### Thirty-sixth measurement — Dynamic Workflows + the orchestration selection contract (2026-06-01)

A parallel research workflow (5 agents) gathered the latest facts (v2.1.158 · Opus 4.8), added
to [claude-code-integration §7·§8](claude-code-integration.md).

- **Dynamic Workflows (new, 2026-05-28 · v2.1.154+):** orchestration as a **JS script** rather
  than conversation — control flow in the script, the model only inside `agent()`. 16
  concurrent/1000 total · saved in `.claude/workflows/` · in-session resume. **Separate** from
  subagents (per-turn) and teams (independent instances, P2P). Our `project.mjs` hand-rolled
  fan-out is its codified counterpart.
- **The 8-row selection table:** just work / subagents / agent team / workflow — choice +
  reason per situation + harness mapping. Default = single session; go multi only for
  decomposable independent threads (cost 4–15×).
- **Correction:** Claude Code **v2.1.158** · latest model **Opus 4.8**.
- **Confirmed:** what to use at which moment is codified with official docs and Anthropic
  evidence.
- **Limits:** Workflows is a research-preview runtime feature — we provide only the "when to
  use" contract.

### Thirty-seventh measurement — the layer-selection principle added (inspection loop, 2026-06-01)

During a 20-minute inspection loop, a reference refresh (latest public Claude Code harness
writing) surfaced a verified gap → reflected.
[claude-code-integration §9](claude-code-integration.md).

- **Fact reflected:** the #1 harness-design mistake named by 2026 references = "the right tool
  in the **wrong layer**" (behavioral constraints→hooks, reusable procedures→skills, isolated
  work→subagents). Claude Code **Skills** (`.claude/skills/SKILL.md`, same-context in-context
  instructions) made explicit as a **different layer** from subagents/hooks — a distinction
  our docs had missed.
- **Added:** the §9 layer-selection table (hooks/skills/subagents/MCP/workflows ↔ Claude Code
  form ↔ our harness mapping).
- **Confirmed:** **layer selection** codified on top of mode selection (§8). 0 broken links ·
  runner 64/64 no regression.
- **Limits:** Skills is a host (Claude Code) runtime layer — we provide only the "where to put
  it" contract.

### Thirty-eighth measurement — external primary-source validation: our evaluator design is right (2026-06-01)

An inspection-loop reference refresh confirmed an **Anthropic primary source** validates our
core design → citation added
([verification-and-guardrails §1](../core/verification-and-guardrails.md)).

- **Fact (Anthropic Outcomes, 2026-05 Code with Claude):** a separate grading agent that
  **cannot see the task agent's reasoning chain and grades only the output** against a rubric
  → quality +8.4% (Word) / +10.1% (PPT) **with no model change**.
- **Meaning:** our "**maker ≠ judge** + rubric grading + evaluator with no write permissions"
  is exactly the structure Anthropic proved quantitative gains for — our evaluator-gate design
  is validated by a primary source (not speculation; a public source).
- **Confirmed:** external evidence that this is an **authoritative direction**, not
  misconfiguration. 0 broken links · runner 64/64.
- **Limits:** Outcomes itself is a Claude managed-agents runtime feature — we cite it only as
  validation of the design idea.

### Thirty-ninth measurement — primary source: verification 2–3×es quality (Boris Cherny) (2026-06-01)

An inspection-loop reference refresh confirmed a first-hand statement by Claude Code's creator
backs our verification-centered design → citation added
([verification-and-guardrails intro](../core/verification-and-guardrails.md)).

- **Fact (Boris Cherny, 2026):** verification is **the most important** thing for quality —
  given verification feedback loops (a different agent checking · stop hooks · UI tests),
  final quality is **2–3×**. Also: a harness is "a minimal wrapper over the model".
- **Meaning:** after Anthropic Outcomes (§38, +8.4/10.1%), our **evaluator, completion-gate,
  and hook**-centered design is validated once more by a primary source. Also consistent with
  the "minimal wrapper" view (our core is gates and verification; execution is delegated to
  Claude Code).
- **Confirmed:** the harness's direction (verification first) reconfirmed on authoritative
  grounds. 0 broken links · runner 64/64.
- **Limits:** an interview-statement citation — the quantitative benchmark is Outcomes (§38).

## One-line summary (harness acceptance checklist)

1. Did you certify **data sources** first (layer 0)?
2. Did the **10–20** golden tasks come from real use, separated from the dev set?
3. Do you grade **outcome + path** together, **code first**?
4. Are the layers filled — unit → integration → E2E → adversarial → **CI regression**?
5. Do changes proceed **one variable at a time** + delta measurement?

---

## Sources (verified basis)

- Anthropic — [Demystifying evals for AI agents](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents) (10–20 tasks · outcome+path · code-first grading · one-variable iteration)
- Braintrust — [What is agent evaluation?](https://www.braintrust.dev/articles/agent-evaluation) (the Data/Task/Scores triad · golden traces)
- Atlan — [How to Test an AI Agent Harness: The Six-Layer Guide](https://atlan.com/know/how-to-test-ai-agent-harness/) (layers 0–5, layer-0 data certification as the root)
