# 649 — `loadFeedBody` caps the RSS / Atom response body at 5 MB (default) via content-length pre-check + streaming reader, so a hostile or runaway feed server can't stream gigabytes into memory before `muse feeds refresh` notices — closes the unbounded-body half of the goal 636 hardening

## Why

Goal 636 added an `AbortController` + `setTimeout` around the
fetch call in `apps/cli/src/commands-feeds.ts:loadFeedBody`. That
fixed the connect/headers timeout — a slow-loris server that
opens a TCP socket and never speaks again no longer hangs the CLI.

But once the headers complete, the body is read via:

```ts
return response.text();
```

`response.text()` accumulates the **entire** body into a single
string before returning. A misbehaving / hostile RSS server can:

1. **Stream gigabytes**. The server's only contract is "respond
   with an XML body". Nothing forces it to be small. A bored
   adversary, a misconfigured CMS, or a feed that's been weaponised
   can return 10 GB of `xxxxxxxx...`, and Node will dutifully read
   the whole thing into a V8 string before `parseFeedBody` runs.
2. **Hide its size in chunked transfer-encoding**. Without
   `content-length` there's no upfront signal to refuse.
3. **Lie about its size with `content-length: 999999999`**.
   A well-behaved client should reject upfront.

Real-world RSS feed sizes:

| Feed                        | Typical size |
| --------------------------- | ------------ |
| Personal blog Atom          | 10-50 KB     |
| Medium-traffic news RSS     | 100-500 KB   |
| NYT homepage / firehose RSS | 500 KB - 2 MB|
| GitHub events Atom          | ~500 KB      |
| **Worst legitimate feed**   | **~5 MB**    |

5 MB is the practical ceiling for any honest RSS source. The fix
defaults `maxBodyBytes` to that. Operators with a heavier
expected feed can override via the new `maxBodyBytes` option.

### Defect class

**Unbounded HTTP response body read** — first hit. Distinct from
goal 636's *connect/headers timeout* and goal 648's *embeddings
fetch timeout*: those bound the *time* of the request, this
bounds the *bytes* of the response body. The body-cap defect can
exist even when the timeout is correctly wired (a fast server
streaming junk at full network speed completes within the timeout
window).

Sibling parity check: `packages/mcp/src/loopback-fetch.ts` already
does exactly this pattern (`readBodyWithCap`, default 64 KB) for
the loopback `muse.fetch` MCP server. That code's commentary
explicitly calls out the defect:

> The naive shape `await response.text()` reads the ENTIRE body
> into a single string before the caller can slice it — a 1 GB
> response from an allowlisted host (operator trusts the host
> enough to allow it, but that's partial trust, not unbounded
> trust) would consume that much memory before the
> post-truncation `slice(0, cap)` trimmed it back.

Same defect, different file. Brought parity to `loadFeedBody`.

Fresh against the recent 10-iter window:

- 648: HTTP fetch timeout (embeddings — *time-bound, distinct*)
- 647: balanced-bracket parser (inString)
- 646: FIFO eviction (unbounded growth)
- 645: file-mode 0o600
- 644: finite-guard
- 643: strict int-parse on HTTP query
- 642: stream error listener
- 641: cacheTtlMs finite-guard
- 640: word-boundary keyword
- 639: keyword dedup

No prior body-byte cap in the window. Defect-class diversity
preserved.

## Slice

