# 644 — `vacuumEpisodes` finite-guards `maxEntries` so a NaN-from-corrupt-caller cap can't silently wipe the entire `~/.muse/episodes.json` file (NaN slips past `Math.max(1, Math.trunc(NaN))`, then `slice(0, NaN)` returns `[]`, then `writeEpisodes(file, [])` destroys every episode)

## Why

`packages/mcp/src/personal-episodes-store.ts:vacuumEpisodes`
is the periodic vacuum / cap-enforcement for stored episodes.
The design doc calls it the "end-of-day vacuum" — schedulers
and the end-of-session hook call it after each upsert to keep
`~/.muse/episodes.json` under a configurable size cap.

Pre-fix:

```ts
export async function vacuumEpisodes(file, maxEntries = DEFAULT_VACUUM_MAX_ENTRIES) {
  const cap = Math.max(1, Math.trunc(maxEntries));
  const existing = await readEpisodes(file);
  if (existing.length <= cap) return 0;
  const sorted = [...existing].sort(/* by endedAt desc */);
  const kept = sorted.slice(0, cap);
  await writeEpisodes(file, kept);
  return existing.length - kept.length;
}
```

When `maxEntries` is NaN, the chain produces a catastrophic
silent data loss:

1. `Math.trunc(NaN) === NaN`.
2. `Math.max(1, NaN) === NaN`. (Math.max returns NaN if any
   argument is NaN.)
3. `existing.length <= NaN` is `false` (every comparison with
   NaN is false).
4. The `if` branch skips the early return.
5. `sorted.slice(0, NaN)` returns `[]` (slice treats NaN end
   as 0).
6. `writeEpisodes(file, [])` writes the file with an empty
   episodes array — **erasing every stored episode**.

A single corrupted call (config typo, env-parsed
`Number("forever")` from a YAML field, a hand-edit JSON that
got coerced through `Number()` somewhere upstream) silently
destroys user history. The function returns `existing.length
- kept.length` = `3 - 0` = `3` (or however many were stored),
which a caller might interpret as "vacuumed 3 stale entries,
all good" — when in reality it wiped EVERY episode.

### Reachability

- The `maxEntries` parameter is operator-supplied via the
  autoconfigure wiring layer or the `--max-entries` flag on
  `muse episode vacuum`. A future env knob
  `MUSE_EPISODE_MAX_ENTRIES` (not currently wired but likely
  to be) would route through one of the env-parsers — bad
  input can produce NaN.
- Programmatic callers in tests / admin tools could pass
  `Number(badConfig.cap)` directly. If the JSON had
  `"cap": "forever"`, the result is NaN.
- The catastrophe is silent — no error, no diagnostic, just
  the next `muse episode list` returns empty. The user
  thinks their session history is gone forever (technically
  it IS, unless they have a backup).

### Defect class

**Finite-guard on a numeric cap that has destructive
consequences** — sibling family to goals 608 (integer
safety), 609 (cost finite-clamp), 618 (ambient cap), 641
(cacheTtlMs guard). All "`?? default` or `Math.max(1, …)`
doesn't catch NaN/Infinity" — but THIS instance has the
strongest impact: the failure mode is silent data
destruction, not degraded cache hit-rate or degraded
performance.

641 was 3 iterations back — that's the most recent
`finite-guard` iter. Step-8 says ≥3 in last 10 forces
redirect; this would be #2 in the recent window (only 641).
Under threshold.

Against the recent window:
- 643: strict int-parse on HTTP query params
- 642: stream error listener (read side)
- 641: cacheTtlMs finite-guard ← closest sibling
- 640: word-boundary keyword matching
- 639: keyword dedup
- 638: lenient base64url decode (auth)
- 637: lenient base64 decode (loopback)
- 636: HTTP timeout
- 635: per-file concurrent write (memory)
- 634: sort tiebreaker

## Slice

- `packages/mcp/src/personal-episodes-store.ts:vacuumEpisodes`:
  - Replaced `const cap = Math.max(1, Math.trunc(maxEntries))`
    with a finite-positive check that falls back to
    `DEFAULT_VACUUM_MAX_ENTRIES` when `maxEntries` isn't
    `Number.isFinite(...) && > 0`.
  - One short WHY comment names the threat model (the NaN
    chain → wipe-the-file silent destruction).
- `packages/mcp/test/mcp.test.ts`:
  - One new test in the existing `personal-episodes-store`
    describe. Four poison shapes:
    - **NaN** — pre-fix this wiped 3 episodes; post-fix
      returns 0 dropped (default cap is 500, well above 3).
    - **Infinity** — pre-fix cap === Infinity, slice(0,
      Infinity) keeps everything, 0 dropped (technically
      OK). Post-fix: same, via the fallback.
    - **0** — pre-fix Math.max(1, 0) = 1, would have kept
      only the newest. Post-fix: falls to default, keeps
      all.
    - **Negative (-5)** — same family.
  - Test seeds 3 episodes with distinct `endedAt` and
    `id`s, calls vacuumEpisodes with each poison shape,
    asserts the count returned is 0 AND that all 3 ids
    survive in the file.

## Verify

