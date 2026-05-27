# 789 — feat: macOS active-window ambient source (live continuous perception)

## Why

P20 continuous perception. The ambient notice loop (756) + daemon
(765) perceive only via `~/.muse/ambient.json` — a file an external
launchd/cron helper must write. The named follow-on was a REAL OS
signal source. This delivers it: Muse reads the frontmost app + window
title live via `osascript`, so "you're in Calendar on the standup
window → here are your notes" fires WITHOUT any helper writing a file.

## Slice

`@muse/mcp` macos-ambient-source.ts:
- `parseActiveWindowSignal(stdout)` — pure: osascript output (app on
  line 1, window title on line 2) → `AmbientSignal`; empty output (no
  frontmost app / no Accessibility permission) → `undefined` so the
  loop stays quiet on a blank signal.
- `MacOsActiveWindowSource implements AmbientSignalSource` — runs the
  active-window AppleScript via an injected `run` (default spawns
  `osascript` with a 3s timeout) and parses it; ANY failure → snapshot
  `undefined` (never throws).
- `apps/api` tick-daemons.ts — `MUSE_AMBIENT_SOURCE=macos` (on darwin)
  selects the live source instead of the file source.

## Verify

- `@muse/mcp` macos-ambient-source.test.ts (new, 6): parse app+window /
  app-only (no front window) / empty→undefined; the source returns the
  parsed live signal over an injected runner; a throwing / empty run →
  `undefined`; **end-to-end** — a live "Calendar / Team Standup" signal
  drives a proactive notice through `createAmbientNoticeRunner` + a real
  `ProactiveNoticeSink`, fire-once edge-deduped.
- **Mutation-proven**: removing the empty-app guard → empty output
  yields a signal → the empty-output test fails; restore → 6/6. Full
  `pnpm check` EXIT 0 (the existing ambient daemon test still green —
  default stays file-source), `pnpm lint` 0/0. No model path → no
  `smoke:live`.

## Decisions

- **Inject the spawn, test the parse** — the deterministic parse +
  fail-open are exercised against contract-faithful osascript output;
  the default `execFile` spawn is thin glue. Matches the project's
  boundary-injection pattern.
- **App on line 1, window on line 2** — newline-delimited (a window
  title rarely contains a newline), avoiding the known tab-in-title
  delimiter edge.
- No bullet flip — P20's continuous-perception bullet is `[x]`; this
  is the named "OS active-window source" follow-on (CAPABILITIES line
  under P20). The file source remains the cross-platform default.
