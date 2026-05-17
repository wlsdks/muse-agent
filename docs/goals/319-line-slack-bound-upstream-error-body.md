# 319 — LINE & Slack spliced the raw unbounded upstream error body into the thrown error

## Why

`MessagingProviderError` messages flow into logs, retry
classification, and user-facing error surfaces. Telegram and
Discord bound the upstream HTTP error body before splicing it in:

```ts
`Telegram sendMessage failed: ${parsed?.description
  ?? (truncateErrorBody(text) || response.statusText)}`
`Discord sendMessage failed: ${parsed?.message
  ?? (truncateErrorBody(text) || response.statusText)}`
```

`truncateErrorBody` (`@muse/shared`, 240-char cap) exists
precisely so a pathological upstream response — an HTML 502 from
a gateway/proxy, a multi-KB stack dump, a CDN block page — can't
flow unbounded into the error string. **LINE and Slack were
missed when this pattern was applied:**

- `line-provider.ts` send: `parsed?.message ?? (text ||
  response.statusText)` — raw `text`.
- `slack-provider.ts` `conversations.history` *and*
  `chat.postMessage`: `parsed?.error ?? (text ||
  response.statusText)` — raw `text` (both sites).

When LINE/Slack are fronted by a proxy returning a large
non-JSON body, `tryParseJson` yields `undefined`, the `??` falls
through, and the entire body lands in `error.message` — an
unbounded log line, a bloated retry-decision string, and a
poor error surface for the user. Inconsistent with the
Telegram/Discord posture and the messaging outbound-robustness
work (311 / 312 / 315).

## Scope

`packages/messaging/src/line-provider.ts` &
`packages/messaging/src/slack-provider.ts`:

- Import `truncateErrorBody` from `@muse/shared` (as
  Telegram/Discord do — first import).
- LINE send error: `(text || response.statusText)` →
  `(truncateErrorBody(text) || response.statusText)`.
- Slack `conversations.history` + `chat.postMessage` errors:
  same substitution (both sites).

Behaviour-preserving for normal short errors —
`truncateErrorBody` only `.trim()`s a body ≤ 240 chars, so a
typical `{"message":"Invalid token"}` / `channel_not_found` path
is byte-identical (those go through `parsed?.message` /
`parsed?.error` anyway). The only change is that a > 240-char
raw body is now capped with an ellipsis, exactly as Telegram and
Discord already do. No new comment needed — the call is
self-describing and the WHY now lives consistently across all
four providers.

## Verify

- `pnpm --filter @muse/messaging test` — 129 pass (was 127;
  +2). New regressions: a 5000-char non-JSON `502` body from
  LINE `pushMessage` and Slack `chat.postMessage` →
  the thrown message starts with the provider prefix, ends with
  the truncation ellipsis `…`, and is `< 300` chars (the raw
  5000-char body no longer flows into the error/logs). The
  existing ok:false / 4xx-propagation / mrkdwn-escape (312) /
  >4096-truncate tests stay green (short errors are byte-identical).
- `pnpm check` — every workspace green (messaging 129,
  apps/cli 563, apps/api 161, all packages). `pnpm lint` —
  exit 0.
- No real-LLM request/response path touched (outbound HTTP error
  formatting). A live Qwen run cannot force a multi-KB upstream
  gateway error, and a real LINE/Slack round-trip needs a token
  the project must not commit, so the deterministic fake-fetch
  regression is the rigorous verification — same stance as
  goals 311 / 312 / 315.

## Status

done — LINE and Slack now bound the upstream error body with
`truncateErrorBody` exactly as Telegram and Discord do, so a
pathological multi-KB gateway/proxy response can no longer flow
unbounded into `MessagingProviderError.message` / logs / retry
strings. The bounded-upstream-error-body posture is now
consistent across all four HTTP messaging providers.
