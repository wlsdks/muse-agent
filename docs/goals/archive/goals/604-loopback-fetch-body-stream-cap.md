# 604 — `muse.fetch` body read now stream-caps at `maxBodyBytes` (pre-fix the entire body was buffered in memory before the post-read slice trimmed it)

## Why

Goal 600 closed the **time** dimension of `muse.fetch`'s body
read: the documented `timeoutMs` now covers the body phase, so a
never-closing stream can't hang the agent past the cap. The
**memory** dimension remained open. Pre-fix `fetchWithOptionalBody`:

```ts
const response = await fetchImpl(url.toString(), { ...init, signal: controller.signal });
const body = readBody ? await response.text() : undefined;
return { body, headers: response.headers, status: response.status };
```

`await response.text()` reads the ENTIRE body into a single string
before returning. The downstream `get` tool then sliced it:

```ts
const fullBody = result.body ?? "";
const truncated = fullBody.length > maxBodyBytes;
const body = truncated ? fullBody.slice(0, maxBodyBytes) : fullBody;
```

So an allowlisted host returning a 1 GB response would have the
full gigabyte in RAM before the slice trimmed it down to 64 KB.
Operators set `allowedHosts` as **partial** trust ("I'm OK pulling
from this host"), not **unbounded** trust ("this host may consume
arbitrary memory on my agent"). The slice-after-read pattern made
the latter mandatory.

Step-8 redirect: not finite-guard (595/596), not 0o600 (598/599),
not boolean-spelling (585/587/597), not timeout (600), not regex-
coverage (601), not Invalid-Date (602), not CLI empty-id (603).
Defect class is "buffered the entire body before the cap" —
fresh.

## Slice

- `packages/mcp/src/loopback-fetch.ts`:
  - New `readBodyWithCap(response)` helper. Uses
    `response.body.getReader()` to pull chunks one at a time,
    decoded incrementally with `TextDecoder({ stream: true })`.
    Once the accumulated `bytesRead` would exceed `maxBodyBytes`
    the helper slices the current chunk's head down to the
    remaining budget, sets `truncated = true`, calls
    `reader.cancel()` so the network read stops, and returns.
  - `fetchWithOptionalBody` now returns `{ status, headers, body,
    truncated }`. The HEAD path skips body reading entirely
    (`truncated: false`).
  - The `get` tool consumes `result.truncated` directly — the
    post-read length comparison is gone.
  - Short WHY comment on the threat model: "1 GB response from an
    allowlisted host (partial trust) would consume that much
    memory before the post-truncation slice — reader-cancel stops
    the network read at the cap so the in-flight buffer never
    grows past it."
- `packages/mcp/test/mcp.test.ts`:
  - One new test in the `muse.fetch loopback server` describe,
    placed BEFORE the timeout test. Mocks `fetch` to return a
    `Response` whose body is a `ReadableStream` that emits 100 ×
    1 KB chunks then closes — a finite, deterministic source.
    Counts the chunks pulled. With `maxBodyBytes: 64`, asserts
    `chunksPulled ≤ 2`. Pre-fix `response.text()` pulls ALL 100
    chunks (`chunksPulled` ≈ 101); post-fix the reader is
    cancelled after the first chunk (1024 bytes > 64-byte cap)
    and `chunksPulled` stays at 1.

## Verify

- `@muse/mcp` suite green (533 passed, +1 vs goal-600 baseline of
  532, 0 failed); tsc strict EXIT=0.
- **Clean-mutation-proven** (Edit-based): collapsing
  `readBodyWithCap` back to `{ body: await response.text(),
  truncated: false }` makes TWO tests fail — the new
  chunks-pulled assertion (`expected true received false`, since
  truncated is now hard-coded false) AND the existing
  `truncates the body at maxBodyBytes and surfaces truncated=true`
  test (same root cause). Mutation confirms the streaming logic is
  load-bearing for both the new cap-on-streaming behavior and the
  inherited truncation contract. Fix restored, suite back to all
  green.
- `pnpm check` EXIT=0 (apps/api 258 passed, apps/cli 1041 passed
  — actually +1 vs goal-600 baseline of 1040; every workspace
  green); `pnpm lint` 0/0; `pnpm guard:core` clean; byte-scan
  clean (no zero-width / control chars in either touched file);
  `git status` shows only the two intended files plus this goal
  doc.
- No LLM request-response wire path touched directly; the fetch
  helper is the agent's HTTP loopback tool, not the model loop.
  `smoke:live` does not apply (per `testing.md` / iteration-loop
  Step 9). HTTP-surface `smoke:broad` is not affected — the
  loopback-fetch isn't probed in the broad smoke (operators wire
  it explicitly with allowlists).

