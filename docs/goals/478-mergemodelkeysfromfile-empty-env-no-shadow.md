# 478 — `mergeModelKeysFromFile` no longer lets an empty env value shadow the configured `models.json` (goal-477 follow-on)

## Why

Discovered while writing the goal-477 coverage for
`resolveOllamaUrl`. `mergeModelKeysFromFile`
(`@muse/autoconfigure` `personal-providers.ts`) implemented its
"env wins on conflict" rule as a naive
`return { ...fileKeyForEnv, ...env }`. A property explicitly set
to `""` (or whitespace-only) is still a *property* — so the
spread overwrites the file value with `""`, and every downstream
caller (`resolveOllamaUrl`, `createModelProvider`,
`api-server-options`, …) that treats `""` as "unset" silently
falls back to its hard-coded default.

Concretely: a shell or launcher that pre-clears `OLLAMA_BASE_URL=`
("zero out leaked env") *destroys* the user's
`~/.muse/models.json` ollama URL. The runtime then falls back to
`http://127.0.0.1:11434` even though the user explicitly
configured a remote Ollama via `muse setup model`. The setup
wizard's own promise — "configure once, persist on disk" —
silently breaks for anyone with a launcher that wipes inherited
env. Same shape for `OPENAI_API_KEY=""` / `ANTHROPIC_API_KEY=""`
/ etc.

This was the deferred-from-477 finding: the goal-477 test
attempted to assert env-over-file precedence and instead
surfaced this real semantic gap, which 477 (test-only by
contract) explicitly punted to a follow-on. No prior test
exercised an empty-string env value, so the contract was
implicit-only.

## Slice

- `packages/autoconfigure/src/personal-providers.ts` — after the
  `{...fileKeyForEnv, ...env}` spread, the merge now restores
  the file value for any merged-key whose env value is an empty
  or whitespace-only string. Iteration is bounded to
  `Object.keys(fileKeyForEnv)` — keys *not* resolved from the
  file (any unrelated env value the caller passes) pass through
  unchanged. Behaviour byte-identical for every non-empty
  env value (the documented env-wins precedence still holds);
  only the silent-shadow-by-empty-string path is closed.
- `packages/autoconfigure/test/autoconfigure.test.ts` — extended
  the existing `mergeModelKeysFromFile lifts …` test (the prior
  five assertions untouched): an env with
  `OLLAMA_BASE_URL: ""` and `OPENAI_API_KEY: "   "` and a
  populated file → resolves to the **file** values
  (`http://localhost:11434`, `from-file-openai`), not `""`.

## Verify

- Extended test green; the five pre-existing
  `mergeModelKeysFromFile lifts …` assertions still green (no
  wrong premise — they only ever set env values that were
  undefined or non-empty); full `@muse/autoconfigure` suite
  green (141 passed, 0 failed); tsc strict (autoconfigure)
  EXIT=0.
- **Clean-mutation-proven** (Edit-based): reverting the merge
  back to the naive `return { ...fileKeyForEnv, ...env }`
  makes the new assertion fail with the precise pre-fix symptom
  (`expected '' to be 'http://localhost:11434'` — the file value
  shadowed by the empty env) while every other assertion stays
  green; fix restored, suite back to 141 green.
- `pnpm check` EXIT=0, every workspace green — no regression
  across the many consumers of `mergeModelKeysFromFile` (cli,
  apps/api, autoconfigure callers); `pnpm lint` 0/0;
  `pnpm guard:core` clean (no IMMUTABLE-CORE touched);
  byte-scan clean; `git status` shows only the two intended
  files.
- Pure config-merge logic — no LLM / model request-response
  wire path; `smoke:live` does not apply (per `testing.md` /
  iteration-loop Step 9).

## Status

Done. A user who `export OLLAMA_BASE_URL=` (or any launcher
that pre-clears credential env to `""`) no longer silently loses
their `muse setup model` configuration: the file value is
restored when env is effectively unset. The five existing
precedence assertions hold byte-identically; only the
empty-shadow path is corrected.

No CAPABILITIES line / no OUTWARD-TARGETS flip: all P-bullets are
already `[x]` and audited; a correctness `fix:` discharging a
deferred-in-477 finding, recorded honestly with this backlog row
— not a false metric.

## Decisions

- Treated empty AND whitespace-only env as "unset" symmetrically:
  matches the convention every consumer already follows
  (`value?.trim().length > 0 ? value : default`). A "shell set
  to a single space" is exactly the same wipe intent as
  empty-string and must behave identically.
- Restricted the override-restoration to keys we actually
  resolved from the file (`Object.keys(fileKeyForEnv)`). Other
  env keys the caller passes in (e.g. `HOME`, `MUSE_MODEL_KEYS_FILE`
  itself) pass through unchanged — the function's responsibility
  is to lift file values, not to second-guess unrelated env.
- Extended the existing `mergeModelKeysFromFile lifts …` test
  rather than adding a new one: the new assertion is the same
  precedence contract clarified, not a separate concern; the
  five existing assertions stay verbatim so the precedence
  baseline remains crisply pinned.
