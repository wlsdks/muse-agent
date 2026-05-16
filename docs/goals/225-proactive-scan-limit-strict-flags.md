# 225 — `muse proactive scan --lead-minutes` + history `--limit` strict numeric

## Why

Closes goal 224's noted follow-up — the two remaining
silent default-fallback flags in `commands-proactive.ts`,
completing strict-numeric consistency on the whole
anticipatory-surfacing command:

- `muse proactive scan --lead-minutes`:
  `options.leadMinutes ? Math.max(1, parseInt(x,10) || 10) : …`
  → `--lead-minutes 30abc` silently scanned a 30-min window;
  `abc` silently became 10.
- `muse proactive history --limit`:
  `Math.max(1, Math.min(500, parseInt(options.limit ?? "20",10) || 20))`
  → `--limit 50abc` silently listed 50; `abc` silently 20.

Same `parseInt`-trailing-garbage / silent-default class the
strict-numeric line removed everywhere else (177…215, 224).
For the dry-run scan, a silently-wrong window misreports
"what would fire next tick"; for history, a silently-wrong
limit misreports the audit trail — both with no signal the
flag was misparsed.

## Scope

- `apps/cli/src/commands-proactive.ts`: reuse the goal-224
  exported `parseBoundedFlag`:
  - `scan` `--lead-minutes` → `parseBoundedFlag(opt, …, 1,
    1440, <env-derived default>)`. The **flag** is now strict
    (rejects `30abc` / below-min); an **absent** flag still
    falls back to the `MUSE_PROACTIVE_LEAD_MINUTES` env
    default, which keeps its existing lenient contract (env
    is out of the strict-numeric line's CLI-flag scope —
    deliberately not changed to avoid a semantics shift).
  - `history` `--limit` → `parseBoundedFlag(opt, "--limit",
    1, 500, 20)`.
  No new helper; no behavior change for valid/absent input.
- `apps/cli/src/commands-proactive.test.ts`: a new case
  pinning the `--limit` `[1, 500]` bounds (absent→20,
  truncate+clamp-to-500, reject `50abc`/`0`). The
  `--lead-minutes` bounds are already covered generically by
  goal 224's `parseBoundedFlag` tests.

## Verify

- `pnpm --filter @muse/cli test` — 536 pass (1 new; existing
  proactive/strict tests unchanged → no regression).
- `pnpm check` exit 0; `pnpm lint` exit 0.
- Dog-fooded the real command (parsing is pre-action,
  deterministic — same stance as the rest of the strict
  line):
  - `muse proactive scan --lead-minutes 30abc` → stderr
    `muse: --lead-minutes must be an integer in [1, 1440]
    (got '30abc')`, exit **1** (was: silent 30-min window).
  - `muse proactive scan` (no flag) → `Window: … (10 min)` —
    the lenient env-fallback default still works, confirming
    no regression on the absent path.

## Status

done — every numeric flag on `commands-proactive.ts`
(watch `--interval`/`--lead-minutes` in 224, scan
`--lead-minutes` + history `--limit` here) now rejects a
typo / unit-slip / out-of-range value with an actionable
message; the env-var fallback default keeps its lenient
contract. The goal-224 follow-up is closed.
