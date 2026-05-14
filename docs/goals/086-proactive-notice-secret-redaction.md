# 086 — Redact accidental secrets in synthesized proactive notice text

## Why

Phase-D proactive notices are LLM-generated heads-ups
("Stark님, Q3 budget memo due in 5 min"). The synthesis prompt
includes persona facts + task summaries; if a credential
accidentally lives in a task title (`"rotate API key
sk-proj-..."`) the model can echo it into the delivered notice.
Add a pre-delivery scrubber that detects high-confidence secret
shapes (OpenAI `sk-`, Anthropic `sk-ant-`, GitHub `ghp_` /
`gho_`, JWTs, AWS access keys) and replaces them with
`[redacted-secret]` before the messaging sink sees them.

## Scope

- New `redactSecretsInText(text)` helper in
  `packages/shared` (alongside `stripUntrustedTerminalChars`).
- Regex families cover the common token shapes; opt-in extra
  patterns via `MUSE_SECRET_REDACTION_EXTRA_REGEXES` (CSV of
  regex literals, validated at startup).
- The proactive notice loop runs the scrubber after synthesis
  and before `messagingRegistry.send`.

## Verify

- shared +1 test asserting each documented pattern redacts.
- mcp +1 test that wires a scrubber-enabled loop and confirms
  the delivered text on the messaging sink is scrubbed.

## Status

done — new `redactSecretsInText(text)` helper in
`@muse/shared` (alongside `stripUntrustedTerminalChars`). High-
confidence credential shapes are replaced with
`[redacted-<family>]` so log readers still see WHICH kind of
secret leaked without leaking the bytes themselves. Patterns:

  - openai-key (sk- + sk-proj-)
  - anthropic-key (sk-ant-)
  - github-pat (ghp_ / gho_ / ghu_ / ghs_ / ghr_)
  - aws-access-key (AKIA / ASIA + 16 alphanumeric)
  - google-api-key (AIza + 35+ alphanumeric)
  - slack-bot-token (xox[abprs]-)
  - jwt (eyJ + dot + payload + dot + signature)

Pattern order matters — `sk-ant-` is matched before the
generic `sk-` so an Anthropic key lands in the right family.

The proactive notice loop runs the scrubber after synthesis
and before `messagingRegistry.send`, the broker publish, and
the history sidecar append — every downstream consumer sees
scrubbed text.

Scope deviation: the `MUSE_SECRET_REDACTION_EXTRA_REGEXES`
env-driven opt-in extension is deferred — the core seven
patterns cover the documented "high-confidence" shapes; user-
supplied regex literals add a new code-execution surface that
warrants its own careful design.

shared +1 test asserts each documented pattern redacts and
plain English passes through. mcp +1 test wires a fake
messaging sink + a task with an embedded sk-proj- token and
confirms the delivered text contains `[redacted-openai-key]`
instead of the raw secret.
