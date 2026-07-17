---
title: Continuity longitudinal evidence gate
status: completed
date: 2026-07-17
scope: deterministic collection coverage; no new outcome or promotion
---

# Continuity longitudinal evidence gate

## Decision

Keep Personal Continuity manual and user-invoked. Raw first-20 outcome thresholds and
first-five/next-five trends are not longitudinal proof. The core now reports the numeric
collection gap separately and can advance only from `collecting` to `audit-required`.
Neither state authorizes Observe, proactive delivery, or promotion.

## What the Module proves

- life and work each need ten explicit feedback entries so their first-five and next-five
  windows cannot be hidden inside an aggregate;
- only delivery dates with explicit feedback count, normalized to the actual UTC date;
- equal instants use delivery id as the deterministic tie-break;
- incomplete first-20 feedback and malformed timestamps fail closed;
- numeric coverage never proves natural timing, distinct domains, comparability, or strict
  task-advancing evidence.

## Real-state result

The real local store was evaluated read-only. It contained 21 deliveries and 21 outcomes.
Life had 6/10 feedback across 2/2 UTC dates; work had 15/10 across 2/2. The result was
`collecting`, with four additional life feedback entries required. Before/after bytes and
SHA-256 were identical. No Pack, outcome, receipt, policy, or source link was created or
changed.

## Claims not supported

This gate does not infer whether a return was natural, validate historical `used` receipts,
pair comparable episodes, add a run/session id, change adaptation, start observation, or
enable proactive delivery. It makes the absence of that evidence visible and testable.
