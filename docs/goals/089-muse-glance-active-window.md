# 089 — `muse glance` — active-window awareness (macOS)

## Why

JARVIS knows which workshop terminal Tony is staring at. Muse has
no ambient screen awareness — every query starts from zero
context. Add `muse glance` (macOS only, like the existing
`MacosNotificationProvider`) that returns the frontmost app, the
active window title, and any selected text via `osascript`. Pure
shell-out, no extra dep.

## Scope

- New `apps/cli/src/commands-glance.ts`.
- `muse glance [--json]` calls `osascript -e '...'` to get:
  - frontmost app name
  - frontmost window title
  - currently-selected text (via Accessibility API; soft-fail when
    not granted — surfaces an empty `selected` field instead of
    erroring).
- Exit cleanly on non-macOS with a one-line hint
  ("muse glance requires macOS — Linux/Windows support is a
  follow-up").

## Verify

- cli +1 unit test on the pure parser that turns osascript's
  newline-delimited output into `{ app, window, selected }`.
- Dogfood (skip on non-darwin):
  ```
  if [ "$(uname)" = "Darwin" ]; then
    node apps/cli/dist/index.js glance --json
  fi
  ```
  Pass if JSON contains a non-empty `app` field.

## Status

open
