# Goal 905 — `muse doctor --local` validates the home-alerts config

## Outward change

`muse doctor --local` now reports on `MUSE_BRIEFING_HOME_ALERTS` (the
"surface a home sensor in my briefing when it's in an alert state"
automation): a `home-alerts config` check that says `N home-alert(s)
configured` (ok) or, when entries are malformed, `M of K home-alert
entries are invalid and skipped — check entityId/label/alertStates`
(warn). Before, a typo'd entry (missing `entityId`/`label`, an empty
`alertStates`) was silently dropped by the fail-open parser, so the
alert never showed up in the briefing and nothing told the user why.

## Why this, now

The symmetric completion of 902 (web-watch config validation). The
two proactive-automation configs — `MUSE_WEB_WATCH_CONFIG` and
`MUSE_BRIEFING_HOME_ALERTS` — share the exact same silent-fail-open
trap, and the doctor (the one place a user checks "is my setup
working?") validated only the first. Closing the pair makes the
config-validation capability coherent and complete: every fail-open
proactive config a user can typo now gets feedback.

## How

New pure `classifyHomeAlertsConfig(raw)`, mirroring
`classifyWebWatchConfig`:
- unset / whitespace / empty array → `undefined` (no check, no noise);
- not valid JSON → warn; not a JSON array → warn;
- otherwise compares the raw entry count to the count
  `parseHomeAlertChecks` actually builds, reporting `ok` when equal or
  `warn` quantifying the drop (singular/plural phrasing).

It drives the REAL `@muse/mcp` `parseHomeAlertChecks` for the valid
count (not a re-implementation), so the diagnostic can't drift from
what the briefing daemon builds. `runLocalDoctor` pushes the check
only when the env is set, right after the web-watch check.

## Verification

`apps/cli` `commands-doctor.test.ts` (`npx vitest run --root apps/cli
commands-doctor.test.ts`, 35 passing): unset/empty→undefined; all-valid
→ ok+count; mixed → warn "2 of 3 … invalid"; single drop → singular
"1 of 2 … entry is invalid"; bad-JSON and non-array → warn. Mutation-
proven: forcing `valid = total` fails the two drop-quantifying tests;
restored green. `pnpm check` green (apps/cli 1598, apps/api 323);
`pnpm lint` 0/0. No LLM path → no smoke:live (Ollama down regardless).

## Decisions

- Mirrored `classifyWebWatchConfig` exactly (same shape, phrasing,
  emit-only-when-set rule) so the two config checks read identically
  in the doctor output and share one mental model.
- Drove `parseHomeAlertChecks` directly rather than re-deriving the
  per-entry validity (entityId/label/alertStates) — a second copy
  would drift from the briefing daemon the first time either changed.
