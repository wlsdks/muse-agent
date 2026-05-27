# 668 — `@muse/messaging` gains a shared `fetchWithTimeout` helper (AbortController + 30s default) and the `TelegramProvider` wires it into both its `getUpdates` poll and `sendMessage` calls so a stalled Bot-API connection can't hang the polling daemon's inbound tick — or a proactive send — forever

## Why

`TelegramProvider.pollUpdates` and `TelegramProvider.send`
both called `this.fetchImpl(url, init)` with **no client
timeout**:

```ts
// pollUpdates:
const response = await this.fetchImpl(url, { method: "GET" });
// send:
const response = await this.fetchImpl(`${baseUrl}/bot${token}/sendMessage`, { ... });
```

The poll URL passes `&timeout=0` — but that's Telegram's
*server-side* long-poll timeout, not the HTTP *client's*
socket timeout. If the TCP connection stalls (dead socket,
a network black-hole between Muse and `api.telegram.org`,
a hung proxy), the `fetch` never resolves and never
rejects. Consequences:

- **Inbound poll tick hangs**. The Phase-2.a polling
  daemon (`telegram-poll-tick.ts`) calls `pollUpdates` on
  a `setInterval` cadence with a single-flight guard.
  A hung poll holds the in-flight flag forever — the
  daemon stops ingesting Telegram messages silently.
  Muse goes deaf on its primary inbound channel with no
  error.
- **Proactive send hangs**. A `send` to a wedged
  connection blocks the proactive notice / reminder
  firing path; the daemon's tick stalls.

Node's global `fetch` (undici) has no default request
timeout — only OS-level TCP timeouts (minutes), and those
only fire on connect, not on a mid-stream stall.

The fix mirrors the pattern goals 648 (`embed`) and 636
(`loadFeedBody`) established: `AbortController` +
`setTimeout`, forward the signal into the fetch (active
cancellation), translate the abort into a clear "timed
out after Nms" error with the original cause, clear the
timer in `finally`. Lifted into a shared
`provider-helpers.ts:fetchWithTimeout` so Discord / Slack /
LINE can adopt it next.

### Defect class

**HTTP fetch with no client timeout guard** — last hit
goal 648 (`embed`, 20 iters ago; 0 of last 10 in this
class). Fresh against the recent 10-iter window:

- 667: route to shared helper (listen)
- 666: route to shared helper (proactive)
- 665: execution-layer clamp
- 664: config upper bound
- 663: route to shared helper (embed)
- 662: mkdtempSync cleanup
- 661: concurrent RMW race
- 660: Promise.race timer leak
- 659: HTTP redirect SSRF
- 658: sort comparator tiebreaker

Distinct site (the messaging layer, never touched for
timeouts) and distinct consequence (the inbound poll
daemon goes silently deaf) from the embed / feed cases.

## Slice

- `packages/messaging/src/provider-helpers.ts`:
  - **New `DEFAULT_PROVIDER_FETCH_TIMEOUT_MS = 30_000`**.
  - **New `fetchWithTimeout(fetchImpl, url, init,
    timeoutMs?)`** — AbortController + setTimeout, signal
    forwarded into the fetch, abort → `"request to <url>
    timed out after Nms"` with the original cause, timer
    cleared in `finally`. Non-finite / non-positive
    `timeoutMs` falls back to the 30s default.
- `packages/messaging/src/telegram-provider.ts`:
  - Imported `fetchWithTimeout`.
  - `TelegramProviderOptions` gains an optional
    `timeoutMs?: number` (default 30s via the helper).
  - `pollUpdates` and `send` both route through
    `fetchWithTimeout(this.fetchImpl, url, init,
    this.timeoutMs)`.
- `packages/messaging/src/provider-helpers.test.ts`:
  - **Four new tests**:
    1. **Timeout fires** — a never-resolving fetch +
       10ms timeout rejects with `/timed out after 10ms/`,
       AND the captured AbortSignal is an `AbortSignal`
       with `aborted === true` (active cancellation, not
       just promise abandonment).
    2. **Fast path** — an immediately-resolving fetch
       returns the response (timer cleared, no leak).
    3. **Non-abort error re-thrown verbatim** — a
       `Promise.reject(ECONNRESET)` propagates as-is; only
       an actual abort becomes a "timed out" error.
    4. **Default constant** — `DEFAULT_PROVIDER_FETCH_TIMEOUT_MS
       === 30_000`.

## Verify

- `pnpm --filter @muse/messaging test`: 188 passed (184
  prior + 4 new). Full `pnpm check`: every workspace
  green; tsc strict EXIT=0.
