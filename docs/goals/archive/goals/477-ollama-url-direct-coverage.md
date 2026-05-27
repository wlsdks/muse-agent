# 477 — direct coverage for `resolveOllamaUrl` (test-only; 458/460/462 class)

## Why

`resolveOllamaUrl` (`apps/cli` `ollama-url.ts`) is the resolution
point for the **critical Ollama wire path** the loop's hard
constraint pins (LOCAL OLLAMA QWEN ONLY). Three production
surfaces fetch from `${resolveOllamaUrl()}/api/...` on every call:

- `commands-ask.ts:102` — `muse ask` notes-RAG embedding lookups
- `commands-notes-rag.ts:68` — `muse notes index` embedding writes
- `commands-vision.ts:135` — `muse vision` `/api/generate` calls
- `commands-doctor.ts:227` — `muse doctor` self-check display

It had **zero direct test coverage** — neither
`apps/cli/src/ollama-url.test.ts` nor any other test file
imported or exercised it. Its contract (env first, then
`~/.muse/models.json` merge, default `127.0.0.1:11434`, trim
whitespace, strip trailing slashes so callers can append
`/api/embeddings` without producing `//`) was implicit-only — a
regression here would silently break every embedding call across
those four commands, with no test catching it.

This is the 458/460/462 sanctioned class: a real
safety/correctness path with **zero** existing direct coverage,
where the contract is non-trivial (multi-axis env/file/default
fallback + URL normalisation) and a mutation-provable assertion
exists. No `.ts` source change.

## Slice

- `apps/cli/src/ollama-url.test.ts` — new file, four focused
  tests pinning `resolveOllamaUrl`'s contract:
  1. default fallback (`http://127.0.0.1:11434`) when nothing
     is configured;
  2. env-configured URL passthrough;
  3. trailing slashes stripped (single and multiple) — the
     contract clause callers depend on for
     `${url}/api/embeddings`;
  4. whitespace-only env treated as unset (default).
  `MUSE_MODEL_KEYS_FILE` is stubbed to an isolated tmp path per
  test so the developer's real `~/.muse/models.json` cannot
  bleed into the run.
- `apps/cli/src/ollama-url.ts` — **unchanged** (`git diff` shows
  no source delta; this is test-only, mirroring goals
  458/460/462).

## Verify

- New test 4/4 green; full `@muse/cli` suite green (768, +4,
  0 failed); tsc strict (cli) EXIT=0.
- **Clean-mutation-proven** (Edit-based): replacing
  `return base.replace(/\/+$/u, "")` with `return base` makes
  the trailing-slash test fail with the precise pre-fix symptom
  (`expected 'http://x:11434/' to be 'http://x:11434'` — the
  contract clause callers rely on to avoid `//api/embeddings`)
  while the default/env/whitespace tests stay green; source
  restored byte-identical, suite back to 4 green.
- `pnpm check` EXIT=0, every workspace green — no regression;
  `pnpm lint` 0/0; `pnpm guard:core` clean (no IMMUTABLE-CORE
  touched); byte-scan clean; `git status` shows only the one
  intended file (src is unchanged).
- Pure config-resolution helper (no HTTP / no model request) —
  `smoke:live` does not apply (per `testing.md` /
  iteration-loop Step 9).

## Status

Done. `resolveOllamaUrl` — the entry point every Ollama
embedding / generation call across `muse ask` / `notes index` /
`vision` / `doctor` funnels through — now has direct coverage
that pins its default / env-passthrough / whitespace / trailing-
slash-strip contract; the trailing-slash clause is
mutation-proven. The four production callers stay byte-identical.

No CAPABILITIES line / no OUTWARD-TARGETS flip: all P-bullets are
already `[x]` and audited; a 458/460/462-class direct coverage
addition on a zero-coverage critical-path helper, recorded
honestly with this backlog row — not a false metric.

## Decisions

- Scoped the test to `resolveOllamaUrl`'s **unique** contract
  (default / env / trim / trailing-slash). Did NOT also assert
  env-over-file precedence: that behaviour belongs to
  `@muse/autoconfigure`'s `mergeModelKeysFromFile` and is
  already that package's responsibility to test; an integration
  assertion here would duplicate (and a quirk I observed —
  `OLLAMA_BASE_URL=""` shadows the file value via the merge's
  spread — is a separate autoconfigure-package concern out of
  this iteration's scope).
- Stubbed `MUSE_MODEL_KEYS_FILE` to an isolated tmp path per
  test (instead of relying on the developer's environment) so
  the test is deterministic on a machine with a real
  `~/.muse/models.json`.
- Test-only (no source change), so source is restored
  byte-identical (`git diff --stat` empty for `ollama-url.ts`)
  — mirrors the 458/460/462 protocol exactly.
