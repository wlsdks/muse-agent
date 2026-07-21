---
title: Attunement architecture and data contract
audience: [engineering, product, security, agents]
purpose: Define the closed loop, privacy boundary, and implementation seams for Attunement
status: partial-implementation
updated: 2026-07-17
related: [../strategy/attunement.md, ../goals/attunement-implementation-plan.md, ../privacy-and-data.md]
---

# Attunement architecture and data contract

The full Attunement loop is **not shipped**. Slice A is implemented as a user-invoked tracer:
the user creates a `life` or `work` thread, links exact sources, opens a pack through the CLI
or local web/API surface, and records one of four outcomes. Exact local tasks, notes, and
context-only reminders are available; Observe, automatic affiliation, further source
adapters, and proactive timing-aware help remain roadmap work.

In plain language: start with an unfinished life or work thread the user chooses, build a
small “where was I?” pack from explicitly linked items, record whether it helped, and change
the next pack in only a few allowed ways. Observation is added later to improve timing—not
to guess what part of the user's life an app belongs to.

## System boundary

```text
chosen PersonalThread + explicitly linked items
  → Continuity Pack → outcome → allowed policy update → next pack

opt-in observation (later)
  → safer timing / rhythm evidence ───────────────────────┘
```

Slice A makes no LLM call. A later LLM may phrase an explanation or summarize an already
linked pack; it does not decide affiliation, consent, retention, interruption budgets,
evidence sufficiency, or action approval.

## Reusable current seams

| Concern | Existing seam | Honest limitation |
|---|---|---|
| Ambient input | `packages/proactivity/src/macos-ambient-source.ts`, `windows-ambient-source.ts`, `ambient-notice-loop.ts` | Produces snapshots; it does not persist dwell, transitions, or personal activity sequences. API/CLI source wiring is not yet symmetric. |
| Context safety | `packages/agent-core/src/ambient-context.ts` | Bounds and redacts untrusted context, but is not an Observe store. |
| Pattern primitives | `packages/memory/src/pattern-signals.ts`, `pattern-detector.ts`, `pattern-orchestration.ts` | Primarily note/task timing and limited CLI activity—not a cross-domain personal rhythm. |
| Intervention control | `packages/proactivity/src/interruption-gate.ts`, `packages/stores/src/proactive-trust-ledger.ts` | Budgets, digest, keep/acted/veto exist; pattern outcomes are not connected end to end. |
| Browser actuator | `packages/browser/src/controller.ts`, `browser-tools.ts`, `matcher.ts` | Strong semantic target observation and fail-close matching; no equivalent generic desktop action tree. |
| Audit/resume | `packages/runtime-state/src/run-history.ts`, `file-checkpoint-store.ts`, CLI `.muse/runs/*.jsonl` | Useful for Muse-run friction; some run history is in-memory without PostgreSQL. |

## Personal-thread contract

Muse must know which part of the user's life they mean before it combines a task, note,
reminder, calendar event, contact, run, or browser visit. Slice A supports exact local tasks,
notes, and reminders, and only the user can create the binding. An LLM may later summarize
linked evidence; it may not invent the association.

```ts
interface PersonalThreadLink {
  threadId: string;
  artifactType: "task" | "note" | "reminder"; // local Slice A adapters
  providerId: "local";
  artifactId: string;
  role: "context" | "next-step";
  linkedBy: "user";
  linkedAt: string;
}
```

Slice A stores the canonical full task/reminder ID or a canonical vault-relative note path.
Task and reminder input accepts a full ID or unique prefix only; it rejects text/title search.
Note input rejects absolute/`..` paths and a resolved realpath outside the vault. A thread has
at most one `next-step`, and it must be a user-linked open task. A reminder is context-only and
cannot create a factual interaction receipt, outcome, permission, or automation. Additional
artifact types and deterministic bindings are later adapters, not a fallback in this path.

### Continuity preparation module

