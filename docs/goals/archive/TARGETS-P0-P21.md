# Outward Target Map — the loop's self-directed north star

The loop sets and evolves its own direction. **No human authors
this; no human is asked.** A human only intervenes by issuing a
direct command. Until then the loop decides what "outward" means,
using its own judgement and best-practice knowledge of what a
great personal AI assistant does.

## North star (the feel, autonomously pursued — never the literal name)

Muse is a personal AI assistant in the spirit of the assistant
from the Iron Man films: it **proactively speaks first** based on
context (schedule, events, patterns, follow-ups) AND **responds
instantly and completely the moment it is addressed**, running the
full agent loop to finish the task — not a command parser, a
companion that acts.

Two qualities define every outward goal:

- **Proactive** — Muse initiates from real context before being
  asked.
- **Instantly responsive & complete** — when addressed, it answers
  now and carries the task to done end-to-end.

## Audited reality — 2026-05-18 (don't rebuild SOLID; CLOSE the gaps)

Evidence audit of the codebase. Read before selecting: do not burn
iterations re-doing proven ground — the outward work IS the gaps.

**SOLID & live-proven — do NOT rebuild (extend only if a gap needs
it):** agent run-loop / strict tool-loop / plan-execute, multi-agent
orchestration, guards + PII/injection fail-close, ToolApprovalGate
(fail-closed on throw), runner sandbox, local-file + local-calendar
/ tasks actuation via real-LLM tool calls, episodic-summariser infra.

**The JARVIS gap = actuation breadth + trust-at-the-edges, NOT core
depth.** Muse is a strong agent you *invoke*; not yet a companion
that *converses and perceives on its own*. The targets below are
the audited gaps, ranked by how much each separates Muse from a
JARVIS you'd depend on daily.

## Self-directed target map (the loop OWNS and EVOLVES this)

Each `- [ ]` bullet below is one **deliverable unit** — the
metric. The loop pursues the highest-priority target with an
unmet bullet and flips `- [ ]`→`- [x]` ONLY when a green,
non-`[UNVERIFIED-LIVE]` `CAPABILITIES.md` line whose check is a
`smoke:live`/`smoke:broad`/integration id exercising that bullet's
named user surface (never a unit-only test) delivers that exact
bullet end-to-end, annotated with the closing commit's short hash.
A bullet is too coarse for thin work to satisfy — that is the
point. The loop **may extend or reorder** bullets when its
best-practice judgement finds a stronger outward direction (record
why in `## Decisions`), and may **split** a bullet only if the
parent stays `[ ]` until ALL children are met (no flipping a
trivially-met sub-bullet to game the metric). It may NOT relabel
inward churn as a flip, weaken the outward test, or skip the check.

**P0 — Knows-you · anticipates · asks** — FOUNDATIONAL: the
assistant essence. A channel chat (P1) or a proactive ping (P2) is
hollow if it doesn't know you and what you'd want. **Priority:
interwoven with P1 (P1 is only the interaction substrate); P0
precedes P2+. The loop works P0 next once P1's in-flight slice
lands.**
- [x] Auto-extract wired into the API agent runtime AND on
  tool-using turns (today REPL-only / `toolsDisabled`-only) so the
  user model grows from real use. Check: a tool-using API turn
  produces a stored memory (integration). — 378 s1
- [x] Recall is embedding-similarity (not Jaccard) AND a stored
  preference is actually applied to a later answer. Check: state a
  preference → differently-worded later request → the answer
  reflects it (integration). — 378 s3 (all split children met; see
  378 Decisions. "notes RAG already has cosine" was stale:
  `loopback-notes.ts` deliberately avoids embeddings.)
  - [x] Embedding-similarity episodic-recall provider + cosine —
    a zero-token-overlap paraphrase recalls the right memory that
    Jaccard structurally misses. — 378 s2
  - [x] Production assembly wires a zero-cost local-Ollama embedder
    into `StoreBackedEpisodicRecallProvider` (default-on; fail-open
    to Jaccard if Ollama is down). — 378 s3
  - [x] A stored preference is applied to a differently-worded
    later request — already true by design: `applyUserMemory`
    injects all prefs wholesale into the system prompt for any
    userid run (not query-matched), so wording never gates it.
- [x] From current context (calendar / inbox / patterns) the agent
  infers a likely UNSTATED need, autonomously investigates it
  (tool / web / notes), and surfaces the finding unasked. Check:
  seeded context → an investigated, relevant surfacing without
  being asked (integration/smoke). — 378 s5 (both split children
  met; see 378 Decisions.)
  - [x] Investigate-and-surface mechanism: the proactive loop
    accepts an injected investigator, runs it on the imminent
    item, and appends the finding to the unasked notice (fail-open
    if it throws). — 378 s4
  - [x] Production investigator wired: `createNotesInvestigator`
    over the primary notes provider, wired into the proactive
    daemon — the notice surfaces "📎 Related notes: …" for the
    item's topic, unasked. — 378 s5
