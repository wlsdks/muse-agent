## 824 — fix: inbox read survives a single bad message (P19 email hardening)

## Why

P19 hardens the one-of-each actuators against real failure modes;
753 did weather (retry-with-backoff), email was a named follow-on.
`GmailEmailProvider.listRecent` reads the message list, then loops
fetching each message's metadata. The per-message `get()` was
**un-guarded**: if ONE message fetch failed — a retry-exhausted 5xx,
or a 200 carrying a non-JSON body (the HTML error interstitial Gmail
and corporate proxies occasionally serve) — `response.json()` threw
and the WHOLE `listRecent` threw, dropping every already-fetched
message. The user asks for 10 recent emails and gets **zero** because
message #7 hiccuped. The briefing's inbox line and `muse inbox` both
go silent over a single transient blip. A JARVIS you depend on shows
the 9 it could read, not none.

## Slice

`@muse/mcp` email-provider.ts:
- Add `GmailAuthError extends Error` (exported) — `get()` throws it for
  401/403 (a permanent credential failure) instead of a plain `Error`.
- `listRecent`'s per-message loop wraps each `get()` in try/catch:
  rethrow on `GmailAuthError` (a bad token affects every message — a
  partial list would HIDE the real problem), otherwise `continue`
  (skip that one message, return the inbox we could read).
- The list-level `get()` stays un-wrapped: no list = nothing to show,
  and its failure already propagates a clear error (unchanged contract,
  existing test still green).

## Verify

`@muse/mcp` email-provider-retry.test.ts (+3, 6 total), contract-faithful
sequenced fetch fake:
- a single message's malformed (non-JSON 200) body → the other two
  messages still return;
- a single message's retry-exhausted 500 → skipped, the rest survive;
- a 401 mid-batch → propagated (a permanent credential failure is never
  masked as a partial list).
- **Mutation-proven**: dropping the per-message try/catch → both skip
  tests fail (the whole batch throws); the auth-propagate invariant
  holds either way (that's the point — only the skip behavior is new).
- Full `pnpm check` EXIT 0, `pnpm lint` 0/0. Gmail HTTP path only (not
  the LLM request/response path) → no smoke:live applicable.

## Decisions

- **Skip transient, propagate auth** — the distinction is the whole
  point: a flaky single message must not nuke the batch, but a dead
  token must not be silently swallowed into a short/empty list. The new
  typed `GmailAuthError` is what lets the loop tell them apart.
- No bullet flip — P19's "one actuator hardened" bullet is already `[x]`
  (753/weather); this is the email follow-on slice it names. CAPABILITIES
  line under P19.
