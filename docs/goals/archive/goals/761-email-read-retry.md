# 761 — feat: email inbox reads retry transient failures; sends never double-send (P19)

## Why

P19 hardening, next actuator after weather (753). `GmailEmailProvider`
did a single fetch on every read and threw on any `!response.ok`, so a
transient 429/5xx dropped the inbox triage / briefing needs-reply line.
The send path has the OPPOSITE requirement: a retried POST could
deliver the same email twice — it must stay single-shot.

## Slice

- Extracted the proven retry helper from weather.ts into a shared
  `@muse/mcp` http-retry.ts (`fetchWithRetry`, `isRetriableStatus`,
  `RetryOptions` + an `init` passthrough for auth headers). weather.ts
  re-exports them (its tests/imports unchanged) and is behaviour-
  identical.
- `GmailEmailProvider.get()` (the idempotent READ primitive behind
  `listRecent` / inbox triage) now routes through `fetchWithRetry`
  with the Bearer-auth header — retries 429/5xx, fails fast on a
  permanent 4xx (incl. 401/403 auth, never retried).
- `sendEmail` is UNCHANGED — single-shot, no retry (deliberate: a
  retried send is a duplicate message to a third party).

## Verify

- `@muse/mcp` email-provider-retry.test.ts (new, 3), contract-faithful
  fake fetch + no-op sleep:
  - `listRecent` recovers from a transient 503 on the inbox read (3
    calls: 503 + list retry + message detail).
  - read still surfaces a clear `Gmail API 503` once retries are
    exhausted.
  - `sendEmail` on a 503 throws immediately, fetch called EXACTLY ONCE
    (no double-send).
- weather-retry.test.ts still 8/8 (the extraction is behaviour-
  preserving).
- **Mutation-proven**: reverting `get()` to a plain non-retry fetch
  fails the two read tests (and the send test stays green — send was
  never retried); restore → 3/3.
- Full `pnpm check` EXIT 0 (mcp 693, every workspace green); `pnpm
  lint` 0/0. HTTP actuator, not the model path → no `smoke:live`.

## Decisions

- **Read retries, send does not.** Idempotent reads benefit from
  retry; a state-changing send must never auto-retry (double-send is
  an irreversible third-party effect). The split is the whole point.
- **Shared `http-retry.ts`** — weather + email now share one retry
  implementation; future read actuators (contacts) reuse it. No bullet
  flip — P19 is already `[x]` (753); this is the "repeat per actuator"
  follow-on, recorded as a CAPABILITIES line.
