# TypeScript 7 Source-Quality Audit - 2026-07-16

## Purpose and decision record

This is the evidence ledger for the repository-wide source-quality program.
An entry is complete only when its production boundary was inspected, any
evidence-backed correction has focused verification, and residual risk is
explicit. Entries marked `No change` were reviewed without a high-confidence
defect and remain eligible for later seam re-audit.

TypeScript 7 remains the normal project-reference compiler. The `typescript`
package name remains the TypeScript 6 Compiler API compatibility alias for
tools that require that API. This avoids weakening `strict`, adding a normal
TS6 build fallback, or conflating compiler and tooling compatibility. The
official-source rationale and operational commands are maintained in
[`docs/development/typescript-7.md`](../development/typescript-7.md), including
the TypeScript 7 announcement and release-notes links.

## Platform and auxiliary package batch

| Area | Production boundary inspected | Result | Focused evidence |
| --- | --- | --- | --- |
| `@muse/windows` | PowerShell transport, base64 interpolation boundary, tool input enums, and read-output parsing | Storage and battery output now accept only finite, valid values; malformed drive rows are omitted so `NaN` or `Infinity` cannot enter tool JSON. | `pnpm --filter @muse/windows exec vitest run src/windows-app-read-tool.test.ts` - 8 passed; `pnpm --filter @muse/windows build` passed. |
| `@muse/agent-specs` | In-memory registry identity/eviction and Kysely upsert mapping | Registry capacity now requires a positive safe integer, preserving the invariant that a successfully saved spec remains retrievable unless a real eviction occurs. | `pnpm --filter @muse/agent-specs exec vitest run test/agent-specs.test.ts` - 16 passed; `pnpm --filter @muse/agent-specs build` passed. |
| `@muse/quarantine-eval` | Bounded handwritten JSON parser, duplicate-key reporting, schema/semantic validation, and scorecard output | No change. Raw input byte limit, nesting/member/value-node limits, invalid JSON handling, duplicate detection, and fail-close schema/semantic gates are present. | Source audit of `HandwrittenJsonParser` and `evaluateSyntheticQuarantineJson`; no changed behavior in this package. |
| `@muse/mascot` | Canonical pose data and SVG generation boundary | SVG options now require a nonempty known-frame sequence and finite positive duration/size values, preventing invalid generated markup after runtime type bypass. | `pnpm --filter @muse/mascot exec vitest run src/mascot.test.ts` - 9 passed; `pnpm --filter @muse/mascot build` passed. |
| `@muse/auth` | Password hash verification, JWT signing/verification, in-memory and Kysely user-store identity paths | In-memory user capacity now requires a positive safe integer; `NaN` can no longer silently disable overflow eviction. Existing password, JWT algorithm/expiry, and token identity guards were inspected. | `pnpm --filter @muse/auth exec vitest run test/auth.test.ts test/auth-hardening.test.ts` - 41 passed; `pnpm --filter @muse/auth build` passed. |
| `@muse/secrets` | Environment, Keychain, and legacy-store source chain; local-only resolver and least-privilege scope | No change. The resolver refuses non-local sources, catches source errors without propagating potentially secret-bearing exceptions, registers only returned values for redaction, and checks scope before source lookup. Keychain invocation uses a fixed executable and argv array. | Source audit of `resolveSecret`, `createSecretScope`, `createKeychainSource`, `createStoreSource`, and `createEnvSource`; no changed behavior in this package. |
| `@muse/a2a` | Signed peer transport, A2A message extraction, quarantine handoff, council request/response path | Council requests and council responses are both bounded to 4,000 characters. Oversized signed questions do not trigger peer reasoning, and oversized local reasoning is clipped before egress. The normal inbound path remains quarantine-or-reject only. | `pnpm --filter @muse/a2a exec vitest run test/council-wire.test.ts test/handler.test.ts` - 29 passed; `pnpm --filter @muse/a2a build` passed. |
| `@muse/runtime-settings` | In-memory cache/store and Kysely conflict-upsert semantics | Kysely upserts now preserve omitted `category`, `type`, `description`, and `updatedBy`, matching the in-memory patch contract while retaining explicit `null` clears. | `pnpm --filter @muse/runtime-settings exec vitest run test/runtime-settings.test.ts test/parse-boolean-setting.test.ts` - 12 passed; `pnpm --filter @muse/runtime-settings build` passed. |
| `@muse/db` | Kysely schema types, ordered SQL migration, DDL idempotency, and database-facing timestamp/JSON columns | No change. The single ordered migration uses repeat-safe create/index operations, schema table definitions match consuming stores, and migration lifecycle ownership remains confined to `@muse/db`. | Source audit of `schema.ts`, `migrations.ts`, and the package entrypoint; no changed behavior in this package. |
| `@muse/cache` | Response-cache options and cache metrics aggregation | Semantic similarity samples are now finite and capped at 1,000 recent observations, so a corrupt score cannot poison metrics and a long-running runtime cannot accumulate unbounded sample memory. | `pnpm --filter @muse/cache exec vitest run test/cache.test.ts test/normalize-cache-text.test.ts` - 23 passed; `pnpm --filter @muse/cache build` passed. |
| `@muse/observability` | In-memory and persisted tracers, trace sinks, token-cost aggregation, budgets, latency, and metrics | In-memory tracer retention now has a finite 10,000-span FIFO cap with invalid-option fallback, matching the package's bounded in-memory metrics posture. | `pnpm --filter @muse/observability exec vitest run test/observability.test.ts` - 74 passed; `pnpm --filter @muse/observability build` passed. |
| `@muse/resilience` | Retry, timeout, circuit breaker, fallback, cancellation, and jitter boundaries | Retry attempts, circuit thresholds, half-open limits, registry capacity, and reset timeout now normalize invalid numeric values before control flow. Invalid attempt limits preserve the default three attempts rather than skipping work or reporting fractional counts. | `pnpm --filter @muse/resilience exec vitest run test/resilience.test.ts test/decorrelated-jitter.test.ts test/error-classifier.test.ts test/scale-request-timeout.test.ts` - 59 passed; `pnpm --filter @muse/resilience build` passed. |
| `@muse/mcp-shared` | Shared idempotent HTTP retry transport | Caller cancellation now terminates before a request and during backoff instead of being retried as a network failure. Retry count and all timer delays require safe non-negative integers and are bounded to prevent overflow/immediate timers or unbounded request loops. | `pnpm --filter @muse/mcp-shared exec vitest run test/http-retry.test.ts` - 7 passed; `pnpm --filter @muse/mcp-shared build` passed. |
| `@muse/mcp` | SDK transport lifecycle, SSRF validation, OAuth wiring, tool-result normalization | No change to connection/OAuth security policy: external transports fail closed, DNS rebinding is checked, and background connections never open a browser. MCP result normalization now maps every non-finite number to `null`, preserving the shared JSON round-trip contract for values such as `1e400`. | `pnpm --filter @muse/mcp exec vitest run test/mcp-transport-result.test.ts` - 1 passed; `pnpm --filter @muse/mcp build` passed. |
| `@muse/browser` | Chrome/CDP lifecycle, page cleanup, tool approval gates, and timeout ownership | Browser options now normalize invalid or overflow-prone navigation/CDP timeout values before they reach Puppeteer and Node timers. Existing dialog, navigation-status, and approval boundaries were inspected without policy changes. | `pnpm --filter @muse/browser exec vitest run src/puppeteer-controller.test.ts` - 1 passed; `pnpm --filter @muse/browser build` passed. |
| `@muse/model` | Provider-neutral wire parsing, tool-argument recovery, non-streaming timeout/cancellation, streamed response contracts, and provider response conversion | The common recovered-tool-argument sanitizer converts parsed non-finite numbers (for example JSON `1e400`) to `null`, so malformed provider output cannot enter the provider-neutral `JsonValue` contract. `MUSE_MODEL_TIMEOUT_MS` accepts only digit-only safe integers at or below Node's timer ceiling; `0` explicitly disables the non-streaming cap while streams retain caller-owned cancellation. Provider response error shaping was also inspected. | `pnpm --filter @muse/model exec vitest run src/provider-shared.test.ts` - 1 passed; source audit of `resolveModelCallTimeoutMs` and `modelCallSignal`; `pnpm --filter @muse/model build` passed. |
| `@muse/multi-agent` | In-memory orchestration message bus, bounded retention, and subscriber delivery | Concurrent publishes now serialize subscriber delivery in publish order. `clear()` advances a generation so queued pre-clear messages cannot reach newly cleared subscriptions. Existing capacity validation and fail-open handler isolation were inspected. | `pnpm --filter @muse/multi-agent exec vitest run test/agent-message-bus.test.ts` - 14 passed; `pnpm --filter @muse/multi-agent build` passed. |
| `@muse/agent-core` | Optional reranker score/order boundary | No change. `topK` fails open for non-finite values, reranker failures and score-length mismatches preserve cosine order, non-finite scores fall back to source scores, and reranking does not mutate caller-owned matches. | `pnpm --filter @muse/agent-core exec vitest run src/reranking.test.ts` - 9 passed; `pnpm --filter @muse/agent-core build` passed. |
| `@muse/recall` | Notes retrieval ranking, reranker candidate window, prompt evidence limit, and browsing-history sync persistence | Direct retrieval callers now normalize `topK` to the CLI's documented 1..20 range: invalid values fail closed to no retrieval and oversized values cap at 20. This keeps embedding/reranker work and evidence budgets bounded without an app-package dependency. Browsing sync now commits against the latest locked store snapshot, preserving concurrent visits, monotonic cursors, and compatible precomputed embeddings without holding a file lock during Chrome reads or embedding calls. | `pnpm --filter @muse/recall exec vitest run src/ask-note-retrieval.test.ts` - 12 passed; `pnpm --filter @muse/recall exec vitest run src/browsing-sync.test.ts`; `pnpm --filter @muse/recall build`. |
| `@muse/skills` | Authored `SKILL.md` create/patch, usage, curation, consolidation, restore, and rollback lifecycle | Every state-changing authored-skill operation now shares the existing `@muse/shared` in-process queue plus cross-process file lock. The dedicated store-wide lock preserves duplicate detection, cap eviction, snapshots, archival, and rollback ordering across concurrent Muse processes without creating a new generic abstraction. | `pnpm --filter @muse/skills exec vitest run test/authored-skill-store.test.ts`; `pnpm --filter @muse/skills build`. |
| `@muse/autoconfigure` | SKILL.md registry construction, precedence, asynchronous runtime cache, and catalog-provider wiring | No change. Authored skills are lowest precedence under user/workspace files; the runtime exposes an empty cache until the asynchronous load resolves; and catalog-provider failures are handled fail-open by the agent-core context boundary. | Source audit of `personal-providers.ts`, `skills-runtime.ts`, and `runtime-assembly.ts`; existing focused precedence/runtime tests inspected. |
| `@muse/voice` | OpenAI TTS/STT request construction, Piper/Whisper.cpp subprocess lifecycle, typed response errors, MIME validation, and cloud/local request timeout | Cloud fetches and local Piper/Whisper.cpp runners now share one safe-positive-integer timeout policy. Fractional values cannot truncate to `0ms`; non-finite/non-positive values use defaults; valid delays cap at Node's timer ceiling. Existing local adapters retain typed output and spawn failures. | `pnpm --filter @muse/voice exec vitest run test/timeout-utils.test.ts test/http-utils.test.ts test/openai-tts.test.ts test/openai-whisper.test.ts test/piper.test.ts test/whisper-cpp.test.ts` - 27 passed; `pnpm --filter @muse/voice build` passed. |
| `@muse/policy` | Tool-output sanitizer and persisted approval-receipt expiry boundary | Sanitizer limits now require safe integers, preserving explicit zero-cap semantics while rejecting fractional/non-finite values. Existing receipt parsing normalizes expiry timestamps before construction and consumption. | `pnpm --filter @muse/policy exec vitest run src/tool-output-sanitizer.test.ts` - 10 passed; `pnpm --filter @muse/policy build` passed. |

