# 182 — credential scrub in the user-memory store

## Why

The credential-redaction line (chat history 108/138, episodes
109, proactive 139, notes 112/140, jobs 116) covered every
persisted model-output surface **except** the user-memory
store. `muse remember`, the LLM-extract path, and the chat-turn
auto-extract hook all write fact/preference values to
`~/.muse/user-memory.json` — and that store is the most
persistent one *and* is re-injected into every future prompt
via persona expansion. A "remember my deploy token is ghp_…"
(or a model that extracts a credential-shaped value) persisted
verbatim and round-tripped back into the model on every turn.

`sanitizeUserMemoryValue` was already the established single
chokepoint (all three write paths funnel through it) doing
control-byte stripping + length cap — but no credential
redaction.

## Scope

- `packages/memory/src/memory-user-store.ts`:
  - `sanitizeUserMemoryValue` now runs `redactSecretsInText`
    (from `@muse/shared`) first, then the existing control-byte
    strip + length cap. One line at the one chokepoint → every
    caller (CLI `muse remember`, auto-extract hook, API
    `/api/user-memory` PUT, InMemory + Kysely stores) inherits
    it.
- `packages/memory/test/memory-user-store-file.test.ts`: new
  case — `ghp_…` / `sk-proj-…` redacted, plain prose untouched.

## Verify

- `pnpm --filter @muse/memory test` — 146 pass (1 new).
- `pnpm check` exit 0; `pnpm lint` exit 0.
- No real-LLM path touched (pure string hygiene; smoke:live
  not required).

## Status

done — the credential-redaction line now covers the most
persistent + most-re-injected store. A leaked secret in an
extracted memory value no longer survives to disk or
round-trips into future prompts.
