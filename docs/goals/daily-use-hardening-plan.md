---
title: Daily-use hardening plan
audience: [product, engineering, evaluation]
purpose: Make Muse safe, useful, resource-bounded, and honestly measurable before widening autonomy
status: active
updated: 2026-07-22
related: [../strategy/attunement.md, attunement-implementation-plan.md, personal-agent-acceptance-plan.md, ../development/personal-agent-qualification.md]
---

# Daily-use hardening plan

## Product decision

Muse does not need a default statistics dashboard yet. The default experience is
an actionable status: what needs the owner's attention, what Muse can safely do,
and what it has learned with evidence. Token volume, cost, latency, and raw
autonomous activity remain Diagnostics data, not a claim of usefulness.

Every user-facing metric must name its evidence class, denominator, time window,
and the decision it can change. A count with none of these is diagnostic noise.
No technical, controlled, synthetic, or unclassified event can promote personal
effectiveness, learning, permission, or autonomy.

## Current controlled state — 2026-07-22

- Resident LaunchAgent is healthy and uses a stable Muse CLI entrypoint.
- It is deliberately contained: local-only, log provider lock, delivery brake,
  and self-learning disabled.
- Thirty old pending reminders are preserved and quarantined by that brake; they
  must never be fired, deleted, or silently rescheduled in bulk.
- Capability evidence and organic effectiveness remain unverified. Technical
  recovery does not change either claim.

## Ordered work

### 0. Keep the recovery boundary intact — complete, continuously checked

- [x] Reject test-runner daemon entries and fail doctor/qualification closed on
  stale resident state.
- [x] Restart a controlled resident daemon and prove live plist, heartbeat, PID,
  and orphan-process agreement.
- [x] Make evaluation help non-executing, so discovery cannot load a large model.
- [ ] On every later activation change, rerun only the affected health probe and
  confirm no delivery setting widened.

**Gate:** no failed runtime gate; every external side effect remains draft-first
or explicitly owner-confirmed.

### 1. Label measurements before displaying them — complete

- [x] Reword run-outcome output as technical grounding diagnostics, never a
  personal usefulness score.
- [x] Preserve Attunement's existing `organic | controlled | unclassified`
  boundary as the sole source of user-outcome and learning claims.
- [x] Add a shared metric contract before any new aggregate: evidence class,
  source/version, denominator, time window, freshness, and action link are
  required; unknown provenance is excluded rather than guessed.
- [x] Keep factual task receipts distinct from feedback and from policy promotion.

**Gate:** a test fixture containing only controlled/unclassified data cannot
produce a user-effectiveness percentage, learning success rate, or autonomy
promotion signal.

### 2. Build an actionable personal status, not a vanity dashboard — complete

- [x] Default surface: blocked/held actions, pending owner feedback, continuity
  review progress, and the next safe action.
- [x] Learning surface: exact source-backed facts/preferences/strategies added,
  corrections awaiting review, and user vetoes; no inferred “learning score.”
- [x] Trust surface: delivery brake state, external drafts awaiting approval,
  runtime health, and an explanation of why Muse is held.
- [x] Keep raw token/cost/latency/tool counters under Diagnostics; rename their
  existing web surface to system metrics only if navigation evidence shows a
  user needs it.

**Gate:** every displayed card has one explicit action, or it is removed. Empty
states say what evidence is missing; they do not render zero as success.

### 3. Add resource admission and backpressure before enabling background work

- [x] First admission boundary: default-on daemon-only CPU/load and free-memory
  guard defers model, learning, email-sync, and browsing-sync work while keeping
  heartbeat, light delivery/safety checks, polling, conflict watch, and retention
  available. It fails open on an invalid local observation and resumes on the
  first admitted tick.
- [x] Keep valid explicit resource limits across resident restarts through the
  narrow LaunchAgent allowlist, and expose the resolved resident policy plus
  current admission verdict through the no-model/no-network `muse doctor
  --resources` diagnostic.
- [x] Persist only the latest admission decision and optional claimed-unit
  boundary as an owner-only local receipt; it is written on transitions/work
  boundaries, not sampled into a chart, and is shown as historical evidence
  separate from the live `muse doctor --resources` verdict.
- [x] Give the owner a live `muse daemon --pause-heavy-work` /
  `--resume-heavy-work` escape hatch. It persists locally, is re-read on each
  tick without restart, holds only model/sync/consolidation work, and records
  the bounded `owner-paused` deferral reason.
- [x] Inventory per-loop CPU, resident memory, model load, queue depth, and
  cancellation latency using local, privacy-safe process measurements.
- [ ] Define hard admission states: active user, low headroom, thermal/battery
  pressure when available, and idle. Heavy work must defer or cancel outside
  idle; correctness/security work never silently degrades.