- **Clean-mutation-proven**: changing the helper's
  `setTimeout(() => controller.abort(), ...)` to a no-op
  (`setTimeout(() => undefined, ...)`) makes EXACTLY the
  "timeout fires" test fail — the never-resolving fetch
  never aborts, so the test hangs to vitest's 5s test
  timeout and fails (confirmed: 1 failed, the timeout
  test). The fast-path, non-abort-error, and default-
  constant tests pass either way. Restored; all green.
- `pnpm lint`: 0 errors / 0 warnings.
- `pnpm guard:core`: clean.
- Byte-hygiene scan on the three touched files: clean.
- **`smoke:live` not run**: the change is on the Telegram
  Bot-API HTTP path, not the Ollama / model wire. The
  test stubs fetch. A real Telegram round-trip would need
  a live bot token (forbidden — cloud credential). The
  helper's timeout behavior is fully covered by the unit
  tests with a fake fetch.

## Status

Done. The Telegram inbound poll + outbound send can no
longer hang on a stalled connection:

| Bot-API connection state                    | Pre-fix                              | Post-fix                          |
| -------------------------------------------- | ------------------------------------ | --------------------------------- |
| Healthy                                      | OK                                   | unchanged                         |
| Server-side long-poll (timeout=0, fast)      | OK                                   | unchanged                         |
| TCP stall mid-request (dead socket)          | **poll tick hangs forever; Muse goes deaf** | times out at 30s (**fixed**) |
| Network black-hole to api.telegram.org       | **send hangs; proactive tick stalls**| times out at 30s (**fixed**)      |
| Connection reset (ECONNRESET)                | rejects with the error               | unchanged (re-thrown verbatim)    |

## Decisions

- **Shared helper in `provider-helpers.ts`**, not inline
  per fetch. Telegram has two fetch sites; Discord / Slack
  / LINE have more. One helper avoids the
  triple-paste the file's own docstring warns against
  ("Telegram, Discord, and Slack landed independent
  inbound fetchers and started cloning identical bits").
- **30s default**, matching the `embed` (648) and
  `loadFeedBody` (636) convention. Telegram's `getUpdates`
  with `timeout=0` returns near-instantly when healthy;
  30s is generous headroom for a slow-but-alive
  connection while bounding a true stall.
- **`timeoutMs` optional on the provider**, threaded from
  the constructor. The polling daemon could pass a tighter
  value (it polls frequently); the default suits the
  one-shot CLI path.
- **Signal forwarded into the fetch**, not just a
  Promise.race. Abandoning the promise alone leaves the
  socket open until the OS TCP timeout (minutes). The
  active `controller.abort()` cancels the in-flight
  request. Test 1 pins `signal.aborted === true`.
- **Abort → "timed out" only when `controller.signal.aborted`**.
  A network error that rejects *before* the timeout
  (ECONNRESET) is re-thrown verbatim — the caller's
  existing `MessagingProviderError` wrapping classifies
  it. Test 3 pins this.
- **Did NOT wire Discord / Slack / LINE in this iter** —
  tight scope. They're the obvious sibling adopters of
  `fetchWithTimeout`; each is its own iter. Telegram is
  the highest-leverage (it's the primary inbound poll
  daemon).
- **Mutation choice**. No-op'd the `controller.abort()`
  callback. The timeout test hangs to vitest's 5s limit
  and fails; the other three pass. Surgical proof of the
  abort's role.

## Remaining risks

- **Discord (`discord-provider.ts`), Slack
  (`slack-provider.ts`), LINE outbound** still fetch
  without `fetchWithTimeout`. Sibling-fixable — each can
  adopt the now-shared helper. Telegram was done first as
  the primary inbound channel.
- **`response.text()` after the fetch** is still
  unbounded by the timeout (the timer is cleared in
  `finally` once the fetch resolves). A slow-drip body
  after headers complete could stall the `.text()` read.
  In practice Telegram responses are small JSON; a body
  cap (goal 649's pattern) on the messaging path would
  close this — deferred, low priority for the small-JSON
  Bot-API responses.
- **The polling daemon's single-flight guard** means a
  timed-out poll now rejects (instead of hanging), which
  the daemon's tick should catch + log + release the
  flag. Verified the tick wraps `pollUpdates` so the
  rejection releases the in-flight flag rather than
  wedging it.
- **`timeoutMs` is not env-configurable** at the provider
  level yet. An operator on a high-latency link who needs
  more than 30s must construct the provider with a custom
  `timeoutMs`. Future iter could wire
  `MUSE_TELEGRAM_TIMEOUT_MS` through the autoconfigure
  messaging-registry builder.
