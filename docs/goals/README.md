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
| 005 | [Models.json file-mode 0600](005-models-json-file-mode.md)                        | security/robustness  | done   |
| 006 | [Auth JWT-rotation surface](006-auth-jwt-rotation.md)                             | security/robustness  | done   |
| 007 | [personal-providers.ts decomp](007-personal-providers-decomp.md)                  | big-file decomp      | partial |
| 008 | [autoconfigure/index.ts sub-builder extraction](008-autoconfigure-decomp.md)      | big-file decomp      | deferred |
| 009 | [agent-runtime.ts method-cluster extraction](009-agent-runtime-decomp.md)         | big-file decomp      | deferred |
| 010 | [chat-repl.ts seam decomp](010-chat-repl-decomp.md)                               | big-file decomp      | deferred |
| 011 | [commands-proactive.ts subcommand split](011-commands-proactive-decomp.md)        | big-file decomp      | deferred |
| 012 | [`muse open <id-prefix>`](012-muse-open-id-prefix.md)                             | JARVIS feature       | done   |
| 013 | [`muse summarize today`](013-muse-summarize-today.md)                             | JARVIS feature       | deferred |
| 014 | [`GET /api/history` REST endpoint](014-rest-history-endpoint.md)                  | JARVIS feature       | done   |
| 015 | [Web UI history panel](015-web-history-panel.md)                                  | JARVIS feature       | deferred |
| 016 | [`muse search --to-notes <path>`](016-muse-search-to-notes.md)                    | JARVIS feature       | done   |
| 017 | [`muse search --site <domain>`](017-muse-search-site-filter.md)                   | JARVIS feature       | done   |
| 018 | [`muse ask --notes-only`](018-muse-ask-notes-only.md)                             | JARVIS feature       | deferred |
| 019 | [`muse remember --json`](019-muse-remember-json.md)                               | JARVIS feature       | done   |
| 020 | [`muse status --watch`](020-muse-status-watch.md)                                 | JARVIS feature       | deferred |
| 021 | [`muse calendar tomorrow` / `this-week`](021-muse-calendar-quicksubs.md)          | JARVIS feature       | done   |
| 022 | [`muse history --kind X` empty hint](022-history-empty-kind-hint.md)              | UX polish            | done   |
| 023 | [`muse search` 429 / rate-limit hint](023-search-rate-limit-hint.md)              | UX polish            | done   |
| 024 | [`muse status` --compact / --verbose toggles](024-status-compact-verbose.md)      | UX polish            | deferred |
| 025 | [`muse today` pattern-detector suggestions](025-today-pattern-suggestions.md)     | UX polish            | deferred |
| 026 | [Followup dedupe — same-summary same-minute](026-followup-dedupe.md)              | reliability          | deferred |
| 027 | [Proactive circuit-breaker — notices/hour cap](027-proactive-circuit-breaker.md)  | reliability          | deferred |
| 028 | [Pattern detector LLM-judge mode](028-pattern-llm-judge.md)                       | reliability          | deferred |
| 029 | [User-memory diff broadcaster](029-user-memory-diff-broadcaster.md)               | reliability          | deferred |
| 030 | [`muse doctor` overall health summary + exit code](030-doctor-summary-exit.md)    | UX polish            | done   |
| 031 | [Rate-limit POST /api/chat per-IP](031-rate-limit-api-chat.md)                    | security/robustness  | done   |
| 032 | [MCP allowlist validation](032-mcp-allowlist-validate.md)                          | security/robustness  | done   |
| 033 | [Expand prompt-injection input guard library](033-prompt-injection-pattern-library.md) | security/robustness | done   |
| 034 | [REPL long-session memory audit](034-repl-memory-leak-audit.md)                    | security/robustness  | done   |
| 035 | [Audit every ~/.muse JSON store file-mode](035-audit-store-file-modes.md)          | security/robustness  | done   |
| 036 | [Final env-only-probe sweep](036-env-only-probe-final-sweep.md)                    | security/robustness  | done   |
| 037 | [Cache-Control: no-store on /api/admin/*](037-admin-cache-control-no-store.md)     | security/robustness  | done   |
| 038 | [Followup write durability + recovery](038-followup-write-durability.md)           | security/robustness  | done   |
| 039 | [Webhook signature validation (LINE / Slack)](039-webhook-signature-validation.md) | security/robustness  | done   |
| 040 | [CORS allowlist instead of wildcard](040-cors-allowlist-not-wildcard.md)           | security/robustness  | done   |
| 041 | [Extract buildCalendarRegistry](041-personal-providers-calendar-decomp.md)         | big-file decomp      | done   |
| 042 | [Extract buildVoiceRegistry](042-personal-providers-voice-decomp.md)               | big-file decomp      | done   |
| 043 | [Extract buildNotesRegistry](043-personal-providers-notes-decomp.md)               | big-file decomp      | done   |
| 044 | [Extract buildTasksRegistry](044-personal-providers-tasks-decomp.md)               | big-file decomp      | done   |
| 045 | [server.ts ServerOptions type cleanup](045-server-options-type-cleanup.md)         | big-file decomp      | done   |
| 046 | [`muse status --watch`](046-muse-status-watch.md)                                  | JARVIS feature       | done   |
| 047 | [`muse ask --notes-only`](047-muse-ask-notes-only.md)                              | JARVIS feature       | done   |
| 048 | [`muse export` (backup tarball)](048-muse-export.md)                               | JARVIS feature       | done   |
| 049 | [`muse import <tar>` (restore)](049-muse-import.md)                                | JARVIS feature       | done   |
| 050 | [`muse history --grep <pattern>`](050-muse-history-grep.md)                        | JARVIS feature       | done   |
| 051 | [`muse memory diff [<since>]`](051-muse-memory-diff.md)                            | JARVIS feature       | done   |
| 052 | [`muse session lock --hours N`](052-muse-session-lock.md)                          | JARVIS feature       | done   |
| 053 | [`muse trust list --by-domain`](053-muse-trust-by-domain.md)                       | JARVIS feature       | done   |
| 054 | [`muse today --summarize`](054-muse-summarize-today.md)                            | JARVIS feature       | done   |
| 055 | [`muse search --time today\|week\|month`](055-muse-search-time-range.md)          | JARVIS feature       | done   |
| 056 | [`muse open <id> --raw`](056-muse-open-raw.md)                                     | JARVIS feature       | done   |
| 057 | [`muse runs delete <run-id>`](057-muse-runs-delete.md)                             | JARVIS feature       | done   |
| 058 | [`muse notes search --mode llm-judge` polish](058-muse-notes-search-llm-judge-polish.md) | JARVIS feature | done |
| 059 | [`muse calendar import <file.ics>`](059-muse-calendar-import-ics.md)               | JARVIS feature       | done   |
| 060 | [Top-level muse with no args prints help](060-muse-help-on-empty.md)               | UX polish            | done   |
| 061 | [`muse today` colorize output (TTY-aware)](061-today-colorize.md)                  | UX polish            | done   |
| 062 | [`muse history` relative time format](062-history-relative-time.md)                | UX polish            | done   |
| 063 | [`muse history` icon-per-kind](063-history-icon-per-kind.md)                       | UX polish            | done   |
| 064 | [`muse status` JSON schemaVersion](064-status-schema-version.md)                   | UX polish            | done   |
| 065 | [`muse search` backend latency in output](065-search-backend-latency.md)           | UX polish            | done   |
| 066 | [zsh + bash completions](066-zsh-completions.md)                                   | UX polish            | done   |
| 067 | [Ctrl-C handling in long-running commands](067-ctrl-c-friendly.md)                 | UX polish            | done   |
| 068 | [`muse doctor --watch` (TUI)](068-doctor-watch-mode.md)                            | UX polish            | done   |
| 069 | [Reminder firing idempotency on restart](069-reminder-firing-idempotent.md)        | reliability          | done   |
| 070 | [Proactive notice retry on transient fail](070-proactive-retry-on-transient-failure.md) | reliability    | done   |
| 071 | [Calendar fallback to local on remote fail](071-calendar-fallback-on-remote-fail.md) | reliability        | done   |
| 072 | [Episode capture on SIGTERM](072-episode-capture-on-sigterm.md)                    | reliability          | done   |
| 073 | [User-memory auto-extract throttle](073-user-memory-extract-throttle.md)           | reliability          | done   |
| 074 | [Notes index rebuild on schema bump](074-notes-index-schema-bump-rebuild.md)       | reliability          | done   |
| 075 | [MCP reconnect backoff progress](075-mcp-reconnect-backoff-progress.md)            | reliability          | done   |
| 076 | [`muse trace tail` — live-tail spans](076-muse-trace-tail.md)                      | observability        | done   |
| 077 | [`muse metrics show` (SLO + drift)](077-muse-metrics-show.md)                      | observability        | done   |
| 078 | [`muse status` today's token-cost rollup](078-status-token-cost-rollup.md)         | observability        | done   |
| 079 | [proactive-history.json rotation on size](079-proactive-history-rotation.md)       | observability        | done   |
| 080 | [Activity log compaction](080-activity-log-compaction.md)                          | observability        | done   |
| 081 | [`muse export --encrypt`](081-muse-export-encrypt.md)                              | security/robustness  | done   |
| 082 | [`muse auth rotate-jwt`](082-muse-auth-rotate-jwt.md)                              | security/robustness  | done   |
| 083 | [MCP server fingerprint pinning](083-mcp-server-fingerprint-pinning.md)            | security/robustness  | done   |
| 084 | [Chat rate limiter per-user keying](084-rate-limit-per-user.md)                    | security/robustness  | done   |
| 085 | [Prompt injection detection telemetry](085-injection-detection-telemetry.md)       | security/robustness  | done   |
| 086 | [Proactive notice secret redaction](086-proactive-notice-secret-redaction.md)      | security/robustness  | done   |
| 087 | [`muse vision <image>` via Ollama](087-muse-vision-ollama.md)                      | JARVIS feature       | done   |
| 088 | [`muse read <pdf>` document understanding](088-muse-read-pdf.md)                   | JARVIS feature       | done   |
| 089 | [`muse glance` active-window awareness](089-muse-glance-active-window.md)          | JARVIS feature       | done   |
| 090 | [Episode semantic index](090-episode-semantic-index.md)                            | JARVIS feature       | done   |
| 091 | [`muse recall <query>` cross-store](091-muse-recall-cross-store.md)                | JARVIS feature       | done   |
| 092 | [`muse feeds` RSS/Atom ingest](092-muse-feeds-rss.md)                              | JARVIS feature       | done   |
| 093 | [Linux libnotify provider](093-linux-libnotify-provider.md)                        | JARVIS feature       | done   |
| 094 | [`muse persona` templates](094-muse-persona-templates.md)                          | JARVIS feature       | open   |
| 095 | [`muse status --suggestions`](095-muse-status-suggestions.md)                      | JARVIS feature       | open   |
| 096 | [`muse show <image>` terminal render](096-muse-show-terminal-image.md)             | JARVIS feature       | open   |

Categories:

- **security/robustness** — bug fix, hardening, defense-in-depth
- **big-file decomp** — mechanical move, >700 LOC files toward leaf modules
- **JARVIS feature** — new user-facing surface or workflow
- **UX polish** — empty-state hints, formatting toggles, clearer errors
- **reliability** — auto-behavior correctness, throttling, deduping
- **observability** — surfaces over runs / metrics / cost / traces
