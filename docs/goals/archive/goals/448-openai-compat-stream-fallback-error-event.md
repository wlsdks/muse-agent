# 448 — A failing no-body-stream fallback yields an error EVENT, not a thrown generator

## Why

`OpenAICompatibleProvider.stream` (`@muse/model`
`provider-base.ts`) is the streaming wire path **Ollama / Qwen
actually uses at runtime** (architecture.md: OpenAI-compatible
endpoints used by Ollama go through `OpenAICompatibleProvider`).
The method has a deliberate error contract — errors are surfaced
as `{ type: "error" }` *events* on the async iterable, never
thrown — so a `for await` consumer can branch on
`ModelProviderError.retryable` instead of crashing. Two of its
three error paths honour this (the fetch-rejection path and the
`!response.ok` path each `yield { error, type: "error" }; return`),
and the non-JSON case explicitly documents the rationale
("surface it as a retryable ModelProviderError … instead of a raw
SyntaxError escaping the provider").

The third path violated it. When a streaming response has a null
body (`!response.body` — a 204 / proxy / polyfill), the code
falls back to `this.generate(request)` (a fresh non-stream POST)
**unwrapped**. `generate` is throw-based by contract, so if that
fallback fails — the local model server died between the stream
attempt and the retry, or the retry endpoint returns 5xx — a raw
`ModelProviderError` escapes the async generator as a rejection.
A consumer iterating `for await (const ev of provider.stream())`
expecting the documented event contract instead gets a thrown
exception (likely an unhandled rejection / crash) and never sees
the `.retryable` signal.

This is the 415 / 432 / 443 sibling-asymmetry / advertised-but-
inconsistent-contract class — the method's error contract is
established by 2 of 3 paths and the stated rationale, and the
third concretely breaks it — on the real Qwen runtime path. Fresh
package (model last touched goal 415, ~33 iterations ago); a
behavioural contract-consistency `fix:`, not a bound/NaN guard.

## Slice

- `packages/model/src/provider-base.ts` — wrap the `!response.body`
  → `generate()` fallback in try/catch and `yield` the **same**
  structured error event the other two stream error paths yield
  (`cause instanceof ModelProviderError ? cause : new
  ModelProviderError(this.id, …, true)`), then `return`. The
  normal streaming path (body present) and the fallback's
  success path are byte-unchanged; only a *failing* fallback now
  degrades to the contract-correct event instead of a thrown
  rejection.
- `packages/model/test/model.test.ts` — a new `it` in the
  existing `OpenAICompatibleProvider` describe: a fetch that
  returns a null-body 200 (triggers the fallback) then a 500
  (the fallback fails); `for await` over `provider.stream(...)`
  must NOT throw, must yield exactly one `{ type: "error" }`
  event whose `error` is a `ModelProviderError` with
  `retryable === true` (500 → retryable).

## Verify

- New `it` green; full `@muse/model` suite 163 passed (10 files,
  +1; 5 pre-existing skips); tsc strict (model) EXIT=0.
- **Mutation-proven teeth**: reverting to the unwrapped fallback
  makes the new test fail by *throwing* `ModelProviderError:
  OpenAI-compatible request failed with 500` out of the generator
  (the exact pre-fix bug); `catch (cause) {` occurrence count
  went 3→2 then restored to 3, suite back to green.
- `pnpm check` EXIT=0, every workspace green (model 163,
  cli 739, api …) — no regression; `pnpm lint` 0/0;
  `pnpm guard:core` clean; byte-scan clean; `git status` shows
  only the two intended files.
- **smoke:live EXIT=0** — a real local Qwen round-trip
  (`ollama/qwen3.6:35b-a3b`, `GEMINI/OPENAI/ANTHROPIC` keys
  emptied, no cloud, zero cost) through the edited
  `OpenAICompatibleProvider`. The file is on the request/response
  wire path, so the live check was run per Step 9 even though the
  changed branch (no-body fallback) is not hit on a normal
  round-trip; it confirms the normal streaming/generate path is
  unregressed.

## Status

Done. All three of `OpenAICompatibleProvider.stream`'s error
paths now honour the method's documented event contract: a
failing no-body fallback is delivered as a retryable
`ModelProviderError` *event*, so a streaming consumer on the Qwen
runtime path can handle it (and retry per `.retryable`) instead
of crashing on an escaped throw. Normal streaming behaviour is
unchanged (verified live).

No CAPABILITIES line / no OUTWARD-TARGETS flip: all P-bullets are
already `[x]` and audited; a contract-consistency `fix:` to an
existing provider path, recorded honestly with this backlog row —
not a false metric.

## Decisions

- Byte-parallel error translation to the existing fetch-rejection
  path (same `instanceof ModelProviderError ? … : new …(…, true)`
  shape): the three paths must be indistinguishable on the error
  contract, and a shared exact pattern is the most drift-proof
  way to keep them so (the 413/432 single-source rationale).
- Ran smoke:live despite the changed branch being unreachable on
  a healthy round-trip: the edited file *is* the Qwen wire path,
  and Step 9 requires the live check for request/response-path
  edits — a green normal round-trip is the honest proof the edit
  didn't regress the path, even though the new branch needs a
  fault to exercise.
