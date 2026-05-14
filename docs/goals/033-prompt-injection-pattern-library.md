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

open
