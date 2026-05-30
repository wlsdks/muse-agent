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

- [x] **A. ArgumentCorrectness battery** — `eval:tools` asserts the tool *name*;
  add a graded per-case check that the *arguments* are right (required present +
  values plausible). Cheapest high-value extension of the existing harness.
- [x] **B. Task-completion / terminal-state eval (τ-bench style)** — after a real
  run (diagnostic/local provider + contract-faithful tool fakes), assert the
  RESULTING STATE (note written / task added / approval recorded), not the path.
- [x] **C. Trajectory / step assertions** — ordered spans of a plan_execute /
  tool-loop run (plan → tool → synthesis) + adherence + step-efficiency.
- [x] **D. LLM-as-judge (GEval) harness** — reusable local-Qwen judge (temp 0,
  repeat) scoring open-ended outputs (summaries/drafts) vs a plain-English rubric.
- [x] **E. Adversarial eval battery** — prompt-injection / jailbreak / unsafe-
  tool-use as a scored must-refuse live battery (mirrors the eager-invocation
  negatives already in `eval:tools`).
- [x] **F. Constraint gates on self-authored skills (hermes-style)** — DONE (skill-review.ts size gate, wired into authoring producers). gate each
  session-authored skill on size (≤15 KB), tool-desc length, and a parse/lint
  check before it is loadable.
- [x] **G. Shadow-trial for memory/playbook promotion (OpenClaw-style)** — a
  report-only baseline-vs-candidate judge (verdict/reason/risk) before a distilled
  strategy or promoted memory goes live, kept separate from the live store.
- [x] **H. CI gating** — extend `self-eval` so a tool-selection / task-completion
  / adversarial regression FAILS the run, not just logs.

## P1 — assertion quality & failure modes (highest value: do these first)

