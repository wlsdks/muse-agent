# 108 — Redact credential shapes before persisting `last-chat.jsonl`

## Why

`muse chat --continue` reads the last N turns from
`~/.muse/last-chat.jsonl` so the model "remembers" the
conversation across CLI invocations. `appendLastChatTurn` wrote
both sides of the turn verbatim. If a user typed
`"rotate sk-proj-abc… tomorrow"`, that OpenAI key persisted on
disk indefinitely AND was replayed into every subsequent
`--continue` turn — both unnecessary exposure and an active
exfiltration vector when the next assistant reply quotes the key
back.

The goal-086 `redactSecretsInText` helper already exists for the
proactive-notice + messaging-out paths; this iteration extends
its reach to the chat-history persistence layer.

## Scope

- `apps/cli/src/chat-history.ts` `appendLastChatTurn`:
  - Run `turn.message` AND `turn.response` through
    `redactSecretsInText` BEFORE the JSONL write.
  - Pure substitution (`[redacted-<name>]` markers replace
    matches; the rest of the turn passes through unchanged) so
    the conversation reads normally.
- The trade is intentional: a personal JARVIS should forget
  credential strings rather than recall them verbatim. The
  marker remains so the next turn knows "the user mentioned a
  key here" without the actual secret.

## Verify

- New `apps/cli/test/program.test.ts` case:
  - Append a turn whose user side carries `sk-proj-…` and whose
    assistant side echoes a `ghp_…` PAT.
  - Assert: raw file contains `[redacted-openai-key]` +
    `[redacted-github-pat]`, NOT the verbatim secrets.
  - Assert: non-credential context ("rotate", "Friday") survives.
  - Assert: `readLastChatHistory()` returns the redacted form
    (this is what `--continue` hands back to the model).
- `pnpm --filter @muse/cli test` — 332 tests pass.
- `pnpm check` exit 0; `pnpm lint` exit 0.
- No real-LLM path touched (the new scrub is pre-write disk
  hygiene; the live request still saw the original text in this
  turn — secret hygiene applies to *future* turns).

## Status

done — `~/.muse/last-chat.jsonl` is now secret-clean on first
write. Pairs with goal 107 (Stripe + GitLab PAT patterns) so the
expanded `SECRET_PATTERNS` reach also covers the
chat-history surface.