- `@muse/mcp` suite green (538 passed, +1 vs the pre-iter
  baseline of 537, 0 failed).
- **Clean-mutation-proven** (Edit-based): reverting the
  finite-guard back to bare `Math.max(1, Math.trunc
  (maxEntries))` makes the new test fail with the EXACT
  pre-fix symptom — `Received: 3` (3 episodes dropped =
  the file was wiped) vs. `Expected: 0`. The 1 previously-
  added test (vacuumEpisodes sort tiebreaker) and the 535
  other pre-existing tests pass both pre- AND post-fix.
- `pnpm check` green: apps/api 270/270, apps/cli 1101/1101,
  every workspace; tsc strict EXIT=0.
- `pnpm lint` 0/0, `pnpm guard:core` clean, byte-scan clean.
- No LLM request/response wire path touched — pure
  persistence layer. `smoke:live` doesn't apply.

## Status

Done. `vacuumEpisodes` is now safe against the full
poison-input family:

| `maxEntries`              | Before                                  | After                       |
| ------------------------- | --------------------------------------- | --------------------------- |
| Positive finite (e.g. 10) | OK — keeps 10 newest                    | unchanged                   |
| Undefined (default)       | OK — keeps 500 newest                   | unchanged                   |
| **NaN**                   | **WIPES the entire file** (silent data destruction) | falls back to 500 (**fixed**) |
| **Infinity**              | cap === Infinity, no-op (technically OK but not finite) | falls back to 500 (**fixed** — strict contract) |
| **0**                     | keeps only 1 newest (silent over-trim)  | falls back to 500 (**fixed**) |
| **Negative (-5)**         | Math.max(1, -5) = 1, keeps 1 newest     | falls back to 500 (**fixed**) |

No CAPABILITIES line / no OUTWARD-TARGETS flip: a
robustness / data-loss-prevention `fix:` on the personal-
episodes persistence layer. Recorded honestly with this
backlog row — given the destructive impact, a critical-
severity fix.

## Decisions

- **Falls back to `DEFAULT_VACUUM_MAX_ENTRIES` (500)** for
  all invalid shapes, not throw. The store layer is a
  fail-open utility — `muse episode vacuum` shouldn't
  crash on a bad CLI flag; the no-op fallback preserves
  user data. The trade-off: silent default vs. loud
  failure. Silent default matches the established pattern
  in 608, 609, 618, 641.
- **`Number.isFinite(maxEntries) && maxEntries > 0`** rather
  than the weaker `Number.isFinite(maxEntries)`. A
  caller passing `0` or `-5` (unit slip / range mistake)
  shouldn't get the buggy `Math.max(1, 0) = 1` behavior
  that silently over-trims to a single episode — they
  should fall to the documented default, same as NaN.
- **Kept the `DEFAULT_VACUUM_MAX_ENTRIES` constant
  reference**, not hard-coded 500 in the guard. If a
  future iter bumps the default, both branches stay in
  sync.
- **One short WHY comment** names the data-loss threat
  model. Required because the bug is non-obvious — a
  maintainer reading the function sees `Math.max(1, …)`
  and might assume the input was already validated. The
  comment surfaces the NaN-chain destruction explicitly.
- **Did NOT also harden `upsertEpisode`, `removeEpisode`,
  or `clearEpisodes`** — these are the explicit "write a
  specific shape" operations. `clearEpisodes` is
  intentionally destructive (the user opt-in); `upsertEpisode`
  / `removeEpisode` work on `id`-keyed lookups, not cap-
  bounded counts.
- **Mutation choice.** Reverted only the finite-guard back
  to `const cap = Math.max(1, Math.trunc(maxEntries))`.
  The new test fails with the literal `Received: 3` data-
  loss symptom (NaN case wipes the 3-episode file). The
  535 other tests and the 1 previously-added tiebreaker
  test pass both ways.

## Remaining risks

- **`commands-episode` CLI path** doesn't currently expose
  a `--max-entries` flag that would directly feed
  `vacuumEpisodes`. If a future flag wires through
  `Number.parseInt(value)` lenient parsing, the guard
  catches the result. Defense in depth.
- **No checksum / WAL** for `~/.muse/episodes.json` — a
  bit-flip in storage that corrupts the file would still
  be lost. Out-of-scope.
- **Sibling personal stores** (`personal-tasks.ts`,
  `personal-followups-store.ts`, `personal-veto-store.ts`,
  etc.) — each has its own vacuum / cap functions. A grep
  for `Math.max(1, Math.trunc(` finds:
  - This file (now fixed).
  - `packages/scheduler/src/scheduler-stores.ts:60` —
    `maxJobs` cap, guarded against unbounded growth but
    not against NaN destruction (the eviction loop is
    `while (size > maxJobs)` — `size > NaN` is false →
    no destruction, just unbounded growth).
  - `packages/agent-core/src/runtime-helpers.ts` — none
    found.
  Audit-worthy as a separate sweep.
- **`Infinity` is treated as "default" rather than "no
  cap."** A caller who actually wants no cap would now
  get 500 instead. There's no documented "no cap" mode;
  the test pins the strict contract.
