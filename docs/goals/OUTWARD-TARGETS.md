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
- [ ] Auto-extract wired into the API agent runtime AND on
  tool-using turns (today REPL-only / `toolsDisabled`-only) so the
  user model grows from real use. Check: a tool-using API turn
  produces a stored memory (integration).
- [ ] Recall is embedding-similarity (not Jaccard; notes RAG
  already has cosine) AND a stored preference is actually applied
  to a later answer. Check: state a preference → differently-worded
  later request → the answer reflects it (integration).
- [ ] From current context (calendar / inbox / patterns) the agent
  infers a likely UNSTATED need, autonomously investigates it
  (tool / web / notes), and surfaces the finding unasked. Check:
  seeded context → an investigated, relevant surfacing without
  being asked (integration/smoke).
- [ ] On an ambiguous / under-specified request the agent asks a
  clarifying question instead of guessing, and offers ("shall I
  X?") when it detects a likely-wanted action. Check: ambiguous
  input → a clarifying question, not a hallucinated action
  (integration).

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
- [ ] The result is sent back over the same channel via the
  messaging registry. Check: a `smoke` exercising inbound→reply on
  one provider (contract-faithful HTTP fake or real) asserting the
  outbound POST — never a fake registry.
- [ ] Thread context carries across turns on the channel (the chat
  IS a Muse session). Check: multi-turn inbound retains context.
- [ ] Risky actions prompt for in-chat approval before executing.
  Check: approval gate exercised over the channel path.

**P2 — Proactive delivery proven on a real channel** — Audit:
well-engineered (dedupe, quiet-hours, Phase-D synth) but EVERY
firing test injects a fake registry; unit-only, cannot count per
the CAPABILITIES surface-check rule.
- [ ] Proactive / followup / reminder daemon delivers to a real
  (or contract-faithful HTTP-faked) channel; check asserts the
  message was POSTed to the channel API, not a fake registry.
- [ ] Anticipatory prep ("meeting in 15 min — here's the doc")
  rides this path (ties to P1).

**P3 — Ambient perception loop** — Audit: only `muse glance`, a
manual one-shot CLI print, macOS-only, never reaches the agent.
- [ ] A gated perception daemon periodically snapshots ambient
  signals (screen / clipboard / active app / notifications) and
  injects them as run context unasked. Check: an ambient change
  measurably alters a subsequent agent answer.

**P4 — Close the trust-blocking PARTIALs** — audit-identified;
required before Muse can be delegated to unsupervised. (User-model
partials — auto-extract wiring, embedding recall — moved up to P0
as the "knows-you" foundation.)
- [ ] Calendar WRITE (create/move/cancel) across Google / CalDAV /
  macOS exercised by a surface check (contract-faithful HTTP fake),
  not read-only.
- [ ] Voice end-to-end round-trip has an automated check
  (mic→STT→agent→TTS pipeline; STT/TTS mockable, full path).

**P5 — Durable delegated objectives (long-horizon agency)** — the
"trust over time" gap: turns "an agent you invoke" into "a
assistant you delegate to". A standing objective is not a one-shot.
- [ ] A user can register a standing objective ("watch for X / keep
  trying Y until Z / tell me when W") that survives process restart
  and the ~20-min boundary as durable state. Check: register →
  restart → still tracked (integration).
- [ ] It is autonomously re-evaluated on a tick with backoff and
  either fires its action when the condition is met or escalates
  when unmeetable — never silently dropped. Check: condition flips
  → action fires + marked done; unmet → backoff retry (integration).
- [ ] Acting on an objective uses the user's *scoped* service
  credentials under recorded consent (the act-as-the-user
  prerequisite, shared with P4). Check: an objective performs a
  real (HTTP-faked) external action via a scoped credential with
  consent recorded.

**P6 — Accountability & correction loop** — trust requires the user
can see, undo, and teach. Without this, P4/P5 autonomy is not
safely delegable.
- [ ] A reviewable action log records every autonomous action
  (what / why / when / result), queryable by the user. Check: an
  autonomous action produces a rationale-bearing log entry on the
  user surface (smoke/integration).
- [ ] One-tap undo/veto of a logged action reverses it where
  reversible AND writes a memory veto so that action class does not
  recur. Check: act → undo → reversed + veto recorded → same
  trigger no longer auto-acts (integration).

*Quality bar (not a bullet — not objectively surface-checkable):*
judgement & interruption etiquette (when to act silently vs ask vs
stay quiet, prioritise, don't be noisy) is graded inside P1/P2
work, never shipped as a standalone goal.

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
