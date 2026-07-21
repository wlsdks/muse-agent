---
title: Attunement implementation plan
audience: [product, engineering, evaluation]
purpose: Deliver and falsify the first Attunement closed loop through dependency-ordered slices
status: proposed
updated: 2026-07-13
related: [../strategy/attunement.md, ../design/attunement.md, ../privacy-and-data.md]
---

# Attunement implementation plan

## What we are proving

The first question is not “can Muse watch the desktop?” It is:

> When I return to something unfinished in my life or work, can Muse restore the right
> context, suggest one useful next step, and learn from my response?

Examples include preparing for a hospital visit, continuing a trip plan, contacting someone,
finishing an article, or resuming a work project. Start with a version the user deliberately
opens. Add automatic detection only after the basic help is useful.

## How to read the plan

The slices below are ordered by dependency, not by days or weeks. Each slice must produce
something a user can try and a gate that can prove it works. Do not build several partial
subsystems and call their combination “Attunement.”

Terms used below:

- **Personal thread:** one unfinished topic the user chose, from daily life or work.
- **Continuity Pack:** a small bundle showing the linked context and one next step.
- **Outcome ledger:** one canonical state: `used`, `adjusted`, `ignored`, or `rejected`.
- **Policy reducer:** deterministic code that turns the outcome into a small, allowed change
  for the next pack.

## Slice A — user-invoked Continuity Pack

**Implemented local CLI experience:** the user runs `muse thread start <title> --kind life|work`,
explicitly links local tasks, notes, reminders, and configured calendar occurrences, then runs `muse continue <thread-id>`.
Muse shows the connected source IDs and one user-linked open task. Reminders are context
only. The user records `used`, `adjusted`,
`ignored`, or `rejected` explicitly with `muse thread outcome`; opening is a separate delivery
event and is never treated as a helpful outcome.

This is the tracer bullet: one thin path through thread → pack → feedback → changed next
pack. It does not require desktop observation.

**Build**

- ✅ `packages/attunement/` has `PersonalThread`, exact artifact links, Continuity Pack
  construction, delivery/outcome records, reset/undo receipts, and a deterministic display
  policy reducer.
- ✅ A shared preparation Module now owns canonical local resolution, one-shot due-state
  derivation, unavailable-only Pack rejection, and policy-version-checked delivery opening.
  CLI and HTTP use the same open Interface; timing offers use its read-only preview path.
- ✅ `muse thread start|list|link|unlink|continue|inspect|outcome|reset|undo-reset` and the
  short `muse continue` entry point are available.
- ✅ New deliveries can anchor one exact open local next-step and trusted local
  task completion paths record an immutable factual interaction receipt. CLI
  and authenticated HTTP expose the same mutation-free projection and digest,
  including life/work-separated state coverage and exact-only completion
  latency; explicit outcomes remain a separate ledger and legacy deliveries
  remain unavailable.
- ✅ Slice A supports exact local tasks, notes, reminders, and provider-bound calendar
  occurrences. `muse calendar events` exposes a separate copyable Continuity reference;
  CLI, HTTP, and web require an explicit configured provider and resolve that exact occurrence
  without provider fallback. Calendar context remains read-only and context-only. Reminder IDs are accepted only
  as a full ID or unique prefix, resolve to the canonical full ID, and remain context-only;
  they cannot become a next step, factual interaction receipt, outcome, permission, or
  automation. Contacts, run logs/checkpoints, and browser history are later
  adapters.
- ✅ Only the user binds an item to a `threadId`; no deterministic auto-link or LLM summary is
  present in Slice A.
- Treat `work` as one optional thread kind. It must not be the default meaning of every
  thread.

**Gate**

- A pack uses only items linked to the selected thread, with resolvable evidence IDs.
  Unsupported “where you left off” claims are omitted.
- Browser history is absent unless separately enabled; no form submission or external send.
- `muse thread outcome` accepts only `used`, `adjusted`, `ignored`, and `rejected`; no timeout
  or model inference creates a hidden outcome.
- Golden tests prove `outcome N → allowed policy change → different pack N+1`.
- Replaying the same outcome is idempotent; reset restores the baseline.
- A policy change may affect only pack form, detail level, suggestion threshold, or
  suppression. It cannot expand data sources, retention, permissions, recipients, or actions.
- Golden examples cover both a daily-life thread and a work thread; neither may rely on a
  work-only field or prompt.
- One shared review Module reads the oldest unreviewed delivery in the first-20 window,
  resolves only its still-linked exact evidence, and exposes deterministic progress to CLI,
  HTTP, and web. CLI adds copy-ready commands for all four outcomes as a surface-local
  Adapter. Review fetches are read-only: only an explicit user-authored outcome action may
  create feedback.

**Kill criterion:** if fewer than 20% of the first 20 eligible packs are used, or more than
30% are rejected, stop adding automation. Fix the pack's usefulness first. Passing this
threshold is measurement evidence only; it never grants permission for proactive delivery.

### First-20 batch result — 2026-07-17

