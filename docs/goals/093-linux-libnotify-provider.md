# 093 — `LinuxLibnotifyProvider` parallel to MacosNotificationProvider

## Why

JARVIS speaks to Tony in the workshop regardless of OS. Muse's
`MacosNotificationProvider` only fires on darwin; a Linux user
on the same proactive daemon gets a silent log entry. Add a
parallel `LinuxLibnotifyProvider` that shells out to
`notify-send` (the libnotify CLI, present on every major Linux
desktop). Same fail-soft constructor posture: throws on non-Linux
hosts so the messaging registry skips it cleanly.

## Scope

- New `LinuxLibnotifyProvider` class in `@muse/messaging`,
  alongside `MacosNotificationProvider`.
- Constructor accepts optional `{ title?: string, urgency?:
  "low" | "normal" | "critical" }`.
- Throws on `process.platform !== "linux"` (matches mac provider).
- `send(_destination, { text })` spawns
  `notify-send [--app-name muse] [--urgency <u>] <title> <text>`.
- Autoconfigure wires it under
  `MUSE_MESSAGING_LIBNOTIFY_ENABLED=true` (opt-in like the macOS
  provider) in `packages/autoconfigure/src/registry-builders/messaging.ts`.

## Verify

- messaging +1 test: mock `child_process.spawn`, assert argv shape
  + that non-linux host construction throws.
- Dogfood (skip on non-linux):
  ```
  if [ "$(uname)" = "Linux" ]; then
    MUSE_MESSAGING_LIBNOTIFY_ENABLED=true \
      node apps/cli/dist/index.js messaging providers --local
  fi
  ```
  Pass if the providers list includes `libnotify` (or cleanly
  skipped on non-linux).

## Status

open
