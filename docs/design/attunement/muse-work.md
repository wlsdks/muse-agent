# Muse Work — binding flows, board and continuity into one unit of "work"

> **Status: SHIPPING IN SLICES (2026-07-22).** The local Work store, the CLI/API verbs, outcome
> recording, flow-deletion cleanup and the exact Personal Continuity context link have shipped. A
> dedicated web Work detail view and chat promotion are still roadmap.

## Why

Jinan's original direction: "the final form of this has to be work." Today the parts of a piece of
work are scattered across three places — **flows** (recurring automation, the graph view over
scheduler jobs), **the board** (`muse board` — the durable task queue and approvals), and
**continuity threads** (`muse thread` — resuming interrupted work with its evidence). The thing the
user actually means by "one piece of work" ("prepare the birthday party", "the Q3 report") does not
exist in the system.

Work is not a new runtime — it is a **binding**: a one-line goal plus the flows, board tasks and
continuity thread that belong to it, plus its outcome record. Within Personal Continuity's
"thread → pack → outcome → adaptation" loop, Work is the work-specialised extension of a thread: one
mode, not the product boundary (see `product-identity.md`).

## Data contract (one new store)

```
~/.muse/works.json   (follows the encrypted-file convention)
Work {
  id, name, goal,            // the one-line goal the user wrote
  flowIds: string[],         // scheduler job ids — the automation running for this work
  boardTaskIds: string[],    // muse board task ids
  threadId?: string,         // the continuity thread, if there is one
  status: "active" | "paused" | "done",
  outcomes: [{ atIso, note, kind: "used"|"adjusted"|"ignored" }],  // isomorphic to thread outcome
  createdAtIso, updatedAtIso
}
```

The principle: store references only, never copies. The lifecycle of a flow, task or thread is owned
by its own store, and deleting a Work only cuts the references. The lesson from linking two stores —
audit *every* lifecycle operation (the calendar↔reminder link) — applies directly here: a hook that
cleans a deleted job out of `Work.flowIds` has to be part of the acceptance criteria.

Any product entry point that changes the Work↔PersonalThread relationship uses the relationship
coordinator that locks both files in a fixed order. Work evidence links, `Work.threadId` and deletion
on either side fail before they can contradict each other or leave a dangling state, until an
explicit unlink/clear happens. A Work inside Continuity is context only; it does not acquire Work's
own `done`/`outcome` authority.

## Surfaces

- **Web**: a "Work" entry under the "My life" LNB section (or an extension of the continuity view —
  decided at implementation time). Work detail = goal header + three sections (a link to the flow
  mini-canvas / a board-task checklist / a thread continue button) + the outcome timeline.
- **CLI**: `muse work list|show|start|link|outcome|done` — symmetric with the existing thread, board
  and scheduler verbs.
- **Chat**: "let's keep going with this" → proposes a Work through the same promotion path as thread
  creation (a proposal, not automatic creation — the user confirms).

## Safety (unchanged, restated)

- Work creates no new execution authority. Flow execution keeps the scheduler's existing gates,
  outbound stays behind the existing channel approval gate (draft-first), and banking is permanently
  out of scope.
- A Work's "done" is decided by a recorded outcome, not by self-report (the termination principle
  from agent-testing).

## Slices (each independently shippable)

1. **W1 — store plus CLI skeleton**: `works.json` and `muse work list|start|link|show`, referential
   integrity tests (linking a non-existent `flowId` is refused), lifecycle audit hooks.
2. **W2 — web Work view**: read-only detail (the three sections), LNB placement decided.
3. **W3 — outcome loop**: `muse work outcome` plus its effect on the next pack and brief (handled
   isomorphically to a continuity outcome).
4. **W4 — chat promotion path**: the propose-then-confirm flow (reusing the clarify-directive).

## Open questions (Jinan decides before implementation)

- LNB placement: a new "My life > Work" entry, or an extension of the continuity view? (without
  conflicting with the navigation-curation principle)
- A cap or cleanup policy for flows per Work — how to make visible the state where a dead Work keeps
  running automation (a Work badge on the scheduled-automatic-activity tab, for example).