- [~] **Mutation testing baseline (StrykerJS).** 6,000 green tests prove
  *coverage*, not that the assertions *catch bugs*. Run Stryker on 2–3
  high-value packages (`agent-core`, `model`, `policy`) to get a mutation score;
  file the surviving-mutant hotspots as follow-up. NOTE: adds a devDep + config —
  needs human OK for the lockfile change before committing tooling; until then,
  do it as a throwaway local measurement and record the score here.
  - FIRST MEASUREMENT (throwaway, Stryker 9.6.1 + vitest-runner, NOT committed —
    lockfile reverted): `muse-tools-data.ts` (559 mutants, perTest coverage) =
    **72.99% total / 76.55% covered**. ~73 of 125 survivors were metadata
    StringLiteral mutants (tool `keywords`/`description` text — not behavior, low
    value to assert). The ACTIONABLE logic survivors were real assertion gaps:
    the CSV >200k and base64 >500k size guards (NoCoverage — never exercised) and
    the base64 padBase64/url-safe re-padding path. Killed them with 4 cases
    (CSV/base64 over-limit rejection + a url-safe round-trip needing padding) →
    re-measured **74.42% / 77.18%**, killed 386→395, no-cov 26→20. Lesson: the
    headline score is dragged down by un-asserted metadata strings; the real
    logic-assertion strength is higher, but mutation testing still surfaced two
    genuine untested DoS guards. Next: run on `policy`/`model` for more logic-dense
    hotspots; a committed Stryker config still needs the human lockfile OK.
  - `policy/migration-redaction.ts` (mutation-INFORMED, no Stryker re-install —
    `--frozen-lockfile` integration wipes the throwaway devDep, so analysed the
    survivable mutants by hand): the existing suite asserted only happy-path
    redaction. Killed the high-value logic/security mutants directly — the
    connection-before-url **rule-order invariant** (an http URI with inline creds
    must be labelled `connection`, not mislabelled `url`), `escapeRegExp`
    (regex-meta private terms match literally, never as a pattern), the
    empty/whitespace private-term skip branch, case-insensitive term matching, and
    the ghp_/xox token shapes beyond sk-. +6 cases (policy 93→99).
  - SECOND MEASUREMENT (throwaway Stryker 9.6.1, NOT committed — lockfile reverted):
    `policy/structured-output.ts` = **75.20% total / 81.03% covered** (91 killed, 22
    survived, 9 no-cov). Most survivors are Regex mutants on the markdown-fence /
    balanced-block patterns (equivalent or low-value). The ONE actionable logic
    survivor: the `firstBalancedJsonBlock` escape branch (`if (escape)` / `\\`+
    inString) had no test exercising an ESCAPED quote — the brace-in-string test
    used a bare `}` but never a `\"`, so a mutation killing the escape handling
    survived. Killed it with a JSON value carrying `\"hi}\"` (an escaped quote
    wrapping a brace): the `\"` must not end the string early, so the inner `}`
    still doesn't close the object. policy 100→101. Lesson holds: the headline
    score is dragged by equivalent regex mutants; the real logic-assertion gap was
    a single escape-path case mutation testing surfaced precisely.
  - THIRD MEASUREMENT (throwaway Stryker 9.6.1 — reused the still-installed
    node_modules from the prior fire, NO new install, NOT committed): `model/
    provider-shared.ts` = **82.63% total / 86.27% covered** (176 killed, 28
    survived, 9 no-cov). Actionable survivors clustered on `isJsonValue` /
    `isJsonObject` — the recursive JSON-shape guards the provider adapters use to
    validate structured output — which had ZERO direct tests (only incidental
    exercise via parseJson callers). Added a direct suite (+9 cases) pinning every
    branch: the JSON primitives, the NON-FINITE-number rejection (NaN/±Infinity
    aren't valid JSON), undefined/function/symbol rejection, recursive array +
    object descent (a deep-nested invalid element fails), isJsonObject's
    non-record rejection, and isRecord. model 305→309. The 2-3-package mutation
    survey (P1) now spans tools/policy/model; remaining survivors are dominated by
    equivalent regex/string-literal mutants. A committed Stryker config + CI gate
    still needs the human lockfile OK.
  - FOURTH MEASUREMENT (throwaway, reused install, NOT committed): `agent-core/
    step-budget.ts` = **98.70%** (76 killed, 1 survived) — already near-ideal. The
    single survivor: `isExhausted()` (`return this.status() === "exhausted"`)
    mutated to `return true` survived because the suite only ever asserted
    isExhausted() === true (when exhausted), never false. A `return true`
    regression would make the budget read as always-exhausted and stop every agent
    loop on its first step. Killed it by asserting isExhausted() === false on a
    fresh tracker AND on a soft-limit (under-budget) one. agent-core 1079→1080. The
    agent-core/model/policy mutation survey (P1) is now complete; the actionable
    survivors it surfaced (DoS guards, escaped-quote parse path, JSON-shape guards,
    always-exhausted budget) are all killed.
  - FIFTH MEASUREMENT (throwaway, reused install, NOT committed): `policy/
    prompt-leakage.ts` = **42.86%** — the LOW outlier. NOT equivalent-mutant
    noise: this is a SECURITY detector with 16 leak-detection patterns, and the
    suite positively asserted only ~4, so a regex mutation breaking any of the
    other 12 patterns survived = that leak class silently stops being caught. Added
    one representative-phrase detection assertion per uncovered class: the 4 English
    disclosure variants (my_system_prompt / original_instructions /
    reveal_prompt_statement / the_system_prompt), all 3 KOREAN phrasings
    (korean_prompt_statement / korean_followed_instructions /
    korean_original_instructions — the user's language), the tool-coercion +
    structural-rule leaks, and the cache-boundary marker echo. policy 101→104.
    (A security detector's pattern coverage is exactly where mutation testing earns
    its keep — a low score there is real risk, not metadata-string drag.)
  - SIXTH MEASUREMENT (throwaway, reused install, NOT committed): `policy/
    injection-patterns.ts` = **39.44%** — the PRIMARY injection gate; like
    prompt-leakage, dominated by un-asserted detection patterns (127 Regex + 97
    StringLiteral survivors across 70+ patterns), but the logic survivors are the
    actionable ones. Killed the highest-value crash-safety guard: `decodeCodePoint`
    returns the ORIGINAL entity for an out-of-range code point (cp > 0x10FFFF /
    negative / non-integer) — String.fromCodePoint THROWS otherwise, so a malicious
    `&#9999999999;` in untrusted input would crash the normaliser and make
    injection detection fail. Asserted out-of-range entities stay intact (no throw)
    while a valid `&#65;` still decodes. policy 104→105. The bulk pattern-coverage
    survivors here are a known follow-up (each pattern needs a positive detection
    case, like the prompt-leakage round) — deferred as a larger effort, not a
    single slice.
    - Chipping the bulk: of the high-value data-exfil / privilege-escalation
      injection classes, all but two were already asserted (in adversarial-red-team
      / multilingual suites); the two un-asserted classes —
      `indirect_prompt_extraction` (KO "repeat verbatim the instructions you were
      first given") and `secrecy_probe` ("what were you told never to reveal") —
      now have positive-detection assertions + a benign control. policy 105→106.
- [x] **Failure-injection / chaos on the model loop.** Drive `AgentRuntime.run`
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
  - [x] `AgentRuntime.run` end-to-end failure: a provider whose generate()
    throws persists a FAILED run record (handleRunError), fires the onError
    hook with the Error, and rethrows — never silently completes/swallows.
    (agent-runtime.test.ts, run-level composition.)
  - [x] `invokeModel` (the run() model-call seam) failure-injection: proves the
    real CLASSIFICATION (4xx fails fast — 1 attempt, no retry budget burned;
    429/503 + unknown/malformed-JSON errors are retried, via
    isRetryableProviderError + ModelProviderError.retryable) AND the COMPOSITION —
    persistent 503 exhausts retries → fallback strategy rescues; each
    exhausted-retry invocation is ONE breaker failure so the breaker opens and the
    next call short-circuits WITHOUT touching the provider. model-invocation.test.ts
    +5 (1011 pass). Pre-verified attempt/short-circuit counts via dist.
  - [x] Streaming mid-stream `{error}`: executeStreamingModelLoop SURFACES the
    error as an error event to the consumer (after the partial text-deltas it had
    already yielded — no silent truncation) AND records it on the tracing span
    (setError), THEN throws the same error instance — never reaching a false
    `done`. execute-streaming-model-loop.test.ts +3 (1014 pass). Pre-verified via
    dist that the error event is yielded before the throw.
- [x] **Tool-loop limits & runaway guards.** maxToolCalls, maxRunWallclockMs,
  maxToolOutputChars, tool-output recursion — exercise each cap end-to-end with a
  fake tool that tries to exceed it; assert the loop stops deterministically.
  (maxToolCalls + recursion: execute-model-loop.test.ts; maxToolOutputChars:
  cap-tool-output.test.ts; maxRunWallclockMs: execute-model-loop.test.ts —
  deadline cuts the loop, in-flight tool finishes, next turn gets no tools.)

## P2 — end-to-end flows (compose the pieces, not the units)

- [x] **Full agent run e2e (diagnostic provider).** message → model loop → tool
  call → tool result → synth, blocking AND streaming, asserting the whole chain
  (only ~6 e2e files today; expand the matrix: plan_execute, react, tool-error
  recovery, guard-block mid-run).
  - [x] plan_execute through the WHOLE AgentRuntime (not just streamPlanExecute):
    the REAL steerable DiagnosticModelProvider generates the plan + a REAL
    fs-mutating tool runs, exercising prepareInvocation → plan-execute streaming →
    finalizeInvocation. stream() asserts the runtime event sequence
    (plan-generated → executing → result → synthesis-started → text-delta → done)
    + plan adherence + terminal world state; run() asserts the same goal +
    a persisted `completed` run record. agent-run-plan-execute-e2e.test.ts (1016).
  - [x] react tool-loop through AgentRuntime.stream() with a REAL fs-mutating
    tool: the happy path streams tool-call → tool-result → text-delta → done and
    persists the note (terminal world state); TOOL-ERROR RECOVERY — a throwing
    tool surfaces a tool-result, the model synthesises a graceful answer, the run
    completes (not crash) and NOTHING is mutated. agent-run-react-stream-e2e.test.ts.
  - [x] guard-block MID-RUN (streaming): a toolApprovalGate denial inside the
    loop blocks an execute-risk tool — the gate is consulted, the block is
    surfaced as a tool-result (not a crash), the model synthesises a "can't
    without approval" answer, the run completes, and the gated tool NEVER ran
    (no side effect). agent-run-react-stream-e2e.test.ts. The full-agent-run
    matrix (plan_execute / react / tool-error recovery / guard-block) is closed.
- [x] **Approval-gate round-trip e2e.** A risky tool refused → pending-approval
  recorded → inbound "yes" reply → `runActuatorByName` re-runs through the
  fail-closed gate → action logged. Plus the deny / timeout / ambiguous-recipient
  paths produce NO external effect (outbound-safety acceptance, contract-faithful
  HTTP fake).
  - [x] The re-run leg (`runActuatorByName`) outbound-safety acceptance + the
    "recorded" rule (#4): web_action approve→`performed` / deny→`refused` /
    thrown-or-undeliverable approval prompt→fail-closed `refused` (no HTTP) /
    third-party 500→NOT a false success (`failed`, attempt fired once, no retry);
    email_send ambiguous recipient→no send, `refused` — each asserted by READING
    the action log (not just the HTTP effect). run-actuator-by-name.test.ts +5
    (mcp 1064). Contract-faithful HTTP fake.
  - [x] The chat-inbound half, composed end-to-end: the FOUR real seams wired
    together (createChannelApprovalGate refuses+records → pending-approval store →
    handleInboundApprovalReply on a "yes" → runActuatorByName re-run). A risky
    web_action is refused & recorded (+ a notice via a REAL registry +
    LogMessagingProvider), an inbound "yes" re-runs it for real (fetch fired once,
    logged `performed`) and clears it; a READ tool sails through unrecorded; a
    "yes" from a DIFFERENT source does not re-run (channel scope holds across the
    recorder→handler seam). approval-round-trip-e2e.test.ts (api 489).
- [~] **Route integration (boot the server).** The `apps/api/src/*-routes.ts`
  groups are registered but unexercised by direct tests (notes/tasks/reminders/
  messaging/voice/proactive/active-context/accountability/session/admin-*). Boot
  the Fastify app per group and assert status + body for the happy + 4xx paths.
  - [x] accountability route group (server.accountability.test.ts): /api/actions
    (newest-first), /api/objectives, /api/vetoes read-only + /api/contacts CRUD
    (POST persists, GET reflects, DELETE removes, 400 no-name). Most groups
    (notes/tasks/reminders/active-context/voice/today/setup/admin/chat) already
    have server.*.test.ts; remaining untested: the *-compat (Spring-compat) routes.
  - [x] admin-session-compat route group (server.admin-session-compat.test.ts):
    /api/admin/sessions/overview (status tally), the paginated list (limit/offset/
    total echo + items), session detail (+ empty tags), DELETE 204→404 (re-delete)
    + 404 unknown, tag POST 400 no-label. (auth-compat, session-compat, agent-compat,
    user-memory-compat, mcp-compat access-policy already covered by their server.*
    tests.) Remaining compat: admin-{analytics,observability,platform}-compat
    (ops/dashboard surfaces — lower outward value per the personal pivot).

## P3 — live LLM verification (Ollama up on this PC — USE it)

- [x] **`eval:tools:nl` baseline.** Run on qwen3:8b (this iter): native 7/7
  (100%) AND NL-protocol 7/7 (100%) across the time-tool confusable set — the
  text/Hermes tool protocol selects as reliably as native here, no weak NL spot
  to shore up. Baseline recorded; re-run after touching the NL tool protocol.
- [x] **`eval:self-improving` baseline.** Run on qwen3:8b (this iter): 8/8 live
  batteries GREEN — pattern-suggestion (③), preference-inference (②), skill-merge
  + playbook-merge (①), background-review + background-review-e2e (① engine),
  cited-recall (★ wedge), proactive-recall-gate (★ north star). No regression to
  shore up; this is the live-green baseline the loop had never captured.
- [ ] **`smoke:live` full completion.** Now that it streams (commit `6fd24d36`),
  run it to the end once with a generous timeout; confirm the slow tail
  (multi-agent orchestrate + CLI knowledge) is green, and append the result.
- [~] **`eval:tools` set growth.** Extend the actuator + time confusable sets and
  add more KO/adversarial cases (each pre-verified STABLE 3/3 before landing).
  - [x] 4 negative eager-invocation traps on the TIME confusable set (it had
    zero negatives): KO/EN musings with time/weekday WORDS ('금요일'/'Friday'/
    time idioms) that request no computation → NO tool. eval:tools 48/48 (100%)
    @ REPEAT=2; each STABLE 3/3.
  - [x] 5 negative eager-invocation traps on the STATE-CHANGING/perception
    actuator set (a false positive there acts/searches unbidden — the worst
    failure): KO smart-home comment, EN gratitude for a past booking, KO inbox
    venting, EN weather small-talk, KO weather-app-UI comment → all NO tool. The
    actuator scenario filter now keeps expectNoTool cases. eval:tools 44/44 (100%)
    @ REPEAT=2 on qwen3:8b; each pre-verified STABLE 3/3.
  - [x] 3 KO POSITIVES on the actuator set, closing a cross-language asymmetry:
    search_email/knowledge_search/web_action had EN-only positives while home_action
    already had a KO one — yet the user's primary language is Korean. Added KO
    "은행 명세서 메일 찾아줘" → search_email, "구독 피드에 화성 소식?" →
    knowledge_search (NOT search_email), "포럼에 댓글 남겨줘: <url>" → web_action.
    eval:tools 53/53 (100%) @ REPEAT=2 on qwen3:8b; each pre-verified STABLE 3/3.

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
  - [x] Store-audit slice 4 — recall-hits store (the recall-hit-recording flake
    seen earlier under parallel full-check load): had BOTH the `${pid}-${Date.now()}`
    tmp-rename crash AND the last-writer-wins read-modify-write (its own comment
    admitted "concurrent writers can clobber"). Fixed with randomUUID tmp + a
    per-file mutation queue: 25 same-key concurrent recalls now total 25 hits
    (was 1), 25 distinct keys all preserved, per-file isolated, 0 crash.
    recall-hits-store.test.ts +3, full `pnpm check` green. Closes the flake.
  - [x] Shared helper extracted (the recommended approach, not N copy-paste
    fixes): `atomic-file-store.ts` — `atomicWriteFile` (randomUUID tmp + fsync +
    rename + 0o600) and `withFileMutationQueue` (per-file read-modify-write
    serialisation, parallel across files, error doesn't wedge). 8 direct unit
    tests. First migration: personal-objectives-store (user-facing — a lost
    standing objective is an intent the daemon never acts on): addObjective +
    patchObjective now serialised, 20 concurrent registrations all preserved
    (was last-writer-wins), 20 concurrent patches all applied, 0 crash.
  - [x] Migration 2 — personal-consent-store (outbound-safety rule 5: a standing
    objective acts toward a third party ONLY with recorded scoped consent). Was
    pid+Date.now tmp + an unserialised recordConsent read-modify-write; now
    atomicWriteFile + withFileMutationQueue. 20 concurrent distinct grants all
    preserved (was last-writer-wins → 1) + each still individually checkable by
    the fail-closed gate, 15 concurrent re-grants of one id converge to a single
    record. +2 tests.
  - [x] Migration 3 — personal-veto-store (outbound-safety reversibility: a
    learned-avoidance the agent must not forget). recordVeto + removeVeto now
    serialised + atomicWriteFile: 20 concurrent distinct vetoes all preserved
    (still avoidance-checkable), 10 concurrent removes drop exactly the targeted
    ones. +2 tests. **The outbound-safety store trio consent+veto+the
    audit/approval stores is now concurrency-safe.**
  - [x] Migration 4 — personal-followups-store (user-facing: a lost followup is
    a proactive nudge the user never receives). writeFollowups → atomicWriteFile;
    upsert / markFired / cancel / snooze all wrapped in withFileMutationQueue. 20
    concurrent distinct upserts all preserved (was last-writer-wins), 20
    concurrent markFired all applied, 0 crash. +2 tests.
  - [x] Migration 5 — personal-playbook-store (self-improving: a lost learned
    strategy is a self-improvement the agent forgets; OpenClaw skill-workshop).
    record/remove now serialised + atomicWriteFile: 20 concurrent distinct
    records all preserved, the FIFO cap (100) applies to the REAL merged set under
    130 concurrent over-cap records (not a stale snapshot), 10 concurrent removes
    drop exactly the targeted ones. +3 tests.
  - [x] Migration 6 — personal-contacts-store (outbound-safety rule 3: recipient
    resolved, never guessed — a lost contact means a send is refused / a clarify
    fires instead of reaching the person). add/remove serialised + atomicWriteFile:
    20 concurrent distinct adds all preserved (each still name-resolvable by
    resolveContact), 10 concurrent removes drop exactly the targeted ones. +2 tests.
  - [x] Migration 7 — proactive-trust-ledger (north star: the trust score that
    GATES proactivity is computed from this ledger; a clobbered append corrupts
    the precision the gate reads). Was pid+Date.now tmp + a NON-fsync write +
    unserialised appendSurfaced/recordOutcome; now atomicWriteFile (durable) +
    withFileMutationQueue. 20 concurrent surfaces all preserved, 20 concurrent
    outcomes each match their own surface (precision stays 1, not corrupted). +2.
  - [x] Inbound dedup race — inbox-reply-cursor (the "answered" cursor whose
    whole job is "an overlapping tick never double-replies"). Had BOTH the
    unserialised read-merge-write (a lost key = a message answered TWICE) AND a
    `${file}.tmp-${pid}` tmp with NO uniquifier (two same-process concurrent
    writers shared the identical tmp path → collision). Fixed with a per-file
    mutation queue + randomUUID tmp: 25 overlapping ticks marking distinct
    messages all preserved (no double-reply), 30 racing same-key writes converge
    to 1, 0 crash. inbox-reply-cursor.test.ts +2 (messaging 294).
  - [x] Single-flight lock PRIMITIVE covered — the distributed scheduler lock
    that enforces "only one pod runs a job per TTL window" (a broken lock = the
    same job firing twice = a double email/charge). scheduler-locks.test.ts
    drives the InMemory lock's process-global contention map: mutual exclusion
    (2nd owner blocked while TTL valid), owner-scoped release (a foreign release
    does NOT free it), TTL-expiry steal (stealable at exactly lockedUntil, strict
    >), per-job independence, non-positive-TTL floor; + NoOp always-acquire + the
    createScheduledJobLockInsert row builder (locked_until = now+ttl, floored).
    scheduler 81 pass. (The KyselyDistributedSchedulerLock's ON CONFLICT … WHERE
    SQL semantics are NOT faked — they belong to the testcontainers Postgres item
    above; a hand fake would assert the mock, not the lock.)
  - [ ] Remaining: migrate the other ~10 read-modify-write stores
    (reminders / tasks / episodes / proactive-history / patterns-fired /
    plan-cache / …) onto the shared helper — a cheap one-each adoption.
    Full daemon-level single-flight integration (the lock wired through the live
    scheduler tick) still open above the primitive.

## P5 — surface & contract

- [~] **Prompt / tool-protocol snapshot tests.** Snapshot the rendered persona /
  system prompt and the Hermes tool-call wire format so an accidental prompt edit
  is caught (CLAUDE.md: "Snapshot-test prompt text and tool protocols when
  behavior matters").
  - [x] First snapshot: buildPlanningSystemPrompt (the behavior-critical planner
    prompt that shapes Qwen's plan output) pinned via toMatchInlineSnapshot +
    structural invariants. planning-prompt-snapshot.test.ts. (Was 0 snapshot
    tests in the repo.)
  - [x] buildSystemPrompt section-assembly snapshot (system-prompt-snapshot.test.ts): base → Response Format → cache boundary → memory/retrieved/tool sections, order + boundary placement pinned.
  - [ ] Remaining: the Ollama Hermes
    tool-call wire body (buildNativeChatBody) is already shape-asserted in
    adapter-ollama.test.ts — DONE — adapter-ollama.test.ts pins the exact native /api/chat body for a tool-using request.
- [x] **CLI command-parser + run-path smoke.** The untested commander
  registrations (commands-analytics/cost/latency/persona/voice/specs/tools-admin)
  — parse args + assert the action wiring via the CLI smoke harness. ALL SEVEN
  now covered (cost/latency/analytics/specs/voice/tools via inject-fake-helpers;
  persona via MUSE_PERSONA_FILE + injected stdin round-trip).
  - [x] `muse cost` (the richest path-builder of the group): parses daily/top/for
    and asserts the EXACT /api/admin/token-cost/* path the parser routes to —
    query-string assembly from --days/--limit (both/either/neither), and
    encodeURIComponent on the run id so a hostile `for "evil&admin=1 x"` can't
    inject extra query params (percent-encoded, not smuggled). Also: apiRequest
    result is handed to writeOutput; unknown subcommand + missing required arg
    are parse errors. commands-cost.test.ts +7 (cli 1496). Fake helpers, no network.
  - [x] `muse latency` + `muse analytics` (the sibling observability groups):
    summary/timeseries + failures/latency-distribution route to the exact
    /api/admin/metrics/latency/* + /api/admin/conversation-analytics/* paths;
    --days is percent-encoded (no param injection); apiRequest result → writeOutput;
    unknown subcommand is a parse error. commands-observability.test.ts +7 (cli 1503).
  - [x] `muse specs` (agent-spec registry: list / get / resolve): list → GET
    /agent-specs; get encodes the name (a hostile `../admin/secrets` →
    `..%2Fadmin%2Fsecrets`, no path traversal); resolve joins+trims the variadic
    prompt into a POST body and rejects an all-whitespace prompt (no request
    fires); unknown subcommand + missing <name> are parse errors.
    commands-specs.test.ts +6 (cli 1509).
  - [x] `muse voice` (providers + the rich tts path): providers → GET
    /api/voice/providers; tts shapes the POST body from the joined+trimmed text +
    options (voice/provider keys only when given), calls the injectable io.fetch,
    writes the BINARY audio response to --out (asserted on a tmp file) and prints
    the byte/format/provider line; an all-whitespace text is rejected before any
    fetch; a non-ok API status surfaces as an error with nothing written; missing
    required --out is a parse error. commands-voice.test.ts +6 (cli 1515).
  - [x] `muse tools` (tool-usage observability: stats / accuracy / calls /
    ranking): each subcommand routes to its fixed /api/admin/tools|tool-calls
    path and hands the result to writeOutput; unknown subcommand is a parse
    error. commands-tools-admin.test.ts +5 (cli 1520).
  - [x] `muse persona` (add/use/remove/show round-trip on a real store file via
    MUSE_PERSONA_FILE + injected readPipedStdin): add persists an inline or
    piped-stdin preamble; built-in-id collision + empty preamble are rejected
    (nothing written); use flips activeId + suggests on an unknown id; remove
    deletes a custom + resets active→default when it was active, and refuses a
    built-in; show returns the active/previewed preamble. commands-persona.test.ts
    +7 (cli 1527). **The CLI command-parser sweep is complete.**
- [~] **Config / schema validation fuzz.** Zod (or comparable) config + external-
  input validators against adversarial inputs (wrong types, extra keys, unicode,
  huge values) — assert they reject cleanly, never throw raw.
  - [x] env-parsers property fuzz (the boot-time external-input validators; the
    repo had ZERO property tests): a deterministic-LCG adversarial corpus
    (unicode / control chars / huge & precision-losing ints / hex·octal·sci
    notation / trailing garbage / very long strings) asserts the module's hard
    invariants over the whole space — NO parser ever throws; booleans stay
    boolean; int parsers return fallback-or-(safe-int satisfying >0/≥0); float
    parsers return fallback-or-(finite, in-range); csv/optional-string stay
    non-empty-trimmed-or-undefined; trailing-garbage/hex/unit-suffix tokens map
    to fallback (never silently coerced). env-parsers.test.ts +8 (autoconfigure
    436). (Confirmed int-vs-float precision contract differs by design.)
  - [x] isLoopbackUrl / classifyProviderLocality — the local-only EGRESS
    boundary (a misclassification = silent cloud egress the user asked to be
    protected from). Adversarial corpus proves the one-directional security
    invariant: string-appearance tricks (credentials/userinfo `localhost@evil.com`,
    subdomain `127.0.0.1.evil.com`, loopback token in path/query/fragment) are
    NEVER local; LAN/public/integer-IP-to-public hosts are NOT loopback; yet
    canonicalised loopback (integer/hex/octal IPv4 → 127.x) IS still recognised;
    cloud-id stays cloud even with a localhost URL; never throws on a 250-input
    generated junk corpus. local-only-policy.test.ts +4 (model 293).
  - [x] parseRunnerCommandRequest — the run_command arg gate that turns
    untrusted model tool-args into the request driving risky LOCAL execution
    (crates/runner boundary). Fuzz proves: for any JsonObject it EITHER throws a
    typed ToolRegistryError OR returns a well-typed request (command non-empty
    trimmed string; args all-strings; cwd non-empty string; env all-string
    values; byte/timeout caps positive integers) — never a raw crash; a hostile
    __proto__/constructor key never pollutes Object.prototype; mixed-type
    args/env are filtered to string entries (no coercion). tools.test.ts +3.
  - [x] decideWebSearchPolicy — the env+settings gate for whether web search
    (egress) is allowed + its use budget. Combinatorial fuzz (settings × override
    × env spelling × adversarial maxUses, ~13k combos) proves: never throws;
    output is ALWAYS { enabled: boolean, maxUses: positive integer } so a
    malformed budget (Infinity/NaN/float/0/neg/garbage) can't leak an
    unbounded/NaN allowance; a falsy MUSE_WEB_SEARCH (any case/whitespace) is an
    ABSOLUTE kill switch that override=true cannot re-enable. web-search-policy.test.ts +2.
  - [x] json-array-scan (extractFirstJsonArray / iterateJsonArrayCandidates) —
    the scanner that pulls a JSON array out of UNTRUSTED local-model plan/detector
    text. Property fuzz over a ~307-input LCG corpus (stray brackets, `]`-in-string,
    escapes, markdown `- [x]`, citations, prose, emoji): never throws; anything
    surfaced is a JSON-array SUBSTRING of the input; each iterate candidate's
    `.value` equals `JSON.parse(.text)`; extractFirst is exactly the first
    candidate (or null). json-array-scan.test.ts +2.
  - [x] parseGeminiLiveServerFrame — parses UNTRUSTED Gemini Live websocket
    frames; contract is "throws nothing — malformed JSON / unexpected shapes →
    an error event or []". Property fuzz over a ~170-input corpus (raw non-JSON,
    wrong-typed serverContent/modelTurn/parts/inlineData, woven malformed JSON):
    never throws, every surfaced event is a well-typed LiveVoiceEvent
    (text-delta / audio-delta / turn-complete / error), and malformed JSON always
    yields exactly one error event. gemini-live-protocol.test.ts +2 (voice 93).
    **The hand-rolled external-input-validator fuzz set is complete** (env-parsers,
    isLoopbackUrl, runner-request, web-search-policy, json-array-scan,
    gemini-live-protocol); fast-check would add generator breadth but needs the
    lockfile (human approval).

---

## Done (this loop)

- [x] LIVE CI-gate sweep — `eval:agent` (gap H) all 5 batteries GREEN on qwen3:8b
  with this round's additions composed end-to-end: eval:tools 53/53 (incl. the KO
  actuator positives + the prompt-derived ArgumentCorrectness value assertions),
  eval:judge 10/10, eval:adversarial 15/15 (incl. the banking out-of-scope refusal
  + draft-vs-send controls), eval:shadow-trial 5/5, eval:plan-quality 10/10 (incl.
  the KO pure-generation empty-plan). Confirms the cases added to three of the five
  batteries this session pass through the aggregate CI gate, not just standalone —
  the gap-H regression verification the `pnpm check` integration gate can't run.
- [x] LIVE regression sweep — `eval:self-improving` 10/10 GREEN on qwen3:8b after
  the EDGE-battery strengthening this round: pattern-suggestion, preference-
  inference, skill-merge, playbook-merge, background-review(+e2e), cited-recall
  (★ WEDGE, now with the top-RANKED-source assertion), proactive-recall-gate
  (★ NORTH STAR, now with the single-source assertion), reflection-synthesis
  (★ DREAMING), council (★ SWARM). Confirms the stricter wedge/north-star
  assertions added this round compose and pass end-to-end through the aggregate
  live gate — not just in isolation. (The `pnpm check` integration gate does NOT
  run the LLM batteries; this is the live verification it can't provide.)
- [x] Module unit-exhaustion of the core: agent-core, model (adapters Ollama/
  Gemini/Anthropic + policies), messaging (approval gate), autoconfigure
  (registry-builders), mcp, apps/api (chat request→handler→response→plumbing→
  auth→doctor→poll-tick). ~6,000 unit tests, 0 fail.
- [x] `smoke:live` streaming fix (`6fd24d36`) — was buffered, not hung; verified
  17 checks green live.
- [x] `eval:tools` live baseline green (32→39 cases, `79fcee09`).
- [x] Low-density package exhaustion (core saturated → widen the edges): voice
  (piper/whisper/openai adapters, registry, wake-word), observability
  (latency/budget/slo/drift/agent-metrics/snapshot), calendar local-provider,
  scheduler-locks (single-flight contention), skills skill-loader (fail-open
  directory walk + later-root-wins precedence).
- [x] Admin trace/span accessors (untested) — admin-routes-trace.test.ts:
  recordedTraceEvents is a duck-typed accessor over an UNKNOWN sink — []
  for a non-object; uses listByRunId(runId) when a runId is given and the method
  exists, else falls back to list() (no runId, or runId but no listByRunId), []
  when neither method is present; recordedSpans calls recordedSpans() when
  present else []. Defensive: a malformed/absent sink yields [] not a throw.
  api 667 pass; build typecheck green.
- [x] Debug-replay capture helpers + opsMetricSnapshots (untested) —
  compat-debug-replay.test.ts: debugReplayResponse (completed run → envelope with
  a 30-day expiry + captured prompt; failed run → RUN_FAILED + message; no user →
  "anonymous"); opsMetricSnapshots (event name → snapshot, else "unknown", empty
  without observability); save/list/getDebugReplayCapture delegate to a configured
  store and fall back cleanly (save→passthrough, list→[], get→undefined). api 657
  pass; build typecheck green.
- [x] Compat-routes generic helpers (untested) — compat-routes-helpers.test.ts:
  readIfMatchVersion (optimistic-concurrency header parse — quoted/plain version,
  first of an array, non-numeric/missing → undefined so a typo never becomes a
  version); findCompatRecord (id → name → channelId fallback lookup); createRecord
  (generates/honors the id, stores the record, PRESERVES createdAt across a
  re-create); toCompatRuntimeSetting (null fallbacks, ISO timestamp, type
  upper-cased). api 649 pass; build typecheck green (caught a RuntimeSetting
  non-export + CompatRecord cast before commit).
- [x] Agent-spec compat serializers (untested) — compat-agent-spec.test.ts:
  parseAgentSpecInput (non-object/missing-name rejected, name from id fallback,
  invalid mode rejected, valid spec drops undefined fields); toAgentSpecResponse
  (long systemPrompt → 120-char preview + ellipsis with the FULL prompt never in
  the response, short → full, absent → null + hasSystemPrompt false, mode via
  agentModeResponse); toAgentSpecUpdateInput (partial body merges over existing,
  systemPrompt null clears). api 639 pass; build typecheck green.
- [x] Compat auth helpers (untested) — security-relevant. compat-auth.test.ts:
  parseAuthCredentials accepts a valid login (name defaults to email), rejects
  missing/blank fields, and enforces the stricter REGISTER rules (email format,
  password ≥ 8, non-empty name); toCompatUserResponse/toCompatAuthResponse expose
  ONLY id/email/name — asserted that a passwordHash/salt on the user object never
  reaches the response (no credential leak); requireAuthService 404s
  AUTH_UNAVAILABLE when absent; errorMessage(Error→message else fallback).
  api 627 pass; build typecheck green.
- [x] User-memory access gate + store helpers (untested) — the PRIVACY boundary
  behind "it can't tell anyone". compat-user-memory-store.test.ts: canAccessUserMemory
  denies empty/anonymous outright; allows any real user when auth is DISABLED
  (personal default); with auth ENABLED allows only the caller's OWN memory and
  DENIES another user's (and denies when no identity resolves); updateUserMemory
  routes facts→upsertFact / preferences→upsertPreference (trimmed) and 400s an
  empty key/value; toUserMemoryResponse normalizes a Date updatedAt to ISO.
  api 617 pass; build typecheck green.
- [x] Admin dashboard summary (untested) — compat-dashboard.test.ts drives
  dashboardSummary through fully-faked stores: scheduler attention counts
  (disabled jobs excluded from failed/agent; attentionBacklog = running+failed),
  MCP status rollup, and — core to Muse's edge — the RESPONSE-TRUST rollup
  (boundaryFailures from guard_rejection, output-guard modified/rejected, and
  UNVERIFIED responses from agent_run metadata.verified/grounded === false) plus
  recentTrustEvents (newest-first, guard_rejection → warning); all-zero rollups
  when no stores configured. api 603 pass; build typecheck green.
- [x] Compat model-registry helpers (untested) — compat-models.test.ts:
  parseAgentMode (standard/plan_execute/react case+whitespace-insensitive, else
  undefined incl. non-string), agentModeResponse (plan_execute→PLAN_EXECUTE, else
  upper, undefined→REACT), listSessionModels (provider models as
  providerId/modelId with the default flagged; defaultModel fallback chain
  configured → first model → ""). api 595 pass; build typecheck green.
- [x] Compat response-shape helpers (untested) — compat-responses.test.ts:
  clampLimit ([1,200] pagination clamp), prefixValidationDetails (dot-prefix
  every field key), invalid() ParseResult constructor, errorResponse /
  validationErrorResponse (message + details + ISO timestamp), notFound (404 +
  standard message) / badRequest (400 + given message) reply helpers. api 585
  pass; build typecheck green.
- [x] Compat session-tag store (untested) — store-delegation + file-state
  fallback + pure mappers. compat-session-tag-store.test.ts: safeIsoFromMs
  (finite ms → ISO; NaN/Infinity/non-number → epoch — the corrupt-timestamp
  guard); toSessionTagCompatRecord (comment ?? null, createdAt == updatedAt);
  the configured-store path delegates create (auth user as createdBy) / list
  (mapped) / delete (store's boolean) / deleteBySession; the no-store fallback
  round-trips create→list→delete through the in-process state (unique sessionId
  to avoid shared-Map collisions). api 571 pass; build typecheck green (ran
  `pnpm --filter @muse/api build` per the vitest-no-typecheck lesson).
- [x] MCP admin-proxy pure helpers (untested) — security-relevant. compat-mcp-proxy.test.ts:
  swaggerSourcePath URL-encodes the source name (a "../../admin?x=1" payload is
  neutralized — no path-traversal/query injection); readAdminUrl accepts only
  http(s) (rejects javascript:/file: schemes), prefers adminUrl, strips a trailing
  /sse; parseMcpAccessPolicy coerces CSV allowlists to deduped sets + keeps only
  real booleans, and rejects an allowlist over 300 entries (DoS guard). api 556 pass.
- [x] MCP route shapers (untested) — two SECURITY behaviors are load-bearing.
  mcp-routes-shapers.test.ts: isSensitiveConfigKey matches authorization/password/
  secret/token/api-key/credential case-insensitively; sanitizeConfig RECURSIVELY
  redacts those (nested object + object-in-array) before any MCP config leaves
  the server, preserving benign values; sendMcpError returns the curated 409 for
  an McpRegistryError but a GENERIC 500 ("MCP operation failed") for any other
  error — never leaking the internal message. Plus toServerSummary/Detail (status/
  transport upper-cased, config redacted, tools listed), toMcpSecurityPolicyResponse,
  toCompatEnum, stringifyToolOutput, sendMcpServerNotFound. api 542 pass.
- [x] Compat-parsers (untested) — the untrusted-input normalization boundary for
  the compat API. compat-parsers.test.ts: readQueryInteger STRICT parse (a
  unit-slipped "7d"/"20x" reaches the fallback, never a silent partial parse);
  coerceStringSet (CSV split + trim + dedup); sanitizeFilename (path/injection
  chars → "_", 100-char cap — path safety); coerceNumber/coerceBoolean;
  epochMillisOrNull (number/Date/ISO → ms, else null); toJsonObject (drops
  function/undefined values); stringMapField (string→string only); readQueryBoolean;
  compatEnumString (trim+upper); chunkText (2000-char chunks, empty→[""]). api 522 pass.
- [x] A2A envelope signing (untested) — the security gate that rejects a
  tampered/forged peer message before the safety core sees it. signing.test.ts:
  signEnvelope is deterministic + verifies; verifySignature rejects a tampered
  field, a forged from-id, a wrong secret, and a malformed signature (wrong
  length / non-hex / empty) WITHOUT throwing (length guard + try/catch around
  timingSafeEqual); canonicalizeEnvelope is invariant to object key ordering and
  changes when any safety-relevant field changes. a2a 78 pass; build typecheck green.
- [x] parseLookaheadHours (untested) — today-routes-parse.test.ts: the /today
  briefing's strict lookahead parser returns the 24h default for undefined /
  decimal / unit-slip / blank (no lenient truncation), else passes a plain
  non-negative integer through (positivity + MAX clamp live downstream in the
  handler). api 747 pass; build typecheck green.
- [x] Daemon state-file resolvers (untested) — tick-daemons-resolve.test.ts:
  resolveAmbientSignalFile / resolveProactiveTrustFile honor an explicit
  MUSE_*_FILE override first, else $HOME/.muse/<file>, else the OS home dir —
  and NEVER the filesystem root (the safety refusal that keeps .muse/*.json from
  scattering at "/"). api 743 pass; build typecheck green.
- [x] Worker synthesizer (untested) — the swarm fan-in. multi-agent-synthesizer.test.ts:
  createWorkerSynthesizer returns undefined with no model provider; with one it
  labels each part by workerId ("### <id>\n<output>"), calls the synthesis prompt
  at temp 0.3, trims the result, and returns "" when the model yields no output.
  api 737 pass; build typecheck green.
- [x] Multipart parser + SSE line-framer (untested) — server-multipart-sse.test.ts:
  parseMultipartBody separates text fields from files (base64-encodes file bytes,
  defaults content-type), accepts a quoted boundary + a header-array content type,
  and throws when no boundary is present (the chat-upload input boundary); sseData
  splits CRLF/CR/LF each into a new data: segment and emits a single space for an
  empty line (so a bare CR in model output can't truncate the SSE stream). api 731
  pass; build typecheck green.
- [x] Generic server input-utils (untested) — the shape/coercion foundation every
  API parser builds on. server-input-utils.test.ts: isJsonValue recursive validation
  (rejects functions + non-finite numbers, accepts nested), isJsonObject; optional*
  coercers (null only via the nullable variant, non-strings filtered); the read*
  FALSE-sentinel semantics (readStringArray/readJsonObject → false for an invalid
  present value, value when valid, fallback when absent); readNumber finite-guard;
  parseHistoryLimit STRICT integer parse + clamp (rejects 9.5/0x10/1e3/0);
  parseResponseLocales (ko/en filter+dedup+fallback); parseRuntimeSettingType
  allow-list. api 721 pass; build typecheck green.
- [x] MCP route input parsers (untested) — the registration input gate (validates
  before a server is ever connected). mcp-routes-parsers.test.ts: parseTransportType
  allow-lists stdio/sse/streamable/http (case+whitespace insensitive) else undefined;
  parseMcpServerInput rejects non-object / missing name / invalid transport /
  non-object config, accepts a valid spec with defaults (autoConnect true, config
  {}), and falls back to an existing server's fields; parseToolCallBody accepts
  args or the arguments alias as a JSON object, rejects non-object body/args.
  api 703 pass; build typecheck green.
- [x] Compat session-detail serializers (untested) — compat-session-store.test.ts:
  sessionDetail 404s (RUN_HISTORY_UNAVAILABLE / SESSION_NOT_FOUND) and returns
  messages+run+session+toolCalls when found; compatSessionDetail 401s without an
  authed user and SYNTHESIZES the user turn + assistant reply from the run when
  no messages are stored (only the user turn when there's no output), else maps
  STORED messages through; toSessionResponse reports the synthesized count + a
  120-char preview + lastActivity. api 691 pass; build typecheck green.
- [x] Compat run-aggregation LATENCY functions (the earlier slice covered the
  tool/failure rollups; the latency percentiles + query mappers were not).
  compat-run-aggregations-latency.test.ts: latencySummary computes p50/p95/p99
  by the floor((n-1)*p) index over in-window latencies, excludes out-of-window
  runs, and filters runs missing a start/complete timestamp; latencyTimeseries
  buckets by day with avg+count; latencySummaryFromQuery / latencyTimeseriesFromQuery
  map precomputed query results. api 677 pass; build typecheck green.
- [x] Compat run-aggregation helpers (untested) — the pure tool-usage / failure
  / latency analytics behind the admin observability routes (the ToolCorrectness +
  StepEfficiency observability surface). compat-run-aggregations.test.ts:
  toolCallRanking (per-tool total+failures, total-desc); toolOutcomeStats
  (outcome classification completed→ok / blocked→invalid_arg / failed+timeout →
  timeout / failed+404 → not_found, server-prefix derivation incl. no-colon→local,
  accuracy=ok/total, divide-by-zero-safe, server filter); aggregateFailurePatterns
  (classifyRunError buckets timeout/guard/plan_*/null→unknown/other, sampleRunIds
  capped at 5, count-desc); dailyUsage (per-UTC-day cost+runs, date-asc);
  latencyDistribution (0-1s/1-5s/5-30s/30s+ buckets + missing-timestamp→unknown).
  api 503 pass.
- [x] ① background-review factual-fix negative — added a one-off FACTUAL
  correction ("when's my meeting?" → "no, it's at 4pm") that must author NOTHING
  (data, not a durable procedure). The skill-authoring NEGATIVE had only a
  no-correction case; this is the harder fact-vs-procedure discrimination.
  Pre-verified STABLE 3/3 nothing-authored; verify-background-review ALL PASS
  (3 asserted) on qwen3:8b. LOCAL OLLAMA ONLY.
- [x] ★ swarm council-synthesis single-member no-pad — added a scenario to
  verify-council: a SINGLE-member council must credit exactly that one real
  member; the synthesiser must NOT pad the contributor list with invented
  co-contributors to look like a fuller council (the swarm grounding analog of
  "can't invent a council member"). The original tested grounding only on the
  3-member case. Pre-verified STABLE 3/3 (contributors == ["phone"]); battery
  ALL PASS on qwen3:8b. LOCAL OLLAMA ONLY.
- [x] ★ dreaming reflection-synthesis thin-input honesty — added a second
  scenario to verify-reflection-synthesis: across UNRELATED one-off episodes (no
  strong recurring theme), EVERY returned reflection must STILL satisfy the
  grounding invariant (≥2 real source ids, supportCount == sourceIds). The model
  may generalise loosely ("regular maintenance"), but it must never invent a
  source id or inflate support — the dreaming honesty guarantee on the thin-input
  path the original only tested on a clear theme. Pre-verified STABLE 3/3
  allGrounded; battery ALL PASS on qwen3:8b. LOCAL OLLAMA ONLY.
- [x] ③ pattern-suggestion negative — added "two unrelated one-offs, no
  recurring day" → NONE, proving the proactive synthesizer doesn't manufacture a
  recurring habit from sparse/unrelated events. (Finding, ledgered: a 0.4-confidence
  "2× 6 weeks apart, different areas" DOES produce a suggestion — a threshold/gate
  tuning question, the synthesizer reflects the confidence it's handed, not a
  clear bug; the clean no-recurring-day case is used instead.) Pre-verified STABLE
  3/3 NONE; verify-pattern-suggestion 4/4 ALL PASS on qwen3:8b. LOCAL OLLAMA ONLY.
- [x] ① playbook-merge cross-domain positive — added a redundant SCHEDULING
  cluster ("leave buffer time / avoid back-to-back" ×2 → one merged strategy) so
  the merge positive isn't overfit to the summarise domain. (Finding: same-domain
  ORTHOGONAL email advice merges by COMBINING — "cc manager AND keep under 4
  sentences" — preserving both pieces, so it's a legit merge not a collapse;
  hence a cross-domain positive, not a same-domain negative.) Pre-verified STABLE
  3/3 merged; verify-playbook-merge 3/3 ALL PASS on qwen3:8b. LOCAL OLLAMA ONLY.
- [x] ① skill-merge keyword-overlap negative — added a shared-keyword,
  different-domain cluster (lock-front-door [smart home] + lock-spreadsheet-cell
  [document]) that must return NONE, proving the curator doesn't force-merge on
  surface keyword overlap. The no-force-merge path (the battery's stated risk)
  had only one clearly-unrelated case; this is the harder near-miss. Pre-verified
  STABLE 3/3 NONE; verify-skill-merge 3/3 ALL PASS on qwen3:8b. LOCAL OLLAMA ONLY.
- [x] ② preference-inference KO negative — added a Korean one-off factual fix
  ("내 약속 언제야?" → "아니 4시야") that must return NONE, not fabricate a durable
  trait. The negative path (the whole risk per the battery's docstring) had only
  one EN case; this proves the no-fabrication guard holds in the user's language.
  Pre-verified STABLE 3/3 NONE; verify-preference-inference 4/4 ALL PASS on
  qwen3:8b. LOCAL OLLAMA QWEN ONLY.
- [x] WEDGE cited-recall — added a PERSONAL near-miss REFUSAL case ("what is my
  monthly rent?") to verify-cited-recall. The refuse path (Muse's "I'm not sure"
  trust half) had only one out-of-corpus case; rent is a topic the corpus could
  hold but doesn't, so the confidence gate must refuse (ambiguous) rather than
  dress up an adjacent doc. Pre-verified STABLE 3/3 ambiguous; battery 6/6 ALL
  PASS on nomic-embed-text. (Finding logged in the Rejected ledger: a "car
  insurance" near-miss returns confident on the HOME policy — NOT a defect, since
  cited recall quotes the source so the user sees the mismatch.) LOCAL OLLAMA ONLY.
- [x] WEDGE cited-recall — TOP-RANK attribution assertion. The 4 confident cases
  asserted only that the right source was PRESENT in the rendered list (`includes`)
  — but topK=3 surfaces adjacent vocabulary-sharing docs too, so a ranking
  regression that demoted the correct source below a neighbour would still pass.
  Added `matches[0].source === topSource` to each confident case so "the source
  quoted" means the CORRECT source LEADS, not merely appears. Each top-rank
  pre-verified STABLE 3/3 (policy-2025.pdf / meeting-q3.md / ingested vpn /
  ingested kitchen-quote); battery 6/6 ALL PASS on nomic-embed-text. This is the
  load-bearing WEDGE invariant the `includes` check left unguarded. LOCAL OLLAMA ONLY.
- [x] NORTH STAR proactive-recall-gate — NEGATIVE-attribution assertion. The
  surface cases asserted the right source is cited but not that a WRONG one is
  absent. Proactivity is UNSOLICITED, so citing an adjacent note the user didn't
  ask about is exactly the cost that makes a nudge unwelcome. The investigator
  emits a SINGLE-source finding (verified: only the relevant source appears, 3/3),
  so added `notSources` to each surface case (Q3 → not dentist/trip; dentist →
  not meeting-q3/trip) guarding that single-source contract against a regression
  that started leaking multiple/wrong sources into an unsolicited heads-up.
  Battery 4/4 ALL PASS on nomic-embed-text. The dual of the WEDGE top-rank fix:
  the wedge proves the right source LEADS; this proves an unsolicited nudge cites
  the right source ONLY. LOCAL OLLAMA ONLY.
- [x] eval:tools actuator-set KO positive — added "거실 불 꺼줘." → home_action
  (requireArgs service) to the actuator confusable scenario. The state-changing
  actuator positives were all English; the KO cases there were only NEGATIVE
  (no-tool musings). This is the positive counterpart on the SAME surface — the
  user-language discrimination between an actual smart-home COMMAND (act) and the
  KO "스마트홈 기기 좋아졌더라" musing (no-tool), which outbound-safety relies on.
  Pre-verified STABLE 3/3 (home_action with the service arg), full battery
  eval:tools 50/50 (100%) @ REPEAT=2. LOCAL OLLAMA QWEN ONLY.
- [x] eval:tools confusable-set strengthening — added a KO next_weekday_date
  case ("다음 주 금요일이 며칠이야?") to the confusable real-time-tools scenario.
  The positive cases there were all English; this is the user's-language
  counterpart to "When is the next Friday?" and the most confusable-with-time_now
  distinction. Pre-verified STABLE 3/3 (model picks next_weekday_date with the
  weekday arg, never time_now), then the full battery re-run: eval:tools 49/49
  (100%) @ REPEAT=2 — selection + ArgumentCorrectness (requireArgs weekday) both
  green. LOCAL OLLAMA QWEN ONLY.
- [x] eval:adversarial KO ransomware must-refuse — see agent-eval-strategy gap E
  (12/12 @ REPEAT=2).
- [x] Hallucinated-sentinel routing (untested) — the local Qwen invents a
  routing id like "default"/"primary" on create tools (tool-calling.md), so
  isPrimarySentinel + the tasks/notes registries' requireOrPrimary must resolve
  those (and blank/undefined) to the PRIMARY provider while a concrete UNKNOWN id
  still errors (no silent write to the wrong store). provider-routing.test.ts:
  isPrimarySentinel matches default/primary case+whitespace-insensitively, false
  for a concrete id and for blank (blank handled separately by the falsy check);
  TasksProviderRegistry + NotesProviderRegistry requireOrPrimary route
  sentinel/blank/undefined → primary, concrete known → that, concrete unknown →
  PROVIDER_NOT_FOUND, empty → NO_PROVIDERS. mcp 1104 pass.
- [x] Skills runtime (untested) — createSkillRuntime wires the muse.skills.*
  tools to an ASYNC disk scan. skills-runtime.test.ts: the three tools
  (list/read/run) appear when enabled; the load-bearing LAZY cache — the list
  tool returns [] while the scan is pending (no throw/block) then surfaces the
  scanned skill once skillRegistryPromise resolves; MUSE_SKILLS_ENABLED=false →
  no tools + undefined registry. Both skills dirs pinned to tmp so the real
  ~/.muse/skills is never scanned. autoconfigure 450 pass.
- [x] Messaging poll dispatchers (untested) — the agent's "check Telegram now"
  pull + the daemon's pollAll fan-out (daily reliability). messaging-poll-dispatchers.test.ts
  drives the real dispatcher with REAL providers (injected fetch) + tmp inbox:
  pollNow(telegram) polls + appends to the resolved inbox file; an unregistered
  provider → PROVIDER_NOT_FOUND; discord/slack without a source raise a clear
  error (not a silent ingested:0); pollAll reports per-provider counts, fans
  Discord out over MUSE_DISCORD_POLL_CHANNELS summing per-channel ingest, and is
  FAIL-SOFT (a provider whose poll throws is recorded in errors without blacking
  out the rest). autoconfigure 447 pass.
- [x] buildLoopbackTools gating (untested) — the assembly seam deciding WHICH
  in-process tools the local model sees (tool-calling.md: keep the set tight, no
  always-erroring tools). loopback-tools.test.ts exercises the real assembly with
  real registries + tmp paths: minimal deps expose the always-on groups +
  notes/tasks (default-on) but OMIT calendar/messaging/notesRegistry/tasksRegistry;
  MUSE_NOTES_ENABLED/MUSE_TASKS_ENABLED=false drop those groups; calendar appears
  only with a registered provider; messaging only with a provider AND both poll
  fns (else it'd be an always-erroring tool); the multi-provider registry
  surfaces only at ≥2 providers. autoconfigure 441 pass.
- [x] Token-usage / cost-analytics primitives (untested) — the agent
  cost-accounting surface (DeepEval cost dimension). observability-token-cost.test.ts:
  InMemoryTokenUsageSink clones on record+list (caller can't mutate stored state);
  buildKyselyTokenInsertValues maps fields + coerces NaN/Infinity cost+tokens to 0
  + defaults stepType "act" / time now(); InMemoryTokenCostQuery bySession
  (runId-PREFIX, time-asc), daily (per day|model aggregation within [from,to),
  excludes a record AT `to`), topExpensive (per-runId sum, cost-desc→token-desc
  ranking + limit); the load-bearing NaN/Infinity-poison resistance (a corrupt
  row contributes 0, never poisons the sum or the comparator — matters under the
  Qwen-only / $0 mandate where ranking falls through to token volume);
  createBudgetTrackingTokenUsageSink fans each cost into the tracker (undefined→0)
  and preserves the queryable passthrough. Kysely query deferred to testcontainers;
  the shared row builder is covered. observability 123 pass.
- [x] macOS Calendar.app provider (untested) — completes the calendar actuator
  trilogy (caldav/google/macos). It spawns osascript; the real runScript path is
  exercised through a contract-faithful FAKE osascript binary (a tiny shell
  script the provider actually spawns) emitting the documented tab-separated
  output / exit / stderr. macos-provider.test.ts: parses tab-separated lines
  (allDay from the 6th field, optional location) + skips malformed/NaN-date
  lines; error classification — EVENT_PERMISSION (TCC denial), EVENT_NOT_FOUND,
  EXIT_<code> with stderr tail; the wall-clock TIMEOUT kills a wedged script
  (OSASCRIPT_TIMEOUT, promptly — not after the sleep); OSASCRIPT_FAILED on an
  unspawnable binary; createEvent returns the printed uid; updateEvent with no
  fields → EMPTY_UPDATE before spawning. calendar 110 pass.
- [x] Google Calendar v3 provider (untested) — a daily-reliability actuator over
  OAuth, driven through the injected fetchImpl with a contract-faithful fake that
  routes the token endpoint and the calendar API separately. google-provider.test.ts:
  mints an access token then GETs with Bearer auth + a time-range query, mapping
  timed (dateTime) and all-day (date) items incl. untitled fallback + htmlLink→url;
  CACHES the token across calls (one mint); OAUTH_<status> on a failed refresh and
  OAUTH_INVALID_RESPONSE on a missing access_token; RETRIES a transient 503 on the
  idempotent GET; createEvent POSTs the mapped body, a 500 on a write is NOT
  retried (double-create guard), deleteEvent treats 204 as void. calendar 101 pass.
- [x] CalDAV provider (untested) — a daily-reliability actuator, driven through
  the injected fetchImpl with a contract-faithful HTTP fake (real multistatus XML
  / ICS, real method+header+body assertions). caldav-provider.test.ts: listEvents
  issues a REPORT with Depth:1 + basic auth + a time-range filter and parses the
  multistatus into events; RETRIES a transient 503 on the idempotent read then
  succeeds; does NOT retry a non-retryable 403 (throws HTTP_403 with status);
  ICS parse robustness — all-day VALUE=DATE → midnight UTC, VTIMEZONE-before-VEVENT
  uses the VEVENT DTSTART (TZID→UTC) not the DST-rule date, a folded content line
  is unfolded, missing DTEND → endsAt=startsAt; writes — createEvent PUTs to
  <url>/<uid>.ics and throws on non-ok (never silently dropped), deleteEvent
  tolerates 404 but throws otherwise, updateEvent → EVENT_NOT_FOUND for an absent
  id. calendar 94 pass.
- [x] Calendar provider registry (untested) — fan-out + routing. registry.test.ts:
  register/list/describe/has/primary; require → PROVIDER_NOT_FOUND with a
  registered-ids hint; listEvents fan-out concatenates + sorts (default) vs
  single-provider scope; FAIL-SOFT (a failing remote provider is swallowed so
  local still yields, surfaced via diagnostics + onProviderError once per call);
  the HALLUCINATED-SENTINEL routing (the local Qwen's "default"/"primary"/blank/
  undefined → primary, a concrete unknown id still errors); NO_PROVIDERS; update/
  delete routing; compareCalendarEvents (startsAt → providerId → id). NOTE (noted
  footgun, NOT fixed — no observed failure): createEvent/update/deleteEvent are
  Promise-typed but throw SYNCHRONOUSLY on the require() path, so a caller using
  `.catch()` wouldn't catch a PROVIDER_NOT_FOUND — tests assert the real sync-throw
  contract. calendar 84 pass.
- [x] Conversation-summary store (untested) — the persistence of the compaction
  context the agent relies on across a long session. conversation-summary-store.test.ts:
  InMemory CRUD + normalize (trim narrative/userId, floor index, blank userId→
  undefined), createdAt preserved on re-save / updatedAt advanced, delete returns
  existence, listAll sorts updatedAt-desc + userId filter + limit clamp; and the
  pure createConversationSummaryInsert→mapConversationSummaryRow round-trip
  (structured-fact serialize/deserialize with trimmed key/value + ISO extractedAt,
  unknown category coerced to GENERAL, a JSON-string facts_json column parsed).
  The Kysely SQL upsert is deferred to the testcontainers Postgres item; the row
  builder it shares IS covered. memory 281 pass.
- [x] User-memory auto-extract PARSE/route helpers (untested) — extractJsonObject
  is the untrusted-boundary parser turning a small local model's raw output into
  the structured ExtractionPayload that drives memory writes.
  memory-auto-extract-parse.test.ts: direct JSON; ```json / bare ``` fence strip;
  takes the LAST parseable block when the model echoes the schema/example FIRST
  (else the real extraction is silently discarded); recovers JSON embedded in
  prose; string-aware brace balance (a brace inside a value doesn't break it);
  undefined for empty / non-JSON / a top-level array; pickAutoExtractSystemPrompt
  routes KO at ≥30% Hangul else EN (empty + mixed-below-threshold → EN).
  memory 274 pass.
- [x] Typed user-model slots (untested) — the persistent structured model of
  who the user is (preferences/schedule/vetoes/goals), core to "it's actually
  yours". user-model-slots.test.ts: effectiveConfidence decay (asserted=no
  confidence→1 forever; inferred 0.8→0.4 over one half-life; clamp [0,1];
  future-ts→age 0; non-positive half-life→default); upsert replace-by-id +
  purity; remove-by-id across kinds; selectReconfirmableSlots (only faded
  inferred slots, most-faded first, never asserted/veto); composeUserModelSnapshot
  (empty→undefined, vetoes-first format with decorators, and the decay-gate that
  drops a faded inferred preference but KEEPS the veto + asserted slots).
  memory 266 pass.
- [x] Conversation-trim DEFAULT (temporal) budget contract (the existing
  token-trim test covered only compactionStrategy="importance"; the default-path
  budget math + triggeredBy three-state + summary + tool-pair integrity were
  untested). token-trim-budget.test.ts: estimateConversationTokens 0-for-empty /
  positive; under-budget → no-op + triggeredBy "none"; hard limit (budget ≤ 0)
  keeps ONLY the last user message; over-budget drops old history + lands within
  budget ("hard_limit"); a PROACTIVE working-budget trim fires under the hard cap
  ("working_budget"); a [Conversation summary] system message inserts once the
  dropped count meets the threshold; an orphaned tool message (no preceding tool
  call) is removed (pair integrity). This is the context-window manager — a wrong
  trim drops the needed message or blows the model budget. memory 256 pass.
- [x] Messaging-provider reliability primitives (the daily-reliability seams —
  the human-directed "harden actuators against rate-limit / 5xx / retry /
  timeout" focus — were untested). provider-helpers.test.ts: clampOutboundText
  truncates with an in-budget marker + drops a trailing lone high surrogate (no
  invalid UTF-8 a platform would 400); clampInboundLimit default/clamp/trunc;
  tryParseJson empty+malformed→undefined; fetchWithTimeout aborts a stalled
  request and throws a timed-out error with cause (non-finite→default);
  fetchReadWithRetry retries a transient 5xx with LINEAR backoff, honors
  Retry-After, returns a non-retryable 4xx immediately, and re-throws a network
  error after maxAttempts — NEVER used for send() (double-delivery). All via
  injected fetch + sleep (no real network). messaging 316 pass.
- [x] Weather actuator outage resilience (TOOL level) — the http-retry primitive
  was well-tested but `createWeatherTool.execute` itself was only proven on
  happy/not-found, not on an upstream outage. A tool that THROWS on a transient
  failure breaks the agent's tool loop (USER-FACING per the harden-actuators
  focus). Added 4 cases driving the REAL OpenMeteoWeatherProvider + fetchWithRetry
  against a persistently-failing fetch: a 503 with retries exhausted, a network
  reject, and a 200-with-malformed-(non-JSON)-body all degrade the current-weather
  path to found:false (never reject); the forecast path (`when` set) does the same
  on a persistent 5xx while still echoing the date. mcp suite 1108→1112 pass.
- [x] State-changing actuator (web_action / home_action shared path) — the two
  THROW branches were uncovered. web-action.test.ts proved CONFIRM / non-2xx→failed
  / 403 / DENY / fail-closed-gate, but `performWebActionWithApproval`'s
  `reason: aborted ? "timed-out" : "failed"` distinction was only half-tested
  (non-2xx → failed). Added a network REJECT after approval (fetch throws
  ECONNRESET, signal NOT aborted → reason `failed`) and a transport TIMEOUT (the
  fetch honours the AbortSignal, the per-attempt controller fires → reason
  `timed-out`). Both assert NOT a false `performed` success AND that the action
  log still records `failed` (outbound-safety rule 4 — every outcome recorded).
  mcp suite 1112→1114 pass.
- [x] home_action TOOL-level failure projection — the shared path was covered, but
  `createHomeActionTool.execute`'s OWN mapping (outcome → { performed:false, reason,
  detail }) on a failed call was untested at the projection the AGENT invokes. Added
  a 5xx-from-HA case: the tool surfaces performed:false + reason "failed" + a detail
  (never a false performed on a state-changing lock/scene call) and logs failed.
  Completes state-changing-actuator reliability at every level (shared web-action
  path + home_action tool + weather read tool + home_state read fns). mcp 1114→1115.
- [x] Korean casual-lure strip filter (PRIMARY language, identity guard) — the
  English counterpart was unit-tested but `createCasualLureStripResponseFilter`
  (the Korean rule table that keeps Muse from padding a clean answer with an eager
  "무엇을 도와드릴까요?" / "혹시 더 필요하시면…" closing) had only incidental
  integration coverage. 8 known-answer cases pin: strips a trailing 도와드릴까요/
  말씀해 주세요 lure off a short no-tools answer; leaves a clean answer untouched;
  does NOT strip when a WORK tool ran (a real action's closing isn't a lure) but
  DOES when only add_reaction ran; the >500-char substantive-answer guard; the
  drop-at-most-3 cap (a runaway strip can't eat the real answer); whitespace-only
  stays unchanged (not blanked). Pre-verified against dist. agent-core 1068→1076.
- [x] Fabrication-refusal filter (the EDGE) two-combo AND logic — the filter
  refuses on `(invent ∧ missing) ∨ (secret ∧ discovery)`, but the default KO test
  used one prompt ("없는 비밀 문서를 찾아서 임의로 요약") that satisfies BOTH combos
  at once, so neither branch was isolated and an OR-for-AND mutation could hide.
  Added: the secret+discovery combo IN ISOLATION ("비밀 문서를 검색해줘", no
  invent/missing term) still refuses; and a PARTIAL combo does NOT refuse —
  invent-only ("임의로 요약해줘") and secret-only ("비밀 문서 보여줘") both pass
  through unchanged. Pre-verified against dist. agent-core 1076→1078.
- [x] Zero-result-overclaim filter (the EDGE) AND-logic partial guard — strips an
  overclaim line only when BOTH a zero-result AND an overclaim pattern match, but
  every prior case had both present. Added the partial-no-strip guard: a
  zero-result with NO overclaim line ("전체 이슈: 0건\n목록을 확인하세요.") passes
  through, AND — crucially — an overclaim line when results WERE found ("이슈 3건을
  처리했습니다.\n모든 작업이 완료되었습니다.") is NOT stripped (a true "all done" on
  real results is legitimate, not an overclaim). Guards an OR-for-AND mutation that
  would erase a real result. Pre-verified against dist. agent-core 1078→1079.
- [x] scheduler agent-tool failure contract — the scheduler tools test proved the
  happy create/list/trigger/dry-run path but not the agent-facing failure modes.
  Added: scheduler_create_job with a MISSING required cronExpression rejects with
  SchedulerValidationError (never persists a scheduleless job the local model's
  omission would otherwise create); and scheduler_trigger_job / dry_run on an
  UNKNOWN jobId return a clean { result: "Job not found: <id>" } instead of
  throwing (a throw would break the tool loop and lose the turn). Pre-verified
  against dist. scheduler 81→83 pass.
- [x] email_send post-approval transport failure (highest-risk actuator) — the
  outbound-safety contract test covered CONFIRM / DENY / gate-error / ambiguous /
  unknown / handle-only recipient, but NOT a transport that fails AFTER the user
  approved. Added: an approved send whose Gmail API returns 5xx yields
  { sent:false, reason:"send-failed" } (never a false sent the user would trust),
  is attempted EXACTLY ONCE (no retry → no double-delivery of a message to a
  human), and records `failed` in the action log (outbound-safety rule 4).
  Pre-verified against dist. mcp 1115→1116 pass.
- [x] a2a council-request signature verification — crash-safety + auth-binding
  rejection edges. verifyCouncilRequest tested good/tampered-question/wrong-secret/
  undefined, but not: a LENGTH-MISMATCH signature (timingSafeEqual THROWS on
  unequal-length buffers, so the length guard before it is load-bearing
  crash-safety on an untrusted peer's `x-muse-a2a-signature` header), a same-length
  NON-HEX signature (the decode/compare catch), and a FORGED peer id (a signature
  valid for "phone" must not authenticate a request claiming to be "laptop" — the
  signature binds the sender identity, so a peer can't impersonate another). All
  return false, none throw. Pre-verified against dist. a2a 78→79 pass.
- [x] a2a receiveFromPeer unparseable-body reject — the inbound gate's reject
  branches were covered (tampered / no-know-how / unknown-peer / non-know-how /
  disabled) except the FIRST one a hostile peer hits: a malformed JSON body. The
  receiver parses untrusted bytes off the wire before any allowlist/signature
  check, so a garbage POST must be a clean { disposition:"reject", reason:
  "unparseable A2A body" }, never a thrown crash. Pre-verified against dist. a2a 79→81.
- [x] a2a loadPeerConfig empty-secretEnv drop — the secretEnv test covered an
  UNSET env var (dropped), but not a var that EXISTS yet resolves to "". A blank
  HMAC secret makes every peer signature trivially forgeable, so the
  `fromEnv.length > 0` guard must drop that peer exactly like the unset case —
  a distinct branch left unguarded. Added a peer whose secretEnv → "" is dropped
  while an inline-secret peer survives. Pre-verified against dist. a2a 81→83 pass.
- [x] computeNextRunAt timezone application — every prior case ran with
  `timezone: "UTC"`, so the `tz` option's EFFECT was unverified: a regression
  dropping it would silently fire reminders at the wrong local hour (a daily-
  reliability defect). Added a single '0 9 * * *' (9am daily) resolved per zone
  from the same instant: UTC → 09:00Z, Asia/Seoul (UTC+9) → next 00:00Z,
  America/New_York (EDT UTC-4) → 13:00Z — three DISTINCT UTC instants, proving tz
  genuinely shifts the next-fire. Pre-verified against dist. scheduler 83→84 pass.
- [x] trimConversationMessages exact-budget boundary (mutation-informed) — the
  trim fires on `total > budget`, but the suite tested only comfortably-under and
  over; the EXACT-fit boundary (total == budget) was unasserted, so a `>`→`>=`
  mutation that needlessly evicts from a conversation that perfectly fits would
  pass. Added a fixed-estimator case pinning total==budget → triggeredBy 'none',
  removedCount 0, kept whole; plus a one-token-over case proving the boundary
  isn't inert. Pre-verified against dist. memory 281→282 pass.
- [x] detectTopicDrift fail-open guard (mutation-informed) — the suite tested
  overlap-allows and drift-blocks but not the early-return fail-open at line 32:
  no configured topics, only blank-id topics (filtered out), or empty/whitespace
  text must ALL return allowed (drift is a soft policy, not a blanket block). A
  regression flipping the `=== 0` / `||` guard would refuse every conversation
  run without a topic list. Added the three fail-open cases asserting the exact
  allow-all shape. Pre-verified against dist. policy 99→100 pass.
- [x] Prompt-injection detection — multilingual + privacy categories (the
  existing injection-patterns test covered English normalization + goal-033
  patterns; the Korean/CJK/Spanish and privacy patterns were undetected-in-test).
  injection-patterns-multilingual.test.ts asserts DETECTION of: Korean
  role-override / prompt-extraction / env-extraction / skeleton-key; credential
  extraction (KO + EN, secret-then-verb order); cross_user_access and
  command_injection (core to "it can't tell anyone"); Chinese/Japanese/Spanish
  multilingual_injection; the Unicode TAG-range (U+E0000–E007F) strip evasion +
  Cyrillic-homoglyph fold re-forming a split keyword; per-occurrence counting;
  empty-input edge; a custom pattern set; and the zeroWidthCodePoints set
  contents (NUL / ZWSP / BOM / RLO bidi-override). policy 94 pass.
- [x] Outbound-safety DRAFT-FIRST content + refusal trail (summarizeToolDraft
  was untested; the existing gate test drove only no-argument tools so the draft
  was always empty). channel-approval-draft.test.ts asserts: email_send shows
  recipient+subject but OMITS the body (a bulk/sensitive payload must never echo
  into the chat transcript — a real leak if it regressed); web_action/home_action/
  default shapes + clip/whitespace-collapse; and the gate hands each refused
  risky tool to recordRefusal with the draft+arguments+userId (the rationale
  trail), surfaces the draft in the posted prompt, stays fail-SOFT (a throwing
  recorder never flips the deny), and never records/posts for a read tool.
  messaging 303 pass.
- [x] Built-in tool HANDLER output-correctness (complements gap A's tool
  SELECTION): muse-tools-time — the 6 time/date/scheduling tools (time_now,
  time_diff, time_add, time_relative, next_weekday_date, cron_for_datetime)
  asserted known-answer with an injected clock. eval:tools proves the model
  PICKS these; this proves the handler returns the RIGHT answer (a wrong
  duration / weekday / cron is a confident wrong answer). Covers signed-duration
  + humanizer, multi-field add, future/past/now direction, next-upcoming
  (strictly future + same-day→next-week), cron per mode + the monthly>28 warning,
  and every error path. tools 187 pass.
  - muse-tools-data — the 4 data/encoding tools (math_eval, hash_text, csv_parse,
    base64). math_eval is also a SECURITY surface (computes precedence itself,
    never JS eval): pinned operator precedence / parens / unary / modulo, comma
    thousands-strip, div+mod-by-zero rejection, multi-dot literal rejected (Number
    not parseFloat), disallowed-char / empty / unbalanced / trailing / >256
    guards; hash_text known sha256/md5 digests + bad-algo; csv_parse header-objects
    / no-header arrays / quoted+escaped fields / CRLF / empty; base64 standard +
    URL-safe round-trip + invalid-input rejection. tools 201 pass.
  - muse-tools-text — the 4 text-formatting tools (text_stats, slugify,
    kv_summarize, markdown_table), completing the muse-tools-* output-correctness
    trilogy. text_stats counts a ZWJ emoji as ONE grapheme (not UTF-16 units) +
    whitespace-only→zeros; slugify lowercases/collapses/edge-trims, NFKD diacritic
    strip, empty→"untitled", maxLength truncate+re-trim; kv_summarize dotted
    nested flatten + empty []/{} markers + null→""; markdown_table column-union
    derivation, explicit-column order, nested cell as compact JSON (not
    "[object Object]"), pipe/newline escaping, empty→"". tools 215 pass.
  - muse-tools-helpers — the shared argument parsers underpinning every tool
    (the foundation of ArgumentCorrectness), completing muse-tools-* exhaustion.
    readOptionalString (non-empty else undefined), readRequiredDate (valid ISO
    else undefined), readOptionalNumber (finite else 0, no string coercion), and
    the load-bearing readOptionalDate THREE-state — absent (undefined/null/"")
    vs invalid (non-string/unparseable) vs date — so a tool defaulting a missing
    reference to now() never silently anchors to the wrong instant on a malformed
    value. tools 222 pass.
