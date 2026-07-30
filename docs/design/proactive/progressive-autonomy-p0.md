---
title: Progressive autonomy P0
status: implemented
updated: 2026-07-18
---

# Progressive autonomy P0

P0 proves one reversible local action: `muse.tasks.complete-linked-next-step` schema v1. It may change only an exact user-authored Attunement link from a local open task to done. A standing grant is bound to the user, thread, task link instance including `linkedAt`, `open -> done`, expiry, maximum uses, policy version, executor version, and `issuedBy: user`.

The policy reducer returns enforcement (`deny | confirm | allow-standing`) separately from shadow assessment (`wouldDeny | wouldConfirm | wouldAllowStanding`). Shadow mode never changes confirmation enforcement. Hard deny, veto, missing or corrupt link authority, and unsupported actions deny. Only an exact active grant can allow standing execution; all other supported requests require confirmation and cannot enter the mutation path.

Grant administration is a trusted host-composition boundary. The authority-minting file adapter is deliberately absent from the general `@muse/stores` barrel and is exposed only through the explicit `@muse/stores/host-progressive-autonomy` entry point. Trusted host wiring owns its construction, user-authorization verifier, file ownership, and OS permissions; TypeScript and package exports are not a security sandbox. Model, tool, and action-executor wiring receives only the frozen narrow executor interface, without issue, revoke, or veto methods. Approval rate, silence, model confidence, Attunement outcomes, and executor output are not inputs to grant issuance or scope.

Live execution persists `prepared` before claiming. One autonomy-file lock rechecks the active grant, veto, and current exact link instance, reserves one use, and persists `executing` with immutable live mode, policy/executor versions, decision, and claim time. Only a replay with that same live claim context may resume task CAS; shadow, hard-deny, and version-mismatched calls cannot inherit its mutation authority. Terminal `succeeded`, `failed`, `unknown`, and `undone` executions return their durable result without re-entering CAS. The task file lock performs an exact fingerprint CAS. Exact intended-after is replay success; any other state is `unknown` with no task write. Durable action receipts contain the before/intended/observed fingerprints, full grant, thread/link, trace, outcome, and rationale.

The durable store rejects malformed records and cross-record inconsistencies, including duplicate execution/idempotency/receipt identifiers, missing or scope-mismatched grant references, inconsistent action/shadow/undo receipts, and `usedCount` disagreement with durable claims. Every public mutation validates its complete candidate state with those same strict rules before the atomic write, so invalid prepare inputs cannot poison a previously readable store. A `succeeded` receipt must include an observed fingerprint exactly equal to its intended-after fingerprint at both write and reload boundaries; `unknown` retains the actual non-matching observation when available. Undo first validates exact recorded after-state and persists an `undoing` claim under the autonomy lock. A before-state can count as crash recovery only after that durable claim exists; a user-restored before-state without the claim is refused. The task restore and undo receipt are idempotently reconciled after a crash.

## Approval execution prerequisite

Existing channel approvals use a separate shared durability boundary before
they can become an autonomy input. API and CLI atomically move one pending id
through `claimed -> executing -> succeeded | unknown`, while an explicit
refusal moves it to `denied`. Only the winning claim token can advance a state,
and every terminal or in-flight record is a no-replay tombstone. Tool output is
classified once in `@muse/messaging`: any explicit error or false outcome marker
wins over success; output that does not prove success becomes `unknown` and is
never retried automatically. The store validates complete candidate state,
owner binding, approval lifetime, monotonic timestamps, unique ids and claim
tokens before an atomic write. This is fail-closed at-most-once execution, not
exactly-once: a crash after claim may omit the action, but cannot repeat it.

`completePendingApproval` is the single orchestration boundary shared by API
and CLI. It owns claim, effect-free preparation, begin, the one effect-bearing
callback, outcome classification, and finalization. API and CLI adapters cannot
rebuild that sequence; they only resolve or confirm the exact claimed snapshot
and map the coordinator's discriminated result. CAS loss reports the phase and
actual durable state. A store exception is distinct from CAS loss and reports
whether an effect was attempted plus an observed state when a strict follow-up
read succeeds; otherwise it remains explicitly unobserved and is never retried
automatically.

Approval recovery is an explicit pre-effect takeover, not an automatic retry.
`status` returns bounded metadata but never the claim token, tool arguments,
internal actor identity, or store path. A `claimed` local task mutation becomes
eligible only after a fixed 15-minute lease while its immutable snapshot is
still unexpired. Recovery then atomically rotates the token, preserves the
original `claimedAt`, and re-enters `completePendingApproval` with acquisition
phase `recover`. The previous claimant can no longer win `begin`; `executing`,
`unknown`, `succeeded`, and `denied` records are never recovered. Staleness is
only eligibility for an explicit takeover, not evidence that the prior process
crashed.

Inbound channel replies do not execute pending actions. They return the exact
CLI approval id; the former unused `autoRun -> clear` option was removed because
it bypassed the durable claim boundary. These receipts improve execution safety
only and never issue or widen an autonomy grant.

## Outside P0

P0 has no live-autonomy CLI, API, web, messaging, posting, purchasing, finance, account or credential changes, calendar invitations, browser submission, generic desktop control, irreversible deletion, subagent side effects, new personal-data sources, or outcome-driven permission promotion. Web, CLI, and local/authenticated HTTP expose shadow evidence review only; none can execute or authorize the reviewed action. Cross-surface live execution and every additional action schema require separate reviewed slices.

## Shadow dogfood and promotion

Collect 20–50 real shadow decisions before considering live promotion. Each sample must preserve existing confirmation enforcement and retain its rationale receipt. Review exact-scope matches, false allows, false denies, user vetoes, expiry/version failures, relinks, crash replay, and undo outcomes.

Runtime proposals and explicit reviews are separate evidence. The trusted runtime composition root marks normal runtime opportunities `organic`; direct harness runs are `controlled` only when explicitly labeled, and legacy schema-v1 records read as `unclassified` without rewriting the file. Controlled and unclassified opportunities remain inspectable but never enter the review queue or readiness count.

`muse autonomy review` and the equivalent HTTP read return the oldest unreviewed organic opportunity with its exact recorded scope and current source state. `would-approve` requires the same user-authored link and an open task; stale evidence may receive only `would-deny` or `needs-adjustment`, while unavailable evidence accepts no decision. Reviews are counterfactual and execute nothing. Only unique, valid explicit organic reviews count toward the 20–50 sample window; reaching 20 changes the status to `audit-required`, never to automatic permission.

CLI Ink does not ask for a duplicate counterfactual review after the user has
already answered the exact runtime task-completion prompt. Only literal `y/Y`
and `n/N` produce `explicit-cli-ink` evidence, mapped to `would-approve` and
`would-deny`. Every cancel-like input, timeout, teardown, silent or policy
decision, trust/standing authority, API/channel flow, and missing opportunity
produces no evidence. Before recording, Muse revalidates the same owner,
user-authored local next-step link including `linkedAt`, and present open task.
Stale, relinked, missing, closed, or unreadable sources remain in the manual
review queue. Runtime and manual evidence are mutually exclusive and count at
most once; neither form changes permission.

Promotion requires zero false `wouldAllowStanding` decisions, zero scope expansion, complete durable receipts, successful crash/replay and safe-undo review, and an explicit human decision. Any false allow, corrupt-state tolerance, unexplained receipt gap, CAS clobber, veto miss, or unsafe undo immediately demotes the action to confirmation or disables it. Sample volume, approval rate, silence, confidence, and Attunement outcomes never promote authority automatically.
