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
explicitly links local tasks/notes, then runs `muse continue <thread-id>`. Muse shows the
connected source IDs and one user-linked open task. The user records `used`, `adjusted`,
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
- ✅ Slice A supports only local tasks and local notes. Reminders, calendar events, contacts,
  run logs/checkpoints, and browser history are later adapters.
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
- `muse thread review` reads the oldest unreviewed delivery in the first-20 window, resolves
  its exact persisted evidence, and prints copy-ready commands for all four outcomes.
  `--json` exposes deterministic progress. Review is read-only: only the user-authored
  `muse thread outcome` command may create feedback.

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