The first ledger window is complete: raw outcomes are `used 12`, `adjusted 6`,
`ignored 2`, `rejected 0`. A strict receipt audit excludes two historical
`used` entries without concrete task-advancing evidence, yielding a conservative
10/20 use lower bound. The numerical kill threshold therefore does not kill
manual Slice A, but it does **not** authorize automation.

This was agent-operated, mostly same-session batch dogfood. The life sample is
only a grocery/milk stress stratum, not broad or longitudinal daily-life
evidence. Keep delivery user-invoked and hold Slice B. Before another promotion
review, collect matched life/work return moments across dates. The immediate
follow-up now exposes deterministic due/overdue state and tags from the exact
linked task across CLI/API/web and removes duplicated contextual notes. Hidden
web next steps retain only the safe exact reference marker; timing preview opens
no delivery. Post-window delivery 21
confirmed the rendering but was honestly scored `adjusted`, so automation stays
held. Full evidence and the raw/strict audit:
[`../evaluations/continuity-first-20-2026-07-17.md`](../evaluations/continuity-first-20-2026-07-17.md).

A shared longitudinal evidence gate now makes the remaining collection gap explicit without
changing that ledger: the real read-only state is `life 6/10` and `work 15/10` feedback,
with both kinds spanning `2/2` UTC dates. Status remains `collecting` because life needs four
more explicit outcomes. Even after numeric coverage, the only next status is
`audit-required`; code cannot certify natural timing, domain diversity, comparability, or a
strict action receipt, and it never enables automation.

Interaction receipts improve that future audit without filling the four-outcome
gap: they can prove an exact linked task changed after a Pack, but never infer
whether the Pack was useful. The next life episodes still need distinct natural
return moments and explicit calibration feedback.

A 24-delivery controlled shadow run now covers `{life, work} × {exact, none,
unavailable}` with four cases per cell through supported CLI commands. It
recorded eight exact receipts, zero explicit outcomes, no permission/grant
fields, byte-stable report reads, and receipt-stable replays. This passes the
implementation shadow gate only; the same-session timing distribution is not
natural resumption evidence and cannot release Slice B or autonomy. Details:
[`../evaluations/continuity-interaction-shadow-24-2026-07-18.md`](../evaluations/continuity-interaction-shadow-24-2026-07-18.md).

The shared report now exposes the remaining interaction evidence gap directly:
each kind needs ten exact receipts across two UTC opened dates before moving from
`collecting` to `audit-required`. Generated stress data remains offline and cannot
fill this gate. A 5,000-cohort / 174,548-item production-vs-oracle evaluation had
zero mismatches and caught an off-by-one mutation, while an aggregate-only read of
the actual default state preserved both Attunement and tasks bytes. Actual coverage
is still life `0/10`, work `0/10`, and `0/2` dates for both, so no usefulness,
naturalness, permission, or automation claim is released. Evidence:
[`../evaluations/continuity-interaction-longitudinal-audit-2026-07-18.md`](../evaluations/continuity-interaction-longitudinal-audit-2026-07-18.md).

The web review now closes the natural collection path without fabricating any
evidence: it renders that shared audit separately from outcome readiness and
offers completion only for the opened delivery's current canonical `none`, exact
available local open next-step task. It reuses the authenticated task endpoint
and refetches the authoritative reports; task success is not presented as proof
that a receipt persisted. Chromium interaction tests cover the success, retry,
recorder-failure, divergent-gate, and fail-closed cases. The actual read-only
audit remains life `0/10`, work `0/10`, and `0/2` dates for both, so the next
evidence must come from ordinary use rather than fixtures. Evidence:
[`../evaluations/continuity-natural-evidence-loop-2026-07-18.md`](../evaluations/continuity-natural-evidence-loop-2026-07-18.md).

The factual completion path is now crash-recoverable rather than best-effort.
API, local CLI, and loopback completion prepare an exact bounded sidecar event
inside the serialized task mutation before the done write, then retry the shared
recorder after commit. API startup drains a bounded snapshot without blocking
readiness on corrupt state; corrupt/full outboxes remain byte-preserved and stop
new untracked completions before their task write. Tests cover restart recovery,
old-done no-synthesis, open/mismatch classification, recorder-success-before-ack
replay, queue bounds, and exact-one receipts. This improves evidence durability
only; actual natural coverage remains unchanged. Evidence:
[`../evaluations/continuity-interaction-outbox-2026-07-18.md`](../evaluations/continuity-interaction-outbox-2026-07-18.md).

The first actual post-outbox collection cycle is now open on the sole existing
user-authored work next-step that was still exact and open. A fail-closed
one-shot runner rechecked the candidate and all source bytes immediately before
invoking the public CLI command once. The actual ledger moved from 21 to 22
deliveries and from zero to one `none` interaction; tasks and the receipt outbox
were unchanged, no receipt or outcome was created, and exact coverage remains
life `0/10`, work `0/10`. This is collection readiness, not natural completion
evidence or permission. Evidence:
[`../evaluations/continuity-natural-collection-cycle-1-2026-07-18.md`](../evaluations/continuity-natural-collection-cycle-1-2026-07-18.md).

