# 672 — `LineProvider.send` adopts the shared `fetchWithTimeout` helper on its push call, so a stalled LINE Messaging API connection can't hang the proactive send path — the final provider, completing the messaging-provider timeout sweep (goals 668 → 669 → 672)

## Why

`LineProvider.send` POSTed to LINE's `/v2/bot/message/push`
via a bare `this.fetchImpl(...)` with no client timeout. A
stalled TCP connection to `api.line.me` (dead socket,
network black-hole, hung proxy) leaves the `fetch` hanging
forever — neither resolving nor rejecting — stalling the
proactive notice / reminder firing path that routes through
LINE.

LINE differs from Telegram / Discord / Slack in that it's
**webhook-inbound** (no poll loop), so only the outbound
push needed the guard. That made it the lowest-leverage of
the four providers — which is why goals 668 (Telegram) and
669 (Discord + Slack) deferred it. This iter closes it,
finishing the sweep: all four messaging providers now bound
every outbound (and, where applicable, inbound-poll) HTTP
call with the shared `fetchWithTimeout` (AbortController +
30s default).

### Defect class

**HTTP fetch with no client timeout guard** — the final
slice of the messaging-timeout epic (668 built the shared
helper + Telegram; 669 added Discord + Slack; 672 adds
LINE). 2 of the last 10 iters were in this class (668,
669) — under the 3-in-10 stagnation threshold, so
completing the epic's last slice this iter is sanctioned
("advance the oldest open epic's next undone slice").

Recent 10-iter window:

- 671: web-search maxUses settings strictness
- 670: calendar local-timezone render
- 669: Discord/Slack fetch timeout
- 668: Telegram fetch timeout
- 667/666: route to synthesizeAndPlay
- 665: execution-layer clamp
- 664: config upper bound
- 663: route to shared embed
- 662: mkdtempSync cleanup

## Slice

- `packages/messaging/src/line-provider.ts`:
  - Imported `fetchWithTimeout`.
  - `LineProviderOptions` gains `timeoutMs?: number` (default
    30s via the helper), stored as a private field.
  - `send`'s push POST routes through
    `fetchWithTimeout(this.fetchImpl, url, init,
    this.timeoutMs)`.
- `packages/messaging/test/messaging.test.ts`:
  - **One new test**: a never-resolving fetch + `timeoutMs:
    10` → `send(...)` rejects with `/timed out after 10ms/`.
    The fake fetch attaches a reject-on-abort listener to the
    forwarded signal, proving the abort propagates.

## Verify

- `pnpm --filter @muse/messaging test`: 191 passed (190
  prior + 1 new). Full `pnpm check`: every workspace green;
  tsc strict EXIT=0.
- **Clean-mutation-proven**: reverting the LINE `send` back
  to a bare `this.fetchImpl(url, init)` makes the new LINE
  timeout test hang to vitest's 5s test timeout and fail
  (confirmed with a hard `timeout 30` that the reverted test
  never completes — the never-resolving fetch no longer
  receives an abort signal). Restored; all green.
- `pnpm lint`: 0 errors / 0 warnings.
- `pnpm guard:core`: clean.
- Byte-hygiene scan on the two touched files: clean.
- **`smoke:live` not run**: LINE Messaging API HTTP path,
  not the Ollama / model wire. The test stubs fetch. A real
  round-trip needs a live channel access token (forbidden —
  cloud credential). The timeout behavior is fully covered
  by the unit test + `fetchWithTimeout`'s own suite (668).

## Status

Done. Every messaging provider now bounds its HTTP calls
with `fetchWithTimeout`:

| Provider  | Inbound                          | Outbound send                 |
| --------- | -------------------------------- | ----------------------------- |
| Telegram  | timed-out poll (668)             | timed-out (668)               |
| Discord   | timed-out poll (669)             | timed-out (669)               |
| Slack     | timed-out poll (669)             | timed-out (669)               |
| LINE      | webhook (no poll)                | **timed-out (this iter)**     |

The messaging-provider timeout sweep is complete: no
provider's HTTP call can silently hang the polling daemon
or the proactive firing path on a stalled connection.

## Decisions

- **Identical wiring to Telegram / Discord / Slack** — same
  `timeoutMs?` option, same private field, same
  `fetchWithTimeout(this.fetchImpl, url, init,
  this.timeoutMs)` call shape. One timeout knob across all
  four providers.
- **Only the send path** — LINE is webhook-inbound (no poll
  loop calling the LINE API), so there's no inbound fetch to
  bound. `fetchInbound` reads the persisted webhook inbox
  file (local I/O, no network).
- **One test, on the send path** — the only HTTP call LINE
  makes. `fetchWithTimeout` itself has the full behavioral
  suite (668); this test confirms the wiring threads
  `timeoutMs` through.
- **Mutation choice** — reverted the LINE send to bare
  `fetchImpl`. The LINE timeout test hangs to vitest's 5s
  limit and fails; all other messaging tests pass. Surgical
  proof.

## Remaining risks

- **The messaging-timeout sweep is complete** — all four
  providers' HTTP calls are bounded. No further timeout
  gaps in the messaging layer.
- **`response.text()` after the fetch** is still unbounded
  by the timeout (timer cleared once the fetch resolves) —
  the same note carried from 668/669. LINE responses are
  tiny (`{}` on success), so a slow-drip body is not a
  realistic concern here.
- **`timeoutMs` not env-configurable** per provider — an
  operator on a high-latency link must construct the
  provider with a custom `timeoutMs`. A future iter could
  wire `MUSE_<PROVIDER>_TIMEOUT_MS` through the
  autoconfigure messaging-registry builder for all four at
  once now that the sweep is uniform.
- **The notification-only providers** (macOS notification,
  Linux libnotify) already have their own SIGKILL-watchdog
  timeouts on the spawned `osascript` / `notify-send`
  child processes (not HTTP, so `fetchWithTimeout` doesn't
  apply) — they were never part of this HTTP-timeout sweep.
