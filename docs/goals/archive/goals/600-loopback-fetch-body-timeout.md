# 600 — `muse.fetch` body read now respects the documented `timeoutMs` (pre-fix the timer cleared before the body read began, letting a slow body hang indefinitely past the cap)

## Why

`packages/mcp/src/loopback-fetch.ts` is the bounded HTTP GET/HEAD
loopback MCP server — the agent's path to "read this allowlisted
URL" without giving Muse free network access. It carries a
documented `timeoutMs` (default 5_000ms) to bound how long a
single fetch can take.

Pre-fix `callFetch`:

```ts
async function callFetch(url: URL, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url.toString(), { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}
```

The `await fetchImpl(...)` resolves once the request reaches
"headers received" — that's how `Response` works. The `finally`
then immediately clears the timer.

The caller's body read happens AFTER `callFetch` returns:

```ts
const response = await callFetch(decision.url, { headers, method: "GET" });
const fullBody = await response.text();   // ← unbounded
```

So a server that returns headers quickly but streams the body
slowly (or never closes it) would hang the agent **indefinitely
past the documented `timeoutMs`** while `response.text()` waited.
A malicious-but-allowlisted host could DoS the agent through a
single request to a stream that never closes.

Per the WHATWG Fetch spec, the signal passed to `fetch()` aborts
both the connect+headers phase AND the body read — but only if
the signal stays active. The pre-fix code cleared the timer (and
let the controller drop out of scope) before the body read began,
so there was no signal to fire when timeoutMs elapsed.

Step-8 redirect: not finite-guard (595/596), not 0o600 file mode
(598/599), not boolean-spelling (585/587/597), not in-memory/
Kysely parity (593/594). Defect class is "timeout window doesn't
cover the body-read phase" — fresh.

## Slice

- `packages/mcp/src/loopback-fetch.ts`:
  - Renamed `callFetch` → `fetchWithOptionalBody(url, init,
    readBody)`. The new shape does the body read INSIDE the same
    try block as the fetch, so the timer's `clearTimeout` is in
    the `finally` AFTER both phases complete. When the timer fires
    during the body read, the controller's `abort()` propagates
    via fetch's signal contract and `response.text()` rejects
    with an `AbortError`.
  - Returns a structured `{ status, headers, body }` shape (where
    `body` is `string | undefined` based on `readBody`) so the
    `head` tool can opt out of the body read and the `get` tool
    can use the body without an extra `await response.text()` at
    the call site.
  - Short WHY comment on the threat model: "slow body could hang
    the agent indefinitely past the documented timeout; signal
    contract requires keeping the controller alive across both
    phases."
  - Updated the `get` and `head` tool `execute` paths to consume
    the new shape. No external API change — `get` still returns
    `{ body, headers, status, truncated }`; `head` still returns
    `{ headers, status }`.
- `packages/mcp/test/mcp.test.ts`:
  - One new test in the `muse.fetch loopback server` describe.
    Mocks `fetch` to return a `Response` whose body is a
    `ReadableStream` that NEVER closes naturally — its only
    completion path is the abort signal:

        const stream = new ReadableStream<Uint8Array>({
          start(streamController) {
            signal.addEventListener("abort", () => {
              streamController.error(new Error("aborted by signal"));
            });
          }
        });

    With `timeoutMs: 50`, asserts the call returns `{ error:
    "fetch failed: …" }` within ~2_000ms (a generous bound). Pre-
    fix the test would hang until vitest's 5_000ms test-level
    timeout.

## Verify

- `@muse/mcp` suite green (532 passed, +1 vs baseline 531, 0
  failed); tsc strict EXIT=0.
- **Clean-mutation-proven** (Edit-based): restructuring
  `fetchWithOptionalBody` back to the pre-fix shape (clear timer
  in finally AFTER the fetch but BEFORE the body read) makes the
  new test fail — the body stream never closes, and `response.
  text()` waits forever, until vitest's own 5_000ms test timeout
  surfaces the regression as a failed assertion. Fix restored,
  suite back to all green.
