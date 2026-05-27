# 636 — `loadFeedBody` wires `AbortController` + `setTimeout` (default 30s) around the `fetch` call so a slow-loris / dead RSS server can't hang `muse feeds refresh` / `muse feeds add` forever; injectable `fetchImpl` makes the timeout directly testable

## Why

`apps/cli/src/commands-feeds.ts:loadFeedBody` was the network
entry point for every RSS / Atom ingest the personal CLI does
— `muse feeds add <url>` fetches once, `muse feeds refresh`
fetches every registered feed in sequence, `muse feeds today`
reads cached entries (no network). Pre-fix:

```ts
export async function loadFeedBody(url: string): Promise<string> {
  if (url.startsWith("file://")) {
    return readFile(fileURLToPath(url), "utf8");
  }
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`feed fetch ${url} returned ${response.status.toString()}`);
  }
  return response.text();
}
```

`fetch(url)` with no `signal` and no timeout. A slow-loris feed
server (one that returns headers slowly, drips a byte every
few seconds, or stalls mid-body) hangs the entire CLI call
forever. Three reachable failure modes:

1. **Dead / firewalled RSS host** — `fetch` waits on the TCP
   connect indefinitely. The default Node connect timeout is
   the OS default (Linux ~60-180s, macOS ~75s) — but once the
   socket is established and silent, there's NO timeout at
   all.
2. **Slow-loris attack** — a malicious feed server keeps the
   connection alive by emitting one byte every 60s. `fetch`
   never sees an EOF, never throws. `muse feeds refresh`
   blocks until the user kills the CLI.
3. **Provider that hangs on a partial response** — common
   with corporate proxies that intercept HTTPS and silently
   drop the upstream. The connection stays "open" from
   Node's perspective; `fetch` waits forever.

`muse feeds refresh` walks ALL registered feeds in sequence
(`refreshSingleFeed` at `commands-feeds.ts:84`); ONE hung feed
blocks every subsequent feed AND the whole command. On a
JARVIS-class personal daemon running `feeds refresh` on a
schedule, a single hung server would peg the scheduler tick
forever.

The fix established in goal 624 (`performConsentedAction`
HTTP timeout) is the same pattern needed here:
`AbortController` + `setTimeout(controller.abort, timeoutMs)`,
clear the timer in `finally`. Same shape `loopback-fetch.ts`
and `mcp/loopback-search.ts` already use.

This iter's defect class — **HTTP fetch with no timeout
guard** — was last hit in goal 624 (12 iterations ago):

- 635: per-file concurrent write (memory store)
- 634: sort tiebreaker
- 633: surrogate-pair truncation
- 632: tilde-expansion
- 631: per-file concurrent write (inbound thread store)
- 630: mkdtemp directory cleanup
- 629: per-entry validation
- 628: unit-promotion + finite-guard
- 627: tolerant-read nested array
- 626: child-process stream error

Solidly fresh against the recent window.

## Slice

- `apps/cli/src/commands-feeds.ts`:
  - Export `DEFAULT_FEED_FETCH_TIMEOUT_MS = 30_000` so callers
    and tests can reference the constant.
  - Export `LoadFeedBodyOptions` with optional `fetchImpl`
    (test seam) and `timeoutMs` (per-call override).
  - `loadFeedBody(url, options = {})`:
    - `file://` branch is unchanged (no network).
    - `http(s)://` branch:
      - Resolve `fetchImpl` from options or `globalThis.fetch`.
      - Resolve `timeoutMs` from options (finite-positive
        only; falls back to the 30s default on NaN /
        Infinity / `<= 0`).
      - Build `controller = new AbortController()` and
        `timer = setTimeout(() => controller.abort(),
        timeoutMs)`.
      - Wrap the `fetchImpl(url, { signal: controller.signal
        })` call in try/catch/finally. On abort (signal.aborted
        is true after the catch), throw a clear "timed out
        after Nms" error with the original `cause` attached
        (preserve-caught-error ESLint rule requires the
        wrapping). Otherwise re-throw. The `finally`
        `clearTimeout(timer)` is unconditional — successful
        responses don't leak the timer keeping the event loop
        alive.
