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

- [ ] **Mutation testing baseline (StrykerJS).** 6,000 green tests prove
  *coverage*, not that the assertions *catch bugs*. Run Stryker on 2–3
  high-value packages (`agent-core`, `model`, `policy`) to get a mutation score;
  file the surviving-mutant hotspots as follow-up. NOTE: adds a devDep + config —
  needs human OK for the lockfile change before committing tooling; until then,
  do it as a throwaway local measurement and record the score here.
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
