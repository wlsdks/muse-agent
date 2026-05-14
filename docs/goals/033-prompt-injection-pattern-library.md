# 033 — Expand prompt-injection input guard patterns

## Why

createInjectionInputGuard catches a few known patterns. Expand the
detection library — system-prompt-override probes, role-switch attempts,
adversarial JSON-injection — and snapshot-test it.

## Scope

- Survey known prompt-injection corpus (e.g. Lakera Prompt Injection
  Dataset terms only).
- Add 5-10 new pattern detectors to findInjectionPatterns.
- Snapshot test fixtures so future tweaks don't regress.

## Verify

- agent-core +N tests.

## Status

done — added 5 pattern families (7 regex entries total) to
`sharedInjectionPatterns`: history_poisoning (en + ko),
training_data_extraction, sandbox_escape, few_shot_poisoning,
tool_spoofing. policy +6 tests covering each new family plus a
false-positive sanity check on ordinary planning text.
