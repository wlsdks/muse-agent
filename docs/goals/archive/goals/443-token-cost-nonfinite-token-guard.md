# 443 — A non-finite token count can't poison the token-volume ranking (428 sibling)

## Why

Goal 428 added `finiteCostUsd` to `InMemoryTokenCostQuery`
(`@muse/observability` `observability-token-cost.ts`) because
`?? 0` does not catch NaN/Infinity: a single corrupt or
hand-edited `estimatedCostUsd` row would poison the whole
daily/top-expensive/per-session aggregate AND the cost sort
comparator (NaN ⇒ spec-undefined order).

The **parallel token fields** — `completionTokens`,
`promptTokens`, `totalTokens` — were left unguarded with the
identical exposure. This is not theoretical here: the file's own
`topExpensive` comment and test 714–728 establish that under the
**Qwen-only / $0 mandate** every `estimatedCostUsd` is `0`, so
the ranking comparator `b.totalCostUsd - a.totalCostUsd ||
b.totalTokens - a.totalTokens` *always* falls through to the
`totalTokens` tiebreak. So in the project's actual operating mode
the token tiebreak is the **primary** sort key, and one corrupt /
hand-edited NaN `totalTokens` row (428's stated threat model — a
"hand-edited 'NaN' DB row") makes the comparator return NaN and
the user-facing "what used the most tokens" ranking
spec-undefined — plus `daily` would render `NaN` token totals.

The 428-style NaN test covered only the cost field; a grep
confirmed **zero** assertions on NaN token fields. This is the
sanctioned 428 / 433 sibling-asymmetry class ("fix one, the
sibling carrying the identical concrete gap"), probe-confirmed,
fully unit-verifiable in-memory (no PG), on a fresh package
(observability last touched goal 428, ~15 iterations ago — no
same-area churn).

## Slice

- `packages/observability/src/observability-token-cost.ts` — add
  `finiteTokens` (byte-parallel to `finiteCostUsd`) and apply it
  to `completionTokens` / `promptTokens` / `totalTokens` at the
  exact aggregation + passthrough points 428 hardened for cost:
  `bySession` (3 fields), `daily` (3 summed fields), `topExpensive`
  (the summed + sort-comparator `totalTokens`, both the
  new-group and merge branches). Behaviour-identical for every
  finite row; only a non-finite token contributes `0` instead of
  poisoning the sum/comparator.
- `packages/observability/test/observability.test.ts` — a new
  `it` mirroring the 428 cost test for tokens, in the cost-tied
  ($0) scenario so the token tiebreak *is* the sort key: a NaN
  `totalTokens` run → its `topExpensive`/`bySession` total is `0`
  (not NaN), the ranking is the well-defined
  `["huge","small","bad"]`, and `daily` token totals stay finite
  (`9120`, never NaN).

## Verify

- New `it` green; full `@muse/observability` suite 62 passed
  (+1); tsc strict (observability) EXIT=0.
- **Mutation-proven teeth**: reverting just the `topExpensive`
  else-branch `finiteTokens(event.totalTokens)` → raw
  `event.totalTokens` makes the new test fail with exactly
  `AssertionError: expected NaN to be +0`; source then restored
  (suite back to 62 green). The guard is load-bearing, not
  decorative.
- `pnpm check` EXIT=0, every workspace green (observability 62,
  cli 737, api …) — no regression, confirming behaviour-identical
  for finite data; `pnpm lint` 0/0; `pnpm guard:core` clean;
  byte-scan clean; `git status` shows only the two intended
  files.
- Pure deterministic aggregation math — no LLM / model
  request-response wire path; `smoke:live` does not apply (per
  `testing.md` / iteration-loop Step 9).

## Status

Done. A corrupt or hand-edited non-finite token count now
contributes `0` rather than poisoning the daily token totals or
collapsing the `topExpensive` ranking into spec-undefined order —
the same protection 428 gave the cost field, now extended to the
token fields that are the *operative* ranking key under the
Qwen-only / $0 mandate. The two halves of the cost/token
aggregation are field-symmetric again.

No CAPABILITIES line / no OUTWARD-TARGETS flip: all P-bullets are
already `[x]` and audited; a robustness `fix:` to an existing
telemetry surface (428 sibling), recorded honestly with this
backlog row — not a false metric.

## Decisions

- Kept `finiteTokens` a distinct one-liner rather than reusing
  `finiteCostUsd`: same body today, but they guard semantically
  different quantities (dollars vs counts) and a future change to
  one (e.g. integer-truncating tokens) must not silently bleed
  into the other. One-line duplication < wrong coupling.
- Guarded the same call-site set 428 guarded for cost (not also
  the Kysely path): the in-memory path is the unit-verifiable
  one and the exact 428 parallel; the Kysely SUM/percentile
  divergences (negative-duration clamp, `LIKE` metachars) are a
  separate Testcontainers-gated concern — logged, not scope-crept
  here.
