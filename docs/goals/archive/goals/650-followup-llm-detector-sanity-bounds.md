# 650 — `parseLlmDetectorOutput` sanity-bounds the LLM-emitted `scheduledForIso` to `[now - 5 min, now + 365 days]` so a confused / hallucinating model can't litter `~/.muse/followups.json` with year-9999 entries that never fire OR ancient timestamps that fire instantly

## Why

`packages/agent-core/src/followup-llm-detector.ts:parseLlmDetectorOutput`
parses the LLM's JSON-array response into `FollowupPromise[]`.
Each entry's `scheduledForIso` is `new Date(...)`-parsed and
finite-guarded — but a finite-but-nonsensical timestamp passes
straight through.

The LLM can hallucinate timestamps in three ways:

1. **Year 9999 / 2099 / 1999** — when the prompt's "anchor time"
   is ambiguous or the model muddles year arithmetic.
2. **Ancient timestamps** ("circle back yesterday" interpreted
   as a real follow-up).
3. **Off-by-decade typos** — "2026" → "2036" in a generated ISO
   string.

Downstream effects:

- **Far-future (>1 year)**: the follow-up sits in
  `~/.muse/followups.json` forever and never fires. Storage
  noise; not security-critical but pollutes the timeline.
- **Past timestamps**: the firing daemon's `scheduledAt <= now`
  check fires the follow-up on its very next tick, regardless
  of how stale the timestamp is. A user who never made a
  yesterday-commitment gets pinged about it.
- **Both classes**: pollute the dedup minute-key set, can mask
  legitimate follow-ups that share the same minute.

The fix sanity-bounds the LLM-emitted timestamp:

- **Past tolerance**: 5 minutes. Absorbs LLM response latency
  (model takes ~3 sec to ~minutes on slow hardware) and minor
  clock skew. Beyond 5 minutes past the anchor, the timestamp
  is treated as hallucination.
- **Future horizon**: 365 days. A year is the practical ceiling
  for personal follow-ups; anything beyond is hallucination.

Both bounds are exported as named constants so callers reading
the code can align their expectations with the runtime check.

### Defect class

**LLM-emitted timestamp sanity-bound** — first hit. Distinct
from prior classes in the 10-iter window:

- 649: unbounded HTTP body
- 648: HTTP fetch timeout (embed)
- 647: bracket parser inString
- 646: FIFO cap
- 645: file mode 0o600
- 644: finite-guard data destruction
- 643: strict int-parse on HTTP query
- 642: stream error listener
- 641: cacheTtlMs finite-guard
- 640: keyword word-boundary

None previously hit the *value-range sanity-bound on LLM output*
class. The rule-detector (`extractFollowupPromises`) already
clamps its own `value * 86_400_000` to derive `scheduledFor` from
`options.now`, so its outputs are structurally bounded. Only the
LLM path accepts the model's *raw ISO string* without value
bounds.

## Slice

