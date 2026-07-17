---
title: Shared Continuity review core evaluation
status: completed
date: 2026-07-17
scope: review semantics and read-only verification; no new dogfood outcome
---

# Shared Continuity review core evaluation

## Decision

The review path is materially more consistent, not more intelligent. CLI,
HTTP, and web now consume one core projection for first-20 eligibility,
oldest-pending selection, progress, and exact current evidence. Keep delivery
manual-only and keep the existing outcome policy and store schema.

## Before and after

| Property | Before | After |
|---|---|---|
| First-20 queue | Private CLI implementation | One `@muse/attunement` Module |
| HTTP/web pending item | No canonical pending queue | Same core `next` and `progress` |
| Review evidence | CLI resolved exact current links; web showed stored IDs | Both use the same exact current-link resolution |
| Removed source | CLI-specific unavailable handling | Core-owned unavailable result on every surface |
| Outcome commands | CLI-owned | Still CLI-owned; not leaked into the core |
| Review read effects | Assumed per surface | API byte-identity test plus real-store byte check |

## Verification evidence

- Core/Pack focused tests: 21 passed, including seven review Interface cases.
- HTTP route tests: 9 passed, including direct-core equality, corrupt-store
  structured failure, byte-identical GET, and two-pending outcome-to-next.
- CLI tests: 17 passed; removing only the CLI `outcomeCommands` Adapter yields
  the same canonical core projection.
- Chromium Browser Mode: 3 passed; explicit `used` feedback advances the
  visible oldest-pending card to the second delivery.
- TS7 root graph, direct web typecheck, changed-file ESLint, and diff checks
  passed.

The real local Attunement file was read through the canonical local resolver.
Before and after both contained 21 deliveries and 21 explicit outcomes; file
bytes and SHA-256 were unchanged. The honest result was no pending item and
first-20 progress of 20 reviewed out of 20. No receipt was added or rewritten.

## Claims not supported

This change does not add inference, automatic source linking, proactive
delivery, a new outcome, a policy-reducer change, a store migration, causal
adaptation evidence, or another dogfood episode. It improves review locality,
surface consistency, and the ability to verify the existing loop.
