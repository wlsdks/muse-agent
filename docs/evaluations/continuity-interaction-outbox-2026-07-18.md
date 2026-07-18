# Continuity interaction outbox evaluation — 2026-07-18

## Claim under test

A local task completion that commits while Continuity receipt recording fails
must remain recoverable across process restart. Recovery must be exact,
idempotent, bounded, and independent from outcomes or permission.

## Design evidence

- API, CLI-local, and loopback completion choose one `completedAt` under the
  serialized task mutation and prepare `taskId + completedAt` before the done
  write.
- The sidecar uses cross-process locking, fsynced atomic rename, owner-only
  `0600` mode, a 256-event hard cap, and 64 events per retry batch.
- Missing sidecar means empty. Malformed, unsupported, duplicate, hash-mismatched,
  or over-capacity state fails closed without overwriting its bytes.
- Recorder failure retains the event while task completion remains successful.
  API `onReady` retries a bounded snapshot but logs and preserves readiness if
  the whole sidecar is corrupt.
- Already-done tasks preserve their original timestamp and retry only an existing
  matching pending event. A replay cannot invent historical evidence intent.

## Failure-path evidence

- API integration creates a valid Pack, temporarily corrupts Attunement, commits
  the task, restores Attunement, and starts a new Fastify runtime. `onReady`
  records exactly one receipt without another task request.
- Corrupt outbox startup remains ready, but a new completion returns failure and
  leaves both task status and corrupt bytes unchanged.
- CLI-local and loopback tests repeat a failed delivery through an already-done
  task and prove the original `completedAt` is unchanged.
- Package tests retain open work, terminally remove timestamp mismatches, reject
  a full queue without eviction, and simulate a crash after receipt recording
  but before pending acknowledgement by re-preparing the deterministic event.
  The replay removes the pending item while the receipt count remains one.

## Verification

| Check | Result |
| --- | --- |
| Attunement outbox + interaction focused tests | PASS — 12/12 |
| API task/receipt integration | PASS — 3/3 |
| CLI task public behavior | PASS — 41/41 |
| Autoconfigured loopback public behavior | PASS — 16/16 |
| Full `@muse/attunement` suite | PASS — 150/150 |
| Full `@muse/domain-tools` suite | PASS — 913/913 |
| Full `@muse/autoconfigure` suite | PASS — 908/908 |
| Affected TS7 project build | PASS |
| Changed-file ESLint | PASS |
| Full repository `pnpm check` | PASS |

## Product boundary

The outbox contains only factual delivery intent. It does not contain or write
`used | adjusted | ignored | rejected`, feedback, permission, grants, or
autonomy state. Synthetic fixtures verify failure handling but do not change the
actual local interaction baseline or count as natural evidence.
