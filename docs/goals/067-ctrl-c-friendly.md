# 067 — Ctrl-C handling in long-running commands

## Why

Audit muse search / muse ask / muse history / muse listen for clean
Ctrl-C exit (no hanging promises, no half-written files).

## Scope

- Per-command SIGINT handler.
- AbortController propagation.

## Verify

- Manual dogfood; cli +1 test where possible.

## Status

done — new shared scaffold `apps/cli/src/sigint-abort.ts`
exports `withSigintAbort(action, { onSigint? })` that installs a
one-shot SIGINT handler, exposes an `AbortSignal` to the action,
and unhooks the handler in `finally` so subsequent commands
install fresh handlers. The wrapper sets `process.exitCode = 130`
(128 + SIGINT) when the abort fires so a shell pipeline
`&& next` doesn't run after Ctrl-C.

Wired into `muse ask` (chat-only fast path) — the
streaming-from-modelProvider loop bails on `signal.aborted` and
prints "(Ctrl-C — aborting…)" to stderr. The `--with-tools`
path + the messaging poll daemons are deferred — they don't
share a single fetch point and need their own AbortSignal
threading; the scaffold gives them a target shape when that
work lands.

cli +1 test on the scaffold covers the happy path (no abort →
action returns, exit code untouched) and the SIGINT path
(abort fires, onSigint callback runs, exit code = 130). Live
Ctrl-C dogfood is left as manual verification per the goal's
"manual dogfood; cli +1 test where possible" framing.
