# 353 — `muse ask --with-tools --json` also broke the JSON contract on agent error

## Why

Closes the follow-up goal 352 explicitly flagged
("scoped to the chat-only fast path; the `--with-tools` agent
path … is a separate concern, not modified"). Investigation
confirmed it is the **exact same bug**:

The `ask` action (lines 255–668) has **no outer try/catch**.
The `--with-tools` branch calls `await
assembly.agentRuntime.run(...)` with no local error handling, so
a provider/agent failure (Ollama down, 5xx, guard block, tool
error) **propagates uncaught** out of the action. program.ts
has no ask-specific top-level handler, so the success
JSON-payload block (which only runs after `run()` resolves) is
never reached → in `--json` mode **stdout is empty**, identical
to the chat-only bug fixed in 352. `muse ask --with-tools --json
… | jq` gets nothing on any agent failure and a script has no
structured way to detect it.

## Scope

`apps/cli/src/commands-ask.ts` — wrap the agent-path
`agentRuntime.run` + result assignment in `try/catch`; on
error route through the **same** `renderAskStreamError` helper
extracted in 352:

- `--json` → a parseable `{ query, model, answer, error }`
  object on stdout (any partial answer; `answer` is `""` since
  `run()` throws before output is assigned), exit 1.
- non-`--json` → the `\n(error: …)\n` stderr line, exit 1 —
  consistent with (and no worse than) the prior uncaught-throw
  behaviour.

Both `muse ask` paths now share one error contract. The
success path is untouched (the `try` wraps only the run+assign;
on success it falls through to the existing tools-used / JSON
payload blocks exactly as before). One short WHY comment
mirrors the chat-only path's.

## Verify

- `commands-ask.test.ts` — +1 case: `renderAskStreamError`
  with `answer: ""` (the agent-path input — `run()` throws
  before any output) in `--json` mode is still a parseable
  object with `answer === ""` and the error preserved. (The
  json/non-json contract itself is already pinned by the goal
  352 tests this reuses.)
- `pnpm --filter @muse/cli test` — 604 pass (+1). `pnpm check`
  — every workspace green (apps/cli 605 incl. the test/ glob,
  apps/api 161, all packages). `pnpm lint` — exit 0. The
  goal-227 enforcement test (328) stays green.
- No real-LLM request/response path touched — the `try` only
  adds error routing; the agent `run()` success flow is
  byte-identical. The deterministic helper test is the rigorous
  verification.

## Status

done — `muse ask --with-tools --json` now emits the same
parseable `{ query, model, answer, error }` object on an agent
failure as the chat-only path, instead of empty stdout from an
uncaught throw. The `muse ask` `--json` error contract is now
consistent across both execution paths; the goal-352 follow-up
is closed.
