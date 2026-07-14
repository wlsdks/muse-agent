---
title: Attunement Slice B safety contract
audience: [product, engineering, evaluation]
purpose: Prevent partial Observe work from collecting data or sending notices before user control and focus gates exist
status: proposed
updated: 2026-07-15
related: [attunement-implementation-plan.md, ../strategy/attunement.md]
---

# Attunement Slice B safety contract

## Decision

Do not add an Observe collector, OS integration, or proactive Continuity Pack
delivery independently. Slice B starts only with one user-visible, local state
machine that proves all of the following together:

1. The user explicitly starts observation for one existing personal thread.
2. `pause`, `inspect`, and `forget` are available before the first collected
   event can influence a notice.
3. A paused or disabled state performs zero OS reads and contributes no event.
4. A Focus Hold state suppresses every optional Muse notice before its outbound
   delivery path; scheduled reminders and due-critical alerts are not routed
   through that hold.
5. A boundary may offer at most one existing Continuity Pack or digest. It may
   not create a new goal, link a source, or infer an outcome.

The current runtime has interruption-budget, digest, veto, and activity-history
substrates. It does not have an Observe state store, an active-thread binding,
or a Focus Hold signal. Adding any one of those in isolation is not a Slice B
implementation and must not be presented as one.

## First shippable vertical slice

### User contract

```
muse observe start <thread-id>
muse observe status
muse observe pause
muse observe resume
muse observe inspect
muse observe forget
```

- `start` rejects an unknown thread and replaces no existing active thread
  without an explicit user choice.
- `inspect` shows the active thread, state, event count, source kinds, and TTL;
  it never displays raw title, clipboard, selection, keystroke, screenshot, or
  opaque external payload data.
- `forget` atomically deletes the current session and its derived aggregates.
- `resume` never restores a forgotten session.

### Minimal persisted record

The first store is owner-only and atomically written. It contains only:

- schema version and lifecycle state: `disabled | active | paused`;
- explicit `threadId` and user-authored start/resume timestamps;
- bounded, TTL-governed event metadata needed for deterministic stable-block
  aggregation; and
- a source-kind allowlist plus deletion receipts.

It contains no raw user content. A schema without TTL, deletion, or a source
allowlist fails closed on read and is not migrated by guessing.

## Runtime wiring order

1. Resolve Observe state once per optional-notice tick.
2. If `disabled` or `paused`, do not call an OS reader and do not write an
   event. This is a hard gate, not a best-effort filter after collection.
3. If `active`, collect only the allowlisted metadata bound to that exact
   `threadId`; unbound activity is discarded before persistence.
4. Run deterministic aggregation only after the persisted event passes TTL and
   shape validation.
5. Pass Focus Hold to the existing optional-notice delivery seam before
   `applyInterruptionBudget`. Hold queues at most one boundary digest/offer and
   never calls the outbound `deliver` function.
6. The boundary may surface the existing user-linked Continuity Pack. Opening
   it remains a delivery; `used`, `adjusted`, `ignored`, and `rejected` remain
   explicit user feedback only.

## Required proof before enabling a collector

- Disabled and paused runs make zero OS-read calls, including during an
  overlapping scheduler tick.
- `forget` leaves no readable event or aggregate and a subsequent `resume`
  starts a distinct empty session.
- An event cannot be persisted without an active explicit thread binding.
- Focus Hold produces zero optional outbound sends and no more than one
  queued boundary offer.
- Reminders and due-critical notices retain their existing delivery behavior.
- Every surfaced pack has exact current evidence; unavailable-only packs create
  no delivery or outcome record.
- The life and work outcome gates remain reported separately. Passing either
  one never enables automatic delivery.

## Stop conditions

Stop implementation and return to Slice A usefulness if any of these occur:

- pause cannot prevent the next scheduled read;
- inspect or forget cannot account for every stored event;
- Focus Hold suppresses a requested or due-critical notification;
- a collector needs raw text, screenshots, clipboard data, or an inferred
  thread link to be useful; or
- a proposed shortcut bypasses the existing interruption-budget/veto delivery
  seam.

## Non-goals

- desktop or IDE autonomy;
- automatic thread discovery or link creation;
- model-derived outcomes, friction labels, or timing decisions;
- external sends; and
- promotion of a `hold` or `manual-only` outcome gate into automatic delivery.
