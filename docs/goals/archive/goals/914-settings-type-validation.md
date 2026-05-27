# Goal 914 — `muse settings set --type` validates the override (with a "did you mean")

## Outward change

`muse settings set <key> <value> --type <type>` now rejects an invalid
`--type` locally — `--type must be one of string | number | boolean |
json (got 'boolen') — did you mean 'boolean'?` — and issues NO PUT.
Before, the `--type` override was passed straight into the request
body unvalidated, so a typo (`--type bool`, `--type boolen`) shipped a
garbage type to the settings store and the user got an opaque
server-side error (or a setting written with a nonsense type) instead
of a clear, correctable CLI message.

## Why this, now

The same input-validation seam as `orchestrate run --mode` (which
already validates its enum with a `closestCommandName` hint) and the
recent `--limit` / `--before` / `dueAt` fixes (907/911/913) — applied
to the one remaining unvalidated enum-ish override. `settings set`
toggles runtime features (`webSearch.enabled`, …); a silently-wrong
`--type` either fails opaquely or persists a mistyped setting. A clear
local error with a suggestion is the consistent, friction-free
behaviour the sibling commands already give.

## How

The `set` action validates an explicit `--type` against
`["string", "number", "boolean", "json"]` (case-insensitively
normalised), throwing a clear error with a `closestCommandName`
"did you mean" hint for a near-miss and no guess for a wholly-unknown
value — exactly mirroring `orchestrate --mode`. A valid override is
lower-cased into the body; omitting `--type` still auto-infers via
`inferSettingType`. No new dependency (reuses `closestCommandName`).

## Verification

`apps/cli` `commands-settings.test.ts` (`npx vitest run --root
apps/cli commands-settings.test.ts`, 8 passing): a fake `apiRequest`
harness asserts an invalid `--type` near-miss throws with the
"did you mean 'boolean'" hint and issues NO request; a wholly-unknown
`--type` throws WITHOUT a guess; a valid `--type NUMBER`
(case-insensitive) sends `type:"number"` in the PUT body; omitting
`--type` auto-infers `boolean`. The existing `inferSettingType` unit
tests stay green. Mutation-proven: reverting to the raw
`options.type ?? inferSettingType(value)` fails the three validation
tests; restored green. `pnpm check` green (apps/cli 1655, apps/api
323); `pnpm lint` 0/0. Thin HTTP wrapper + commander validation, no
LLM path → no smoke:live (Ollama down regardless).

## Decisions

- Threw (consistent with `orchestrate --mode`) rather than printing +
  `process.exitCode = 1`: an explicit `--type` that's wrong is a usage
  error, and the top-level CLI surfaces a thrown commander action as a
  clear message + non-zero exit.
- Validated only the explicit override, leaving auto-inference
  untouched — `inferSettingType` is already correct + tested, and the
  gap was solely the unchecked override.
