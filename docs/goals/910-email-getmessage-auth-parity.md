# Goal 910 — `read_email` reports an expired token instead of "no such message"

## Outward change

When the Gmail access token is missing / expired / lacks scope, the
agent-facing `read_email` tool now reports the **auth failure** —
`Gmail auth rejected (401) — the access token is missing, expired, or
lacks gmail.readonly scope` — instead of the misleading `no message
with that id (or the inbox was unreachable)`. Before, `getMessage`
swallowed every error (including a permanent 401/403) as `undefined`,
so an agent asked to read a message on an expired token concluded the
**email didn't exist** rather than that the user needs to re-auth — a
wrong answer that sends the agent (and user) down the wrong path.

## Why this, now

P19 actuator-hardening — correct failure-mode classification for the
email reader. `listRecent` / `summariesForIds` already make this
distinction deliberately: a permanent `GmailAuthError` propagates (it
affects every read — surface it), while a single message's transient
blip / malformed body is skipped. `getMessage` was the one read method
that didn't follow the policy — it `catch {}`-swallowed auth errors
too. Via the CLI the gap was masked (the listing call hits the 401
first), but the agent-facing `read_email` tool calls `getMessage`
directly with an id, so the misclassification reached the model
unfiltered. Cross-method parity closes it.

## How

- `GmailEmailProvider.getMessage`: re-throw `GmailAuthError`, return
  `undefined` only for non-auth errors (transient / malformed) —
  exactly mirroring `summariesForIds`'s catch.
- `read_email` tool: wrap the `getMessage` call in try/catch and return
  `{ found: false, id, reason: <error message> }`, so the propagated
  auth message reaches the agent as the reason (matching how
  `email_recent` already surfaces `listRecent` failures). A non-auth
  failure still degrades to the existing "no message with that id"
  reason.

## Verification

`packages/mcp` `email-read-message.test.ts` (`pnpm --filter @muse/mcp
test`, 938 passing): a contract-faithful fake fetch returning `401`
drives the REAL `getMessage` → asserts it `rejects` with
`GmailAuthError`; and the real `read_email` tool → asserts
`found:false` with a `reason` containing "auth rejected" and NOT "no
message with that id". The happy path (200 → full body) and the
404-→undefined path stay green. Mutation-proven: reverting `getMessage`
to swallow the auth error (`catch { return undefined }`) fails both new
tests; restored green. `pnpm check` green (mcp 938, apps/cli 1625,
apps/api 323); `pnpm lint` 0/0. Email tool-handler + provider logic, no
LLM request/response path → no smoke:live (Ollama down regardless).

## Decisions

- Surfaced the raw provider message as the tool `reason` rather than a
  re-worded string — `GmailAuthError`'s message already names the fix
  ("token missing/expired or lacks scope"), and re-wording risks
  drifting from the provider's actual diagnosis.
- Kept `getMessage`'s `EmailMessage | undefined` contract for non-auth
  failures (a genuinely-missing message is still `undefined`); only the
  permanent-auth case now throws, which is the one case the caller must
  treat differently.
