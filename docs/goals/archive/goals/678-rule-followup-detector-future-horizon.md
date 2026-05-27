# 678 — the rule-based `extractFollowupPromises` sanity-bounds its output to `now + 365 days`, so a phrase like "in 9999 days" can't queue a follow-up scheduled ~27 years out — parity with the LLM detector's `LLM_FOLLOWUP_FUTURE_HORIZON_MS` (closes goal 650's documented remaining-risk)

## Why

`packages/agent-core/src/followup-detector.ts:extractFollowupPromises`
is the rule-only first-pass detector that scans an assistant
turn for explicit time-bound promises ("I'll check in 30
minutes", "tomorrow morning", "3일 후"). It derives the
`scheduledFor` instant from `options.now + value × unit`:

```ts
// `in (\d{1,4}) days` →
scheduledFor: new Date(options.now.getTime() + value * 86_400_000)
```

The `\d{1,4}` capture accepts up to **9999**, with no upper
bound on the resolved instant. "remind me in 9999 days"
queues a follow-up scheduled **~27 years** in the future — a
junk promise that bloats `~/.muse/followups.json` and never
meaningfully fires.

Goal 650 added a `[now − 5 min, now + 365 days]` sanity bound
to the **LLM** fallback detector (`followup-llm-detector.ts`,
`LLM_FOLLOWUP_FUTURE_HORIZON_MS`) and its Remaining Risks
explicitly deferred the rule detector:

> The rule-based `extractFollowupPromises` has no upper bound
> on its `\d{1,4}` day-count regex — `"in 9999 days"` produces
> a timestamp 27 years out. Sibling-fixable in a future iter.

This iter closes that gap: the rule detector's `push` helper
now rejects any promise whose resolved instant is beyond
`now + 365 days`, matching the LLM detector's horizon.

(No past-tolerance bound is needed here — the rule detector
derives every instant as a forward offset from `now`, or via
`nextOccurrenceAtHourMinute` which rolls a past time to
tomorrow, so it never produces a past instant. The LLM
detector needed the past bound because it parses model-emitted
absolute timestamps.)

### Defect class

**Value-range sanity bound on a derived timestamp** — same
class as goal 650 (LLM detector bound), applied to its sibling
rule-detector code path. 650 was ~28 iters ago (0 of the last
10 in this class). Fresh-enough class; the rule detector is a
distinct path closing 650's named remaining-risk.

Recent 10-iter window:

- 677: Korean source-block sanitizer (i18n)
- 676: supervisor worker tiebreaker
- 675: vision data-URL base64 validation
- 674: strict ?limit= parse (api history)
- 673: Math.min/max spread RangeError (calendar)
- 672: HTTP timeout (LINE)
- 671: asymmetric validation (web-search)
- 670: calendar local-timezone render

## Slice

- `packages/agent-core/src/followup-detector.ts`:
  - **New `export const RULE_FOLLOWUP_FUTURE_HORIZON_MS =
    365 * 86_400_000`** (parity name with the LLM detector's
    `LLM_FOLLOWUP_FUTURE_HORIZON_MS`).
  - The `push` helper — which already finite-guards and
    minute-dedups — now also rejects
    `ts > options.now.getTime() + RULE_FOLLOWUP_FUTURE_HORIZON_MS`.
    A WHY comment cites the 27-years-out scenario and the
    goal-650 parity.
- `packages/agent-core/test/followup-detector.test.ts`:
  - **Three new tests**: "in 9999 days" and "in 366 days"
    (just past the horizon) → dropped (length 0); "in 300
    days" (inside the horizon) → kept with the correct
    instant; and the constant pins to 365 days.

## Verify

- `pnpm --filter @muse/agent-core test`: 670 passed (667 prior
  + 3 new). Full `pnpm check`: every workspace green; tsc
  strict EXIT=0.
- **Clean-mutation-proven**: removing the horizon check
  (`if (ts > now + HORIZON) return;`) makes EXACTLY the
  "in 9999 days" test fail — it produces a promise (length 1)
  instead of being dropped (length 0). The in-horizon
  ("in 300 days") and constant-pin tests pass either way.
  Restored; all green.
- `pnpm lint`: 0 errors / 0 warnings.
- `pnpm guard:core`: clean.
- Byte-hygiene scan on the two touched files: clean.
- No LLM request/response wire path touched — the rule
  detector is a pure regex scan over an already-generated
  assistant turn. `smoke:live` doesn't apply (this is the
  rule-only path that exists precisely to avoid an LLM call).

## Status

Done. Both follow-up detectors now share the same future
horizon:

| Phrase                       | Pre-fix (rule detector)        | Post-fix                  |
| ---------------------------- | ------------------------------ | ------------------------- |
| "in 30 minutes"              | queued at now+30m              | unchanged                 |
| "in 3 days"                  | queued at now+3d               | unchanged                 |
| "in 300 days"                | queued at now+300d             | queued (inside horizon)   |
| "in 366 days"                | queued ~1 year out             | **dropped** (past horizon)|
| "in 9999 days"               | **queued ~27 years out**       | **dropped** (fixed)       |
| LLM detector "9999-12-31"    | dropped (goal 650)             | dropped (unchanged)       |

## Decisions

- **365-day horizon, matching the LLM detector** — both
  detectors now bound to the same window, so a follow-up's
  acceptance doesn't depend on which path detected it. A
  personal-assistant follow-up beyond a year is vanishingly
  rare; a user who genuinely wants a multi-year reminder can
  use a calendar event.
- **Future-only bound** — the rule detector never produces a
  past instant (forward offsets / next-occurrence roll-forward),
  so a past-tolerance check (which the LLM detector needs for
  model-emitted absolute timestamps) would be dead code here.
- **Separate constant, not imported from the LLM detector** —
  `followup-llm-detector.ts` imports the `FollowupPromise`
  type FROM `followup-detector.ts`, so importing the horizon
  the other way would couple the base detector to its LLM
  extension. The 365-day value is duplicated (one line each)
  with cross-referencing comments, which is cleaner than the
  circular-ish dependency. Both are named `*_FUTURE_HORIZON_MS`
  for grep-ability.
- **Bound in `push`, not per-regex** — `push` is the single
  emit chokepoint every regex branch funnels through (it
  already finite-guards + dedups), so one check covers all
  the relative / slot / at-time branches.
- **Mutation choice** — removed the horizon line. The
  "in 9999 days" test fails (promise emitted); the in-horizon
  and constant tests pass. Surgical proof.

## Remaining risks

- **The `\d{1,4}` regex still matches up to 9999** — the fix
  bounds the OUTPUT (resolved instant), not the input. "in
  9999 days" is parsed then dropped at `push`, which is the
  right layer (a `value × unit` that lands within the horizon
  for a smaller unit — e.g. "in 9999 minutes" ≈ 6.9 days — is
  correctly kept).
- **Korean relative phrases** (`9999일 후`) go through the same
  `push` chokepoint, so they're bounded too — verified by
  construction (all branches call `push`).
- **The horizon is not env-configurable** — both detectors
  hardcode 365 days. A future iter could wire a shared
  `MUSE_FOLLOWUP_HORIZON_DAYS` through autoconfigure for both
  paths at once.
- **`nextOccurrenceAtHourMinute` / `nextDayAtHour`** produce
  instants at most ~2 days out, well inside the horizon — the
  bound only ever trips the explicit large-N relative phrases.
