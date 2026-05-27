# 669 — `DiscordProvider` and `SlackProvider` adopt the shared `fetchWithTimeout` helper on both their inbound-poll and outbound-send calls, completing the messaging-provider timeout sweep goal 668 started on Telegram

## Why

Goal 668 added `fetchWithTimeout` (AbortController + 30s
default) to `@muse/messaging` and wired it into the
`TelegramProvider`. Its Remaining Risks named the obvious
next adopters:

> Discord (`discord-provider.ts`), Slack
> (`slack-provider.ts`), LINE outbound still fetch without
> `fetchWithTimeout`. Sibling-fixable — each can adopt the
> now-shared helper.

Both providers had two un-timed `this.fetchImpl(...)` calls
each:

- **Discord**: `fetchMessages` (channel-history poll) +
  `send` (`POST .../messages`).
- **Slack**: `fetchHistory` (`conversations.history` poll) +
  `send` (`chat.postMessage`).

Same hazard as Telegram: a stalled TCP connection to the
Discord / Slack API (dead socket, network black-hole, hung
proxy) leaves the `fetch` hanging forever — neither
resolving nor rejecting. Consequences:

- The Phase-2.c (Discord) / Phase-2.d (Slack) polling
  daemons call the poll path on a `setInterval` cadence with
  a single-flight guard; a hung poll holds the in-flight
  flag forever, and the daemon silently stops ingesting that
  channel's messages.
- A `send` to a wedged connection stalls the proactive
  notice / reply firing path.

This iter routes all four fetches through `fetchWithTimeout`,
matching the Telegram wiring exactly. After this, all three
REST-polling messaging providers (Telegram, Discord, Slack)
are timeout-bounded on both directions.

### Defect class

**HTTP fetch with no client timeout guard** — second
consecutive iter in this class (668 = Telegram, 669 =
Discord + Slack). This is the *completion slice* of the
messaging-timeout sweep, not class drift: 668 built the
shared helper and proved it on the primary channel; 669
applies the same helper to the remaining two REST providers
so the coverage is uniform. 2 of the last 10 iters in this
class — under the 3-in-10 redirect threshold.

Recent 10-iter window:

- 668: Telegram fetch timeout
- 667: route to shared helper (listen)
- 666: route to shared helper (proactive)
- 665: execution-layer clamp
- 664: config upper bound
- 663: route to shared helper (embed)
- 662: mkdtempSync cleanup
- 661: concurrent RMW race
- 660: Promise.race timer leak
- 659: HTTP redirect SSRF

## Slice

- `packages/messaging/src/discord-provider.ts`:
  - Imported `fetchWithTimeout`.
  - `DiscordProviderOptions` gains `timeoutMs?: number`
    (default 30s via the helper), stored as a private field.
  - `fetchMessages` poll + `send` both route through
    `fetchWithTimeout(this.fetchImpl, url, init,
    this.timeoutMs)`.
- `packages/messaging/src/slack-provider.ts`:
  - Same: import, `timeoutMs?` option + field, both
    `conversations.history` poll and `chat.postMessage` send
    routed through `fetchWithTimeout`.
- `packages/messaging/test/messaging.test.ts`:
  - **Two new tests** (one per provider): a never-resolving
    fetch + `timeoutMs: 10` → `send(...)` rejects with
    `/timed out after 10ms/`. The fake fetch attaches a
    reject-on-abort listener to the forwarded signal,
    proving the abort propagates.

## Verify

- `pnpm --filter @muse/messaging test`: 190 passed (188
  prior + 2 new). Full `pnpm check`: every workspace green;
  tsc strict EXIT=0.
- **Clean-mutation-proven**: reverting the Discord `send`
  back to a bare `this.fetchImpl(url, init)` makes EXACTLY
  the Discord timeout test fail — the never-resolving fetch
  no longer receives an abort signal, so the test hangs to
  vitest's 5s test timeout and fails (confirmed: 1 failed).
  The Slack test and all other messaging tests pass either
  way. Restored; all green.
- `pnpm lint`: 0 errors / 0 warnings.
- `pnpm guard:core`: clean.
- Byte-hygiene scan on the three touched files: clean.
- **`smoke:live` not run**: Discord / Slack Bot-API HTTP
  paths, not the Ollama / model wire. The tests stub fetch.
  A real round-trip would need live bot tokens (forbidden —
  cloud credentials). The timeout behavior is fully covered
  by the unit tests + `fetchWithTimeout`'s own tests (goal
  668).

## Status

Done. All three REST-polling messaging providers are now
timeout-bounded on both inbound poll and outbound send:

| Provider  | Inbound poll                  | Outbound send                 |
| --------- | ----------------------------- | ----------------------------- |
| Telegram  | timed out (goal 668)          | timed out (goal 668)          |
| Discord   | **timed out (this iter)**     | **timed out (this iter)**     |
| Slack     | **timed out (this iter)**     | **timed out (this iter)**     |
| LINE      | webhook-inbound (no poll)     | outbound un-timed (sibling)   |

A stalled connection to any of the three Bot APIs now fails
fast at 30s (default) instead of silently wedging the
polling daemon or the send path.

## Decisions

- **Identical wiring to Telegram (goal 668)** — same
  `timeoutMs?` option, same private field, same
  `fetchWithTimeout(this.fetchImpl, url, init,
  this.timeoutMs)` call shape. Uniformity across providers
  means an operator reasons about one timeout knob, not
  three different ones.
- **Both directions per provider** — the poll is the
  silent-deafness risk (daemon stops ingesting); the send
  is the stalled-tick risk (proactive firing blocks). Both
  matter, so both fetches are bounded.
- **One test per provider, on the send path** — the send
  path is the simplest to exercise (no cursor-file / inbox
  branching) and proves the `timeoutMs` is threaded into
  `fetchWithTimeout`. The poll path uses the same helper
  call, so the send test covers the wiring; `fetchWithTimeout`
  itself has the full behavioral suite (goal 668).
- **Did NOT wire LINE outbound** — LINE is webhook-inbound
  (no poll loop), and its outbound push is a single
  lower-frequency call. Sibling-fixable; lowest leverage of
  the four.
- **Mutation choice** — reverted the Discord send to bare
  `fetchImpl`. The Discord timeout test hangs to vitest's
  5s limit and fails; the Slack test (independent provider)
  and all others pass. Surgical proof that the wiring, not
  just the helper, is what bounds the call.

## Remaining risks

- **LINE outbound** (`line-provider.ts`) still fetches
  without `fetchWithTimeout`. Lowest-leverage adopter
  (single push, no poll loop). Sibling-fixable.
- **`response.text()` after the fetch** is still unbounded
  by the timeout (timer cleared once the fetch resolves) —
  same note as goal 668. Discord / Slack responses are
  small JSON; a body cap would close the slow-drip-body
  edge but is low priority.
- **`timeoutMs` not env-configurable** per provider yet —
  an operator on a high-latency link must construct the
  provider with a custom `timeoutMs`. A future iter could
  wire `MUSE_<PROVIDER>_TIMEOUT_MS` through the
  autoconfigure messaging-registry builder for all three at
  once.
- **The polling daemons' single-flight guards** now see a
  rejection (timeout) instead of a hang — the tick must
  catch + log + release the in-flight flag. The existing
  tick wrappers do this (verified for Telegram in goal 668;
  Discord / Slack ticks follow the same shape).
