# 109 — Redact LLM-generated summary + topics before episode persistence

## Why

Goal 108 made `~/.muse/last-chat.jsonl` secret-clean at write
time, so the turns the episode summariser sees are already
redacted. But:

1. The summariser is a model call, and a model is free to
   *hallucinate* a credential-shaped string into its summary —
   especially when prompted to recall "what was the user asking
   about?" with a recently-typed `sk-…` reference in scope.
2. Episodes are long-lived: they outlive the chat history (the
   `last-chat.jsonl` head gets compacted away) and feed
   `muse persona`'s `recentTopics` line into every JARVIS reply.
   A persistent secret echo would be far harder to scrub later.

Defense-in-depth: run the same shared `redactSecretsInText` on
the model output before the episode hits disk.

## Scope

- `apps/cli/src/chat-end-session.ts` `captureEndOfSessionEpisode`:
  - After `summariseSession` returns, run `summary.summary`
    through `redactSecretsInText`.
  - Map `summary.topics.map(redactSecretsInText)` so each topic
    individually goes through the same filter.
  - No control-flow change — the redaction is a write-time
    substitution, not a gating decision.

## Verify

- New `apps/cli/test/program.test.ts` case:
  - Stub `modelProvider` hallucinates a `sk-proj-…` into the
    summary body AND a `ghp_…` into the topics list.
  - Assert: in-memory `captured.episode.summary` carries
    `[redacted-openai-key]`, not the verbatim key, AND surrounding
    English ("Discussed key rotation") survives.
  - Assert: topics list contains `[redacted-github-pat]` but
    benign topics (`rotation`, `security`) survive.
  - Assert: `~/.muse/episodes.json` on disk carries the same
    scrubbed form.
- `pnpm --filter @muse/cli test` — 333 tests pass.
- `pnpm check` exit 0; `pnpm lint` exit 0.
- No real-LLM path touched (the new scrub is post-summary disk
  hygiene; the live request still saw the unredacted output —
  but episodes are long-lived, so future reads stay clean).

## Status

done — `~/.muse/episodes.json` is now scrubbed via the same
helper as the goal-107 + 108 surfaces. Pairs with the broader
credential-hygiene line (goals 086 / 107 / 108).