- [ ] Put budgets around model concurrency, context/KV cache size, indexing
  batches, browser work, and retry loops. Queue one bounded unit at a time.
  Background model execution and automatic notes indexing are now bounded.
  Notes refresh uses one attempted embedding by default, persists exact
  resumable progress, publishes only complete files through immutable vector
  generations, and leaves explicit full reindex unlimited. Context/KV and
  shared retry-loop budgets remain open.
- [x] Emit only decision-grade telemetry: work admitted/deferred/cancelled and
  the policy reason. Do not sample a costly always-on dashboard.
- [x] Aggregate claimed-unit duration, CPU delta, maximum positive RSS growth,
  completion, and failure into a constant-size local workload profile. Doctor
  reports the largest cumulative-time unit; raw event history and continuous
  sampling remain intentionally absent.
- [x] Require an owner-visible escape hatch and a deterministic test seam for
  each admission decision.

The current slice additionally records per-unit CPU delta, RSS, candidate queue
depth, duration, and truthful cooperative stop-boundary latency. The broader
inventory item stays open until model load is measured directly. Its bounded
aggregate now survives daemon restarts and makes comparative dogfooding
possible without adding a dashboard or an unbounded telemetry log; thermal
production support and the wider model/cache/index/browser budgets also remain
open rather than being inferred from this daemon-only governor.

**Gate:** under an injected constrained-resource state, background work starts
zero new model/tool jobs, records a bounded deferral reason, and foreground chat
remains responsive. On recovery it resumes at most one bounded unit.

### 4. Triage old reminder backlog without automation — complete

- [x] Show counts/age bands only until the owner reviews the backlog; never send
  historical reminders merely because delivery is re-enabled.
- [x] Offer explicit per-item or owner-confirmed bounded-batch choices:
  dismiss, snooze to a supplied time, retain, or draft a digest.
- [x] Record an immutable action receipt for each choice; bulk operations require
  an exact preview and all-or-nothing validation.

**Gate:** a simulated backlog cannot cause an external send, deletion, or state
change without an explicit owner action; retries are idempotent.

### 5. Run bounded technical capability qualification

- [x] Add a no-side-effect preflight that lists the fixed 11-axis battery,
  expected model/runner requirements, and resource budget before the full run.
- [x] Require explicit execution intent, owner idle confirmation, a sufficient
  time budget, and a local CPU/RAM admission before the full pass^k capability
  evaluator can build or start a local model; expose the same decision through
  a read-only admission command.
- [ ] Publish the canonical v2 report only on a clean source/artifact snapshot;
  a partial/aborted run is unverified, never passing evidence.

**Gate:** fresh 11-axis report passes all required repeats with matching source
and artifact provenance. This proves technical capability only.

### 6. Collect real daily-use evidence before widening behavior

- [ ] Keep Continuity user-invoked. Gather life and work return moments across
  dates, with explicit `used | adjusted | ignored | rejected` feedback.
- [ ] Review negative outcomes and exact source links; change only the bounded
  display-policy reducer when evidence supports it.
- [ ] Treat receipts as corroborating progress only, never feedback or consent.

**Gate:** Attunement's longitudinal and first-window gates are satisfied by
organic evidence, then independently audited. No technical replay can fill the
gap.

### 7. Consider controlled delivery only after all prior gates

- [ ] Present an exact owner preview for a single, low-risk, local/log-only
  delivery cohort.
- [ ] Verify the resource governor, reminder quarantine, draft-first policy,
  and outcome ledger in that cohort.
- [ ] Keep self-learning and broader autonomy held until separately approved by
  their own evidence and permission gates.

**Gate:** the cohort has zero unapproved sends, no resource-budget breach, and
an auditable owner outcome for every proposed action. Passing does not grant
ongoing autonomy automatically.

## Metric catalog after the gates exist

| Surface | Allowed metric | Excluded metric |
| --- | --- | --- |
| Personal status | pending reviews, held actions, continuity evidence coverage | total tokens, total agent turns |
| Learning review | source-backed changes and corrections awaiting review | inferred learning score |
| Trust | approved/held/rejected proposals with explicit owner outcome | “autonomy level” based on activity count |
| Resource | admitted/deferred/cancelled background units by reason | continuous CPU/RAM charts by default |
| Diagnostics | token cost, latency, tool failure, grounding diagnostics | personal usefulness or promotion claim |

## Testing discipline

Each slice runs its affected deterministic tests first, then its boundary test:
store/schema changes use compatibility and corruption cases; scheduler/resource
changes use injected clocks/process state and cancellation tests; UI changes use
real-browser interaction only for the new user journey. The full capability
battery is an explicit qualification event, not a routine edit-loop command.
