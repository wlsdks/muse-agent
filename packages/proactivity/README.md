# @muse/proactivity

Owns Muse's unasked-help surface: the loops deciding whether, when, and how to interrupt the user
unasked — reminders, digests, pattern-driven nudges, ambient/situational awareness, and
standing-objective action on the user's behalf. It is a package because these loops share one
interruption budget, one quiet-hours policy, and one veto/consent contract across every trigger.

## Public surface

Re-exported flat from per-loop modules (`export *`); the notable ones:

- `proactive-notice-loop`, `reminder-firing-loop`, `pattern-firing-loop`, `followup-firing-loop`,
  `objective-evaluation-loop` — the scheduled loops that decide whether to fire an unasked notice.
- `interruption-gate`, `quiet-hours`, `veto-key`, `undo-action` — the shared budget/timing gate
  every firing loop must pass, and the "stop doing this" learned-silence/reversal primitives.
- `consented-action` (`performConsentedAction`) — fail-closed dispatch of a standing-objective
  action toward a third party, gated on recorded, scope-matched consent.
- `digest-flush`, `situational-briefing`, `briefing-imminent`, `commitment-checkin`,
  `note-family-absence`, `web-watch` — batched notice delivery and ambient detectors.
- `macos-ambient-source`, `windows-ambient-source` — OS-level presence/idle signal adapters.
- `objective-evaluator`, `objective-evidence`, `approval-rate-analysis`, `run-outcome-analysis`,
  `presence`, `proposed-action-confirm` — firing-quality scoring, and draft-first confirmation.

## Depends on

- `@muse/agent-core` — runs the agent turn a firing loop triggers.
- `@muse/calendar` — imminent-event and briefing signals.
- `@muse/mcp-shared` — shared MCP tool/context types used by loop-triggered actions.
- `@muse/memory` — reads the user-model/pattern evidence a firing decision is based on.
- `@muse/messaging` — the channel a notice or standing-objective action is sent through.
- `@muse/prompts`, `@muse/shared`, `@muse/stores` — prompt templates, primitives, durable state.

## Rules that bind this package

Any loop here that ends in a message or action toward a third party is governed by
[`../../.claude/rules/safety/outbound-safety.md`](../../.claude/rules/safety/outbound-safety.md): draft-first,
fail-closed approval via `@muse/messaging`'s gate, and — for standing-objective actions —
recorded scoped consent via `performConsentedAction` (`consented-action.ts`), fail-closed on a
veto, missing consent, or scope mismatch.

## Tests

```bash
pnpm --filter @muse/proactivity test
```
