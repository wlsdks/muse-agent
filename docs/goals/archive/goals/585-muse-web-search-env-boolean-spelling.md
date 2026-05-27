# 585 — `MUSE_WEB_SEARCH` env flag accepts every standard boolean spelling (`true`/`1`/`yes`/`on` and `false`/`0`/`no`/`off`), aligning the setup-status snapshot with the rest of the codebase's boolean-spelling convention

## Why

`readWebSearchEnvSnapshot` (autoconfigure/setup-status.ts) — the
shared snapshot reader that feeds `muse setup --json` and
`GET /api/setup/status` — recognised only the exact literals
`"on"` and `"off"` (case-insensitive) on the `MUSE_WEB_SEARCH`
env flag. Any other value — including the perfectly standard
`MUSE_WEB_SEARCH=false`, `=0`, `=no`, or even `=true`, `=1`,
`=yes` — fell through to defaults with `source: "default"`.

This is inconsistent with the rest of the runtime-settings
boolean convention:

- `RuntimeSettings.getBoolean(...)` (packages/runtime-settings/src/index.ts:102)
  accepts the full 8-spelling set via `parseBooleanValue`.
- `parseBooleanSetting` (same module) exports the rich parser.
- `parseBoolean` in autoconfigure's env-parsers.ts already had
  the full 8-spelling set for boolean envs that have a fallback.

So an admin who set `MUSE_WEB_SEARCH=false` in their shell
intent-to-disable would see `muse setup --json` report
`webSearch.enabled: true, source: "default"` and quietly think
the env flag had been picked up — when it had silently been
ignored. Pure footgun.

Step-8 redirect: the prior 8-of-10 commits sat in `apps/cli/*`
on the `--json` envelope sweep. This iteration moves to a
different defect class entirely — env-flag boolean spelling
convention symmetric across all 8 standard tokens — in the
`autoconfigure` package.

## Slice

