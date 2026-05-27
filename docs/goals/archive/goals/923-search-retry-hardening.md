# Goal 923 — `muse.search` retries a transient web failure (P19 web-actuator hardening)

## Outward change

The built-in web search (`muse.search`, both the SearXNG and
DuckDuckGo backends) now retries a transient `429` / `5xx` / network
reject with backoff before giving up, instead of failing the whole
search on a momentary blip. A DuckDuckGo `503` mid-restart, or a
SearXNG instance that returns a transient `502`, no longer drops the
user's search outright — Muse waits the host-supplied `Retry-After`
(or its own exponential backoff) and tries again. Only a failure that
PERSISTS across attempts surfaces the existing error
(`rate-limited (429)` / `search backend responded 503`).

This is the **web** entry in P19's "repeat per actuator" hardening
thread: weather (753), email (824/910), and the shared transport
(883/901) were already retry-hardened; the search read actuator was
still on a bare single-shot `fetch`.

## Why this, now

P19 names email/web/contacts/weather/smart-home as the one-of-each
actuators to turn into daily-dependable integrations. Search is the
web READ actuator a local-model assistant leans on constantly (Qwen
has no native `web_search`), and DuckDuckGo's HTML endpoint is
explicitly "brittle and rate-limited" — exactly the surface where a
single transient failure was most likely and most user-visible. The
shared `fetchWithRetry` (with `Retry-After` honouring + per-attempt
timeout) already existed; search simply wasn't routed through it.

Retry is SAFE here precisely because search is an idempotent `GET` —
the deliberate opposite of the state-changing `web-action` POST path,
which must NEVER retry (a retried POST can double-act, per
`outbound-safety.md`). That asymmetry is the reason this is a separate,
correct slice and not a blanket change.

## How

- Added `retryOptions?: RetryOptions` to `SearchMcpServerOptions`
  (the same test-injection seam `OpenMeteoWeatherProvider` uses), and
  threaded it into both fetch sites.
- DDG path: replaced the manual `AbortController`/timer + single
  `fetchImpl` with `fetchWithRetry(fetchImpl, url, { timeoutMs,
  ...retryOptions, init })`. `fetchWithRetry` owns the per-attempt
  timeout, so the manual abort is gone. The existing `!response.ok`
  handling (429 → rate-limited, other → status error) is unchanged —
  it now runs only on the FINAL attempt's response.
- SearXNG path (`querySearxng`): same swap; a transient `5xx` now
  retries before the function returns `undefined` and abandons the
  preferred backend for the DDG fallback.
- No tool schema / description change, so the model's one-shot
  selection of `search` is untouched.

## Verification

`packages/mcp` `search-retry.test.ts` (NEW; `npx vitest run --root
packages/mcp search-retry.test.ts`, 5 passing) drives the REAL tool
`execute` path against a contract-faithful sequenced fake fetch:
- DDG recovers from two `503`s then succeeds on the third attempt
  (asserts `backend:"duckduckgo"`, a parsed result, and exactly 3
  fetch calls);
- a persistent `503` still surfaces `status:503` after retries
  exhaust (3 calls);
- a persistent `429` is retried then reported `rateLimited:true` (3
  calls);
- SearXNG recovers from a transient `503` then succeeds (2 calls — the
  preferred backend isn't abandoned on a blip);
- a permanent SearXNG `404` (non-retriable, 1 call) falls through to
  the DDG backend.

Mutation-proven: reverting the DDG `fetchWithRetry` back to a single
`fetchImpl` fails the recovery/persistence/429 tests (1 call, not 3);
restored green. `pnpm --filter @muse/mcp test` 949 passing. `pnpm
check` green bar the known apps/cli voice-playback `/tmp` mkdtemp flake
(passes 12/12 in isolation; this change is mcp-only). `pnpm lint` 0/0.
Idempotent-GET transport hardening, no LLM request/response or schema
change → no smoke:live (Ollama down regardless).

## Decisions

- Hardened the search READ path but deliberately NOT the `web-action`
  POST path — retrying an idempotent search is safe; retrying a
  state-changing submit can double-act (outbound-safety). The split is
  intentional, not an oversight.
- Threaded `retryOptions` through the constructor (mirroring
  `OpenMeteoWeatherProvider`) rather than hard-coding backoff, so the
  test injects `{ baseDelayMs: 0, sleep }` and runs instantly while
  production keeps the shared defaults (2 retries, 250ms base,
  `Retry-After`-aware, 15s per-attempt cap).
- Kept the existing 429 / non-ok error messages verbatim — they now
  fire only after retries exhaust, so the user-facing contract is
  unchanged except that a transient blip no longer reaches it.
