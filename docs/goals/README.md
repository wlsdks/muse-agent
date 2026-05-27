# Goals

The self-driving backlog for the autonomous iteration loop.

The loop **never stops, never asks a human for work, never
completes**. It fires every ~20 min, ships one commit, repeats
forever. The loop sets its own outward direction.

Read these every iteration, in order:

1. **[`.claude/rules/iteration-loop.md`](../../.claude/rules/iteration-loop.md)**
   — the authoritative contract (5 rules up top).
2. **[`OUTWARD-TARGETS.md`](OUTWARD-TARGETS.md)** — the loop's
   self-directed north star + target map (loop owns/evolves the
   *direction*; honesty machinery is immutable).
3. **[`CAPABILITIES.md`](CAPABILITIES.md)** — the only success
   metric (append-only; every goal adds one green automated check).
4. `MEMORY.md`.

This file is just the backlog table + ledger. The definitions,
procedure, falsification rule, regression sweep, and immutable core
live in the contract — don't restate them here.

## Backlog (append/flip-only)

Add ≤1 row, flip status of goals you touched; never reorder, never
delete an open row, never rewrite another goal's status.

The done-history (goals 373–603) is archived in
[`archive/BACKLOG-through-603.md`](archive/BACKLOG-through-603.md).
Append new rows below; the table starts fresh from this reset.

| #   | Goal | Category | Status |
| --- | ---- | -------- | ------ |

## Rejected ledger (so fresh agents don't re-mine)

Append one line when a discovery path is evaluated and deferred:
`- <area> — iter <hash> — deferred: <reason>`

- sibling-registry unknown-id dead-end errors — iter 472 — fully
  discharged by 476: every sibling registry (`@muse/voice`
  472, `@muse/messaging` 473, `@muse/calendar` 474, `@muse/mcp`
  tasks-providers 475, `@muse/mcp` notes-providers 476) now
  appends `registeredHint` and is mutation-proven. No remaining
  package carries the hint-less dead-end; entry closed.
- smoke:live picker model speed — iter a147d939 — deferred: owner's
  Ollama-only picker fix confirmed working (real `/api/chat`
  round-trips, HTTP 200, ~50-60s each); it prefers the largest
  local qwen (`qwen3.6:35b-a3b`) so a full 6-endpoint run exceeds a
  5-min wrapper. Future outward (Autonomy: faster loop
  self-verification): prefer a fast small qwen (e.g. `qwen3:8b`)
  for smoke:live, or shard endpoints. Not slice-3 scope.
- web Playwright e2e infra — iter (375 s3) — deferred: no
  playwright.config / e2e harness exists in `apps/web` (only the
  dev-dep). Standing up config + browser install + seeded-API
  harness is its own infra task; the right-sized verified check for
  375 s3 was the `App.test.tsx` MuseConsole render assertion. A
  future outward goal can build the e2e harness if a real failure
  motivates it.
- smoke:live local-Qwen nondeterminism — iter (377 s2) — observed,
  not a regression: smoke:live ran real round-trips (owner picker
  fix works) 10 pass / 3 fail. The 3 (chat strict tool-loop didn't
  emit `time_now`; native web_search 0 citations / "no web tool";
  notes.search picked a different note) are small-local-model
  behaviour on endpoints goal-377 does NOT touch (the inbound
  daemon is off without `MUSE_INBOUND_REPLY_ENABLED`); the agent
  path P1-b2 depends on PASSED live (`/api/chat — direct answer`,
  `plan_execute (live)`). A future Autonomy goal: make these three
  CAPABILITIES checks robust to local-model variance (prompt
  hardening / model-capability gating), or tag them
  `[UNVERIFIED-LIVE]`. Not 377-scope.
- P1 audit — apps/api/test/p1-seam.test.ts — PASS: P1's four
  CAPABILITIES checks pass together AND compose end-to-end —
  `startInboundReplyTick` → `respondToInbound` →
  `createThreadedInboundRunner` → channel approval gate → real
  `TelegramProvider` HTTP, with the turn-1 user+reply carried into
  the turn-2 agent run (thread continuity through the tick path)
  and a write/execute tool blocked with an in-chat approval prompt
  POSTed to the same chat. No drift; no bullet reopened. P1
  (two-way conversation on a real channel) is genuinely delivered
  for the user, not just per-piece.
- P0-b2 production embedder wiring — iter (378 s2) — deferred: the
  embedding-recall provider + cosine + paraphrase proof shipped;
  remaining child is wiring a zero-cost local-Ollama embedder into
  `createMuseRuntimeAssembly` so production episodic recall uses
  `EmbeddingEpisodicRecallProvider`. Next 378 slice — kept separate
  from the provider so neither half is half-shipped.
  (RESOLVED 378 s3: production embedder wired, fail-open; P0-b2
  parent flipped.)
- P0-b3 production investigator wiring — iter (378 s4) — deferred:
  the investigate-and-surface mechanism (proactive loop accepts an
  injected investigator, appends the finding to the unasked notice,
  fail-open) shipped + integration-verified; remaining child is a
  real production investigator (a notes/tool lookup keyed off the
  imminent item) wired into the daemon's assembly. Next 378 slice —
  kept separate so neither half is half-shipped.
  (RESOLVED 378 s5: createNotesInvestigator over the primary notes
  provider wired into tick-daemons; P0-b3 parent flipped.)
