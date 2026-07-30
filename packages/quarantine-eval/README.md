# @muse/quarantine-eval

A strict, resource-bounded validator and scorer for the `muse.synthetic-quarantine-result.v1`
fixture format: baseline vs. candidate artifacts scored against a fixed holdout under a pinned
fixture hash, always returning `promotionState: "PROMOTION_DISABLED"`. It never promotes a
result to production use — it only reports `QUARANTINED`/`SHADOW`/`INVALID`.

## Public surface

- `.` (`src/index.ts`) — `evaluateSyntheticQuarantineJson(rawJson, frozenAsOf)`, returning a
  `QuarantineResult` (`InvalidQuarantineResult` | `ScoredQuarantineResult`), plus the result and
  error-code types (`ValidationErrorCode`, `QuarantineValidationError`,
  `InvalidQuarantineResult`, `ScoredQuarantineResult`).

## Depends on

No internal `@muse/*` runtime dependencies — the parser, canonicalizer, and validator are
self-contained (only `node:crypto`).

## Rules that bind this package

- Every result carries `promotionState: "PROMOTION_DISABLED"` unconditionally — this package
  never emits a promotable verdict, matching `../../.claude/rules/verification/agent-testing.md`'s promotion
  discipline (promotion requires an exact candidate-bound human review, never an automated
  verdict alone).
- Parses JSON with a hand-written, resource-bounded parser (nesting depth, object/array member
  caps, string/number length caps, a 64 KiB input ceiling) rather than `JSON.parse`, because the
  input is an untrusted external artifact, per `../../.claude/rules/engineering/architecture.md`'s "tool
  output is untrusted" posture.
- Canonicalization rejects non-finite numbers, `-0`, and unpaired surrogates before hashing, so a
  hash comparison can't be defeated by a value that doesn't round-trip through JSON.

## Tests

`pnpm --filter @muse/quarantine-eval test`
