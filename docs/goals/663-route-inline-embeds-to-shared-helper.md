# 663 — `muse ask` and `muse notes reindex / query` (the two CLI commands with inline `embed()` copies) now route through the shared `apps/cli/src/embed.ts:embed()` helper so they inherit goal 648's `AbortController + setTimeout` timeout + goal 651-shaped vector validation + goal 649-shaped error-body cap — closes the "Other RAG / model fetch sites" gap goal 648's remaining-risks called out

## Why

Goal 648 added an `AbortController` + 30-second `setTimeout`
wrapper to `apps/cli/src/embed.ts:embed()` so a hung Ollama
couldn't hang every RAG caller. Its Remaining Risks
explicitly noted:

> `commands-notes-rag.ts:72` — duplicates the `embed`
> body shape but doesn't go through the shared helper.
> `commands-ask.ts:103` — same. Sibling-fixable in future
> iters by routing them through the shared helper.

Both files held a verbatim local copy:

```ts
async function embed(text: string, model: string): Promise<number[]> {
  const resp = await fetch(`${resolveOllamaUrl()}/api/embeddings`, { ... });
  if (!resp.ok) { throw new Error(`embeddings ${resp.status}: ${...}`); }
  const body = await resp.json() as { embedding?: number[] };
  if (!body.embedding) throw new Error("missing embedding");
  return body.embedding;
}
```

— same body shape, missing the timeout. A hung / cold-
loading / unreachable Ollama would hang `muse ask` and
`muse notes reindex` indefinitely, while the shared
`embed()` it was forked from now bounds the call at 30s.

The shared helper from goal 648 additionally gained:

- **Empty / non-finite vector rejection** — pre-fix the
  callers' "missing embedding" check let a `null` or
  `"nope"` body slip past (`body.embedding` was just
  null-tested, not array-validated). Shared helper validates
  `Array.isArray + every finite number + length > 0`.
- **`embedModel` cold-load timeout** — 30s default,
  override via `timeoutMs`. The local copies had no
  timeout at all.

Routing the two CLI sites through the shared helper is a
pure refactor that:

1. Inherits all three protections (timeout, vector
   validation, status+body error message).
2. Removes ~14 lines of duplicated code per file.
3. Closes the explicit gap goal 648 documented.

### Defect class

**Refactor — route duplicate code through the shared
helper that already has the protections we want**.
Distinct from recent classes in shape:

- 662: mkdtempSync cleanup
- 661: concurrent RMW race
- 660: Promise.race timer leak
- 659: HTTP redirect SSRF
- 658: sort comparator tiebreaker
- 657: secret patterns ext (PGP)
- 656: secret patterns ext (PEM)
- 655: path-traversal alt-separator
- 654: PKCE feature
- 653: recursion depth bound

A `refactor:` Conventional Commit. The bug-class
ancestry is "HTTP fetch timeout" (sibling of 648), but
the fix is "remove duplication" — not the same shape of
diff.

## Slice

- `apps/cli/src/commands-ask.ts`:
  - Import swap: `resolveOllamaUrl` → `embed` (the
    inline copy was the only caller of `resolveOllamaUrl`
    in this file).
  - Deleted the 14-line `async function embed(...)` body.
  - All callers of the local `embed(...)` (line 343 in
    `registerAskCommand`) now resolve to the shared
    helper via the import binding. Pure name-resolution
    change.
- `apps/cli/src/commands-notes-rag.ts`:
  - Same import swap: `resolveOllamaUrl` → `embed`.
  - Deleted the 14-line inline copy.
  - Callers at lines 240 (`reindexNotes`) and 429
    (`registerNotesRagCommands`) now resolve to the
    shared helper.

## Verify

- `pnpm --filter @muse/cli test`: 1131 passed (unchanged
  count — pure refactor). Full `pnpm check`: every
  workspace green; tsc strict EXIT=0.
- **The existing tests covering `muse ask` and `muse
  notes reindex`** were the proof of preservation:
  - The CLI tests that hit the RAG path either mock fetch
    or assert on error paths that don't depend on the
    embed-internals — same behavior pre- and post-refactor.
  - The shared `embed()` helper already has 9 direct
    unit tests (goal 648) — those continue to pass.
- `pnpm lint`: 0 errors / 0 warnings.
- `pnpm guard:core`: clean.
- Byte-hygiene scan on the two touched files: clean.
- **`smoke:live` did NOT run** in this iter. The path is
  the real `embed()` call to local Ollama and the
  inheritance from the shared helper means the wire
  shape is unchanged — verified by existing CLI tests
  that exercise the call site with mocked fetches. A
  future iter can dogfood `muse ask "What did I write
  about X?"` against the live Ollama and verify the
  refactored path still completes.

## Status

Done. The two CLI command sites now inherit the shared
helper's protections:

| Behavior                                        | Pre-fix (inline copies)     | Post-fix (shared helper)        |
| ----------------------------------------------- | --------------------------- | ------------------------------- |
| 30s timeout on a hung Ollama                    | **none — hangs forever**    | **30s default + overridable**   |
| Vector validation (Array.isArray + finite)      | nullish check only          | Array.isArray + length>0 + finite |
| Error body cap                                  | none                        | inherits truncateErrorBody     |
| AbortSignal forwarded to fetch                  | none                        | controller.signal forwarded     |
| Code duplication                                 | 14 lines × 2 files = 28     | 0 lines duplicated              |

## Decisions

- **Pure import swap + delete**, no new options threaded
  through. The shared `embed(text, model, options?)` has
  a default options object — the two CLI callers don't
  need any per-call override. Future iters can wire
  per-call timeout / fetchImpl seams when needed.
- **No `resolveOllamaUrl` import retained**. After
  removing the inline copy, neither file references it
  anymore. ESLint's `no-unused-vars` would flag the dead
  import.
- **No test addition for this iter**. The refactor is a
  pure DRY pass — the shared helper's tests (goal 648's
  9 + structural coverage) already prove the behavior.
  Adding tests at the CLI command layer would require
  spinning up a full agent runtime; the existing CLI
  tests cover the call site shape.
- **Did NOT change the local `cosine()` helpers** in
  the two files. They're small (~10 lines each), used
  in different contexts (the cosine in commands-notes-rag
  is exported and used by the index loader), and
  consolidating them isn't part of this iter's scope.
  Sibling iter can DRY them too if it becomes useful.

## Remaining risks

- **`packages/autoconfigure/src/context-engineering-builders.ts:
  embeddings for episodic recall`** — another embed
  callsite, but it uses a different shape (in-process
  fake / real-Ollama injection seam already, no timeout
  on the production path). Sibling-fixable.
- **`apps/cli/src/embed.ts:embed()`** itself is the
  one source of truth now. If a future code path needs
  a different embedding endpoint (e.g., a remote
  cloud-hosted embedding service), it should add a new
  helper or extend `embed()`'s `baseUrlResolver` rather
  than re-inlining the body.
- **The shared helper's `timeoutMs: 30_000` default**
  is hardcoded. An operator who needs a longer timeout
  for a slow embed model (mxbai-embed-large cold-start
  on a Raspberry Pi) must pass `timeoutMs` per-call.
  Future iter could wire `MUSE_EMBED_TIMEOUT_MS`
  through autoconfigure.
- **No real-LLM dogfood ran in this iter**. The
  refactor is byte-level equivalent on the network
  side (same POST body, same URL, same headers). If
  Ollama's response shape changed between goal 648 and
  now, both pre- and post-fix paths would break the
  same way. Confidence: high.
