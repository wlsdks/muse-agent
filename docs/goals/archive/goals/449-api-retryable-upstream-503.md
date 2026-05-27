# 449 — A retryable upstream failure surfaces as HTTP 503, not a flat 500 (448 HTTP-boundary sibling)

## Why

`sendAgentError` (`apps/api` `server-agent-error.ts`) maps a
failed agent run to an HTTP response. Known types map cleanly
(GuardBlocked → 403, OutputGuard/Plan → 422), but **everything
else falls through to a flat `500 AGENT_RUN_FAILED`** — including
a `ModelProviderError` (often nested under the retry-exhausted
wrapper as `.cause`).

Per architecture.md and goal 448, `ModelProviderError.retryable`
is the source of truth: a *transient* upstream failure (local
Ollama momentarily down / ECONNREFUSED, a provider 5xx/429, the
goal-448 no-body-stream fallback failing) carries
`retryable: true`. But the HTTP boundary **discards that signal**
— a transient "retry in a moment" and a permanent unrecoverable
bug both return identical `500`s. An integration client (the
CLI's remote mode, a script, a webhook consumer, a reverse proxy)
therefore cannot implement correct retry/backoff: it can't tell
the local model server just needs a moment from a real defect.

This is the same `.retryable`-is-the-contract principle goal 448
fixed *inside* the provider (errors as events carrying
`.retryable`); here the **HTTP layer throws the signal away**. The
429 / 432 / 443 / 448 advertised-but-discarded-contract class, on
the user/integration-facing HTTP surface; fresh package (api last
touched goal 437, ~12 iterations ago).

## Slice

- `apps/api/src/server-agent-error.ts` — before the `500`
  fall-through, an `isRetryableUpstreamError` walk of the error
  cause chain (same seen-set/cause shape as `unwrapErrorMessage`)
  returns `503` with `code/errorCode: "UPSTREAM_UNAVAILABLE"`
  when a `ModelProviderError` with `retryable === true` is found
  (direct or nested under a wrapper `.cause`). Duck-typed on the
  documented `.retryable` contract field (`name ===
  "ModelProviderError" && retryable === true`) rather than
  `instanceof`, so a cross-package / dual-bundle instanceof
  mismatch can't silently drop the signal. Behaviour is
  byte-identical for every non-retryable error (guard/plan
  unchanged; non-retryable provider errors and unknown errors
  still `500 AGENT_RUN_FAILED`).
- `apps/api/test/server-agent-error.test.ts` — new focused unit
  test (fake `reply` capturing status + payload): a retryable
  `ModelProviderError` (direct) → 503 UPSTREAM_UNAVAILABLE; one
  nested under a wrapper `.cause` → still 503 (proves the
  cause-chain walk); a NON-retryable `ModelProviderError` → still
  500 AGENT_RUN_FAILED; a generic error → still 500 (the two
  no-regression anchors).

## Verify

- New tests green; full `@muse/api` suite 200 passed (45 files,
  +1 file / +4 it); tsc strict (api) EXIT=0.
- **Mutation-proven teeth**: removing the 503 branch makes the
  two retryable tests fail with exactly
  `AssertionError: expected 500 to be 503` while the two
  no-regression (non-retryable → 500) tests still pass; `503`
  occurrence count went 2→1 then restored to 2, suite back to
  200 green.
- `pnpm check` EXIT=0, every workspace green (api 200, cli 739,
  …) — no regression; `pnpm lint` 0/0; `pnpm guard:core` clean;
  byte-scan clean; `git status` shows only the two intended
  files.
- `sendAgentError` is post-failure HTTP shaping — deterministic,
  no model call (the provider wire path is not touched; goal 448
  was the wire-path edit that needed the live check). Not a
  request/response wire change; `smoke:live` does not apply (per
  `testing.md` / iteration-loop Step 9).

## Status

Done. A transient upstream failure now reaches the client as
`503 UPSTREAM_UNAVAILABLE` instead of an indistinguishable
`500 AGENT_RUN_FAILED`, so a caller / proxy can correctly retry
with backoff (and the CLI remote mode can distinguish "the local
model is starting up" from a real bug). The `.retryable`
source-of-truth contract is now honoured at the HTTP boundary as
well as inside the provider (448). Every non-retryable / unknown
error is unchanged.

No CAPABILITIES line / no OUTWARD-TARGETS flip: all P-bullets are
already `[x]` and audited; an error-UX / contract-consistency
`fix:` to an existing route surface (448 HTTP-boundary sibling),
recorded honestly with this backlog row — not a false metric.

## Decisions

- Status 503 + a distinct `UPSTREAM_UNAVAILABLE` code, but no
  `Retry-After` header: the `reply` abstraction in this
  function's signature exposes only `status().send()`, no header
  API; threading a header through would change the interface and
  every caller — scope creep. 503 alone is the standard
  transient signal clients/proxies already act on; the header is
  a separate, optional later refinement.
- Left non-retryable `ModelProviderError` (bad key / model-not-
  found, `retryable: false`) on `500`: re-classifying a
  non-retryable upstream config error (502? 400?) is a separate,
  genuinely debatable question; the concrete, non-speculative
  defect is "transient → wrongly 500 instead of 503", and the
  tight fix keeps every non-retryable path byte-identical. Noted,
  not chased.
- Duck-typed the `.retryable` contract rather than importing and
  `instanceof`-checking `ModelProviderError`: architecture.md
  makes `.retryable` the documented source of truth, and a
  shape-check at a package boundary is the drift-proof read of
  exactly that contract (the 448 rationale, applied at the HTTP
  edge).
