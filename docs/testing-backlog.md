# Multi-faceted testing backlog

The test-hardening loop spent its first phase on **module unit-exhaustion**
(every export/branch of a chosen module, deterministic, dist-pre-verified).
The core is now saturated (~6,000 unit tests, 0 fail). That is the *shallowest*
testing layer. This backlog enumerates the **harder, higher-value layers** the
codebase still lacks, so the loop can pick a diverse target each fire instead of
hunting for the next thin module.

**Loop rule:** each fire, pick the highest-priority unchecked item whose
prerequisites are met, do ONE coherent slice of it (one commit), tick it (or add
a sub-bullet noting what's done / what remains). Keep the existing gates: own
check green → package suite → `pnpm lint` 0 → live gate where relevant. Prefer
depth on one item over touching several. When an item is genuinely exhausted,
mark it `[x] DONE` with the commit range.

Mock/fixture data MAY be created to drive a real code path, but the path must be
the REAL one against a contract-faithful fake — never a stubbed registry or a
happy-path-only assertion (per `outbound-safety.md`).

---

## P0 — agent-eval strategy (research-grounded — see `agent-eval-strategy.md`)

Best-practice for *agent* testing (DeepEval metric taxonomy, τ-bench terminal-
state eval, LLM-as-judge) + how hermes-agent (constraint gates on every variant)
and OpenClaw (dreaming shadow-trial before promotion) do it. These rank ABOVE
the generic layers below because they test what makes Muse an *agent*.

- [ ] **A. ArgumentCorrectness battery** — `eval:tools` asserts the tool *name*;
  add a graded per-case check that the *arguments* are right (required present +
  values plausible). Cheapest high-value extension of the existing harness.
- [ ] **B. Task-completion / terminal-state eval (τ-bench style)** — after a real
  run (diagnostic/local provider + contract-faithful tool fakes), assert the
  RESULTING STATE (note written / task added / approval recorded), not the path.
- [ ] **C. Trajectory / step assertions** — ordered spans of a plan_execute /
  tool-loop run (plan → tool → synthesis) + adherence + step-efficiency.
- [ ] **D. LLM-as-judge (GEval) harness** — reusable local-Qwen judge (temp 0,
  repeat) scoring open-ended outputs (summaries/drafts) vs a plain-English rubric.
- [ ] **E. Adversarial eval battery** — prompt-injection / jailbreak / unsafe-
  tool-use as a scored must-refuse live battery (mirrors the eager-invocation
  negatives already in `eval:tools`).
- [x] **F. Constraint gates on self-authored skills (hermes-style)** — DONE (skill-review.ts size gate, wired into authoring producers). gate each
  session-authored skill on size (≤15 KB), tool-desc length, and a parse/lint
  check before it is loadable.
- [ ] **G. Shadow-trial for memory/playbook promotion (OpenClaw-style)** — a
  report-only baseline-vs-candidate judge (verdict/reason/risk) before a distilled
  strategy or promoted memory goes live, kept separate from the live store.
- [ ] **H. CI gating** — extend `self-eval` so a tool-selection / task-completion
  / adversarial regression FAILS the run, not just logs.

## P1 — assertion quality & failure modes (highest value: do these first)

- [ ] **Mutation testing baseline (StrykerJS).** 6,000 green tests prove
  *coverage*, not that the assertions *catch bugs*. Run Stryker on 2–3
  high-value packages (`agent-core`, `model`, `policy`) to get a mutation score;
  file the surviving-mutant hotspots as follow-up. NOTE: adds a devDep + config —
  needs human OK for the lockfile change before committing tooling; until then,
  do it as a throwaway local measurement and record the score here.
- [~] **Failure-injection / chaos on the model loop.** Drive `AgentRuntime.run`
  /`executeModelLoop` against a provider fake that returns 429 / 503 / a mid-
  stream `{error}` / a timeout / malformed JSON — assert retry classification,
  fallback policy, circuit-breaker open, and that a partial stream surfaces an
  error event (not a silent truncation). The "hardening" half of the human's
  directive. (Adapter-level retryable flags are already unit-tested; this is the
  *loop* composing them.)
  - [x] `executeModelLoop` throw-propagation (`b…` this commit): first-turn
    throw rejects; a later-turn throw rejects after the requested tool already
    ran; an unexpected `executeToolCall` throw propagates (NOT captured as a
    status:"error" tool result). 5→8 tests in execute-model-loop.test.ts.
  - [ ] Remaining: `AgentRuntime.run` end-to-end under a 429/503/timeout/
    malformed provider (retry → fallback → circuit-breaker open) and a
    streaming mid-stream `{error}` surfaced as an error event.
- [ ] **Tool-loop limits & runaway guards.** maxToolCalls, maxRunWallclockMs,
  maxToolOutputChars, tool-output recursion — exercise each cap end-to-end with a
  fake tool that tries to exceed it; assert the loop stops deterministically.

## P2 — end-to-end flows (compose the pieces, not the units)

- [ ] **Full agent run e2e (diagnostic provider).** message → model loop → tool
  call → tool result → synth, blocking AND streaming, asserting the whole chain
  (only ~6 e2e files today; expand the matrix: plan_execute, react, tool-error
  recovery, guard-block mid-run).
- [ ] **Approval-gate round-trip e2e.** A risky tool refused → pending-approval
  recorded → inbound "yes" reply → `runActuatorByName` re-runs through the
  fail-closed gate → action logged. Plus the deny / timeout / ambiguous-recipient
  paths produce NO external effect (outbound-safety acceptance, contract-faithful
  HTTP fake).
- [ ] **Route integration (boot the server).** The `apps/api/src/*-routes.ts`
  groups are registered but unexercised by direct tests (notes/tasks/reminders/
  messaging/voice/proactive/active-context/accountability/session/admin-*). Boot
  the Fastify app per group and assert status + body for the happy + 4xx paths.

## P3 — live LLM verification (Ollama up on this PC — USE it)

- [ ] **`eval:tools:nl` baseline.** Never run by the loop. Run it, record the
  score, add cases for any weak natural-language selection.
- [ ] **`eval:self-improving` baseline.** The 4 LLM batteries (pattern-suggestion,
  preference-inference, skill/playbook merge). Never run by the loop. Run, record,
  shore up regressions.
- [ ] **`smoke:live` full completion.** Now that it streams (commit `6fd24d36`),
  run it to the end once with a generous timeout; confirm the slow tail
  (multi-agent orchestrate + CLI knowledge) is green, and append the result.
- [ ] **`eval:tools` set growth.** Extend the actuator + time confusable sets and
  add more KO/adversarial cases (each pre-verified STABLE 3/3 before landing).

## P4 — generative & data-layer

- [ ] **Property-based / fuzz (fast-check).** Parsers/serializers/normalizers
  (env-parsers, gemini-live-protocol, web-search-policy, isApprovalReply,
  isLoopbackUrl, JSON repair) — assert invariants over generated input
  (round-trip, never-throws, idempotence). Zero today. (Adds a devDep — same
  lockfile caveat as Stryker.)
- [ ] **Real-Postgres behavior (testcontainers).** Only ~2 test files touch a real
  PG. The Kysely stores (runs, messages, tool-calls, approvals, checkpoints,
  traces) should have query-behavior tests against a real container, not just the
  in-memory store.
- [~] **Concurrency / races.** Atomic tmp+rename stores under concurrent writers,
  pending-approval cap under races, inbound dedup, single-flight daemons —
  interleave operations and assert no lost/duplicated/corrupt state.
  - [x] First slice + a real bug FOUND & FIXED: appendInbound (write-queue)
    preserves every record under 25 racing appends and isolates per-file;
    recordPendingApproval CRASHED with an ENOENT tmp-rename race (tmp name was
    `${pid}-${Date.now()}` → same-ms collision) — fixed with a random-uuid tmp
    suffix. Store now never crashes/corrupts under concurrency (last-writer-wins
    remains, documented). store-concurrency.test.ts (4 tests), full check green.
  - [x] Lossless serialization: a per-file mutation queue now serialises the
    whole read-modify-write of recordPendingApproval + clearPendingApproval, so
    25 concurrent records preserve ALL 25 (was last-writer-wins) and mixed
    concurrent clear+record resolves correctly. No more silent loss of a refused
    action's pending approval.
  - [x] Store-audit slice 2: audited all `${pid}-${Date.now()}`-tmp stores
    (~30) for the same race. Fixed `personal-action-log-store` (the immutable
    accountability trail, outbound-safety rule 4) — 25 concurrent appends were
    19/20 CRASHING + losing ~all; now per-file append queue + random-uuid tmp =
    0 crash, all 25 preserved, order kept. action-log-concurrency.test.ts.
  - [x] Store-audit slice 3: fixed proposed-action store (draft-first outbound
    proposals) — concurrent patch crashed 7/8 + clobbered; now 0-crash, all 8
    status patches applied + 12 concurrent proposes preserved. **The outbound-
    safety + audit critical trio is now concurrency-safe: pending-approval,
    action-log, proposed-action.**
  - [ ] Remaining (LOWER stakes — flag as a deliberate shared-helper effort, not
    per-store churn): the non-critical read-modify-write stores (objectives /
    episodes / playbook / reminders / tasks / proactive-history / belief-
    provenance, etc.) share the latent race; cursor/offset stores only risk the
    tmp-collision crash, not loss. Best done as ONE shared atomic-append helper
    (server-only util) migrated across stores, not N copy-paste fixes. inbound
    dedup + single-flight daemon race tests also open.

## P5 — surface & contract

- [ ] **Prompt / tool-protocol snapshot tests.** Snapshot the rendered persona /
  system prompt and the Hermes tool-call wire format so an accidental prompt edit
  is caught (CLAUDE.md: "Snapshot-test prompt text and tool protocols when
  behavior matters").
- [ ] **CLI command-parser + run-path smoke.** The untested commander
  registrations (commands-analytics/cost/latency/persona/voice/specs/tools-admin)
  — parse args + assert the action wiring via the CLI smoke harness.
- [ ] **Config / schema validation fuzz.** Zod (or comparable) config + external-
  input validators against adversarial inputs (wrong types, extra keys, unicode,
  huge values) — assert they reject cleanly, never throw raw.

---

## Done (this loop)

- [x] Module unit-exhaustion of the core: agent-core, model (adapters Ollama/
  Gemini/Anthropic + policies), messaging (approval gate), autoconfigure
  (registry-builders), mcp, apps/api (chat request→handler→response→plumbing→
  auth→doctor→poll-tick). ~6,000 unit tests, 0 fail.
- [x] `smoke:live` streaming fix (`6fd24d36`) — was buffered, not hung; verified
  17 checks green live.
- [x] `eval:tools` live baseline green (32→39 cases, `79fcee09`).
