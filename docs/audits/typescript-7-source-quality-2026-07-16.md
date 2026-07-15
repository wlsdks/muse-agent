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

## Follow-up

- Continue the package/app ledger in dependency order. A source review is not a
  completion claim for callers or downstream registration paths.
- Re-audit changed seams after all package and application entries exist.
- Perform independent final review and the final requirement-by-requirement
  completion audit before closing the program.
