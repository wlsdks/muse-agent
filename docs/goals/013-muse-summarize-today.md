# 013 — `muse summarize today`

## Why

`muse today` is a structured report. The JARVIS-feel ask is a
2-3 sentence LLM-narrated end-of-day journal entry: "you completed
3 tasks, sent the Q3 memo, and the morning walk pattern fired
on schedule." Useful as a daily-log paste-in for notes.

## Scope

- New CLI subcommand `muse summarize today` (or extend
  `muse today --summarize`).
- Compose: pull `muse today` briefing + `muse history --since
  today-start` + persona top-of-mind.
- Pipe through `agentRuntime.run()` with a small prompt
  ("narrate the user's day in 2-3 sentences; Korean unless persona
  says otherwise").
- `--save-to-notes <path>` optional flag persists the result.

## Verify

- pnpm check / lint / smoke broad + live (the live test prompts
  Gemini with a seeded briefing; verifies non-empty narrative
  returned).
- cli +1-2 tests.

## Status

open