- `pnpm check` EXIT=0 (apps/api 258 passed, apps/cli 1040
  passed, every workspace green); `pnpm lint` 0/0; `pnpm
  guard:core` clean; `git status` shows only the two intended
  files.
- No LLM request-response wire path touched directly; the fetch
  helper is the agent's HTTP loopback tool, not the model loop.
  `smoke:live` does not apply (per `testing.md` / iteration-loop
  Step 9). HTTP-surface `smoke:broad` is not affected — the
  loopback-fetch isn't probed in the broad smoke (operators wire
  it explicitly with allowlists).

## Status

Done. The `muse.fetch.get` tool's `timeoutMs` cap now covers BOTH
phases:

| Phase                          | Before                                    | After                              |
| ------------------------------ | ----------------------------------------- | ---------------------------------- |
| Connect + headers              | bounded by timeoutMs                      | unchanged                          |
| Body read (`response.text()`)  | **unbounded** — could hang indefinitely   | bounded by timeoutMs (**fixed**)   |
| HEAD (no body)                 | bounded by timeoutMs                      | unchanged                          |

No CAPABILITIES line / no OUTWARD-TARGETS flip: a robustness /
DoS-defense `fix:` on an internal loopback MCP tool, recorded
honestly with this backlog row — not a false metric.

## Decisions

- **Renamed `callFetch` → `fetchWithOptionalBody`.** The new
  shape doesn't just return a `Response`; it returns a settled
  result. The new name signals the boundary clearly: this helper
  finishes BOTH phases inside its timeout window. A future
  maintainer who needs the bare-Response shape would have to
  re-introduce the un-bounded body path explicitly.
- **`readBody: boolean` parameter, not separate getBody/headOnly
  helpers.** The two tools share the same connect+timeout
  bookkeeping; splitting helpers would duplicate the controller
  + timer + finally pattern. The bool keeps the call sites
  symmetric and the helper testable as one function.
- **`body: string | undefined`** — the HEAD path doesn't read a
  body so `undefined` is the honest representation. The `get`
  tool's `??` fallback handles it (`const fullBody = result.body
  ?? "";`).
- **Mutation choice.** Tried "clear timer in finally before body
  read" because that's the realistic regression — a maintainer
  refactoring for readability might be tempted to scope the
  fetch and body read into separate try blocks. The mutation
  proves that's the load-bearing structural change.
- **Did NOT add a hard byte-cap to the in-progress body read.**
  The post-read truncation (`fullBody.length > maxBodyBytes`)
  still happens AFTER the full body has been read into memory.
  A slow body is now bounded by `timeoutMs`, but a fast body
  larger than `maxBodyBytes` is still buffered in memory before
  truncation. That's a separate defect (memory bound vs time
  bound) — deferred.
- **Test uses a never-closing stream + abort listener** to
  cleanly distinguish "body read is bounded by signal" from
  "headers arrived but no body came." A scheduling-based test
  (e.g. setTimeout in the body) would risk flakiness on slow
  CI; the abort-listener pattern is fully deterministic.

## Remaining risks

- **`fullBody.length > maxBodyBytes`** truncation happens after
  the full body is loaded into memory. A 1 GB response from an
  allowlisted host (the operator trusts the host enough to
  allow it, so this is partial-trust) would consume that much
  memory before being sliced down. A future iteration could
  add a chunk-level cap using `response.body!.getReader()`.
- **`response.text()`** decodes the body as UTF-8 in one pass.
  A pathological binary body could blow up the JSON envelope
  the tool returns. Same allow-listed-host trust gradient
  applies; deferred.
- **Connect timeout vs body timeout** are conflated into a
  single `timeoutMs`. A real-world server that takes 4_000ms
  to connect leaves only 1_000ms for the body in the default
  5_000ms cap. Separate connect/body timeouts would be more
  ergonomic but is API surface change; the current single
  timeoutMs matches the OpenAI/Anthropic SDK conventions.
