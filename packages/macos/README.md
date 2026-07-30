# @muse/macos

Owns Muse's native macOS control tools: in-process `MuseTool`s that spawn official Apple CLIs
(`osascript`, `shortcuts`, `open`, `pmset`, `screencapture`, `pbcopy`, `mdfind`) directly, plus
one-way mirrors into Reminders/Notes/Contacts and a helper-binary read bridge. It is a package
rather than a folder because it is deliberately split out of `@muse/mcp` — "Muse-own native tool"
and "MCP plumbing" are separate — and every tool here shares one AppleScript-injection defense.

## Public surface

- `./` (main entry, `export *`) — macOS `MuseTool`s (`macos-tools.ts`) plus the Reminders/Notes
  mirrors and Contacts import.
- `readMacHelper`, `readMacWindows`, `MAC_HELPER_READS` — bridge to a companion macOS helper
  binary for reads the App Sandbox/AppleScript path can't reach.
- `createMacObserveTool`, `MAC_OBSERVE_SOURCES` — the observe-surface tool over the supported
  macOS ambient sources.
- `resolveMacHelperPath` — locates the helper binary.
- `./system-resource-observation` (separate exports subpath) — idle time, AC/battery power state,
  and thermal-state probes (`readMacIdleMs`, `parseThermalState`, etc.).

## Depends on

- `@muse/shared` — common primitives.
- `@muse/tools` — the `MuseTool` contract this package implements. Never depends on `@muse/mcp`.

## Rules that bind this package

Every AppleScript-bound string (a reminder title, a note body) from user/model text is escaped
with the shared `escapeAppleScript` helper before entering an `osascript` program — untrusted
content must not be able to terminate the string context and inject statements, per
[`../../CLAUDE.md`](../../CLAUDE.md)'s "tool output is untrusted" principle. The Reminders/Notes
mirrors are opt-in and fail-soft: gated by an env flag (e.g. `MUSE_APPLE_REMINDERS_MIRROR`,
default off), and a mirror failure never rolls back or blocks the underlying Muse-store write. The
outbound iMessage tool takes its approval gate and action logger by injection, so the
[`../../.claude/rules/safety/outbound-safety.md`](../../.claude/rules/safety/outbound-safety.md) wiring lives at
the CLI boundary. The `./system-resource-observation` subpath is the one part of this package that
self-disables on a non-macOS `process.platform`; the rest assumes a macOS host and relies on the
caller to gate registration by platform.

## Tests

```bash
pnpm --filter @muse/macos test
```
