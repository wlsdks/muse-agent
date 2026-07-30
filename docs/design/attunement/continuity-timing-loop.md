# Thread-Scoped Continuity Timing Loop

## Purpose

This is Slice B of Attunement: an explicit personal thread can learn when to
offer an already-grounded Continuity Pack and when to remain silent. It is not
global surveillance, a general-purpose memory system, or an autonomous action
engine.

## Consent and storage

- The user starts a session for one existing `life` or `work` thread and gives
  an explicit consent revision.
- Only one timing session may be active at a time.
- State is owner-local at `${MUSE_ATTUNEMENT_FILE}.timing.json`.
- `pause` rejects every future observation. A collector must check the session
  before reading an OS signal, so pausing means zero reads on its next tick.
- `forget` atomically removes that session plus every observation, candidate,
  and feedback receipt derived from it.

## Data contract

An observation contains only:

- a fixed app category: `communication`, `planning`, `research`, `writing`,
  `building`, or `other`
- an ISO start/end time and duration
- session and thread identifiers

Window titles, application names, selected text, clipboard contents,
screenshots, keystrokes, URLs, and model interpretations are not fields in the
public API or persisted schema. Unknown JSON keys fail closed, including a
corrupted local file carrying raw desktop data.

## Deterministic reducer

The reducer produces an inspectable candidate with evidence observation ids,
rule version, and a reason:

- no observation, short focus, or no category change -> `silent`
- stable focus followed by a category boundary -> `offer`
- an otherwise eligible boundary inside the learned offer cooldown -> `digest`

An `offer` is permission to display an existing exact-source Continuity Pack.
It never sends a message, invokes a model, changes a task, or contacts anyone.

## Feedback

`used`, `adjusted`, `ignored`, and `rejected` feedback is immutable. It can
only make the offer cooldown more conservative; it cannot expand collection,
retention, permissions, delivery channels, recipients, or autonomous actions.

## Interfaces

CLI commands:

```text
muse timing start <threadId> --consent-version <n>
muse timing pause|resume|forget|inspect <sessionId>
muse timing record <sessionId> --category <category> --duration-ms <n> --started-at <iso> --ended-at <iso>
muse timing evaluate <sessionId>
muse timing feedback <candidateId> <used|adjusted|ignored|rejected>
```

Authenticated API equivalents live under `/api/attunement/timing/`. The
evaluation endpoint returns a Continuity Pack only for an `offer` candidate.
