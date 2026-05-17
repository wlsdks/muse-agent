# 326 — raw ANSI ESC bytes in production CLI source (`muse status --watch`)

## Why

Continuing the goal-227 rule sweep (no raw control / zero-width
bytes in committed source or docs) started for test source in
goal 325. A repo-wide scan surfaced the highest-severity
remaining hit in **production** CLI source, not a test fixture:

`apps/cli/src/commands-status.ts:722`, the `muse status
--watch` redraw loop:

```js
io.stdout("<ESC>[2J<ESC>[H");   // ESC = raw 0x1B byte
```

The clear-screen + cursor-home ANSI sequence was written with
two **raw `0x1B` (ESC) control bytes** embedded directly in the
string literal. Consequences:

- Violates the goal-227 rule in *production* source (worse than
  the test-only goal-325 case) and trips the pre-commit
  control-byte scan on every iteration that touches this file.
- Invisible in editors / `Read`: the literal renders as
  `io.stdout("[2J[H")`, so a reader cannot tell it is an ANSI
  escape at all — the surrounding comment ("cursor at home …
  redrawable viewport") is the only hint the bytes even exist.

## Scope

`apps/cli/src/commands-status.ts` — the single
`io.stdout("…")` clear-screen call in the watch loop:

- Replace the two raw `0x1B` bytes with the **escape-sequence
  text** `\x1b`, byte-exact via a targeted
  `s/\x1b\[2J\x1b\[H/\\x1b[2J\\x1b[H/g` (perl confirmed exactly
  one occurrence in the file).

Runtime-identical: the JavaScript string literal
`"\x1b[2J\x1b[H"` parses to the same byte sequence
(`ESC [ 2 J ESC [ H`) that was written before, so the
watch-loop terminal behaviour is unchanged. The change is
purely in the *source representation* — raw bytes → readable
escape — which both satisfies goal-227 and makes the ANSI
clear-screen/cursor-home intent self-evident to a reader. No
behavioural code path altered.

## Verify

- `pnpm --filter @muse/cli test` — 563 pass (the
  `muse status` / watch command tests stay green; the emitted
  bytes are unchanged).
- File control-byte rescan
  (`perl -CSD … /[\x00-\x08\x0b-\x1f\x7f]|\x{200b}…/`) now
  reports **clean** — the only previously-flagged line (722) is
  resolved and none were introduced.
- `pnpm check` — every workspace green (apps/cli 563, apps/api
  161, all packages). `pnpm lint` — exit 0.
- No real-LLM request/response path touched (terminal I/O
  string representation only). Deterministic test + scan are the
  rigorous verification.

## Status

done — production CLI source no longer carries raw ANSI ESC
control bytes; the `muse status --watch` clear-screen sequence
is written as the readable escape `"\x1b[2J\x1b[H"`, the
goal-227 rule now holds across this file, and its
control-byte scan is clean. Terminal behaviour is byte-identical.
Remaining repo goal-227 hits are docs-only
(`docs/goals/238`, `docs/goals/251`) — lower severity, a
candidate for a follow-up docs-hygiene pass.
