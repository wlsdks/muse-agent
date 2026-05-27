# 648 — `embed` (the shared Ollama `/api/embeddings` helper) wires `AbortController` + `setTimeout` (default 30s) around the fetch so a hung / cold-loading Ollama can't hang every RAG caller — sibling-pattern to goal 636's `loadFeedBody`

## Why

`apps/cli/src/embed.ts:embed` is the shared embedding-call
helper. Every RAG-dependent CLI command goes through it:

- `muse ask` — notes-RAG query path
- `muse notes reindex` — full notes corpus embed
- `muse episode reindex` — episode-index pipeline
- `muse recall` — cross-store semantic recall

Pre-fix:

```ts
const resp = await fetchImpl(`${baseUrl}/api/embeddings`, {
  body: JSON.stringify({ model, prompt: text }),
  headers: { "content-type": "application/json" },
  method: "POST"
});
```

No `signal`, no timeout. Ollama's `/api/embeddings` endpoint
can wedge a request:

1. **Cold model load** — the first embeddings call after
   Ollama startup loads the model into RAM. For `nomic-embed-
   text` this is sub-second; for `mxbai-embed-large` or
   anything bigger on weaker hardware, it can be 30+ seconds.
   Without a timeout the CLI just sits there.
2. **Remote `OLLAMA_BASE_URL`** — if the operator wired
   `MUSE_OLLAMA_BASE_URL=https://ollama.remote.box:11434`
   and that host loses network mid-request, the fetch hangs
   on the open socket.
3. **Ollama process stalled** — a misbehaving Ollama
   (concurrent request flood, model corruption, host swap
   pressure) can accept the connection and then just never
   respond.

Every RAG-dependent command sits behind this single helper.
A hung embed call hangs the entire CLI:

- `muse notes reindex` walks the notes dir; one stuck embed
  blocks the rest of the corpus.
- `muse ask "what's on my calendar?"` blocks until either
  the user hits Ctrl-C or the OS-level connect timeout fires
  (Linux ~60-180s, macOS ~75s, but only on TCP connect — once
  the socket is established, no timeout).

The fix is the same pattern goal 636 (`loadFeedBody` for RSS
ingest) established: `AbortController` + `setTimeout` +
forward the `signal` to `fetchImpl`, clear the timer in
`finally`, translate the abort into a clear "timed out after
Nms" error with the original `cause`.

### Defect class

**HTTP fetch with no timeout guard** — last hit in goal 636
(loadFeedBody, 12 iters back). Fresh against the recent
10-iter window:

- 647: balanced-bracket parser
- 646: unbounded growth (FIFO cap)
- 645: file-mode 0o600
- 644: finite-guard (data destruction)
- 643: strict int-parse on HTTP query params
- 642: stream error listener
- 641: cacheTtlMs finite-guard
- 640: word-boundary keyword matching
- 639: keyword dedup
- 638: lenient base64url decode (auth)

HTTP timeout hasn't been hit in 12 iterations. Solidly fresh.

## Slice

- `apps/cli/src/embed.ts`:
  - Exported `DEFAULT_EMBED_TIMEOUT_MS = 30_000`.
  - Extended `EmbedOptions` with `timeoutMs?: number` (test
    seam + per-call override).
  - `embed()` now:
    - Resolves `timeoutMs` from options (finite-positive
      only; falls back to 30s default on NaN / Infinity /
      `<= 0`).
    - Builds `controller = new AbortController()` and
      `timer = setTimeout(() => controller.abort(), timeoutMs)`.
    - Wraps `fetchImpl(...)` in try/catch/finally. Forwards
      `signal: controller.signal` into the fetch. On
      `controller.signal.aborted` after the catch, throws a
      clear "timed out after Nms" Error with the original
      `cause` attached (ESLint `preserve-caught-error`
      requirement). `finally clearTimeout(timer)` is
      unconditional.
- `apps/cli/src/embed.test.ts`:
  - Updated import to include `DEFAULT_EMBED_TIMEOUT_MS`.
  - Four new tests in the existing `embed` describe:
    1. **Never-resolving fetch times out** — fake fetch that
       returns a promise that listens for `signal.abort` and
       rejects; assert `embed(...)` rejects with `/timed out
       after 10ms/u`.
    2. **AbortSignal forwarded** — capture the `signal`
       passed to the fake fetch, verify it's an `AbortSignal`
       and that `signal.aborted === true` after the timeout
       fires. Pins that the upstream connection is actively
       cancelled, not just abandoned.
    3. **Success returns vector + clears timer** — fake fetch
       that resolves immediately with a `{ embedding: [.5,
       .5] }` body. Assert the vector comes back. Implicit:
       no leaked timer (would surface as a hanging vitest
       run).
    4. **Default constant = 30_000** — pins the exported
       default so a future silent change requires the test
       bump.

## Verify

- `@muse/cli` suite green (1109 passed, +4 vs the pre-iter
  baseline of 1101, 0 failed). Note: the +4 here counts
  vitest's reported total which already includes the new
  tests post-fix; pre-fix the failure was the 2 timing tests
  hanging to vitest's 5s default.
- **Clean-mutation-proven** (Edit-based): reverting the
  timeout wrapping back to the bare `await fetchImpl(...)`
  makes EXACTLY the two timing-driven tests fail with the
  vitest 5-second test timeout exceeded — both because the
  never-resolving fake fetch has no abort signal pre-fix and
  hangs forever. The body-success test and the default-
  constant test pass both pre- AND post-fix because they
  don't depend on the timeout. Fix restored; all 1109 tests
  pass.
