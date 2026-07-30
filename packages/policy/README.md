# @muse/policy

The deterministic security/privacy policy layer: injection and PII detection, tool-output
sanitization, approval receipts, progressive-autonomy capability profiles, and privacy
routing. It is a package because these are exactly the checks that `.claude/rules/architecture.md`
requires stay deterministic code — never a prompt instruction — and every runtime surface
(agent-core, tools, mcp) needs to depend on the same policy types without depending on
each other.

## Public surface

- `injection-patterns.js`, `injection-detection-counter.js` — deterministic prompt-injection
  pattern detection and its counters.
- `pii-patterns.js` — PII pattern detection used by input/output guards.
- `tool-output-sanitizer.js` — `SanitizedToolOutput` production for tool results.
- `tool-exposure-authority.js` — `ToolExposureAuthority`, the opaque per-run authority that
  gates a delegated-write-scope tool's canonical-path checks.
- `approval-receipt.js` — the recorded approval receipt shape for a gated action.
- `progressive-autonomy.js` — capability-profile types for progressive-autonomy opportunities.
- `capability-profile.js` — the capability-declaration types other packages route on.
- `adversarial-red-team.js` — must-refuse/over-refusal test-case types.
- `prompt-leakage.js`, `source-block-sanitizer.js`, `migration-redaction.js`, `topic-drift.js`,
  `structured-output.js`, `privacy-routing.js`, `guard-monitor.js` — the remaining detection,
  sanitization, and routing primitives the guard pipeline composes.

## Depends on

- `@muse/model` — model-facing types this policy layer's output feeds back into.
- `@muse/shared` — shared types and utilities.

## Rules that bind this package

- [`../../.claude/rules/architecture.md`](../../.claude/rules/architecture.md) — "Deterministic code for policy, permissions,
  budgets, and stop conditions" is this package's charter; it must never become an LLM prompt.
- [`../../.claude/rules/outbound-safety.md`](../../.claude/rules/outbound-safety.md) — `approval-receipt.js` and `progressive-autonomy.js`
  back the recorded-consent and approval-gate requirements for any outbound action.

## Tests

```bash
pnpm --filter @muse/policy test
```
