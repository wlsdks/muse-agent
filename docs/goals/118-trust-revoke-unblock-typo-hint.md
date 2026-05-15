# 118 — `muse trust revoke` / `unblock` hints when target tool isn't listed

## Why

`muse trust revoke noteon.write` (typo for `notion.write`) was a
silent success: `withoutValue(list, "noteon.write")` returns the
unchanged list, `mutate` rewrites the file with the same content,
and the action prints `Revoked 'noteon.write' for stark (now 3
trusted)` — implying the typo'd entry got revoked when in fact the
real `notion.write` is still trusted.

Same shape for `unblock`. Both surfaces are idempotent (removing
nothing leaves nothing) but a typo shouldn't read as silent
success — JARVIS-class would say "sir, that isn't on the list —
did you mean …?".

## Scope

- `apps/cli/src/commands-trust.ts`:
  - `revoke` action peeks the pre-state via `readTrustFile`,
    checks `wasPresent = beforeEntry.trustedTools.includes(tool)`,
    then runs the existing `mutate` (still idempotent).
  - When `wasPresent === false`, emit a stderr warning naming the
    user key, with an optional `closestCommandName` suggestion
    against the pre-state trusted list. Skip the success line.
  - `unblock` action mirrors the same shape against
    `blockedTools`.
  - Exit code stays 0: the operation is genuinely idempotent —
    the trust file already reflects what the user wanted, just
    not via the name they typed. Scripted callers don't break.

## Verify

- New `apps/cli/test/program.test.ts` case pins:
  - One-edit typo on trusted (`muse.notes.writes`) →
    "not in the trusted list" + "did you mean 'muse.notes.write'?".
  - One-edit typo on blocked (`shell.exe`) → same shape against
    blocked list.
  - Unrelated input (`totally-unrelated-tool-name`) → warning
    fires but no false-positive suggestion.
  - Happy-path real revoke still emits the existing success line.
- `pnpm --filter @muse/cli test` — 348 tests pass.
- `pnpm check` exit 0; `pnpm lint` exit 0.
- No real-LLM path touched.

## Status

done — typo on `trust revoke` / `unblock` is now caught with a
"did you mean" hint. Same Levenshtein helper used by goals 099 +
100 + 114.