## Durable state and application-boundary batch

| Area | Production boundary inspected | Result | Focused evidence |
| --- | --- | --- |
| `@muse/proactivity` | Commitment check-in append/status state and background-exit one-shot notification state | Check-in mutations now use atomic writes plus in-process and cross-process serialization. Background exit notification has a firing lock across select, mark, and deliver, preventing the API and CLI daemons from double-sending one exit. | `pnpm --filter @muse/proactivity exec vitest run test/background-exit-notice-loop.test.ts test/commitment-checkin.test.ts test/commitment-checkin-lock.test.ts` - 53 passed; `pnpm --filter @muse/proactivity build` passed. |
| `@muse/messaging` | Matrix, Telegram, channel, inbox, acknowledgement, reply, thread, injection, and pending-approval sidecars | Cursor and inbox read-modify-write paths now share the messaging cross-process mutation primitive. Telegram offsets remain monotonic under overlapping polls; delivery and injection cursors preserve every concurrent advance. | Messaging cursor regressions - 100 passed across focused suites; injection/store-concurrency regressions - 15 passed; `pnpm --filter @muse/messaging build` passed. |
| `@muse/calendar` | Google OAuth refresh success-response boundary | A malformed 2xx OAuth body now yields typed `OAUTH_INVALID_RESPONSE`, matching the normal Google API transport contract instead of leaking a raw JSON parse failure. | `pnpm --filter @muse/calendar exec vitest run test/google-provider.test.ts` - 14 passed; `pnpm --filter @muse/calendar build` passed. |
| `@muse/api` | Channel owner adoption/pairing-code consumption and curator reject cooldown ledger | Owner adoption and one-time pairing-code consumption now run as cross-process transactions. Reject cooldown counts are atomically accumulated so concurrent consolidate ticks cannot re-propose an already rejected cluster. | `src/channel-owner-store.test.ts` - 2 passed; `src/reject-ledger.test.ts` - 9 passed; `pnpm --filter @muse/api build` passed. |
| `@muse/cli` | Model credential merge and JWT secret rotation state | Concurrent provider setup merges against a fresh locked snapshot, retaining encryption-at-rest semantics. JWT rotation now keeps every intermediate signing key in the previous-secret grace chain. | `src/setup-model.test.ts` - 14 passed; `src/jwt-rotation-store.test.ts` - 8 passed; `pnpm --filter @muse/cli build` passed. |
| `@muse/shared` + `@muse/web` | Browser import boundary | Browser consumers now import only `@muse/shared/browser`, a Node-free entry point for JSON and error utilities. The root barrel remains compatible for Node consumers, while Vite no longer externalizes Node builtins from shared runtime/process modules. | `pnpm --filter @muse/shared exec vitest run test/browser.test.ts` - 2 passed; `pnpm --filter @muse/shared build` and `pnpm --filter @muse/web build` passed. |
| `@muse/shared` + `@muse/tools` + Rust runner | TS watchdog to Rust command-tree lifecycle | The outer watchdog now starts the runner in an isolated POSIX process group and terminates that group on timeout or abort. A real wedged runner regression proves its inherited command process does not survive the watchdog. | `pnpm --filter @muse/tools exec vitest run test/tools.test.ts -t "Rust runner watchdog"` - 9 passed; `pnpm --filter @muse/shared build` and `pnpm --filter @muse/tools build` passed. |
| `@muse/api` + `@muse/stores` | Reminder create, snooze, fire, and delete mutations | API routes now use the store's cross-process `mutateReminders` transaction rather than stale read-then-write snapshots, so overlapping API mutations and the firing daemon cannot lose unrelated reminder updates. | `pnpm --filter @muse/api exec vitest run test/server.reminders-concurrency.test.ts` - 1 passed; `pnpm --filter @muse/api build` passed. |
| `@muse/api` + `@muse/stores` | Task create, patch, complete, and delete mutations | Every task mutation now reads and changes the latest locked snapshot through `mutateTasks`, preventing overlapping API calls from overwriting unrelated task changes. | `pnpm --filter @muse/api exec vitest run test/server.tasks-concurrency.test.ts` - 1 passed; `pnpm --filter @muse/api build` passed. |
| `@muse/api` | TS7 project-reference graph and persisted orchestration-history restore | Removed the duplicate `@muse/attunement` project reference; the remaining references and runtime dependencies are aligned. The file history adapter validates dates, modes, statuses, counts, duration, conversation metadata, and optional fields before route consumers call Date methods. | `pnpm --filter @muse/api exec vitest run src/orchestration-history-file.test.ts` - 4 passed; `pnpm --filter @muse/api build` passed. |
| `@muse/shared` + `@muse/stores` + `@muse/memory` | File mutation queue and cross-process lock ownership; conversation-summary and task-memory file stores | Moved reusable process-local mutation serialization and O_EXCL file locking to `@muse/shared`, preserving `@muse/stores` re-exports. Memory file stores now lock complete read-hydrate-mutate-write operations across processes without introducing the `memory → stores → memory` TS7 project-reference cycle. | `pnpm --filter @muse/stores exec vitest run test/atomic-file-store.test.ts test/lock-retry-backoff.test.ts` - 19 passed; `pnpm --filter @muse/memory exec vitest run test/conversation-summary-store.test.ts test/file-task-memory-store.test.ts` - 17 passed; shared/stores/memory builds passed. |
| `@muse/memory` | Belief-provenance append log | Provenance batches now hold the same in-process and cross-process lock across read, bounded append, and encrypted-format-preserving write. Concurrent auto-extraction and explicit forget events no longer overwrite one another. | `pnpm --filter @muse/memory exec vitest run src/belief-provenance-store.test.ts` - 15 passed; `pnpm --filter @muse/memory build` passed. |
| `@muse/runtime-state` | Per-run file checkpoint save/delete lifecycle | Checkpoint save and delete now serialize complete read-modify-write operations per run file across processes while preserving the existing atomic rename format. Concurrent run lifecycle activity can no longer discard a recovery checkpoint. | `pnpm --filter @muse/runtime-state exec vitest run src/file-checkpoint-store.test.ts` - 12 passed; `pnpm --filter @muse/runtime-state build` passed. |
| `@muse/cli` + `@muse/stores` | Local task add, complete, edit, delete, commitment tracking, watch-folder task creation, and chat completion reporting | All CLI personal-task read-modify-write paths now resolve and mutate the current cross-process locked snapshot through `mutateTasks`. This prevents concurrent CLI, API, and daemon activity from discarding task changes; commitment duplicate checks and title-based resolution also operate on the current snapshot. | `pnpm --filter @muse/cli exec vitest run src/commands-tasks.test.ts src/commands-commitments.test.ts src/commands-watch-folder.test.ts src/chat-repl.test.ts` - 89 passed; `pnpm --filter @muse/cli build` passed. |
| `@muse/domain-tools` | IMAP/SMTP connection, mailbox, send, typed auth/network error, approval-gated outbound-mail, public HTTP redirect, SSRF, readable/PDF response, loopback fetch/filesystem, and local task-provider boundaries | IMAP/SMTP operation timeout now accepts only safe positive integer milliseconds and caps Node timer overflow. Public web reading retains per-hop SSRF/redirect and body-byte guards; invalid `maxChars` values now defer to the documented reader default rather than causing negative/fractional slicing in HTML or PDF paths. Loopback fetch and filesystem caps now reject unsafe size/count values; fetch preserves explicit zero-timeout disable semantics. The local task provider now delegates file reads to the canonical task store, so corrupt JSON is quarantined before a recovery add creates a replacement file rather than silently destroying the original bytes. | `pnpm --filter @muse/domain-tools exec vitest run src/email-provider.test.ts src/email-send.test.ts` - 37 passed; `pnpm --filter @muse/domain-tools exec vitest run test/fetch-readable-url.test.ts` - 20 passed; `pnpm --filter @muse/domain-tools exec vitest run test/loopback-fetch.test.ts` - 2 passed; `pnpm --filter @muse/domain-tools exec vitest run test/loopback-filesystem.test.ts` - 16 passed; `pnpm --filter @muse/domain-tools exec vitest run src/tasks-providers-local-file.test.ts` - 25 passed; package build passed. |
| `@muse/attunement` | File-backed Personal Continuity and timing-session state | All attunement state mutations already use the shared queued, cross-process locked atomic-write path. Timing-state reads now additionally reject duplicate IDs, dangling references, cross-thread/session evidence, and duplicate feedback for a candidate, preventing corrupted local JSON from bypassing lifecycle invariants. | `pnpm --filter @muse/attunement exec vitest run src/timing-store-integrity.test.ts`; `pnpm --filter @muse/attunement build`. |
| `@muse/stores` | Inbound swarm quarantine sidecar | Inert inbound know-how mutations now share both the process-local queue and the cross-process nonce-owned file lock. Concurrent API, CLI, or daemon add/promote/reject operations can no longer overwrite each other's sidecar state. | `pnpm --filter @muse/stores exec vitest run test/swarm-quarantine-store.test.ts` - 6 passed; `pnpm --filter @muse/stores build` passed. |
| `@muse/scheduler` | File-backed scheduled-job mutation, in-memory/Kysely distributed lock lifecycle, and on-exit watcher recovery | No change. File mutations take a cross-process lock across hydrate/mutate/write; Kysely lock acquisition is owner-scoped and expires only through the atomic conflict predicate; in-memory release cannot delete another owner’s lock. On-exit watches clear durable armed state before invoking a job and reconcile crash leftovers explicitly. | Source audit of `scheduler-file-store.ts`, `scheduler-locks.ts`, `dynamic-scheduler.ts`, and `on-exit-schedule.ts`. |
| `@muse/web` | API client non-2xx error envelope | No change. The sole API client preserves actionable non-empty `errorMessage`, `message`, or `error` response fields in priority order and replaces malformed successful JSON with a stable status-bearing error. | Source audit of `apps/web/src/api/client.ts` against API compatibility response helpers. |

