## 857 — fix: `web_action` is selectable for post / rsvp / reserve / apply / register

## Why

`web_action` is Muse's ONLY agentic web actuator (gated, draft-first
submit/book to a third party). Its relevance keywords were
`["web","submit","book","form","action"]`, so on the cheap local Qwen
it surfaced for "submit the form" / "book a table" but **MISSED the
equally-common state-changing-web verbs** — confirmed against the real
`DefaultToolFilter`: "post a comment", "rsvp to the invite", "reserve a
table", "apply to the job", "sign up/register" all failed to surface
the tool, so the model could never select it for those one-shot. A web
actuator the user can't reach for half their web verbs is half
delivered (standing #1 priority: a tool that exists but isn't
selectable is not delivered).

## Slice — add the missing non-payment verbs

`@muse/mcp` web-action-tool.ts: keywords += `post, reserve, rsvp,
apply, register, subscribe` + Korean `예약 (reserve/book)`, `신청
(apply/register)`. Payment verbs (buy / order / purchase / checkout /
pay) are **deliberately excluded** — payments are permanently out of
scope per outbound-safety.md, and the tool's own description already
says "Not for payments".

## Verify

`@muse/autoconfigure` web-action-relevance.test.ts — the REAL
`web_action` through the REAL `DefaultToolFilter`:
- the previously-covered submit / book / form prompts still surface it;
- post / rsvp / reserve / apply / register now surface it;
- an unrelated prompt ("what is 2+2?", "summarize this article")
  surfaces NONE (small exposed set per tool-calling.md rule 1).
- **Mutation-proven**: reverting to the old 5-keyword set fails the
  new-verbs test (rebuilt dist, re-run).
- `pnpm check` EXIT 0, `pnpm lint` 0/0.

## Decisions

- **Exposure deterministically verified; live SELECTION
  [UNVERIFIED-LIVE].** The DefaultToolFilter relevance test proves the
  tool now SURFACES for these prompts (the deliverable, Ollama-down-
  verifiable, same as 849/850/851). Whether the local model then PICKS
  it needs a `smoke:live` round-trip — Ollama is down this session, so
  that rides the standing live mandate.
- **No payment verbs.** Surfacing `web_action` for "buy/order/checkout"
  would invite the model toward payment flows that are a hard product
  boundary; the added verbs are all non-payment submit/book/post
  actions the gate already covers.
- No new dependency.
