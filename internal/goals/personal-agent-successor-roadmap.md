---
title: Muse personal-agent successor roadmap
audience: [owner, product, engineering, evaluation]
purpose: Continue from Core100 with bounded evidence and release-gap closure
status: active-authoritative
decision: continue-with-successor
activatedFromHead: 926c01738b9be9a8b1c3668ec61c2b66d17dce63
updated: 2026-07-29
related:
  - personal-agent-core-100-roadmap.md
  - ../../docs/development/personal-agent-qualification.md
  - ../../docs/development/ai-agent-testing-strategy.md
  - ../../.claude/harness/contract.md
---

# Muse personal-agent successor roadmap

## Decision

Core100-100's decision is `continue-with-successor`. The current background runtime is
healthy/pass, but capability and delivery are `unverified`, release evidence is `red`, and organic
effectiveness is `not-proven`. This is not assumed to be `release-ready`.

Muse's controlled continuity, encrypted restore, daemon rollback, and provider-neutral runtime
foundation are worth continuing to experiment with, and the remaining blockers can be reduced to
the recoverable 20-minute slices below. External publication, tag/release, signing, credential
use, and releasing the delivery brake are not authorized by this decision.

## Execution contract

- Each activation's active wall-clock does not exceed 20 minutes, and a single command does not
  exceed 12 minutes.
- The legacy 990-minute capability battery is not run. Only existing bounded shards are
  aggregated, and only one actually-empty shard is run at a time.
- Source-changing BUILD WIP is 1; read-only EVIDENCE/MONITOR WIP is 1.
- The deterministic, controlled-live, and organic-production denominators are never promoted into
  one another.
- An artifact that does not match the current HEAD/tree/time/input hash is not green evidence.
- The release/signature/credential/permission/process boundary starts on Sol, and a fresh
  evaluator makes an independent verdict.
- A slice that fails to close a red blocker is left as `monitoring` or `blocked`, and work moves
  to the next dependency-ready safety/reliability slice.

## Authoritative execution order

| ID | lane | 20-minute slice | acceptance | dependency |
| --- | --- | --- | --- | --- |
| PA-S001 | EVIDENCE | Inventory Core100's bounded capability shards and current qualification against the current HEAD. | `verified-current`, `stale`, `missing`, or `blocked` is shown per required axis with the exact artifact/hash, and no shard is executed. | Core100-100 |
| PA-S002 | EVAL | Run only the one required capability axis marked `missing` in PA-S001, with frozen input. | Within 12 minutes there is a terminal artifact, exact denominator, skip/failure reason, and HEAD/tree/input hash, and no other axis or the 990-minute battery is started. | PA-S001 |
| PA-S003 | RELEASE | Classify release-scanner findings by hash only, as one `ruleId × scope` slice. | The matched value is not printed; false-positive, remediation-required, and owner-review are separated, and the gate is red if any finding remains unclassified. | Core100-097 |
| PA-S004 | OPS | Separate the scheduled/overdue follow-up/reminder queue into an inspect-only snapshot. | The pending-draft, scheduled, and overdue denominators and their age are visible, and send/delete/reschedule/provider calls are zero. | current qualification |
| PA-S005 | RELEASE | Record the current package and signature boundary as preflight-only. | Among reproducible candidate, detached signature, and commit/tag verification, the actually available path and the missing authority are separated, and signing/tag/release effects are zero. | PA-S003 |
| PA-S006 | RECOVERY | Verify the isolated install-health rollback for one fresh local package candidate. | A failed health probe reverts to the known-good artifact, the personal-data digest is unchanged, and actual login/reboot or owner-profile mutation is zero. | PA-S005, Core100-098 |
| PA-S007 | MONITOR | Review only the new organic snapshot after Core100-099's `nextObservationAt`. | Without an exact user/thread/source/window/denominator/explicit label, `not-proven` is retained and no waiting occurs. | Core100-099 |
| PA-S008 | GOVERNANCE | Re-judge every applicable gate with fresh provenance. | One of `release-ready`, `continue-with-successor`, or `terminate` is recorded along with blockers/rollback, and red/unknown is never promoted to green. | PA-S001, PA-S003, PA-S004, PA-S006, PA-S007 |

PA-S002 handles only one axis at a time. If PA-S001 finds multiple required axes missing, activate
them sequentially under the same contract, and move to the next axis only once each artifact is
independently reusable.

## Current blockers and rollback

- capability: `unverified`, because current qualification lacks an exact-provenance capability
  attempt.
- delivery: `unverified` — the local-only/provider-lock/self-learning hold is maintained, but the
  delivery brake is engaged and there is an overdue queue.
- release: `red` — the source/candidate scan is complete, but there are unclassified findings and
  no verified signature.
- organic: `not-proven`, because fresh organic-production observations and explicit outcome labels
  are zero.
- install: deterministic PID/list rollback is verified, but there is no package, heartbeat, or
  login/reboot proof.

The rollback baseline is the normal `origin/main` at `926c01738b9be9a8b1c3668ec61c2b66d17dce63`. If
a successor slice worsens a gate, `git revert` the verified source commit normally instead of
force/reset, then rerun the same gate. The delivery brake, provider lock, local-only setting, and
self-learning hold are not relaxed without new independent evidence and the necessary owner
authority.

