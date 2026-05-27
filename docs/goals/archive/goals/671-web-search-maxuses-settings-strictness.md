# 671 — `decideWebSearchPolicy`'s settings-path `maxUses` resolution gains the same `Number.isInteger` + positive guard the env path already enforces, so a `settings.webSearch.maxUses` of `Infinity` (unbounded search budget) or a non-integer (`3.5`) can't slip past where `MUSE_WEB_SEARCH_MAX_USES` would reject it

## Why

`packages/model/src/web-search-policy.ts:resolveMaxUses`
resolves the native-web-search budget from two sources with
**asymmetric strictness**:

- **Env path** (`MUSE_WEB_SEARCH_MAX_USES`): runs through
  `strictPositiveInt` — requires the whole trimmed token to
  be a plain positive integer; rejects `"3x"`, `"30s"`,
  `"1e3"`, `"5.9"`, `"-3"`, `"0"`, etc. (goal-463 lineage).
- **Settings path** (`settings.webSearch.maxUses`): only
  `typeof === "number" && maxUses > 0`.

So a config object carrying:

```ts
settings: { webSearch: { maxUses: Infinity } }   // → returns Infinity
settings: { webSearch: { maxUses: 3.5 } }         // → returns 3.5
```

passes the bare `> 0` check. `Infinity > 0` is `true`, so an
**unbounded** search budget is returned — the agent could
issue web-search calls without limit. `3.5 > 0` is `true`,
so a **non-integer** budget is returned, disagreeing with
the integer contract the env path enforces and the
`WebSearchPolicy.maxUses: number` field implies.

(`NaN`, `0`, `-1` already fell through correctly — `NaN > 0`
and `0 > 0` and `-1 > 0` are all `false`. The reachable bugs
were specifically `Infinity` and non-integer floats.)

The fix adds `Number.isInteger(settings.maxUses)` to the
settings-path check, so it matches the env path: a non-finite
or non-integer settings value falls through to the
`DEFAULT_MAX_USES` (5), exactly as a malformed env value does.

### Defect class

**Asymmetric validation between two config sources for the
same field** (one strict, one lax) — same shape as goal 664
(create-gate vs the constant it should enforce), but a
distinct site (web-search budget, model package) and a fresh
AREA (the model / web-search-policy module hasn't been
touched in the recent window). Deliberately a different area
than the recent messaging-timeout run (668/669) and the
calendar fix (670) to keep the stagnation guard happy —
messaging already shows 3× in the last 10 (661/668/669), so
this iter stays out of messaging.

Recent 10-iter window:

- 670: calendar local-timezone render
- 669: Discord/Slack fetch timeout
- 668: Telegram fetch timeout
- 667/666: route to synthesizeAndPlay
- 665: execution-layer clamp
- 664: config upper bound
- 663: route to shared embed
- 662: mkdtempSync cleanup
- 661: concurrent RMW race

## Slice

- `packages/model/src/web-search-policy.ts`:
  - `resolveMaxUses`'s settings branch now requires
    `Number.isInteger(settings.maxUses)` alongside the
    existing `typeof === "number"` and `> 0`. A WHY comment
    explains the env-path-parity rationale.
- `packages/model/src/web-search-policy.test.ts`:
  - **One new test**: a loop over `[Infinity, NaN, 3.5, 0,
    -1]` settings values, each asserting the resolved budget
    falls through to the default `5`; plus a positive-integer
    (`7`) case asserting legitimate values are still honoured.

## Verify

- `pnpm --filter @muse/model test`: 172 passed | 5 skipped
  (the skips are pre-existing live-provider-gated tests). The
  new test passes. Full `pnpm check`: every workspace green;
  tsc strict EXIT=0.
- **Clean-mutation-proven**: reverting the settings check
  back to the bare `typeof === "number" && maxUses > 0`
  makes the new test fail — `Infinity` and `3.5` slip through
  and the function returns them (instead of `5`), exactly the
  unbounded-budget / non-integer-budget symptom. The `NaN`,
  `0`, `-1` cases pass either way (they already failed `> 0`).
  Restored; all green.
- `pnpm lint`: 0 errors / 0 warnings.
- `pnpm guard:core`: clean.
- Byte-hygiene scan on the two touched files: clean.
- No LLM request/response wire path touched — this is a pure
  policy-resolution function. `smoke:live` doesn't apply.
  (Native web search is an Anthropic/OpenAI capability; Muse's
  Qwen-only loop policy doesn't exercise it live, but the
  policy code is maintained for the provider-neutral
  architecture.)

## Status

Done. The web-search budget is now bounded identically from
both sources:

| `maxUses` source                          | Pre-fix              | Post-fix                    |
| ----------------------------------------- | -------------------- | --------------------------- |
| env `"5"` (valid)                         | 5                    | 5                           |
| env `"3x"` / `"5.9"` / `"-3"` (invalid)   | falls to 5           | falls to 5 (unchanged)      |
| settings `7` (valid)                      | 7                    | 7                           |
| settings `Infinity`                       | **Infinity** (unbounded) | **5** (fixed)           |
| settings `3.5`                            | **3.5** (non-integer) | **5** (fixed)              |
| settings `NaN` / `0` / `-1`               | falls to 5           | falls to 5 (unchanged)      |

## Decisions

- **`Number.isInteger`, not `Number.isFinite`** — a search
  budget is a count of calls, conceptually a whole number,
  matching the env path's integer requirement. `Number.isInteger`
  also rejects `Infinity` and `NaN` (both non-integer), so a
  single guard covers all the non-finite cases too.
- **Fall through to default, not throw** — consistent with
  the env path (a malformed env value silently uses the
  default; `muse doctor` is where an operator sees the
  invalid-config warning). A throw here would break policy
  resolution for a borderline config.
- **Did NOT validate at the type boundary** (e.g., a Zod
  schema on `WebSearchSettings`) — that's a broader change.
  The resolution function is the single chokepoint both
  sources funnel through; guarding it bounds the behaviour
  regardless of how the settings object was constructed.
- **Mutation choice** — reverted the `Number.isInteger`
  addition. `Infinity` and `3.5` slip through (return
  themselves) and the test fails with the unbounded /
  non-integer symptom; the already-falsy cases pass. Surgical
  proof of the parity fix.

## Remaining risks

- **`WebSearchSettings.maxUses` has no schema validation at
  ingest** — the value arrives from runtime settings / config
  as a raw number. The resolution-time guard is the
  defense; a schema at the config-parse boundary would be
  belt-and-braces. Out of scope.
- **Native web search is unused in the Qwen-only loop** — the
  fix is for the provider-neutral architecture (Anthropic /
  OpenAI native search). Low live impact today, correct for
  the general case.
- **`settings.enabled` is a boolean** (line 42) and doesn't
  have the same numeric-validation concern — only `maxUses`
  needed the parity fix.
- **The default of 5** is shared between both paths via
  `DEFAULT_MAX_USES`; a future iter could expose it for
  operator override if a higher ceiling is ever wanted.
