# 095 — `muse status --suggestions` — anticipatory hints from patterns

## Why

JARVIS doesn't wait to be asked — he says "sir, your 3pm flight
is in 45 minutes". Muse has the data (patterns-fired tracks what
the user does + when) but the inference layer that turns
"fired at 09:00 most weekdays" into a hint never landed.
Add a `--suggestions` flag on `muse status` that derives 1-3
concrete "you usually do X around now" hints from the existing
patterns-fired sidecar.

## Scope

- Extend `apps/cli/src/commands-status.ts` with `--suggestions`.
- New `suggestPatternHints(firedRows, now)` pure helper:
  - Groups firings by pattern name.
  - For each pattern with ≥ 3 firings, compute the median hour-
    of-day. If `now`'s hour is within ±1 of the median, emit a
    suggestion line.
  - Cap at 3 suggestions.
- Skip silently when patterns-fired has < 3 entries (fresh
  install).
- Render under the snapshot, before the trailing newline:
  `Suggestions (3): * you usually check tasks around this hour`

## Verify

- cli +1 unit test on `suggestPatternHints` with a synthetic
  patterns-fired array (3 morning + 5 evening firings; verify the
  hint that matches `now`'s hour wins).
- Dogfood:
  ```
  HOME_DIR=$(mktemp -d -t muse-sugg-XXXX)
  mkdir -p "$HOME_DIR/.muse"
  # Seed patterns-fired with a "morning task check" pattern fired
  # at 09:00 several times — close to the current hour for the
  # rendered hint to surface.
  NOW=$(date -u +%H)
  cat > "$HOME_DIR/.muse/patterns-fired.json" <<EOF
  {"version":1,"fired":[
    {"patternId":"morning_tasks","firedAtIso":"2026-05-10T${NOW}:00:00Z"},
    {"patternId":"morning_tasks","firedAtIso":"2026-05-11T${NOW}:05:00Z"},
    {"patternId":"morning_tasks","firedAtIso":"2026-05-12T${NOW}:02:00Z"}
  ]}
  EOF
  HOME="$HOME_DIR" node apps/cli/dist/index.js status --user dogfood --suggestions
  ```
  Pass if stdout includes a "Suggestions" section + the
  `morning_tasks` pattern is named.

## Status

open
