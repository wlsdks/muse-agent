# Shared presence boundary evaluation — 2026-07-18

## Claim under test

Presence may affect terminal routing and model-synthesized reminder or proactive
text only when it is finite, non-negative, not in the future, and recent within
one shared window. Multiple Muse processes that share one filesystem must retain
the greatest valid activity timestamp, and the local sidecar must stay private.
Presence persistence is best-effort and must not delay chat requests.

This is a shared-filesystem multi-process contract. It is not a claim of remote
multi-device coordination or device identity.

## Before the change

The isolated baseline ran 12,036 deterministic cases. It produced 2,955 passes
and 9,081 failures while the existing API suite remained green. Reproduced
failures included older writers replacing newer timestamps, invalid or future
values erasing high-water state, future/non-finite values selecting the terminal
sink, cache-expiry regression, and a presence file created as `0644`.

## Deterministic evaluation

```sh
pnpm --filter @muse/proactivity build
pnpm --filter @muse/api build
node .muse-dev/evals/presence-boundary/dogfood.mjs
```

The fixed-seed rerun (`0x5eedc0de`) completed in 3.478 seconds with
12,123/12,123 passes:

- 12,026 pure logical/public-code cases, including 10,000 randomized high-water
  histories, 1,000 rapid single-writer cases, and 1,008 recent-activity cases;
- 89 durable sequential and boundary cases;
- eight separate Node-process writer races;
- corrupt, truncated, missing, unreadable, invalid-record, cache, permission,
  sink, and consolidation controls.

The committed integration tests additionally hold the exact presence file lock,
start two child processes behind one barrier, prove neither completes while the
lock is held, then release it and require the durable maximum. Removing the
internal lock makes that test fail. A real Fastify request test proves chat
returns while the presence lock remains held and then proves the hook eventually
persists a valid timestamp; both awaiting persistence and deleting the hook are
mutation-detected.

Focused verification passed:

- API tracker and held-lock request tests: 11/11;
- proactivity recent-activity and sink tests: 19/19;
- public reminder/proactive invalid-presence fallbacks: 2/2;
- API and proactivity type checks, scoped ESLint, and `git diff --check`.

Raw cases and the machine-readable summary remain only under
`.muse-dev/evals/presence-boundary/`. The directory is `0700`; `cases.jsonl` and
`summary.json` are `0600` and git-ignored.

## Boundary

This is deterministic synthetic technical evidence, not natural presence or
Attunement usefulness evidence. It does not touch `~/.muse`, send a message,
record a Continuity outcome, or expand permission. The run used a macOS local
filesystem; Windows CI, crash injection between lock/read/rename, timer-flush
I/O retry semantics, and remote/synchronized filesystems remain separate work.
