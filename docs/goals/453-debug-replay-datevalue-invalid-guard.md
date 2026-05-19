# 453 — A corrupt persisted timestamp can't 500 the whole debug-replay list

## Why

`mapDebugReplayCaptureRow` (`@muse/runtime-state`
`debug-replay.ts`) maps a persisted `debug_replay_captures` row
into the JSON the admin surface
(`GET /api/admin/debug/replay` + `/:id`) returns. It renders
timestamps via `dateValue(row.captured_at).toISOString()` (also
`expires_at`, `createdAt`, `updatedAt` — four sites).

`dateValue` was:

```ts
function dateValue(value: unknown): Date {
  return value instanceof Date ? value : new Date(typeof value === "string" ? value : Date.now());
}
```

It does **no validity check**. A corrupt / hand-edited /
partially-written persisted timestamp string → `new Date("…")`
→ an **Invalid Date**, and the immediately-following
`.toISOString()` throws `RangeError: Invalid time value`.
`listDebugReplayCaptures` maps **every** row through this, so a
single bad row throws out of the mapper and **500s the entire
`GET /api/admin/debug/replay` endpoint** — the admin loses
visibility into *all* captures because one row is malformed
(and an unhandled `RangeError` escapes).

This is the 418 / 440 "an Invalid Date silently flows then
crashes serialization" class, on the persisted admin debug-replay
surface — the same corrupt/hand-edited-persisted-value threat
model goal 440 explicitly shipped against, and
`.toISOString()`-on-Invalid-Date throwing is deterministic JS,
not hypothetical. Fresh package (runtime-state — no recent
functional touch); a genuine `fix:` surfaced by a disciplined
survey (prompts / multi-agent / message-bus / orchestration-
history were all confirmed mature+covered first — not
manufactured).

## Slice

- `packages/runtime-state/src/debug-replay.ts` — `dateValue` now
  computes the candidate (Date passthrough or `new Date(string |
  now())`) and, if its time is `NaN`, falls back to `new Date()`
  — the **same "unusable input → now" convention the function
  already used** for the non-string branch (`: Date.now()`), now
  applied uniformly so it can NEVER return an Invalid Date.
  Guards both branches (an Invalid Date object passed in is also
  caught). Behaviour-identical for every valid Date / ISO string
  / non-string input; only a corrupt value now degrades to "now"
  instead of crashing the whole list.
- `packages/runtime-state/test/debug-replay.test.ts` — a new
  `it` in the existing `mapDebugReplayCaptureRow` describe: a row
  with `captured_at: "not-a-date"` and an empty `expires_at`
  must NOT throw, and both rendered timestamps must be parseable
  ISO strings; a well-formed timestamp is still passed through
  unchanged.

## Verify

- New `it` green; full `@muse/runtime-state` suite 20 passed
  (5 files, +1); tsc strict (runtime-state) EXIT=0.
- **Mutation-proven teeth**: reverting `dateValue` to the
  unguarded form makes the new test fail by throwing
  `RangeError: Invalid time value` out of
  `mapDebugReplayCaptureRow` (the exact pre-fix endpoint-crash);
  `Number.isNaN(candidate.getTime())` occurrence count went
  1→0 then restored to 1, suite back to 20 green.
- `pnpm check` EXIT=0, every workspace green (runtime-state 20,
  cli 739, api …) — no regression; `pnpm lint` 0/0;
  `pnpm guard:core` clean; byte-scan clean; `git status` shows
  only the two intended files.
- Pure deterministic date mapping — no LLM / model
  request-response wire path; `smoke:live` does not apply (per
  `testing.md` / iteration-loop Step 9).

## Status

Done. One corrupt timestamp in one persisted debug-replay row no
longer takes down `GET /api/admin/debug/replay` for every
capture; the bad row's timestamp degrades to "now" (still listed
and inspectable) instead of an unhandled `RangeError`. Every
well-formed row is rendered exactly as before.

No CAPABILITIES line / no OUTWARD-TARGETS flip: all P-bullets are
already `[x]` and audited; a robustness `fix:` to an existing
admin surface (418 / 440 invalid-date class), recorded honestly
with this backlog row — not a false metric.

## Decisions

- Fallback to `new Date()` (now), not epoch or null: `dateValue`
  already used `Date.now()` for its other unusable-input branch
  and the call sites need a non-null `Date` to `.toISOString()`;
  matching the existing convention keeps the four call sites and
  their return types untouched (tightest scope).
- Fixed at `dateValue` (the single chokepoint feeding all four
  `.toISOString()` sites), not at each call site: one guard at
  the source closes the hole everywhere (capturedAt / expiresAt /
  createdAt / updatedAt) and can't drift — the 441/449 single-
  chokepoint rationale.
- Recorded the survey explicitly: prompts, multi-agent
  (orchestration-history / message-bus fail-open / fan-in cap)
  and runtime-state's JSON guards were all confirmed
  mature+covered before this; the `maxOutputCharsPerWorker`
  non-finite case was *declined* as defensive-without-observed-
  failure (no non-literal source) — this fix is the one concrete,
  reachable, deterministic defect found, not a manufactured guard.
