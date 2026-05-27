# Goal 880 — episode summariser scrubs the input transcript with the canonical redactor

## Outward change

When `MUSE_EPISODIC_MEMORY_ENABLED=true`, the end-of-session
summariser sends the chat transcript to a model. That transcript is
scrubbed for credentials **before it leaves the machine**. Until now
the scrub used a local 3-pattern subset (`sk-`/`gh[pso]_`/`ya29.`,
`sk-ant-`, `AIza`) — so a user who pasted a **DB connection URI with
an inline password, an AWS access key, a Slack / Telegram / Discord
bot token, a JWT, a Stripe key, a GitLab PAT, or a PEM private key**
into the chat had it sent to the model verbatim, even though the
file's own docstring promised machine-boundary scrubbing.

The summariser now scrubs the input with the canonical
`@muse/shared` `redactSecretsInText` — the same 14-family redactor
every other outbound surface (proactive notices, search-to-notes,
the capture re-scrub) already uses. The model now sees
`[redacted-connection-uri]` / `[redacted-aws-access-key]` / etc.
instead of the live secret.

## Why this, now

A real privacy/correctness gap on a fresh surface (episode capture
path, explicitly flagged for review and distinct from recall). Two
divergent redactors existed: the weak local one scrubbed the
*input* (what's sent to the model), while the strong shared one
scrubbed the *output* re-scrub — exactly backwards from a
data-minimisation standpoint, since the input is the larger,
secret-bearing payload.

While unifying, found the canonical shared redactor was itself
**missing the Google OAuth (`ya29.`) family** that the old local
redactor caught — so added `google-oauth-token` to `@muse/shared`.
That strengthens every consumer (a leaked `ya29.` bearer in a task
title can no longer round-trip out via a proactive Telegram notice).

## How

- `@muse/shared`: new `{ name: "google-oauth-token", regex:
  /\bya29\.[A-Za-z0-9_-]{20,}/gu }` in `SECRET_PATTERNS` (after
  `google-api-key`).
- `@muse/agent-core` `episodic-summariser.ts`: `redactSecrets` now
  delegates to `redactSecretsInText`; the local `SECRET_PATTERNS` /
  `SECRET_PLACEHOLDER` constants are deleted. `summariseSession`'s
  default redactor inherits the change; the `redact` override option
  is unchanged.

## Verification

- `@muse/shared` `shared.test.ts`: asserts `ya29.…` →
  `[redacted-google-oauth-token]`. Mutation-proven (removing the
  pattern fails it).
- `@muse/agent-core` `episodic-summariser.test.ts`: the
  `redactSecrets` suite now asserts the family-tagged placeholder,
  and a new case proves the previously-missed families
  (connection-uri / aws / slack / jwt) are redacted; the
  `summariseSession` spy asserts the model-bound transcript carries
  `[redacted-openai-key]`, not the live key. Mutation-proven
  (reverting the delegation to the weak local impl fails 2 tests).
- Pure string-scrub change (no LLM request/response protocol
  change) → no smoke:live; Ollama down regardless. `pnpm check`
  exit 0 (shared core touched), `pnpm lint` 0/0.

## Decisions

- Strengthened the canonical redactor rather than copying patterns
  into agent-core — one source of truth was the whole point; a
  second copy is exactly the divergence this fixes.
- `ya29.` body `{20,}` (high-entropy length) over the old `{6,}`,
  matching the shared redactor's "stable prefix + entropy length"
  house style to avoid false positives.
