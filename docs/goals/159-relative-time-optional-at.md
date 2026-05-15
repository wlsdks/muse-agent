# 159 — relative-time parser accepts a time without the `at` keyword

## Why

Dog-food finding: `muse tasks add "..." --due "tomorrow 9am"`
was rejected with `INVALID_TASK_DUE_AT`. Only `tomorrow at 9am`
(with the `at` keyword) or a raw ISO string worked. A personal
JARVIS-style assistant must understand the way people actually
type times — "tomorrow 9am", "next monday 6pm", "today noon" —
not just the stilted `at`-prefixed form.

The `resolveRelativeTimePhrase` day pattern required
`\s+at\s+` between the day phrase and the time spec, so the
no-`at` form fell through to "unsupported phrase" → undefined →
the caller surfaced a hard rejection.

## Scope

- `packages/mcp/src/loopback-relative-time.ts`:
  - Day pattern `(?:\s+at\s+(.+))?` → `(?:\s+(?:at\s+)?(.+))?`
    — the `at` keyword is now optional. One-character-class
    change; every existing `at` form parses identically.
  - Header doc updated to list the no-`at` forms.
- `packages/mcp/test/mcp.test.ts`:
  - New case "accepts the time without the 'at' keyword (goal
    159)" covering `tomorrow 9am`, `today 6pm`, `tomorrow 14:30`,
    `next monday 6pm`, `today noon`, plus regression checks that
    `tomorrow at 9am` and bare `tomorrow` still resolve.

## Verify

- `pnpm --filter @muse/mcp test` — 327 pass (1 new).
- `pnpm check` exit 0; `pnpm lint` exit 0.
- End-to-end dog-food (Ollama qwen3:8b API, reasoning off):
  `muse tasks add --due "tomorrow 9am"` →
  `due 2026-05-16 09:00` (previously rejected). `today 6pm`,
  `next monday 6pm`, `tomorrow 14:30`, and the legacy
  `tomorrow at 9am` all resolve correctly.

## Status

done — pure date logic, no model round-trip changed (smoke:live
not required). Korean phrases ("내일 오후 3시") remain a
separate, larger goal.