`@muse/attunement` owns the shared preparation boundary. One deep local-source Module
dispatches task, note, and reminder Adapters behind the same validator/resolver Interfaces.
It resolves only already-linked canonical IDs, normalizes bounded user text, preserves valid
stored due timestamps and exact task tags, and never searches for a replacement. Preparation
captures its clock once, derives `due|overdue` on the transient task or pending-reminder
artifact, and reuses that same artifact in evidence; only an open task may appear in
`nextStep`.

User-open preparation reads state, builds from exact links, rejects Packs with no available
evidence, and opens a policy-version-checked delivery as one module operation. CLI and HTTP call that
operation. Timing `offer` uses the sibling read-only preparation Interface and cannot create a
delivery. Rendering stays surface-local; a hidden next step may expose only its exact
`artifactType:artifactId` marker, not title, summary, status, due timestamp, or tags.

Continuity review uses a sibling read-only core Module. It owns first-20 eligibility,
deterministic oldest-pending selection, progress, current-link verification, and exact
evidence resolution. CLI adds copy-ready commands as a surface-local Adapter; HTTP returns
the canonical domain projection and web renders it. A removed link or unavailable source is
shown as unavailable, never searched for, and merely fetching review cannot open a delivery,
record an outcome, or change policy.

Continuity evaluation is also one read-only core Module. It orders delivery and feedback
windows by parsed instant plus delivery id, holds the first-20 gate until every eligible Pack
has explicit feedback, and reports life/work longitudinal numeric coverage separately.
Only feedback-bearing deliveries contribute UTC opened dates. Ten feedback entries and two
UTC dates per kind complete the conservative numeric collection target, but the result is
`audit-required`, never ready or promoted: natural timing, distinct domains, comparability,
and strict action receipts remain a human evidence review. Invalid `openedAt` or `recordedAt`
fails closed rather than producing a trend or complete-looking evaluation.

## Minimal observation contract

The first persisted unit is an app session transition, not a raw screen sample:

```ts
interface ObservationEvent {
  id: string;
  source: "active-app" | "muse-run" | "browser-history";
  threadId?: string;
  appId?: string;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  consentVersion: number;
}
```

`threadId` is present only while the user has an explicit thread active. App identity alone
never decides whether an activity belongs to work, health, family, travel, or anything else.

Required envelope fields include provenance, source-specific retention, redaction result,
and a stable evidence ID. Window titles, selected text, clipboard contents, keystrokes, and
screenshots are not stored in the default profile. Browser history remains a separate,
explicit opt-in corroborating source.

## State and evidence

The Personal Rhythm Model v0 uses deterministic aggregates: dwell distributions by app
and time bucket, stable-block length, transition counts, and rapid-switch episodes. These
are hypotheses, not diagnoses.

Every friction candidate contains:

- evidence IDs and time range;
- deterministic rule/version and confidence;
- minimum recurrence threshold;
- user label: `normal`, `exploring`, `stuck`, or `unknown`;
- suppression state and expiry.

No user-facing claim is allowed without resolvable evidence. A `normal` or `exploring`
correction suppresses that candidate immediately.

## Intervention and outcome contract

An intervention records its evidence, policy decision, chosen form, offered action, and
delivery boundary. The canonical outcome enum is `used`, `adjusted`, `ignored`, or
`rejected`. `openedAt` is a separate delivery event, not an outcome. A permanent veto is a
`rejected` outcome with an explicit suppression instruction. Later stable dwell is a
separate behavioral observation, not proof of causality.

Continuity interaction evidence is also separate from outcome. An eligible new
delivery anchors the exact user-authored local next-step link and its observed
open-state fingerprint. When an existing trusted task-completion path later
commits that exact task as done, Muse may record an immutable `open-to-done`
receipt. The receipt never becomes `used`, feedback, permission, readiness, or
promotion evidence by itself. Legacy, relinked, ambiguous, unreadable, and
pre-delivery sources remain explicitly unavailable or uncorrelated.

