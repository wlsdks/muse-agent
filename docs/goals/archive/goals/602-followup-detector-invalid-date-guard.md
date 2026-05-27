# 602 — `extractFollowupPromises` refuses to emit a promise with an Invalid Date `scheduledFor` (closes a downstream-crash path on a `tomorrow morning` phrase + corrupt slot config)

## Why

`packages/agent-core/src/followup-detector.ts` is the agent's
self-followup detector — it scans an assistant turn for time-
bound promises (`"I'll check in 30 min"`, `"tomorrow morning"`,
`"오늘 3시에"`, …) and emits structured `FollowupPromise` shapes
the `followup-capture-hook` then persists to disk.

The detector accepts a `slotHours` option that overrides the
default slot mapping (`morning: 9 → 7` if the operator prefers
an earlier hour). A corrupt configurator — `Number.parseInt(env.
MUSE_FOLLOWUP_MORNING_HOUR, 10)` on a typo'd `7am` → NaN, or a
settings-store row whose number column came back as NaN —
could inject a non-finite hour into the merged `slots` map.

Downstream in `nextDayAtHour(now, NaN)`:

```ts
next.setHours(NaN, 0, 0, 0);   // produces an Invalid Date
```

The resulting `FollowupPromise.scheduledFor` is `new Date(NaN)`.
The `push` function deduped by `Math.floor(scheduledFor.getTime()
/ 60_000)` — `NaN / 60_000 = NaN`, `Math.floor(NaN) = NaN`,
`Set.has(NaN)` works (Sets canonicalize NaN), so the FIRST
invalid promise per kind was emitted.

The promise then flowed to `followup-capture-hook.ts:170`:

```ts
const scheduledFor = promise.scheduledFor.toISOString();
```

**`(new Date(NaN)).toISOString()` throws `RangeError: Invalid
time value`** — uncaught inside the for-loop, **crashes the
afterTurn hook** on every run carrying a `tomorrow morning` /
`내일 아침` phrase paired with the corrupt slot config.

Step-8 redirect: same package as goal 601 (agent-core) but
different file (`followup-detector.ts` vs `clarify-directive.ts`)
and different defect class (Invalid-Date corruption prevention
vs regex-coverage). The defect family is "invalid-state leaks
past detector into downstream throw site" — fresh distinct
from recent finite-guard sweeps which were on bounded-resource
configurators.

## Slice

- `packages/agent-core/src/followup-detector.ts:push`:
  - Added an early-return on `!Number.isFinite(promise.
    scheduledFor.getTime())`. The detector now refuses to emit
    a promise whose Date is Invalid. The contract from the
    detector → hook is now "every emitted FollowupPromise has
    a serialisable scheduledFor" — the hook's `.toISOString()`
    becomes unconditionally safe.
  - Added a short WHY comment explaining the threat model
    (corrupt slotHours from upstream env / settings parse →
    Invalid Date → downstream RangeError).
  - Captured `promise.scheduledFor.getTime()` once into `ts`
    and used it for both the guard and the minuteKey
    computation, since `getTime()` is the only point where
    `NaN` is observable on a JavaScript Date.
- `packages/agent-core/test/followup-detector.test.ts`:
  - One new test exercising `slotHours: { morning: NaN }`,
    `slotHours: { morning: Infinity }`, and `slotHours:
    { morning: -Infinity }` on the input `"see you tomorrow
    morning"`. Asserts:
    - Every emitted promise has a finite `scheduledFor.
      getTime()` (no Invalid Date can sneak through).
    - The `tomorrow-slot` kind specifically is empty (the
      corrupt slot would otherwise have produced one Invalid
      Date `tomorrow-slot` promise per branch).

## Verify

- `@muse/agent-core` suite green (660 passed, +1 vs baseline
  659, 0 failed); tsc strict EXIT=0.
- **Clean-mutation-proven** (Edit-based): reverting the `push`
  function back to its pre-fix shape (no finite guard, only
  the Set-based minute dedupe) makes the new test fail — the
  detector emits a `tomorrow-slot` promise with `Number.NaN`
  as `scheduledFor.getTime()`, and the test's
  `result.every(p => Number.isFinite(p.scheduledFor.getTime()))`
  assertion catches it. Fix restored.
