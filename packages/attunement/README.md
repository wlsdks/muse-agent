# @muse/attunement

The Continuity Pack and Attunement policy layer: preparing a resumable "unfinished thread"
artifact, evaluating longitudinal outcomes into a policy, and the Observe/Timing session
stores that feed it. It is a package rather than a folder because it is the one place that
turns raw personal-store evidence into the policy Muse actually acts on.

## Public surface

- `prepareContinuityPack`, `openPreparedContinuityPack`, `readPreparedContinuityPack` — build
  and read a Continuity Pack artifact.
- `computeContinuityEvaluation`, `prepareContinuityReview` — longitudinal outcome evaluation
  and the owner-facing review projection.
- `BASELINE_POLICY`, `policyForOutcome`, `isBaselinePolicy` — the deterministic policy reducer.
- `createPersonalThread`, `linkArtifact`, `unlinkArtifact`, `recordContinuityOutcome`,
  `openContinuityDelivery`, `readAttunementState` — the `AttunementStoreError`-backed thread
  store (`attunement-store.ts`).
- `startTimingSession`, `evaluateTimingSession`, `recordTimingObservation`,
  `projectMagShadowTimingDecision` — the Shadow-timing session store and MAG projection.
- `startObserveSessionSafe`, `pauseObserveSession`, `forgetObserveSession`, `observeStatus` —
  the pausable/forgettable Observe session lifecycle.
- `proposeExperienceLearningCandidate`, `promoteApprovedExperienceLearningContinuityPolicy`,
  `createExperienceLearningApprovalReceipt` — the experience-learning-to-policy promotion path.
- `./host`, `./state-validation`, `./continuity-source-observations`, `./continuity-snapshots`
  — additional public subpaths for the production-authorized host wiring, state parsing
  (`parseAttunementState`), and source-observation/snapshot types.

## Depends on

- `@muse/stores` — the file-backed personal stores this package reads/writes through.
- `@muse/policy` — capability/consent types used by the Observe consent gate.
- `@muse/calendar` — calendar event types referenced by artifact validators.
- `@muse/runtime-state` — shared runtime state types.
- `@muse/shared` — shared types and utilities.

## Rules that bind this package

- [`../../docs/strategy/attunement.md`](../../docs/strategy/attunement.md) — the product contract this package implements: Shadow
  Muse → Continuity Capsule → visible Policy Card, with existing stores remaining
  authoritative and the graph/policy layer staying rebuildable.
- [`../../.claude/rules/outbound-safety.md`](../../.claude/rules/outbound-safety.md) — Observe must stay visible, pausable, inspectable,
  and forgettable, and must not persist raw keystrokes or continuous screen capture by default.

## Tests

```bash
pnpm --filter @muse/attunement test
```