The shared interaction report is a read-only factual view over that ledger. It
reports `exact | none | unavailable` counts and ratios for all deliveries and
separately for `life` and `work`. Completion latency uses only exact receipt
`completedAt - openedAt` values; zero samples remain explicit null statistics.
CLI and HTTP return the same core report. The report does not feed the outcome
reducer, longitudinal readiness, promotion, permission, or autonomy grants.

The report also carries an interaction-only longitudinal audit. Each thread kind
has a conservative collection target of ten canonical exact interactions across
two distinct UTC `openedAt` dates. Until both life and work meet both numbers the
status is `collecting`; numeric completion can only produce `audit-required`.
`none`, `unavailable`, and explicit outcomes do not count. This audit is a gap
tracker, not proof of natural timing, usefulness, causality, or permission.

The web review makes that factual loop usable without adding another scoring or
approval step. It displays the interaction audit independently from outcome
readiness. For the currently opened delivery, an inline completion action is
available only when the canonical report still says `none` and the Pack contains
the exact available `local/task/next-step` artifact in `open` state. The action
uses the existing authenticated task-completion route, then refetches both
reports. Task HTTP success proves the task effect, not receipt persistence: if
the refreshed report remains unchanged, the UI does not claim an exact receipt.
Loading, missing, errored, unavailable, exact, hidden, relinked, and completed
states all fail closed. This path never writes an outcome or expands permission.

Factual receipt delivery uses a bounded, owner-only sidecar outbox shared by the
API, local CLI, and loopback task surface. For a new `open → done` transition,
the task's serialized mutation chooses `completedAt` once and durably prepares
the exact `taskId + completedAt` event before writing the task. Recorder failure
therefore leaves a retryable event without rolling back the user's completed
task. API startup and later completion paths retry a bounded snapshot; delivery
is idempotent because the receipt and pending event IDs are deterministic.
Already-done tasks preserve their original timestamp and may deliver only an
existing matching event—Muse never synthesizes historical intent from a replay.
Open and unreadable sources remain pending; missing, timestamp-mismatched, and
not-correlated events terminate without a receipt. A corrupt or full outbox is
never overwritten: startup logs and remains available, while a new completion
fails before the task write so it cannot create another untracked effect.

Slice A adaptation may change only:

- detail (`standard` or `compact`);
- next-step presentation (`direct`, `contextual`, or `hidden`);
- whether the previous feedback is acknowledged in the next pack.

Later, separately reviewed adaptation may change:

- the focus threshold;
- evidence/recurrence threshold;
- quiet/surface boundary;
- intervention form (`silent-context`, `one-line-offer`, `digest`);
- source or candidate suppression.

It may not silently widen observed sources, retention, action permissions, recipients, or
third-party effects.

## Privacy and permission gates

Observe follows five testable properties:

1. **Local-first:** observation state is an owner-only local store; cloud use follows the
   existing provider choice and must never silently receive observation data.
2. **Visible:** status shows enabled sources, fields, retention, last sample, and derived
   hypotheses.
3. **Pausable:** pause stops OS reads by the next tick; disabled means zero source polling.
4. **Inspectable:** every hypothesis resolves to redacted evidence and rule version.
5. **Forgettable:** delete by event, time range, source, or all; derived state is rebuilt.

Per-app deny lists, private-window exclusion, atomic writes, `0600` permissions, TTL tests,
and source-level consent versioning are release gates. Observe must not ship before pause,
inspect, and forget work.

## Computer-use boundary

The near-term actuator is browser-only plus Muse-local notes/tasks. It reuses semantic
snapshots, stable refs, ambiguous-target refusal, approval, action budgets, prompt-injection
defanging, and checkpoints. No automatic form submission, third-party send, purchase, or
arbitrary desktop control is part of the first loop.

## Observability

Trace each observation decision, feature version, candidate evidence, intervention policy,
outcome, adaptation, and deletion cascade. Product metrics must be derivable without storing
raw content. The implementation gates are defined in the
[implementation plan](../goals/attunement-implementation-plan.md).
