# P43 — Close the loop: continuous + autonomous + reliable

Human-directed frontier (2026-06-03, Jinan). Rationale + the 129-capability
map: `docs/strategy/capability-map.md`. The four P43 bullets in
`OUTWARD-TARGETS.md` are deliberately UN-SLICEABLE — each flips only when the
whole behaviour is proven end-to-end by a live battery. This file decomposes
them into the vertical slices the loop ships across iterations; a slice landing
does NOT flip the bullet.

## P43-1 — Autonomous self-development daemon (THE #1 lever)

**The gap, measured (not assumed).** The self-development mechanisms already
exist, but only as (a) **manual CLI** (`muse playbook distill`, `playbook
consolidate`, `skills consolidate`, `episode consolidate`, `reflections`) and
(b) the **`apps/api` server tick** (`tick-daemons.ts` wires `startConsolidateTick`
+ `distillQueuedCorrections`). The process the user actually runs on their Mac —
**`muse daemon` (`apps/cli/src/commands-daemon.ts`)** — drove proactive /
reminder / followup / ambient / web-watch / objectives / briefing / *reflection*
ticks but **NO learning-from-corrections tick**. So a correction Jinan makes is
enqueued (`enqueueLearnEvent`) at correction time and then sits there until he
manually runs `muse playbook distill`. The loop is open exactly where it most
needs to be closed.

**The arc (slices → flip).** Each slice keeps the grounding floor (probation
writes, brake-first, no fabrication) and is proven live where it touches the
model.

- **Slice 1 — distill corrections on the daemon tick. ✅ DELIVERED.** Move the
  grounding-fenced queue-drain (`distillQueuedCorrections`) into `@muse/autoconfigure`
  (the one package that depends on BOTH `@muse/agent-core` and `@muse/mcp`, so the
  api tick AND the CLI daemon share one implementation; `apps/api` re-exports it,
  byte-identical). Wire a `selfLearnTick` into `muse daemon`'s `runTick`, mirroring
  the reflection tick: gated by `MUSE_SELFLEARN_ENABLED` (+ a resolved model),
  interval-throttled (`MUSE_SELFLEARN_INTERVAL_MS`, default 5 min), brake-first
  (the learning-pause kill switch is honoured inside the drain), one distill per
  tick, every write on PROBATION until a reinforce graduates it. Proof:
  `commands-daemon.test.ts` — distills a queued correction with no manual command
  (drains the queue), the BRAKE leaves the queue intact when paused, the gate is
  off by default, `--status` reports it; api `distill-queue` suite still green
  against the re-export.
- **Slice 2 — disuse-decay on the daemon tick. ✅ DELIVERED.** The FORGETTING
  half of continuous RL over the bank: `decayStalePlaybookRewards` (already run
  by the api tick, NOT the CLI daemon) now runs in `muse daemon` under the same
  `MUSE_SELFLEARN_ENABLED` switch + the learning-pause brake (a paused user's
  bank is frozen), model-free, slow daily cadence. A positive-reward strategy
  not reinforced within the stale window fades toward neutral so a one-off
  thumbs-up can't steer the agent forever. Distill ADDS (slice 1), decay FADES
  (slice 2) = the user's actual runtime now does continuous RL over the bank
  unattended. Proof: `commands-daemon.test.ts` — a 60-day-stale reward-2
  strategy fades to 1 on the tick (no model), the BRAKE freezes it when paused,
  the gate is the same as distill.
- **Slice 3a/3b — consolidate (probation-preserving). ✅ DELIVERED.** Skill +
  playbook consolidation on the daemon tick; the merged entry STAYS probation
  (never auto-graduates). Autonomous GRADUATION was deliberately NOT built — it
  is sign-unsafe (a correction is a NEGATIVE signal; graduating on it inverts the
  sign), so graduation stays bound to a manual positive act (an explicit
  reinforce). A 10-voter panel ratified this.
- **FLIP slice — the 2-session live battery. ✅ DELIVERED (P43-1 FLIPPED).** The
  flip is the SUBTRACTIVE direction, not the (sign-unsafe) additive one: a
  correction in session A autonomously DECAYS a strategy it CONTRADICTS so a
  later session stops applying it. The unblock the held design needed — an LLM
  POLARITY gate (`classifyCorrectionContradiction`) that tells "do X" from
  "STOP X" (a lexical Jaccard can't) — is live-validated 11/11 / 0
  false-CONTRADICT on qwen3:8b and is a permanent `eval:self-improving` battery.
  DECAY-ONLY + fail-closed + injected-only + brake-first; proven end-to-end by a
  live `muse daemon --once`: a seeded injected strategy + a contradicting
  correction → the real classifier decayed it below the inject line (reward -4,
  not injectable, probation untouched) with NO manual command. **P43-1 = `[x]`.**

## P43-2 — Reliable carry-to-done (all-actuator retry + plan-execute verify)

The bullet flips only when a 2+-step task carries to a verified done through an
injected failure. Vertical slices, hardening one actuator's transient-failure
gap at a time (the human focus: a proven-once actuator that breaks on a
rate-limit / transient 5xx is a USER-FACING reliability defect):

- **Slice 1 — Google Calendar writes survive a 429 rate-limit. ✅ DELIVERED.**
  Messaging already retried (`sendWithRetry`); calendar writes did NOT — Google
  `createEvent`/`updateEvent`/`deleteEvent` failed outright on a transient
  status (line `maxRetries = GET ? retries : 0`). Now a WRITE retries ONLY a 429
  rate-limit, honouring `Retry-After` (clamped) — SAFE because a 429 is rejected
  BEFORE the mutation applies, so it can't double-create; a write 5xx or a
  mid-flight network reject stays non-retried (AMBIGUOUS — may have committed).
  Proof: contract-faithful HTTP fake in `google-provider.test.ts` — a 429+Retry
  -After retries then succeeds (honours 2s, not the 250ms backoff), no-hint 429
  falls back to backoff, the budget exhausts to HTTP_429 (no infinite loop), and
  a 5xx write is still NEVER retried.
- **Slice 2+ (remaining).** Extend safe transient-retry to the email send (429
  -only — never a 5xx, since Gmail send is non-idempotent), CalDAV/home write
  Retry-After parity, then the plan-execute loop that verifies each step's
  effect + replans on a failed/ambiguous step. The FLIP needs a 2+-step task
  carried to a verified done through an injected deny/timeout/5xx.

## P43-3 / P43-4

Decomposed when reached (see the bullet text in `OUTWARD-TARGETS.md`).
P43-3 = one live stream syncing into the citable corpus with persisted offset
state; P43-4 =
absence/anomaly anticipation + evening recap.
