# Goals

Trackable, prioritized work items for Muse. Each goal lives in its own
`NNN-slug.md` with the same shape: `## Why`, `## Scope`, `## Verify`,
`## Status`. One commit per goal — finish the work, flip the status to
`done`, link the commit hash, move on.

The bar for "in this list" is: concrete, scoped, single-iter,
verifiable. Open-ended ideas don't count — they live in `docs/design/`.

## Workflow

1. Pick the lowest open `NNN` from the table below.
2. Read its md.
3. Execute → tests → lint → smoke (broad + live if a key is set).
4. Commit. Update the goal's `## Status` to `done — <commit-hash>`.
5. Update the table's status column here.

## Priority order

| #   | Goal                                                                              | Category             | Status |
| --- | --------------------------------------------------------------------------------- | -------------------- | ------ |
| 001 | [API default port conflict](001-api-default-port.md)                              | security/robustness  | done   |
| 002 | [Verify error-body cap on non-HTML responses](002-error-body-cap-non-html.md)     | security/robustness  | done   |
| 003 | [SSE stream control-byte strip](003-sse-control-byte-strip.md)                    | security/robustness  | done   |
| 004 | [Tool-loop timeout + max-iterations audit](004-tool-loop-timeout-audit.md)        | security/robustness  | done   |
| 005 | [Models.json file-mode 0600](005-models-json-file-mode.md)                        | security/robustness  | open   |
| 006 | [Auth JWT-rotation surface](006-auth-jwt-rotation.md)                             | security/robustness  | open   |
| 007 | [personal-providers.ts decomp](007-personal-providers-decomp.md)                  | big-file decomp      | open   |
| 008 | [autoconfigure/index.ts sub-builder extraction](008-autoconfigure-decomp.md)      | big-file decomp      | open   |
| 009 | [agent-runtime.ts method-cluster extraction](009-agent-runtime-decomp.md)         | big-file decomp      | open   |
| 010 | [chat-repl.ts seam decomp](010-chat-repl-decomp.md)                               | big-file decomp      | open   |
| 011 | [commands-proactive.ts subcommand split](011-commands-proactive-decomp.md)        | big-file decomp      | open   |
| 012 | [`muse open <id-prefix>`](012-muse-open-id-prefix.md)                             | JARVIS feature       | open   |
| 013 | [`muse summarize today`](013-muse-summarize-today.md)                             | JARVIS feature       | open   |
| 014 | [`GET /api/history` REST endpoint](014-rest-history-endpoint.md)                  | JARVIS feature       | open   |
| 015 | [Web UI history panel](015-web-history-panel.md)                                  | JARVIS feature       | open   |
| 016 | [`muse search --to-notes <path>`](016-muse-search-to-notes.md)                    | JARVIS feature       | open   |
| 017 | [`muse search --site <domain>`](017-muse-search-site-filter.md)                   | JARVIS feature       | open   |
| 018 | [`muse ask --notes-only`](018-muse-ask-notes-only.md)                             | JARVIS feature       | open   |
| 019 | [`muse remember --json`](019-muse-remember-json.md)                               | JARVIS feature       | open   |
| 020 | [`muse status --watch`](020-muse-status-watch.md)                                 | JARVIS feature       | open   |
| 021 | [`muse calendar tomorrow` / `this-week`](021-muse-calendar-quicksubs.md)          | JARVIS feature       | open   |
| 022 | [`muse history --kind X` empty hint](022-history-empty-kind-hint.md)              | UX polish            | open   |
| 023 | [`muse search` 429 / rate-limit hint](023-search-rate-limit-hint.md)              | UX polish            | open   |
| 024 | [`muse status` --compact / --verbose toggles](024-status-compact-verbose.md)      | UX polish            | open   |
| 025 | [`muse today` pattern-detector suggestions](025-today-pattern-suggestions.md)     | UX polish            | open   |
| 026 | [Followup dedupe — same-summary same-minute](026-followup-dedupe.md)              | reliability          | open   |
| 027 | [Proactive circuit-breaker — notices/hour cap](027-proactive-circuit-breaker.md)  | reliability          | open   |
| 028 | [Pattern detector LLM-judge mode](028-pattern-llm-judge.md)                       | reliability          | open   |
| 029 | [User-memory diff broadcaster](029-user-memory-diff-broadcaster.md)               | reliability          | open   |
| 030 | [`muse doctor` overall health summary + exit code](030-doctor-summary-exit.md)    | UX polish            | open   |

Categories:

- **security/robustness** — bug fix, hardening, defense-in-depth
- **big-file decomp** — mechanical move, >700 LOC files toward leaf modules
- **JARVIS feature** — new user-facing surface or workflow
- **UX polish** — empty-state hints, formatting toggles, clearer errors
- **reliability** — auto-behavior correctness, throttling, deduping
