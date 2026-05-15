# 153 — `muse feeds remove` / `refresh --id` fuzzy-suggest typos

## Why

The fuzzy-suggest pattern landed across most CLI surfaces
(goals 099, 100, 114, 118, 119, 124, 125, 131, 132, 133, 137,
151) but the feed-id surfaces were skipped. Two specific bad
UXs survived:

- `muse feeds remove tech-news` (the feed is named `tech_news`)
  → printed *"no feed with id 'tech-news'"* with no hint at the
  closest match.
- `muse feeds refresh --id weater` → printed the deceptive
  *"(no feeds to refresh)"* and exited **0**. Indistinguishable
  from "the named feed happened to refresh with nothing new"
  — the user thinks a refresh ran when it didn't.

## Scope

- `apps/cli/src/commands-feeds.ts`:
  - `remove <id>`: trim input, check existence first, on miss
    surface `closestCommandName(trimmed, knownIds)` hint +
    `muse feeds list` pointer + exit 1.
  - `refresh --id <id>`: same pre-check + hint, exit 1 instead
    of the silent 0.
- `apps/cli/src/commands-feeds.test.ts` (new):
  - 4 cases — typo→hint, no-suggestion case, exact-match clean
    path, refresh-typo→hint. End-to-end via `MUSE_FEEDS_FILE`
    env + a fake `ProgramIO` (same pattern as goal 152's tests).

## Verify

- `pnpm --filter @muse/cli test` — 399 tests pass.
- `pnpm check` exit 0.
- `pnpm lint` exit 0.
- No real-LLM path touched (`smoke:live` unchanged).

## Status

done — the feed-id surfaces now share the rest of the CLI's
"did you mean …" voice; silent `refresh --id <typo>` no longer
masquerades as a successful no-op.