## Follow-up

- Continue the package/app ledger in dependency order. A source review is not a
  completion claim for callers or downstream registration paths.
- Re-audit changed seams after all package and application entries exist.
- Perform independent final review and the final requirement-by-requirement
  completion audit before closing the program.

## Feed persistence concurrency (2026-07-16)

- Confirmed against Node fs guidance and established Node persistence libraries: atomic replacement prevents partial-file corruption but does not make a stale read-modify-write operation safe.
- `@muse/recall` now exposes `mutateFeedsStore`: callers prepare network/model work outside the lock, then apply a narrow delta to the latest locked snapshot. CLI refresh preserves concurrent additions/removals and merges concurrent successful feed archives.
- Verified with focused `@muse/recall` store and `@muse/cli` command race tests plus their package builds.

## Checkpoint retention coordination (2026-07-16)

- Audited the disk-backed runtime checkpoint store: per-run save/delete already shared a cross-process lock, but retention pruning could delete a different run without respecting that run's active lock.
- Pruning now acquires the candidate run's mutation queue and lock, re-evaluates recency after waiting, and never queues behind the save currently invoking retention.
- Focused verification: `pnpm --filter @muse/runtime-state exec vitest run src/file-checkpoint-store.test.ts` (13 passed) and `pnpm --filter @muse/runtime-state build`.

## Shared lock ownership and user-memory convergence (2026-07-16)

- Compared the duplicated user-memory lock to the shared lock implementation. The duplicated unlock could remove a successor lock after stale-lock takeover; the shared nonce check prevents that ownership race.
- Added validated per-call stale and live-lock wait options to the shared lock. FileUserMemoryStore now uses the shared mutation queue and nonce-aware lock while retaining its prior 3-second fail-closed wait policy.
- Focused verification: `@muse/shared` file-lock tests (2 passed) and build; `@muse/memory` user-memory file, lock, and external-edit tests (53 passed) and build.

## Conversation-summary corruption preservation (2026-07-16)

- Audited FileConversationSummaryStore: normal mutations already read the latest state under shared queue and cross-process lock, but malformed JSON or an invalid root could be overwritten by the next summary save.
- Corrupt summary files now move to a timestamped quarantine before the store degrades to empty; the next save creates a fresh canonical file without destroying recoverable bytes.
- Focused verification: `pnpm --filter @muse/memory exec vitest run test/conversation-summary-store.test.ts` (13 passed) and `pnpm --filter @muse/memory build`.

## Task-memory corruption preservation (2026-07-16)

- Audited FileTaskMemoryStore: mutations already hydrate inside shared queue and cross-process lock, but malformed JSON or an invalid root previously degraded to an empty state that the next save could overwrite.
- Corrupt task-memory files now move to a timestamped quarantine before recovery writes a fresh canonical store.
- Focused verification: `pnpm --filter @muse/memory exec vitest run test/file-task-memory-store.test.ts` (6 passed) and `pnpm --filter @muse/memory build`.

## Shared corrupt-file recovery (2026-07-16)

- Compared Node's asynchronous filesystem guidance with practical lock designs: atomic replacement avoids torn writes but does not preserve malformed state or serialize stale read-modify-write paths. Recovery must retain the original bytes before a canonical replacement is written.
- Extracted the repeated best-effort corrupt-file quarantine into `@muse/shared`. Task memory, conversation summaries, belief provenance, and the durable multi-agent board now use a UUID-suffixed quarantine name so concurrent recovery attempts cannot collide within one millisecond.
- Board malformed roots, invalid JSON, and oversized files now quarantine before its next mutation writes a fresh board; individual invalid task records remain safely filtered without treating the whole board as corrupt.
- Focused verification: `pnpm --filter @muse/shared build`; `pnpm --filter @muse/memory exec vitest run test/file-task-memory-store.test.ts test/conversation-summary-store.test.ts src/belief-provenance-store.test.ts` (34 passed) and build; `pnpm --filter @muse/multi-agent exec vitest run test/board-store.test.ts` (8 passed) and build.

## Follow-up persistence and recovery audit (2026-07-16)

- Audited follow-up capture, lifecycle mutations, and daemon firing. Upsert, fire, cancel, and snooze already reacquire the latest persisted state under the shared nonce-owned file lock; daemon delivery has a separate firing lock, so no lost-update or duplicate-delivery change was warranted.
- The legacy `@muse/stores` quarantine compatibility helper alone still used a timestamp-only target. It now delegates to the shared UUID-suffixed primitive, preserving every backup when repeated corruptions occur within one millisecond.
- Focused verification: `pnpm --filter @muse/stores exec vitest run test/store-quarantine.test.ts test/followups-cross-process.test.ts test/followups-store-lifecycle.test.ts` (14 passed) and `pnpm --filter @muse/stores build`.

## Standing-objective persistence audit (2026-07-16)

- No change. Objective registration and patching re-read and atomically write under the shared cross-process lock; focused tests cover external-lock waiting and 50 concurrent registrations/patches.
- The evaluator holds a separate firing lock across select, evidence-gated evaluation, act, and status commit. It retries action failures, rejects evidence-less completion, bounds options, and self-heals an unparseable `nextEvalAt` rather than freezing the objective.
- CLI registration validates objective kinds before the typed cast, resolves terminal-transition IDs unambiguously, and user-scopes list output. Source and focused store/proactivity/CLI test suites were inspected; no evidence-backed modification was warranted.

## Consent persistence and action timeout audit (2026-07-16)

- Consent records preserve exact user/objective/scope matching, optional destination-host binding, expiry fail-closure, and veto precedence. Record mutations use the shared cross-process lock and malformed stores degrade to no consent after quarantine; no consent-store policy change was warranted.
- The post-consent HTTP timeout now accepts only positive safe integer delays within Node's timer range. Invalid values (`NaN`, infinities, zero, negatives, fractions, overflow) retain the documented bounded default instead of disabling the cap or delegating to timer-specific failure behavior.
- Timeout classification now uses Muse's own abort signal state rather than a fetch implementation's error class, so wrapped or translated abort errors still report a timeout and leave the objective loop retryable.
- Focused verification: `pnpm --filter @muse/proactivity exec vitest run test/consented-action.test.ts` (17 passed), `pnpm --filter @muse/proactivity build`, `pnpm --filter @muse/mcp exec vitest run src/consented-action.test.ts` (7 passed), and `pnpm --filter @muse/mcp build`.

## Action-log persistence audit (2026-07-16)

- No change. The accountability log serializes same-process appends with a per-file queue and all-process appends with the shared nonce-owned lock; each new entry seals to the locked chain tip.
- Existing focused coverage proves append ordering, external-lock convergence, encrypted append preservation, wrong-key fail-closure, corrupt-plaintext quarantine, secret redaction, and detection of edited, removed, reordered, or sliced chain entries.
- Undo records its veto before appending its own accountability entry; an inverse-action failure prevents both later writes, leaving the original action visible and the correction retryable.

## Proposed-action approval gate (2026-07-16)

- Malformed `expiresAt` now fails closed in the exported actionability predicate as well as the persisted-record validator; no direct or future caller can approve a draft whose expiry cannot be parsed.
- Proposal TTLs now require a positive safe integer within the representable future range. Invalid, fractional, infinite, negative, zero, or excessive values fall back to the bounded 24-hour default rather than creating an invalid date or an effectively permanent draft.
- Focused verification: `pnpm --filter @muse/stores exec vitest run test/proposed-action-concurrency.test.ts` (4 passed), `pnpm --filter @muse/stores build`, `pnpm --filter @muse/proactivity exec vitest run test/proposed-action.test.ts` (9 passed), and `pnpm --filter @muse/proactivity build`.

## Reminder persistence and snooze lifecycle (2026-07-16)