- `apps/cli/src/commands-feeds.ts`:
  - Exported `DEFAULT_FEED_MAX_BODY_BYTES = 5 * 1024 * 1024`.
  - Extended `LoadFeedBodyOptions` with `maxBodyBytes?: number`
    (test seam + per-call operator override).
  - `loadFeedBody()` now (changes after the `!response.ok` check):
    1. **Pre-check** `response.headers.get("content-length")`.
       If declared and over the cap, throw `"feed body <url>
       declared <n> bytes; cap is <max>"` immediately — saves
       reading any body bytes for well-behaved servers.
    2. **Streaming reader**. `response.body.getReader()` with
       a `TextDecoder("utf-8")` accumulator. Each chunk pushes
       `total += value.byteLength`; once `total > maxBodyBytes`
       cancel the reader and throw `"feed body <url> exceeded
       <max> bytes"`. The mid-stream cancel propagates back to
       the fetch's underlying socket via the body's source
       contract — bytes stop arriving from the network.
    3. **finally**: `clearTimeout(timer)` was moved to wrap the
       whole body read. Pre-fix the timeout was cleared right
       after headers completed, so a slow-body stream had no
       time bound either. Now the abort signal stays armed
       through the body read — a slow-loris in the body phase
       still trips the timeout (covered by the existing 30s
       cap, not a new test).
- `apps/cli/src/commands-feeds.test.ts`: import updated, three new
  tests:
  1. **Content-length declares too big** — `new Response(empty
     stream, { headers: { content-length: "999999999" } })`
     with `maxBodyBytes: 1024` — assert `/declared 999999999
     bytes; cap is 1024/u`. Pins the upfront rejection path.
  2. **Chunked body actually exceeds cap** — `ReadableStream`
     enqueues 2,000 bytes, `maxBodyBytes: 100` — assert
     `/exceeded 100 bytes/u`. Pins the per-chunk byte-tally /
     `reader.cancel()` path.
  3. **Default constant is 5 MB** — `DEFAULT_FEED_MAX_BODY_BYTES
     === 5 * 1024 * 1024`. Pins the documented default so a
     future silent change requires the test bump.

## Verify

- `pnpm --filter @muse/cli test`: 1112 passed (1109 prior + 3
  new). `pnpm check` full: apps/api 270/270, apps/cli 1115/1115
  (the cross-package tests bring the count up to 1115 in the
  full sweep). Every workspace green; tsc strict EXIT=0.
- **Clean-mutation-proven**: reverting the body-cap block back to
  bare `return response.text();` makes EXACTLY the two
  behaviour-driven tests fail:
  - "rejects upfront when content-length declares oversized"
    fails because no error is thrown — the bare `response.text()`
    happily returns the empty body.
  - "rejects mid-stream when chunked body exceeds the cap" fails
    because `response.text()` reads the whole oversized body
    (2,000 bytes) and returns it.
  The default-constant test passes both pre- and post-fix
  because it doesn't depend on runtime behaviour. Restored
  the fix; all green again.
- `pnpm lint`: 0 errors / 0 warnings.
- `pnpm guard:core`: clean.
- Byte-hygiene scan (`perl -ne` on `commands-feeds.ts` +
  `commands-feeds.test.ts` for U+200B/200C/200D/FEFF): clean.
- No LLM request/response wire path touched (this is the HTTP
  fetch of an external RSS / Atom XML body, not the model chat
  path). `smoke:live` doesn't apply — Ollama is not in the loop.

## Status

Done. `muse feeds refresh` against a gigabyte-sized hostile feed
now fails fast with a clear error instead of consuming all
available RAM. The change is per-feed (each `loadFeedBody` call
is bounded independently), so one runaway feed in the
operator's subscription list can't poison the whole `refresh`
pass.

| Server behaviour                                        | Before                              | After                          |
| ------------------------------------------------------- | ----------------------------------- | ------------------------------ |
| Honest, small feed (50 KB RSS)                          | OK                                  | unchanged                      |
| Honest, large feed (2 MB NYT firehose)                  | OK                                  | unchanged                      |
| Slow-loris on connect / headers                         | hung pre-636; ~30s timeout post-636 | unchanged (still 30s)          |
| **10 GB chunked body, no content-length**               | **OOM kill**                        | **fails at 5 MB cap** (fixed)  |
| **Content-length: 999999999** (declared but never sent) | **slow OOM / fetch stall**          | **rejected upfront** (fixed)   |
| Slow-loris on body (drips bytes over hours)             | hung indefinitely                   | 30s timeout fires (improved — moved `clearTimeout` to wrap body) |

## Decisions