- clampPositive lenient-parseInt vs strict parseInteger — iter 464
  — deferred (NOT a bug): `provider-utils.clampPositive` ("every
  MUSE_*_LIMIT/CAPACITY/TOPK knob") uses lenient `Number.parseInt`
  ("5x"→5) while the sibling `env-parsers.parseInteger` (414/444)
  is strict. Looks like a 463-class sibling, BUT
  `provider-utils.test.ts` explicitly pins the leniency
  ("lenient prefix parse", "pins behaviour vs a future Number()
  refactor") — a deliberate human design decision. Not changed:
  the loop must not override a deliberate tested choice
  (no-manufacturing). Revisit only on an explicit human call to
  unify the two env-int parsers.
- KyselyLatencyQuery vs InMemory divergence — iter 443 — deferred:
  in-memory `computeDurationMs` clamps negative durations to 0 and
  `matchesLatencyFilter` uses `startsWith`, but the Kysely SQL
  passes negative `ended_at - started_at` through and uses `LIKE`
  (metachars). Real sibling-asymmetry but Testcontainers/PG-gated
  to verify; not unit-provable here. Take when a PG harness runs.
- relative-time compound/decimal durations — iter 441 — deferred:
  `resolveRelativeTimePhrase` accepts "in half an hour" but rejects
  "in 1.5 hours" / "in 2 hours 30 minutes" (probe, iter 440). A
  genuine (b)-refinement of the existing grammar, not new surface;
  deferred this iter only to avoid same-area churn right after the
  440 due-date fix (Step-8). Next free non-time iteration may take it.
  (RESOLVED: 445 delivered decimal notation "in 1.5 hours" /
  "in 2.5 days"; 452 delivered two-unit compound
  "in 2 hours 30 minutes" / "in 1 day 6 hours". Discovery fully
  discharged — three-or-more-pair chains intentionally out of
  scope, not a dangling promise.)
- P0 audit — packages/agent-core/test/p0-seam.test.ts — PASS: P0's
  four CAPABILITIES checks pass together (agent-core 555 incl.
  auto-extract-tool-turn / episodic-recall-embedding /
  clarify-directive; `@muse/mcp` 375 incl. notes-investigator +
  proactive-loop) AND compose end-to-end through the real pipeline:
  a tool-turn fact stored under the run's userId (b1) is recalled
  on a LATER zero-token-overlap request via `applyUserMemory`
  wholesale injection (b2 — wording never gates it), `applyUserMemory`
  → `applyClarifyDirective` run in the live agent-runtime order so
  clarify stays silent on a well-specified request yet still steers
  an under-specified first turn to ask while the injected user
  memory remains present (b4 composes with knows-you, neither
  transform suppresses the other). b3 (proactive
  investigate-and-surface) re-run green on its own surface (the
  proactive daemon). No drift; no bullet reopened. P0 (knows-you ·
  anticipates · asks) is genuinely delivered end-to-end.
- P2 audit — apps/api/test/p2-seam.test.ts — PASS: P2's two
  CAPABILITIES checks pass together (`@muse/api`
  proactive-notice-delivery.test.ts — bare notice POST + real
  dedupe [b1]; prepped-doc POST [b2]) AND compose into one
  non-spammy real-channel flow: with a real `LocalDirNotesProvider`
  + `createNotesInvestigator` wired into `runDueProactiveNotices`
  over a real `TelegramProvider` HTTP, tick 1 POSTs the imminent
  announcement + the prepped "Related notes: …" doc (decoy
  excluded) to the real Bot API, and ticks 2 & 3 (item still
  imminent, investigate-appended body differs) produce ZERO
  re-POSTs — the real dedupe sidecar is item-derived not
  body-derived, so the composed flow honours the P2 "not noisy"
  quality bar. No drift; no bullet reopened. P2 (proactive
  delivery proven on a real channel) is genuinely delivered
  end-to-end.
- P3-b1 production wiring — iter (382) — deferred: the gated
  perception→run-context injection mechanism (`applyAmbientContext`
  + `resolveAmbientSnapshot`, fail-open, untrusted-field
  sanitised, opt-in only) shipped + unit/integration-verified in
  `@muse/agent-core`. Remaining: wire it into the live
  agent-runtime context pipeline behind an opt-in option AND a
  gated osascript-backed perception daemon, then flip P3-b1 with
  the mandated surface check (an ambient change measurably alters
  a subsequent agent answer — integration). Next 382 slice — kept
  separate so neither half is half-shipped (377 s1 / 378 s2,s4
  no-flip-mechanism precedent).
  (RESOLVED 382 s2: `applyAmbientContext` + `resolveAmbientSnapshot`
  wired into the live agent-runtime pipeline behind an opt-in
  `ambientSnapshotProvider`; ambient-context-runtime.test.ts proves
  an ambient change alters a subsequent answer; off by default.
  smoke:live ran a real Qwen round-trip = 9 pass / 4 fail, the
  pre-existing ledgered local-Qwen nondeterminism on endpoints
  this change provably does not touch — no `ambientSnapshotProvider`
  is wired in `apps/api`, so the gated-off path is byte-identical
  pre/post (apps/api 170 deterministic tests green via pnpm check);
  not a regression, not [UNVERIFIED-LIVE] (round-trip executed).
  P3-b1 flipped.)
- P3 audit — packages/agent-core/test/p3-seam.test.ts — PASS: P3's
  one CAPABILITIES check passes (`@muse/agent-core`
  ambient-context.test.ts + ambient-context-runtime.test.ts, 9/9)
  AND the target works as one end-to-end flow — the seam for a
  single-bullet target is ambient-vs-the-rest. p3-seam.test.ts
  drives the real `createAgentRuntime`: with ambient enabled
  alongside a user-memory provider, BOTH the `[Ambient Context]`
  and `[User Memory]` blocks reach the model (appendSystemSection
  merges, no clobber); a throwing ambient provider degrades the
  run (no ambient block) but never breaks it — fail-open proven
  through the real runtime, not just the unit resolver — with
  other context still intact; and with no provider there is no
  ambient block even when other context is active (privacy
  default-off survives composition). No drift; no bullet reopened.
  P3 (ambient perception loop) is genuinely delivered end-to-end.
  P0/P1/P2/P3 now all delivered + audited.
- P4 audit — packages/calendar/test/calendar-write-contract.test.ts
  + apps/cli/src/commands-listen.test.ts — PASS: P4's two
  CAPABILITIES checks re-run green together (calendar WRITE 8/8,
  voice round-trip 4/4) and each was scrutinised for "marked done
  but went sideways": P4-b1 instantiates the REAL Google / CalDAV /
  macOS providers with only the transport (fetchImpl / osascript
  spawn) faked and asserts the exact outbound request for
  create/move/cancel — not read-only, not a fake provider; P4-b2
  drives the REAL `registerListenCommand` via `parseAsync` with
  only the I/O boundaries faked and asserts every stage's data
  flowed (WAV→STT→/api/chat→TTS→played file) — full path, not a
  re-implemented pipeline. No seam test, unlike P0–P3: P4's two
  bullets are INDEPENDENT trust-closures (calendar-write trust;
  voice-round-trip trust), not a composed pipeline — a synthetic
  voice→calendar composition would need the full agent+tool+server
  stack and is an unnatural seam the bullets do not claim
  (gold-plating, which the contract bans). The faithful Step-4
  exercise for an independent-bullet target is the joint re-run +
  faithfulness scrutiny + the falsifiable-test check, all of which
  pass. No drift; no bullet reopened. P4 (close the trust-blocking
  PARTIALs) is genuinely delivered. P0/P1/P2/P3/P4 now all
  delivered + audited.
- P5 audit — packages/mcp/src/p5-seam.test.ts — PASS: P5's three
  CAPABILITIES checks re-run green together (objectives-store /
  objective-evaluation-loop / consented-action, 18/18). Unlike P4,
  P5's bullets ARE a composed delegation pipeline, so a seam test
  exercises the join end-to-end through the real on-disk stores
  with every read a fresh call (no shared in-memory = a restarted
  process / the next ~20-min tick): register a durable objective
  (b1) → restart → tick unmet → exponential backoff PERSISTED →
  restart (backoff survived) → tick met → the consented
  scoped-credential real (HTTP-faked) external action fires
  carrying the Bearer cred (b3) → restart → durably `done`; and
  the fail-closed consent gate composes with the lifecycle — no
  consent ⇒ no HTTP, the objective is NOT falsely completed and
  stays active across a restart. No drift; no bullet reopened. P5
  (durable delegated objectives / long-horizon agency) is
  genuinely delivered end-to-end. P0/P1/P2/P3/P4/P5 now all
  delivered + audited.
- P6 audit — packages/mcp/src/p6-seam.test.ts — PASS: P6's two
  CAPABILITIES checks re-run green together (action-log /
  undo-action, 9/9). Like P5, P6's bullets ARE a composed loop
  (see → undo → teach), so a seam test exercises the whole cycle
  through the real on-disk stores with every read a fresh call
  (= a restarted process): an autonomous consented action performs
  → is logged (b1) → the user reviews it → undo reverses + records
  a durable veto + logs the undo itself (b2 + b1) → "restart"
  (veto + log survive) → the same trigger recurs → the durable
  veto refuses it (no HTTP, objective not falsely completed) → the
  refusal is logged too → a final query returns the complete
  durable audit trail [refused, undo, performed] newest-first. No
  drift; no bullet reopened. P6 (accountability & correction loop)
  is genuinely delivered end-to-end. **P0–P6 now ALL delivered +
  audited** — the next iteration self-extends OUTWARD-TARGETS
  toward the north star (no human authors it).
- P7-b1 production adapter wiring — iter (390) — deferred: the
  `applyVetoAvoidance` transform is wired LIVE into the
  agent-runtime pipeline behind a duck-typed
  `VetoAvoidanceProvider` and flipped on the `createAgentRuntime`
  integration (the P3-b1 precedent). Remaining: the thin concrete
  adapter `@muse/mcp readVetoes → VetoAvoidanceProvider` wired
  into the apps/api server assembly so production runs read the
  real `~/.muse/vetoes.json`. Not required by P7-b1's stated
  integration check; a follow-up like P3-b1's real-osascript
  provider was to its flip.
  (RESOLVED 391: p7-seam.test.ts in apps/api exercises the real
  `readVetoes → VetoAvoidanceProvider` adapter through the real
  createAgentRuntime pipeline — the adapter shape is proven sound;
  only its server-assembly placement remains, a pure wiring line.)
  (FULLY RESOLVED 402: the wiring line shipped —
  `buildVetoAvoidanceProvider(env)` (autoconfigure
  context-engineering-builders, default-on, opt-out
  `MUSE_VETO_AVOIDANCE=false`, `resolveVetoesFile` →
  `~/.muse/vetoes.json`) is constructed and passed as
  `vetoAvoidanceProvider` into the production `createAgentRuntime`.
  P7's learn-from-correction was confirmed DEAD in production
  (grep: zero `vetoAvoidanceProvider` refs in apps/api +
  autoconfigure) and is now LIVE — a recorded veto surfaces
  `[Learned Avoidance]` into real `/api/chat` runs. Verified by
  veto-avoidance-provider.test.ts; no parent flip — P7-b1's bullet
  was already `[x]` on its mandated check, this discharges the
  deferred production-wiring follow-up like the P9 daemon slices.)
- P7 audit — apps/api/test/p7-seam.test.ts — PASS: P7's two
  CAPABILITIES checks re-run green together (veto-avoidance 5/5,
  personal-veto-store 5/5). Like P5/P6, P7's bullets ARE a
  composed lifecycle, but the `mcp ↛ agent-core` boundary forced
  the isolated tests apart; apps/api depends on BOTH, so the seam
  test is the one place it composes for real: the REAL `@muse/mcp`
  veto store, behind the production-shape `readVetoes →
  VetoAvoidanceProvider` adapter, driven through the REAL
  `createAgentRuntime` pipeline — no veto → recordVeto surfaces
  `[Learned Avoidance]` into a live run (b1) → queryVetoes lists
  it (b2 review) → removeVeto (b2 clear) → a subsequent live run
  no longer carries the directive (clear genuinely un-does the
  live injection, not just the proxy the boundary forced). No
  drift; no bullet reopened. P7 (learns from correction) is
  genuinely delivered end-to-end. **P0–P7 now ALL delivered +
  audited.**
- P8 audit — packages/mcp/src/p8-seam.test.ts — PASS (with a
  corrected bookkeeping drift): the audit caught that goal 392 s1
  appended P8-b1's `— 392` annotation + CAPABILITIES line + README
  "done" row but never flipped the OUTWARD-TARGETS checkbox
  (`- [ ]`, while P8-b2 was correctly `- [x]`). The capability was
  genuinely delivered — situational-briefing.test.ts re-run 5/5
  green — so this is a metric-glyph drift, exactly what the audit
  exists to catch; the checkbox was corrected `[ ]`→`[x]` (not a
  re-deliver, not a REOPEN — the check was always green). Then the
  audit proper: both P8 piece-checks re-run green together (8/8)
  and p8-seam.test.ts exercises the whole flow — the full
  situational picture (soonest-first upcoming + escalated
  "Needs you" w/ resolution + active "Still tracking", finished
  excluded) synthesised from the REAL objectives store and
  delivered intact in ONE POST over a REAL `TelegramProvider`,
  then deduped in-window by the real sidecar. No further drift; no
  bullet reopened. P8 (proactive situational briefing) is
  genuinely delivered end-to-end. **P0–P8 now ALL delivered +
  audited.**
- P9-b2 env-gated daemon-set wiring + concrete objectives
  evaluator/actuator — iter (395) — deferred: P9-b2 genuinely
  bundles (a) the situational-briefing apps/api rider, (b) both
  riders env-gated + registered in the daemon set
  (`start…DaemonIfConfigured` + ServerOptions/autoconfigure
  plumbing + server.ts), (c) a concrete production objectives
  evaluator/actuator (the LLM-ish, smoke:live-class part). Too
  coarse for one tight commit, so P9-b2 was split; child (a) —
  `startSituationalBriefingTick`, the deterministic zero-LLM
  parallel of the P9-b1 objectives rider — shipped + tested (395).
  Parent P9-b2 stays `[ ]` until (b)+(c). Honest split, the
  378-s2 / P5 precedent — no parent flip, no CAPABILITIES line
  until the parent is met end-to-end. (PROGRESS 396: child (b) done
  for the situational-briefing daemon — env-gated + registered in
  the apps/api daemon set end-to-end, ServerOptions +
  autoconfigure + server.ts + integration test. Remaining: the
  objectives daemon env-gated + a concrete agent/LLM
  condition-evaluator — the smoke:live-class (c). Parent still
  `[ ]`.) (PROGRESS 397: (c) env-gating + registration +
  `createModelObjectiveEvaluator` strict-parse + conservative
  fail-soft + `createMessagingObjectiveActuator` SHIPPED &
  deterministically verified — BUT the real-qwen3:8b dog-food
  showed the small local model does not reliably emit a parseable
  verdict, so "the evaluator decides a real objective's condition"
  is **[UNVERIFIED-LIVE]** and parent P9-b2 stays `[ ]`. The
  evaluator's safe-default means it never false-acts — it just
  defers — so shipping the wiring is safe; clearing the
  [UNVERIFIED-LIVE] (reliable small-model verdict) is the priority
  follow-up.) (RESOLVED 398: the 397 [UNVERIFIED-LIVE] was a
  dog-food request-shape bug, NOT a code gap — the script used the
  OpenAI-compat endpoint with an invalid `reasoning:false` bool
  (400) / `/no_think` (empty). Re-dog-fooded the real production
  `createModelObjectiveEvaluator` via the correct zero-think path
  (native `/api/chat` `think:false`) against the mandated local
  qwen3:8b: met-time→`{met}`, future→`{unmet}`,
  impossible→`{unmeetable,reason}` — it genuinely decides. Tag
  cleared, parent P9-b2 flipped `[x]`, CAPABILITIES line appended.
  No code change needed — the evaluator/parser were always
  correct; the prior failure was the harness.)
- P9 audit — apps/api/test/p9-seam.test.ts — PASS: P9's bullets
  ARE a composed production pipeline (env-gated daemon-set fn →
  builds concrete `createModelObjectiveEvaluator` +
  `createMessagingObjectiveActuator` → P9-b1 `startObjectivesTick`
  rider → `runDueObjectives` over the real on-disk store). All
  P9 deterministic backing checks re-run green together
  (`@muse/mcp` 17/17 evaluator+loop+store; `@muse/api` 15/15
  rider+daemon ×2). p9-seam.test.ts exercises the WHOLE chain
  composed exactly as `startObjectivesDaemonIfConfigured` wires it
  (only the model verdict — a deterministic strict-JSON stand-in;
  the live qwen3:8b decision was separately verified by goal 398's
  real round-trip — and the HTTP boundary faked): a `met` verdict
  → "✅ Objective met:" POSTed over a real `TelegramProvider` +
  the objective durably `done`; `unmet` → no POST, stays `active`
  with attempts/backoff; `unmeetable` → "⚠ Objective needs you:"
  escalation POSTed + durably `escalated`. No drift; no bullet
  reopened. P9 (the delegated-autonomy loops actually run in
  production) is genuinely delivered end-to-end. **P0–P9 now ALL
  delivered + audited.**
- P8 audit (b3/b4 re-audit) — apps/api/test/situational-briefing-daemon-imminent-seam.test.ts — PASS: the original P8 audit
  (above) predated and explicitly covered only b1/b2 (the 8/8
  piece-checks); the loop-extended b3 (400) + b4 (401) added the
  REAL task/calendar imminence grounding AFTER it. Their per-piece
  checks existed, but the actual production assembly —
  `startSituationalBriefingDaemonIfConfigured` constructing the
  `deriveBriefingImminent(tasksFile)` ⊎ `deriveCalendarBriefing
  Imminent(calendar)` union from `ServerOptions` — was unguarded:
  goal 396 tested only its env-gate/register/stop, the b3/b4 tick
  tests hand-build the union themselves. A regression dropping the
  calendar branch or mis-wiring the file would have kept every test
  green. New seam drives the real builder with a real tasksFile +
  real calendar lister and asserts the wired imminentProvider
  unions both (and is absent when neither is set). All P8 checks
  re-run green together (`@muse/mcp` 13/13 composer+loop+seam+
  derivers; `@muse/api` 11/11 tick+daemon+new-seam). No drift; no
  bullet reopened — the production code was correct, only
  unguarded; it is now guarded.
- P10 audit — apps/api/test/multi-agent-tiered.test.ts +
  scripts/smoke-live-llm.mjs "muse ask grounds … PDF" sibling
  "--tiered (live)" — PASS: P10's five slices ARE a composed chain,
  not five disconnected pieces. All piece-checks re-run green
  TOGETHER: `@muse/multi-agent` 60/60 (s1 `AgentWorker.model`
  dispatch + s2 `classifyTier` + s3 `planTieredRun` collapse/
  fail-open), `@muse/api` multi-agent-tiered 7/7 (s4 orchestrate:
  `buildTieredOrchestration` → `planTieredRun` → per-worker model →
  real `MultiAgentOrchestrator` dispatch; + `resolveTierCapacityProbe`
  collapse), `@muse/cli` 21/21 (s4 `routeAskTierModel` + the
  `--tiered` flags) + program.test.ts `muse ask --tiered` 1/1,
  `pnpm check` exit-0. The END-TO-END user flow is the s5
  `smoke:live` check: ONE `muse orchestrate --tiered` run executed two
  workers on two DISTINCT real local Qwen tiers (fast=qwen3:8b,
  heavy=qwen3.6:35b-a3b) — re-ran green this audit. The composition
  seam (`buildTieredOrchestration`: spec role → classify → plan →
  capacity-collapse → `AgentWorker.model` → orchestrator) is the
  server's exact production path, tested whole in multi-agent-tiered;
  the live check proves the CLI→server→two-real-models flow. No drift;
  no bullet reopened. P10 (tiered local-model orchestration) is
  genuinely delivered end-to-end. (P11–P16 audits pending — one per
  iteration per Step 4.)
- P11 audit — apps/cli/src/p11-email-contacts-seam.test.ts — PASS:
  P11's two bullets (read/triage/summarise + briefing-feed; gated
  send) ARE composed, not disconnected. All piece-checks re-run green
  TOGETHER: `@muse/mcp` 20/20 (email-provider read + summarizeInbox /
  unreadBriefingLine, email-send fail-closed gate, situational-briefing
  -loop unread-inbox grounding), `@muse/cli` 11/11 (commands-inbox,
  commands-email, commands-contacts surfaces). The two composition
  seams: (1) inbox-unread → P8 briefing already composes in
  situational-briefing-loop.test.ts (real EmailProvider →
  `unreadBriefingLine` → delivered brief over a real TelegramProvider);
  (2) contacts → gated send had no end-to-end home — added
  p11-seam: `muse contacts add Bob` then `muse email send --to Bob`
  over the SAME `~/.muse/contacts.json` resolves + fires on confirm,
  and TWO same-name contacts ⇒ ambiguous, NO send (never-guess holds
  end-to-end through the real CLI commands + the real store +
  `resolveContact` + the fail-closed `sendEmailWithApproval` gate). No
  drift; no bullet reopened. P11 (email read + briefing + gated send)
  is genuinely delivered end-to-end.
- P12 audit — @muse/cli weather.test.ts + @muse/mcp
  situational-briefing-loop.test.ts "grounds … forecast" + LIVE
  `muse weather` — PASS: P12's two surfaces compose. Piece-checks
  re-run green TOGETHER: `@muse/mcp` 15/15 (weather provider /
  describeWeatherCode / formatWeather / resolveWeatherLine + the
  briefing weather-grounding test), `@muse/cli` 2/2 (`muse weather`
  answer reflects the HTTP-faked forecast). Seams: (1) WeatherProvider
  → `muse weather` answer; (2) OpenMeteoWeatherProvider → the proactive
  briefing weather line (real provider, faked fetch, over a real
  TelegramProvider) — both already compose. END-TO-END live flow re-run
  this audit: `muse weather Seoul` against the real free Open-Meteo API
  → "clear sky, 27°C · feels 26°C · humidity 38% · wind 6 km/h"; "San
  Francisco" → "fog 10C" — the real geocode → forecast → format chain
  works. No drift; no bullet reopened. No new seam test (both surfaces
  already compose; a redundant test would be inward churn).
- P13 audit — @muse/mcp personal-contacts-store.test.ts + @muse/cli
  commands-contacts.test.ts + (consumption seam) p11-email-contacts
  -seam.test.ts + LIVE `muse contacts` — PASS: P13's resolver is the
  recipient-resolution backbone for outbound safety. Piece-checks
  re-run green TOGETHER: `@muse/mcp` 7/7 (store round-trip +
  `resolveContact` resolved / by-alias / exact-over-substring /
  ambiguous / unknown / empty), `@muse/cli` 6/6 (commands-contacts
  add/list/resolve + the p11 consumption seam). The consumption seam
  (a contact → gated email recipient, never-guess) already composes in
  p11-email-contacts-seam.test.ts (goal 700). END-TO-END live flow
  re-run this audit (real `~/.muse/contacts.json`): `muse contacts add
  Bob --alias Bobby` → resolve by name AND alias → "bob@example.com";
  a SECOND "Bob" → resolve is AMBIGUOUS, lists both candidates (never a
  guessed address); unknown → not-found. The never-guess rule holds
  live. No drift; no bullet reopened. No new seam test (the resolver's
  piece-checks + the existing p11 consumption seam cover it).
- P14 audit — @muse/cli commands-notes-rag.test.ts + scripts/
  smoke-live-llm.mjs "muse ask grounds an answer in a real PDF" — PASS:
  P14 (PDF/document grounding) composes both deterministically and
  live. Piece-check re-run green: `@muse/cli` commands-notes-rag 16/16
  (`extractDocumentText` pdf-parse extraction (rejects raw-byte
  structure) + `reindexNotes` PDF ingest with the PDF chunk ranked
  above a decoy via a deterministic embedder). END-TO-END live flow
  re-run this audit: `smoke:live` "muse ask grounds an answer in a real
  PDF and excludes a decoy (P14)" PASS — a real PDF reindexed via the
  real local nomic-embed-text, `muse ask` via real qwen3:8b answers
  grounded in the PDF's figure with the PDF top-ranked and the decoy
  excluded. The whole extract → reindex → retrieve(decoy-excluded) →
  grounded-answer chain works. No drift; no bullet reopened. No new
  seam test (the deterministic retrieval check + the live grounded
  answer already compose the chain end-to-end).
- P15 audit — @muse/mcp web-action.test.ts + @muse/cli
  commands-web-action.test.ts — PASS: P15 (gated agentic web action)
  composes; the fail-closed gate is contract-faithful. Piece-checks
  re-run green TOGETHER: `@muse/mcp` web-action 4/4
  (`performWebActionWithApproval`: CONFIRM → exactly one real request
  carrying the method+body + `performed` log; DENY / gate-throw /
  never-autonomous → 0 HTTP; records the actual request, never a fake
  flag), `@muse/cli` commands-web-action 2/2 (`muse web-action`
  confirm → done; deny → no HTTP, exit 1). The surface → orchestration
  → gate → HTTP chain composes in commands-web-action.test.ts (real
  command, injected gate, recording fetch); the gate semantics are
  proven contract-faithfully in web-action. The bullet's own falsifiable
  test (action → gate → only on confirm fires; absent ⇒ no external
  effect) IS the contract-faithful HTTP-fake check — no live external
  POST (that would violate the local/free + safety stance). No drift;
  no bullet reopened. No new seam test (both layers already compose).
- P16 audit — @muse/mcp smart-home.test.ts + @muse/cli
  commands-home.test.ts — PASS: P16 (opt-in Home Assistant lifestyle
  actuator) composes; every service call is fail-closed gated.
  Piece-checks re-run green TOGETHER: `@muse/mcp` smart-home 4/4
  (`buildHomeAssistantServiceCall` URL+entity_id body+Bearer+data-merge;
  `performHomeActionWithApproval` CONFIRM → one real HA service POST +
  `performed` log, DENY → 0 calls), `@muse/cli` commands-home 3/3
  (`muse home call` confirm → done; deny → no call, exit 1; malformed
  `domain.service` → no call). The HA request builder → the shared
  `performWebActionWithApproval` gate → CLI surface chain composes; no
  live external HA call (real device + safety + local-only — the
  contract-faithful recording-fetch IS the named check). No drift; no
  bullet reopened. **P11–P16 (the human-authored actuator-breadth map)
  is now ALL delivered + audited; P0–P16 complete + audited.** The loop
  extended the map (P17 — conversational actuation) per OUTWARD-TARGETS.
- P17 audit — apps/api p17-{email,web-action,home-action}-tool-agent-seam.test.ts
  + @muse/cli actuator-tools.test.ts + @muse/autoconfigure
  autoconfigure.test.ts — PASS: P17 (conversational actuation)
  composes end-to-end. Piece-checks re-run green TOGETHER: the three
  apps/api seam tests (706/707/708) each drive a REAL `createAgentRuntime`
  run where the model emits email_send / web_action / home_action →
  CONFIRM fires one real send/request/HA-POST, DENY/ambiguous ⇒ 0; the
  @muse/cli actuator-tools 6/6 (env→toolset selection; every actuator
  execute-risk; a REAL agent run web_action CONFIRM→1 / DENY→0,
  mutation-proven). Audited the previously-UNCOVERED composition seam —
  `createMuseRuntimeAssembly({extraTools})` → personal exposure policy →
  `planForContext` — and locked it: an execute-risk actuator injected via
  `extraTools` is exposed to the model ONLY under `localMode` (the
  `muse ask --with-tools --actuators` path) AND only when relevant to the
  prompt; without `--actuators` (no localMode) it stays hidden (fail-safe).
  The build-tools → assembly registry → exposure-policy → gated-execute
  chain composes as one `muse ask --with-tools --actuators` user flow; no
  live LLM call (deterministic provider; HTTP-faked). No drift; no bullet
  reopened. **P0–P17 complete + audited.**
- P18 audit — @muse/autoconfigure p18-seam.test.ts — PASS: P18 (web
  control of the user's real logged-in Chrome) composes end-to-end. The
  two bullets shipped separately — read-first perception (750/751) and
  gated state-changing action (752) — so the audit proves they COMPOSE
  in ONE web-control run through the whole real stack:
  `createChromeDevToolsMcpServer` → `McpManager.toMuseTools()` →
  `withChromeDevToolsRisk` → `ToolRegistry` → `createAgentRuntime` +
  `toolApprovalGate`. In a single run the agent calls
  `chrome-devtools.take_snapshot` (read → gate ALLOWS → reaches the
  browser) then `chrome-devtools.fill_form` (re-stamped write →
  gate DENIES → `callTool` NEVER fires); both risk classes hit the gate
  in the same run. Piece-checks re-run green TOGETHER: @muse/mcp
  chrome-devtools-mcp 9/9 + @muse/autoconfigure chrome-devtools-agent-run
  / chrome-devtools-gated-action / p18-seam 5/5. No live LLM (deterministic
  provider; transport-faked). No drift; no bullet reopened.
- P19 audit — @muse/mcp p19-seam.test.ts — PASS: P19 (daily-harden the
  one-of-each actuators) composes with its real consumer. 753 added
  retry-with-backoff to the weather provider; the seam proves it
  COMPOSES with `resolveWeatherLine` (the proactive-briefing path) —
  a transient 503 on geocoding now yields a weather line instead of
  the briefing silently dropping it, and the WITHOUT-retry case
  (`retries: 0`) returns `undefined` (the exact gap 753 closed), so
  the retry is load-bearing not cosmetic. Piece-check re-run green
  TOGETHER: p19-seam + weather-retry 10/10. Contract-faithful fake
  fetch; no live LLM. No drift; no bullet reopened. (P19's bullet is
  "one actuator"; further actuators — email/contacts/smart-home — are
  follow-on hardening slices, not reopened scope.)
- P20 audit — @muse/autoconfigure p20-seam.test.ts — PASS: P20's two
  bullets — Knowledge (multi-doc RAG with citation, 754/755) and
  Perception (ambient signal → proactive notice, 756) — both deliver
  in one realistic assistant setup without interference. The seam runs
  ONE scenario: a `createAgentRuntime` with `knowledge_search` over a
  LIVE temp-dir notes corpus answers grounded AND cites
  `notes/health.md`, then `runAmbientNoticeTick` fires a proactive
  notice through a real `ProactiveNoticeSink` from a simulated
  active-window signal. Piece-checks re-run green TOGETHER: @muse/mcp
  ambient-notice-loop 6/6, @muse/agent-core knowledge-recall-agent
  5/5, @muse/autoconfigure knowledge-corpus-live + p20-seam 5/5. Also
  the 10th-iteration regression sweep: full `pnpm check` green across
  all 26 workspace suites (the unit/integration CAPABILITIES checks);
  smoke:live deferred — no request/response path changed since the
  retarget, so no live round-trip to re-run. No drift; no bullet
  reopened. **P18–P20 complete + audited.**
- P21 audit — apps/api p21-seam.test.ts — PASS: P21 (web-watch,
  "monitor this page and ping me when X") composes end-to-end for the
  user. The seam threads the user's literal `MUSE_WEB_WATCH_CONFIG`
  string through the FULL chain — `webWatchesFromConfig` parse →
  `createHttpSnapshot` HTTP-GET (778) → `detectWatchTrigger` (776) →
  `createWebWatchRunner` baseline (777) → `startWebWatchTick` daemon
  sink (779) → a real `MessagingProviderRegistry` — over a
  contract-faithful page transitioning `processing → shipped →
  shipped`: the user is pinged EXACTLY ONCE on the rising edge with
  their configured title+message, none while steady; and the SAME env
  registers the production daemon (disabled/empty → not). Composition
  mutation-proven: breaking the daemon sink's `title: text` render →
  the seam's text assertions fail. Piece-checks re-run green TOGETHER:
  @muse/mcp web-watch + web-watch-runner + web-watch-config 13/13,
  apps/api web-watch-tick 4/4, p21-seam 2/2. Read-only watch (never
  submits — outbound-safety holds). No drift; no bullet reopened.
  Follow-on (not reopened scope): the authenticated-page snapshot
  source (Chrome-DevTools-MCP background page) for watches behind a
  login. **P21 complete + audited.**
- regression sweep (10th feat-iter) — iter f7acef7b..HEAD — PASS:
  every CAPABILITIES-line check green via `pnpm check` (runtime-state
  26 · tools 158 · agent-core 719 · mcp 837 · multi-agent 63 ·
  scheduler 62 · autoconfigure 282 · api 327 · cli 1307 — ~3.8k
  tests, 0 fail). No regression. The broad `smoke:live` gate is NOT a
  per-line check and remains the known-slow deferred item (a147d939):
  ~50-60 s/round-trip × multi-endpoint exceeds the wrapper window;
  confirmed still returns 200s, not a code regression. Tagged
  [UNVERIFIED-LIVE] for this sweep; restoring a fast smoke:live
  (shard endpoints / per-request timeout) stays the deferred Autonomy
  follow-up.
- P22 audit — ea4d4af9 — PASS: all 13 P22 bullets re-verified together
  (commands-daemon.test.ts 28/28 green) AND exercised as ONE real
  end-to-end user flow against the BUILT CLI (apps/cli/dist):
  `muse daemon --init --provider log` wrote daemon.json →
  `muse daemon --status` (no flags) read "log" back and reported
  proactive/followup/objectives enabled → `muse daemon --install`
  wrote a plist that passed `plutil -lint: OK` → `muse daemon --once`
  fired the imminent task (proactive 1/1) with all five ticks running
  and a clean `daemon --once complete`. The pieces compose; no drift,
  no bullet reopened. (Note: the audit run used provider=log — local,
  no third-party send — and read the real ~/.muse/followups.json, a
  benign local delivery.)
- P23 audit — f5fdf210 — PASS: both P23 check files re-run together
  green (agent-core knowledge-recall-agent 7/7 + autoconfigure
  knowledge-recall-sources 7/7) AND exercised as ONE end-to-end flow
  with REAL Ollama embeddings (not the fake): knowledge_search over a
  corpus with a semantic decoy + an exact-token chunk ("TKT-5512")
  recalled the exact-token chunk AND ranked it first under
  nomic-embed-text + hybrid RRF. Engine (P23-1) + corpus wiring (P23-2)
  compose; no drift, no bullet reopened.
- MMR live paraphrase-dedup reliability — iter 10a05881..HEAD —
  deferred: live nomic-embed jitter flips the thin MMR margin
  run-to-run, so real-paraphrase dedup is not reliably deterministic;
  MMR kept as a best-effort diversity nudge (deterministic on exact
  duplicates). Reliable paraphrase-dedup would need a cosine-threshold
  near-dup collapse, not MMR — not pursued (low value vs. complexity).
- P24 audit — 15f01486 — PASS: P24 check re-run green
  (knowledge-recall-agent 8/8: cosine + hybrid + MMR) AND exercised
  end-to-end with REAL Ollama embeddings — one knowledge_search call
  composed hybrid recall (P23) + MMR diversify (P24): it recalled the
  exact token "TKT-7781" and returned topK without error. The two
  budget paraphrases both appearing at topK=3 matches the
  honestly-documented P24-2 finding (real-paraphrase dedup is
  best-effort, not guaranteed) — claims match reality, no drift, no
  bullet reopened.
- P25 audit — 9daf0fe3 — PASS: P25 check re-run green
  (commands-daemon 29/29) AND exercised end-to-end through the BUILT
  CLI with real Ollama + real notes: `muse daemon --once`
  (MUSE_BRIEFING_RELATED_KNOWLEDGE_ENABLED, app=Notes ambient signal,
  notes dir holding q3-budget.md + a parking decoy) delivered to the
  log sink: "Heads up: You opened Notes — Related: [notes/q3-budget.md]
  The Q3 budget memo is due Friday …" — the full chain (ambient
  perception → real hybrid+MMR enricher → the right real note →
  enriched notice) composes. No drift, no bullet reopened.
- regression sweep (20th feat-iter) — iter d5aeb747..HEAD — REPAIRED
  then PASS: `pnpm check` caught a real regression — a raw NUL byte
  (0x00) in `packages/agent-core/src/knowledge-recall.ts:165` (the
  hybrid-path key separator introduced with P23-1), which compiled +
  worked but violates goal-227 byte hygiene (no raw control bytes in
  tracked source); the shared package test flagged it. Fixed by
  writing the separator as the escaped backslash-u-0000 form (identical
  runtime key). Full sweep then green across all workspaces (agent-core
  721, mcp 837, cli 1317, api 327, autoconfigure 283, shared 30, … 0
  fail), lint 0/0. The sweep did its job.
- P26 audit — afa5327e — PASS: P26 check re-run green (commands-daemon
  32/32) AND exercised end-to-end through the BUILT CLI — one
  `muse daemon --once` ran all SEVEN ticks; the three configured
  (proactive, reminders, ambient) each fired and delivered to the log
  sink ("📋 P26 audit task due in 5 min", "P26 audit reminder",
  "Heads up: You are in Slack"), while web-watch/objectives/home-watch/
  followup correctly skipped (no config/model), clean exit. The new
  reminders + home-watch ticks compose with the rest; no drift, no
  bullet reopened.
- P27 audit — 14935389 — PASS: P27 check re-run green (commands-daemon
  36/36) AND exercised end-to-end through the BUILT CLI — one
  `muse daemon --once` (MUSE_BRIEFING_ENABLED, with a due task + an
  active objective + a contact whose birthday is today) delivered ONE
  brief composing the imminent task ("- in 5 min: Submit the Q3
  report") and the objective status ("- watch the deploy until green")
  in a single digest. Birthday (P27-2) and calendar (P27-3) inclusion
  are each pinned by their slice smoke. No drift, no bullet reopened.
- P28 audit — adc15e7c — PASS: P28 check re-run green (knowledge-recall
  9/9) AND exercised end-to-end at the knowledge_search tool surface —
  a 4-chunk corpus ranked s1>s2>s3>s4 rendered in edge-loaded order
  "s1 s3 s4 s2" (best s1 first so citation is preserved; 2nd-best s2 at
  the far edge; order differs from pure relevance). Edge-loading
  composes through the real tool; no drift, no bullet reopened.
- P29 audit — 99f34ee3 — PASS: P29 check re-run green (commands-daemon
  38/38) AND exercised through the BUILT CLI — `muse daemon --once
  --print` echoed the delivered proactive notice to stdout
  ("📨 @me: 📋 P29 audit echo due in 5 min") alongside the tick
  summary, clean exit. Foreground observability composes; no drift, no
  bullet reopened.