- `packages/autoconfigure/src/env-parsers.ts` — add
  `parseBooleanTriState(value): true | false | undefined`. The
  existing `parseBoolean(value, fallback): boolean` collapses
  undefined and unrecognised into the fallback; the new
  tri-state version distinguishes "explicit recognised value"
  from "set source to env" callers need (here:
  `readWebSearchEnvSnapshot`'s `source: "default" | "env"`).
- `packages/autoconfigure/src/setup-status.ts` — refactor
  `readWebSearchEnvSnapshot`'s `MUSE_WEB_SEARCH` branch from
  `?.toLowerCase()` + literal `=== "off" | "on"` to
  `parseBooleanTriState(...)` + `if (flag === false / true)`.
  All 8 spellings now flip `source: "env"`.
- `packages/autoconfigure/test/setup-status.test.ts` — three
  new tests:
  - every standard falsy spelling (`false / False / FALSE / 0
    / no / NO / off / Off`) disables with `source: "env"`,
  - every standard truthy spelling (`true / True / TRUE / 1 /
    yes / YES / on / On`) enables with `source: "env"`,
  - unrecognised spellings (`enabled / disabled / y / n / "  "
    / xyz / truue`) keep `source: "default"` so a typo does
    NOT silently flip the snapshot.

## Verify

- New `it(...)`s green; full `@muse/autoconfigure` suite green
  (146 passed, +3 vs baseline 143, 0 failed); tsc strict
  EXIT=0.
- **Clean-mutation-proven** (Edit-based): reverting the call
  site to the literal-string compare made 2 of the 3 new tests
  fail with `enabled` and `source` mismatches (the
  unrecognised-spellings test is unaffected because the old
  code also fell through to defaults for unknown values). Fix
  restored, suite back to all green.
- `pnpm check` EXIT=0 (apps/api 249 passed, apps/cli 1040
  passed, every workspace green); `pnpm lint` 0/0; `pnpm
  guard:core` clean; byte-scan clean; `git status` shows only
  the three intended files.
- Pure env-parsing surface — no LLM request-response wire
  path; `smoke:live` does not apply (per `testing.md` /
  iteration-loop Step 9). The defended path is `muse setup
  --json` / `GET /api/setup/status` snapshot accuracy when an
  admin uses a non-`on`/`off` boolean spelling.

## Status

Done. The `MUSE_WEB_SEARCH` env flag is now spelling-symmetric
with the rest of the boolean-env convention:

| Spelling                              | Before                    | After                                    |
| ------------------------------------- | ------------------------- | ---------------------------------------- |
| `on` / `off` (case-insensitive)       | recognised, source: env   | recognised, source: env (unchanged)      |
| `true` / `1` / `yes` (case-insens.)   | **ignored**, src: default | recognised, source: env (**fixed**)      |
| `false` / `0` / `no` (case-insens.)   | **ignored**, src: default | recognised, source: env (**fixed**)      |
| typos / garbage                       | ignored, src: default     | ignored, src: default (unchanged)        |

No CAPABILITIES line / no OUTWARD-TARGETS flip: a convention-
sweep `fix:` on the snapshot surface, recorded honestly with
this backlog row — not a false metric.

## Decisions

- **New helper `parseBooleanTriState` instead of reusing
  `parseBoolean`.** The existing `parseBoolean(value, fallback)`
  always returns `boolean` — it collapses both "value
  unrecognised" and "value unset" into `fallback`. The
  snapshot needed a 3-way distinction:
  `source: "default" | "env"` only flips on
  `flag !== undefined`. A `boolean` return type can't carry
  that signal. Considered branching on equality with the
  parsed result vs the fallback — rejected as fragile (a
  legitimate `MUSE_WEB_SEARCH=true` with a default-true would
  look the same as unset and stay source=default). Tri-state
  is the cleaner shape.
- **Inlined the helper in autoconfigure, didn't cross-import
  `parseBooleanSetting` from `@muse/runtime-settings`.** The
  runtime-settings helper is conceptually identical, but
  `autoconfigure` already owns the 8-spelling sets at module
  scope and the cross-package import would introduce a new
  edge in the workspace graph for a 6-line helper. The 8-token
  set is defined once per package (env-parsers.ts:31-32 and
  runtime-settings/src/index.ts:211-212) — the duplication is
  the price of keeping the package boundary clean. If the
  duplication ever becomes a third site, that's the signal to
  hoist to `@muse/shared`, not earlier.
- **Backward compatibility audit.** The old code recognised
  only `on`/`off`. Every other value was a no-op → defaults.
  The new code recognises 8 more spellings as on/off; nothing
  recognised before is now misinterpreted. Anyone who had
  `MUSE_WEB_SEARCH=xyz` (unknown) still gets defaults. The
  only behaviour change is unknown-spellings → known: pure
  semantic widening, not a break. Snapshot consumers (`muse
  setup --json`, `GET /api/setup/status`) get MORE accurate
  source attribution, not less.
- **No production caller of `readWebSearchSettings`
  (runtime-settings/src/index.ts:229) was touched.** That
  helper is exported but only its own test imports it; the
  production webSearch read goes through
  `runtimeSettings.getBoolean(...)` in
  `apps/api/src/server-helpers.ts:137`, which already uses the
  rich parser. So the convention sweep didn't need to touch
  it. A follow-up iter MAY align the two helpers (either drop
  the unused one, or have it call `parseBooleanSetting`
  internally for symmetry) — deferred to keep scope tight.
- **The unrecognised-spelling test (3 of 3) is the load-
  bearing typo-safety guarantee.** Even though the mutation
  doesn't break it (both old and new code fall through to
  defaults for `xyz`), it pins the contract: a typo'd
  `MUSE_WEB_SEARCH=truue` MUST NOT silently flip the snapshot
  to source=env. Future regressions that widen recognition
  (e.g. "starts with t → true") would break this test.
- **Step-8 sub-defect-class check: env-flag boolean spelling.**
  Different package (`autoconfigure` vs `apps/cli/*`), different
  surface (snapshot env-read vs CLI write-surface `--json`),
  different defect (spelling-recognition gap vs missing
  structured-envelope output). Clean redirect away from the
  prior 3+ CLI `--json` iterations.

## Remaining risks

- `packages/runtime-settings/src/index.ts:235` —
  `readWebSearchSettings` (the unused sibling) still uses
  strict `=== "true"` for `webSearch.enabled` and `=== "off"`
  for the env flag. Not production-reachable, but the test
  surface there is asymmetric with this iter's. Could be
  folded into a single follow-up that either deletes the
  unused export OR aligns it byte-for-byte with this snapshot.
- The same spelling-symmetry sweep could apply to other
  bi-state `MUSE_*` env flags reported by snapshot surfaces
  (`MUSE_USER_MEMORY_AUTO_EXTRACT`, the proactive-* flags,
  voice flags). Most of them already go through `parseBoolean`
  with a fallback, so they're already fine on the value side
  — but their `source: default | env` attribution (if any)
  may share the same defect class.