- Extracted the shared `snoozeReminder` state transition used by API and loopback reminder paths. Re-arming a fired reminder now clears its obsolete `firedAt` receipt while preserving its identity, routing, recurrence, and new due time.
- Both consumers now resolve the updated reminder from the latest locked snapshot, so an id removed between initial reference resolution and mutation returns not-found instead of a stale success payload.
- Focused verification: `pnpm --filter @muse/stores exec vitest run test/personal-reminders-serialize.test.ts` (16 passed), `pnpm --filter @muse/stores build`, `pnpm --filter @muse/domain-tools build`, and `pnpm --filter @muse/api build`.
## Contacts import transaction and identifier boundary

- Inspected the contacts persistence contract, recipient-resolution tests, domain tool, CLI import path, encryption recovery, and concurrent mutation coverage.
- `name`, aliases, email, phone, and handle remain the only recipient identifiers; relationship, connection, and free-text recall fields stay non-identifying material.
- Fixed Apple Contacts import's stale read-merge-write sequence. `mutateContactsWithResult` now derives an importer result and replacement list from one queued, locked snapshot, so an intervening local add or removal cannot be overwritten by the final import write.
- Added a locked-snapshot regression test. Contact status/type strings remain domain-owned literal unions rather than a global enum or constants bucket; no shared extraction was warranted beyond the existing stores API surface.
## macOS Contacts external-date validation

- Inspected the Contacts AppleScript payload boundary, parser, normalization, cap/error handling, and its focused tests.
- Tightened birthday normalization from component-range checks to real calendar validation. Valid yearless leap-day values remain supported, but impossible dates such as `1990-02-29` and `04-31`, plus unrepresentable years, are discarded before persistence.
- `DAYS_PER_MONTH` and leap-year logic are local parser implementation details, not cross-domain constants or enums.
## Apple Contacts identity merge safety

- Inspected the Apple-to-Muse merge contract, direct identifier normalization, user-authored field preservation, duplicate handling, and focused merge tests.
- Fixed a same-name false-merge path: addressable contacts now require one unambiguous matching phone/email. Name fallback is permitted only for a single candidate when either the imported or stored record has no addressable identifier.
- This preserves useful enrichment of relationship-only or birthday-only records without collapsing distinct people who happen to share a name.
## macOS Contacts write completion and audit isolation

- Inspected the execute-risk Contacts writer: schema, approval gate, AppleScript escaping, runner errors, timeout/permission mapping, and action logging.
- Kept the approval boundary fail-closed. After a successful irreversible Contacts write, action-log failures are now isolated and reported as `auditLogged: false` while retaining `written: true`; callers cannot mistake a completed write for a failed one and retry into a duplicate contact.
- Refusal and execution-failure paths remain non-writing and keep their best-effort audit attempt.
## Shared subprocess truncation contract

- Inspected `runCommandWithTimeout`, its bounded stream accumulator, and the Rust runner/voice consumer impact graph.
- Added an explicit `truncated` result signal whenever either bounded stream exceeds its capture limit. The Rust runner now fail-closes with that signal instead of misclassifying a partial JSON response as generic invalid JSON.
- Voice consumers retain their existing stderr behavior because they do not parse captured stdout; no unrelated output contract change was made.
## Rust runner request-size boundary

- Inspected the local Rust runner protocol, command/environment hardening, process-group cleanup, output draining, sandbox planning, and protocol tests.
- Bounded untrusted stdin before JSON parsing to 1 MiB, reading only one extra byte to detect overflow. Oversized requests now fail before an unbounded allocation or parser work begins.
- Added direct reader tests for normal JSON and over-limit input; response serialization keeps the existing failure contract.
## Rust runner drain-completion truthfulness

- Audited the post-exit stream-drainer fallback after process-group cleanup.
- A timed-out or disconnected drainer now marks its empty fallback as truncated instead of presenting unknown output as complete; callers retain the command outcome but can fail-safe on incomplete output.

## Desktop notification subprocess diagnostics

- **Area:** `packages/messaging` native macOS and Linux desktop notification providers.
- **Finding:** `osascript` and `notify-send` ran through the shared subprocess helper without capture limits, allowing an untrusted diagnostic stream to consume memory. The duplicated watchdog implementations also risked diverging.
- **Decision:** A messaging-local helper now owns the common 30-second watchdog and a 16 KiB per-stream diagnostic boundary. A successful zero exit code remains a successful delivery even when diagnostics are truncated, avoiding false failures and duplicate notifications; failed receipts explicitly mark truncated diagnostics.
- **Evidence:** focused macOS and libnotify provider tests cover timeout behavior, UTF-8 diagnostic decoding, bounded output, and truncated-error reporting.

## LINE outbound transport normalization

