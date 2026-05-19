# Goals

The self-driving backlog for the autonomous iteration loop.

The loop **never stops, never asks a human for work, never
completes**. It fires every ~20 min, ships one commit, repeats
forever. The loop sets its own outward direction.

Read these every iteration, in order:

1. **[`.claude/rules/iteration-loop.md`](../../.claude/rules/iteration-loop.md)**
   — the authoritative contract (5 rules up top).
2. **[`OUTWARD-TARGETS.md`](OUTWARD-TARGETS.md)** — the loop's
   self-directed north star + target map (loop owns/evolves the
   *direction*; honesty machinery is immutable).
3. **[`CAPABILITIES.md`](CAPABILITIES.md)** — the only success
   metric (append-only; every goal adds one green automated check).
4. `MEMORY.md`.

This file is just the backlog table + ledger. The definitions,
procedure, falsification rule, regression sweep, and immutable core
live in the contract — don't restate them here.

## Backlog (append/flip-only)

Add ≤1 row, flip status of goals you touched; never reorder, never
delete an open row, never rewrite another goal's status.

| #   | Goal                                                                    | Category       | Status           |
| --- | ----------------------------------------------------------------------- | -------------- | ---------------- |
| 373 | [Proactive multi-device routing](373-proactive-multi-device-routing.md) | epic / outward | done             |
| 374 | [`muse ask --notes-only`](374-muse-ask-notes-only.md)                   | outward        | done (pre-built) |
| 375 | [Web UI history panel](375-web-history-panel.md)                        | epic / outward | done             |
| 377 | [Inbound conversational replies](377-inbound-conversational-replies.md)  | epic / outward | done — P1 fully delivered (b1–b4) |
| 378 | [Knows-you from real use](378-knows-you-from-real-use.md)                | epic / outward | done — P0 fully delivered (b1–b4) |
| 380 | [Proactive delivery on a real channel](380-proactive-real-channel.md)     | epic / outward | done — P2 fully delivered (b1–b2) |
| 382 | [Ambient perception loop](382-ambient-perception.md)                     | epic / outward | done — P3-b1 delivered (live-wired) |
| 384 | [Calendar WRITE contract check](384-calendar-write-contract.md)           | epic / outward | done — P4 fully delivered (b1–b2) |
| 386 | [Durable standing objectives](386-durable-standing-objectives.md)         | epic / outward | done — P5 fully delivered (b1–b3) |
| 388 | [Reviewable action log](388-reviewable-action-log.md)                     | epic / outward | done — P6 fully delivered (b1–b2) |
| 390 | [Learns from correction](390-learns-from-correction.md)                   | epic / outward | done — P7 fully delivered (b1–b2) |
| 392 | [Proactive situational briefing](392-situational-briefing.md)             | epic / outward | done — P8 fully delivered (b1–b2) |
| 394 | [Delegated-autonomy loops run](394-autonomy-loops-run.md)                 | epic / outward | P9-b1 done; P9-b2 split (rider child done) |
| 395 | [Situational-briefing daemon rider](395-briefing-daemon-rider.md)         | epic / outward | P9-b2 child done (rider) |
| 396 | [Briefing daemon env-gated](396-briefing-daemon-env-gated.md)             | epic / outward | P9-b2 child done; objectives-daemon child next |
| 397 | [Objectives daemon + model evaluator](397-objectives-daemon-evaluator.md) | epic / outward | wiring done; [UNVERIFIED-LIVE] cleared by 398 |
| 398 | [Objectives evaluator live-verified](398-objectives-evaluator-live.md)     | epic / outward | done — [UNVERIFIED-LIVE] cleared; P9-b2 flipped |
| 400 | [Briefing grounded in real tasks](400-briefing-real-imminence.md)         | epic / outward | P8-b3 done (loop-extended bullet) |
| 401 | [Briefing grounded in calendar too](401-briefing-calendar-imminence.md)   | epic / outward | P8-b4 done (loop-extended bullet) |
| 402 | [P7 learn-from-correction wired into prod](402-veto-avoidance-prod-wiring.md) | epic / outward | done — deferred P7-b1 adapter resolved |
| 403 | [Objective verdict parse hardening](403-objective-verdict-parse-hardening.md) | fix / robustness | done — fenced/think-wrap silent mis-parse fixed |
| 404 | [`muse objectives` CLI entry point](404-objectives-cli.md)                | epic / outward | done — user can register/list/cancel objectives |
| 405 | [Objectives daemon actions are P6-accountable](405-objectives-actions-accountable.md) | epic / outward | done — daemon actions logged reviewably |
| 406 | [`muse actions` — read the accountability log](406-actions-cli.md)        | epic / outward | done — P6 log now user-readable from CLI |
| 407 | [Direct coverage for the security guard factories](407-guards-direct-coverage.md) | test / robustness | done — 6 fail-close guards now directly unit-tested |
| 408 | [P8 b3/b4 production-assembly seam audit](408-p8-b3b4-daemon-imminent-seam.md) | audit / robustness | done — the daemon's real task+calendar imminent-union is now guarded |
| 409 | [Fix Atom feed permalink selection](409-atom-feed-permalink-fix.md) | fix / robustness | done — `muse feeds` records the rel=alternate permalink, not the self/feed URL |
| 410 | [Close named-invisible-entity injection evasion](410-named-invisible-entity-evasion.md) | fix / security | done — `&ZeroWidthSpace;`/`&NoBreak;` no longer evade injection/PII/leakage guards |
| 411 | [Corrupt-store quarantine for the 2 history audit logs](411-history-store-corrupt-quarantine.md) | fix / data-safety | done — proactive/reminder history now quarantined like their 10 siblings, not destroyed |
| 412 | [CalDAV ICS line unfolding (RFC 5545)](412-caldav-ics-line-unfolding.md) | fix / robustness | done — folded SUMMARY/LOCATION/DESCRIPTION no longer truncated at octet 75 |
| 413 | [Cron macro validation consistency](413-cron-macro-validation-consistency.md) | fix / consistency | done — `@daily`/`@hourly`/… now accepted, matching computeNextRunAt |
| 414 | [Strict parseInteger env parsing](414-parseinteger-strict-env-parsing.md) | fix / safety | done — typo'd `MUSE_*=16k` falls back instead of silently becoming 16 |
| 415 | [OpenAI Responses tool-arg object guard](415-openai-responses-toolarg-object-guard.md) | fix / consistency | done — Responses path now `{}`-guards non-object args like the chat+Ollama paths |
| 416 | [Exemplar scoring keeps single-syllable Korean tokens](416-exemplar-korean-single-syllable-tokens.md) | fix / quality | done — Korean 1-syllable query nouns no longer dropped from few-shot scoring |
| 417 | [Bare Korean time phrase resolves to today](417-bare-korean-time-phrase.md) | fix / consistency | done — `오후 5시`/`정오`/`자정` resolve like `5pm`/`noon`, not error |
| 418 | [Episodes summary compares parsed instants](418-episodes-summary-instant-compare.md) | fix / consistency | done — `muse status` "last session" no longer wrong on mixed-precision/tz endedAt |
| 419 | [`muse remind` validates `<when>` before dispatch](419-remind-predispatch-when-validation.md) | fix / UX | done — remote mode fails fast with the actionable error, no doomed round-trip; +command test |
| 420 | [`muse tasks add` validates `--due` before dispatch](420-tasks-predispatch-due-validation.md) | fix / UX | done — 419 follow-up discharged; tasks/remind now consistent; +command test |
| 421 | [`clampOutboundText` never emits a lone surrogate](421-clamp-outbound-lone-surrogate.md) | fix / robustness | done — emoji at the truncation boundary no longer makes chat APIs drop the whole message |
| 422 | [Inbound reply handled only after send succeeds](422-inbound-handled-after-send.md) | fix / robustness | done — a transient send failure no longer silently loses Muse's reply forever |
| 423 | [Redact Telegram & Discord bot tokens](423-redact-telegram-discord-bot-tokens.md) | fix / security | done — Muse's own channel tokens no longer leak through the channel they control |
| 424 | [Direct coverage for the calendar credential store](424-calendar-credential-store-direct-coverage.md) | test / security | done — 0o600 + tolerant-read + prototype-safety now pinned (was untested) |
| 425 | [Local date/time flavors don't mangle the fallback](425-local-date-time-fallback-not-mangled.md) | fix / robustness | done — a bad timestamp shows whole, not chopped to "not-a-date"/"strin" |
| 426 | [Greeting-strip never empties a greeting-only reply](426-greeting-strip-no-empty-reply.md) | fix / UX | done — greeting Muse no longer yields total silence (was stripped to "") |
| 427 | [`MUSE_*` path overrides expand a leading `~`](427-resolver-leading-tilde-expansion.md) | fix / robustness | done — `MUSE_*_FILE=~/x` no longer writes state into a literal ./~/ dir |
| 428 | [Non-finite token cost can't poison the aggregate](428-token-cost-nan-guard.md) | fix / robustness | done — one NaN/Infinity cost no longer turns `muse cost` into NaN + scrambles order |
| 429 | [Tasks invalid-dueAt error code consistency](429-tasks-dueat-error-code-consistency.md) | fix / consistency | done — PATCH /api/tasks now returns INVALID_TASK_DUE_AT like POST, not BAD_DUE_AT |
| 430 | [Direct coverage for `uniqueCommandPrefix`](430-uniquecommandprefix-direct-coverage.md) | test / robustness | done — the typo-recovery prefix resolver now has direct unit coverage (was implicit-only) |
| 431 | [Whisper.cpp STT enforces advertised formats](431-whisper-enforce-supported-format.md) | fix / consistency | done — unsupported mime → actionable UNSUPPORTED_FORMAT, not a cryptic whisper exit |
| 432 | [OpenAI Whisper STT enforces advertised formats](432-openai-whisper-enforce-supported-format.md) | fix / consistency | done — 431 sibling discharged; both STT adapters now uniform |
| 433 | [Auto-extract dedupes veto/goal slots by id](433-auto-extract-slot-dedup.md) | fix / persona-safety | done — a re-emitted veto no longer eats the cap & drops a distinct one |
| 434 | [Context-reference store eviction coverage](434-context-reference-store-eviction-coverage.md) | test / safety | done — TTL + oldest-first cap eviction now directly pinned (was implicit-only) |
| 435 | [LINE webhook malformed-signature → clean-401 coverage](435-line-webhook-malformed-signature-coverage.md) | test / security | done — forged wrong-length sig now pinned to 401 (was the implicit DoS-guard) |
| 436 | [Non-finite tool-loop limit can't disable the bound](436-runtime-limit-nan-guard.md) | fix / safety | done — NaN maxToolCalls/wallclock now falls back to default, not a disabled CLAUDE.md non-negotiable |
| 437 | [Non-finite rate-limiter option can't self-DoS /api/chat](437-rate-limiter-nan-guard.md) | fix / safety | done — 436 sibling; NaN/Infinity capacity → safe default, not deny-all/unbounded |
| 438 | [Pin time_add bad-base / non-numeric-offset robustness](438-time-add-robustness-coverage.md) | test / robustness | done — stringified/NaN tool args can't crash the agent's +Nh time math (was implicit) |
| 439 | [Pin math_eval no-eval sandbox rejection branches](439-math-eval-sandbox-rejection-coverage.md) | test / security | done — trailing-chars keystone + unbalanced-parens + modulo-by-zero + 256-char off-by-one + non-string required guard (was implicit; mutation-proven) |
| 440 | [Reject impossible calendar due-dates instead of silent rollover](440-due-date-impossible-calendar-reject.md) | fix / robustness | done — `2026-02-30` no longer silently scheduled as Mar 2; tasks+reminders share the keystone fix (probe-demonstrated) |
| 441 | [computeNextRunAt fails closed on blank/corrupt cron](441-scheduler-compute-next-run-fail-closed.md) | fix / safety | done — blank persisted cron no longer silently fires every minute; compute chokepoint re-asserts validate (336/337 sibling, probe-demonstrated) |
| 442 | [Pin full Telegram MarkdownV2 reserved-char escaping contract](442-telegram-markdownv2-full-reserved-char-coverage.md) | test / delivery | done — all 18 reserved chars + over-escape + HTML ordering pinned (was 5/18; mutation-proven; silent-400 regression class) |
| 443 | [Non-finite token count can't poison the token-volume ranking](443-token-cost-nonfinite-token-guard.md) | fix / safety | done — 428 sibling; finiteTokens guards the totalTokens sort key that is primary under Qwen-only/$0 (mutation-proven) |
| 444 | [Float env-parsers reject lenient-garbage like parseInteger](444-env-float-parsers-strict.md) | fix / robustness | done — 414 sibling; `0.5x`/`60s`/`0x` float MUSE_* now → fallback not silent-truncate; +first direct coverage (mutation-proven) |
| 445 | [Reminders/tasks accept decimal relative durations](445-relative-time-decimal-durations.md) | feat / UX | done — "in 1.5 hours" / "in 2.5 days" now resolve (was ERROR); deferred-ledger decimal half delivered (mutation-proven) |
| 446 | [ToolCallDeduplicator bounds its result cache](446-tool-call-deduplicator-bounded.md) | fix / safety | done — 434 sibling; per-run dedup cache now oldest-first bounded (was unbounded; runaway tool loop memory; mutation-proven) |
| 447 | [Re-mentioned recent topic keeps its freshest position](447-persona-recent-topics-freshest-dedupe.md) | fix / UX | done — persona continuity: a topic the user just resumed no longer dropped by first-occurrence dedupe + slice(-5) (425/433 class, mutation-proven) |
| 448 | [Failing no-body-stream fallback yields an error event](448-openai-compat-stream-fallback-error-event.md) | fix / robustness | done — OpenAICompatibleProvider.stream's 3rd error path no longer throws out of the generator (415/432 contract-consistency; smoke:live-verified) |
| 449 | [Retryable upstream failure → HTTP 503, not flat 500](449-api-retryable-upstream-503.md) | fix / robustness | done — 448 HTTP-boundary sibling; transient ModelProviderError now 503 UPSTREAM_UNAVAILABLE so clients can back off (mutation-proven) |
| 450 | [Piper runner survives a child that closes stdin early](450-piper-runner-stdin-epipe-guard.md) | fix / safety | done — unhandled stdin EPIPE (bad model / crash) no longer takes down the whole process; clean SPAWN/EXIT rejection (mutation-proven) |
| 451 | [truncateErrorBody never leaves a lone surrogate at the cut](451-truncate-error-body-surrogate-guard.md) | fix / robustness | done — 421 sibling; split-astral error body no longer emits invalid UTF-8 into API bodies / chat forwards (mutation-proven) |
| 452 | [Reminders/tasks accept two-unit compound durations](452-relative-time-two-unit-compound.md) | feat / UX | done — "in 2 hours 30 minutes" / "in 1 day 6 hours" now resolve; fully discharges the 445 deferred compound/decimal discovery (mutation-proven) |
| 453 | [Corrupt persisted timestamp can't 500 the debug-replay list](453-debug-replay-datevalue-invalid-guard.md) | fix / robustness | done — 418/440 class; dateValue Invalid Date no longer RangeErrors GET /api/admin/debug/replay for every row (mutation-proven) |
| 454 | [CalDAV VEVENT parsing ignores a preceding VTIMEZONE DTSTART](454-caldav-vevent-vtimezone-isolation.md) | fix / correctness | done — every TZID-qualified CalDAV event was parsed with the 2007 DST-rule date; now scoped to the VEVENT body (mutation-proven) |
| 455 | [markdown_table escapes column NAMES, not just cells](455-markdown-table-header-escaping.md) | fix / consistency | done — 415/432 class; a `|`/newline column key no longer breaks the table header (advertised-but-unenforced escaping; mutation-proven) |
| 456 | [Web api-client surfaces the server error message](456-web-api-client-surface-error-body.md) | fix / error-UX | done — 449 UI-consumer sibling; console shows server errorMessage not a bare/empty status; +first direct api-client test (mutation-proven) |
| 457 | [Empty keyword can't make an agent spec match every task](457-agent-spec-empty-keyword-no-match-all.md) | fix / correctness | done — 433/441/453 load-path-invariant class; `""` keyword no longer hijacks sub-agent routing at confidence 0.5 (mutation-proven) |
| 458 | [Direct coverage for the guard-pipeline fail-close/open contract](458-guard-pipeline-failclose-coverage.md) | test / security | done — 407 pipeline-layer sibling; fail-close-on-thrown-guard keystone pinned (was implicit-only; mutation-proven) |
| 459 | [Corrupt job.timezone can't crash scheduled-job rendering](459-scheduler-datevars-invalid-timezone-fallback.md) | fix / robustness | done — 441 load-path sibling; invalid persisted timezone → UTC fallback, not a RangeError that breaks dispatch (mutation-proven) |
| 460 | [Direct fail-closed coverage for the autonomous-action consent gate](460-consent-store-failclosed-coverage.md) | test / security | done — 458-class; hasConsent exact-scope/no-broaden + corrupt→false + malformed-filtered pinned (was zero direct coverage; mutation-proven) |
| 461 | [queryVetoes orders by parsed instant, not lexicographic ISO](461-veto-review-instant-order.md) | fix / correctness | done — 418 sibling; veto review surface no longer mis-orders across mixed-precision/offset timestamps (mutation-proven) |
| 462 | [Direct coverage for the derived-agent-metrics fan-out](462-derived-agent-metrics-fanout-coverage.md) | test / observability | done — 458-class; SLO/drift feed + inner-forward fan-out pinned (was zero direct coverage; mutation-proven) |
| 463 | [readWebSearchEnvSnapshot rejects a lenient-prefix MAX_USES typo](463-websearch-maxuses-strict-parse.md) | fix / robustness | done — 414/444 sibling; `MUSE_WEB_SEARCH_MAX_USES=5x` no longer shown as valid env-config on muse doctor (mutation-proven) |
| 464 | [queryActionLog orders by parsed instant, not lexicographic ISO](464-action-log-review-instant-order.md) | fix / correctness | done — 461/418 sibling (the named "Parallel to queryActionLog"); P6 accountability log no longer mis-orders newest action (mutation-proven) |
| 465 | [Corrupt firedAtMs can't crash the `muse pattern` fired list](465-pattern-fired-list-invalid-date-guard.md) | fix / robustness | done — 453/459 sibling; one Invalid-Date record no longer RangeErrors the whole listing → "(unknown time)" (mutation-proven) |
| 466 | [filterFresh instant-compare — cross-provider timestamp can't drop an inbound message](466-inbox-filterfresh-instant-compare.md) | fix / correctness | done — 461/464 functional sibling; mixed provider precision/offset no longer silently drops a genuinely-new inbound message (mutation-proven) |
| 467 | [parseIcsDateValue rejects an impossible calendar date instead of silent rollover](467-ics-parser-impossible-date-reject.md) | fix / correctness | done — 440 ICS-import sibling; a malformed `.ics` impossible date no longer imports a `muse calendar import` event on the wrong day/time (mutation-proven) |
| 468 | [chat-REPL slash typo gets a "did you mean" suggestion](468-chat-repl-slash-did-you-mean.md) | feat / cli-ergonomics | done — REPL parity with the top-level CLI's fuzzy hint; reuses the tested `closestCommandName`; no-match output byte-identical (mutation-proven; first direct `handleSlashCommand` coverage) |
| 469 | [decideWebSearchPolicy strict-parses MAX_USES at runtime](469-websearch-policy-runtime-strict-maxuses.md) | fix / correctness | done — goal-463 runtime sibling; a typo'd `MUSE_WEB_SEARCH_MAX_USES=3x` flagged invalid by `muse doctor` is no longer silently honoured (as 3) by the runtime (mutation-proven) |
| 470 | [muse auth rotate-jwt --grace-hours strict-parses its value](470-auth-grace-hours-strict-parse.md) | fix / safety | done — 414/444/463/469 sibling on a safety flag; `--grace-hours 2d`/`24x` no longer slips past the existing guard as its numeric prefix → no unintended JWT-secret grace window (mutation-proven; first direct `commands-auth` coverage) |
| 471 | [muse feeds decodes HTML entities in RSS/Atom titles](471-feeds-html-entity-decoding.md) | fix / UX | done — `htmlEntities:true` on the feed parser; `&rsquo;`/`&#8217;`/`&mdash;`/`&hellip;` no longer shown literally in `muse feeds`; terminal-safety boundary preserved (mutation-proven) |
| 472 | [voice registry unknown-id error names the registered providers](472-voice-registry-unknown-id-hint.md) | fix / error-UX | done — `requireStt/requireTts` now append `(registered: …)`/`(none registered)` so a typo'd voice providerId via the API is recoverable; error code unchanged (mutation-proven) |
| 473 | [messaging registry unknown-id error names the registered providers](473-messaging-registry-unknown-id-hint.md) | fix / error-UX | done — goal-472 sibling slice; `MessagingProviderRegistry.require` now hints, so a misconfigured proactive/reminder/objectives/inbound daemon is recoverable; identical wording to 472; code unchanged (mutation-proven) |
| 474 | [calendar registry unknown-id error names the registered providers](474-calendar-registry-unknown-id-hint.md) | fix / error-UX | done — goal-472/473 sibling slice; `CalendarProviderRegistry.require` now hints, so a misconfigured briefing-daemon / `/api/calendar/*` providerId is recoverable; identical wording to 472/473; code unchanged (mutation-proven) |
| 475 | [tasks-providers registry unknown-id error names the registered providers](475-tasks-providers-registry-unknown-id-hint.md) | fix / error-UX | done — goal-472/473/474 sibling slice; `TasksProviderRegistry.require` now hints, recoverable across briefing imminence (P8-b3) / accountability log (P6-b1) / `muse tasks`; identical wording; code unchanged (mutation-proven) |
| 476 | [notes-providers registry unknown-id error names the registered providers](476-notes-providers-registry-unknown-id-hint.md) | fix / error-UX | done — fully discharges the goal-472 sibling slice (5/5); `NotesProviderRegistry.require` now hints, recoverable across `muse recall`/`muse notes`/RAG; identical wording; code unchanged (mutation-proven) |
| 477 | [direct coverage for resolveOllamaUrl](477-ollama-url-direct-coverage.md) | test / wire-path | done — 458/460/462 class; the entry point every Ollama embedding/generation call funnels through (ask/notes-rag/vision/doctor) now has direct default/env/whitespace/trailing-slash coverage (mutation-proven; src byte-identical) |
| 478 | [mergeModelKeysFromFile no longer lets an empty env shadow models.json](478-mergemodelkeysfromfile-empty-env-no-shadow.md) | fix / correctness | done — discovered in 477; `export OLLAMA_BASE_URL=` no longer silently destroys the user's `muse setup model` configuration (file value restored when env is empty/whitespace-only); env-wins precedence unchanged for non-empty values (mutation-proven) |
| 479 | [direct coverage for StepBudgetTracker](479-step-budget-direct-coverage.md) | test / safety | done — 458/460/462/477 class; the agent-run token budget gate (ok/soft_limit/exhausted on every step) now has ctor/input-guard/exact-boundary/accessor coverage; soft-limit boundary mutation-proven (src byte-identical) |
| 480 | [direct coverage for ToolCallDeduplicator + stableJson](480-tool-call-deduplicator-direct-coverage.md) | test / correctness | done — 458/460/462/477/479 class; agent loop's tool-call dedup memoizer (canonicalization / decision / completed-only memoization / FIFO eviction) now covered; `.sort()` central clause mutation-proven end-to-end (src byte-identical) |
| 481 | [createOllamaEmbedder no longer hits a relative URL on empty OLLAMA_BASE_URL=](481-ollama-embedder-empty-env-no-shadow.md) | fix / correctness | done — goal-478 sibling found by systematic grep; `??` kept "" so episodic-recall's embedder fetched `/api/embeddings` (relative → throws → silent Jaccard downgrade); now treats empty/whitespace as unset, mirroring 478 byte-for-byte (mutation-proven via stubbed-fetch integration) |
| …   | *self-generated outward via discovery — never ends*                     |                |                  |

Closed infra (not loop work): 376 progress dashboard + tunnel —
human-operated; see its md.

## Rejected ledger (so fresh agents don't re-mine)

Append one line when a discovery path is evaluated and deferred:
`- <area> — iter <hash> — deferred: <reason>`

- sibling-registry unknown-id dead-end errors — iter 472 — fully
  discharged by 476: every sibling registry (`@muse/voice`
  472, `@muse/messaging` 473, `@muse/calendar` 474, `@muse/mcp`
  tasks-providers 475, `@muse/mcp` notes-providers 476) now
  appends `registeredHint` and is mutation-proven. No remaining
  package carries the hint-less dead-end; entry closed.
- smoke:live picker model speed — iter a147d939 — deferred: owner's
  Ollama-only picker fix confirmed working (real `/api/chat`
  round-trips, HTTP 200, ~50-60s each); it prefers the largest
  local qwen (`qwen3.6:35b-a3b`) so a full 6-endpoint run exceeds a
  5-min wrapper. Future outward (Autonomy: faster loop
  self-verification): prefer a fast small qwen (e.g. `qwen3:8b`)
  for smoke:live, or shard endpoints. Not slice-3 scope.
- web Playwright e2e infra — iter (375 s3) — deferred: no
  playwright.config / e2e harness exists in `apps/web` (only the
  dev-dep). Standing up config + browser install + seeded-API
  harness is its own infra task; the right-sized verified check for
  375 s3 was the `App.test.tsx` MuseConsole render assertion. A
  future outward goal can build the e2e harness if a real failure
  motivates it.
- smoke:live local-Qwen nondeterminism — iter (377 s2) — observed,
  not a regression: smoke:live ran real round-trips (owner picker
  fix works) 10 pass / 3 fail. The 3 (chat strict tool-loop didn't
  emit `time_now`; native web_search 0 citations / "no web tool";
  notes.search picked a different note) are small-local-model
  behaviour on endpoints goal-377 does NOT touch (the inbound
  daemon is off without `MUSE_INBOUND_REPLY_ENABLED`); the agent
  path P1-b2 depends on PASSED live (`/api/chat — direct answer`,
  `plan_execute (live)`). A future Autonomy goal: make these three
  CAPABILITIES checks robust to local-model variance (prompt
  hardening / model-capability gating), or tag them
  `[UNVERIFIED-LIVE]`. Not 377-scope.
- P1 audit — apps/api/test/p1-seam.test.ts — PASS: P1's four
  CAPABILITIES checks pass together AND compose end-to-end —
  `startInboundReplyTick` → `respondToInbound` →
  `createThreadedInboundRunner` → channel approval gate → real
  `TelegramProvider` HTTP, with the turn-1 user+reply carried into
  the turn-2 agent run (thread continuity through the tick path)
  and a write/execute tool blocked with an in-chat approval prompt
  POSTed to the same chat. No drift; no bullet reopened. P1
  (two-way conversation on a real channel) is genuinely delivered
  for the user, not just per-piece.
- P0-b2 production embedder wiring — iter (378 s2) — deferred: the
  embedding-recall provider + cosine + paraphrase proof shipped;
  remaining child is wiring a zero-cost local-Ollama embedder into
  `createMuseRuntimeAssembly` so production episodic recall uses
  `EmbeddingEpisodicRecallProvider`. Next 378 slice — kept separate
  from the provider so neither half is half-shipped.
  (RESOLVED 378 s3: production embedder wired, fail-open; P0-b2
  parent flipped.)
- P0-b3 production investigator wiring — iter (378 s4) — deferred:
  the investigate-and-surface mechanism (proactive loop accepts an
  injected investigator, appends the finding to the unasked notice,
  fail-open) shipped + integration-verified; remaining child is a
  real production investigator (a notes/tool lookup keyed off the
  imminent item) wired into the daemon's assembly. Next 378 slice —
  kept separate so neither half is half-shipped.
  (RESOLVED 378 s5: createNotesInvestigator over the primary notes
  provider wired into tick-daemons; P0-b3 parent flipped.)
- clampPositive lenient-parseInt vs strict parseInteger — iter 464
  — deferred (NOT a bug): `provider-utils.clampPositive` ("every
  MUSE_*_LIMIT/CAPACITY/TOPK knob") uses lenient `Number.parseInt`
  ("5x"→5) while the sibling `env-parsers.parseInteger` (414/444)
  is strict. Looks like a 463-class sibling, BUT
  `provider-utils.test.ts` explicitly pins the leniency
  ("lenient prefix parse", "pins behaviour vs a future Number()
  refactor") — a deliberate human design decision. Not changed:
  the loop must not override a deliberate tested choice
  (no-manufacturing). Revisit only on an explicit human call to
  unify the two env-int parsers.
- KyselyLatencyQuery vs InMemory divergence — iter 443 — deferred:
  in-memory `computeDurationMs` clamps negative durations to 0 and
  `matchesLatencyFilter` uses `startsWith`, but the Kysely SQL
  passes negative `ended_at - started_at` through and uses `LIKE`
  (metachars). Real sibling-asymmetry but Testcontainers/PG-gated
  to verify; not unit-provable here. Take when a PG harness runs.
- relative-time compound/decimal durations — iter 441 — deferred:
  `resolveRelativeTimePhrase` accepts "in half an hour" but rejects
  "in 1.5 hours" / "in 2 hours 30 minutes" (probe, iter 440). A
  genuine (b)-refinement of the existing grammar, not new surface;
  deferred this iter only to avoid same-area churn right after the
  440 due-date fix (Step-8). Next free non-time iteration may take it.
  (RESOLVED: 445 delivered decimal notation "in 1.5 hours" /
  "in 2.5 days"; 452 delivered two-unit compound
  "in 2 hours 30 minutes" / "in 1 day 6 hours". Discovery fully
  discharged — three-or-more-pair chains intentionally out of
  scope, not a dangling promise.)
- P0 audit — packages/agent-core/test/p0-seam.test.ts — PASS: P0's
  four CAPABILITIES checks pass together (agent-core 555 incl.
  auto-extract-tool-turn / episodic-recall-embedding /
  clarify-directive; `@muse/mcp` 375 incl. notes-investigator +
  proactive-loop) AND compose end-to-end through the real pipeline:
  a tool-turn fact stored under the run's userId (b1) is recalled
  on a LATER zero-token-overlap request via `applyUserMemory`
  wholesale injection (b2 — wording never gates it), `applyUserMemory`
  → `applyClarifyDirective` run in the live agent-runtime order so
  clarify stays silent on a well-specified request yet still steers
  an under-specified first turn to ask while the injected user
  memory remains present (b4 composes with knows-you, neither
  transform suppresses the other). b3 (proactive
  investigate-and-surface) re-run green on its own surface (the
  proactive daemon). No drift; no bullet reopened. P0 (knows-you ·
  anticipates · asks) is genuinely delivered end-to-end.
- P2 audit — apps/api/test/p2-seam.test.ts — PASS: P2's two
  CAPABILITIES checks pass together (`@muse/api`
  proactive-notice-delivery.test.ts — bare notice POST + real
  dedupe [b1]; prepped-doc POST [b2]) AND compose into one
  non-spammy real-channel flow: with a real `LocalDirNotesProvider`
  + `createNotesInvestigator` wired into `runDueProactiveNotices`
  over a real `TelegramProvider` HTTP, tick 1 POSTs the imminent
  announcement + the prepped "Related notes: …" doc (decoy
  excluded) to the real Bot API, and ticks 2 & 3 (item still
  imminent, investigate-appended body differs) produce ZERO
  re-POSTs — the real dedupe sidecar is item-derived not
  body-derived, so the composed flow honours the P2 "not noisy"
  quality bar. No drift; no bullet reopened. P2 (proactive
  delivery proven on a real channel) is genuinely delivered
  end-to-end.
- P3-b1 production wiring — iter (382) — deferred: the gated
  perception→run-context injection mechanism (`applyAmbientContext`
  + `resolveAmbientSnapshot`, fail-open, untrusted-field
  sanitised, opt-in only) shipped + unit/integration-verified in
  `@muse/agent-core`. Remaining: wire it into the live
  agent-runtime context pipeline behind an opt-in option AND a
  gated osascript-backed perception daemon, then flip P3-b1 with
  the mandated surface check (an ambient change measurably alters
  a subsequent agent answer — integration). Next 382 slice — kept
  separate so neither half is half-shipped (377 s1 / 378 s2,s4
  no-flip-mechanism precedent).
  (RESOLVED 382 s2: `applyAmbientContext` + `resolveAmbientSnapshot`
  wired into the live agent-runtime pipeline behind an opt-in
  `ambientSnapshotProvider`; ambient-context-runtime.test.ts proves
  an ambient change alters a subsequent answer; off by default.
  smoke:live ran a real Qwen round-trip = 9 pass / 4 fail, the
  pre-existing ledgered local-Qwen nondeterminism on endpoints
  this change provably does not touch — no `ambientSnapshotProvider`
  is wired in `apps/api`, so the gated-off path is byte-identical
  pre/post (apps/api 170 deterministic tests green via pnpm check);
  not a regression, not [UNVERIFIED-LIVE] (round-trip executed).
  P3-b1 flipped.)
- P3 audit — packages/agent-core/test/p3-seam.test.ts — PASS: P3's
  one CAPABILITIES check passes (`@muse/agent-core`
  ambient-context.test.ts + ambient-context-runtime.test.ts, 9/9)
  AND the target works as one end-to-end flow — the seam for a
  single-bullet target is ambient-vs-the-rest. p3-seam.test.ts
  drives the real `createAgentRuntime`: with ambient enabled
  alongside a user-memory provider, BOTH the `[Ambient Context]`
  and `[User Memory]` blocks reach the model (appendSystemSection
  merges, no clobber); a throwing ambient provider degrades the
  run (no ambient block) but never breaks it — fail-open proven
  through the real runtime, not just the unit resolver — with
  other context still intact; and with no provider there is no
  ambient block even when other context is active (privacy
  default-off survives composition). No drift; no bullet reopened.
  P3 (ambient perception loop) is genuinely delivered end-to-end.
  P0/P1/P2/P3 now all delivered + audited.
- P4 audit — packages/calendar/test/calendar-write-contract.test.ts
  + apps/cli/src/commands-listen.test.ts — PASS: P4's two
  CAPABILITIES checks re-run green together (calendar WRITE 8/8,
  voice round-trip 4/4) and each was scrutinised for "marked done
  but went sideways": P4-b1 instantiates the REAL Google / CalDAV /
  macOS providers with only the transport (fetchImpl / osascript
  spawn) faked and asserts the exact outbound request for
  create/move/cancel — not read-only, not a fake provider; P4-b2
  drives the REAL `registerListenCommand` via `parseAsync` with
  only the I/O boundaries faked and asserts every stage's data
  flowed (WAV→STT→/api/chat→TTS→played file) — full path, not a
  re-implemented pipeline. No seam test, unlike P0–P3: P4's two
  bullets are INDEPENDENT trust-closures (calendar-write trust;
  voice-round-trip trust), not a composed pipeline — a synthetic
  voice→calendar composition would need the full agent+tool+server
  stack and is an unnatural seam the bullets do not claim
  (gold-plating, which the contract bans). The faithful Step-4
  exercise for an independent-bullet target is the joint re-run +
  faithfulness scrutiny + the falsifiable-test check, all of which
  pass. No drift; no bullet reopened. P4 (close the trust-blocking
  PARTIALs) is genuinely delivered. P0/P1/P2/P3/P4 now all
  delivered + audited.
- P5 audit — packages/mcp/src/p5-seam.test.ts — PASS: P5's three
  CAPABILITIES checks re-run green together (objectives-store /
  objective-evaluation-loop / consented-action, 18/18). Unlike P4,
  P5's bullets ARE a composed delegation pipeline, so a seam test
  exercises the join end-to-end through the real on-disk stores
  with every read a fresh call (no shared in-memory = a restarted
  process / the next ~20-min tick): register a durable objective
  (b1) → restart → tick unmet → exponential backoff PERSISTED →
  restart (backoff survived) → tick met → the consented
  scoped-credential real (HTTP-faked) external action fires
  carrying the Bearer cred (b3) → restart → durably `done`; and
  the fail-closed consent gate composes with the lifecycle — no
  consent ⇒ no HTTP, the objective is NOT falsely completed and
  stays active across a restart. No drift; no bullet reopened. P5
  (durable delegated objectives / long-horizon agency) is
  genuinely delivered end-to-end. P0/P1/P2/P3/P4/P5 now all
  delivered + audited.
- P6 audit — packages/mcp/src/p6-seam.test.ts — PASS: P6's two
  CAPABILITIES checks re-run green together (action-log /
  undo-action, 9/9). Like P5, P6's bullets ARE a composed loop
  (see → undo → teach), so a seam test exercises the whole cycle
  through the real on-disk stores with every read a fresh call
  (= a restarted process): an autonomous consented action performs
  → is logged (b1) → the user reviews it → undo reverses + records
  a durable veto + logs the undo itself (b2 + b1) → "restart"
  (veto + log survive) → the same trigger recurs → the durable
  veto refuses it (no HTTP, objective not falsely completed) → the
  refusal is logged too → a final query returns the complete
  durable audit trail [refused, undo, performed] newest-first. No
  drift; no bullet reopened. P6 (accountability & correction loop)
  is genuinely delivered end-to-end. **P0–P6 now ALL delivered +
  audited** — the next iteration self-extends OUTWARD-TARGETS
  toward the north star (no human authors it).
- P7-b1 production adapter wiring — iter (390) — deferred: the
  `applyVetoAvoidance` transform is wired LIVE into the
  agent-runtime pipeline behind a duck-typed
  `VetoAvoidanceProvider` and flipped on the `createAgentRuntime`
  integration (the P3-b1 precedent). Remaining: the thin concrete
  adapter `@muse/mcp readVetoes → VetoAvoidanceProvider` wired
  into the apps/api server assembly so production runs read the
  real `~/.muse/vetoes.json`. Not required by P7-b1's stated
  integration check; a follow-up like P3-b1's real-osascript
  provider was to its flip.
  (RESOLVED 391: p7-seam.test.ts in apps/api exercises the real
  `readVetoes → VetoAvoidanceProvider` adapter through the real
  createAgentRuntime pipeline — the adapter shape is proven sound;
  only its server-assembly placement remains, a pure wiring line.)
  (FULLY RESOLVED 402: the wiring line shipped —
  `buildVetoAvoidanceProvider(env)` (autoconfigure
  context-engineering-builders, default-on, opt-out
  `MUSE_VETO_AVOIDANCE=false`, `resolveVetoesFile` →
  `~/.muse/vetoes.json`) is constructed and passed as
  `vetoAvoidanceProvider` into the production `createAgentRuntime`.
  P7's learn-from-correction was confirmed DEAD in production
  (grep: zero `vetoAvoidanceProvider` refs in apps/api +
  autoconfigure) and is now LIVE — a recorded veto surfaces
  `[Learned Avoidance]` into real `/api/chat` runs. Verified by
  veto-avoidance-provider.test.ts; no parent flip — P7-b1's bullet
  was already `[x]` on its mandated check, this discharges the
  deferred production-wiring follow-up like the P9 daemon slices.)
- P7 audit — apps/api/test/p7-seam.test.ts — PASS: P7's two
  CAPABILITIES checks re-run green together (veto-avoidance 5/5,
  personal-veto-store 5/5). Like P5/P6, P7's bullets ARE a
  composed lifecycle, but the `mcp ↛ agent-core` boundary forced
  the isolated tests apart; apps/api depends on BOTH, so the seam
  test is the one place it composes for real: the REAL `@muse/mcp`
  veto store, behind the production-shape `readVetoes →
  VetoAvoidanceProvider` adapter, driven through the REAL
  `createAgentRuntime` pipeline — no veto → recordVeto surfaces
  `[Learned Avoidance]` into a live run (b1) → queryVetoes lists
  it (b2 review) → removeVeto (b2 clear) → a subsequent live run
  no longer carries the directive (clear genuinely un-does the
  live injection, not just the proxy the boundary forced). No
  drift; no bullet reopened. P7 (learns from correction) is
  genuinely delivered end-to-end. **P0–P7 now ALL delivered +
  audited.**
- P8 audit — packages/mcp/src/p8-seam.test.ts — PASS (with a
  corrected bookkeeping drift): the audit caught that goal 392 s1
  appended P8-b1's `— 392` annotation + CAPABILITIES line + README
  "done" row but never flipped the OUTWARD-TARGETS checkbox
  (`- [ ]`, while P8-b2 was correctly `- [x]`). The capability was
  genuinely delivered — situational-briefing.test.ts re-run 5/5
  green — so this is a metric-glyph drift, exactly what the audit
  exists to catch; the checkbox was corrected `[ ]`→`[x]` (not a
  re-deliver, not a REOPEN — the check was always green). Then the
  audit proper: both P8 piece-checks re-run green together (8/8)
  and p8-seam.test.ts exercises the whole flow — the full
  situational picture (soonest-first upcoming + escalated
  "Needs you" w/ resolution + active "Still tracking", finished
  excluded) synthesised from the REAL objectives store and
  delivered intact in ONE POST over a REAL `TelegramProvider`,
  then deduped in-window by the real sidecar. No further drift; no
  bullet reopened. P8 (proactive situational briefing) is
  genuinely delivered end-to-end. **P0–P8 now ALL delivered +
  audited.**
- P9-b2 env-gated daemon-set wiring + concrete objectives
  evaluator/actuator — iter (395) — deferred: P9-b2 genuinely
  bundles (a) the situational-briefing apps/api rider, (b) both
  riders env-gated + registered in the daemon set
  (`start…DaemonIfConfigured` + ServerOptions/autoconfigure
  plumbing + server.ts), (c) a concrete production objectives
  evaluator/actuator (the LLM-ish, smoke:live-class part). Too
  coarse for one tight commit, so P9-b2 was split; child (a) —
  `startSituationalBriefingTick`, the deterministic zero-LLM
  parallel of the P9-b1 objectives rider — shipped + tested (395).
  Parent P9-b2 stays `[ ]` until (b)+(c). Honest split, the
  378-s2 / P5 precedent — no parent flip, no CAPABILITIES line
  until the parent is met end-to-end. (PROGRESS 396: child (b) done
  for the situational-briefing daemon — env-gated + registered in
  the apps/api daemon set end-to-end, ServerOptions +
  autoconfigure + server.ts + integration test. Remaining: the
  objectives daemon env-gated + a concrete agent/LLM
  condition-evaluator — the smoke:live-class (c). Parent still
  `[ ]`.) (PROGRESS 397: (c) env-gating + registration +
  `createModelObjectiveEvaluator` strict-parse + conservative
  fail-soft + `createMessagingObjectiveActuator` SHIPPED &
  deterministically verified — BUT the real-qwen3:8b dog-food
  showed the small local model does not reliably emit a parseable
  verdict, so "the evaluator decides a real objective's condition"
  is **[UNVERIFIED-LIVE]** and parent P9-b2 stays `[ ]`. The
  evaluator's safe-default means it never false-acts — it just
  defers — so shipping the wiring is safe; clearing the
  [UNVERIFIED-LIVE] (reliable small-model verdict) is the priority
  follow-up.) (RESOLVED 398: the 397 [UNVERIFIED-LIVE] was a
  dog-food request-shape bug, NOT a code gap — the script used the
  OpenAI-compat endpoint with an invalid `reasoning:false` bool
  (400) / `/no_think` (empty). Re-dog-fooded the real production
  `createModelObjectiveEvaluator` via the correct zero-think path
  (native `/api/chat` `think:false`) against the mandated local
  qwen3:8b: met-time→`{met}`, future→`{unmet}`,
  impossible→`{unmeetable,reason}` — it genuinely decides. Tag
  cleared, parent P9-b2 flipped `[x]`, CAPABILITIES line appended.
  No code change needed — the evaluator/parser were always
  correct; the prior failure was the harness.)
- P9 audit — apps/api/test/p9-seam.test.ts — PASS: P9's bullets
  ARE a composed production pipeline (env-gated daemon-set fn →
  builds concrete `createModelObjectiveEvaluator` +
  `createMessagingObjectiveActuator` → P9-b1 `startObjectivesTick`
  rider → `runDueObjectives` over the real on-disk store). All
  P9 deterministic backing checks re-run green together
  (`@muse/mcp` 17/17 evaluator+loop+store; `@muse/api` 15/15
  rider+daemon ×2). p9-seam.test.ts exercises the WHOLE chain
  composed exactly as `startObjectivesDaemonIfConfigured` wires it
  (only the model verdict — a deterministic strict-JSON stand-in;
  the live qwen3:8b decision was separately verified by goal 398's
  real round-trip — and the HTTP boundary faked): a `met` verdict
  → "✅ Objective met:" POSTed over a real `TelegramProvider` +
  the objective durably `done`; `unmet` → no POST, stays `active`
  with attempts/backoff; `unmeetable` → "⚠ Objective needs you:"
  escalation POSTed + durably `escalated`. No drift; no bullet
  reopened. P9 (the delegated-autonomy loops actually run in
  production) is genuinely delivered end-to-end. **P0–P9 now ALL
  delivered + audited.**
- P8 audit (b3/b4 re-audit) — apps/api/test/situational-briefing-daemon-imminent-seam.test.ts — PASS: the original P8 audit
  (above) predated and explicitly covered only b1/b2 (the 8/8
  piece-checks); the loop-extended b3 (400) + b4 (401) added the
  REAL task/calendar imminence grounding AFTER it. Their per-piece
  checks existed, but the actual production assembly —
  `startSituationalBriefingDaemonIfConfigured` constructing the
  `deriveBriefingImminent(tasksFile)` ⊎ `deriveCalendarBriefing
  Imminent(calendar)` union from `ServerOptions` — was unguarded:
  goal 396 tested only its env-gate/register/stop, the b3/b4 tick
  tests hand-build the union themselves. A regression dropping the
  calendar branch or mis-wiring the file would have kept every test
  green. New seam drives the real builder with a real tasksFile +
  real calendar lister and asserts the wired imminentProvider
  unions both (and is absent when neither is set). All P8 checks
  re-run green together (`@muse/mcp` 13/13 composer+loop+seam+
  derivers; `@muse/api` 11/11 tick+daemon+new-seam). No drift; no
  bullet reopened — the production code was correct, only
  unguarded; it is now guarded.
