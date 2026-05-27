## 875 — fix: `muse tasks list` shows which tasks are urgent

## Why

Tasks carry an `urgent` flag (set via `muse tasks edit --urgent`,
emitted by `serializeTask`, surfaced in `muse today` since 838) — but
`muse tasks list` rendered id/title/status/due/tags and dropped it. So
an urgent task looked identical to a normal one exactly where the user
reviews their list. The same seam class as 865 (recurrence invisible in
`remind list`): a stored, settable field a primary view didn't reflect.

## Slice

`apps/cli` human-formatters.ts `formatTaskRow`: prepend `⚠ ` to an
urgent task's title (matching the briefing's `⚠` for escalated items);
`HumanTaskRow` gains `urgent?`. Normal tasks are unchanged.

## Verify

`apps/cli` human-formatters.test.ts (+1): `formatTaskList` marks an
urgent task with `⚠ Pay rent` and leaves a normal task unmarked.
- **Mutation-proven**: dropping the urgent badge fails the marker test.
- `pnpm check` EXIT 0, `pnpm lint` 0/0. Pure formatter, no LLM path.

## Decisions

- `⚠` is consistent with the situational briefing's escalated-item
  marker, so urgency reads the same across surfaces.
- `serializeTask` already emits `urgent`, so the list payload (local +
  API) carries it — only the renderer needed it.
- No new dependency.