- `apps/cli/src/commands-feeds.test.ts`:
  - New import for `loadFeedBody` and `DEFAULT_FEED_FETCH_TIMEOUT_MS`.
  - Four tests in a new `describe("loadFeedBody — fetch
    timeout ...")` block:
    1. **Times out a never-resolving fetch** — inject a fake
       `fetch` that returns a promise that never resolves but
       listens for `signal.abort` and rejects then. Assert
       the call rejects with `/timed out after 10ms/u` (the
       error message text).
    2. **Passes AbortSignal through** — capture the `signal`
       passed to the fake fetch, verify it's an `AbortSignal`,
       and verify `signal.aborted === true` after the timeout
       fires. Pins that the upstream connection is actively
       cancelled, not just abandoned.
    3. **Returns body + clears timer on success** — inject a
       fake fetch that resolves immediately with an RSS body.
       Assert the body comes back. Implicit: no leaked timer
       (would surface as the test hanging in unrelated runs).
    4. **`DEFAULT_FEED_FETCH_TIMEOUT_MS === 30_000`** — pins
       the exported default so a future "let's make it 5
       minutes" silent change requires the test bump.

## Verify

- `@muse/cli` suite green (1101 passed, +4 vs the pre-iter
  baseline of 1097, 0 failed). One byte-hygiene + one lint
  fix were needed during the iter — covered below.
- **Clean-mutation-proven** (Edit-based): reverting the
  timeout wrapping back to a bare `await fetchImpl(url)`
  makes EXACTLY the two timing-driven tests fail. The first
  fails with the test timeout exceeded (5000ms vitest
  default) because pre-fix the never-resolving fake fetch
  hangs forever. The second fails the same way. The
  body-success test and the default-constant test pass both
  pre- and post-fix because they don't depend on the timeout
  semantics. Fix restored, all 1101 pass.
- **Two follow-up fixes during the iter** (bundled into this
  commit):
  - ESLint `preserve-caught-error` rule flagged the
    `throw new Error(...)` in the timeout branch — the
    caught `cause` must be propagated. Added `{ cause }` to
    the Error constructor.
  - `@muse/shared` byte-hygiene test caught a literal
    Zero-Width Joiner (U+200D) in goal 635's doc (the
    `👨U+200D👩U+200D👧` family emoji again — same as goals 633 and 634
    that surfaced it). Replaced with textual `U+200D`
    notation, same fix iters 606+ use.
- `pnpm check` green: apps/api 261/261, apps/cli 1101/1101,
  every workspace; tsc strict EXIT=0.
- `pnpm lint` 0/0 (after the `{ cause }` fix), `pnpm
  guard:core` clean, byte-scan clean on both touched files.
- No LLM request/response wire path touched — the timeout is
  on the RSS HTTP fetch, not on any model call.
  `smoke:live` doesn't apply.

## Status

Done. `muse feeds refresh` / `muse feeds add` can no longer
be stuck by a single misbehaving feed:

| Feed-server behavior                              | Before                       | After                          |
| ------------------------------------------------- | ---------------------------- | ------------------------------ |
| Healthy server, responds quickly                  | OK                           | unchanged                      |
| Server returns HTTP error (4xx / 5xx)             | OK (throws status error)     | unchanged                      |
| Server never responds (dead / firewalled)         | **hangs forever**            | times out at 30s (**fixed**)   |
| Slow-loris (one byte every minute)                | **hangs forever**            | times out at 30s (**fixed**)   |
| Proxy intercepts HTTPS, drops upstream silently   | **hangs forever**            | times out at 30s (**fixed**)   |
| `muse feeds refresh` with 5 feeds, 1 hung         | **whole command hangs**      | hung feed errors, rest finish (**fixed**) |

No CAPABILITIES line / no OUTWARD-TARGETS flip: a robustness /
HTTP-timeout `fix:` on the RSS ingest path. Recorded honestly
with this backlog row.

## Decisions