- `pnpm check` EXIT=0 (apps/api 258 passed, apps/cli 1040
  passed, every workspace green); `pnpm lint` 0/0; `pnpm
  guard:core` clean; `git status` shows only the two intended
  files.
- The fix is a defensive validation inside the detector's
  push boundary; no wire-format change to model requests. The
  followup-capture-hook is a non-blocking afterTurn hook, and
  the test pins the contract at the detector layer (where the
  defect originates). `smoke:live` not required.

## Status

Done. The detector → hook contract is now "every emitted
FollowupPromise has a finite, serialisable scheduledFor":

| slotHours.morning value | Before                                  | After                            |
| ----------------------- | --------------------------------------- | -------------------------------- |
| `9` (default)           | tomorrow-slot at 09:00 (works)          | unchanged                        |
| `7` (custom)            | tomorrow-slot at 07:00 (works)          | unchanged                        |
| `Number.NaN`            | **emits Invalid Date promise → crash** | **filtered out** (no promise)    |
| `Number.POSITIVE_INFINITY` | **emits Invalid Date promise → crash** | **filtered out** (no promise)    |
| `Number.NEGATIVE_INFINITY` | **emits Invalid Date promise → crash** | **filtered out** (no promise)    |
| Out-of-range finite (e.g. 25) | rolls over (setHours wraps)        | unchanged (still in-bounds Date) |

No CAPABILITIES line / no OUTWARD-TARGETS flip: a robustness /
crash-prevention `fix:` on the agent-core followup-detection
path, recorded honestly with this backlog row — not a false
metric.

## Decisions

- **Guard at the push boundary, not at each emit site.** The
  detector has 9 emit sites (6 English + 5 Korean — counting
  branches). Each could call `setHours(NaN, ...)` if a corrupt
  hour reaches it. Guarding at the single `push` chokepoint
  catches every current path AND every future path that adds
  a new locale or pattern, without per-site duplication.
- **`!Number.isFinite(ts)` over `Number.isNaN(ts)`** — the
  finite check also rejects `Infinity` / `-Infinity`. A Date's
  internal timestamp can't be `Infinity` from a normal setHours
  call, but defensive guards should accept both NaN and
  Infinity uniformly. Same posture as the goal-595 / goal-596
  finite-guards.
- **One test, three Infinity / NaN values.** Could have split
  into three `it(...)` blocks. Chose one for compactness — the
  three inputs share the same expected behaviour (filtered
  out) and the test's loop body documents the equivalence.
- **Did NOT validate slotHours at construction.** Could have
  rejected corrupt slot values up front in the merge at line
  106 (`const slots = { ...DEFAULT_SLOTS, ...options.slotHours }`).
  That would tighten the input boundary, but the push-time guard
  is more general — it catches Invalid Dates from ANY source,
  including future pattern additions that might compute hours
  differently.
- **Mutation choice.** The realistic regression is dropping the
  guard during a refactor that "simplifies" push. The mutation
  removes the guard cleanly, demonstrating the test catches
  the load-bearing change.

## Remaining risks

- **`followup-capture-hook.ts:170` `.toISOString()`** is still
  unguarded. With the detector contract now holding, it's
  safe — but a future caller of `extractFollowupPromises` that
  bypasses the detector and feeds raw promises into the hook
  could still hit the `.toISOString()` throw. Out of scope;
  the detector is the canonical producer.
- **Other Invalid-Date emit sites** in the codebase. The
  pattern `setHours(<hour-from-config>, ...)` exists in other
  scheduler / reminder paths. Each is its own audit; this
  iteration scopes to the followup detector only.
- **DST transitions** through `setHours` are a separate
  concern: a `tomorrow morning` resolved through a DST shift
  might land at 08:00 or 10:00 instead of 09:00. Out of scope
  here; it's a JavaScript Date behaviour and would need a
  zoned-time library to address properly.
