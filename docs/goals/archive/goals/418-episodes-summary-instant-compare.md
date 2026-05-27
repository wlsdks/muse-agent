# 418 — `summariseEpisodesRows` compares parsed instants, not raw strings

## Why

User-facing correctness + internal-consistency fix on a fresh
axis (the `personal-status-summary.ts` summarisers — never touched
by the recent mcp-time/prompts/model cluster). These power both
the `muse.status.snapshot` MCP tool and `muse status`, so a wrong
"last session" is a JARVIS self-observability surface lying to the
user.

`summariseEpisodesRows` picked the most-recent episode with
`row.endedAt > lastEndedAt` — a **lexicographic string** compare.
Its three sibling summarisers in the SAME file already compare
parsed instants (`summariseRemindersRows` /
`summariseFollowupsRows` via `Date.parse(...)` ms;
`summarisePatternsFiredRows` via numeric `firedAtMs`), and the
codebase's own `compareTasksByDueDate` carries an explicit comment
that string-comparing free-form ISO timestamps "is wrong across
mixed precision … and timezone offsets". `summariseEpisodesRows`
was the lone violator. Probed (built dist):

```
endedAt "…10:00:00Z" vs "…10:00:00.500Z"  → reports the EARLIER one
endedAt "…02:00:00Z" vs "…10:00:00+09:00" → reports the EARLIER one
```

Episode `endedAt` is a free-form timestamp (runtime-written, and
importable / hand-editable), so mixed sub-second precision and
timezone offsets are realistic — `muse status` then shows the
wrong "last session was about X", and a garbage `endedAt` (e.g.
`"zzz…"`) could even win the lexicographic max and feed an
Invalid Date downstream.

## Slice

- `packages/mcp/src/personal-status-summary.ts` —
  `summariseEpisodesRows` now tracks `lastEndedMs` and updates the
  winner only when `Date.parse(row.endedAt)` is finite and greater
  (keeping the original string for output). Byte-for-byte the same
  shape as the sibling summarisers; an unparseable `endedAt` is
  skipped instead of winning by string order — the same posture as
  `summarisePatternsFiredRows`.
- `packages/mcp/test/mcp.test.ts` — regression beside the existing
  episodes test: mixed-precision and timezone-offset rows now pick
  the truly-latest episode, and a garbage `endedAt` no longer
  wins. Fails on the pre-fix code (all three assertions).

## Verify

- `@muse/mcp` `summariseEpisodesRows` tests 2/2 (existing + new);
  the new cases fail pre-fix.
- `pnpm check` EXIT=0, every workspace green (mcp ok, cli 717,
  …); tsc strict (mcp) clean; `pnpm lint` 0/0; `pnpm guard:core`
  clean; byte-scan clean.
- Pure summariser, no clock/IO, no request/response (LLM) path —
  no `smoke:live` applies. mcp is consumed cross-package so the
  full `pnpm check` was the gate.

## Status

Done. `muse status` / `muse.status.snapshot` now reports the
genuinely most-recent episode (and its summary) even when episode
`endedAt` strings have mixed precision or timezone offsets — the
four summarisers in this file are now consistent (all compare
parsed instants), matching the codebase's documented timestamp
rule.

No CAPABILITIES line / no OUTWARD-TARGETS flip: all P-bullets are
already `[x]`; this is a correctness/consistency fix to an
existing helper, recorded honestly as a `fix(mcp):` change with
this backlog row — not a false metric.

## Decisions

- Mirrored the sibling `Date.parse` + finite-guard pattern rather
  than inventing one: it makes the four summarisers uniform and
  cannot drift from the documented `compareTasksByDueDate` rule.
- Skipping a non-finite `endedAt` (vs the pre-fix "garbage string
  can win") is the intended, safer behaviour and matches
  `summarisePatternsFiredRows` returning `undefined` when nothing
  valid exists — recorded so the behaviour change is explicit.
