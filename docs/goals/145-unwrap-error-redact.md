# 145 — `unwrapErrorMessage` scrubs credentials before returning to client

## Why

`sendAgentError`'s 500-branch passes `unwrapErrorMessage(error)`
into the chat-error response body. The unwrapper walks the
`cause` chain (RetryExhaustedError → ModelProviderError →
underlying fetch error) and joins each message with `" — "`. So
the joined string sometimes carries the upstream provider's
diagnostic text — and that text occasionally echoes the request
payload, which in turn can carry the partial / full credential
that triggered the auth failure:

- OpenAI 401 → "Invalid token sk-proj-…" (observed in production
  diagnostic messages).
- Anthropic 401 → "Anthropic API error from sk-ant-api03-…".
- GitHub 422 → "ghp_… lacks scope X".

A client / log file picking up the error response then carries
the secret too. Same risk-class as goal 111 (messaging registry
scrub) but on the inbound-from-LLM path.

## Scope

- `apps/api/src/server-agent-error.ts` `unwrapErrorMessage`:
  - Run the joined message through `redactSecretsInText` before
    returning.
  - Non-Error inputs ("Agent run failed" fallback) skip the
    scrub — already constant.
  - Existing behaviour (cause chain walk, cycle guard, " — "
    separator) unchanged.

## Verify

- New `apps/api/test/error-unwrap.test.ts` cases:
  - OpenAI 401 with `sk-proj-…` in the inner cause →
    `[redacted-openai-key]` + surrounding prose preserved.
  - Anthropic `sk-ant-api03-…` → `[redacted-anthropic-key]`.
  - GitHub `ghp_…` → `[redacted-github-pat]`.
- `pnpm --filter @muse/api test` — 153 tests pass.
- `pnpm check` exit 0; `pnpm lint` exit 0.
- `pnpm smoke:live` — 13/0 (the redaction runs on the error
  reply path; live success round-trip unaffected).

## Status

done — the API 5xx / 4xx error reply no longer echoes the
credential that triggered the upstream failure. Pairs with the
goal-086 / 107 / 108 / 109 / 111 / 112 / 116 / 138 / 139 / 140
credential-hygiene line.
