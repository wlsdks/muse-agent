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

open