- `packages/agent-core/src/followup-llm-detector.ts`:
  - Exported `LLM_FOLLOWUP_PAST_TOLERANCE_MS = 5 * 60_000`.
  - Exported `LLM_FOLLOWUP_FUTURE_HORIZON_MS = 365 * 86_400_000`.
  - `parseLlmDetectorOutput` now takes a second arg `now: Date`
    (plumbed from `extractFollowupPromisesLlm`'s `now`).
  - Bound check inside the per-entry loop: after the finite
    guard, reject entries where `scheduledMs < nowMs - PAST` OR
    `scheduledMs > nowMs + FUTURE`.
- `packages/agent-core/test/followup-llm-detector.test.ts`:
  - Import updated.
  - **Two existing tests** ("tolerates prose wrapping",
    "dedupes by minute") now pin `now: new Date("2026-05-13
    T13:00:00Z")` — they used timestamps from May 13 without
    an explicit anchor, which were past the new bound when
    the test runs against any later wall-clock date. Pinning
    `now` keeps them deterministic across machines and dates.
  - **Four new tests**:
    1. **Past hallucination dropped** — input has one
       `2026-05-12T13:00:00Z` (24h before anchor) + one
       valid `2026-05-13T13:10:00Z`; result is the valid
       one only.
    2. **Far-future hallucination dropped** — input has
       `9999-12-31T23:59:59Z` + valid `2026-05-20T10:00:00Z`;
       result is the valid one only.
    3. **In-tolerance past kept** — input has
       `2026-05-13T12:57:00Z` (3 min before anchor, inside
       the 5-min window); kept.
    4. **Constants pinned** — `LLM_FOLLOWUP_PAST_TOLERANCE_MS
       === 300_000`, `LLM_FOLLOWUP_FUTURE_HORIZON_MS ===
       31_536_000_000`.

## Verify

- `pnpm --filter @muse/agent-core test`: 667 passed (663 prior
  + 4 new). `pnpm check` full: apps/api 270/270,
  apps/cli 1115/1115, agent-core 667/667; every workspace
  green; tsc strict EXIT=0.
- **Clean-mutation-proven**: reverting the bound check (the
  `if (scheduledMs < min … > max) continue;` line) makes
  EXACTLY the two hallucination-drop tests fail (one returns
  2 entries instead of 1; the other same). The in-tolerance
  test passes both pre- and post-fix because its timestamp
  is within the bound either way. The constants test passes
  regardless. Restored; all green.
- `pnpm lint`: 0 errors / 0 warnings.
- `pnpm guard:core`: clean.
- Byte-hygiene scan on the two touched files: clean.
- The LLM provider stub returns a static string output — no
  real-LLM request/response wire path is touched. `smoke:live`
  doesn't apply.

## Status

Done. The LLM-fallback detector can no longer pollute the
follow-up store with garbage timestamps:

| LLM-emitted `scheduledForIso`                | Pre-fix              | Post-fix             |
| -------------------------------------------- | -------------------- | -------------------- |
| `"now + 10 min"` (anchor's near future)      | accepted             | accepted             |
| `"now + 6 months"`                           | accepted             | accepted             |
| `"now - 3 min"` (LLM latency window)         | accepted             | accepted             |
| `"now - 24 hours"` (clearly past)            | **fires on next tick** | **dropped** (fixed)|
| `"9999-12-31T23:59:59Z"` (year 9999)         | **stored, never fires** | **dropped** (fixed)|
| `"not-a-date"`                                | finite-guard dropped | unchanged            |

## Decisions

- **5-minute past tolerance** rather than zero. The LLM can
  take 2-30 seconds to respond on local Ollama; a strict
  zero-past bound would reject a legitimate "I'll ping in 1
  min" promise if the LLM took more than 60 seconds to
  process. 5 minutes is generous enough for any local-LLM
  latency window without admitting clearly-past
  hallucinations.
- **365-day future horizon**. Personal follow-ups beyond a
  year are vanishingly rare in real usage. A user who
  legitimately wants a multi-year reminder can use the
  rule-based path (which has no upper bound) or wire a
  long-lived task into the calendar provider — outside the
  fast-promise detector's scope. The horizon caps the LLM
  hallucination space; it doesn't cap user intent.
- **`continue` on out-of-bounds**, not throw. The detector's
  fail-soft posture (any error → empty result, never reject
  the whole turn) is preserved: a bad entry is silently
  dropped, valid entries in the same array still surface.
- **`now` plumbed through `parseLlmDetectorOutput`**, not
  captured at module load. The function is pure; tests pin
  `now` explicitly. Capturing `Date.now()` inside the
  function would tie test outcomes to wall-clock — exactly
  the issue I fixed in the two existing tests.
- **Exported constants**, not magic numbers in the function
  body. Callers that need to read the bounds (future
  observability, dashboard "rejected by sanity bound"
  counter) can import them. Tests pin them so a future
  silent loosening (e.g., past tolerance grew to a day)
  requires the test bump.
- **Mutation choice**. Reverted only the `if (...)`
  bound-check line. Two tests fail pre-fix with the exact
  symptom (result has 2 entries instead of 1). The
  in-tolerance test and the constants test pass both pre-
  and post-fix because they don't depend on the bound
  triggering. Surgical proof.

## Remaining risks

- **The rule-based `extractFollowupPromises`** has no upper
  bound on its `\d{1,4}` day-count regex — `"in 9999 days"`
  produces a timestamp 27 years out. Sibling-fixable in a
  future iter. The rule path's structural derivation from
  `options.now` makes the bound less critical (the timestamp
  is computed, not parsed from an LLM string), but the
  worst-case year-2053 follow-up is still pure noise.
- **The bounds are not env-configurable**. An operator who
  wants a 2-year horizon must edit the constants. Future
  iter could wire `MUSE_LLM_FOLLOWUP_FUTURE_HORIZON_DAYS`
  through autoconfigure if needed.
- **The bound check happens after the JSON parse**. A
  malicious LLM that emits megabytes of past-timestamp
  entries still triggers the JSON.parse → array iteration
  cost. The detector's `maxOutputTokens: 220` cap in the
  request limits the worst-case array size; out-of-scope
  for this iter.
- **No telemetry on rejected entries**. A future iter
  could log a counter so operators can spot a misbehaving
  model that consistently emits out-of-bounds timestamps.
- **`scheduledForIso` is the only LLM-emitted timestamp
  parsed across the codebase**; the other LLM detectors
  (objectives, notes-judge, episode-judge) emit strings or
  IDs, not timestamps. So this fix is targeted, not a
  pattern to sibling-port.
