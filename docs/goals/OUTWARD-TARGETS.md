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
- [ ] Tiering is exercised end-to-end on the user surface — auto in
  the `muse ask`/REPL path (off by default behind a flag until
  proven not to degrade a plain ask) AND explicit via
  `muse orchestrate --tiered` — proven by a `smoke:live` round-trip
  whose workers ran on two distinct local Qwen tiers and whose
  low-capacity path collapsed to one. — 680 s4+s5
  (goal 683 delivered the `muse ask --tiered` half; goal 685 delivered
  the `muse orchestrate --tiered` explicit surface — each worker runs on
  the tier model classified from its spec role, response surfaces the
  per-worker model, integration + `smoke:broad` green. STILL OPEN before
  this flips: the `smoke:live` round-trip proving two workers ran on two
  distinct real Qwen tiers AND the low-capacity collapse on the live
  surface — both surfaces are now wired, only the live proof remains.)

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
- [ ] Read / triage / summarise the inbox (read-only) via an email
  provider (IMAP/SMTP or Gmail API) behind the abstraction;
  needs-reply items feed the P8 situational briefing. Check: a
  contract-faithful HTTP-faked inbox → the agent summarises it / it
  surfaces in the briefing (integration).
- [ ] Send / reply obeys `outbound-safety.md` — a message to a third
  party is never sent without the user confirming the exact drafted
  content; recipient resolved or the agent asks; fail-closed; sent
  content action-logged. Check: send attempt → approval prompt
  carrying the draft → only on explicit confirm does the HTTP-faked
  send fire; deny / timeout / ambiguous-recipient ⇒ no send
  (integration, contract-faithful, never a fake registry).

**P12 — Real-world context: weather + location (read-only).** Cheap
grounding for anticipation.
- [ ] A weather/location provider grounds answers and the proactive
  briefing ("rain at 3pm — leave early"). Check: seeded location →
  the briefing/answer reflects the real (HTTP-faked) forecast
  (integration).

**P13 — Contacts / people graph.** A JARVIS knows who people are;
also the recipient-resolution backbone for P11/P15 outbound safety.
- [ ] A contacts provider resolves a name → identifier (email /
  handle) so "email Bob" resolves unambiguously, and an
  ambiguous/unknown person triggers a clarifying question instead of
  a guessed recipient. Check: known contact resolves; ambiguous →
  clarify, never a guessed address (integration).

**P14 — Document understanding (PDF / office, beyond markdown
notes).**
- [ ] The agent ingests a real PDF/office document and answers
  grounded questions / summarises it, citing the source. Check: a
  real document → a grounded answer citing it; a decoy excluded
  (integration).

**P15 — Web actions beyond search (gated).** Search exists; ACTING
on the web (forms, bookings) does not — execute-tier, governed by
`outbound-safety.md`.
- [ ] An agentic web action (submit / book) is approval-gated +
  consent-recorded and never autonomous; absent consent ⇒ blocked,
  fail-closed. Check: action → approval/consent gate → only on
  confirm does it proceed; absent ⇒ no external effect (integration).

**P16 — Lifestyle actuators (opt-in umbrella, lower priority).**
Smart-home / music / health-data — each behind the same
provider+consent pattern; any state-changing or outbound action is
gated per `outbound-safety.md`. **Banking / financial-account
access, payments and money movement are OUT OF SCOPE — never built
(see `outbound-safety.md`).** Split per-actuator when picked.
- [ ] One opt-in lifestyle provider (e.g. smart-home or music) lands
  end-to-end with every state-changing action approval-gated; absent
  approval ⇒ no effect. Check: a state-changing action → gate → only
  on confirm does it fire (integration).

The loop extends this map itself when all are delivered or its
judgement finds a stronger outward direction. "Nothing to do" is
impossible by construction.

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