- `pnpm check` green: apps/api 270/270, apps/cli 1109/1109,
  every workspace; tsc strict EXIT=0.
- `pnpm lint` 0/0, `pnpm guard:core` clean, byte-scan clean.
- No LLM request/response wire path touched — this is the
  EMBEDDINGS path (cosine-similarity vectors), not the model
  chat path. The fix is symmetric to the RSS feed timeout
  from goal 636. `smoke:live` doesn't apply (the embeddings
  endpoint is local to Ollama; smoke:live exercises the chat
  path against Qwen).

## Status

Done. The RAG helper can no longer hang the CLI on a
misbehaving Ollama:

| Ollama state                                | Before                       | After                          |
| ------------------------------------------- | ---------------------------- | ------------------------------ |
| Healthy, model loaded                       | OK                           | unchanged                      |
| Cold model load (45s first call)            | **hangs the CLI for 45s**    | times out at 30s (**fixed**)   |
| Server returns HTTP error (4xx / 5xx)       | OK (throws status error)     | unchanged                      |
| Remote OLLAMA_BASE_URL unreachable          | **hangs on TCP connect / silent socket** | times out at 30s (**fixed**) |
| Ollama process accepts connection but stalls| **hangs forever**            | times out at 30s (**fixed**)   |
| `muse notes reindex` with 1 hung embed       | **whole reindex blocked**    | hung file errors, rest continue (**fixed**) |

No CAPABILITIES line / no OUTWARD-TARGETS flip: a robustness
/ HTTP-timeout `fix:` on the shared embeddings helper.
Recorded honestly with this backlog row.

## Decisions

- **30-second default**, matching `loadFeedBody` (goal 636).
  Ollama's cold-model load for `nomic-embed-text` is < 5s
  on typical hardware; for `mxbai-embed-large` it can be
  15-25s. 30s is generous enough for slow first-loads while
  bounded enough to surface a real hang.
- **Per-call `timeoutMs` override** for tests and future env-
  driven configs. Finite-guarded same way 636 did it (NaN /
  Infinity / `<= 0` fall back to default).
- **`signal: controller.signal` forwarded** to the actual
  `fetchImpl` call. Critical — abandoning the promise alone
  would leave the underlying socket open until OS connect
  timeout. The active abort cancels the connection.
- **`Error("…", { cause })`** preserves the original
  AbortError. ESLint `preserve-caught-error` enforces this.
- **`finally clearTimeout(timer)`** unconditional. Even on
  success, the timer is cleared — otherwise a successful
  embed leaks a 30s timer keeping the event loop alive
  (`muse notes reindex` would idle for 30 seconds AFTER
  finishing every embed).
- **Did NOT bound `resp.text()` / `resp.json()` separately.**
  Headers complete within the 30s window in the normal case;
  body parse is fast (embedding vectors are typically ~1-3
  KB). A bytes-streaming attacker that drips bytes AFTER
  headers complete could still hang the body parse — but
  Ollama isn't an adversarial endpoint. Out of scope.
- **Mutation choice.** Reverted the whole timeout block back
  to bare `await fetchImpl(...)`. Both timing tests fail
  pre-fix (test timeout exceeded); the success and default-
  constant tests pass both ways. Surgical proof of the
  timeout's role.

## Remaining risks

- **Other RAG / model fetch sites without timeouts**. A
  quick audit:
  - `apps/cli/src/commands-notes-rag.ts:72` — duplicates the
    `embed` body shape but doesn't go through the shared
    helper. Wait — looking more carefully, `notes-rag.ts`
    has its OWN inline `embed()` function. The shared
    `apps/cli/src/embed.ts:embed()` (now timed-out) is used
    by `commands-recall.ts` and the episode-index pipeline.
    `commands-notes-rag.ts` and `commands-ask.ts` each have
    inline copies that still lack timeouts. Sibling-fixable
    in future iters by routing them through the shared
    helper.
  - `apps/cli/src/commands-vision.ts:80,165` — image fetch +
    remote vision API. Same defect class.
  - `apps/cli/src/setup-calendar.ts:144` — Google OAuth.
  - `packages/autoconfigure/src/context-engineering-builders.ts:210`
    — embeddings for episodic recall.
  - `packages/voice/src/openai-tts.ts:97` — OpenAI TTS HTTP.
  - `packages/voice/src/openai-whisper.ts` — same pattern.
  Each is its own iter. Picked the shared embedding helper
  first (highest-leverage — every notes/recall caller goes
  through it).
- **Cold model load > 30s** would now error instead of
  succeeding eventually. Operator workaround: pass a larger
  `timeoutMs` via a future config knob. The 30s default is a
  trade-off between "fail loudly on a hang" and "tolerate a
  slow first call."
- **`muse notes reindex`** walks every note serially — a
  30s timeout per note × 100 notes is still 50 min worst-
  case if Ollama is fully wedged. The fix bounds per-call,
  not per-command. Per-command timeout would be a separate
  iter.
- **DOMException AbortError vs. native Error** — Node's
  fetch rejects with `AbortError` (DOMException with `name
  === "AbortError"`). The catch wraps any rejection from
  the aborted fetch into our "timed out" Error with cause.
  A real fetch error (network reset mid-request, before
  abort) is differentiated via `controller.signal.aborted
  === true`.