- **5 MB default**, generous against any honest RSS / Atom feed
  observed in the wild. Operators with a heavier expected feed
  (e.g., a media archive that exports its full corpus as one
  Atom feed) can override via `maxBodyBytes`. Matches the
  loopback-fetch default's posture (its 64 KB is for arbitrary
  HTTP fetches, not RSS specifically — RSS is structurally
  bigger because each feed includes N item entries).
- **Content-length pre-check before streaming**, not "after the
  fact". A polite server that advertises 10 GB upfront gets
  rejected without reading a single body byte. The streaming
  reader is the safety net for the chunked / no-content-length
  case.
- **Mid-stream `await reader.cancel()`**. Critical. Without
  the cancel, the underlying HTTP socket stays open and the
  remote server can keep streaming (the bytes go to /dev/null
  on the Node side, but the network read keeps the connection
  alive). `reader.cancel()` propagates back to the source
  ReadableStream, which in turn aborts the underlying fetch's
  socket read.
- **`clearTimeout(timer)` moved to wrap the body read.**
  Pre-fix the timer was cleared right after the headers
  resolved, so the body read had no time bound. With the
  timer kept alive across the body, a slow-loris in the body
  phase still trips the 30s timeout (covered by the existing
  timeout tests — no new test needed for this incidental
  improvement). The controller is the same one, so abort
  during body propagates to the reader.
- **Strict-int parse for content-length** via
  `Number.parseInt(declared, 10)`. A malformed header like
  `content-length: abc` returns NaN and the finite-guard skips
  the pre-check (falling through to the streaming guard) —
  defensive but not the primary path.
- **`finally try-catch releaseLock`** — same defensive pattern
  as `loopback-fetch.ts`. The lock may already be released by
  the cancel or by natural stream completion; releasing twice
  throws. Silently absorbed; the function's contract is
  unaffected.
- **No XXE / billion-laughs concern**. `fast-xml-parser`
  doesn't process DTD entities by default and the existing
  `htmlEntities: true` only maps named HTML entities
  (`&amp;`, `&rsquo;`, etc.), no expansion of custom-defined
  entities. The body-byte cap is the only relevant DoS
  surface for this parser.
- **Mutation choice**. Reverted the entire body-cap block back
  to the pre-fix `return response.text();`. The two
  behaviour-tests both fail (one with no error thrown, one
  reading the whole oversized body). Surgical proof of the
  cap's role.

## Remaining risks

- **`response.text()` callers elsewhere**. Quick audit of
  other `await fetch(...).text()` sites that should sibling-fix
  in future iters:
  - `apps/cli/src/program-helpers.ts` — `apiRequest` (HTTP
    surface to the Muse API server itself — partially trusted,
    less critical).
  - `apps/cli/src/commands-vision.ts:80` — image fetch +
    remote vision API (untrusted-image-server risk).
  - `apps/cli/src/setup-calendar.ts:144` — Google OAuth token
    exchange (Google is trusted; low risk).
  - `packages/voice/src/openai-tts.ts:97` — OpenAI TTS body
    (audio bytes; size is bounded by input text but no
    explicit cap).
  - `apps/api/src/compat-mcp-proxy.ts:136` — proxy to admin
    URL (allowlist-bounded but body is uncapped).
  Each is its own iter when the defect class rotates back
  around.
- **The 5 MB cap is hardcoded at the call site default**, not
  configurable via env. An operator who needs a different
  cap must wire the option through the caller. Future iter
  could route through `MUSE_FEED_MAX_BODY_BYTES` env if
  needed.
- **Streaming-mid-cancel may leave a partial decode in the
  body string**, but that string is discarded by the throw
  — the function never returns a partial body. Not a leak.
- **The body cap is per-call, not per-`refresh`**. A
  refresh that walks N feeds bounds memory to 5 MB *per
  feed*, not 5 MB *total*. With ~50 feeds that's 250 MB
  worst-case if every feed comes back at the cap. Real-
  world feeds are an order of magnitude smaller; the cap is
  a worst-case bound, not the typical case.