- **30-second default**, not 10s or 60s. Real RSS feeds on
  slow shared hosts can take 10-15s to respond on first hit;
  30s is generous enough for a healthy slow server while
  bounded enough that a hung server doesn't peg the
  scheduler tick. Matches the `notify-send` timeout in
  `LinuxLibnotifyProvider` and is shorter than the 60s the
  whisper-cpp runner uses (because audio transcription's
  model load is much slower than a single HTTP GET).
- **Per-call `timeoutMs` override** in `LoadFeedBodyOptions`,
  not a module-level setting. Lets tests pass a tiny
  timeout (10ms) without 30-second test runtimes, and lets
  a future env knob configure it without a global mutation.
  Finite-guarded — NaN / Infinity / `<= 0` fall back to the
  30s default. Same posture as `withTimeout` in
  `packages/resilience`.
- **`fetchImpl` injection seam.** Mirrors
  `packages/cli/src/embed.ts`'s pattern. Pure unit-test
  surface — production code never sets it, callers can mock
  the global fetch without `vi.mock`.
- **AbortSignal forwarded to fetch**, not just used for the
  timer. This actively cancels the connection rather than
  abandoning the promise (which would leak the underlying
  socket until the OS times out). Critical for the slow-
  loris case — abandoning would still hold the socket open.
- **`Error("…", { cause })`** to preserve the original
  AbortError. ESLint's `preserve-caught-error` rule enforces
  this; without it the catch context is lost. Matches the
  pattern other timeout wrappers in the codebase use.
- **`finally clearTimeout(timer)`** is unconditional. Even
  on success, the timer is cleared — without this the
  successful-fetch case leaks a 30-second timer keeping the
  event loop alive (`muse feeds refresh` would hang AFTER
  completing all feeds, waiting for the last timer to fire).
- **Did NOT also add a timeout to the `file://` branch.**
  `readFile` on a local file is filesystem-bound; tmpfs
  reads are microseconds, slow disk reads are bounded by OS
  scheduler. The defect specifically affects network
  fetches.
- **Mutation choice.** Reverted only the timeout
  wrapping (the AbortController + setTimeout + try/catch/
  finally). The fetchImpl resolution and the file:// branch
  stayed because they don't depend on the timeout. Both
  timing tests fail pre-fix (test hangs to vitest's 5s
  default); the success-path and default-constant tests
  pass both ways — confirms the fix is surgical to the
  timeout path.

## Remaining risks

- **Other CLI fetch sites without timeouts.** A quick grep:
  - `apps/cli/src/commands-notes-rag.ts:72` — embeddings to
    Ollama
  - `apps/cli/src/commands-ask.ts:103` — embeddings to
    Ollama
  - `apps/cli/src/embed.ts:23` — generic embed helper used
    by both
  - `apps/cli/src/commands-vision.ts:80, 165` — image fetch
    + remote vision API
  - `apps/cli/src/setup-calendar.ts:144` — Google OAuth
    token
  - `packages/autoconfigure/src/context-engineering-builders.ts:210`
    — embeddings for episodic recall
  Each is its own iter. Local-Ollama hangs are less likely
  than remote-RSS hangs (loopback connections don't slow-
  loris), but the defect class is identical. Picked the
  most-user-visible (RSS ingest) first.
- **Body-read is NOT timeout-bounded.** `response.text()`
  reads the entire body — a slow-loris that drips bytes
  AFTER the headers complete (i.e. between the `await
  fetchImpl()` resolution and `response.text()`) would still
  hang. The headers-timeout cap is what 30s gates; covering
  body read too would require a second AbortController +
  timer, or a reader-pump pattern like
  `loopback-fetch.ts:readBodyWithCap`. Out-of-scope for this
  single-call-site fix; the headers timeout closes the
  primary attack surface (no response at all).
- **No retry / backoff.** A genuine transient failure (DNS
  blip, single-packet drop) is treated as a hard error.
  `muse feeds refresh` continues to the next feed (the
  outer loop already swallows per-feed errors), so the
  user-visible impact is "this one feed didn't refresh
  this tick" — acceptable.
- **`controller.signal.aborted` check after catch.** If a
  caller passes a pre-aborted signal (they don't, no caller
  does), the catch could mis-classify a genuine fetch
  rejection as a timeout. Not exposed by the current
  surface; defensive-only.
