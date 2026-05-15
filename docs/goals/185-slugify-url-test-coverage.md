# 185 — direct test coverage for `slugifyUrl`

## Why

`slugifyUrl` derives the default feed `--id` from a URL when
the user runs `muse feeds add <url>` without `--id`. That id
is user-visible and is what `muse feeds remove` / `refresh`
(goal 153) match on. The function has several non-obvious
branches — scheme strip (`http(s)://` / `file://`),
non-`[A-Za-z0-9._-]` run collapse, leading/trailing dash trim,
60-char cap, and the `|| "feed"` empty fallback — and was
**module-private with zero direct coverage**, contrary to the
testing rule ("direct unit tests for every export of every
helper module — no implicit-only coverage").

## Scope

- `apps/cli/src/commands-feeds.ts`: `slugifyUrl` is now
  `export`ed. No behaviour change.
- `apps/cli/src/commands-feeds.test.ts`: 6 cases pinning the
  contract — scheme strip, run collapse, dash trim, 60-cap,
  empty→`feed`, and clean host+path preserved verbatim.

## Verify

- `pnpm --filter @muse/cli test` — 482 pass (6 new).
- `pnpm check` exit 0; `pnpm lint` exit 0.
- No behaviour change, no real-LLM path (test coverage +
  export visibility only; smoke:live not required).

## Status

done — the slug contract that backs every default feed id is
now pinned; a future refactor that breaks scheme-stripping or
the empty fallback fails a test instead of silently producing
a wrong `muse feeds` id.
