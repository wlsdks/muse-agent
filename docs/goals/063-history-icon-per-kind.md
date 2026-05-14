# 063 — muse history kind-prefix icons

## Why

Tiny icon per kind (📞 reminder, 💬 episode, etc.) for quick scanning.
TTY-aware fallback.

## Scope

- icon map + render block.
- NO_COLOR respected.

## Verify

- cli +1 test.

## Status

done — `commands-history.ts` now prefixes each entry header with
an ASCII-only kind glyph from a frozen `HISTORY_KIND_ICONS` map:

  - reminder  → `(R)`
  - proactive → `(P)`
  - followup  → `(F)`
  - pattern   → `(*)`
  - episode   → `(E)`
  - unknown kind → `(.)` fallback

Scope deviation from the proposal: glyphs are ASCII, not emoji.
The project CLAUDE.md is strict about "no emojis" in source, so
the goal's "📞 reminder" etc. is realised with the closest
ASCII analogue that still scans cleanly in a vt100 / CI log.
TTY-awareness is moot — the chosen glyphs render in every
terminal — but the map is exported so a future colorised variant
(NO_COLOR-aware) can layer on without duplicating the mapping.

cli +1 unit test asserts the map's contents + that every glyph
is pure printable ASCII so the column never grows wide.