- **Area:** `packages/messaging` LINE push provider.
- **Finding:** non-OK LINE responses became `MessagingProviderError`, but a rejected fetch (including the timeout helper's rejection) escaped as an untyped raw exception. That bypassed the provider error contract used by retry policy.
- **Decision:** normalize every LINE push transport rejection as `UPSTREAM_FAILED`, retaining the safe causal message while preserving HTTP status and Retry-After handling for actual responses.
- **Evidence:** focused provider coverage now distinguishes validation-before-network, HTTP failure mapping, and rejected transport normalization.
- **Follow-up:** unreadable non-OK response bodies are also normalized while retaining the HTTP status and Retry-After metadata; focused tests cover 429, a rejected body stream, and timeout-shaped transport rejection.

## Discord request and response boundary

- **Area:** `packages/messaging` Discord REST provider, outbound sends and inbound channel reads.
- **Finding:** timeout/transport rejections and failed response-body reads could escape as raw exceptions. For an outbound POST this obscured retry safety; for reads it discarded the provider status contract.
- **Decision:** Discord now normalizes request and body-read failures to `UPSTREAM_FAILED`. Body failures retain status and Retry-After metadata; transport failures have no status and remain non-retryable, preventing an ambiguous POST from being replayed.
- **Evidence:** focused tests cover timeout-shaped send rejection, unreadable successful send response, and unreadable inbound error response.
- **Follow-up:** the final retried inbound HTTP error now retains Retry-After too. Focused tests pin a server-directed zero-delay retry that succeeds and an exhausted 429 receipt that retains `retryAfterMs`.

## Slack API and cursor boundary

- **Area:** `packages/messaging` Slack Web API provider, outbound chat post and inbound history polling.
- **Finding:** request/body failures escaped untyped; exhausted inbound rate limits discarded Retry-After; permissive `parseFloat` accepted malformed timestamp prefixes and could advance a cursor past valid history.
- **Decision:** normalize Slack request/body failures as `UPSTREAM_FAILED`, preserve Retry-After for final reads, and require an entirely numeric positive Slack timestamp before it may affect a cursor or ISO conversion.
- **Evidence:** focused tests cover timeout-shaped POST rejection, unreadable success body, 429 retry/success, exhausted 429 metadata, and timestamp suffix rejection.
- **Follow-up:** timestamp validation now also requires Date-range validity, so an out-of-range numeric API value cannot be persisted as a future `oldest` cursor; the polling-after-file regression is covered directly.

## Telegram API and update-offset boundary

- **Area:** `packages/messaging` Telegram Bot API requests and persisted getUpdates offset.
- **Finding:** raw request/body failures crossed the provider boundary; final rate limits discarded Telegram's body retry-after; malformed numeric update IDs or dates could make offset persistence fail or crash conversion.
- **Decision:** one Telegram-local request/body boundary normalizes every Bot API operation. Only safe update IDs advance offsets; malformed message dates are skipped while valid updates still progress. A missing valid message ID may safely fall back to the update ID for snapshot compatibility.
- **Evidence:** focused tests cover ambiguous outbound failure, unreadable success body, mixed malformed/valid update progression, and body-supplied retry-after preservation.
- **Follow-up:** Telegram result entries are now runtime-narrowed as arrays and records before any field access. Null, non-object, malformed chat, and malformed date entries are skipped without blocking a valid later update or corrupting its offset.

## Matrix request and sync-token boundary

- **Area:** `packages/messaging` Matrix Client-Server REST provider.
- **Finding:** request/body failures could escape as raw exceptions; an empty `next_batch` reached persistence as a raw writer error; Matrix's body retry-after uses milliseconds and must not be scaled twice.
- **Decision:** Matrix REST calls now share a provider-local request/body boundary, reject empty sync tokens before persistence, and preserve Matrix retry-after values in their native millisecond unit for direct errors while converting only at the shared HTTP fallback boundary.
- **Evidence:** focused tests cover empty next_batch token preservation and exhausted Matrix 429 retry_after_ms handling.
- **Follow-up:** `sendWithRetry` now creates one retry-scoped idempotency key and passes it through the registry; Matrix forwards it as the encoded native transaction ID, so retryable failures cannot turn a retry into a duplicate event.
- **Follow-up:** Matrix `/sync` nested rooms, timelines, and events are now parsed as untrusted records/arrays. Malformed entries and invalid timestamps are isolated while a valid later text event and `next_batch` continue normally.

### 2026-07-16 - tools Rust runner response boundary

- Inspected `packages/tools/src/runner.ts` and its contract-faithful child-process tests in `packages/tools/test/tools.test.ts` after CodeGraph sync.
- The existing output cap already operates on UTF-8 bytes and avoids splitting multibyte sequences; no duplicate truncation change was warranted.
- Tightened the untrusted runner JSON parser: `status` is now accepted only as a safe integer, otherwise normalised to `null`. This prevents non-finite or precision-losing JSON numbers from reaching process-failure classification.
- Added the `1e400` contract fixture. Focused runner boundary tests: 7 passed. `pnpm --filter @muse/tools build`: passed.
- Independent review further matched the parser to Rust's `Option<i32>` exit-code wire contract: accepted statuses are non-negative integers through `0x7fff_ffff`; negative, fractional, overflowing, and non-finite values normalise to `null`. The focused contract suite now has 12 passing tests and the package build remains green.

### 2026-07-16 - voice adapters and background process lifecycle

- Inspected `packages/voice/src/whisper-cpp.ts`, `packages/voice/src/piper.ts`, and their timeout/error-path tests. Both adapters already use the shared subprocess watchdog, bound stderr capture, typed provider failures, and best-effort temporary-directory cleanup. No evidence-backed source change was needed.
- Inspected the background process store, spawn orchestration, Node spawner, and focused lifecycle tests. Fixed two process-boundary invariants: invalid/non-positive PIDs are rejected before persistence or later signalling, and an exit observed while async launch bookkeeping is pending is persisted after registration rather than leaving a stale `running` record.
- The Node adapter now consumes rejected async exit listeners, preventing a registry-write failure from becoming an unhandled rejection. Focused stores tests: 11 passed. `pnpm --filter @muse/stores build`: passed. Independent contract review: pending.
- Follow-up review extended the PID boundary to persisted JSON: only positive safe-integer PIDs are accepted by reads, registrations, and PID updates, so corrupt negative/fractional values are dropped before reaching liveness or signal APIs. An exit captured before launch bookkeeping completes now propagates its persistence failure rather than silently returning a stale running record. Focused stores tests: 29 passed; build passed. Final independent review: pending.

### 2026-07-16 - API process lifecycle

- Inspected `apps/api/src/parent-watch.ts`, `graceful-shutdown.ts`, production signal wiring, and shutdown tests. Parent-watch currently validates a numeric parent PID, uses an unrefed interval, and performs only existence probes; no evidence-backed change was made in that path.
- Fixed graceful shutdown close-failure handling: `closeServer()` rejection is logged and resolved instead of becoming an unhandled rejection from the production `void shutdown()` signal handler. The forced-exit deadline intentionally remains armed when close fails; successful close still clears it.
- Focused API shutdown tests: 8 passed. `pnpm --filter @muse/api build`: passed. Independent review: pending.

### 2026-07-16 - API tick bootstrap and shared distill queue

- Inspected API tick-daemon bootstrap, quiet-hours resolver, channel-daemon supervisor, and focused lifecycle tests. Existing daemon handles are registered for Fastify `onClose`, replacement handles are stopped, and status output is bounded/redacted; no evidence-backed change was needed.
- Inspected the shared `@muse/autoconfigure` distill consumer. `maxPerTick` now accepts only positive safe integers; malformed values fall back to the one-item cost/progress-safe default instead of relying on `slice` coercion or producing an empty batch.
- Focused shared distill tests: 15 passed. `pnpm --filter @muse/autoconfigure build`: passed. Independent review: pending.

### 2026-07-16 - environment numeric boundaries and parent watch

- Compared API tick bootstrap numeric parsing with the tick implementations. Each interval-owning daemon already rejects non-finite input and clamps its own documented range, so broad `optionalNumber` extraction would add no safety and blur differing option semantics.
- Hardened `MUSE_PARENT_PID`: only a positive, safe decimal process ID now starts the parent watcher. Exponent notation, fractional/whitespace forms, and unsafe integers are ignored rather than reaching `process.kill(pid, 0)` and causing a spurious API self-exit.
- Focused parent-watch tests: 10 passed. `pnpm --filter @muse/api build`: passed. Independent review: pending.

### 2026-07-16 - CLI session recovery marker

- Inspected CLI SIGINT cancellation, REPL session lifecycle, and the persisted crash marker. Scoped SIGINT listeners already clean up in `finally` and thread cancellation into the long-running streaming callers; no evidence-backed edit was needed there.
- Hardened the shared session crash-marker reader: only a positive safe-integer PID and a parseable start timestamp count as recoverable prior-session evidence. Malformed marker JSON fields now fail closed instead of producing a misleading crash notice.
- Focused session-marker tests: 9 passed. `pnpm --filter @muse/stores build`: passed. Independent review: pending.

### CLI JWT rotation persistence boundary (2026-07-16)

- Inspected `apps/cli/src/jwt-rotation-store.ts`, `apps/cli/src/commands-auth.ts`, and their focused tests.
- Finding: TypeScript's static contract did not protect the exported rotation function from an invalid `Date`, non-finite/negative `graceMs`, or a computed expiry beyond JavaScript's supported `Date` range; those inputs could otherwise reach `toISOString()` as an implementation-level error.
- Decision: validate only at `rotateJwtState`, the persistence-domain owner of the `now + graceMs` calculation. A shared duration abstraction would have one consumer and would not improve the contract. The CLI continues to reject malformed text; the store rejects invalid programmatic input with a domain-specific `RangeError` before state construction.
- External basis: TypeScript erases types at runtime (TypeScript Handbook), JWT expiry processing is time-bound (RFC 7519), and invalid dates fail when converted to ISO form (MDN). OWASP's cryptographic-storage guidance also treats rotation procedures as a security boundary that should be ready before an incident.
- Verification: `pnpm --filter @muse/cli exec vitest run src/jwt-rotation-store.test.ts src/commands-auth.test.ts` (15 passed); `pnpm --filter @muse/cli build` passed.

### TypeScript representation decision (2026-07-16)

- Research basis: the TypeScript Handbook confirms that `enum` emits a runtime object, while literal discriminants support narrowing without a second runtime representation. Google’s TypeScript guide likewise cautions against `const enum` in shared code.
- Decision for Muse: do not mass-convert serialized strings into enums and do not create a global constants bucket. Keep finite wire-state values as literal unions plus discriminated object shapes unless a runtime registry is genuinely needed. Co-locate constants and errors with their owning boundary; extract only when at least two independent consumers share the same semantic contract.

### Shared JWT rotation-state contract (2026-07-16)

- Inspected the CLI file reader/writer and the autoconfigure boot reader. Both consumed `auth-secrets.json` independently, with materially different validation for `rotatedAt` and prior-key records.
- Decision: place the pure persisted-state parser in `@muse/auth`, which owns JWT semantics. CLI and autoconfigure retain their own file I/O and their fail-open fallback behavior. The CLI now declares its direct package dependency rather than reaching through an unrelated shared module.
- Contract: current key and timestamps must be canonical ISO values emitted by the writer; malformed top-level state falls back to the configured environment secret, while malformed historical entries are omitted. This avoids provider coupling and prevents a permissive boot parser from accepting state the CLI would later reject.
- Verification: `pnpm --filter @muse/auth exec vitest run test/jwt-rotation-state.test.ts` (2 passed); `pnpm --filter @muse/autoconfigure exec vitest run test/auth-wiring.test.ts` (9 passed); `pnpm --filter @muse/cli exec vitest run src/jwt-rotation-store.test.ts` (13 passed); builds for `@muse/auth`, `@muse/autoconfigure`, and `@muse/cli` passed.

### JWT compact serialization and clock boundary (2026-07-16)

- Inspected `packages/auth/src/jwt.ts` and its focused verifier tests after tracing `JwtTokenProvider.parseToken` with CodeGraph.
- Finding: destructuring `token.split(".")` ignored a fourth segment, so an otherwise valid compact JWS with appended data could be accepted. Also, an invalid injected `Date` produced `NaN` in the expiry comparison, allowing the comparison to fail open.
- Decision: require exactly three compact JWS segments before MAC verification; reject invalid clocks before token creation or expiry evaluation. Existing server-side HS256 pinning, constant-time signature comparison, and expiration boundary remain unchanged.
- External basis: RFC 7515 defines JWS Compact Serialization as exactly protected-header, payload, and signature joined by periods; RFC 7519 requires the current time to precede `exp`. OWASP also recommends server-side algorithm selection rather than trusting a token header.
- Verification: `pnpm --filter @muse/auth exec vitest run test/jwt.test.ts` (23 passed); `pnpm --filter @muse/auth build` passed.

### JWT verifier follow-up: Date range and canonical encoding (2026-07-16)

- Independent review found two remaining verifier edges: a finite but enormous configured duration could serialize an invalid expiry, and Node's permissive base64url decoder could accept a noncanonical compact segment.
- Decision: validate the computed expiration as a real `Date` before signing. Require every compact JWS segment to use canonical unpadded base64url by round-tripping Node's decoder/encoder after an alphabet check. This is intentionally local to JWT parsing because generic base64 helpers would not encode the JWS canonicality requirement.
- External basis: Node documents permissive base64/base64url decoding behavior, while RFC 7515 specifies compact JWS as URL-safe base64url segments without padding.
- Verification: `pnpm --filter @muse/auth exec vitest run test/jwt.test.ts` (25 passed); `pnpm --filter @muse/auth build` passed.

### Kysely user registration concurrency boundary (2026-07-16)

- Inspected `packages/auth/src/user-stores.ts`, its in-memory parity behavior, the `users.email` unique constraint in migrations, and API mapping of `USER_EXISTS` to HTTP 409.
- Finding: the Kysely store used `existsByEmail()` before insert. Concurrent registrations could both observe absence, then one received a raw database uniqueness error instead of the application duplicate-user contract.
- Decision: make `INSERT ... ON CONFLICT (email) DO NOTHING RETURNING` the atomic arbiter. A missing returned row maps to `AuthError(USER_EXISTS)`. This removes a database round trip and preserves the public API result without coupling to PostgreSQL driver's error object shape.
- External basis: PostgreSQL documents that `ON CONFLICT` provides an atomic insert-or-alternative outcome under concurrency, and SQLSTATE `23505` represents a unique violation.
- Verification: `pnpm --filter @muse/auth exec vitest run test/auth.test.ts` (17 passed); `pnpm --filter @muse/auth build` passed.

### Kysely user update conflict normalization (2026-07-16)

- Follow-up inspection found that ID-targeted upsert can still race with a concurrent change to the unique `email` column. The preflight duplicate lookup cannot make that conflict impossible.
- Decision: use one module-local write wrapper for save/update. It reuses the shared error-shape guard and maps PostgreSQL's stable `23505` unique-violation code to `AuthError(USER_EXISTS)`; all other errors propagate unchanged. The code and helper remain in the auth persistence owner rather than a generic exception module.
- Verification: `pnpm --filter @muse/auth exec vitest run test/auth.test.ts` (18 passed); `pnpm --filter @muse/auth build` passed.

### Kysely update race test follow-up (2026-07-16)

- Independent review required direct coverage of the `findByEmail` then ID-targeted upsert path, rather than inferring it from the insert test.
- Added a narrow Kysely-shaped test double that reaches `update`, simulates the post-precheck `23505`, and separately proves a non-unique database error is rethrown unchanged.
- Verification: `pnpm --filter @muse/auth exec vitest run test/auth.test.ts` (20 passed); `pnpm --filter @muse/auth build` passed.

### Policy approval receipt contract (2026-07-16)

- Inspected `packages/policy/src/approval-receipt.ts`, capability-profile allowlists, and the focused receipt tests.
- No change: receipt creation and validation canonicalize every approval-critical field, validate registered profile constraints and expiry, and the single-process store has no asynchronous gap between nonce lookup/insert or consumed check/set. The public store interface explicitly requires future persisted adapters to make consume transactional.
- Intentional boundary: this is an in-memory/test implementation only; a database-backed receipt store is not present and should be introduced only with a real multi-process approval flow, preserving the declared atomic `consume` contract.

### Runtime-state file checkpoint identity boundary (2026-07-16)

- Inspected `packages/runtime-state/src/file-checkpoint-store.ts` and its focused durability, retention, locking, resume, and traversal tests.
- Finding: replacing unsafe run-ID characters with `_` was not injective, so distinct run IDs such as `run/a` and `run?a` shared a checkpoint file and could resume each other's state.
- Decision: new filenames retain a bounded safe prefix plus the full SHA-256 of the original run ID. The reader and deleter retain fallback support for the legacy filename; resumable listing deduplicates a run ID while old and new files coexist. Existing lock and atomic-rename behavior stays on the new target.
- Verification: `pnpm --filter @muse/runtime-state exec vitest run src/file-checkpoint-store.test.ts` (15 passed); `pnpm --filter @muse/runtime-state build` passed.

### Runtime-state checkpoint migration follow-up (2026-07-16)

- Independent review found v1/v2 namespace overlap, unsafe legacy fallback, alias-counted retention, and a save/delete interleaving risk in the initial migration design.
- Decision: place v2 files in a dedicated subdirectory; trust a legacy file only when all persisted checkpoints name the requested run; retry a valid legacy file after corrupt v2 data; group retention by persisted logical run ID; and acquire v2/legacy locks in one stable order for save, delete, and prune.
- Migration posture: ambiguous legacy collision files fail closed rather than disclosing another run's state. Valid legacy files remain recoverable and deletable.
- Verification: `pnpm --filter @muse/runtime-state exec vitest run src/file-checkpoint-store.test.ts` (19 passed); `pnpm --filter @muse/runtime-state build` passed.

### Runtime-state checkpoint retention lock-order follow-up (2026-07-16)

- Independent review found a cross-run deadlock: save held its run's v1/v2 locks while retention could lock another run; concurrent saves could invert those dependencies.
- Decision: complete the atomic checkpoint commit under the owning run locks, release them, then invoke retention. Retention still re-evaluates candidates under the candidate run's locks, but no longer nests a second run lock beneath a held save lock.
- Verification: `pnpm --filter @muse/runtime-state exec vitest run src/file-checkpoint-store.test.ts` (20 passed); `pnpm --filter @muse/runtime-state build` passed.

### Runtime state: debug replay listing contract

- Inspected `packages/runtime-state/src/debug-replay.ts`, its in-memory tests, and the autoconfigure factory path.
- Aligned the Kysely and in-memory listing contracts: `captured_at DESC, id ASC` is now deterministic for equal timestamps, and list limits normalize finite integer boundaries before reaching PostgreSQL.
- Kept the normalization private to this store because it is an API persistence boundary rather than a shared cross-domain contract.
- Added a Kysely query-shape test for the ordered listing and invalid numeric limits.
- Verified with `pnpm --filter @muse/runtime-state exec vitest run test/debug-replay.test.ts test/debug-replay-kysely.test.ts` (15 passed) and `pnpm --filter @muse/runtime-state build`.
- Independent architecture review: PASS.

### Runtime settings: patch metadata parity

- Inspected the runtime-settings public store contract, in-memory implementation, Kysely UPSERT builder, factory wiring, and focused tests.
- Fixed an observed parity defect: omitted `updatedBy` now preserves the existing audit value in the in-memory store, while explicit `null` clears it, matching the Kysely conflict-update contract.
- Retained the string-literal `RuntimeSettingType` union. No enum or global constant is warranted because this serialized value set has no shared runtime registry behavior.
- Verified with `pnpm --filter @muse/runtime-settings exec vitest run test/runtime-settings.test.ts` (8 passed) and `pnpm --filter @muse/runtime-settings build`.
- Independent architecture review: PASS.

### Observability: persisted trace-event boundary (no code change)

- Inspected `packages/observability/src/observability-tracers.ts`, the model-loop span creation path, trace-event migration, factory wiring, and focused observability tests.
- Confirmed the DB foreign-key invariant is satisfied on the production model-loop path: it always supplies `context.runId` as `run.id`, which the persisted tracer resolves before the defensive `unknown` fallback.
- Did not broaden the tracer API or relax the database foreign key: no reachable persistence failure or DB/in-memory contract divergence was evidenced.

### API: orchestration-history file persistence (no code change)

- Inspected the file store, its restart/corruption tests, and API-server construction path.
- The store is created once per API server, and synchronous `record`/`clear` complete the in-memory mutation and atomic rename in one event-loop turn.
- A cross-process merge protocol would require an explicit multi-writer product contract; changing only the temporary filename would not prevent last-writer-wins loss. No evidence-backed change was made.

### Memory: file-backed task persistence (no code change)

- Inspected `FileTaskMemoryStore`, its in-memory/Kysely parity, file-lock and mutation-queue boundaries, and focused quality/persistence tests.
- Confirmed every mutation hydrates under the shared file lock, applies the in-memory invariant, then writes atomically; focused tests cover independent-instance concurrent saves, external lock waiting, corrupt-data quarantine, retention, and nested date round trips.
- No duplication or unsafe shared-contract extraction was evidenced.

### Memory: conversation-summary persistence recovery

- Inspected in-memory, file-backed, and Kysely conversation-summary paths plus factory wiring and focused persistence tests.
- Hardened file deserialization so malformed summaries or facts are skipped while valid summaries remain writable and recoverable; a malformed entry can no longer make a later save fail in `toISOString()`.
- Normalized invalid runtime `Date` inputs to the store clock across in-memory saves, file saves, and Kysely inserts; corrupted database dates map to epoch instead of leaking invalid dates into a later serialization path.
- Verified with `pnpm --filter @muse/memory exec vitest run test/conversation-summary-store.test.ts` (17 passed) and `pnpm --filter @muse/memory build`.
- Independent architecture review: PASS after a follow-up correction for caller-supplied invalid dates.

### Memory: Kysely user-memory concurrent mutation

- Inspected file-backed user-memory encryption/locking/CAS tests and the Kysely user-memory implementation and focused tests.
- Fixed a DB concurrency defect: Kysely fact, preference, and typed-slot writes previously read a full row then wrote it back without a per-user transaction lock, allowing concurrent requests to lose unrelated updates.
- Added a shared internal mutation boundary that acquires a transaction-scoped PostgreSQL advisory lock per user before read-modify-write; independent users remain concurrent.
- Kept the PostgreSQL detail inside `KyselyUserMemoryStore`; provider-neutral memory interfaces remain unchanged. The injected lock seam is private to construction options for deterministic storage tests.
- Verified with `pnpm --filter @muse/memory exec vitest run test/memory-user-store-kysely.test.ts` (17 passed) and `pnpm --filter @muse/memory build`.
- Independent architecture review: PASS.

### Memory: encrypted belief-provenance recovery

- Inspected belief-provenance file storage, encryption handling, validation, user-scoped query behavior, concurrent append tests, and external-lock test coverage.
- Fixed an encrypted-corruption recovery defect: when an envelope authenticated and decrypted but its plaintext was not valid JSON, a later record could overwrite the unrecoverable history without preserving it.
- Such envelopes are now quarantined before the best-effort empty recovery path. Wrong-key and authentication-tag failures still throw before quarantine or overwrite.
- Verified with `pnpm --filter @muse/memory exec vitest run test/belief-provenance-store.test.ts src/belief-provenance-store.test.ts` (61 passed) and `pnpm --filter @muse/memory build`.
- Independent architecture review: PASS.
### MCP: duplicate server conflict parity

- Inspected in-memory and Kysely MCP server stores plus API error shaping.
- Fixed an API contract mismatch: a PostgreSQL unique-name violation from Kysely save is now normalized to `McpRegistryError`, matching in-memory behavior and yielding the curated 409 response instead of a generic 500.
- Non-unique database failures remain unmodified and follow the generic server-error path.
- Verified with `pnpm --filter @muse/mcp exec vitest run test/server-stores.test.ts` (2 passed) and `pnpm --filter @muse/mcp build`.
- Independent architecture review: PASS.
### MCP: OAuth credential corruption boundary

- Inspected the OAuth file store, callback flow, existing persistence tests, and shared credential-encryption contract against MCP and OWASP guidance.
- Added strict persisted-record validation: malformed plaintext JSON is quarantined before a later write can overwrite its only copy.
- Preserved the stronger encrypted-credential contract: wrong keys, unsupported encrypted envelopes, and authenticated ciphertext whose decrypted payload has an unsupported shape now fail closed without modifying the credential file.
- Kept envelope recognition narrow so a malformed plaintext record with an incidental `data` field still follows the recoverable plaintext path.
- Verified with `pnpm --filter @muse/mcp exec vitest run test/oauth-store.test.ts` (17 passed) and `pnpm --filter @muse/mcp build`.
- Independent architecture review: PASS after two security findings and one boundary-classification finding were addressed.
### Runtime state: debug replay JSON boundary

- Audited the shared JSON-value guard, tool-argument coercion, policy structured-output normalization, model structured-output tests, and debug replay persistence mapping.
- Confirmed the shared guard already rejects `NaN` and infinities recursively; tools and policy already test the `1e400` boundary, so no duplicate abstraction was added.
- Replaced debug replay's divergent local JSON guard with the shared contract. Invalid metadata now degrades to `{}`, and invalid array entries are omitted instead of later serializing as JSON `null`.
- Verified with `pnpm --filter @muse/runtime-state exec vitest run test/debug-replay.test.ts test/debug-replay-kysely.test.ts` (16 passed) and `pnpm --filter @muse/runtime-state build`.
- Independent architecture review: PASS.
### API: shared JSON input guard ownership

- Audited API server-input utilities, their direct tests, the shared JSON guard, and dependent parser paths.
- Replaced the duplicate API-local recursive JSON validator with a re-export of `@muse/shared` `isJsonValue`; the public API module path remains stable.
- The shared guard retains finite-number validation and recursive array/object validation, so API input behavior is unchanged while the contract has one owner.
- Verified with `pnpm --filter @muse/api exec vitest run src/server-input-utils.test.ts` (9 passed) and `pnpm --filter @muse/api build`.
- Independent architecture review: PASS.
### Runtime settings: audit actor, cache races, and JSON persistence

- Audited bare and admin runtime-settings routes, auth identity attachment, runtime-settings cache lifecycle, persisted JSON parsing, and focused contract tests.
- Auth-required bare `/settings/:key` writes now record the authenticated user instead of accepting client-controlled `updatedBy`; unauthenticated local mode retains its existing body-driven behavior.
- Added per-key generations plus a monotonic cache epoch so an in-flight store read cannot repopulate stale cache data after `set`, `delete`, or `refreshCache`.
- `getJson` now accepts parsed data only when the shared recursive JSON guard verifies finite numbers, preventing `1e400` from surfacing as `Infinity`.
- Verified with `pnpm --filter @muse/runtime-settings exec vitest run test/runtime-settings.test.ts` (10 passed), `pnpm --filter @muse/runtime-settings build`, `pnpm --filter @muse/api exec vitest run test/runtime-settings-auth.test.ts test/server.contract.test.ts` (14 passed), and `pnpm --filter @muse/api build`.
- Independent architecture review: PASS after the refresh-cache race finding was addressed.

### Scheduler: configuration and execution lifecycle ownership

- Audited the public scheduler store contract, API parser, dynamic scheduler, in-memory/file/Kysely stores, and Kysely update shaping against TypeScript narrowing and explicit input-boundary guidance.
- Fixed a concurrent lost-write risk: a configuration update can no longer submit `last_result`, `last_run_at`, or `last_status` and overwrite a result concurrently recorded by `updateExecutionResult`.
- Added `ScheduledJobUpdateInput` so the API parser, dynamic scheduler, all stores, and Kysely update helper share the same configuration-only contract; identity and audit fields are excluded too.
- Added regression coverage for all three lifecycle fields, including an explicit unsafe-JavaScript input that proves the in-memory path preserves the latest execution outcome.
- Verified with `pnpm --filter @muse/scheduler exec vitest run test/scheduler-helpers-templating.test.ts` (11 passed), `pnpm --filter @muse/scheduler build`, and `pnpm --filter @muse/api build`.
- Independent runtime-contract review: PASS after end-to-end type propagation.

### Stores: encrypted credential recovery boundary

- Audited the shared encrypted credential store, its mutation queue/file lock, legacy-format compatibility tests, and credential-encryption failure semantics against MCP and OWASP fail-closed guidance.
- Fixed a destructive recovery defect: write and delete operations previously treated an existing unreadable store as empty, allowing a wrong key or malformed file to be overwritten before it could be recovered.
- Existing unreadable files now reject mutation without changing bytes. The normalized error and read-path warning state that the file was left untouched and describe the explicit recovery choices without promising an impossible immediate re-login.
- Added byte-preservation regression coverage for both a wrong encryption key and malformed on-disk JSON.
- Verified with `pnpm --filter @muse/stores exec vitest run test/encrypted-credentials.test.ts` (9 passed) and `pnpm --filter @muse/stores build`.
- Independent runtime-contract review: PASS after recovery guidance correction.

### Web: chat-stream request lifecycle

- Audited `useChatStream`, persisted transcript handling, SSE event commits, reset behavior, and the existing conversation/approval/commit tests.
- Fixed a stale asynchronous state defect: reset and unmount now abort the active chat request, and stale stream/JSON/error/finally callbacks cannot repopulate a cleared conversation or clear a newer request's state.
- Added synchronous lifecycle ownership before optimistic UI mutation, closing the React pre-rerender double-send race that could create an orphan assistant draft or clear the active stream indicator.
- Kept lifecycle ownership local to the hook module and added focused unit coverage for abort, stale completion, and re-entry rejection.
- Verified with `pnpm --filter @muse/web exec vitest run src/api/useChatStream.lifecycle.test.ts src/api/useChatStream.conversationId.test.ts src/api/useChatStream.commit.test.ts src/api/useChatStream.pendingApprovals.test.ts` (27 passed) and `pnpm --filter @muse/web build`.
- Independent runtime-contract review: PASS after two concurrency follow-up findings were addressed.

### MCP: Chrome DevTools local-browser boundary

- Audited the Chrome DevTools turnkey preset, its environment-driven assembly path, the generic MCP URL policy, static launch audit, and focused preset tests against Chrome and MCP security guidance.
- Fixed a trust-boundary gap: `MUSE_CHROME_DEVTOOLS_BROWSER_URL` previously flowed directly into the `npx` command and could target a remote endpoint despite the preset's local logged-in-browser contract.
- The preset now accepts only loopback HTTP endpoints (`localhost`, `127/8`, or `::1`) with arbitrary local ports. It rejects remote/private-network hosts, non-HTTP schemes, URL userinfo, query strings, and fragments so credentials cannot enter generated process arguments.
- Normal localhost and SSH/Docker port-forwarded local endpoints remain supported.
- Verified with `pnpm --filter @muse/mcp exec vitest run test/chrome-devtools-mcp.test.ts` (14 passed) and `pnpm --filter @muse/mcp build`.
- Independent runtime-contract review: PASS after query/fragment credential coverage was added.

### Calendar: bounded provider retry contract

- Audited Google and CalDAV provider retry paths, injected delay tests, `Retry-After` parsing, and Node timer behavior against current Google Calendar truncated-backoff guidance.
- Fixed a shared retry configuration defect: unbounded retry counts and exponential delays could exceed Node's timer range, where an oversized delay is coerced to an immediate retry.
- Centralized calendar-owned normalization for retry count, base delay, and truncated exponential backoff. Both providers now share a maximum of five extra attempts and a 30-second delay cap, matching the existing `Retry-After` ceiling.
- The helper normalizes its own direct inputs too, so negative, non-finite, and oversized values cannot bypass its timer-safe contract.
- Verified with `pnpm --filter @muse/calendar exec vitest run test/errors.test.ts test/google-provider.test.ts test/caldav-provider.test.ts` (42 passed) and `pnpm --filter @muse/calendar build`.
- Independent runtime-contract review: PASS after helper self-normalization coverage was added.

### CLI: bug-report secret boundary

- Audited unexpected-error formatting, GitHub issue URL construction, the shared secret-redaction contract, and focused formatter tests against OWASP guidance for remote diagnostic data.
- Fixed an external disclosure path: error text, command, and version values are now redacted at the final title/body boundary before they are encoded into the GitHub issue URL.
- Local terminal output intentionally retains the original error text for direct diagnosis; only the remote pre-filled issue payload is sanitized.
- Added regressions for secrets in both error text and public formatter option fields.
- Verified with `pnpm --filter @muse/cli exec vitest run src/format-cli-error.test.ts` (16 passed) and `pnpm --filter @muse/cli build`.
- Independent runtime-contract review: PASS after final-boundary redaction was added for command and version interpolation.

### CLI: import tar termination contract

- Audited the encrypted bundle/import pipeline, tar invocation boundaries, archive-path behavior, and focused import tests against GNU/BSD tar guidance and Node child-process lifecycle semantics.
- Confirmed `tar -f` consumes its archive argument directly; no speculative archive-path change was made. The concrete defect was instead that a signal-terminated child reports `close(code = null, signal)`, which list and extraction paths incorrectly accepted as success.
- Both operations now accept only exit code zero. Signal termination rejects with the signal name, so partial archive listings and partial restores cannot be reported as completed.
- Added focused regression coverage for signal termination in both listing and extraction stages.
- Verified with `pnpm --filter @muse/cli exec vitest run src/commands-import.test.ts` (9 passed) and `pnpm --filter @muse/cli build`.
- Independent runtime-contract review: PASS.

### CLI: child-process signal completion contract

- Audited the shared child-process result helper and its CLI callers, including import, voice recording/playback, brief playback, AppleScript, background state, and external-open paths, against Node's documented `close(code, signal)` contract.
- Fixed a cross-cutting false-success defect: signal termination previously coerced `code: null` to zero in the shared helper. Only a literal zero exit now succeeds by default; nonzero exits retain their stderr diagnostics and signals retain their names.
- Added a narrowly-scoped caller opt-in for an intentionally requested signal. Push-to-talk and timed `rec` capture accept `SIGTERM` only after their own `child.kill("SIGTERM")` succeeds; unexpected signals, spawn failures, and nonzero exits remain failures.
- Added direct helper coverage for default rejection and explicitly approved signals, plus an end-to-end timed capture regression returning WAV data after the controlled stop.
- Verified with `pnpm --filter @muse/cli exec vitest run src/async-promises.test.ts src/commands-listen.test.ts src/commands-brief.test.ts src/voice-playback.test.ts src/commands-glance.test.ts` (67 passed) and `pnpm --filter @muse/cli build`.
- Independent runtime-contract review: PASS after listener-owned stop handling was added.

### CLI: shared audio-player lifecycle ownership

- Audited `muse brief --speak` custom-player execution against the shared voice playback watchdog and the provider-neutral TTS response contract.
- Confirmed TTS format is a closed `TtsFormat` union, so no speculative filename validation was added. The concrete maintenance risk was duplicate player lifecycle ownership: brief independently implemented the same spawn/watchdog/kill contract as shared voice playback.
- Kept the public brief wrapper and timeout constant stable, but delegated custom-player execution to the shared watchdog so stderr draining, output sanitization, timeout behavior, and future child-process fixes have one owner.
- During independent review, fixed the shared watchdog to preserve `close(code = null, signal)` diagnostics. Signal exits now report their actual signal rather than an unknown exit code; nonzero exit and stderr behavior is unchanged.
- Verified with `pnpm --filter @muse/cli exec vitest run src/commands-brief.test.ts src/voice-playback.test.ts src/async-promises.test.ts` (46 passed) and `pnpm --filter @muse/cli build`.
- Independent runtime-contract review: PASS after signal diagnostic coverage was added.

### Messaging: fetch timeout and caller cancellation ownership

- Audited shared messaging-provider HTTP timeout/retry helpers, their provider callers, and focused reliability tests against the Fetch/AbortSignal composition contract.
- Fixed caller-cancellation loss: adding a timeout previously overwrote `RequestInit.signal`, so a provider caller could not cancel an in-flight request. Timeout and caller signals are now composed, with `null` normalized as no caller signal.
- Fixed a second-order retry defect found in independent review: idempotent read retry now immediately propagates an aborted caller signal rather than retrying already-cancelled requests and waiting through backoff. Internal timeout failures remain retryable and ordinary transient failures preserve existing retries.
- Added regression coverage for composed caller cancellation and for one-attempt/no-delay cancellation through `fetchReadWithRetry`.
- Verified with `pnpm --filter @muse/messaging exec vitest run src/provider-helpers.test.ts test/provider-helpers.test.ts test/read-retry.test.ts` (42 passed) and `pnpm --filter @muse/messaging build`.
- Independent runtime-contract review: PASS after retry cancellation handling was added.

### API and messaging: LINE webhook redelivery receipts

- Audited the signed raw-body LINE webhook receiver, its file-backed inbox mutation path, and focused route/store tests against LINE's current webhook-redelivery contract and established webhook idempotency practice.
- Fixed verified persistence failure handling: a write failure now returns `503` rather than acknowledging an event that LINE may need to redeliver. Partial writes remain safe because successful events are retained as delivery receipts before the retry.
- Added a bounded, backwards-compatible receipt ledger separate from inbox capacity. LINE's stable `webhookEventId` is used as the receipt key, while the existing provider/source/message identity remains the fallback for callers without a delivery key. `appendInbound` now reports whether it inserted so webhook responses accurately count new entries.
- The ledger keeps 10,000 receipt keys. LINE does not disclose its retry count or interval and says they may change, so behavior beyond that bounded retention is intentionally documented as best-effort rather than overstated as an absolute guarantee.
- Covered ordinary duplicate delivery, capacity eviction, legacy pre-receipt inbox entries that later receive an event key, `stored: 0` no-op accounting, and `503` retry signaling.
- Verified with `pnpm --filter @muse/messaging exec vitest run test/messaging.test.ts` (97 passed), `pnpm --filter @muse/messaging build`, `pnpm --filter @muse/api exec vitest run test/messaging-webhooks.test.ts` (6 passed), and `pnpm --filter @muse/api build`.
- Independent runtime-contract review: PASS after receipt-backfill migration coverage.

### API and messaging: durable channel-poll cursor commits

- Audited the Discord and Slack polling cursor flow from remote response through the generic API poller and local inbox store. The prior ordering advanced a provider cursor before the inbox append, so a local write failure could permanently skip remote messages.
- Added a shared `PollingFetchOptions` contract: durable pollers defer cursor advancement, persist the complete batch, then explicitly commit. Direct provider polling preserves its immediate-cursor behavior for compatibility.
- Cursor state is now split between a fetched-but-not-persisted stage and an inbox-durable-but-not-yet-written committable stage. Append failures discard only the first; cursor-write failures retain the second for a later retry, including an empty subsequent poll.
- The generic poller commits all-filtered raw batches too, so events intentionally excluded from the text inbox do not replay forever. Ingest logging now counts only actual inbox insertions rather than duplicate deliveries.
- Discord's official channel endpoint documents `after` as a message-ID boundary; Slack documents `oldest` as an exclusive timestamp boundary. Both cursor writes therefore occur only after the local at-least-once boundary succeeds.
- Covered deferred Discord/Slack provider commits, append failure followed by an empty poll, cursor-write failure followed by an empty poll, direct polling compatibility, wrapper behavior, and single-flight behavior.
- Verified with `pnpm --filter @muse/messaging exec vitest run test/deferred-cursor-polling.test.ts test/messaging.test.ts test/slack-provider-contract.test.ts test/discord-after-store.test.ts` (110 passed), `pnpm --filter @muse/api exec vitest run test/channel-poll-tick.test.ts test/discord-poll-tick.test.ts test/slack-poll-tick.test.ts` (24 passed), `pnpm --filter @muse/messaging exec tsc -b --force`, and `pnpm --filter @muse/api exec tsc -b --force`.
- Independent runtime-contract review: PASS after staged-versus-committable cursor recovery coverage.

### Web: shared streaming request lifecycle

- Audited the web chat and grounded-ask streaming hooks against React cleanup semantics and the Fetch/ReadableStream abort contract. Chat already owned request cancellation; ask did not, so a reset or unmount could leave its request consuming an SSE response and let late callbacks overwrite fresh state.
- Extracted the shared one-active-request lifecycle into a web-local module. It synchronously rejects re-entry, aborts and invalidates a reset/unmounted request, and allows only the active request to finish its pending state.
- Preserved `createChatStreamRequestLifecycle` as a compatibility export while migrating chat to the shared implementation. Ask now passes its request signal to `fetch`, aborts on reset and cleanup, and gates buffered-response, SSE-delta, error, and `finally` updates by request identity.
- Verified with `pnpm --filter @muse/web exec vitest run src/api/useAskStream.test.ts src/api/useChatStream.lifecycle.test.ts src/api/useChatStream.conversationId.test.ts src/api/useChatStream.commit.test.ts src/api/useChatStream.pendingApprovals.test.ts` (43 passed) and `pnpm --filter @muse/web build`.
- Independent runtime-contract review: PASS.

### API: channel-daemon supervisor lifecycle transitions

- Audited daemon replacement and server-shutdown ownership against Node's synchronous callback semantics and established supervisor shutdown practice.
- Fixed a re-entrant replacement defect: a retiring handle could synchronously call back into `stop(name)` after its replacement had been registered, stopping the replacement while leaving its status marked as running.
- `adopt` now makes replacement transitions explicit, treats duplicate adoption of the same live handle as idempotent, and rejects registrations attempted by a retiring handle. `stopAll` is explicitly terminal because its sole call site is Fastify's `onClose` hook: it rejects both re-entrant and late asynchronous registrations after shutdown begins.
- Cleanup is also handle-identity re-entrant safe, and replacement state retains the candidate identity so callbacks that re-adopt the same candidate neither recursively stop it nor publish an already-stopped handle.
- Added regressions for retiring-handle re-entry, same-candidate re-adoption, duplicate adoption, re-entry during complete shutdown, shutdown-time sibling adoption, self-adoption during cleanup, and a post-shutdown registration.

### Stores: daemon-settings schema compatibility

- Audited the shared daemon-settings file, its API compatibility re-export, CLI/API mutation callers, lock-backed read-modify-write path, and existing cross-process durability tests against secure configuration and restoration guidance.
- Fixed a forward-compatibility data-loss path: a settings file marked with a newer or unsupported schema version was accepted and then rewritten as version 1 by either flags or quiet-hours mutation, discarding unknown top-level data.
- Legacy unversioned object files remain writable and are upgraded to v1. Any other version marker, or any non-object JSON root, now fails closed while the file lock is held, so both writers leave the original file byte-for-byte intact until the user upgrades Muse.
- The shared typed format error is mapped to HTTP `409` for both web settings PATCH endpoints and to a concise stderr/nonzero result for `muse quiet`, rather than a generic server failure or raw CLI rejection.
- Added coverage for legacy migration, future versions, non-object JSON roots, both mutation APIs, HTTP conflict responses, and the CLI diagnostic path.

### Rust runner: tool-controlled environment execution boundary

- Audited command spawning, process-group cleanup, pipe draining, Seatbelt path handling, and the request environment filter against current Rust, Git, Cargo, and OpenSSH documentation.
- Confirmed existing timeout, descendant process-group cleanup, bounded output, UTF-8 truncation, and canonicalized Seatbelt-path contracts; no speculative lifecycle rewrite was made.
- Fixed an environment-injection gap: request-controlled `GIT_EXEC_PATH`, Git template/config/editor variants and global/repository config-discovery roots, Cargo/Rustup compiler/wrapper/rustflags/credential-provider/target/toolchain configuration and config-discovery roots, and OpenSSH askpass/security-key-provider variables could select executables, hooks, or libraries after a bare command passed the runner's path guard.
- Added explicit exact and prefix-owned denials while preserving ordinary uppercase environment variables such as `GIT_AUTHOR_NAME` and `MUSE_RUNNER_LABEL`.
- The config-root boundary also covers Windows `USERPROFILE` and Git's `HOMEDRIVE`/`HOMEPATH` fallback, so request input cannot reactivate OpenSSH user config or platform-specific Git global config discovery.