The shared exact-artifact resolver boundary now revalidates artifact id, type,
provider, and role before evidence can become available or a delivery can open.
`undefined` remains an unavailable source and resolver errors still propagate;
identity mismatch, throw, and all-unavailable open failures preserve the entire
Attunement file and do not allocate delivery/run ids. A fixed-seed offline
evaluation covered all 126 public preview/open signatures and 10,000 core
stress cases with zero mismatch omissions, control drift, evidence laundering,
or oracle mismatches. Its generated corpus is ignored synthetic evidence only;
it does not change natural coverage, outcomes, policy, or permission. Evidence:
[`../evaluations/continuity-provider-boundary-2026-07-18.md`](../evaluations/continuity-provider-boundary-2026-07-18.md).

Continuity evidence now carries durable provenance independently on delivery,
outcome, interaction receipt, and the crash-recovery outbox. Readiness requires
matching production-authorized pairs; controlled and legacy-unclassified data
remain visible only in technical digests. This supersedes earlier raw ledger
counts as a promotion signal: the actual current organic readiness is 0, while
the historical 22 deliveries and 21 outcomes remain preserved as unclassified
technical evidence. A reproducible aggregate evaluation kept 10,080 controlled
exact pairs at readiness 0 and classified 1,000 ordinary-input attempts as
unclassified, with no change to the real local store. This still does not
authorize Slice B, proactive delivery, or autonomy. Evidence:
[`../evaluations/continuity-evidence-provenance-2026-07-18.md`](../evaluations/continuity-evidence-provenance-2026-07-18.md).

## Slice B — safe observation and better timing

**User experience:** after the user explicitly starts a personal thread, Muse can notice a
stable activity block, hold its own optional notices, and offer the existing Continuity Pack
at a natural return point. The user can see, pause, or delete everything Observe collected.

**Build**

- Add minimal app-session events, an atomic owner-only store, source TTL, and a focus-state
  reducer to `packages/attunement/`.
- Add `muse observe status|start|pause|resume|inspect|forget`.
- Attach an observation to a thread only while that explicit thread is active.
- Unify ambient source selection used by API and CLI.
- Extend `packages/proactivity/src/interruption-gate.ts` so stable focus holds only
  Muse-generated optional notices. User-scheduled reminders and due alerts stay exempt.

**Gate**

- Disabled or paused means zero OS reads; pause applies by the next tick.
- Store writes are atomic, owner-only (`0600`), TTL-aware, inspectable, and deletable.
- Raw titles, clipboard text, selections, keystrokes, and screenshots never enter the
  default observation store.
- Focus means zero optional Muse notices; a boundary produces at most one digest or offer.
- The Slice A pack still works when Observe is off.

**Kill criterion:** Observe does not ship without pause, inspect, and forget. If Focus Hold
suppresses a requested or due-critical notice, stop and fix notice classification first.

## Slice C — personal rhythm and recurring friction

**User experience:** after enough evidence exists, Muse can ask a retrospective question
such as “Was this switching normal, exploration, or did it make this harder to continue?”
It does not silently diagnose the user.

**Build**

- Add deterministic dwell, stable-block, and transition aggregates.
- Create evidence-linked friction candidates only from observations bound to a personal
  thread.
- Connect each question and answer to the same outcome ledger and policy reducer.
- Expose the same inspect/reset view through CLI and API.

**Gate**

- No candidate without evidence IDs, rule version, confidence, and a recurrence threshold.
- Require at least three comparable episodes across two distinct dates before asking.
- `normal` or `exploring` immediately suppresses that candidate.
- An LLM may explain a candidate in plain language; deterministic code decides whether it
  qualifies and what data supports it.
- Property tests prove adaptation cannot widen consent, retention, approval, or action scope.
- A daily-life routine must not be described with workplace language unless the user labeled
  it as work.

**Kill criterion:** if more than half of the first 20 questions are labeled `normal` or
`exploring`, retire rapid switching as a friction signal. If rejection exceeds 30%, stop
automatic questions and keep only a user-opened review.

## Product evaluation

- Start with users who have at least three comparable returns to unfinished threads; do not
  count passive observation volume as value.
- Measure pack use, rejection, corrected links, time to resume, and preference for a short
  line versus a detailed pack.
- Report daily-life and work threads separately so success in one cannot hide failure in the
  other.
- For users with at least ten comparable interventions, compare the first five with the next
  five. If usefulness does not improve, freeze automatic adaptation and keep explicit user
  settings only.
- Every release candidate reviews store schemas and deletion cascades, not user content.

## Expansion gate

Only after the Muse-managed and optional browser loop passes should a separate plan consider
generic desktop or IDE control. Each new surface needs a semantic state model, explicit
personal-thread binding, deterministic target resolution, recovery, permission, and an
outcome link. Better model reasoning cannot replace those controls.
