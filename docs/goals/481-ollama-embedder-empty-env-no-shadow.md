# 481 — `createOllamaEmbedder` no longer hits a malformed relative URL when `OLLAMA_BASE_URL=""` (goal-478 sibling)

## Why

Discovered by grepping for `process.env.X ?? default` patterns
after the goal-478 empty-env fix. `createOllamaEmbedder`
(`@muse/autoconfigure` `context-engineering-builders.ts:201`) —
the runtime embedder the cross-session episodic-recall feature
(`StoreBackedEpisodicRecallProvider`, default-on) constructs —
resolved its base URL with **nullish coalescing**:

```ts
const base = (process.env.OLLAMA_BASE_URL ?? "http://127.0.0.1:11434").replace(/\/+$/u, "");
```

`??` only falls back on `null`/`undefined`, not on `""`. So a
shell or launcher that pre-clears `OLLAMA_BASE_URL=` ("zero out
leaked env" — the same pattern goal 478 fixed at the merge
layer) leaves `base` empty, and every `/api/embeddings` call
fetches the **relative URL `/api/embeddings`** instead of the
default host.

Worse: `StoreBackedEpisodicRecallProvider`'s embed branch
intentionally **fail-opens** ("a thrown embedder must degrade to
Jaccard, never break recall" — line 547 of `episodic-recall.ts`).
So when the relative-URL fetch throws (`TypeError: Invalid URL`
in Node fetch), episodic recall silently degrades from
embedding-similarity to Jaccard token-overlap with **no error
visible to the user** — exactly the silent-quality-loss the
goal-478 fix exists to prevent at the merge layer, here in a
different consumer that was missed.

Same defect class as 478. The bug is a one-line `??`
vs trim-and-length-check, not a deeper architectural issue.

## Slice

- `packages/autoconfigure/src/context-engineering-builders.ts`
  — `createOllamaEmbedder` now reads
  `process.env.OLLAMA_BASE_URL?.trim()` and treats
  empty/whitespace-only as "unset" (default
  `http://127.0.0.1:11434`), mirroring **byte-for-byte**
  `apps/cli/src/ollama-url.ts` `resolveOllamaUrl` and the
  goal-478 merge fix. Behaviour byte-identical for every
  non-empty trimmed env value; only the silent-shadow path is
  closed.
- `packages/autoconfigure/test/autoconfigure.test.ts` —
  appended an integration test that exercises the real
  construction path: stubs `globalThis.fetch` to capture the
  URL, sets `process.env.OLLAMA_BASE_URL = ""`, constructs the
  recall provider via `buildEpisodicRecallProvider`, saves a
  summary into the store, triggers the embedder via
  `provider.resolve(...)`, and asserts the captured URL is the
  default (`http://127.0.0.1:11434/api/embeddings`) — NOT the
  relative `/api/embeddings` the old code would emit.

## Verify

- New test green; full `@muse/autoconfigure` suite green (142
  passed, +1, 0 failed); tsc strict (autoconfigure) EXIT=0.
- **Clean-mutation-proven** (Edit-based): reverting to the
  `??`-only resolution makes the new test fail with the precise
  pre-fix symptom (`expected '/api/embeddings' to be
  'http://127.0.0.1:11434/api/embeddings'` — the malformed
  relative URL that would silently degrade episodic recall to
  Jaccard) while every other test stays green; fix restored,
  suite back to 142 green.
- `pnpm check` EXIT=0, every workspace green — no regression
  (the recall provider is used by `agent-core` /
  `apps/api`/`apps/cli` consumers); `pnpm lint` 0/0;
  `pnpm guard:core` clean (no IMMUTABLE-CORE touched);
  byte-scan clean; `git status` shows only the two intended
  files.
- Pure config-resolution + integration coverage — no real LLM
  call (fetch is stubbed); `smoke:live` does not apply (per
  `testing.md` / iteration-loop Step 9).

## Status

Done. A user who `export OLLAMA_BASE_URL=` (or any launcher that
pre-clears credential env to `""`) no longer silently degrades
their cross-session episodic recall from embedding-similarity to
Jaccard — the embedder now hits the configured-or-default
Ollama host. Same fix shape as goal 478; the
`apps/cli/src/ollama-url.ts` / `mergeModelKeysFromFile` /
`createOllamaEmbedder` trio now consistently treats empty env as
unset.

No CAPABILITIES line / no OUTWARD-TARGETS flip: all P-bullets are
already `[x]` and audited; a correctness `fix:` discharging a
goal-478 sibling-asymmetry found by the systematic grep,
recorded honestly with this backlog row — not a false metric.

## Decisions

- Mirrored `resolveOllamaUrl` and the goal-478 merge wording
  byte-for-byte rather than introducing a new shape: the three
  surfaces must agree; a near-variant after two consistent
  fixes is exactly the drift the cross-package convention
  exists to prevent.
- Wrote an **integration** test (real `buildEpisodicRecallProvider`
  → real `StoreBackedEpisodicRecallProvider` → captured fetch
  URL) rather than extracting a public helper just to unit-test
  the resolution: the integration form exercises the
  failing-as-shipped path end-to-end with no new public surface.
  A future refactor that extracts a shared helper across the
  three callers (cli `resolveOllamaUrl`, the autoconfigure
  merge, and the embedder) is a separate concern — out of this
  iteration's tight scope.
- Stubbed `globalThis.fetch` with a save/restore wrapper inside
  a try/finally so the assertion is deterministic and the
  global is left in its original state — the byte-clean,
  test-isolated pattern the autoconfigure suite already follows.