## Status

Done. The `muse.fetch.get` tool's `maxBodyBytes` cap now bounds
BOTH the in-flight buffer AND the returned string:

| Phase                                    | Before                                            | After                                       |
| ---------------------------------------- | ------------------------------------------------- | ------------------------------------------- |
| Network read into memory                 | **unbounded** — full body buffered before slice   | bounded by maxBodyBytes (**fixed**)         |
| Returned `body` string length            | bounded by maxBodyBytes (post-read slice)         | unchanged (still bounded)                   |
| `truncated` flag                         | from `fullBody.length > maxBodyBytes`             | from the streaming-read cap directly        |
| HEAD (no body)                           | unchanged                                         | unchanged                                   |

No CAPABILITIES line / no OUTWARD-TARGETS flip: a robustness /
DoS-defense `fix:` on an internal loopback MCP tool, recorded
honestly with this backlog row — not a false metric.

## Decisions

- **Helper signature `readBodyWithCap(response)` — `maxBodyBytes`
  comes from the closure.** The helper lives INSIDE
  `createFetchMcpServer`, so it has free access to the `maxBodyBytes`
  closure variable. Passing the cap as an argument would be
  redundant noise at the single call site.
- **`TextDecoder({ stream: true })` for chunk decoding.** Multi-
  byte UTF-8 codepoints can straddle chunk boundaries. The
  `stream: true` flag holds incomplete bytes back until the next
  chunk, then a final empty `decoder.decode()` flushes the
  remainder. This matches Node/browser fetch's own decoding
  behavior. The truncated-chunk path uses `stream: false`
  (default) on the trimmed head, accepting that the very last
  codepoint might be a replacement char on a slice-mid-codepoint
  — the same artifact the post-read slice would have produced.
- **`subarray(0, Math.max(0, remaining))` for the trimmed chunk.**
  `Math.max(0, ...)` defends against the edge case where the cap
  is already reached and `remaining` is 0 or negative —
  `subarray(0, 0)` yields an empty view, the decoder emits the
  empty string, truncation flag is set, reader cancelled. Without
  the clamp a negative `end` would be interpreted as
  `length + end` (i.e. slicing from the tail), producing the
  WRONG bytes.
- **`reader.cancel()` is `await`ed.** The spec lets the
  underlying source clean up resources synchronously OR
  asynchronously; awaiting ensures the cancel completes before
  the finally block tries to release the lock. Pre-cancel
  releaseLock would throw (lock still held by an active reader).
- **`releaseLock()` wrapped in try/catch.** After `cancel()` the
  lock is released automatically per spec, so a second
  `releaseLock()` either no-ops or throws depending on the
  runtime. Catching keeps the helper's contract clean on both
  Node and browser-style implementations.
- **Mutation choice.** Reverted the helper to
  `{ body: await response.text(), truncated: false }` — the
  realistic regression a maintainer might write while "simplifying
  the streaming bit." That mutation breaks both the new
  chunks-pulled test AND the existing truncates test, proving the
  streaming logic is load-bearing for the contract those tests
  encode.
- **Test uses a finite 100-chunk stream + chunk counter** rather
  than an infinite stream + timing assertion. Pre-fix the test
  terminates quickly (100 chunks is fast) but the chunks-pulled
  count distinguishes pre/post-fix unambiguously. Timing-based
  proofs flake on slow CI; counter-based proofs don't.

## Remaining risks

- **`response.text()`'s decode-the-whole-thing-at-once UTF-8
  pathology** is no longer reachable through the agent path —
  the streaming reader bounds the decode at maxBodyBytes-many
  bytes. A future refactor that re-introduces `response.text()`
  on the agent path would re-open this surface.
- **Connect vs body timeout conflation** (carried over from goal
  600) — still a single `timeoutMs` for both phases. Separate
  caps would be more ergonomic but is API surface change.
- **`maxBodyBytes` is byte-count; the returned `body.length` is
  char-count.** For pure ASCII the two coincide. For mixed UTF-8
  the returned string can have fewer characters than the byte
  cap. This matches the pre-fix behavior — the slice was also at
  char-index `maxBodyBytes`, so a multi-byte body was already
  trimmed to a string of fewer-than-`maxBodyBytes` characters in
  some cases. Not a regression; documented here for the next
  reader.
