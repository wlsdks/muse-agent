## 860 — fix: the web-action audit log records the submitted body (the exact content)

## Why

`performWebActionWithApproval` is the fail-closed actuator behind every
agentic web action (`web_action` tool, `muse web-action`, smart-home
writes). outbound-safety rule 4 requires every outbound action — sent
OR refused — to append "a rationale-bearing entry to the action log
with the **exact content**." But the log only recorded
`web action: <summary> (<method> <url>)` — the **request body**, which
IS the exact content of a state-changing POST (the form fields / JSON
being submitted), was dropped. So the reviewable/undo log could show
WHERE a booking went but not WHAT was actually submitted — a real audit
gap on the highest-blast-radius primitive.

## Slice — log the body, secret-scrubbed + capped

`@muse/mcp` web-action.ts: the log `what` now appends
` body: <redacted, ≤500 chars>` when the request has a non-empty body.
Built once and shared by the performed / refused / failed log closure,
so the body is recorded on a refusal too ("what WOULD have been sent").
The body is run through `redactSecretsInText` (the action log is
long-lived and may sync — same posture as note ingest 846/852) and
length-capped to bound log size.

## Verify

`@muse/mcp` web-action.test.ts (+2, 8 total) — drives the REAL
`performWebActionWithApproval` against a contract-faithful fake fetch +
a real action-log file, read back via `readActionLog`:
- the submitted body (`{"time":"19:00"}`) appears in the log `what` for
  a PERFORMED action AND for a REFUSED one;
- a telegram-bot-token-shaped secret in the body is scrubbed
  (`[redacted-telegram-bot-token]`, raw secret absent).
- **Mutation-proven**: dropping the body from `what` fails the
  body-recording test; logging the raw (un-redacted) body fails the
  secret-scrub test.
- `pnpm check` EXIT 0, `pnpm lint` 0/0. (No LLM request/response path —
  the gated HTTP boundary is faked — so no smoke:live.)

## Decisions

- **Redact, don't omit.** "Exact content" and "don't leak secrets" both
  matter; logging the body scrubbed (not dropped) satisfies rule 4 while
  keeping the long-lived log safe. A 500-char cap bounds a large form
  body without losing the identifying head.
- **Recorded on refusal too.** Rule 4 is explicit that a refused action
  is logged "with the exact content" — sharing the `bodyNote` across the
  performed/refused/failed closure makes "what would have been
  submitted" reviewable even when nothing fired.
- No new dependency (`redactSecretsInText` is already in `@muse/shared`).