- [x] On an ambiguous / under-specified request the agent asks a
  clarifying question instead of guessing, and offers ("shall I
  X?") when it detects a likely-wanted action. Check: ambiguous
  input → a clarifying question, not a hallucinated action
  (integration). — 378 s6 (conservative detector + clarify-directive
  transform wired LIVE into the agent-runtime pipeline)

*Quality bar (not a bullet — not objectively checkable):* the
anticipation must feel timely and not noisy; graded inside P0/P2
work, never shipped as a standalone goal.

**P1 — Two-way conversation on a real channel** — THE gap. Audit:
*not implemented at all*; every inbound path (telegram-poll,
channel-poll, LINE webhook) only `appendInbound`s to soft context
for the next user-initiated `/api/chat`. Muse can message first
but cannot converse back. Drive to fully-delivered FIRST.
- [x] An inbound consumer drains the messaging inbox and invokes
  the FULL agent runtime (`agentRuntime.run`) per inbound message —
  not append-to-soft-context. Check: integration inbound→run→reply.
  — 377 s2
- [x] The result is sent back over the same channel via the
  messaging registry. Check: a `smoke` exercising inbound→reply on
  one provider (contract-faithful HTTP fake or real) asserting the
  outbound POST — never a fake registry. — 377 s3
- [x] Thread context carries across turns on the channel (the chat
  IS a Muse session). Check: multi-turn inbound retains context.
  — 377 s4
- [x] Risky actions prompt for in-chat approval before executing.
  Check: approval gate exercised over the channel path. — 377 s5

**P2 — Proactive delivery proven on a real channel** — Audit:
well-engineered (dedupe, quiet-hours, Phase-D synth) but EVERY
firing test injects a fake registry; unit-only, cannot count per
the CAPABILITIES surface-check rule.
- [x] Proactive / followup / reminder daemon delivers to a real
  (or contract-faithful HTTP-faked) channel; check asserts the
  message was POSTed to the channel API, not a fake registry.
  — 380 (runDueProactiveNotices over a real TelegramProvider HTTP
  fake: asserts the Bot API URL + chat_id + notice text, and the
  real dedupe sidecar suppresses a re-POST)
- [x] Anticipatory prep ("meeting in 15 min — here's the doc")
  rides this path (ties to P1). — 380 (real `LocalDirNotesProvider`
  → `createNotesInvestigator` → `runDueProactiveNotices` → real
  `TelegramProvider` HTTP: the POST carries both the imminent-item
  announcement AND the prepped "Related notes: …" doc, decoy
  excluded)

**P3 — Ambient perception loop** — Audit: only `muse glance`, a
manual one-shot CLI print, macOS-only, never reaches the agent.
- [x] A gated perception daemon periodically snapshots ambient
  signals (screen / clipboard / active app / notifications) and
  injects them as run context unasked. Check: an ambient change
  measurably alters a subsequent agent answer. — 382 s2
  (`applyAmbientContext` + `resolveAmbientSnapshot` wired into the
  live agent-runtime context pipeline behind an opt-in
  `ambientSnapshotProvider`; integration proves a window change
  between two runs changes the answer; off by default. smoke:live
  ran a real Qwen round-trip (9 pass / 4 fail = the ledgered
  local-Qwen nondeterminism, README §Rejected; not a regression —
  no `ambientSnapshotProvider` is wired in `apps/api` so the
  request/response path is byte-identical for the smoke path))

**P4 — Close the trust-blocking PARTIALs** — audit-identified;
required before Muse can be delegated to unsupervised. (User-model
partials — auto-extract wiring, embedding recall — moved up to P0
as the "knows-you" foundation.)
- [x] Calendar WRITE (create/move/cancel) across Google / CalDAV /
  macOS exercised by a surface check (contract-faithful HTTP fake),
  not read-only. — 384 (calendar-write-contract.test.ts: real
  providers, only the transport faked — Google create POST/move
  PATCH/cancel DELETE w/ Bearer+JSON; CalDAV create PUT/move
  REPORT→PUT/cancel DELETE w/ Basic+ICS; macOS create+cancel over
  the real osascript spawn asserting the AppleScript)
- [x] Voice end-to-end round-trip has an automated check
  (mic→STT→agent→TTS pipeline; STT/TTS mockable, full path).
  — 384 (commands-listen.test.ts drives the real
  `registerListenCommand` Phase-C push-to-talk action: faked mic
  spawn → STT → /api/chat → TTS → playback, asserting each stage's
  data actually flowed end-to-end)

**P5 — Durable delegated objectives (long-horizon agency)** — the
"trust over time" gap: turns "an agent you invoke" into "a
assistant you delegate to". A standing objective is not a one-shot.
- [x] A user can register a standing objective ("watch for X / keep
  trying Y until Z / tell me when W") that survives process restart
  and the ~20-min boundary as durable state. Check: register →
  restart → still tracked (integration). — 386 (personal-objectives
  -store: atomic fsync+rename, tolerant/corrupt-quarantine read,
  idempotent register; integration proves register → fresh read
  with no shared in-memory = post-restart → still tracked)
- [x] It is autonomously re-evaluated on a tick with backoff and
  either fires its action when the condition is met or escalates
  when unmeetable — never silently dropped. Check: condition flips
  → action fires + marked done; unmet → backoff retry (integration).
  — 386 (runDueObjectives: met→act→durable done; unmet→exponential
  backoff; unmeetable / attempts-exhausted→durable escalated +
  escalate sink; fail-open; integration over the real on-disk store)
- [x] Acting on an objective uses the user's *scoped* service
  credentials under recorded consent (the act-as-the-user
  prerequisite, shared with P4). Check: an objective performs a
  real (HTTP-faked) external action via a scoped credential with
  consent recorded. — 386 (personal-consent-store +
  performConsentedAction: fail-closed — no/scope-mismatched consent
  ⇒ no credential use, no HTTP; recorded consent ⇒ real HTTP-faked
  request carrying the scoped Bearer cred; end-to-end via
  runDueObjectives — met → consented action → durable done)

**P6 — Accountability & correction loop** — trust requires the user
can see, undo, and teach. Without this, P4/P5 autonomy is not
safely delegable.
- [x] A reviewable action log records every autonomous action
  (what / why / when / result), queryable by the user. Check: an
  autonomous action produces a rationale-bearing log entry on the
  user surface (smoke/integration). — 388 (personal-action-log-store,
  append-only durable; integration: runDueObjectives → consented
  act → appendActionLog → queryActionLog returns the what/why/when/
  result entry; refusals logged too)
- [x] One-tap undo/veto of a logged action reverses it where
  reversible AND writes a memory veto so that action class does not
  recur. Check: act → undo → reversed + veto recorded → same
  trigger no longer auto-acts (integration). — 388 (personal-veto
  -store + undoLoggedAction; veto gate wired into
  performConsentedAction fail-closed BEFORE consent; integration:
  act → undo reverses + records veto + logs the undo → re-triggered
  objective is refused, no HTTP, not falsely completed)

*Quality bar (not a bullet — not objectively surface-checkable):*
judgement & interruption etiquette (when to act silently vs ask vs
stay quiet, prioritise, don't be noisy) is graded inside P1/P2
work, never shipped as a standalone goal.

**P7 — Learns from correction (loop-authored, P0–P6 all
delivered).** P6 closed the *mechanical* correction loop: the
exact vetoed {objective,scope} is refused on recurrence. But a
JARVIS-grade assistant that is corrected stops *proposing* the
class everywhere — not just at the one gate — and lets the user
see and unlearn what it has learned. The outward gap: a recorded
veto today informs only `performConsentedAction`; it does not
shape the agent's general reasoning on any other surface, and a
correction is permanent-by-accident with no way to clear it.
- [x] A recorded veto is surfaced into agent run context as a
  learned-avoidance directive so the agent stops PROPOSING that
  class on any subsequent run (not only the consented-action gate
  blocking the exact repeat). Conservative + opt-out-safe: no
  vetoes ⇒ exact no-op (so an un-corrected user / smoke:live is
  unaffected). Check: vetoes recorded → a later agent run's
  context carries the avoidance directive; none → no-op
  (integration). — 390 (applyVetoAvoidance wired live into the
  agent-runtime context pipeline behind a duck-typed
  VetoAvoidanceProvider; createAgentRuntime integration: recorded
  veto → run carries [Learned Avoidance]; none → no-op; gated/
  fail-open so smoke:live unaffected)
- [x] Learned avoidances are reviewable and clearable by the user
  ("what Muse learned not to do" + clear), so a correction is not
  permanent-by-accident. Check: review lists active avoidances;
  clear removes it and the directive no longer injects
  (integration). — 390 (queryVetoes user-scoped newest-first review
  + removeVeto one-tap clear; integration: review lists →
  avoidance provider input non-empty → clear → review empty +
  provider input [] (directive no longer injects, by P7-b1's
  proven []-no-op contract) + hasVeto false)

**P8 — Proactive situational briefing (loop-authored, P0–P7 all
delivered).** P2 proved per-item proactive delivery + anticipatory
prep. But a JARVIS speaks the *situation*, not N disconnected
pings: "next 2 hours — 3pm review (doc attached); objective Y is
blocked and needs you; I'm still watching Z." The outward gap: the
proactive loop fires one notice per item; it never SYNTHESISES
imminent calendar/task items + delegated-objective status into one
coherent heads-up. P8 composes the P2 (imminent) + P5 (objective
lifecycle) substrate into the situational picture.
- [x] A deterministic composer assembles imminent items +
  delegated-objective status (active = tracked, escalated =
  flagged "needs you", done/cancelled excluded) into ONE coherent
  briefing message — not N separate notices; empty context ⇒
  nothing to say. Check: seeded imminent item + active + escalated
  objectives → one briefing naming all with correct framing,
  soonest-first; empty → undefined (integration). — 392
  (composeSituationalBriefing: soonest-first Upcoming + escalated
  "Needs you" w/ resolution + active "Still tracking";
  done/cancelled excluded; undefined when nothing to say; NaN-date
  dropped; whitespace-collapsed)
- [x] The briefing is delivered proactively on the real channel
  (composing the P2 contract-faithful HTTP-faked delivery path),
  once per situation-window, deduped. Check: seeded context → one
  briefing POSTed to the real channel API; a second tick in-window
  does not re-POST (integration). — 392 (runDueSituationalBriefing
  over a real TelegramProvider HTTP fake: asserts Bot API URL +
  chat_id + synthesised briefing text; real last-fired sidecar
  dedupes in-window; nothing-to-say is silent; re-briefs once the
  window elapses)
- [x] The situational briefing is grounded in the user's REAL
  imminent personal tasks, not objective-status only — the daemon
  feeds live due-soon tasks into the briefing's `Upcoming:` so a
  configured server actually tells the user what is coming up.
  (Loop-extended bullet: P8-b2's daemon briefed `[]`-imminent; the
  P8 docs flagged real-imminence as the natural follow-up — this
  closes that observed half-feature; calendar-derived imminence is
  a further enhancement.) Check: a seeded imminent task → the
  delivered briefing's `Upcoming:` names it, alongside objective
  status (integration). — 400 (deriveBriefingImminent mirrors the
  proactive task-imminence rule; per-tick imminentProvider in
  startSituationalBriefingTick; wired in the daemon when tasksFile
  is set)
- [x] The briefing's `Upcoming:` also includes the user's REAL
  imminent calendar events (timed, in-window, `[no-proactive]`
  respected), unioned with tasks, soonest-first — completing
  "tells you what is coming up". (Loop-extended: the recorded
  goal-400 follow-up; `ServerOptions.calendar` already exists so
  the daemon unions it when configured.) Check: a seeded imminent
  calendar event → the delivered briefing's `Upcoming:` names it,
  unioned with a task, soonest-first (integration). — 401
  (deriveCalendarBriefingImminent mirrors the proactive calendar
  rule incl. opt-out; the briefing daemon's imminentProvider
  unions deriveBriefingImminent + deriveCalendarBriefingImminent)

**P9 — The delegated-autonomy loops actually RUN (loop-authored,
P0–P8 all delivered).** P5 (`runDueObjectives`) and P8
(`runDueSituationalBriefing`) are built, tested and seam-audited —
but unlike `runDueProactiveNotices` / `runDueFollowups` they have
NO apps/api daemon: the user's running server never ticks them, so
the delegated-objective autonomy and the proactive briefing exist
only as libraries. A JARVIS does these continuously, unasked. The
outward gap is pure productionisation: a `setInterval` rider
(mirroring `followup-tick` / `proactive-tick`) so a real running
server autonomously drives the loop.
- [x] An apps/api objectives daemon rider drives
  `runDueObjectives` on a clamped cadence with the same
  single-flight + fail-soft + unref discipline as the sibling
  ticks, so a registered standing objective is autonomously
  re-evaluated by a real running server (not only a manual call).
  Check: a tick handle fires `runDueObjectives` on a due objective
  (→ acted + marked done), is single-flight under concurrent
  ticks, clamps a wild interval, and a throwing evaluator does not
  crash the rider (integration). — 394 (apps/api objectives-tick.ts
  rider mirroring followup-tick; objectives-tick.test.ts: due→done,
  single-flight, fail-soft+survives, wild-interval clamped)
- [x] The objectives + situational-briefing daemons are env-gated
  and started in the apps/api daemon set (parallel to
  `startFollowupDaemonIfConfigured`), off by default, with the
  concrete production evaluator/actuator wired. Check: with the
  env configured a real server start registers + can stop the
  daemons; absent env ⇒ not started (integration). — 398 (both
  children met; the 397 [UNVERIFIED-LIVE] cleared — see child)
  - [x] The situational-briefing apps/api daemon rider exists
    (`startSituationalBriefingTick`, the parallel of the P9-b1
    objectives rider): clamp + single-flight + fail-soft + unref,
    drives `runDueSituationalBriefing` over a real provider,
    deduped. — 395 (situational-briefing-tick.ts +
    situational-briefing-tick.test.ts)
  - [x] The situational-briefing daemon is env-gated + registered
    in the apps/api daemon set (`startSituationalBriefing
    DaemonIfConfigured` + ServerOptions `objectivesFile` /
    `briefingSidecarFile` + autoconfigure resolution + server.ts),
    off by default. — 396 (env+options+provider → onClose stop
    hook; absent env / missing options / unregistered provider ⇒
    not started — situational-briefing-daemon.test.ts)
  - [x] The objectives daemon is env-gated + registered in the
    apps/api daemon set with a concrete production
    evaluator/actuator. Check: env configured → server start
    registers + can stop the objectives daemon; absent ⇒ not
    started; the evaluator decides a real objective's condition
    (integration/smoke:live). — 397 shipped+deterministically
    verified (objectives-daemon.test.ts 4/4,
    objective-evaluator.test.ts 4/4); **398 CLEARS the 397
    [UNVERIFIED-LIVE]**: the prior tag was a dog-food request-shape
    bug (OpenAI-compat + invalid `reasoning:false` bool → empty /
    400), NOT a code gap. Re-dog-fooded the real production
    `createModelObjectiveEvaluator` against the loop's mandated
    local qwen3:8b via the correct zero-think path (native
    `/api/chat` `think:false`): met-time → `{met}`, future-time →
    `{unmet}`, logically-impossible → `{unmeetable,reason}` — it
    genuinely decides. Live-verified.

**P10 — Tiered local-model orchestration (human-authored
2026-05-22; see goal 680).** The multi-agent engine
(`@muse/multi-agent`: sequential/parallel/race, `SupervisorAgent`,
LLM-backed `RuntimeAgentWorker`), the `muse orchestrate run` CLI
and `POST /api/multi-agent/orchestrate` all EXIST and pass
`smoke:broad` — but every worker in a run shares ONE model
(`AgentSpec` has no model field; dispatch takes a single
`input.model`), so a fast model can't take a lookup while a
high-capability model takes the reasoning. The outward gap: real
model-tiering on the user's local Ollama — auto in the ask path and
explicit via `muse orchestrate`, capacity-aware, and `smoke:live`
proven (today it is diagnostic-only). Single-user / local-Ollama is
the design point — arbitration is one machine's model residency,
not multi-tenant fair-share.
- [x] A worker can run a model distinct from the run default
  (per-worker model / `tier: fast|heavy` on the dispatch path,
  resolved via `~/.muse/models.json`); absent ⇒ today's
  single-model behaviour byte-identical. Check: one orchestration
  run whose workers demonstrably executed on different local models
  (integration). — 680 s1 (goal 681: `AgentWorker.model` optional
  override applied by the orchestrator dispatch via
  `withSelectedWorker`; absent ⇒ byte-identical. `models.json`
  tier→model resolution + CLI/`muse ask` wiring stay s2+/s4+.)
- [x] A deterministic tier classifier routes simple lookups to the
  fast model and reasoning to the high-capability model, defaulting
  to heavy when unsure (never silently downgrade reasoning), AND a
  capacity probe collapses the run to the single high-capability
  model (sequential) when the host cannot hold both at once
  (fail-open to single-heavy on probe error). Check: labelled tasks
  route to the expected tier; a faked low-capacity host collapses
  to one model (integration). — 680 s2+s3 (goal 682:
  `classifyTier` reasoning-first/default-heavy + `planTieredRun`
  capacity collapse + fail-open in `@muse/multi-agent/tiering.ts`;
  `muse ask` auto / `muse orchestrate --tiered` surface wiring + the
  live two-tier round-trip stay s4+s5.)
- [x] Tiering is exercised end-to-end on the user surface — auto in
  the `muse ask`/REPL path (off by default behind a flag until
  proven not to degrade a plain ask) AND explicit via
  `muse orchestrate --tiered` — proven by a `smoke:live` round-trip
  whose workers ran on two distinct local Qwen tiers and whose
  low-capacity path collapsed to one. — 680 s4+s5 (all four children
  met — 687)
  - [x] `muse ask --tiered` auto-routes a single ask to the fast/heavy
    model (off by default; explicit `--model` overrides). — 683
  - [x] `muse orchestrate --tiered` runs each worker on the tier model
    classified from its spec role; response surfaces the per-worker
    model. — 685
  - [x] `smoke:live` two-tier round-trip: in ONE orchestrate run two
    workers provably executed on two DISTINCT local Qwen tiers with
    real output. — 686
  - [x] The orchestrate server honors the low-capacity collapse —
    `planTieredRun`'s capacity probe (`MUSE_TIER_SINGLE_MODEL_HOST`)
    collapses a tiered run to single-heavy sequential, fail-open on
    probe error; integration-proven (forcing a real low-RAM host live
    is non-reproducible — the deterministic branch is the correct
    integration target). — 687

**P11–P16 — Actuator breadth (human-authored 2026-05-22).** The
cognition layer (memory / anticipation / consent / correction /
briefing) is strong; the real-world *hands* are thin — only
calendar / tasks / notes / messaging. Each target below adds one
provider behind the existing model-neutral abstraction (the way
calendar did), so no new runtime is needed. **Every bullet that
sends to a third party or performs a state-changing external action
MUST obey [`outbound-safety.md`](../../.claude/rules/outbound-safety.md)
— draft-first, fail-closed approval gate, resolved-not-guessed
recipient, action-logged; its acceptance check proves the
deny/timeout/ambiguous/no-consent path produces NO external effect,
not just the happy path.**

**P11 — Email (the single biggest missing surface).** Read-first;
send is draft-first and gated.
- [x] Read / triage / summarise the inbox (read-only) via an email
  provider (IMAP/SMTP or Gmail API) behind the abstraction;
  needs-reply items feed the P8 situational briefing. Check: a
  contract-faithful HTTP-faked inbox → the agent summarises it / it
  surfaces in the briefing (integration). — 694 + 695 (694:
  `EmailProvider` + `GmailEmailProvider` (Gmail REST, Bearer, no
  SDK/dep) + `summarizeInbox` + `muse inbox`; 695: `unreadBriefingLine`
  + the proactive briefing daemon grounds a non-empty brief with an
  unread-inbox digest (contract-faithful over the real TelegramProvider,
  `MUSE_GMAIL_TOKEN`-gated, supplementary — never triggers a brief
  alone). A guided OAuth token flow remains for live use.)
- [x] Send / reply obeys `outbound-safety.md` — a message to a third
  party is never sent without the user confirming the exact drafted
  content; recipient resolved or the agent asks; fail-closed; sent
  content action-logged. Check: send attempt → approval prompt
  carrying the draft → only on explicit confirm does the HTTP-faked
  send fire; deny / timeout / ambiguous-recipient ⇒ no send
  (integration, contract-faithful, never a fake registry). — 696
  (`sendEmailWithApproval`: resolveContact (ambiguous/unknown/no-email
  ⇒ NO send + clarify) → draft → fail-closed approval gate (deny /
  gate-throw ⇒ NO send) → `GmailEmailProvider.send` (real Gmail REST
  over a faked fetch) → action-logged performed/refused; `muse email
  send` surface. Mutation-proven: dropping the deny guard makes a
  denied send fire. Live use needs a real Gmail OAuth token.)

**P12 — Real-world context: weather + location (read-only).** Cheap
grounding for anticipation.
- [x] A weather/location provider grounds answers and the proactive
  briefing ("rain at 3pm — leave early"). Check: seeded location →
  the briefing/answer reflects the real (HTTP-faked) forecast
  (integration). — 688 + 690 (688: `WeatherProvider` /
  `OpenMeteoWeatherProvider`, free/no-key + `muse weather` direct
  answer; 690: provider moved to @muse/mcp + the proactive briefing
  daemon grounds a non-empty brief with a seeded location's forecast,
  contract-faithful HTTP fake over the real TelegramProvider; weather
  is supplementary — never triggers a brief alone. A free-form
  agent-answer weather tool remains a future additive enhancement.)

**P13 — Contacts / people graph.** A JARVIS knows who people are;
also the recipient-resolution backbone for P11/P15 outbound safety.
- [x] A contacts provider resolves a name → identifier (email /
  handle) so "email Bob" resolves unambiguously, and an
  ambiguous/unknown person triggers a clarifying question instead of
  a guessed recipient. Check: known contact resolves; ambiguous →
  clarify, never a guessed address (integration). — 691
  (`~/.muse/contacts.json` store + pure `resolveContact` —
  resolved/ambiguous/unknown, exact-before-substring, never guesses on
  ambiguity — + `muse contacts add|list|resolve`; `resolve` reports the
  ambiguous candidates / not-found on a non-zero exit, never a single
  guessed recipient. The recipient-resolution backbone for P11-send /
  P15 outbound safety.)

**P14 — Document understanding (PDF / office, beyond markdown
notes).**
- [x] The agent ingests a real PDF/office document and answers
  grounded questions / summarises it, citing the source. Check: a
  real document → a grounded answer citing it; a decoy excluded
  (integration). — 088 + 692 + 693 (088 `muse read <pdf> --ask`
  single-doc grounding; 692 wired PDF extraction into the notes RAG
  (decoy-excluded retrieval, deterministic integration test); 693
  added the `smoke:live` check "muse ask grounds an answer in a real
  PDF and excludes a decoy" — real PDF reindexed with nomic-embed-text,
  `muse ask` via real qwen3:8b answers grounded in the PDF's figure
  with the PDF top-ranked (0.84) and the decoy excluded (0.38).
  `office`/.docx remains a future additive source type.)

**P15 — Web actions beyond search (gated).** Search exists; ACTING
on the web (forms, bookings) does not — execute-tier, governed by
`outbound-safety.md`.
- [x] An agentic web action (submit / book) is approval-gated +
  consent-recorded and never autonomous; absent consent ⇒ blocked,
  fail-closed. Check: action → approval/consent gate → only on
  confirm does it proceed; absent ⇒ no external effect (integration).
  — 697 (`performWebActionWithApproval`: fail-closed approval gate
  (deny / gate-throw ⇒ NO HTTP) → injected-transport request →
  action-logged performed/refused/failed; `muse web-action` surface.
  Contract-faithful integration (records the real request shape, never
  a fake flag); mutation-proven (dropping the deny guard makes a denied
  action fire). Banking/payments explicitly out of scope.)

**P16 — Lifestyle actuators (opt-in umbrella, lower priority).**
Smart-home / music / health-data — each behind the same
provider+consent pattern; any state-changing or outbound action is
gated per `outbound-safety.md`. **Banking / financial-account
access, payments and money movement are OUT OF SCOPE — never built
(see `outbound-safety.md`).** Split per-actuator when picked.
- [x] One opt-in lifestyle provider (e.g. smart-home or music) lands
  end-to-end with every state-changing action approval-gated; absent
  approval ⇒ no effect. Check: a state-changing action → gate → only
  on confirm does it fire (integration). — 698 (opt-in Home Assistant
  smart-home: `buildHomeAssistantServiceCall` + `performHomeAction
  WithApproval` route every service call through the fail-closed
  `performWebActionWithApproval` gate; `muse home call
  <domain.service>` surface, opt-in via MUSE_HOMEASSISTANT_URL/TOKEN.
  CONFIRM → one real HA service POST (Bearer + entity_id body);
  DENY/absent ⇒ NO call. Contract-faithful + mutation-proven. Local
  REST, no SDK/dep. Banking/payments out of scope.)

**P17 — Conversational actuation (loop-authored 2026-05-22; the
agent USES the actuators).** P11–P16 exist as CLI surfaces + gated
primitives, but the AGENT can't yet invoke them mid-conversation:
"email Bob the Q3 summary" / "turn off the lights" don't reach
`sendEmailWithApproval` / `performWebActionWithApproval` /
`performHomeActionWithApproval` from a chat/ask turn. The north-star
gap is exactly this — a companion that ACTS when addressed, not a set
of commands the user types. Every actuated tool stays fail-closed per
`outbound-safety.md`: the existing `toolApprovalGate` / channel-approval
seam IS the gate; absent confirm ⇒ no effect; recipient resolved via
`resolveContact`, never guessed; action-logged. (`@muse/tools` is
zero-IO, so these are MCP-bridged / runtime-registered tools, not the
ambient bundle.)
- [x] The agent invokes ONE gated actuator (email send) as a tool
  inside an agent run: a turn asking to email a known contact drafts
  the message, the recipient resolves via `resolveContact`, the
  fail-closed approval gate fires, and only on confirm does the
  (HTTP-faked) send go — deny / timeout / ambiguous-recipient ⇒ NO
  send. Check: an agent run with the tool registered → tool-call →
  gate → confirm fires / absent ⇒ no external effect (integration,
  contract-faithful, never a fake registry). — 706
  (`createEmailSendTool` (@muse/mcp): an `email_send` execute-risk
  agent tool whose execute reuses the proven `sendEmailWithApproval`
  (resolve → fail-closed gate → real `GmailEmailProvider.send` →
  action-log). apps/api p17-email-tool-agent-seam.test.ts drives a
  REAL `createAgentRuntime` run: the model emits an `email_send`
  tool-call → CONFIRM fires one real Gmail send (Bearer, HTTP faked) /
  DENY / ambiguous-recipient ⇒ NO send. Mutation-proven. Wiring the
  gate to a live channel/CLI confirm in production is a follow-up.)
- [x] The OTHER state-changing actuators (web action, smart-home) are
  likewise gated agent tools, so the agent can act on them mid-turn
  under the same fail-closed gate. Check: an agent run → tool-call →
  gate → confirm fires / absent ⇒ no external effect (integration).
  — 707 + 708 (`createWebActionTool` reusing
  `performWebActionWithApproval` + `createHomeActionTool` reusing
  `performHomeActionWithApproval`, both `execute`-risk MuseTools in
  @muse/mcp. apps/api p17-{web-action,home-action}-tool-agent-seam
  tests drive REAL `createAgentRuntime` runs — the model emits a
  `web_action` / `home_action` tool-call → CONFIRM fires one recorded
  request / HA service POST / DENY ⇒ NO external effect.
  Mutation-proven. All three actuators (email, web, smart-home) are now
  gated agent tools; wiring them into a live agent surface with a real
  channel/CLI confirm gate is the next P17 step.)
- [x] The gated actuators are reachable from a LIVE agent surface: a
  real `muse ask --with-tools --actuators` turn exposes email_send /
  web_action / home_action to the model, each carrying a clack confirm
  as its fail-closed gate — the conversation can trigger them and
  nothing fires without explicit confirmation. Off by default; opt-in
  per invocation; providers resolve from env. Check: the actuator tools
  are env-selected + the gate threads end-to-end through a REAL
  `createAgentRuntime` run (confirm fires the request / deny ⇒ none).
  — 709 (`buildActuatorTools` (apps/cli) builds the configured actuator
  MuseTools with clack-confirm gates; `createMuseRuntimeAssembly`
  gained an `extraTools` injection so the CLI feeds them into the
  shared runtime registry without putting interactive gates in the
  headless assembly; `muse ask` sets `localMode` only under
  `--actuators` so no other execute-risk surface is newly exposed.
  apps/cli actuator-tools.test.ts: env→toolset selection + a REAL
  agent run where the model emits a `web_action` call → CONFIRM fires
  one recorded request / DENY ⇒ 0. Mutation-proven: a gate that
  ignores the confirm makes the DENY test fire.)
- [x] REMOTE surface, audit half: when an inbound channel message
  (Telegram/etc.) makes the agent attempt a risky tool, the fail-closed
  channel-approval gate now RECORDS the refusal to the action log
  (visible via `muse actions`) — every action, sent or refused, leaves
  a rationale-bearing trail per outbound-safety. This is the audit
  foundation; the approve-completion round-trip ("reply yes → re-run
  the tool") is the remaining REMOTE half, still `[ ]` below. — 719
  (`recordRefusal` hook on `createChannelApprovalGate`, wired in
  apps/api via `createChannelRefusalRecorder` → `appendActionLog`;
  fail-soft; @muse/messaging stays @muse/mcp-free. Mutation-proven.)
- [x] REMOTE surface, completion via CLI: `muse approvals approve <id>`
  re-runs a pending refusal's exact gated tool — reusing the proven
  actuator orchestration (709 `buildActuatorTools`) with a clack confirm
  showing the draft, then clearing the entry on success (replay-guard).
  So a channel-triggered action the gate refused can be completed
  end-to-end (review on CLI → approve → it fires). — 728 (worklist
  substrate) + 729 (`approvePendingApproval`: confirm→runs+clears /
  deny→stays / unknown/expired→not-found / non-actuator→no-tool;
  replay-guard mutation-proven).
- [x] REMOTE surface, in-CHAT auto-completion (opt-in): with
  `MUSE_INBOUND_AUTO_APPROVE=true`, an inbound channel REPLY
  ("yes"/"approve") to the draft-bearing prompt re-runs the pending tool
  in-chat and reports the result — the whole loop happens in
  Telegram/chat, no CLI. Default OFF (completion stays on the deliberate
  `muse approvals approve` CLI confirm); only ONE un-expired pending
  auto-runs (multiple → ambiguous, lists ids); the reply is the explicit
  confirm of the already-shown draft (outbound-safety), cleared on
  success (replay-guard). — 731 (`runActuatorByName` @muse/mcp shared
  dispatcher + `handleInboundApprovalReply` autoRun branch + server wire;
  mutation-proven single-pending guard). Detection + bridge from 730.

The loop extends this map itself when all are delivered or its
judgement finds a stronger outward direction. "Nothing to do" is
impossible by construction.

## Next horizon — human-directed (2026-05-23): expand + harden, live-verified

The self-authored P0–P17 map is fully delivered. The human set the
direction: keep shipping OUTWARD capability while turning the
"one-of-each" proofs into daily-dependable integrations. Every slice
is proven by a real, surface-level check — mock / fixture data MAY
exercise it, but the real code path must run against a
contract-faithful fake, never a stubbed registry or a
happy-path-only assertion.

**P18 — Web control of the user's REAL logged-in Chrome.** Search
exists; Muse can't yet perceive or act on an arbitrary live web page.
Integrate the open-source **Chrome DevTools MCP**
(`ChromeDevTools/chrome-devtools-mcp`, Apache-2.0), attached to the
user's running Chrome over the remote-debugging port, under the MCP
allowlist. Read / perceive first; acting is gated.
- [x] Read-first: the agent opens / inspects a real URL in the
  attached Chrome via the MCP tool and answers a question grounded in
  the LIVE page content (not a cached search snippet). Check:
  integration/live driving the MCP tool end-to-end against a
  contract-faithful page fixture. — 750 (connector +
  `createChromeDevToolsMcpServer()` + `take_snapshot` tool projection)
  + 751 (agent-RUN end-to-end: `AgentRuntime.run()` invokes the
  projected tool and grounds its answer in the live snapshot;
  mutation-proven against the real forward path).
- [x] A state-changing web action (fill + submit a form) under the
  user's session is approval-gated + draft-first per
  `outbound-safety.md` — deny / timeout / ambiguous-target produces
  NO external effect (contract-faithful fake). Banking / payments
  stay out of scope. — 752 (`chromeDevToolsToolRisk` fail-close
  classifier + `withChromeDevToolsRisk`; e2e AgentRuntime run: a
  denied / throwing gate → the projected `fill_form` never calls the
  browser; read perception stays ungated; mutation-proven).

**P19 — Daily-hardening of the one-of-each actuators.** Each
actuator (email, web action, contacts, weather/location, smart-home)
was proven ONCE; a JARVIS you depend on survives real-world failure.
- [x] One actuator detects + recovers from a real failure mode
  (rate-limit / transient 5xx / retry-with-backoff / malformed
  response) instead of crashing the run or silently dropping —
  proven by a contract-faithful fake exercising that exact path.
  (Repeat per actuator as separate slices.) — 753 (weather:
  `isRetriableStatus` + `fetchWithRetry` retry-with-backoff for
  429/5xx/network-reject; geocode + forecast recover from a transient
  503/502 instead of crashing the briefing; contract-faithful fake
  fetch, mutation-proven). + 824 (email: `listRecent` skips a single
  message whose fetch fails transiently / returns a malformed 200 body
  instead of dropping the whole inbox; a permanent `GmailAuthError`
  still propagates; mutation-proven). + 883 (the shared
  `fetchWithRetry` — weather/email/smart-home/feeds reads — now bounds
  each attempt with a timeout, so a host that accepts but never
  responds is aborted + retried instead of hanging the turn forever;
  mutation-proven). + 901 (the shared `fetchWithRetry` now honours a
  server `Retry-After` header on 429/503 — waits the interval the host
  actually asked for instead of its own 250ms backoff, clamped to
  `maxRetryAfterMs` so an hour-long value can't freeze the turn;
  `parseRetryAfterMs` RFC-7231 delta-seconds | HTTP-date, junk-rejecting;
  mutation-proven). + 910 (email: `getMessage` now re-throws a permanent
  `GmailAuthError` instead of swallowing it as `undefined`, so the
  agent-facing `read_email` tool reports "auth rejected — re-auth" on an
  expired token instead of a misleading "no such message"; cross-method
  parity with `listRecent`; mutation-proven). + 923 (web search:
  `muse.search` routes both its SearXNG + DuckDuckGo backends through
  the shared `fetchWithRetry`, so a transient 429 / 5xx / network reject
  on the idempotent GET retries-with-backoff (Retry-After honoured)
  instead of dropping the search on one blip; the state-changing
  web-action POST still deliberately never retries; real `tool.execute`
  vs a contract-faithful sequenced fake, mutation-proven). + 924
  (contacts: the tolerant read now coerces a wrong-typed field from a
  hand-edited / synced `contacts.json` — a numeric `phone` previously
  survived `id`+`name`-only validation then crashed `resolveContact`
  (`.replace` on a number) for the WHOLE store; `coerceContact` drops
  the bad field, keeps the contact, mutation-proven). The
  email/web/weather/smart-home/contacts actuators are now each hardened
  against their primary real-world failure mode.

**P20 — Deepen the thin axes (Perception + Knowledge).**
- [x] Continuous perception: an ambient signal (active window /
  screen / location) feeds a proactive notice without an explicit
  invoke. Check: a simulated ambient signal drives a real proactive
  delivery end-to-end. — 756 (`deriveAmbientNotices` rule matcher +
  `runAmbientNoticeTick`: a simulated active-window signal delivers a
  notice through the real `ProactiveNoticeSink`, fire-once dedupe,
  fail-soft; mutation-proven. OS active-window source + daemon
  registration are production-wiring follow-on.)
- [x] Knowledge grounding: the agent answers from a MULTI-document
  personal corpus (RAG over notes + ingested docs) and cites which
  source — beyond today's single-doc PDF ingest. — 754 (engine:
  `rankKnowledgeChunks` multi-source cosine RAG +
  `renderKnowledgeMatches` source-citation + `knowledge_search` tool,
  mutation-proven) + 755 (`assembleKnowledgeCorpus` reads the LIVE
  `LocalDirNotesProvider` + merges ingested-doc chunks; agent-run e2e
  over a REAL temp-dir notes store answers grounded AND cites
  `notes/health.md`, mutation-proven).

**P21 — Web-watch (loop-authored 2026-05-23).** "Monitor this page
and ping me when X" — composes the delivered Chrome perception (P18)
with proactive notices (P2/P20). Read-only perception only; no
autonomous action (a watch never SUBMITS anything — outbound-safety).
- [x] A page-change watch fires a proactive notice on a rising-edge
  condition (a term appears / disappears, or content changes vs the
  last snapshot) and does NOT re-fire while the condition persists.
  Check: a watch tick over a contract-faithful page-snapshot sequence
  (via the Chrome DevTools MCP read tool) delivers exactly one notice
  on the edge, none while steady. — 776 (`detectWatchTrigger`
  edge-triggered detector) + 777 (`createWebWatchRunner`: a
  `processing→shipped→shipped` snapshot sequence delivers exactly ONE
  notice on the edge through a real `ProactiveNoticeSink`, none while
  steady; per-watch baseline mutation-proven). + 826 (`createChromeSnapshot`
  reads a page through the user's logged-in Chrome via the Chrome
  DevTools MCP `navigate_page`+`take_snapshot` seam, and
  `webWatchesFromConfig` builds `source:"chrome"` watches — so a watch
  can monitor an AUTHENTICATED page a plain HTTP GET can't see; end-to-end
  edge-trigger proven against a contract-faithful fake connection). The
  daemon CONNECTING Chrome at startup + threading the connection into the
  config is the remaining follow-on wiring (scheduling daemon already
  ships).

<!-- IMMUTABLE-CORE:BEGIN -->
## Immutable core (the loop must NEVER edit — honesty machinery)

Direction is the loop's to choose. These are NOT, and exist so
autonomy can't decay into busywork:

- the north-star definition (proactive + instantly-responsive
  personal assistant; the loop never weakens it),
- the falsifiable-outward test, the banned-shapes list,
- the `CAPABILITIES.md` rules + the requirement that every goal
  ship a green surface-level (not unit-only) automated check,
- the cross-iteration falsification + 10-iter regression sweep,
- never stop / never ask a human / never complete.

A commit-msg hook (`scripts/guard-immutable.mjs`) rejects any
change to lines in this block without `[core-change: human]`.
Changing the immutable core is a human-only action.
<!-- IMMUTABLE-CORE:END -->

The loop's enforced freedom: extend/reorder targets and bullets,
never the lines between the IMMUTABLE-CORE markers.
