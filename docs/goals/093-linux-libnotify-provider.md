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

done — new `LinuxLibnotifyProvider` parallels
`MacosNotificationProvider`. Spawns `notify-send` via the same
runner-injection pattern (constructor-throw on non-linux unless
a test runner is provided). Pure argv builder
`buildNotifySendArgv` is exported so the unit test pins the
exact command line without firing a real notification.

Opt-in via `MUSE_MESSAGING_LIBNOTIFY_ENABLED=true`, mirroring
the macOS flag. Optional `MUSE_MESSAGING_LIBNOTIFY_TITLE` (app
name) + `MUSE_MESSAGING_LIBNOTIFY_URGENCY` (low|normal|critical)
env knobs. Autoconfigure swallows the wrong-OS throw silently
so a shared dotfile setting both Linux + macOS flags doesn't
break boot on either.

messaging +5 tests (argv builder happy + subtitle-less,
send round-trip, custom title/urgency, non-linux guard,
non-zero exit surfaces `MessagingProviderError`). Dogfood is
best-effort-skipped on this macOS host per JARVIS-NEXT.md
contract; the unit tests carry correctness.
