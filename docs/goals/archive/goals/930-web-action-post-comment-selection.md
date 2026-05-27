# Goal 930 — web_action is one-shot selectable for "post a comment" (closes the goal-929 finding)

## Outward change

`web_action`'s tool description listed only "submit a form, book" as
examples. Goal 929's live `eval:tools` run found the local qwen3:8b
picked NO tool for "Post a comment on the project forum thread saying
the build works now." — the model didn't recognise posting/commenting
as a state-changing web action, even though `post` was already a
relevance keyword (keywords gate EXPOSURE, the description gates the
model's SELECTION).

Enriched the description with the concrete state-changing verbs Muse
actually supports — "submit a form, post a comment or reply, RSVP,
reserve or book, apply or sign up" — plus a use-when / not-when line
("Use when the user asks to DO something on a website that changes
state there … Do not use to READ a page, and not for payments").

Live result (qwen3:8b): "post a comment …" now selects `web_action`
with a sensible POST body; "reserve …" still selects it; the actuator
scenario is 7/7 and `eval:tools` is 32/32 (100%) with no regression in
any other tool's selection.

## Why this, now

The /goal session targets LIVE VERIFICATION DEBT. Goal 929 cleared
five selection tags but recorded `web_action`'s post-intent as a
genuine gap (kept `[UNVERIFIED-LIVE]` PARTIAL). tool-calling.md's
first-class concern is one-shot selection — a tool the model won't
pick for its core intent is not delivered — so closing that gap is the
direct next slice, re-checked by the very same `eval:tools` case that
exposed it.

## Decisions

- **Description, not keywords.** The fix is in the model-facing
  description (what drives SELECTION); the relevance keywords already
  exposed the tool. This is exactly the tool-calling.md split:
  keywords surface, description selects.
- **Verified by `eval:tools`, not `smoke:live`.** A tool-description
  change is what tool-calling.md mandates `eval:tools` for; the
  smoke:live battery never exposes the execute-risk `web_action`
  (local-only, no `--actuators`), so its 22/0/1 API request/response
  path is byte-identical and stands.

## Check

`MUSE_EVAL_MODEL=qwen3:8b pnpm eval:tools` — actuator-tools 7/7,
overall 32/32 (100%) ≥ 85%, exit 0. `@muse/mcp` test suite 820/820
green (web-action-relevance unaffected). `pnpm lint` 0/0.
