---
title: Muse personal-agent productization roadmap
audience: [owner, product, engineering, evaluation]
purpose: Move Muse from an advanced engineering alpha to a qualified, useful, evidence-backed daily personal agent
status: historical-reference
updated: 2026-07-28
related:
  - personal-agent-core-100-roadmap.md
  - personal-agent-acceptance-plan.md
  - daily-use-hardening-plan.md
  - attunement-implementation-plan.md
  - ../../docs/strategy/attunement.md
  - ../../docs/development/personal-agent-qualification.md
  - ../../docs/development/agent-capability-baseline.md
  - ../../docs/development/ai-agent-testing-strategy.md
  - competitor-teardown.md
---

# Muse personal-agent productization roadmap

> **2026-07-28 owner-directed replan:** For new task activation and next-task selection,
> [`personal-agent-core-100-roadmap.md`](personal-agent-core-100-roadmap.md) is the authoritative document.
> This 300-task document is retained only as legacy requirements and ID history, so that already
> completed source is not reimplemented. In particular, the 990-minute worst-case Task 059–060 is
> not executed; it is replaced by Core100's bounded qualification shards 004–010.

## Purpose

This document is a dependency-ordered program map for turning Muse's strong technical foundation
into a personal agent that can genuinely be trusted every day. It is not a list for rebuilding
functionality that is already implemented. Functionality that does exist is still included as
work that re-proves its contract whenever the evidence is stale in the current environment or a
fail-closed gate is shut.

What this ultimately sets out to prove is one sentence.

> Muse connects one user's life and work through exact sources, explicitly learns whether it
> helped, and runs reliably every day without silently expanding its permissions.

## Current starting point — 2026-07-25 one-time snapshot

These numbers are not the roadmap's permanent truth. Task 001 replaces them with current evidence
on every new run.

- Forced full CodeGraph reindex complete: 3,673 files, 43,015 nodes, 118,449 edges.
- TS7 typecheck passed.
- `@muse/agent-core` 3,370 tests and `@muse/attunement` 191 tests passed.
- Web unit 670 tests and real Chromium 128 tests passed.
- API boot passed.
- `pnpm qualify:personal-agent` reports `not-qualified`: 2 failed, 1 unverified.
- The resident background runtime was judged stale/crash-looping, and its heartbeat and live identity were not verified.
- For delivery-safety, the local-only, self-learning hold, and provider lock evidence is not
  closed, and 26 overdue follow-ups plus 5 reminders were reported.
- The 10 functional items in the CLI smoke passed, but the process did not exit on its own.
- The browser smoke failed on the title-transition contract after accepting a JavaScript confirm.
- The most recently recorded capability aggregate is 10/11, with corrected-fact freshness as the failing axis.
- Organic personal effectiveness is explicitly `NOT_PROVEN`.

The current read-only qualification result takes precedence over any conflicting past snapshot.
For example, even if the 2026-07-22 resident status in `daily-use-hardening-plan.md` is green, the
program starts from red when the 2026-07-25 qualification is red.

## Operating rules

### Priorities

- **P0:** Safety, correctness, and operational blockers that prevent entry into the next stage.
- **P1:** Essential functionality that creates day-to-day usable value and recoverability.
- **P2:** Functionality that proves differentiation and bounded autonomy.
- **P3:** Ecosystem, expansion, and public-distribution optimization.

This priority is **phase-local** by default. It does not mean a later phase's P0 runs before a P1
already in the current ready queue. Tasks 001–012 build a `Global P0` ready queue of at most five
items from current evidence, consumed in order of present harm, release blocker, and
dependency-readiness.

### Progression rules

1. Task numbers are stable IDs for long-term reference. Do not run them unconditionally in numeric
   order; select the next task using the authoritative execution order below and the current gate state.
2. Keep exactly one narrow slice in BUILD state at a time. Organic collection, soak runs, and
   cohorts that need elapsed time may run in parallel in one separate EVIDENCE/MONITOR lane, and
   must not modify source at the same time.
3. Each task closes only when both its stated deliverable and its verification evidence exist.
4. Separate maker and evaluator into distinct agent contexts and roles. Merely changing the model
   name, or performing both roles back-to-back in the same context, is not independent evaluation.
   Without a separate evaluator, the result is not completion but
   `unseparated self-evaluation`.
5. Never promote deterministic, controlled-live, and organic-production evidence into one another.
6. A factual interaction receipt is not feedback, permission, or policy promotion.
7. Keep external sends, data deletion, permission expansion, and automation activation behind an
   owner preview and a separate permission gate.
8. Each phase exit gate blocks only the specific promotions/behaviors listed in its table. A red
   organic or optional gate must not be used as a global waterfall that also blocks unrelated
   security, reliability, and repair work.
9. A slice that changed source/behavior is committed per task and pushed to the normal upstream
   only after affected-scope tests, `pnpm test:changed`, and independent evaluation pass.
10. Record-keeping work that changed only docs/evidence/ledger/status does not commit/push per
    task. Batch it at a natural checkpoint per the batching rules below.
11. This document is a program map. Keep detailed execution records in commit bodies and the
    existing active ledgers; do not grow this document indefinitely like a session log.

### Commit and push rules

Even while executing 300 tasks, this long-term goal does not produce a small commit every time
that only grows the record. The commit boundary is decided by **whether product behavior changed**,
not by task number.

- **Commit+push immediately after task completion:** when product behavior or a verification
  contract changed — runtime/source code, tests, executable scripts, build/package configuration,
  dependencies, schema/migration, user-visible UI/wording, security policy/hooks. Related
  documentation and evidence summaries may be included in the same commit.
- **Batch commit later:** record-only changes that do not change product behavior, such as roadmap
  checkmarks, dated status, read-only measurement results, evidence narrative, ledger records, and
  wording corrections. Do not push per task.
- **Mixed change:** if a source/behavior change and a record change sit in the same slice, treat it
  as a source change. Put only the records that describe that implementation in the same commit;
  do not mix in unrelated accumulated records.
- **Record batch checkpoint:** consolidate the related records at whichever comes first — phase
  exit, the next source-code commit, before a branch/worktree switch, before a rebase/merge, before
  a long-session handoff, or before a release-readiness run.
- **Verification:** create a source commit only after the required tests and evaluator PASS. A
  docs-only batch is checked for links, ledger format, whitespace, and claim freshness.
- **Push:** perform a normal push to the configured `origin` upstream of the current task branch or
  of a verified local `main`. These rules do not permit `--no-verify`, force/force-with-lease,
  an alternate remote/refspec, or tags/releases.
- **Failure:** on hook, auth, protection, or unresolved divergence, retry a safe fetch/rebase at
  most once within the limits of the repository's standing authorization; if it is not resolved,
  stop the push and report.
- **Protecting the user's changes:** never arbitrarily commit, discard, or rewrite dirty changes
  belonging to other work.

### Task activation and duplication-prevention rules

300 checkboxes do not mean "all 300 capabilities are absent." Before opening a task as BUILD,
check the CodeGraph, tests, qualification artifacts, and existing documents at the current HEAD,
and record one of the following statuses.

| Status | Meaning | Action |
| --- | --- | --- |
| `missing` | No implementation owns the acceptance | Design and implement only the minimum slice required |
| `partial` | Only part of the contract is implemented, or a current blocker exists | Preserve the existing implementation and fix only the missing delta |
| `built-unverified` | The implementation exists but there is no fresh evidence | No reimplementation; perform verification and operational recovery only |
| `verified-current` | Acceptance is met at the current HEAD/artifact | Close as a record-only completion with no code change |
| `monitoring` | Needs elapsed time, as with organic collection, soak, or cohort | Observe in the EVIDENCE/MONITOR lane; does not block the BUILD lane |
| `blocked` | Needs an owner decision, credential, hardware, or elapsed time | Record the blocker and its resume condition, and pick other ready work |
| `deferred` | Valuable but outside the current promotion scope | Do not implement |
| `rejected` | Decided against on mission, safety, or evidence grounds | Do not re-litigate; revisit only with new evidence |
| `superseded` | An earlier task fully satisfies the acceptance | No duplicate implementation; link the replacing task and its current proof |

The activation header records at minimum `Task ID`, `Status`, `lane`, `Type (FIX|BUILD|TEST|OPS|EVAL|DOC)`,
`Size (S|M|L)`, `Current implementation symbol/file`, `missing delta`, `Verification`, `Commit boundary`, `maker
model/effort`, `Selection rationale`, `evaluator model/effort`, and `escalation trigger`.

- If the current source already satisfies the acceptance, do not create a new abstraction or a second store just because a checkbox exists.
- If a later task repeats the same acceptance as an earlier one, it must prove its unique
  domain/recurrence delta in one sentence. Without a new delta, close the later task as `superseded`.
- If a task is L-size, split it into internal commit-sized slices rather than adding numbers. Each
  slice has independent acceptance and an evaluator, and they combine at the final task gate.
- Do not guess at a problem that is not in the code and implement it. A `built-unverified` or
  `partial` judgement must point at both the current source and the failing evidence.

### Common Definition of Done

Every task must satisfy the following conditions even when not stated separately.

- Acceptance criteria are written down before implementation.
- The affected boundaries among normal, failure, cancellation, retry, and stale states are verified.
- If a persistent format is touched, compatibility, corrupt input, and backup/restore are verified.
- If the UI is touched, the required journey is verified in real Chromium.
- If external effects are touched, draft-first, idempotency, dedupe, and explicit authority are verified.
- Documentation and user-facing contracts match actual behavior.
- The evaluator leaves a `PASS | FAIL` per acceptance criterion together with reproduction evidence.

## Execution waves

| Wave | Tasks | Goal | Entry condition for the next stage |
| --- | ---: | --- | --- |
| A — Truthful core | 001–060 | Honestly qualify the current runtime, delivery, surfaces, and memory | runtime, delivery, surface, and recall gates all green |
| B — Trusted daily loop | 061–096 | Close Continuity, security, and resource boundaries to a daily-usable level | organic audit preconditions and the 24h operational soak pass |
| C — Attuned experience | 097–120 | Verify onboarding and Observe/timing starting from manual and shadow modes | owner-reviewed controlled cohort passes |
| D — Competitive product | 121–144 | Selective competitive expansion, distribution cleanup, release judgement | independent release-readiness PASS |
| E — Durable personal OS | 145–216 | Release operations, long-term memory, life domains, computer control, communication, planning | multi-date audit of real personal workflows |
| F — Governed adaptation | 217–252 | Connect skill learning, multi-agent, and model routing to controlled quality gains | held-out improvement over baseline |
| G — Ubiquitous and compounding | 253–300 | Device expansion, continuous evaluation, ecosystem, recurring value operations | fresh G0–G24 review and approval of the next cycle |

## Authoritative execution order

The order below takes precedence over task numbers. Task IDs are references that are never
renumbered; at activation, current status and missing delta determine the actual amount of work.

### Execution lanes

| Lane | WIP | Purpose | Selection rule |
| --- | ---: | --- | --- |
| INCIDENT | 1 when needed | Work that stops present harm, such as data corruption, an unapproved effect, or a runaway resident | Suspend other lanes and start from exact containment |
| BUILD | 1 | A ready slice that changes source/behavior | In order of current Global P0, dependency-ready, measurable acceptance |
| EVIDENCE/MONITOR | 1 | Organic collection, 24h soak, 30-day dogfood, controlled cohort | Runs beside BUILD without modifying source |
| MAINTENANCE | 1 reserved | Weekly/monthly/quarterly review, dependency/security upkeep | Run on an owner cadence that does not disturb BUILD |
| HORIZON | 0 | Optional channels, voice, multi-agent, plugin expansion | Promote to another lane only when a promotion gate and an owner need appear |

### Actual recommended order

| Stage | BUILD lane | Parallel EVIDENCE/MONITOR | Exit / next selection |
| --- | --- | --- | --- |
| 0. Reconcile | Run 001–012 and classify the status of each task | None | Fix the current Global P0 and a 5-item ready queue |
| 1. Truthful core | Fix only the `missing|partial` deltas among 013–060 | 024, 048, 060 pass^k evidence | G1–G4 fresh green |
| 2. Safety/resource | Run 073–096; do not wait for G5 | 084 review, 096 24h soak | G6–G7 green |
| 3. Daily product | 061–067, 097–108, positioning 121 | 068–072 organic collection | G8 green; G5 is an independent promotion gate |
| 4. Release minimum | 133–140 and current release blockers | 141–143 dogfood/readiness | Engineering alpha only if G5 is red; 144 personal-agent release if green |
| 5. Controlled proactivity | Owner-approved shadow/cohort work among 109–120 | Timing labels and negative outcomes | Promote only within the scope G9 allowed |
| 6. Selective competition | Only items among 122–132 with an owner need and a baseline gain | Competitor delta review | G10 is an optional gate that does not block release |
| 7. Durable personal OS | Select from 145–216 in order of incident and organic need | G12–G17 audits | Allow only that domain's promotion |
| 8. Governed adaptation | 217–252; in order learning→multi-agent→provider | Held-out paired evidence | G18–G20 green per scope |
| 9. Device/eval/ecosystem | Only accepted platform/plugin scope among 253–288 | Journey/quarterly qualification | G21–G23 green per scope |
| 10. Recurring cycle | Run 289–300 from failure evidence | Monthly/quarterly monitoring | Decide successor or termination at G24 |

### Codex model policy for executing this roadmap

This section is not Task 242, which decides **which provider/model a user's work is sent to inside
the Muse product**. It sets the model and reasoning effort of the Codex agent that carries out this
300-task development program. The basis is the official
[Codex Models](https://learn.chatgpt.com/docs/models) guidance as of 2026-07-25. The official roles
are Sol = complex, open-ended, high-value work; Terra = everyday general-purpose work; Luna =
repetitive work whose correct-answer shape is clear. Start effort at the lowest level that produces
the needed result, but because a Muse source change has a higher failure cost than ordinary chat,
follow the defaults below. The short names in this section mean the exact model IDs
`gpt-5.6-sol`, `gpt-5.6-terra`, and `gpt-5.6-luna` respectively.

#### One-line conclusion

- **For a controller entrusted with the whole 300-task goal in one session, use `gpt-5.6-sol / high`.**
- **For a worker on an already-activated, safe S/M-size implementation slice, `gpt-5.6-terra / high` is enough.**
- **Luna is not on the required path.** Use it only for clear, repeatable read-only/record work; if
  it is unavailable, substitute `gpt-5.6-terra / medium`.
- If you cannot pick a model, or the table's conditions conflict, choose the stronger option, `Sol / high`.

Therefore, "hand this entire document to Terra high and keep it running" is not a recommended
operating mode. Terra high can be the worker, but next-task selection, scope cutting, high-risk
judgement, and gate evaluation must be owned by a Sol high controller. To reduce cost, have Sol do
not all the coding of every task but only activation and independent evaluation, and hand the BUILD
slices that passed the conditions to Terra high.

#### Model and effort decision table

| Model / effort | Conditions for use | Representative work | Prohibitions / escalation conditions |
| --- | --- | --- | --- |
| `Luna / low` or `Luna / medium` | Low-risk repetitive work with fixed input/output schema and fixed correctness judgement | Status table conversion, ledger format checks, extracting predetermined fields, tidying link lists | Do not use for source/behavior changes, task selection, cause inference, writing acceptance, or gate judgement. Escalate to Terra if even slight judgement is needed |
| `Terra / medium` | Read-heavy current-state collection with a predetermined conclusion format | CodeGraph/file inventory, test log classification, evidence normalization, running already-decided verification commands | Escalate to Terra high or Sol high once new design or blocker prioritization judgement arises |
| `Terra / high` | An S-size or M-size implementation with a completed activation header, clear missing delta / acceptance / verification commands, and none of the high-risk boundaries below | Narrow FIX/BUILD/TEST, reinforcing an existing module, deterministic regression tests, bounded UI journey fixes | Escalate to Sol high on L-size, contract ambiguity, cross-package policy/effect change, an unexpected second subsystem failure, or one `no-progress` |
| `Sol / high` | Program control, open-ended planning, L-size decomposition, architecture, high-risk source, independent evaluation, release judgement | Tasks 001–012, Global P0 selection, security/permission/effect design, migration, concurrency, root-cause, gate evaluator | Consider Sol xhigh for the hardest security/release proof, or after one `no-progress` even at Sol high |
| `Sol / xhigh` | Bounded evaluations where the failure cost is very high and several boundaries must be proven at once | Deep security review, credential/exfiltration threat scan, final release provenance/rollback gate, recurring cross-system corruption | Do not use as the everyday worker default. Do not raise to Max/Ultra without a scope and a termination condition |

Read the app's **Light / Medium / High / Extra High** labels as corresponding to the CLI's
`low / medium / high / xhigh`. `max` is chosen explicitly by the owner only for top-difficulty
problems that are hard for a single agent to solve. `ultra` may include subagent execution, so it is
not an automatic default in this roadmap; use it only when the owner explicitly requests parallel
agent work and there are independent units with no write conflicts.

#### high-risk boundary

If any one of the following is touched, start at `Sol / high` rather than Terra, even at size S.

- External sends, deletion, money/purchases, account changes, effects that commit on the user's behalf
- approval, permission, guard, hook, policy, credential, secret, provider egress
- PostgreSQL/file persistent schema, migration, backup/restore, encryption, data retention
- Rust runner, sandbox, process ownership, daemon lifecycle, scheduler lock, concurrency/idempotency
- browser upload/download, computer control, clipboard/screen/audio capture
- self-learning activation, skill/plugin installation, self-modification of prompt/policy
- multi-agent authority, handoff, shared state, provider/model fallback
- release qualification, artifact provenance, signing, tag, rollback, publication

The mere fact that the implementer of a high-risk task was Sol does not make the evaluation
independent. Even with the same model, a **new agent context** must read only the handoff and the
current diff and verify from there. The default evaluator for source/behavior, phase gate, and
release work is `Sol / high`; for security and final release gates it is `Sol / xhigh`. For
docs/evidence-only low-risk work, a separate `Terra / medium|high` evaluator is enough.

#### Default route per stage

| Stage | controller/plan | Default worker | Independent evaluator |
| --- | --- | --- | --- |
| 0. Reconcile, 001–012 | `Sol / high` | `Terra / medium` for read-only collection only | Task 012 is `Sol / high` in a new context |
| 1. Truthful core, 013–060 | `Sol / high` fixes the ready slice | `Terra / high` for safe S/M; `Sol / high` for lifecycle and root-cause | Tasks are `Sol / high`; G1–G4 are also `Sol / high` |
| 2. Safety/resource, 073–096 | `Sol / high` | `Terra / high` for deterministic probes/tests; `Sol / high` for policy, runner, concurrency | Security G6 is `Sol / xhigh`, resource G7 is `Sol / high` |
| 3. Daily product, 061–072·097–108·121 | `Sol / high` separates G5 from BUILD | `Terra / high` for bounded adapter/UI; `Luna / medium` or `Terra / medium` for organic records | G5 and G8 are `Sol / high` |
| 4. Release minimum, 133–144 | `Sol / high` | `Terra / high` for packaging/test fixes, `Sol / high` for provenance and rollback | Tasks 143–144 are `Sol / xhigh` in a new context |
| 5. Controlled proactivity, 109–120 | `Sol / high` | `Terra / high` only for approved bounded shadow implementation | G9 is `Sol / high` |
| 6. Selective competition, 122–132 | `Sol / high` fixes the adoption criteria | `Terra / high` for bounded experiments, `Luna / medium` for material normalization | The G10 adoption judgement is `Sol / high` |
| 7. Durable personal OS, 145–216 | `Sol / high` cuts slices per domain | `Terra / high` for ordinary S/M; `Sol / high` for high-risk boundaries | G11–G17 are `Sol / high`, `xhigh` when security is involved |
| 8. Governed adaptation, 217–252 | `Sol / high` | `Terra / high` for fixed adapters/tests; `Sol / high` for learning, authority, fallback | G18–G20 are `Sol / high`, activation/security is `xhigh` |
| 9. Device/eval/ecosystem, 253–288 | `Sol / high` | `Terra / high` for bounded platform adapters; `Sol / high` for permission/plugin | G21–G23 are `Sol / high`, plugin security is `xhigh` |
| 10. Recurring cycle, 289–300 | `Sol / high` decides the next cycle from failure evidence | `Luna / medium` or `Terra / medium` for formulaic reports; apply the risk table for repairs | Tasks 299–300 are `Sol / high` in a new context |

#### Mechanical execution order for a new session

A new agent does not change the order below.

1. Read `AGENTS.md`, `harness/AGENTS.md`, and this document's operating rules, authoritative order, and model policy.
2. Check the current HEAD, dirty worktree, and the HEAD/time/input provenance of the current gate artifacts.
3. If there is no fresh, completed G0 activation artifact, start from Stage 0's 001–012 with `Sol / high`.
4. If G0 is fresh, pick exactly one dependency-ready first slice from the current stage's Global P0 ready queue.
5. Judge status and missing delta from the CodeGraph and failing/fresh evidence. Do not open BUILD
   for `verified-current` or `superseded`.
6. Fill in every field of the activation header, then set maker and evaluator using the decision
   table above. Judge condition conflicts or unknown risk as `Sol / high`.
7. The maker performs exactly one BUILD slice and leaves the required checks and a handoff.
   EVIDENCE/MONITOR does not modify source.
8. An evaluator in a separate context reproduces the `PASS | FAIL` per acceptance criterion.
   A self-check in the same context is `unseparated self-evaluation` and cannot open a gate.
9. On `FAIL`, return the blockers as one bundle. On one `no-progress` or a high-risk discovery,
   escalate per the rules above; if the retry budget is exceeded, record `blocked` and the resume condition.
10. On `PASS`, commit+push only source/behavior changes per task. Defer record-only changes to a
    batch checkpoint, bring WIP back to 0, and then pick the next slice from the authoritative order.

Activation records use the following form.

```md
Task ID:
Status:
lane / type / size:
Current implementation symbol/file:
missing delta:
acceptance / verification:
Commit boundary:
maker model / effort:
Selection rationale:
evaluator model / effort:
escalation trigger:
```

#### availability and fallback

- If the exact model or effort is not visible on the current Codex surface, do not silently use a
  different model; record `unavailable` and the substitution reason in the activation header.
- Luna not being exposed is not a blocker. Substitute `Terra / medium` for `Luna / low|medium` work.
- If Terra is not exposed, substitute `Sol / medium|high` even for ordinary work.
- If Sol is not exposed, low-risk S/M implementation can continue with Terra high, but program
  replanning, high-risk boundaries, and phase/release gates are left as
  `blocked: Sol-class independent review unavailable`.
- Model availability and official recommendations may change, so re-record the exact model IDs and
  effort options in Task 001's environment snapshot. The document's role contract must not be
  silently weakened.

### Release label boundary

- **Engineering alpha:** G0–G4 and G6–G8 are green and organic effectiveness is explicitly stated as `NOT_PROVEN`.
- **Evidence-backed personal-agent release:** on top of the above conditions, the G5 organic audit,
  the 121 positioning contract, and the 133–143 release evidence must additionally be green before
  Task 144 is executed.
- G9 proactive timing, G10 competitor expansion, voice/mobile, multi-agent, and plugins are not
  required prerequisites for the first personal-agent release.

### 2026-07-25 current-source activation hints

This table is a dated hint for not reimplementing the current source. It is not a permanent status;
Task 001 re-judges it against the current HEAD and fresh runtime evidence.

| Task | Implementation currently visible | Starting status hint | What actually needs doing |
| --- | --- | --- | --- |
| 003 | [`personal-agent-qualification.ts`](../../apps/cli/src/personal-agent-qualification.ts) has the source/artifact/runtime/delivery schema and a fail-closed aggregate | `built-unverified` | Do not build a new report system; only check the missing provenance delta |
| 013–017 | [`resident-daemon-status.ts`](../../packages/runtime-state/src/resident-daemon-status.ts) has the stable command and PID/heartbeat/orphan state | `built-unverified|partial` | Narrow down the live crash-loop cause and the current mismatch, and reinforce the existing module |
| 025–035 | [`personal-agent-qualification-probes.ts`](../../apps/cli/src/personal-agent-qualification-probes.ts) has local-only, lock, brake, hold, and backlog observation | `built-unverified|partial` | Do not build a second safety layer; recover the persisted/live red state |
| 037–048 | The browser confirm failure and the CLI post-PASS hang reproduce in the current smoke | `partial` | Fix only the minimal failing path and owned-process cleanup |
| 049–060 | The recall substrate exists, e.g. [`episodic-recall.ts`](../../packages/agent-core/src/episodic-recall.ts), but the corrected-fact axis is red | `partial` | Fix only the candidate retention/freshness missing delta |
| 061–066 | The Pack/store/reducer substrate exists, e.g. [`continuity-preparation.ts`](../../packages/attunement/src/continuity-preparation.ts) | `built-unverified|partial` | Check the normal-chat seam and store parity first, and implement only the adapter that is absent |
| 073–084 | The [`policy`](../../packages/policy), [`secrets`](../../packages/secrets), and [`runner`](../../crates/runner) foundations exist | `built-unverified|partial` | Implement only the enforced gap per current threat case |

### Unique delta of tasks that look repetitive

The later tasks below do not reimplement the earlier tasks. If the later-only delta already exists
in the current source, close the later task as `superseded`.

| IDs | earlier contract | later-only delta |
| --- | --- | --- |
| 033 → 200 | A generic draft/approval primitive for all outbound | A one-shot final confirmation that bundles the communication payload, recipient, and account |
| 034 → 202 | Generic retry/dedupe based on effect ID | Reconciliation of the channel provider's accepted/delivered/unknown receipts |
| 128 → 221 | The held-out activation gate of the first skill candidate | An immutable regression registry shared by multiple skills/versions plus baseline comparison |
| 131 → 229 → 240 | The prior go/no-go on whether to open multi-agent at all | Baseline artifact of the accepted family → final paired benchmark/adopt decision |
| 132 → 292 | The first competitor baseline and fit lens | Subsequent quarterly delta-only reassessment; no repeated baseline teardown |
| 142 → 289 | The first 30-day personal-value release judgement | Post-release recurring north-star trend and prune/experiment decisions |
| 143 → 299 | The first HEAD-bound release-readiness | A recurring gate that rebundles current G0–G23 freshness each following cycle |
| 211 → 232 | The Continuity handoff that carries a user project into the next session | A typed, least-authority handoff between supervisor and subagent |

---

## Phase 0 — Program baseline and evidence contract

**Entry condition:** None.

**Exit gate G0:** The current status, evidence classes, task ownership, verification commands, and
WIP rules are reproducible in a single read-only preflight.

- [ ] **001. Re-fix the current qualification baseline.** — `P0`
  - **Why:** Mixing the document's past green snapshots with the current red run produces the wrong task order.
  - **Deliverable:** A fresh report carrying the current HEAD, artifact digest, run time, environment, and the qualification results on all three axes.
  - **Verification:** Run `pnpm qualify:personal-agent` read-only and confirm source/artifact provenance.
  - **Prerequisites:** None.

- [ ] **002. Codify the precedence of conflicting status documents.** — `P0`
  - **Why:** Contradictions such as 2026-07-22 resident green versus 2026-07-25 crash-looping must not be left for a human to interpret.
  - **Deliverable:** The precedence "current command result > provenance-valid report > dated narrative" and the stale-marking rules.
  - **Verification:** With two fixtures from different dates, confirm that the newer but provenance-invalid report is not selected.
  - **Prerequisites:** 001.

- [ ] **003. Strengthen the provenance contract of the qualification report.** — `P0`
  - **Why:** Evidence from a different checkout, an old build, or a previous daemon must not be reused as a current pass.
  - **Deliverable:** HEAD, dirty state, input hash, build digest, runtime identity, and generated-at/expiry fields.
  - **Verification:** Four cases that each change only one of HEAD, artifact, time, or runtime identity all close as stale/unverified.
  - **Prerequisites:** 001–002.

- [ ] **004. Define the program scorecard around outcomes.** — `P0`
  - **Why:** Test counts and tool-call counts must not be mistaken for personal usefulness.
  - **Deliverable:** A gate table for runtime, delivery safety, recall, Continuity, privacy, resource, onboarding, and organic value.
  - **Verification:** A synthetic-only fixture cannot turn organic effectiveness or autonomy promotion green.
  - **Prerequisites:** 002–003.

- [ ] **005. Fix evidence classes and promotion rules as a single type.** — `P0`
  - **Why:** Distinguishing `deterministic`, `controlled-live`, and `organic-production` by wording alone produces drift.
  - **Deliverable:** Immutable `dataOrigin`, independent `executionEvidence`, freshness, and denominator contracts.
  - **Verification:** A record without origin or execution evidence is excluded from the qualification aggregate.
  - **Prerequisites:** 004.

- [ ] **006. Re-confirm receipt, outcome, permission, and policy change as separate ledgers.** — `P0`
  - **Why:** The most dangerous error is task completion being promoted into "Muse helped" or into consent for future automation.
  - **Deliverable:** Explicit linking rules for the four states and a table of forbidden automatic conversions.
  - **Verification:** A fixture that has only task completion generates no feedback, permission, or promotion at all.
  - **Prerequisites:** 005.

- [ ] **007. Fix the acceptance slice template for each phase.** — `P0`
  - **Why:** 144 tasks must not be left with nothing but the claim "it was implemented."
  - **Deliverable:** WHAT, WHY, PASS criteria, out-of-scope, verification commands, evidence accounting, and rollback fields.
  - **Verification:** A handoff with an empty required field does not pass the PLAN gate.
  - **Prerequisites:** 004–006.

- [ ] **008. Assign maker/evaluator roles and authority per phase.** — `P0`
  - **Why:** Same-session self-evaluation easily misses silent data and permission errors.
  - **Deliverable:** A table of worker/evaluator and read/write authority for runtime, store, security, UI, and release.
  - **Verification:** The evaluator can judge from artifacts and acceptance criteria alone, without the build conversation.
  - **Prerequisites:** 007.

- [ ] **009. Specify verification depth by risk grade.** — `P0`
  - **Why:** Both extremes must be avoided — running the full suite for every change, and closing a high-risk change with unit tests alone.
  - **Deliverable:** A test matrix for pure code, UI, persistent store, permission/send, and release.
  - **Verification:** Feeding in five representative changes determines the required deterministic/browser/corruption/live/evaluator gates.
  - **Prerequisites:** 007–008.

- [ ] **010. Fix the dependency graph and the BUILD/EVIDENCE lane WIP.** — `P0`
  - **Why:** Both must be prevented: eye-catching expansion progressing ahead of a blocker, and a long evidence wait halting all development.
  - **Deliverable:** A DAG per G0–G24 scope, BUILD WIP=1, EVIDENCE/MONITOR WIP=1, and incident preemption.
  - **Verification:** Optional expansion is not selected while runtime is red, and a ready security fix remains executable even during organic monitoring.
  - **Prerequisites:** 004, 009.

- [ ] **011. Build a canonical verification-command catalog.** — `P0`
  - **Why:** If different people use different commands and options, pass results cannot be compared.
  - **Deliverable:** A table of commands, budgets, and side effects for typecheck, affected tests, real-browser, smoke, qualification, and pre-push.
  - **Verification:** Each command's timeout, expected artifacts, skip conditions, and failure-retention path are documented.
  - **Prerequisites:** 009–010.

- [ ] **012. Pass the G0 baseline review independently.** — `P0`
  - **Why:** Executing on top of a wrong baseline invalidates every subsequent green.
  - **Deliverable:** G0 `PASS | FAIL`, a blocker bundle, and a Global P0 ready queue of at most five items with status, lane, type, size, and missing delta.
  - **Verification:** The evaluator reproduces 001–011 in a new checkout and confirms that already-implemented acceptance was not redundantly selected into the BUILD queue.
  - **Prerequisites:** 001–011.

---

## Phase 1 — Make the resident runtime a single truth

**Entry condition:** G0 green.

**Exit gate G1:** Exactly one resident writer runs from a stable entrypoint on the real owner macOS
profile, and artifact, PID, heartbeat, and process identity agree across a pass^3 of different
writer generations. When a natural OS/session restart occurs, the same observation is added as
operational evidence, but a forced reboot or a separate macOS user account is not a prerequisite for
G1 or for the owner-scoped personal-agent release.

- [ ] **013. Read-only inventory the macOS resident artifacts and every Muse process.** — `P0`
  - **Why:** Old checkouts and temporary test runners can linger and look like the real daemon.
  - **Deliverable:** A bounded report of plist, launchd registration, PID/PPID, cwd, executable realpath, start time, and heartbeat.
  - **Verification:** It distinguishes the five fixtures artifact-only, process-only, duplicate, orphan, and healthy.
  - **Prerequisites:** 012.

- [ ] **014. Fix the stable CLI entrypoint judgement as fail-close.** — `P0`
  - **Why:** Installing the resident from a tmp, test-runner, or deleted-worktree entrypoint breaks on the next restart.
  - **Deliverable:** Canonical realpath plus a check of the allowed package/release origin.
  - **Verification:** `/tmp`, test output, a missing path, and a moved worktree are rejected before installation.
  - **Prerequisites:** 013.

- [ ] **015. Consolidate stale, orphan, and duplicate process classification into one health module.** — `P0`
  - **Why:** Recovery is dangerous when `daemon --status`, doctor, and qualification each tell a different truth.
  - **Deliverable:** A shared resident health result and a reason-code enum.
  - **Verification:** The three surfaces return byte-equivalent status and reason for the same fixture.
  - **Prerequisites:** 013–014.

- [ ] **016. Prevent two resident writers from being active at the same time.** — `P0`
  - **Why:** Split-brain writes can occur in the task, reminder, outcome, and delivery stores.
  - **Deliverable:** A single-writer lease that includes process identity, plus dead-owner fencing.
  - **Verification:** Of two simultaneous starts only one becomes the writer, and the loser exits with no external effect.
  - **Prerequisites:** 015.

- [ ] **017. Complete the heartbeat freshness and monotonicity contract.** — `P0`
  - **Why:** A live PID alone cannot prove the event loop and scheduled work are alive.
  - **Deliverable:** Owner-only heartbeat receipt, generation, last-progress, and expected cadence.
  - **Verification:** A frozen clock, stale generation, PID reuse, and a partial write are not judged healthy.
  - **Prerequisites:** 015–016.

- [ ] **018. Leave the crash-loop cause as a reason-coded terminal state.** — `P0`
  - **Why:** The current qualification's `crash-looping` alone does not provide a fixable cause.
  - **Deliverable:** Bounded recent failures, exit class, last stable point, and a redacted diagnostic link.
  - **Verification:** It distinguishes config, store corruption, provider auth, port collision, and uncaught exception.
  - **Prerequisites:** 017.

- [ ] **019. Apply bounded backoff and a circuit breaker to resident restart.** — `P0`
  - **Why:** A persistent failure must not escalate into runaway CPU, logs, and external effects.
  - **Deliverable:** Restart budget, exponential backoff, open/half-open states, and an owner-visible reset.
  - **Verification:** Repeated failures stop after the limit and recover from half-open only after a successful probe.
  - **Prerequisites:** 018.

- [ ] **020. Separate the repair plan from its execution.** — `P0`
  - **Why:** Killing a process, replacing a plist, and re-registering must not run without an exact owner preview.
  - **Deliverable:** A read-only repair plan, exact targets, reversible steps, and an explicit apply command.
  - **Verification:** The preview changes nothing, and if a stale target changes before apply the whole operation is rejected.
  - **Prerequisites:** 013–019.

- [ ] **021. Make resident install and upgrade idempotent.** — `P0`
  - **Why:** Reinstalling the same version or interrupting an upgrade must not create duplicate plists and processes.
  - **Deliverable:** A versioned install receipt, atomic replace, and backup of the previous artifact.
  - **Verification:** Install rerun, mid-way crash, downgrade rejection, and rollback fixtures all behave deterministically.
  - **Prerequisites:** 014, 020.

- [ ] **022. Define the data-preservation boundary of uninstall and disable.** — `P0`
  - **Why:** Removing the resident and deleting personal data must be entirely different authorities.
  - **Deliverable:** Service-only removal, preserve-data as the default, and a separate destructive data command.
  - **Verification:** In the uninstall fixture the notes/tasks/memory/Attunement bytes do not change.
  - **Prerequisites:** 020–021.

- [ ] **023. Perform a contained activation on the real owner macOS profile.** — `P0`
  - **Why:** A resident that succeeds only in fixtures or a development foreground process and fails in
    the real owner LaunchAgent domain is not the baseline for daily runtime.
  - **Deliverable:** Install and startup evidence in a state with a stable entrypoint, local-only, log
    provider, delivery brake, and self-learning hold, plus a preservation digest of the personal stores.
  - **Verification:** Run install→start→heartbeat→status→stop→start on the current owner profile and
    confirm zero external sends, exactly one writer, and unchanged store bytes. A separate macOS user or VM profile is not required.
  - **Prerequisites:** 013–022.

- [ ] **024. Qualify resident health with a pass^3 across different writer generations.** — `P0`
  - **Why:** A single green does not prove the launchd timing and PID-reuse boundaries.
  - **Deliverable:** A fresh G1 report containing three independent writer generations.
  - **Verification:** On every run the artifact, PID, executable, generation, heartbeat, and single writer all agree.
    An OS/session restart is non-blocking operational evidence collected additionally when it occurs naturally.
  - **Prerequisites:** 023.

---

## Phase 2 — Close delivery safety and the stale backlog

**Entry condition:** G1 green.

**Exit gate G2:** local-only, provider lock, delivery brake, and self-learning hold agree between
persisted state and the live process, and stale reminders/follow-ups are not sent, deleted, or
rescheduled without an owner action.

- [ ] **025. Make `local-only` a persisted policy that survives a resident restart.** — `P0`
  - **Why:** Containment that lives only in a shell environment variable can disappear after a reboot.
  - **Deliverable:** An owner-only persisted setting, the resolved live value, and provenance.
  - **Verification:** It persists after restart, and an invalid value becomes fail-close rather than network-open.
  - **Prerequisites:** 024.

- [ ] **026. Apply the delivery provider lock to the persisted configuration and the live adapter at once.** — `P0`
  - **Why:** The drift where the setting is `log` but the runtime grabs a different provider such as Telegram must be prevented.
  - **Deliverable:** The allowed provider set, resolved adapter identity, and mismatch reason.
  - **Verification:** Injecting a different provider is blocked before dispatch and reported exactly in the qualification.
  - **Prerequisites:** 025.

- [ ] **027. Make the delivery brake the shared fail-close gate for every outbound path.** — `P0`
  - **Why:** If even one of the reminder, follow-up, proactive, or channel-specific paths bypasses it, containment breaks.
  - **Deliverable:** One brake decision API and a channel-independent audit receipt.
  - **Verification:** Every known outbound caller records zero send calls in the brake-on fixture.
  - **Prerequisites:** 026.

- [ ] **028. Enforce the self-learning hold for the duration of qualification.** — `P0`
  - **Why:** If skill/memory policy changes at the same time as runtime recovery, cause and effect cannot be separated.
  - **Deliverable:** A persisted hold, status display, and separate controls for proposal generation and apply.
  - **Verification:** In the hold state active skill/policy writes are 0, and only the explicit memory-fact path behaves per its existing contract.
  - **Prerequisites:** 025–027.

- [ ] **029. Re-count the overdue reminder backlog without changing it.** — `P0`
  - **Why:** It must be confirmed whether the 5 currently reported match the real store or are a stale figure.
  - **Deliverable:** A read-only inventory of exact ID, age band, state, and source digest.
  - **Verification:** The reminder store bytes are identical before and after the inventory.
  - **Prerequisites:** 027.

- [ ] **030. Re-count the overdue follow-up backlog without changing it.** — `P0`
  - **Why:** The 26 currently reported must be classified first so that they do not become candidates for automatic sending.
  - **Deliverable:** A bounded inventory of exact ID, intended effect, age, recipient presence, and eligibility reason.
  - **Verification:** The read path does not invoke send, reschedule, dismiss, or recipient resolution.
  - **Prerequisites:** 027.

- [ ] **031. Build backlog triage preview per item and per bounded batch.** — `P0`
  - **Why:** The owner must not bulk-process past items without knowing what changes.
  - **Deliverable:** An exact before/after preview of retain, dismiss, explicit snooze, and draft digest.
  - **Verification:** A batch containing a single invalid item produces no mutation at all.
  - **Prerequisites:** 029–030.

- [ ] **032. Apply immutable receipts and idempotency to triage mutations.** — `P0`
  - **Why:** A retry must not move the same reminder twice or dismiss it twice.
  - **Deliverable:** Operation ID, source version, chosen action, and a result-digest receipt.
  - **Verification:** Replaying the same operation returns a byte-stable result and an identical receipt.
  - **Prerequisites:** 031.

- [ ] **033. Standardize every third-party send as draft-first.** — `P0`
  - **Why:** When approval wording differs per feature, bypasses for automatic sending appear.
  - **Deliverable:** A draft carrying recipient, channel, payload hash, and expiry, plus an explicit approve step.
  - **Verification:** Creating a draft alone does not call provider send, and approving a stale draft is rejected.
  - **Prerequisites:** 027, 032.

- [ ] **034. Fix outbound retry and dedupe on an effect basis.** — `P0`
  - **Why:** When success is unknown after a timeout, a duplicate message can be sent.
  - **Deliverable:** Effect ID, provider receipt, ambiguous terminal state, and a manual reconciliation path.
  - **Verification:** At most one effect occurs across the success-before-ack, timeout, provider duplicate, and restart replay fixtures.
  - **Prerequisites:** 033.

- [ ] **035. Make doctor and qualification consume the same delivery-safety result.** — `P0`
  - **Why:** A state discrepancy where the UI says safe and qualification says unsafe must not be left for a human to interpret.
  - **Deliverable:** A shared projection of local-only, lock, brake, hold, backlog, and pending drafts.
  - **Verification:** For the same fixture, the reason codes from CLI/API/status/qualification agree.
  - **Prerequisites:** 025–034.

- [ ] **036. Close G2 with a zero-unapproved-send fault campaign.** — `P0`
  - **Why:** External-effect safety cannot be claimed from happy-path tests alone.
  - **Deliverable:** A fault report covering restart, stale config, backlog, retry, partial receipt, and provider failure.
  - **Verification:** In every case unapproved sends are 0, silent deletes are 0, silent reschedules are 0, and the evaluator PASSes.
  - **Prerequisites:** 025–035.

---

## Phase 3 — Terminal reliability of the Browser, CLI, API, and Web surfaces

**Entry condition:** G2 green.

**Exit gate G3:** The currently confirmed browser confirm regression and CLI exit hang are closed,
the same personal task produces an identical terminal state on CLI/API/Web, and the core smoke
terminates with pass^3.

- [ ] **037. Minimally reproduce the browser JavaScript confirm failure.** — `P0`
  - **Why:** Fixing the whole smoke failure straight away risks confusing dialog lifecycle with test timing.
  - **Deliverable:** A minimal fixture that opens and accepts a confirm and then checks the title or DOM terminal state.
  - **Verification:** Before the fix the same assertion is deterministically red and the failure trace is retained.
  - **Prerequisites:** 036.

- [ ] **038. Fix the dialog open→decision→page continuation lifecycle.** — `P0`
  - **Why:** Accept-API success and actual page continuation are separate contracts.
  - **Deliverable:** Pending dialog ownership, exact decision ack, and post-dialog navigation/DOM settle handling.
  - **Verification:** Accept and dismiss each produce the expected page state, and a double decision is rejected.
  - **Prerequisites:** 037.

- [ ] **039. Add adversarial browser tests to the dialog path.** — `P0`
  - **Why:** alert, confirm, prompt, nested frames, and a dialog just before navigation all have different timing.
  - **Deliverable:** The four dialog families plus disconnect/cancel/race cases.
  - **Verification:** A wrong dialog kind, a stale dialog ID, and a timeout are not reported as success.
  - **Prerequisites:** 038.

- [ ] **040. Fix the resource cleanup and timeout contract of the browser smoke.** — `P0`
  - **Why:** If Chromium or a server lingers after a failure, the next verification is polluted.
  - **Deliverable:** A top-level `finally`, an owned-child registry, bounded shutdown, and artifact retention.
  - **Verification:** After all four paths — pass, assertion failure, Ctrl-C, timeout — no owned process or temp profile remains.
  - **Prerequisites:** 037–039.

- [ ] **041. Minimally reproduce the CLI smoke's "no exit after 10 PASS".** — `P0`
  - **Why:** Functional success and process-lifecycle success must be separated to find the cause.
  - **Deliverable:** A diagnostic fixture that prints active handles/requests and child process ancestry.
  - **Verification:** The exact handle or child that remains after the test items complete is identified.
  - **Prerequisites:** 036.

- [ ] **042. Fix CLI child process ownership and teardown.** — `P0`
  - **Why:** If any one of the stream, scheduler, MCP, or API child fails to exit, automation waits forever.
  - **Deliverable:** An explicit owner, abort propagation, graceful timeout, and a forced-owned-child fallback.
  - **Verification:** The normal, failure, and signal paths all exit within the specified time and do not touch unrelated processes.
  - **Prerequisites:** 041.

- [ ] **043. Unify the CLI terminal-state and exit-code contract per command group.** — `P0`
  - **Why:** When the human-readable PASS wording and the exit code automation receives differ, the gate lies.
  - **Deliverable:** An exit-code table for success, user error, policy block, unverified, and internal failure.
  - **Verification:** Representative CLI commands return codes consistent across stdout/stderr/JSON mode.
  - **Prerequisites:** 042.

- [ ] **044. Separate API boot from readiness.** — `P0`
  - **Why:** The port being open does not mean the stores, provider, and resident dependencies are ready.
  - **Deliverable:** Liveness, readiness, degraded reason, and a no-model/no-network health projection.
  - **Verification:** During a dependency failure liveness is retained and only readiness goes red with an exact reason.
  - **Prerequisites:** 043.

- [ ] **045. Remove the overlapping `act()` warnings from the Web real-browser tests.** — `P1`
  - **Why:** Even at exit 0, an async warning can be a precursor to a real race and a flaky journey.
  - **Deliverable:** user-event-based await boundaries and a query-invalidation settle contract.
  - **Verification:** The 128 browser tests pass repeatedly with 0 console warnings.
  - **Prerequisites:** 044.

- [ ] **046. Bundle the core personal-agent journeys in real Chromium.** — `P1`
  - **Why:** Component tests alone cannot prove the setup→chat→source→Continuity→outcome connection.
  - **Deliverable:** The local-only setup, grounded answer, Pack review, explicit outcome, and held delivery journeys.
  - **Verification:** Each journey is graded on both visible terminal state and persisted effect.
  - **Prerequisites:** 039–045.

- [ ] **047. Build a CLI/API/Web parity contract for the same task.** — `P1`
  - **Why:** Independent per-adapter implementations create drift in permission, error, and store semantics.
  - **Deliverable:** A shared operation matrix and a canonical digest/reason projection.
  - **Verification:** For the same fixture, the allowed effects and store digests of the three surfaces agree.
  - **Prerequisites:** 043–046.

- [ ] **048. Qualify the surface smoke with pass^3 from clean processes.** — `P0`
  - **Why:** A single green does not close lifecycle races and leaked children.
  - **Deliverable:** Three consecutive independent reports for Browser, CLI, API, and Web.
  - **Verification:** Each run exits 0 without timeout, and owned-process, port, and temp-profile leakage is 0.
  - **Prerequisites:** 037–047.

---

## Phase 4 — Corrected-fact recall and memory observability

**Entry condition:** G3 green.

**Exit gate G4:** Latest corrected facts 2/2, ordinary positives, and absent-fact abstention are all
retained, and the full 11-axis capability battery achieves pass^3 with fresh provenance.

- [ ] **049. Reproduce the corrected-fact failure with a fixed minimal corpus.** — `P0`
  - **Why:** Repeating the whole live battery makes it hard to separate candidate retention from ranking as the cause.
  - **Deliverable:** A deterministic fixture with an old fact, an explicit correction, an unrelated distractor, and a query.
  - **Verification:** The trace identifies whether the current failure is at the candidate, rank, or policy stage.
  - **Prerequisites:** 048.

- [ ] **050. Preserve the old/current correction pair before adaptive-k/MMR.** — `P0`
  - **Why:** If a candidate is removed before the freshness and contradiction policy can compare, the correction cannot be selected.
  - **Deliverable:** Correction-aware candidate retention and a bounded expansion rule.
  - **Verification:** The 2/2 correction case passes and ordinary top-1 ranking is retained.
  - **Prerequisites:** 049.

- [ ] **051. Make the freshness/supersession policy a versioned deterministic reducer.** — `P0`
  - **Why:** Leaving "prefer the newest" to the model prompt alone gives no reproducibility and no undo.
  - **Deliverable:** A precedence over timestamp, explicit correction link, confidence, and source authority.
  - **Verification:** Clock ties, out-of-order imports, duplicate corrections, and weak-inference cases produce fixed results.
  - **Prerequisites:** 050.

- [ ] **052. Handle contradictions and tombstones explicitly in search results.** — `P0`
  - **Why:** A deleted or retracted fact must not come back to life on embedding similarity alone.
  - **Deliverable:** The active, superseded, disputed, and deleted states plus recall eligibility.
  - **Verification:** A tombstoned fact does not appear in answer evidence, and a disputed fact is marked as uncertain.
  - **Prerequisites:** 051.

- [ ] **053. Strengthen the absent-fact abstention floor.** — `P0`
  - **Why:** Raising correction recall can introduce a regression that invents facts that do not exist.
  - **Deliverable:** Minimum support, contradiction-aware abstention, and a source-citation requirement.
  - **Verification:** Both the existing absent 8/8 and new near-match adversarial cases all abstain.
  - **Prerequisites:** 050–052.

- [ ] **054. Add reason-coded terminal outcomes to automatic memory extraction.** — `P0`
  - **Why:** If fail-open extraction keeps failing silently, the user mistakenly believes Muse is learning.
  - **Deliverable:** `learned`, `nothing_new`, `policy_rejected`, `model_error`, `schema_error`, `store_error`, `timeout`.
  - **Verification:** Each injected failure records the exact terminal reason without blocking the conversation.
  - **Prerequisites:** 053.

- [ ] **055. Give memory learning health a bounded projection in doctor/status.** — `P1`
  - **Why:** Recent successes and consecutive failures must be judgeable without opening a raw trace.
  - **Deliverable:** Last success, consecutive failure, fixed-size reason counts, and freshness.
  - **Verification:** An old success does not appear as currently healthy and the counters do not grow without bound.
  - **Prerequisites:** 054.

- [ ] **056. Re-verify the non-persistence of ephemeral, private, and policy-rejected turns.** — `P0`
  - **Why:** Adding observability can leak forbidden verbatim text into the diagnostic store.
  - **Deliverable:** An explicit schema of allowed metadata and forbidden payload.
  - **Verification:** The prompts, answers, and secret markers of the private fixtures appear nowhere in the memory or diagnostic bytes.
  - **Prerequisites:** 054–055.

- [ ] **057. Let the owner inspect, correct, forget, and undo memory.** — `P1`
  - **Why:** Without a user path for fixing a wrongly learned fact, long-term personalization is dangerous.
  - **Deliverable:** An exact-memory-ID-based preview and a versioned mutation receipt.
  - **Verification:** Correction and forget are idempotent, the undo scope and expiry are clear, and fuzzy targets are rejected.
  - **Prerequisites:** 051–056.

- [ ] **058. Show memory conflicts to the user in an actionable way.** — `P1`
  - **Why:** Which two facts conflict and which one to choose matters more than a "learning score."
  - **Deliverable:** A conflict view with exact sources, the current policy choice, and keep/correct/forget actions.
  - **Verification:** There is no vanity card without an action, and the active policy is not changed automatically before a choice is made.
  - **Prerequisites:** 052, 057.

- [ ] **059. Regenerate the 11-axis capability report from a clean snapshot.** — `P0`
  - **Why:** A focused correction green alone cannot pass the whole agent capability.
  - **Deliverable:** A fresh 11/11 candidate report with exact source/artifact provenance.
  - **Verification:** Every required axis runs, including correction, ordinary positives, abstention, safety, browser, and tool selection.
  - **Prerequisites:** 049–058.

- [ ] **060. Close G4 with a strict pass^3 of the 11/11 capability aggregate.** — `P0`
  - **Why:** One pass is not enough for non-deterministic model and browser paths.
  - **Deliverable:** Three independent runs of the same contract plus the evaluator's judgement.
  - **Verification:** All three runs are 11/11 with 0 skips, 0 unverified, and matching provenance, and the quality floor is not lowered.
  - **Prerequisites:** 059.

---

## Phase 5 — Close Personal Continuity in normal chat and collect organic evidence

**Entry condition:** G4 green.

**Exit gate G5:** The exact-source Continuity loop closes in normal chat under explicit user
authority, and natural return moments in life and work are collected across multiple dates to a level
that can be independently audited. Automatic timing remains held.

- [ ] **061. Expose a minimal Continuity tool seam in main chat.** — `P1`
  - **Why:** The current CLI/Web-only flow is separated from the personal agent's primary conversational experience.
  - **Deliverable:** Auditable tools for thread select/create, exact link, Pack preview/open, and explicit outcome.
  - **Verification:** The tool schema alone distinguishes the allowed effects from the forbidden auto-link/outcome.
  - **Prerequisites:** 060.

- [ ] **062. Keep life/work thread selection and creation an explicit user act.** — `P1`
  - **Why:** Automatically attributing a conversation topic to a life area persists a wrong personal inference.
  - **Deliverable:** Thread binding in which the suggested draft and the explicit confirm are separated.
  - **Verification:** No thread, kind, or link is created in the store without a user choice.
  - **Prerequisites:** 061.

- [ ] **063. Link exact local tasks and notes safely from chat.** — `P1`
  - **Why:** Linking the wrong personal item via fuzzy name search destroys Continuity's grounding value.
  - **Deliverable:** Canonical ID copy/select, bounded projection, and a link preview.
  - **Verification:** An ambiguous prefix, a renamed/deleted item, and a duplicate title are rejected before mutation.
  - **Prerequisites:** 061–062.

- [ ] **064. Separate Pack preview from delivery open.** — `P1`
  - **Why:** If a timing evaluation or an on-screen preview is recorded as a real delivery receipt, the effectiveness data is polluted.
  - **Deliverable:** A mutation-free preview and an explicit open authority.
  - **Verification:** Repeated previews do not change store bytes, and only open creates exactly one delivery.
  - **Prerequisites:** 063.

- [ ] **065. Record outcomes in chat as only four explicit values.** — `P1`
  - **Why:** Silence, task completion, and conversation sentiment must not be interpreted as hidden feedback.
  - **Deliverable:** A `used | adjusted | ignored | rejected` selection plus an optional owner note.
  - **Verification:** A timeout, a task receipt, and an assistant guess do not create an outcome.
  - **Prerequisites:** 064.

- [ ] **066. Make CLI/API/Web/Chat use one Attunement store and reducer.** — `P0`
  - **Why:** If a second store appears for chat, evidence and policy diverge.
  - **Deliverable:** A shared application service and surface adapter parity.
  - **Verification:** The same exact operation sequence produces an identical digest and projection on every surface.
  - **Prerequisites:** 061–065.

- [ ] **067. Recompute the current organic outcome and interaction coverage read-only.** — `P1`
  - **Why:** Dated snapshots left in the documents, such as 0/10 or 6/10, cannot be used as-is in an execution plan.
  - **Deliverable:** Eligible outcomes per life/work, exact receipts, distinct UTC/local dates, and exclusion reasons.
  - **Verification:** The Attunement and task store bytes are identical before and after report generation.
  - **Prerequisites:** 066.

- [ ] **068. Collect the missing life return moments through natural use.** — `P1`
  - **Why:** A same-session grocery fixture does not prove broad everyday return value.
  - **Deliverable:** Exact-linked Packs and explicit outcomes across different real topics and dates.
  - **Verification:** Agent-operated, synthetic, and controlled replay are excluded from the organic denominator.
  - **Prerequisites:** 067.

- [ ] **069. Collect exact life/work interaction receipts across multiple dates.** — `P1`
  - **Why:** Outcomes alone cannot corroborate that the real next step actually progressed.
  - **Deliverable:** A strict exact-receipt report with the minimum contracted volume per kind and date coverage.
  - **Verification:** Receipts are not aggregated into usefulness, feedback, consent, or promotion.
  - **Prerequisites:** 067–068.

- [ ] **070. Independently review negative outcomes by cause.** — `P1`
  - **Why:** If ignored/rejected/adjusted are absent or disregarded, it becomes a positive-only vanity metric.
  - **Deliverable:** A taxonomy of wrong source, too much detail, bad timing, weak next step, and unwanted help.
  - **Verification:** Each classification is linked to an exact delivery and an owner-authored outcome, and model guesses are marked separately.
  - **Prerequisites:** 068–069.

- [ ] **071. Apply only the bounded display-policy changes the evidence supports.** — `P1`
  - **Why:** Outcomes must not be used as grounds to expand source, permission, recipient, or action scope.
  - **Deliverable:** A versioned reducer change that alters only one of form, detail, suggestion threshold, or suppression.
  - **Verification:** The outcome N→allowed policy delta→Pack N+1 golden test and reset/undo idempotency pass.
  - **Prerequisites:** 070.

- [ ] **072. Independently audit the organic Continuity evidence and close G5.** — `P1`
  - **Why:** Even when the numeric thresholds pass, natural timing and domain diversity may be lacking.
  - **Deliverable:** An audit reviewing eligibility, exactness, dates, diversity, negatives, and the receipt/outcome separation.
  - **Verification:** The evaluator samples the raw records and returns `PASS | FAIL`; even a PASS creates no automatic-delivery authority.
  - **Prerequisites:** 061–071.

---

## Phase 6 — Privacy, permission, sandbox, and untrusted-input boundaries

**Entry condition:** G4 green. G5 organic evidence may run in parallel in the EVIDENCE/MONITOR lane,
and a red state there does not block this phase's security and privacy repair.

**Exit gate G6:** The owner boundary for personal-data storage and tool execution is repairable, and
an independent security judgement confirms there is no permission expansion or sensitive-information
leak under injection, SSRF, shell, and store-corruption faults.

- [ ] **073. Bring the permission matrix for all personal data and effects up to date.** — `P0`
  - **Why:** As features grow, the read, local write, process, network, and external send boundaries can drift.
  - **Deliverable:** An authority table per notes, tasks, memory, calendar, contacts, browser, shell, channels, and Attunement.
  - **Verification:** Each public tool/command/API route maps to exactly one permission class.
  - **Prerequisites:** 072.

- [ ] **074. Close owner-only mode for sensitive stores with a non-recursive repair.** — `P0`
  - **Why:** A loose umask or a migration can expose some `~/.muse` files to other local users.
  - **Deliverable:** An exact-file inventory, a dry-run chmod plan, and an atomic repair receipt.
  - **Verification:** Only the loose-mode fixture is narrowed to 0600/0700, and symlinks and out-of-scope files are rejected.
  - **Prerequisites:** 073.

- [ ] **075. Make the supported sensitive-store encryption repair idempotent.** — `P0`
  - **Why:** If it only shows a warning with no safe transition path, the privacy gate cannot be closed.
  - **Deliverable:** Encrypted-at-rest status, key availability, preview, atomic migration, and rollback.
  - **Verification:** There is no data loss in the plaintext→encrypted, already encrypted, wrong key, crash, and retry cases.
  - **Prerequisites:** 074.

- [ ] **076. Prove that backup and restore preserve encryption and version.** — `P0`
  - **Why:** Encryption that cannot be recovered from does not fit a personal agent's long-term continuity.
  - **Deliverable:** A versioned manifest, encrypted backup, verify-only mode, and an explicit restore preview.
  - **Verification:** The canonical digests match in an isolated empty restore target, and a newer/unknown version fails close.
  - **Prerequisites:** 075.

- [ ] **077. Automate secret and personal-remnant scanning of the current tree and release artifacts.** — `P0`
  - **Why:** A personal agent's repository easily accumulates real addresses, contacts, tokens, and local paths.
  - **Deliverable:** A secret scanner with a narrow allowlist plus owner/company remnant rules.
  - **Verification:** It catches synthetic secrets and personal markers, and false positives on known-safe fixtures are reviewable.
  - **Prerequisites:** 073.

- [ ] **078. Enforce an untrusted envelope on all tool output.** — `P0`
  - **Why:** When browser, MCP, and shell results are merged into the prompt like system instructions, it becomes injection.
  - **Deliverable:** A provenance, size/type bounds, truncation, and instruction-neutralization envelope.
  - **Verification:** An "ignore your permissions" string inside tool output cannot change policy or tool availability.
  - **Prerequisites:** 073.

- [ ] **079. Unify the SSRF and local-network policy across browser, HTTP, and MCP.** — `P0`
  - **Why:** URL redirects and alternate notations can bypass loopback/metadata endpoint blocking.
  - **Deliverable:** Canonical resolution, redirect recheck, DNS rebinding policy, and credential redaction.
  - **Verification:** The IPv4/IPv6, decimal/octal, redirect, userinfo, and DNS-swap adversarial suite is blocked.
  - **Prerequisites:** 078.

- [ ] **080. Document and check the Rust runner's actual isolation limits per capability.** — `P0`
  - **Why:** The name "sandbox" alone must not lead to overestimating network, filesystem, and process restrictions.
  - **Deliverable:** A per-platform enforced/advisory/unavailable capability report.
  - **Verification:** Each claimed restriction is verified with a real probe, and unsupported ones are marked unavailable rather than "safe".
  - **Prerequisites:** 073, 079.

- [ ] **081. Close, or explicitly limit, the file-policy bypass boundary through the shell.** — `P0`
  - **Why:** If only the file tool is protected while the shell can write the same paths, the guard lies.
  - **Deliverable:** Safe-root enforcement, command approval, a container requirement, or an explicit unsupported contract.
  - **Verification:** Scope escape via `>` redirection, heredoc, symlink, subprocess, and script interpreter does not succeed.
  - **Prerequisites:** 080.

- [ ] **082. Operate a cross-surface prompt-injection fault suite.** — `P0`
  - **Why:** Even if the browser alone is safe, notes, calendar, MCP, and email-like content can become bypass paths.
  - **Deliverable:** A direct/indirect injection corpus per source plus the expected terminal state.
  - **Verification:** Each case records 0 secret disclosures, 0 permission expansions, and 0 unapproved tool effects.
  - **Prerequisites:** 078–081.

- [ ] **083. Verify the tamper, size, and privacy boundaries of the security audit log.** — `P1`
  - **Why:** An unbounded raw log becomes a new personal-data store, and a modifiable log is not audit evidence.
  - **Deliverable:** Bounded retention, an integrity chain or immutable receipts, redaction, and an export/forget policy.
  - **Verification:** Corruption is detected under truncation, partial write, clock rollback, and log injection, and there are no secret markers.
  - **Prerequisites:** 074–082.

- [ ] **084. Close G6 with an independent adversarial security review.** — `P0`
  - **Why:** If the security implementer only evaluates their own threat model, blind spots remain.
  - **Deliverable:** Bundled findings and a judgement across permission, privacy, injection, SSRF, runner, and outbound.
  - **Verification:** 0 high/critical blockers; medium findings are either explicitly accepted by the owner or remain as the next P0.
  - **Prerequisites:** 073–083.

---

## Phase 7 — Resource governance, performance, provider neutrality

**Entry condition:** G6 green.

**Exit gate G7:** Foreground chat retains priority, background work operates within CPU, memory,
thermal, queue, and retry budgets, and there is no crash-loop, starvation, or unbounded growth over a
24-hour soak.

- [ ] **085. Complete the hard admission state matrix.** — `P0`
  - **Why:** If active user, idle, low headroom, and thermal pressure are distinguished only in prose, behavior differs per workload.
  - **Deliverable:** A table of state inputs, unavailable semantics, allowed light/heavy work, and cancel/defer decisions.
  - **Verification:** The workloads that may start are exactly fixed per injected state.
  - **Prerequisites:** 084.

- [ ] **086. Verify the per-platform sources of thermal, battery, and memory pressure.** — `P1`
  - **Why:** If only macOS thermal exists and battery or other platforms are inferred, admission decisions are wrong.
  - **Deliverable:** Supported/unavailable probes and timeouts per macOS/Windows/Linux.
  - **Verification:** A probe failure and an unknown future value do not turn into permissive success.
  - **Prerequisites:** 085.

- [ ] **087. Apply the foreground/background model concurrency budget across every provider path.** — `P0`
  - **Why:** If some auxiliary calls bypass the coordinator, foreground latency and local model stability break.
  - **Deliverable:** Lease owner, priority queue, maximum waiters, timeout, and cancellation reason.
  - **Verification:** Foreground runs ahead of queued background work, and bypassing provider calls are detected.
  - **Prerequisites:** 085.

- [ ] **088. Measure the actual KV-cache and model resident memory.** — `P1`
  - **Why:** The token window alone cannot tell the local model's real memory pressure.
  - **Deliverable:** Observed resident delta per provider/model, unavailable markers, and a safety margin.
  - **Verification:** The measurement overhead is bounded, and estimates are not labeled as measured.
  - **Prerequisites:** 086–087.

- [ ] **089. Add batch, memory, and resume budgets to embedding and indexing.** — `P1`
  - **Why:** The currently open embedding budget can destroy background responsiveness.
  - **Deliverable:** Bounded batches, checkpoints, immutable generation publish, and an explicit full-reindex override.
  - **Verification:** After a cancel/restart it resumes from the last complete checkpoint with no duplicate publish.
  - **Prerequisites:** 085, 088.

- [ ] **090. Integrate page, action, wallclock, and memory budgets into browser work.** — `P1`
  - **Why:** A browser session separate from the model loop budget can expand into unbounded pages, popups, and downloads.
  - **Deliverable:** A per-run browser budget and a terminal `budget_exhausted` state.
  - **Verification:** A popup storm, redirect loop, huge page, and stalled navigation terminate at an explicit limit.
  - **Prerequisites:** 040, 085.

- [ ] **091. Track cancellation settlement all the way to uncooperative providers.** — `P0`
  - **Why:** If the physical request keeps running after the user cancels and the lease is released, actual concurrency is exceeded.
  - **Deliverable:** Contracts for logical cancel, physical settlement, retained lease, and late-result discard.
  - **Verification:** After a cancel, a second request does not physically overlap, and a late result is not reflected in the store.
  - **Prerequisites:** 087.

- [ ] **092. Measure both foreground starvation and background starvation.** — `P1`
  - **Why:** Strengthening foreground priority alone can mean consolidation and sync never run.
  - **Deliverable:** A bounded fairness cursor, maximum defer age, and an owner-visible held reason.
  - **Verification:** Even under a sustained foreground fixture, either the minimum background progress the policy allows or an explicit held state appears.
  - **Prerequisites:** 087, 091.

- [ ] **093. Normalize a provider-neutral usage and cost ledger.** — `P1`
  - **Why:** Token and cache semantics differ per provider, which can distort cost comparison.
  - **Deliverable:** The input/output/cache/tool/estimated/unknown fields plus pricing-source freshness.
  - **Verification:** An unknown price is not aggregated as zero, and local providers distinguish cost from resource metrics.
  - **Prerequisites:** 087.

- [ ] **094. Measure local-model cold/warm performance repeatedly.** — `P1`
  - **Why:** A single warm run cannot support a claim about prompt cache and daily responsiveness.
  - **Deliverable:** Multiple-attempt median/p95, time-to-first-token, total latency, and cache-hit evidence.
  - **Verification:** The cold/warm classification is bound to the actual cache state and the quality/grounding gates are identical.
  - **Prerequisites:** 088, 093.

- [ ] **095. Run a constrained-resource recovery fault campaign.** — `P0`
  - **Why:** After deferring under low memory or thermal pressure, recovery can stall forever or surge all at once.
  - **Deliverable:** A pressure→defer→recover→re-admit trace and queue bounds.
  - **Verification:** 0 heavy starts during pressure, foreground stays responsive, and bounded progress happens within cadence after recovery.
  - **Prerequisites:** 085–094.

- [ ] **096. Close the resident 24-hour soak and resource G7.** — `P0`
  - **Why:** Queue leaks, heartbeat drift, memory growth, and retry storms are hard to see in short tests.
  - **Deliverable:** A 24h CPU/RSS/queue/heartbeat/workload summary plus the exact failures.
  - **Verification:** 0 crash-loops, 0 unbounded growth, 0 budget breaches, foreground SLO retained, evaluator PASS.
  - **Prerequisites:** 085–095.

---

## Phase 8 — UX that reaches first value within 10 minutes of installation

**Entry condition:** G7 green.

**Exit gate G8:** From an isolated empty Muse state, the real owner understands the provider and the
local/cloud boundary, completes the first source-backed answer and the first user-invoked Continuity
Pack within 10 minutes, and can repair failures themselves.

- [ ] **097. Define Muse's golden owner journey and its success time.** — `P1`
  - **Why:** Even after chaining per-feature wizards, onboarding never ends if the user does not know which value arrives when.
  - **Deliverable:** The install→privacy choice→provider→local source→first answer→first Pack journey.
  - **Verification:** Each step's terminal state, maximum time, failure recovery, and forbidden hidden actions are measurable.
  - **Prerequisites:** 096.

- [ ] **098. Consolidate the owner-scoped macOS installer path into one.** — `P1`
  - **Why:** A source checkout plus multiple setup commands is too high a barrier to entry for a personal product.
  - **Deliverable:** A signed, or clearly labeled development-stage, package, a stable CLI/app path, and a version receipt.
  - **Verification:** Installation completes from the current owner's isolated empty Muse state without Node/pnpm knowledge,
    and no temporary checkout path remains.
  - **Prerequisites:** 021–024, 097.

- [ ] **099. Make local-only versus cloud egress an explicit choice on first run.** — `P0`
  - **Why:** The act of choosing a provider does not automatically explain which data leaves the device.
  - **Deliverable:** A data-flow preview, local-only as the default, a per-provider egress summary, and a change path.
  - **Verification:** 0 cloud requests before the choice, and the chosen result agrees between the persisted policy and the live runtime.
  - **Prerequisites:** 025, 073, 098.

- [ ] **100. Connect provider setup to a credential-safe diagnostic.** — `P1`
  - **Why:** Showing an auth failure as a generic model error makes the user repeat dangerous reconfiguration.
  - **Deliverable:** Provider discovery, secret input, redacted verify, and a model capability summary.
  - **Verification:** There are no credential markers in logs/trace/UI, and invalid auth yields an actionable reason.
  - **Prerequisites:** 077, 093, 099.

- [ ] **101. Make the first chat's zero-data state useful.** — `P1`
  - **Why:** If the first screen with no personal data shows an empty dashboard or excessive settings, no value is conveyed.
  - **Deliverable:** A guided path that creates a local demo source or the user's chosen first note/task.
  - **Verification:** Fixture data and user data are clearly distinguished, and demo data is not aggregated as memory/organic evidence.
  - **Prerequisites:** 100.

- [ ] **102. Measure the path to the first source-backed answer.** — `P1`
  - **Why:** Muse's core differentiation is exact personal grounding, not generic chat.
  - **Deliverable:** Source selection, cited answer, source inspection, and a correction action.
  - **Verification:** It completes within the 10-minute budget, and unsupported claims are omitted when there is no source.
  - **Prerequisites:** 101.

- [ ] **103. Connect the first user-invoked Continuity Pack to onboarding.** — `P1`
  - **Why:** The user must not have to read a separate CLI document to discover Attunement's value.
  - **Deliverable:** A thin journey of life/work thread selection, exact link, Pack open, and outcome explanation.
  - **Verification:** Automatic threads/links/outcomes are 0, and preview and delivery are separated.
  - **Prerequisites:** 061–066, 102.

- [ ] **104. Reorganize the default status around "the next safe action".** — `P1`
  - **Why:** Token, turn, and activity numbers are diagnostics, not personal value.
  - **Deliverable:** Held actions, pending review, runtime health, evidence gap, and exact repair action cards.
  - **Verification:** Cards without an action are removed, and 0/unverified is not displayed like success.
  - **Prerequisites:** 035, 055, 067, 103.

- [ ] **105. Provide a preview-first repair wizard for the main red states.** — `P1`
  - **Why:** If doctor only describes the problem with no safe path to fix it, daily use is impossible.
  - **Deliverable:** An exact plan per resident, permission mode, encryption, provider auth, and held backlog.
  - **Verification:** The preview changes nothing, a stale target rejects apply, and a destructive step requires separate confirmation.
  - **Prerequisites:** 020, 031, 074–076, 100, 104.

- [ ] **106. Verify keyboard, screen-reader, contrast, and reduced-motion accessibility.** — `P1`
  - **Why:** A personal tool is used repeatedly, so a small accessibility defect becomes cumulative friction.
  - **Deliverable:** Semantic labels, focus order, status announcements, and motion fallback for the core journeys.
  - **Verification:** Automated a11y and a keyboard-only real-browser journey pass together.
  - **Prerequisites:** 103–105.

- [ ] **107. Tidy the Korean and English core contracts and error wording.** — `P2`
  - **Why:** If words like permission, held, unverified, and draft mean different things per translation, safety weakens.
  - **Deliverable:** Canonical terms, locale fallback, and a no-dead-string check.
  - **Verification:** Both locales display the same action/permission semantics and terminal states.
  - **Prerequisites:** 104–106.

- [ ] **108. Close G8 by verifying owner onboarding with an independent pass^3 from an isolated empty state.** — `P1`
  - **Why:** A single success that relies on a developer's memory is not installation-experience evidence.
  - **Deliverable:** Completion time, blockers, recovery actions, and final state from three mutually isolated owner-state runs.
  - **Verification:** All three reach the first cited answer and a Pack within 10 minutes, with 0 unapproved egress/sends and evaluator PASS.
  - **Prerequisites:** 097–107.

---

## Phase 9 — Open Observe, rhythm, timing, and adaptation starting from shadow

**Entry condition:** G8 green and the G5 organic audit still green.

**Exit gate G9:** Observe operates only within explicit consent, pause, and forget boundaries, and
timing passes both shadow and an owner-reviewed local/log-only cohort. No PASS automatically grants
ongoing autonomous authority.

- [ ] **109. Make Observe consent an explicit grant per category and duration.** — `P0`
  - **Why:** If one "allow observation" covers every app, data type, and period, personal trust collapses.
  - **Deliverable:** A versioned grant carrying category, source, retention, purpose, and expiry.
  - **Verification:** Category events without a grant are neither collected nor persisted, and scope expansion requires a new approval.
  - **Prerequisites:** 108.

- [ ] **110. Close Observe inspect, pause, resume, and forget as owner actions.** — `P0`
  - **Why:** The user must be able to see what is being recorded and stop or delete it immediately.
  - **Deliverable:** Live state, a bounded ledger view, pause reason, and an exact forget preview and receipt.
  - **Verification:** 0 new events after pause, forget erases only the target, and resume does not widen the previous scope.
  - **Prerequisites:** 109.

- [ ] **111. Prove data minimization for the O1 category-only collector.** — `P0`
  - **Why:** Early timing research does not need window titles, content, or verbatim keystrokes.
  - **Deliverable:** An allowed category/timestamp schema and a forbidden-payload scanner.
  - **Verification:** Synthetic secret/title/content markers do not remain in the raw store, trace, or report.
  - **Prerequisites:** 109–110.

- [ ] **112. Complete Observe export, retention, and corruption recovery.** — `P1`
  - **Why:** Long-term rhythm data is a new sensitive store, so its lifetime and recovery must be clear.
  - **Deliverable:** Bounded retention, owner export, partial-write quarantine, and version migration.
  - **Verification:** Expired data is removed per policy, and a corrupt record does not make the whole ledger unopenable.
  - **Prerequisites:** 111.

- [ ] **113. Start rhythm features as offline read-only analysis only.** — `P2`
  - **Why:** Coupling to live policy before there is enough data lets a false pattern spread into behavior.
  - **Deliverable:** Local analysis with stable focus/category transitions, time windows, and uncertainty.
  - **Verification:** Running the analysis does not change the delivery, task, outcome, or permission stores.
  - **Prerequisites:** 112.

- [ ] **114. Turn a friction hypothesis into a proposal with evidence and falsification conditions.** — `P2`
  - **Why:** Reading repeated switching directly as "the user is stuck" is a wrong psychological inference.
  - **Deliverable:** Observed facts, a bounded hypothesis, alternative explanations, a falsifier, and no-action as the default.
  - **Verification:** When several explanations fit the same observation, it is not stored as a confident fact.
  - **Prerequisites:** 113.

- [ ] **115. Replay the timing reducer shadow-only.** — `P2`
  - **Why:** Before any real notification, it must be reviewed when `silent | digest | offer` would have been chosen.
  - **Deliverable:** A mutation-free shadow ledger of input snapshot, policy version, decision, and cooldown reason.
  - **Verification:** A shadow run creates no delivery open and no channel send at all.
  - **Prerequisites:** 113–114.

- [ ] **116. Score timing false positives and false negatives via owner review.** — `P2`
  - **Why:** Offer counts or click counts alone cannot evaluate whether the timing was appropriate.
  - **Deliverable:** A should-offer, should-stay-silent, too-early, too-late, and wrong-thread review set.
  - **Verification:** Owner labels and shadow decisions are linked to exact timestamps and policy inputs.
  - **Prerequisites:** 115.

- [ ] **117. Tune the cooldown, suppression, and focus-boundary policy conservatively.** — `P2`
  - **Why:** In early proactivity, the trust cost of repeated interruption is higher than that of missed help.
  - **Deliverable:** Deterministic cooldown, rejection suppression, a stable-focus minimum, and a daily cap.
  - **Verification:** A repeated event storm and a rejected thread do not produce repeated offers.
  - **Prerequisites:** 116.

- [ ] **118. Build an exact preview for a single low-risk local/log-only cohort.** — `P2`
  - **Why:** Before broad channel delivery, the owner must review payload, timing, target, and brake all at once.
  - **Deliverable:** Cohort membership, the proposed Pack, the schedule window, resource state, and abort criteria.
  - **Verification:** Generating the preview means 0 deliveries, and it is rejected if an out-of-cohort item or an unavailable source is included.
  - **Prerequisites:** 117.

- [ ] **119. Run an owner-confirmed controlled timing cohort.** — `P2`
  - **Why:** Shadow accuracy and the real cost of interruption are different things.
  - **Deliverable:** The exact delivery, explicit outcome, timing review, and resource/safety receipt for each proposal.
  - **Verification:** 0 unapproved sends, 0 budget breaches, 0 reminder-quarantine violations, and every proposal has a review state.
  - **Prerequisites:** 118 and the owner's cohort approval.

- [ ] **120. Judge ongoing automation authority separately at the G9 promotion review.** — `P0`
  - **Why:** One cohort PASS must not automatically create ongoing autonomy.
  - **Deliverable:** An owner decision of continue shadow, repeat cohort, narrow grant, or reject, plus an expiry.
  - **Verification:** Absent a decision or with stale evidence, the runtime stays in the user-invoked/held state.
  - **Prerequisites:** 109–119.

---

## Phase 10 — Expand competitiveness in a different way from OpenClaw and Hermes

**Entry condition:** G9 at least a shadow PASS, with G1–G8 still green.

**Exit gate G10:** Only expansions that strengthen exact personal grounding and accountable
adaptation are selected — not "catching up on feature count" — and additional
channels/skills/subagents do not degrade the existing safety and daily-value gates.

- [ ] **121. Fix Muse's positioning contract as one sentence and three proofs.** — `P1`
  - **Why:** Chasing OpenClaw on channel count and Hermes on self-improvement speed blurs Muse's strengths.
  - **Deliverable:** A product contract of exact-source continuity, explicit outcome learning, and no-silent-permission-expansion.
  - **Verification:** The claims in the README, onboarding, status, and release notes are not broader than the current evidence.
  - **Prerequisites:** 120.

- [ ] **122. Define channel-expansion criteria by usage frequency, effectiveness, and security cost.** — `P2`
  - **Why:** "20+ channels" parity creates unnecessary maintenance and attack surface for a single-user product.
  - **Deliverable:** A scorecard of owner usage, notification fit, draft/approval support, and maintenance cost.
  - **Verification:** A low-scoring channel remains a rejected/deferred decision rather than an implementation backlog item.
  - **Prerequisites:** 121.

- [ ] **123. Complete the single highest-value channel as a golden adapter.** — `P2`
  - **Why:** One reliable inbound/outbound/dedupe/approval path matters more than several shallow adapters.
  - **Deliverable:** The setup, health, inbound identity, draft, approve, delivery receipt, retry, and revoke journey.
  - **Verification:** A duplicate webhook, reconnect, token revoke, and ambiguous send each produce an exact terminal state.
  - **Prerequisites:** 033–035, 122.

- [ ] **124. Apply a shared conformance suite to every channel.** — `P2`
  - **Why:** Recipient, thread, attachment, and retry semantics can drift per adapter.
  - **Deliverable:** A capability declaration plus a required/unsupported behavior suite.
  - **Verification:** Unsupported features do not silently fall back, and every outbound passes the shared approval/dedupe gate.
  - **Prerequisites:** 123.

- [ ] **125. Bring MCP discovery, install, and permission UX to product level.** — `P2`
  - **Why:** Even with a strong MCP foundation, real-use value is low if the user cannot understand trust and capability.
  - **Deliverable:** Server identity, tool diff, requested permissions, local/remote transport, and a health/revoke view.
  - **Verification:** A server/tool change requires re-approval, and untrusted metadata cannot change the policy description.
  - **Prerequisites:** 073, 078, 121.

- [ ] **126. Unify the skill lifecycle as proposal-first.** — `P2`
  - **Why:** Copying Hermes-style rapid self-edit as-is loses Muse's accountable-adaptation strength.
  - **Deliverable:** An observe→draft→test→review→activate→rollback state machine.
  - **Verification:** Active skill bytes do not change before the self-learning hold and review.
  - **Prerequisites:** 028, 120, 125.

- [ ] **127. Generate skill/memory proposals from corrections but do not apply them automatically.** — `P2`
  - **Why:** Learning from repeated corrections is highly valuable, but changing durable behavior from one conversation is dangerous.
  - **Deliverable:** A proposal carrying exact source, proposed diff, expected benefit, risk, and expiry.
  - **Verification:** Sensitive/private turns create no proposal, and duplicate corrections are deduped.
  - **Prerequisites:** 054–058, 126.

- [ ] **128. Present only proposals that passed held-out evaluation to the owner.** — `P2`
  - **Why:** A skill fitted to the training examples can break ordinary tasks.
  - **Deliverable:** A train/held-out split, a behavioral rubric, a regression budget, and a rollback checkpoint.
  - **Verification:** A held-out failure disables the activate action and retains the existing active behavior.
  - **Prerequisites:** 127.

- [ ] **129. Verify session crash recovery and resume-pending as an everyday journey.** — `P1`
  - **Why:** OpenClaw's and Hermes's practicality comes from the operational experience of returning after a long task is interrupted.
  - **Deliverable:** Checkpoint identity, pending-effect reconciliation, and an exact resume preview.
  - **Verification:** Crash-before/after-effect, a corrupt checkpoint, and a version mismatch each recover without duplicate effects, or are rejected.
  - **Prerequisites:** 096, 121.

- [ ] **130. Decide the voice and mobile companion by an evidence-based go/no-go.** — `P3`
  - **Why:** They are attractive surfaces, but a large detour unless they actually reduce the current user's return moments.
  - **Deliverable:** Concrete owner journeys, latency/privacy constraints, and a comparison of whether the existing surfaces can solve it.
  - **Verification:** Absent at least two recurring organic needs, the decision not to implement is recorded.
  - **Prerequisites:** 072, 121.

- [ ] **131. Prove an outcome gain over single-agent before expanding subagents.** — `P2`
  - **Why:** Multi-agent greatly increases token use, conflict, and permission surface.
  - **Deliverable:** A bounded task family, a single-agent baseline, a supervisor trial, and a cost/quality/failure comparison.
  - **Verification:** If the held-out results and pass^k do not clearly improve, it is not promoted to the default path.
  - **Prerequisites:** 060, 084, 096.

- [ ] **132. Maintain G10 with a quarterly competitor delta review.** — `P3`
  - **Why:** Using a single teardown as if it were the permanent current state produces wrong parity work.
  - **Deliverable:** The OpenClaw and Hermes delta based on official releases/docs, Muse fit, and an adopt/reject/defer decision.
  - **Verification:** A competitor feature is not put on the backlog unless it has a user problem, safety fit, and an evidence gate.
  - **Prerequisites:** 121–131.

---

## Phase 11 — Repository trust, distribution, 30-day value verification, release

**Entry condition:** Depends on the release label. Engineering alpha requires G0–G4 and G6–G8 green.
An evidence-backed personal-agent release additionally requires G5, Task 121, and 133–143 green.
G9 proactive timing and G10 competitor expansion are not required prerequisites for this phase.

**Exit gate G11:** Installation, the repository, and the release artifact all point at one trustworthy
path, and the 30-day daily-use evidence and release-readiness receive an independent PASS. Public
distribution makes no claim broader than the current evidence.

- [ ] **133. Correct the package metadata to the canonical `muse-agent` repository.** — `P1`
  - **Why:** The current package metadata points at the former `wlsdks/Muse`, so discovery and issue provenance diverge.
  - **Deliverable:** A single canonical target for the repository, homepage, bugs, and source-install links.
  - **Verification:** Every canonical link in the package tarball and the README points at the same current repository.
  - **Prerequisites:** 121.

- [ ] **134. Decide the archive, redirect, and history policy for the former repository.** — `P1`
  - **Why:** If a divergent README and overstated claims remain, users and search engines see the wrong product.
  - **Deliverable:** A canonical notice, migration link, issue handling, and a private/public history safety decision.
  - **Verification:** From the old entrypoint one can reach the current install and current claims in one step.
  - **Prerequisites:** 133 and the owner's repository-state decision.

- [ ] **135. Split README claims into shipped, experimental, roadmap, and not-proven.** — `P1`
  - **Why:** Using the same wording for "an implementation exists" and "personal effectiveness is proven" loses trust.
  - **Deliverable:** A table of "works today", boundaries, current qualification, Attunement status, and comparison claims.
  - **Verification:** Each strong claim is linked to a fresh report or a code contract, and there are no absolute safety claims.
  - **Prerequisites:** 121, 133–134.

- [ ] **136. Consolidate the install, upgrade, repair, backup, and uninstall documentation into a golden path.** — `P1`
  - **Why:** If operational paths are scattered across several documents, dangerous commands get guessed during a real incident.
  - **Deliverable:** Per-platform commands, expected state, rollback, and the preserve-data boundary.
  - **Verification:** A fresh reader completes the isolated owner-state journey from the documentation alone, with no destructive ambiguity.
  - **Prerequisites:** 021–024, 075–076, 098, 133.

- [ ] **137. Bind the version, CHANGELOG, and migration contract to the release artifact.** — `P1`
  - **Why:** When HEAD and the latest tag differ, which store/runtime contract gets installed must be clear.
  - **Deliverable:** The semver decision, a Keep-a-Changelog entry, migration compatibility, and the minimum runtime.
  - **Verification:** The built binary/package version, tag candidate, changelog, and migration version all agree.
  - **Prerequisites:** 136.

- [ ] **138. Verify the macOS signed artifact and the Gatekeeper path.** — `P1`
  - **Why:** An everyday product that is not a source checkout must prove its install origin and whether it was tampered with.
  - **Deliverable:** A signed app/CLI/installer, an entitlements inventory, notarization or an explicit pre-release
    boundary, and the current owner's installed-candidate lifecycle receipt.
  - **Verification:** On the current owner profile the signature, quarantine, and first launch are valid, and an isolated
    candidate install→start→heartbeat→status→stop→start confirms a single writer, agreement of
    artifact, PID, generation, and heartbeat, and 0 external sends.
  - **Prerequisites:** 098, 137.

- [ ] **139. Produce release provenance, SBOM, secret scan, and dependency audit.** — `P0`
  - **Why:** For an agent holding personal data and shell/browser authority, supply-chain provenance matters especially.
  - **Deliverable:** Source commit, reproducible build inputs, checksums, SBOM, and vulnerability/secret reports.
  - **Verification:** The artifact checksum matches the provenance, and a high/critical finding blocks the release.
  - **Prerequisites:** 077, 084, 137–138.

- [ ] **140. Set telemetry and crash reporting as privacy-first opt-in.** — `P1`
  - **Why:** Automatically collecting personal prompts and source contents for product improvement conflicts with Muse's value proposition.
  - **Deliverable:** Default-off or explicit opt-in, allowed fields, local inspect/export/delete, and retention.
  - **Verification:** 0 network events in the opt-out fixture, and no content/secret markers in the opt-in payload.
  - **Prerequisites:** 073–084, 138.

- [ ] **141. Carry out a 30-day owner dogfood under fixed operating rules.** — `P1`
  - **Why:** A few days of focused testing cannot prove everyday return, long-term memory, and daemon drift.
  - **Deliverable:** A bounded journal of daily health, real return moments, failures, repairs, held actions, and explicit outcomes.
  - **Verification:** Synthetic/agent-operated rows are marked separately, and missing days and disabled periods remain in the denominator.
  - **Prerequisites:** 024, 036, 060, 072, 084, 096, 108, 120.

- [ ] **142. Judge the personal-value scorecard and kill criteria from the 30-day evidence.** — `P1`
  - **Why:** However many features exist, there is no value if resume time, correction cost, and unwanted interruption do not improve.
  - **Deliverable:** An evidence-class-aware report on time-to-resume, exact-source success, corrected-fact retention,
    used/adjusted/ignored/rejected, unwanted-send/interruption, and repair burden.
  - **Verification:** Denominator, dates, missingness, and negatives are stated, and technical metrics are not promoted into usefulness.
  - **Prerequisites:** 141.

- [ ] **143. Run the immutable release-readiness gate independently.** — `P0`
  - **Why:** Green local tests alone must not paper over a stale artifact or an organic blocker and release anyway.
  - **Deliverable:** HEAD/time/input-hash-bound runtime, delivery, recall, security, resource, onboarding, organic, and
    packaging reports, plus the owner-scoped installed-candidate lifecycle receipt from 138.
  - **Verification:** If even one required axis is failed/unverified/stale, or the 138 lifecycle receipt does not match the current
    signed candidate, the aggregate is FAILED and blocks the tag/release.
  - **Prerequisites:** 133–142.

- [ ] **144. Complete the first evidence-backed personal-agent release and its retrospective.** — `P1`
  - **Why:** A release is not a code upload; it is an operational event of an installable artifact and honest claims.
  - **Deliverable:** The approved version, an immutable tag, the published artifact, install verification, a rollback plan, and a
    post-release incident/value review.
  - **Verification:** The tag points at the exact approved commit, an isolated owner-state install, upgrade, and rollback pass, and
    organic value is described only within the scope 142 proved.
  - **Prerequisites:** 143 PASS and the owner's release-scope decision.

---

## Phase 12 — Post-release reliability and incident recovery

**Entry condition:** G11 green, so the first evidence-backed release is installable.

**Exit gate G12:** The health, update, rollback, and incident paths of the actually installed release
are verified, and an incident does not escalate into personal-data corruption or duplicate external
effects.

- [ ] **145. Bind the installed release's runtime health receipt to its version.** — `P0`
  - **Why:** A green source checkout and the state of the signed artifact the user runs can differ.
  - **Deliverable:** A receipt carrying installed version, artifact checksum, resident identity, config generation, and heartbeat.
  - **Verification:** The receipt changes exactly across an upgrade, and another artifact's health is not accepted as the current release's.
  - **Prerequisites:** 144.

- [ ] **146. Aggregate crash-free sessions and resident uptime privacy-safely.** — `P1`
  - **Why:** Individual crash reports alone make it hard to judge whether everyday stability is improving.
  - **Deliverable:** Local bounded counters, a version window, a denominator, and an opted-in export path.
  - **Verification:** It distinguishes the crash-free rate from unknown/missing intervals without prompt/source content.
  - **Prerequisites:** 140, 145.

- [ ] **147. Build an incident severity and owner-facing response contract.** — `P0`
  - **Why:** Handling a daemon outage the same way as data corruption or a wrong send is dangerous.
  - **Deliverable:** A SEV taxonomy, containment first action, evidence preservation, recovery owner, and escalation threshold.
  - **Verification:** Representative incidents map to one severity and an executable runbook.
  - **Prerequisites:** 145–146.

- [ ] **148. Make release rollback data-compatible and effect-safe.** — `P0`
  - **Why:** Reverting only the binary can leave a new schema or a pending delivery in conflict with the old version.
  - **Deliverable:** A compatibility preflight, pending-effect brake, previous-artifact restore, and a post-rollback health check.
  - **Verification:** A crash during rollback and an incompatible-store fixture fail close before any data change.
  - **Prerequisites:** 137–139, 147.

- [ ] **149. Build a policy that decides between forward-fix and restore on migration failure.** — `P0`
  - **Why:** Automatic retries and downgrades can widen the scope of corruption.
  - **Deliverable:** A migration journal, last-safe checkpoint, reversible/irreversible classification, and an owner preview.
  - **Verification:** A partial migration, checksum mismatch, disk-full, and running an old binary each produce a deterministic terminal state.
  - **Prerequisites:** 076, 137, 148.

- [ ] **150. Produce a privacy-safe support bundle.** — `P1`
  - **Why:** Incident analysis must not require sharing the whole of `~/.muse`.
  - **Deliverable:** Allowlisted diagnostics, a redaction manifest, an exact preview, a local archive, and an expiry.
  - **Verification:** Seeded secret, prompt, contact, and calendar content is absent from the bundle, and omitted fields are stated.
  - **Prerequisites:** 077, 083, 147.

- [ ] **151. Separate the stable and candidate update channels and the downgrade boundary.** — `P1`
  - **Why:** If an experimental release auto-installs onto the everyday resident, organic evidence and data are polluted.
  - **Deliverable:** Explicit channel selection, a signed manifest, and the minimum/maximum compatible store version.
  - **Verification:** Without a candidate opt-in, a stable user does not receive a prerelease.
  - **Prerequisites:** 137–149.

- [ ] **152. Make the release cohort and rollout pause owner-controlled.** — `P1`
  - **Why:** Even for a single user, cause isolation is hard when the desktop, CLI, and daemon artifacts change at once.
  - **Deliverable:** Component rollout order, health checkpoints, pause/resume, and a rollback trigger.
  - **Verification:** When one component fails, the remaining rollout stops and the mixed-version support state is displayed.
  - **Prerequisites:** 145, 151.

- [ ] **153. Make the resident canary a synthetic probe with no external effects.** — `P1`
  - **Why:** Testing daemon liveness with a real reminder or message creates side effects for the user.
  - **Deliverable:** A no-model/no-network/no-send canary and its expected trace.
  - **Verification:** The canary checks only heartbeat, scheduler, and store reads, and is not aggregated into personal outcomes.
  - **Prerequisites:** 145–152.

- [ ] **154. Make regressions automatically bisectable from release to commit to artifact.** — `P2`
  - **Why:** In fast development, manually guessing the version where a problem started delays recovery.
  - **Deliverable:** Versioned reports, an artifact provenance query, and a deterministic reproducer entrypoint.
  - **Verification:** It finds the first bad artifact for a known injected regression in an uncontaminated fixture.
  - **Prerequisites:** 003, 139, 153.

- [ ] **155. Define reliability SLOs and the error budget to match personal-use value.** — `P1`
  - **Why:** A personal agent is not useful if uptime is high while resume, send, and memory fail.
  - **Deliverable:** SLOs for resident freshness, successful safe resume, duplicate effects, and recovery burden.
  - **Verification:** The denominator and missing time are stated, and exceeding the budget automatically holds feature rollout.
  - **Prerequisites:** 142, 146, 154.

- [ ] **156. Close G12 with a post-release incident drill.** — `P0`
  - **Why:** It must be proven that the documented rollback and support paths work in the real installed environment.
  - **Deliverable:** A drill report for crash-loop, migration failure, bad update, and ambiguous send.
  - **Verification:** 0 data loss, 0 duplicate external effects, bounded recovery time, evaluator PASS.
  - **Prerequisites:** 145–155.

---

## Phase 13 — Handle long-term personal memory including time, contradiction, and forgetting

**Entry condition:** G12 green and G4 corrected recall still green.

**Exit gate G13:** Facts, preferences, episodes, and strategies are stored, retrieved, corrected, and
forgotten while carrying their source and time range, and even under long-term use stale information
does not overwrite the latest truth.

- [ ] **157. Make the personal memory source taxonomy a canonical schema.** — `P1`
  - **Why:** A user statement, an inferred pattern, an imported note, and a task receipt each carry different authority.
  - **Deliverable:** Source class, authority, consent, retention, and allowed-use fields.
  - **Verification:** Memory without a source does not enter active recall or policy learning.
  - **Prerequisites:** 051–058, 156.

- [ ] **158. Support facts with a time range as first-class.** — `P1`
  - **Why:** An address, a job, or a preference may be true only for a specific period rather than "always true".
  - **Deliverable:** valid-from/to, recorded-at, observed-at, and uncertainty semantics.
  - **Verification:** A question about a past point in time and a present question yield different, exact answers from the same fact history.
  - **Prerequisites:** 157.

- [ ] **159. Model preference strength and evolution with explicit evidence.** — `P1`
  - **Why:** Storing a single choice as a permanent preference makes personalization inconvenient instead.
  - **Deliverable:** Preferences carrying stated/observed, strength, scope, repetition, contradiction, and expiry.
  - **Verification:** A single weak observation is not promoted into a durable strong preference.
  - **Prerequisites:** 157–158.

- [ ] **160. Separate the episodic, semantic, and procedural memory boundaries.** — `P1`
  - **Why:** A single event, a persisting fact, and an execution strategy must have different retrieval and forgetting policies.
  - **Deliverable:** Store/interface separation and cross-reference rules.
  - **Verification:** Deleting an episode does not automatically delete an independently confirmed semantic fact or an approved skill.
  - **Prerequisites:** 157–159.

- [ ] **161. Resolve entity aliases and same-person conflicts owner-confirmed.** — `P1`
  - **Why:** Automatically merging same-named people or projects links personal information incorrectly.
  - **Deliverable:** Exact entity IDs, a candidate alias proposal, a merge/split preview, and an undo receipt.
  - **Verification:** An ambiguous name is not auto-merged, and previous links are exactly restored after a split.
  - **Prerequisites:** 160.

- [ ] **162. Compute memory confidence as calibrated support.** — `P2`
  - **Why:** A model confidence number may not match actual accuracy.
  - **Deliverable:** Deterministic support bands using source authority, recency, corroboration, and contradiction.
  - **Verification:** On a held-out correction corpus, the high-support false-claim rate does not exceed the set floor.
  - **Prerequisites:** 158–161.

- [ ] **163. Explain "why this was remembered" in a bounded way in recall results.** — `P1`
  - **Why:** To correct a wrong memory, the user must be able to inspect the selection grounds and the source.
  - **Deliverable:** A safe projection of chosen source, freshness, supersession, and omitted-conflict reason.
  - **Verification:** The explanation does not expose raw private turns or hidden prompts and matches the actual reducer decision.
  - **Prerequisites:** 162.

- [ ] **164. Make memory consolidation a proposal rather than an apply.** — `P2`
  - **Why:** Summarizing multiple episodes into one durable fact carries a risk of distorting meaning.
  - **Deliverable:** The source set, proposed summary, conflicts, and a reversible apply action.
  - **Verification:** Viewing a proposal does not change the store, and it closes as stale if one source disappears.
  - **Prerequisites:** 160–163.

- [ ] **165. Separate forgetting and decay by purpose and risk.** — `P1`
  - **Why:** A safety-critical veto or correction must not disappear merely because it is old.
  - **Deliverable:** The retain, decay rank, archive, delete, and never-auto-delete classes.
  - **Verification:** Explicit vetoes, permission revocations, and security events are not subject to generic age decay.
  - **Prerequisites:** 157–164.

- [ ] **166. Constrain the personal ontology to a user-visible link graph.** — `P2`
  - **Why:** Exact relations a human can inspect are more trustworthy than a hidden personality profile.
  - **Deliverable:** Person/project/place/topic relations, source links, and merge/split/forget controls.
  - **Verification:** Unsupported relations are not added to the graph, and inferences are marked differently from facts.
  - **Prerequisites:** 161–165.

- [ ] **167. Detect conflicts among memory, notes, contacts, and tasks transactionally.** — `P1`
  - **Why:** When the same personal fact is stored differently per store, source selection becomes non-deterministic.
  - **Deliverable:** A cross-store conflict cue, a read snapshot, owner resolution, and a no-hidden-write rule.
  - **Verification:** In the concurrent-change fixture, a stale resolution is rejected and no store is partially applied.
  - **Prerequisites:** 161, 166.

- [ ] **168. Close G13 with a long-term correction/forget/recovery suite.** — `P0`
  - **Why:** Short-term fixtures do not catch months of temporal change and compaction/migration interaction.
  - **Deliverable:** A simulated multi-month corpus and a consented organic audit sample.
  - **Verification:** The evaluator judges current-fact precision, historical queries, abstention, forget completeness, and no-resurrection.
  - **Prerequisites:** 157–167.

---

## Phase 14 — The life loop of tasks, calendar, reminders, contacts, and notes

**Entry condition:** G13 green and each personal store's privacy gate retained.

**Exit gate G14:** The personal domains operate not as separately existing stores but as one verified
life loop that helps with daily and weekly planning and return through exact authority and explicit
action.

- [ ] **169. Capture task intent from conversation as a draft.** — `P1`
  - **Why:** Turning every sentence where the user says "I should" into an automatic task becomes noise.
  - **Deliverable:** Title, due ambiguity, source turn, a proposed list, and an explicit create action.
  - **Verification:** Questions, hypotheticals, and other people's tasks are not auto-created, and store writes before confirm are 0.
  - **Prerequisites:** 066, 168.

- [ ] **170. Clarify a vague task into an executable next action.** — `P1`
  - **Why:** An item like "prepare for the trip" is hard to use directly as a Continuity next step.
  - **Deliverable:** Bounded clarification, an optional decomposition draft, and a link to the original intent.
  - **Verification:** It does not invent detailed actions or deadlines without a user answer.
  - **Prerequisites:** 169.

- [ ] **171. Separate calendar free/busy authority from event-detail authority.** — `P0`
  - **Why:** A tool that only needs schedule availability does not need to read titles, attendees, and notes.
  - **Deliverable:** An availability-only capability and an explicit detail-read capability.
  - **Verification:** The free/busy tool output contains no private event content and no provider fallback occurs.
  - **Prerequisites:** 073, 168.

- [ ] **172. Build a preparation Pack based on an exact calendar occurrence.** — `P1`
  - **Why:** Exactly connecting the notes/tasks needed before a hospital visit, meeting, or trip is the substantive value.
  - **Deliverable:** Occurrence ID, user-linked sources, read-only context, and one optional next action.
  - **Verification:** It is not mixed up with another occurrence of a recurring series, and only Pack open creates a delivery.
  - **Prerequisites:** 064, 171.

- [ ] **173. Specify the reminder lifecycle as create→snooze→fire→ack→expire.** — `P1`
  - **Why:** If old pending items and new reminders pile up in the same state, the backlog recurs.
  - **Deliverable:** A versioned state machine, exact time zone, receipts, and idempotent transitions.
  - **Verification:** DST, clock rollback, restart, duplicate fire, and stale snooze do not produce duplicate delivery.
  - **Prerequisites:** 029–032, 171.

- [ ] **174. Use contacts safely as relationship context, not as recipients.** — `P1`
  - **Why:** Relationship memory is useful, but a contact lookup must not itself become send authority.
  - **Deliverable:** Exact contact ID, bounded relationship facts, and a no-recipient projection.
  - **Verification:** A draft recipient is not decided automatically from a fuzzy name match and contact context alone.
  - **Prerequisites:** 161, 171.

- [ ] **175. Close the round trip of note capture and grounded retrieval.** — `P1`
  - **Why:** Storing a note is not a personal knowledge base if it cannot later be found exactly, edited, and deleted.
  - **Deliverable:** Source-aware create, cited recall, exact edit, conflict detection, and a forget path.
  - **Verification:** Under concurrent edits and a renamed file, the canonical source is retained with no lost update.
  - **Prerequisites:** 167–174.

- [ ] **176. Make the user-invoked daily review actionable.** — `P1`
  - **Why:** What is needed is today's held items, exact commitments, and a safe next action — not plain statistics.
  - **Deliverable:** Today's events/tasks/reminders, pending reviews, and one owner-chosen focus.
  - **Verification:** It does not auto-reschedule or auto-send from an overdue count alone, and every card has a source/action.
  - **Prerequisites:** 169–175.

- [ ] **177. Split the weekly review into a planning review and a learning review.** — `P1`
  - **Why:** Past activity volume must not be mistaken for personal achievement or learning success.
  - **Deliverable:** Completed/open transitions, explicit outcomes, unresolved conflicts, and next-week drafts.
  - **Verification:** Token/tool-call counts remain diagnostics only, and usefulness uses explicit outcomes alone.
  - **Prerequisites:** 176.

- [ ] **178. Draft follow-ups from exact commitments.** — `P1`
  - **Why:** Remembering the contact to make after a conversation or event is useful, but sending to a wrong recipient is dangerous.
  - **Deliverable:** Commitment source, recipient candidate, due window, draft content, and explicit approve.
  - **Verification:** Without an exact commitment or recipient authority, even a draft is not promoted into an actionable send.
  - **Prerequisites:** 033–034, 174, 177.

- [ ] **179. Explain where the daily/weekly loop is stuck in the personal status.** — `P1`
  - **Why:** The user must know what to review without wandering across per-store screens.
  - **Deliverable:** Action cards for source conflict, stale reminder, pending draft, missing outcome, and held automation.
  - **Verification:** Viewing status is mutation-free, and execution is rejected when an action target is stale.
  - **Prerequisites:** 104, 176–178.

- [ ] **180. Close G14 with a multi-date organic audit of the life-domain loop.** — `P1`
  - **Why:** Individual tool tests do not prove real everyday planning and return value.
  - **Deliverable:** Distinct real journeys spanning task/calendar/note/reminder/contact plus negative outcomes.
  - **Verification:** Exact-source success, correction burden, unwanted effects, and time-to-resume are independently evaluated.
  - **Prerequisites:** 169–179.

---

## Phase 15 — Safe execution of web research, browser action, and computer control

**Entry condition:** G14 green and the Browser/runner security gates fresh green.

**Exit gate G15:** Muse researches current information and executes browser/computer tasks while
maintaining the page, file, authentication, and external-effect boundaries, and completes the critical
journeys with pass^k.

- [ ] **181. Operate the browsing archive with explicit opt-in and per-site retention.** — `P1`
  - **Why:** Continuously collecting the entire browsing history is sensitive data Attunement does not need.
  - **Deliverable:** Enable scope, site/category exclusions, inspect, pause, forget, and retention.
  - **Verification:** Visits in the opt-out and private-site fixtures are not recorded in the archive.
  - **Prerequisites:** 109–112, 180.

- [ ] **182. Make the web search freshness and citation contract provider-neutral.** — `P1`
  - **Why:** For a current-information question, an old result must not be answered as if it were a present fact.
  - **Deliverable:** Query time, result date, source URL, provider provenance, and unsupported/unknown states.
  - **Verification:** On a stale-conflict corpus, either the latest authoritative source is chosen or it explicitly abstains.
  - **Prerequisites:** 060, 181.

- [ ] **183. Separate page extraction by content type and trust boundary.** — `P1`
  - **Why:** Handling HTML, PDF, image, and download through the same parser and prompt boundary produces injection and omissions.
  - **Deliverable:** Type detection, bounded extraction, source offsets, and an untrusted envelope.
  - **Verification:** Malformed, huge, encrypted, and prompt-injected documents yield a safe terminal state.
  - **Prerequisites:** 078, 182.

- [ ] **184. Enforce inspect→plan→effect preview before a browser action.** — `P0`
  - **Why:** Clicking or filling the moment a page is seen can act on a stale DOM and in the wrong account.
  - **Deliverable:** Observed target identity, planned steps, effect class, and a revalidation point.
  - **Verification:** An old target handle is not reused after a DOM change or navigation.
  - **Prerequisites:** 039–040, 183.

- [ ] **185. Separate form fill and submit into distinct authorities.** — `P0`
  - **Why:** Preparing input and submitting externally carry different risk.
  - **Deliverable:** Field-level preview, secret masking, a submit effect summary, and explicit confirmation.
  - **Verification:** Approving fill alone does not cause submit/navigation, and hidden fields are also included in the preview.
  - **Prerequisites:** 184.

- [ ] **186. Expose downloads only after quarantine and a provenance check.** — `P0`
  - **Why:** An executable or document received from the web leading straight into a shell or parser is dangerous.
  - **Deliverable:** Content hash, source URL, MIME/signature check, safe filename, and quarantine state.
  - **Verification:** Executable mismatch, path traversal, overwrite, and oversized downloads are blocked.
  - **Prerequisites:** 079, 183–185.

- [ ] **187. Require an exact path, content, and destination preview for file upload.** — `P0`
  - **Why:** Uploading a wrong or sensitive file to an external site is hard to undo.
  - **Deliverable:** Canonical file identity, size/type, destination origin, a redaction warning, and explicit approve.
  - **Verification:** A symlink swap, file mutation, and origin change are rejected by revalidation immediately before upload.
  - **Prerequisites:** 073, 185–186.

- [ ] **188. Bind browser authentication and account identity to the effect.** — `P0`
  - **Why:** With multiple accounts logged in, it can act as a different user or organization.
  - **Deliverable:** An observed account indicator, uncertainty, required owner selection, and session expiry.
  - **Verification:** A send/purchase/admin effect whose account identity is unconfirmed is not executed.
  - **Prerequisites:** 184–187.

- [ ] **189. Make computer control accessibility-tree-first.** — `P1`
  - **Why:** Driving a macOS app from pixel coordinates alone is fragile against window moves, resolution, and locale.
  - **Deliverable:** Semantic element identity, window/app scope, and a coordinate-fallback reason.
  - **Verification:** The target is retained across window moves and scale changes, and ambiguous elements are rejected.
  - **Prerequisites:** 080–082, 188.

- [ ] **190. Add checkpoints and recovery to multi-step computer actions.** — `P1`
  - **Why:** Re-running from the beginning after a mid-way failure causes duplicate input, saves, and sends.
  - **Deliverable:** Step state, observed postconditions, and resumable/non-resumable effect classification.
  - **Verification:** After a crash/restart it resumes from the last verified checkpoint or stops safely.
  - **Prerequisites:** 129, 189.

- [ ] **191. Link web/computer actions to a personal thread with exact provenance.** — `P1`
  - **Why:** It must later be possible to confirm which user goal and authority an executed action came from.
  - **Deliverable:** Separation of thread, source request, action plan, effect receipts, and outcome.
  - **Verification:** An action receipt alone does not create a helpful outcome or a future permission.
  - **Prerequisites:** 066, 184–190.

- [ ] **192. Close G15 with pass^k on the critical browser/computer journeys.** — `P0`
  - **Why:** If the action success rate is low, it is not a practical personal agent even if it is safe.
  - **Deliverable:** Terminal-state graders for research, form draft, download, upload preview, and desktop workflow.
  - **Verification:** Strict pass^k, 0 duplicate effects, 0 wrong-account effects, injection fault suite PASS.
  - **Prerequisites:** 181–191.

---

## Phase 16 — Connect communication with exact recipients and draft-first

**Entry condition:** G15 green and delivery safety fresh green.

**Exit gate G16:** Inbound context and recipient identity are exactly linked, and every outbound
communication goes through draft, review, approve, and reconcile and completes with no duplicate and
no wrong recipient.

- [ ] **193. Bind recipient identity exactly to a contact and a channel account.** — `P0`
  - **Why:** The same name, alias, or address can correspond to several people or accounts.
  - **Deliverable:** Canonical contact ID, channel-specific address, verification source, and expiry.
  - **Verification:** A recipient is not settled from a fuzzy name or conversational context alone.
  - **Prerequisites:** 174, 192.

- [ ] **194. Display the channel account and workspace identity before the effect.** — `P0`
  - **Why:** With a personal Slack, a company Slack, and several email accounts, the wrong sending identity can be chosen.
  - **Deliverable:** A send preview of provider, account, workspace, destination, and observed authority.
  - **Verification:** If the identity is unknown/stale the draft is retained but approve/send is disabled.
  - **Prerequisites:** 123–124, 193.

- [ ] **195. Put source and unsupported-claim markers into the communication draft.** — `P1`
  - **Why:** If a personal agent fabricates facts into a message, it directly damages the user's relationships.
  - **Deliverable:** Cited source snippets, user-authored facts, uncertain placeholders, and an editable draft.
  - **Verification:** Dates, appointments, amounts, and statuses without a source are not generated as automatically definite sentences.
  - **Prerequisites:** 163, 193–194.

- [ ] **196. Constrain tone preference to explicit per-recipient and per-context rules.** — `P1`
  - **Why:** Generalizing the register of one conversation to every relationship produces inappropriate messages.
  - **Deliverable:** A tone profile carrying scope, source, examples, prohibited style, and expiry.
  - **Verification:** The work and family fixtures do not borrow each other's tone preference.
  - **Prerequisites:** 159, 195.

- [ ] **197. Make attachments and quoted history a separate review surface.** — `P0`
  - **Why:** Approving only the body can send a sensitive attachment or a long conversation history along with it.
  - **Deliverable:** Exact attachment hash, quoted range, redaction warning, and a total payload preview.
  - **Verification:** File mutation, a hidden attachment, an excessive quote, and a private marker are blocked before send.
  - **Prerequisites:** 187, 195.

- [ ] **198. Handle inbound thread context as bounded and untrusted.** — `P0`
  - **Why:** Injection in past messages and a long thread can override system policy or the latest intent.
  - **Deliverable:** Participant identity, selected turns, truncation reason, and an untrusted envelope.
  - **Verification:** Quoted injection cannot change tool authority or the recipient, and omitted context is displayed.
  - **Prerequisites:** 078, 193–197.

- [ ] **199. Automate inbound triage only at the label/draft level.** — `P1`
  - **Why:** Coupling mutations such as mark-as-unread, archive, and reply to the initial classification raises the cost of a misjudgement.
  - **Deliverable:** An urgency/category/confidence proposal, owner review, and no-mutation as the default.
  - **Verification:** Viewing triage alone does not change read state, archive, task, or reply.
  - **Prerequisites:** 198.

- [ ] **200. Retain a final owner confirmation for every outbound send.** — `P0`
  - **Why:** Even in Muse's long-term goals, communication puts user trust ahead of automatic sending.
  - **Deliverable:** An immutable payload hash, recipient/account identity, expiry, and one-shot approval.
  - **Verification:** After a draft edit, a recipient change, or expiry, an existing approval is not reused.
  - **Prerequisites:** 033–034, 193–199.

- [ ] **201. Bind scheduled sends to approval expiry and the delivery brake.** — `P0`
  - **Why:** Even an approved message can become stale in content and receiving context as time passes.
  - **Deliverable:** scheduled-at, approval valid-until, revalidation, cancel, and a held reason.
  - **Verification:** No send occurs under expiry, an account change, brake-on, or a clock jump.
  - **Prerequisites:** 173, 200.

- [ ] **202. Reconcile ambiguous delivery status against provider receipts.** — `P0`
  - **Why:** Resending after a timeout can create a duplicate message.
  - **Deliverable:** The pending/accepted/delivered/failed/unknown states and a manual reconciliation path.
  - **Verification:** Under success-before-ack and restart replay, the same effect ID is sent at most once.
  - **Prerequisites:** 034, 201.

- [ ] **203. Record the result after a reply as an outcome separate from the communication receipt.** — `P1`
  - **Why:** The fact that a message was delivered does not mean the goal was achieved or that it helped.
  - **Deliverable:** Separated links for delivery receipt, optional user outcome, and follow-up commitment.
  - **Verification:** A provider delivered event alone does not create a used outcome or a future send permission.
  - **Prerequisites:** 178, 202.

- [ ] **204. Close G16 with a wrong-recipient, duplicate, and injection red-team.** — `P0`
  - **Why:** Communication failures are hard to undo, so adversarial verification matters more than the happy journey.
  - **Deliverable:** An alias collision, account drift, attachment swap, prompt injection, and ambiguous-ack campaign.
  - **Verification:** 0 wrong recipients, 0 unapproved sends, 0 duplicate effects, evaluator PASS.
  - **Prerequisites:** 193–203.

---

## Phase 17 — Operate goals, projects, and execution as truth-preserving plans

**Entry condition:** G16 green and normal-chat Continuity retained.

**Exit gate G17:** Muse converts the user's goals into bounded plans and checkpoints and safely resumes
long work without guessing at actual completion and blockage.

- [ ] **205. Fix personal work/project state as a canonical domain separate from threads.** — `P1`
  - **Why:** Using the same ID for a conversation thread, a Continuity thread, and project execution state mixes authority and lifetime.
  - **Deliverable:** Explicit relations among project ID, goal, status, owner, source, and linked threads/tasks.
  - **Verification:** Deleting or completing a project does not implicitly change linked evidence and outcomes.
  - **Prerequisites:** 066, 180, 204.

- [ ] **206. Make goal decomposition a pre-execution draft.** — `P1`
  - **Why:** Executing model-generated subgoals directly as tasks or tool actions can expand scope.
  - **Deliverable:** Assumptions, subtasks, dependencies, unknowns, and an owner-editable plan.
  - **Verification:** Task creation and tool execution before confirm are 0.
  - **Prerequisites:** 170, 205.

- [ ] **207. Make acceptance criteria and kill conditions mandatory in a plan.** — `P1`
  - **Why:** A "just do it well" plan easily overstates completion and expands without end.
  - **Deliverable:** Measurable outcome, non-goals, stop/kill criteria, and evidence method.
  - **Verification:** A plan whose criteria are empty or contradictory is not transitioned into active execution.
  - **Prerequisites:** 007, 206.

- [ ] **208. Select the next action from exact dependencies and readiness.** — `P1`
  - **Why:** Prioritizing easy-looking work and skipping the real blocker means the project does not progress.
  - **Deliverable:** Ready/blocked reason, required authority, cost/risk, and one chosen action.
  - **Verification:** A task with an unmet dependency or a pending owner decision is not shown as runnable.
  - **Prerequisites:** 205–207.

- [ ] **209. Make blockers and decisions first-class states.** — `P1`
  - **Why:** Retrying a failure indefinitely, or auto-guessing a problem that needs a user decision, is not allowed.
  - **Deliverable:** Blocker type, evidence, owner question, retry eligibility, and a resolved-by receipt.
  - **Verification:** When the same blocker recurs with no new evidence, it terminates as no-progress.
  - **Prerequisites:** 208.

- [ ] **210. Bind the plan version and effect boundary to the execution checkpoint.** — `P0`
  - **Why:** Resuming an old checkpoint after a plan edit can execute an action that was already cancelled.
  - **Deliverable:** Plan digest, completed steps, pending effects, and resume compatibility.
  - **Verification:** It does not auto-resume under a plan mismatch, a corrupt checkpoint, or an ambiguous effect.
  - **Prerequisites:** 129, 207–209.

- [ ] **211. Make the session handoff a source-backed Continuity Pack.** — `P1`
  - **Why:** Trusting only a model summary when resuming long work can lose decisions and blockers.
  - **Deliverable:** Goal, verified progress, exact artifacts, decisions, blockers, and one next action.
  - **Verification:** Unsupported completion claims are excluded and the original source can be inspected.
  - **Prerequisites:** 064, 210.

- [ ] **212. Set tool, time, and cost budgets for every plan step.** — `P1`
  - **Why:** With only an overall run budget, one subtask can consume all resources.
  - **Deliverable:** Per-step attempt, wallclock, model, browser, and external-effect budgets.
  - **Verification:** Budget exhaustion produces an explicit terminal state and is not treated as success into the next step.
  - **Prerequisites:** 087–095, 207.

- [ ] **213. Compute the progress projection only from verified effects.** — `P0`
  - **Why:** What the agent said it "completed" and the actual file/task/API state can differ.
  - **Deliverable:** The planned, attempted, verified, blocked, and rolled-back states with evidence links.
  - **Verification:** Tool errors and unverifiable output do not raise the completed percentage.
  - **Prerequisites:** 208–212.

- [ ] **214. Place a review gate before irreversible and user-visible steps.** — `P0`
  - **Why:** A blanket approval obtained early in a long plan must not execute a later dangerous effect.
  - **Deliverable:** A just-in-time preview, exact target/effect, plan context, and approval expiry.
  - **Verification:** If the target or payload changes it requires re-approval, and finance/payments are permanently refused.
  - **Prerequisites:** 073, 200, 213.

- [ ] **215. Review the project outcome separately from the completion receipt.** — `P1`
  - **Why:** Even with every task closed, the user's actual goal may not have been achieved.
  - **Deliverable:** Verified deliverables, owner acceptance, adjusted/rejected outcome, and residual work.
  - **Verification:** Task count alone does not create project success or a playbook reward.
  - **Prerequisites:** 203, 213–214.

- [ ] **216. Close G17 with a multi-session real project audit.** — `P1`
  - **Why:** Short synthetic plans do not capture the realistic cost of long-term resume, drift, and owner decisions.
  - **Deliverable:** Two or more real projects spanning multiple dates, including failure and adjustment cases.
  - **Verification:** Completion truth, resume accuracy, duplicate effects, budget, and owner burden are independently evaluated.
  - **Prerequisites:** 205–215.

---

## Phase 18 — Operate self-learning and skills/playbooks proposal-first

**Entry condition:** G17 green, sufficient organic outcomes, and separate approval to lift the
self-learning hold.

**Exit gate G18:** Muse may create improvement proposals from experience, but does not change active
behavior without held-out verification, user review, and rollback.

- [ ] **217. Bind a learning candidate's source and purpose immutably.** — `P0`
  - **Why:** Without knowing from which experience and why a rule arose, wrong learning cannot be undone.
  - **Deliverable:** Source runs/outcomes, proposed behavior, scope, expected benefit, and expiry.
  - **Verification:** A candidate is not created from an unclassified receipt or a model self-critique alone.
  - **Prerequisites:** 127–128, 216.

- [ ] **218. Separate memory correction from procedural skill proposals.** — `P0`
  - **Why:** A factual correction such as "my name is…" must not change the tool-execution strategy.
  - **Deliverable:** Distinct pipelines for semantic fact, preference, prompt/playbook, and executable skill.
  - **Verification:** Each candidate uses a different permission, evaluation, and activation gate.
  - **Prerequisites:** 157–168, 217.

- [ ] **219. Generate skill diffs only in a quarantine filesystem.** — `P0`
  - **Why:** If code/instructions still being generated become visible on the active skill search path, behavior changes immediately.
  - **Deliverable:** An isolated candidate directory, manifest, requested tools/permissions, and a checksum.
  - **Verification:** During candidate build/test, the active skill registry and the runtime prompt digest do not change.
  - **Prerequisites:** 126–128, 218.

- [ ] **220. Auto-generate and review deterministic contract tests per skill.** — `P1`
  - **Why:** A natural-language skill with only success examples can operate on excessively broad input.
  - **Deliverable:** Positive, boundary, forbidden-effect, and malformed-input examples plus a grader.
  - **Verification:** Review whether the generated tests themselves weaken the source requirements and permission boundaries.
  - **Prerequisites:** 219.

- [ ] **221. Enforce a held-out regression set and baseline comparison.** — `P0`
  - **Why:** Overfit, where only the learned examples improve while general performance degrades, must be prevented.
  - **Deliverable:** An immutable split, a baseline artifact, and quality/safety/cost deltas.
  - **Verification:** If there is even one held-out safety regression, the activate gate closes.
  - **Prerequisites:** 220.

- [ ] **222. Connect playbook reward and decay to explicit outcomes only.** — `P1`
  - **Why:** Using completion or agent confidence as a reward reinforces wrong strategies.
  - **Deliverable:** Eligible outcomes, a lower-confidence bound, negative weight, and time decay.
  - **Verification:** Receipt-only records and controlled replay do not raise production ranking.
  - **Prerequisites:** 006, 215, 221.

- [ ] **223. Resolve competing skills and policy conflicts before activation.** — `P1`
  - **Why:** When different instructions apply to the same trigger, behavior becomes non-deterministic.
  - **Deliverable:** Trigger overlap, permission mismatch, a precedence proposal, and an owner decision.
  - **Verification:** A candidate with an unresolved conflict does not enter the active registry.
  - **Prerequisites:** 219–222.

- [ ] **224. Make activation, revoke, and rollback a versioned transaction.** — `P0`
  - **Why:** A partial activation or a failed rollback leaves the prompt and the tool registry inconsistent.
  - **Deliverable:** Active generation, atomic switch, previous version, health probe, and a rollback receipt.
  - **Verification:** Under a crash and under concurrent activation, exactly one generation is visible.
  - **Prerequisites:** 223.

- [ ] **225. Prevent user preferences from overriding safety/system policy.** — `P0`
  - **Why:** Learning a preference like "always send right away" can weaken the approval gate.
  - **Deliverable:** Policy precedence, non-learnable constraints, and a rejected-proposal reason.
  - **Verification:** An adversarial preference corpus cannot change the permission, send, payment, or retention guards.
  - **Prerequisites:** 073, 159, 224.

- [ ] **226. Treat imported/community skills as untrusted quarantine.** — `P0`
  - **Why:** An external skill can contain code, prompt injection, and hidden network effects.
  - **Deliverable:** Provenance, signature/checksum, a static permission scan, a sandbox test, and an explicit install preview.
  - **Verification:** Import alone causes no code execution, network access, or active registration.
  - **Prerequisites:** 125, 219–225.

- [ ] **227. Bind background curation to resource admission and the owner schedule.** — `P1`
  - **Why:** Self-improvement must not encroach on foreground work and privacy expectations.
  - **Deliverable:** An idle-only claim, model budget, candidate cap, pause/resume, and no-auto-activate.
  - **Verification:** Under resource pressure, owner pause, and hold states, model curation starts are 0.
  - **Prerequisites:** 085–096, 217–226.

- [ ] **228. Close G18 with a learning audit and a rollback drill.** — `P0`
  - **Why:** Beyond candidate quality, a wrongly activated behavior must be findable and reversible.
  - **Deliverable:** The source→candidate→tests→approval→activation→outcomes chain plus a revoke drill.
  - **Verification:** 0 silent activations, 0 held-out regressions, baseline digest restored after rollback, evaluator PASS.
  - **Prerequisites:** 217–227.

---

## Phase 19 — Use multi-agent only when it is better than a single agent

**Entry condition:** G18 green and a single-agent baseline exists per task family.

**Exit gate G19:** Decomposition, handoff, permission, budget, and cancellation are verified, and on the
selected task families multi-agent materially improves the held-out results over single-agent.

- [ ] **229. Fix a single-agent baseline for every multi-agent candidate task.** — `P0`
  - **Why:** Without a comparison basis, increasing the agent count looks like success even when only cost and complexity grow.
  - **Deliverable:** A baseline of outcome quality, pass^k, cost, latency, and tool/effect count.
  - **Verification:** Measured repeatedly with the same artifacts, rubric, budget, and held-out set.
  - **Prerequisites:** 131, 228.

- [ ] **230. Make the decomposition gate admit only genuinely independent subtasks.** — `P1`
  - **Why:** Parallelizing tightly coupled work produces divergent implicit decisions.
  - **Deliverable:** Judgements on shared state, ordering, context dependency, and mergeability.
  - **Verification:** Coupled fixtures remain a single-agent/serial plan and only independent fixtures fan out.
  - **Prerequisites:** 206–209, 229.

- [ ] **231. Minimize agent roles and writable scope.** — `P0`
  - **Why:** If every subagent has full filesystem and tool authority, the blast radius grows.
  - **Deliverable:** Role, inputs, allowed paths/tools/effects, output schema, and expiry.
  - **Verification:** Out-of-scope writes and tool calls are blocked at runtime and do not rely on an advisory prompt alone.
  - **Prerequisites:** 073, 230.

- [ ] **232. Constrain handoffs to typed artifacts with exact source links.** — `P1`
  - **Why:** A free-form summary can lose decisions, uncertainty, and provenance.
  - **Deliverable:** Goal, inputs, assumptions, decisions, artifacts, blockers, and a verification schema.
  - **Verification:** A handoff missing a required field or a source does not start downstream execution.
  - **Prerequisites:** 007, 211, 231.

- [ ] **233. Apply idempotency and causal ordering to the message bus.** — `P0`
  - **Why:** Retries and out-of-order delivery can execute a subtask twice or apply a stale decision.
  - **Deliverable:** Message ID, correlation/causation IDs, sequence, dedupe window, and terminal ack.
  - **Verification:** Under duplicate, delayed, reordered, and restart replay, an effect is reflected exactly once.
  - **Prerequisites:** 231–232.

- [ ] **234. Protect shared-state mutation with optimistic concurrency and a merge gate.** — `P0`
  - **Why:** Two agents overwriting the same file/store causes silent data corruption.
  - **Deliverable:** Base version, conflict result, an owner/lead merge decision, and atomic publish.
  - **Verification:** Concurrent incompatible edits are not automatically last-write-wins.
  - **Prerequisites:** 233.

- [ ] **235. Enforce token, time, tool, and effect budgets per subagent.** — `P1`
  - **Why:** One subagent can consume the whole orchestration budget or get stuck in a tool loop.
  - **Deliverable:** Per-agent and aggregate budgets, cancellation, and a budget-exhausted result.
  - **Verification:** A child budget overrun does not send siblings and the supervisor into unbounded cascading retries.
  - **Prerequisites:** 212, 233–234.

- [ ] **236. Prevent delegation from amplifying permissions.** — `P0`
  - **Why:** Authority the supervisor lacks must not be acquired by combining subagents.
  - **Deliverable:** Authority intersection, non-delegable effects, and approval ownership.
  - **Verification:** The union of the children's authority does not exceed the parent authority, and external sends retain the owner gate.
  - **Prerequisites:** 073, 214, 231–235.

- [ ] **237. Include cancellation and orphan subagents in resident health.** — `P0`
  - **Why:** If a child keeps executing tools after the supervisor exits, it becomes an invisible background effect.
  - **Deliverable:** Process/task ownership, cooperative abort, lease expiry, and orphan fencing.
  - **Verification:** After a supervisor crash and a user cancel, new child effects are 0 and late results are discarded.
  - **Prerequisites:** 016, 091, 235–236.

- [ ] **238. Separate the evaluator from the maker agent in context and authority.** — `P0`
  - **Why:** When the same agent grades its own output, self-preference and shared assumptions remain.
  - **Deliverable:** A read-only evaluator role, artifact-only input, a fixed rubric, and an independent trace.
  - **Verification:** The evaluator reproduces without the maker's scratch/context and has no write/effect tools.
  - **Prerequisites:** 008, 232, 237.

- [ ] **239. Open remote/hosted subagents only when they pass an owner-controlled egress threat model.** — `P2`
  - **Why:** Source and personal data can move to an external sandbox.
  - **Deliverable:** Data classification, an upload manifest, secrets exclusion, retention/deletion, and explicit opt-in.
  - **Verification:** On a local-only profile remote dispatch is 0, and no file outside the approved subset is transmitted.
  - **Prerequisites:** 073–084, 236–238.

- [ ] **240. Close G19 with a held-out multi-agent benchmark.** — `P1`
  - **Why:** Even with a safe architecture, there is no default-use value if the outcome is no better than single-agent.
  - **Deliverable:** A paired baseline per task family, quality/cost/latency/failure deltas, and an adopt/reject decision.
  - **Verification:** Families without strict pass^k and material improvement keep single-agent as the default.
  - **Prerequisites:** 229–239.

---

## Phase 20 — Operate provider/model quality, fallback, and cost under one contract

**Entry condition:** G19 green and the canonical agent contract retained independently of whether
multi-agent is in use.

**Exit gate G20:** The same safety, grounding, and message-integrity floor is retained across provider
changes, fallback, compaction, streaming, structured output, and multimodal input, and cost/performance
choices are reproducible.

- [ ] **241. Bind the provider capability registry to runtime probes and versions.** — `P1`
  - **Why:** Documented support and an actual endpoint's tool/stream/schema/context support can differ.
  - **Deliverable:** Model ID, provider, capabilities, limits, probe time, source, and unknown fields.
  - **Verification:** A probe failure is distinguished from unsupported, and stale capabilities are not used for routing.
  - **Prerequisites:** 093–094, 240.

- [ ] **242. Make task-model routing an explicit policy with an owner override.** — `P1`
  - **Why:** Automatic model selection can silently change data egress, cost, latency, and tool support.
  - **Deliverable:** Task requirements, allowed providers, the local/cloud boundary, rationale, and override.
  - **Verification:** On a local-only profile a cloud model is not selected, and an unsupported capability fails close.
  - **Prerequisites:** 099–100, 241.

- [ ] **243. Constrain fallback to the error taxonomy and effect boundaries.** — `P0`
  - **Why:** A model fallback after a tool effect that re-runs the whole turn can produce duplicate actions.
  - **Deliverable:** Retryable/non-retryable/ambiguous errors, a safe replay boundary, and a fallback budget.
  - **Verification:** The effect-before-error fixture does not re-run the previous tool call and continues from the checkpoint.
  - **Prerequisites:** 034, 210, 242.

- [ ] **244. Isolate provider credential rotation and auth-profile fallback.** — `P0`
  - **Why:** Automatically switching to a different account's credential can change cost, data, and organizational boundaries.
  - **Deliverable:** Profile identity, allowed scope, expiry, explicit rotation, and redacted health.
  - **Verification:** 0 unauthorized profile fallbacks, 0 secrets in logs/trace, and a revoked profile blocked immediately.
  - **Prerequisites:** 077, 100, 243.

- [ ] **245. Strengthen context compaction with a decision, authority, and tool-pair preservation contract.** — `P0`
  - **Why:** If approval scope or a tool result is dropped during long-session compaction, wrong re-execution occurs.
  - **Deliverable:** Preserved decisions, source refs, pending effects, message pairs, and uncertainty.
  - **Verification:** In an adversarial long run there is no approval expansion, orphan tool result, or lost correction.
  - **Prerequisites:** 210–213, 241.

- [ ] **246. Measure and invalidate the prompt-prefix cache per provider.** — `P1`
  - **Why:** If cache optimization reuses a stale policy or skill generation, safety breaks.
  - **Deliverable:** Prefix digest, policy/skill/model version, hit evidence, and invalidation rules.
  - **Verification:** After a policy, permission, or skill change the old cache is not used, and the warm-latency gain is reproducible.
  - **Prerequisites:** 094, 224, 245.

- [ ] **247. Make structured-output repair schema-safe and bounded.** — `P0`
  - **Why:** JSON repair can guess at meaning or bypass validation.
  - **Deliverable:** A parse/validate/repair attempt budget, an original/repair trace, and a terminal schema error.
  - **Verification:** Malformed security decisions and tool arguments are not repaired into guessed success.
  - **Prerequisites:** 241–246.

- [ ] **248. Verify streaming tool-call assembly and message repair provider-neutrally.** — `P0`
  - **Why:** Chunk order, duplicate deltas, and partial arguments can break message-pair integrity.
  - **Deliverable:** A stream state machine, call identity, and partial/cancel/error terminal states.
  - **Verification:** Invalid tool executions are 0 on a reordered/duplicated/truncated stream corpus.
  - **Prerequisites:** 247.

- [ ] **249. Unify provenance and budget for image, audio, and document input.** — `P1`
  - **Why:** A multimodal attachment can bypass the context budget and the privacy boundary.
  - **Deliverable:** Source hash, type, size/token estimate, egress policy, and extraction confidence.
  - **Verification:** Unknown size, unsupported type, hidden metadata, and a private attachment are handled before dispatch.
  - **Prerequisites:** 183, 197, 241–248.

- [ ] **250. Qualify the fully offline local-model path per feature and quality.** — `P1`
  - **Why:** Even with a local adapter present, a cloud fallback can remain in memory, tools, embedding, or voice.
  - **Deliverable:** A blocked-network run, model/embedding/STT/TTS dependencies, and unavailable-feature disclosure.
  - **Verification:** In a network-denied environment hidden egress is 0 and the supported journeys pass the terminal grader.
  - **Prerequisites:** 099, 242, 249.

- [ ] **251. Produce a quality, latency, cost, and privacy Pareto report per task family.** — `P2`
  - **Why:** Instead of one "best model", each personal task has a different tradeoff.
  - **Deliverable:** Fixed task sets, pass^k, median/p95, estimated/actual cost, and egress class.
  - **Verification:** Unknown prices and failed runs are not excluded, and the owner can reproduce the routing policy.
  - **Prerequisites:** 241–250.

- [ ] **252. Close G20 with a cross-provider qualification.** — `P0`
  - **Why:** Green unit tests per adapter do not prove preservation of the whole agent contract.
  - **Deliverable:** A supported provider/model matrix with capability-specific PASS/FAIL/UNAVAILABLE.
  - **Verification:** The safety, grounding, tool-integrity, compaction, and cancellation floors are retained on every advertised path.
  - **Prerequisites:** 241–251.

---

## Phase 21 — Connect macOS, Windows, Linux, mobile, and voice capability-aware

**Entry condition:** G20 green and each platform's privacy/permission model documented.

**Exit gate G21:** Capabilities a platform or device does not support are not guessed at, and pairing,
voice, and handoff operate within explicit authority and capability descriptors.

- [ ] **253. Build the cross-platform runtime contract and its differences as a single matrix.** — `P1`
  - **Why:** launchd and permission behavior verified on macOS must not be claimed as-is for Windows/Linux.
  - **Deliverable:** A capability matrix for service, filesystem, secrets, notifications, thermal, sandbox, and browser.
  - **Verification:** Unsupported/unknown is not marked as safe success and is linked to platform-specific tests.
  - **Prerequisites:** 024, 080, 086, 252.

- [ ] **254. Implement and verify the artifact/runtime truth of the Windows resident service.** — `P1`
  - **Why:** The existing limitation that registration alone cannot prove a live runtime must be closed.
  - **Deliverable:** Stable entrypoint, service identity, PID/heartbeat, single writer, and a repair plan.
  - **Verification:** The register-only, stale process, duplicate, restart, and update scenarios have the same semantics as G1.
  - **Prerequisites:** 013–024, 253.

- [ ] **255. Implement and verify the systemd/user-session boundary of the Linux service.** — `P2`
  - **Why:** Confusing system and user services, and headless environment differences, can change credential and notification scope.
  - **Deliverable:** The supported unit model, a stable path, an environment allowlist, and health/repair.
  - **Verification:** There is no hidden duplicate resident under logout, reboot, a missing display, or a stale unit.
  - **Prerequisites:** 013–024, 253.

- [ ] **256. Close the single-state contract between the macOS desktop app and the CLI/daemon.** — `P1`
  - **Why:** If the app, menu bar, and CLI create separate settings and residents, the user cannot know the real state.
  - **Deliverable:** Shared runtime settings, health, deep links, one repair path, and window restoration.
  - **Verification:** Running the app and CLI concurrently and updating do not create two resident writers or conflicting settings.
  - **Prerequisites:** 024, 098, 145, 253.

- [ ] **257. Constrain the mobile companion to a read/review-first minimal surface.** — `P2`
  - **Why:** Replicating every tool execution and setting on a small screen increases permission errors and UX complexity.
  - **Deliverable:** Status, Pack review, draft approve/reject, and explicit limited actions.
  - **Verification:** Mobile alone cannot create a new broad permission, self-learning activation, or financial effect.
  - **Prerequisites:** 104, 120, 200, 253.

- [ ] **258. Protect device pairing with mutual verification and revoke.** — `P0`
  - **Why:** A stolen pairing code or a stale device can access personal data and approvals.
  - **Deliverable:** A short-lived challenge, device identity, owner confirmation, capability grant, and revoke.
  - **Verification:** A replay, an expired challenge, a cloned identity, and a revoked device cannot create a session.
  - **Prerequisites:** 073–084, 257.

- [ ] **259. Make the capability descriptor handshake versioned and fail-close.** — `P0`
  - **Why:** If the server assumes an action the device does not support is possible, a wrong fallback occurs.
  - **Deliverable:** Supported actions/data classes, versions, limits, and unavailable reasons.
  - **Verification:** An unknown future capability and a version mismatch do not lead to an automatic downgrade effect.
  - **Prerequisites:** 241, 253–258.

- [ ] **260. Constrain clipboard and file handoff to a one-shot explicit transfer.** — `P0`
  - **Why:** Continuous synchronization of the clipboard and nearby files becomes a sensitive-information leak path.
  - **Deliverable:** Selected payload, source/destination device, preview, expiry, and a transfer receipt.
  - **Verification:** 0 background clipboard scraping, revalidation of symlink/file mutation, and 0 transfers after revoke.
  - **Prerequisites:** 187, 258–259.

- [ ] **261. Start voice input with push-to-talk and a visible listening state.** — `P1`
  - **Why:** Always-listening carries a large privacy and false-trigger cost in a personal environment.
  - **Deliverable:** Explicit start/stop, a live indicator, a local buffer, and cancel-before-send.
  - **Verification:** Audio capture is 0 while the indicator is off, and a cancelled utterance does not reach the model or memory.
  - **Prerequisites:** 099, 253.

- [ ] **262. Make the STT/TTS provider and audio retention an explicit choice.** — `P0`
  - **Why:** The user must know whether voice data has cloud egress and whether it is stored.
  - **Deliverable:** Local/cloud provider, transcript/audio retention, an egress preview, and a forget action.
  - **Verification:** On a local-only profile cloud audio requests are 0 and raw audio is not persisted by default.
  - **Prerequisites:** 241–252, 261.

- [ ] **263. Handle voice interruption, barge-in, and accessibility as terminal states.** — `P1`
  - **Why:** If a tool effect keeps progressing when speech is cut off or recognition is uncertain, it is dangerous.
  - **Deliverable:** The listening/thinking/speaking/cancelled/needs-confirmation states plus accessible alternatives.
  - **Verification:** Under barge-in and a low-confidence command, external/tool effects do not execute without confirmation.
  - **Prerequisites:** 261–262.

- [ ] **264. Close G21 with a cross-device real journey audit.** — `P1`
  - **Why:** Pairing and individual feature tests alone cannot prove real continuity handoff.
  - **Deliverable:** The desktop→mobile review, mobile revoke, voice draft, and offline fallback journeys.
  - **Verification:** 0 wrong-device disclosures, 0 unauthorized effects, 0 capability drift, evaluator PASS.
  - **Prerequisites:** 253–263.

---

## Phase 22 — Continuous evaluation, fault injection, drift canary

**Entry condition:** G21 green and the advertised surfaces and providers settled.

**Exit gate G22:** A versioned evaluation system that grades outcomes and paths detects model, provider,
platform, and release drift, and synthetic results are not mistaken for organic value.

- [ ] **265. Compose the golden journey catalog from real personal failure families.** — `P0`
  - **Why:** Convenient synthetic prompts alone do not catch corrected memory, wrong recipients, and a stale daemon.
  - **Deliverable:** A journey set for runtime, memory, Continuity, browser, communication, project, and device.
  - **Verification:** Each journey is linked to an observed failure or an explicit high-risk contract.
  - **Prerequisites:** 142, 156, 168, 180, 192, 204, 216, 264.

- [ ] **266. Make the terminal-state grader outcome-first.** — `P0`
  - **Why:** Even when the assistant's wording is plausible, the actual effect and store state can be wrong.
  - **Deliverable:** A grader over final state, artifact digest, external effects, abstention, and owner-visible result.
  - **Verification:** A fixture that says "done" in words but has no effect is judged as a failure.
  - **Prerequisites:** 265.

- [ ] **267. Add trace invariants only where ordering is a contract.** — `P1`
  - **Why:** Pinning every internal step blocks implementation improvement and produces a brittle eval.
  - **Deliverable:** Minimal invariants such as approval-before-send, guard-before-tool, and checkpoint-before-resume.
  - **Verification:** An outcome-equivalent refactor passes and only safety-ordering violations fail.
  - **Prerequisites:** 266.

- [ ] **268. Complete the fault injection catalog per I/O boundary.** — `P0`
  - **Why:** Network timeouts, disk full, process death, clock shift, and corrupt data are rare in normal tests.
  - **Deliverable:** Model, store, browser, process, channel, device, and scheduler fault controls.
  - **Verification:** Every critical boundary has a deterministic failure and an expected terminal state.
  - **Prerequisites:** 265–267.

- [ ] **269. Apply mutation testing to the core reducers and guards.** — `P1`
  - **Why:** It must be confirmed that green tests actually catch a wrong policy change.
  - **Deliverable:** Selected safety/attunement/recall/runtime mutations and a killed/survived report.
  - **Verification:** Known off-by-one, inverted guard, missing freshness, and duplicate-effect mutations are all caught.
  - **Prerequisites:** 268.

- [ ] **270. Apply strict pass^k and seed accounting to non-deterministic journeys.** — `P0`
  - **Why:** Even with a high average success rate, trust breaks when the user fails once on an important task.
  - **Deliverable:** Required k, seeds/models, the all-pass rule, and abort/missing semantics.
  - **Verification:** A single fail, skip, or unverified cannot turn the strict gate green.
  - **Prerequisites:** 265–269.

- [ ] **271. Detect eval pollution and train/test leakage.** — `P0`
  - **Why:** If golden answers enter the prompt, memory, or a generated skill, performance rises falsely.
  - **Deliverable:** Dataset fingerprints, runtime isolation, memory reset, and a skill registry snapshot.
  - **Verification:** Seeded leakage is found in preflight and blocks publication of the canonical report.
  - **Prerequisites:** 217–228, 265–270.

- [ ] **272. Compare the model/provider/release drift canary versioned.** — `P1`
  - **Why:** The same model name and API can change behavior over time.
  - **Deliverable:** Baseline artifact, current result, material delta, and an auto-hold threshold.
  - **Verification:** A known changed fixture is detected before rollout and does not rewrite organic history.
  - **Prerequisites:** 241–252, 270–271.

- [ ] **273. Maintain the security regression corpus as real exploit families.** — `P0`
  - **Why:** Generic injection sentences alone cannot protect new tool, channel, and device boundaries.
  - **Deliverable:** Injection, SSRF, path escape, wrong-recipient, permission amplification, and secret-leak cases.
  - **Verification:** A new capability cannot pass the advertised security gate without a corresponding corpus case.
  - **Prerequisites:** 082–084, 204, 236, 258, 272.

- [ ] **274. Physically separate the technical, controlled, and organic evidence dashboards.** — `P0`
  - **Why:** The visual confusion that makes many synthetic passes look like real personal value must be prevented.
  - **Deliverable:** Separate panels/stores, immutable origin, denominators, and promotion-disabled labels.
  - **Verification:** A synthetic-only dataset does not render an organic graph, percentage, or autonomy status.
  - **Prerequisites:** 004–006, 142, 265–273.

- [ ] **275. Put time, model, and compute budgets on the evaluation itself.** — `P1`
  - **Why:** While continuously verifying a 300-item roadmap, the evaluator can disturb the everyday runtime.
  - **Deliverable:** Change-tier selection, a preflight estimate, resource admission, cancel/resume, and a partial-unverified result.
  - **Verification:** When the budget is short it does not silently skip an axis; it leaves the canonical report unverified.
  - **Prerequisites:** 085–096, 265–274.

- [ ] **276. Close G22 with a quarterly full qualification.** — `P1`
  - **Why:** Individual release gates alone can miss long-term model, platform, and personal-data drift.
  - **Deliverable:** A versioned full battery, the previous delta, open blockers, and claims allowed/withdrawn.
  - **Verification:** An independent evaluator judges PASS/FAIL from fresh source/artifact/live evidence.
  - **Prerequisites:** 265–275.

---

## Phase 23 — Open the plugin ecosystem and external contribution permission-first

**Entry condition:** G22 green and the core capability/security contracts versioned.

**Exit gate G23:** Plugins and external contributions disclose capability, permission, and provenance
before installation, and pass compatibility verification without bypassing the core safety floor and
user data.

- [ ] **277. Make identity, version, capability, and permission mandatory in the plugin manifest.** — `P0`
  - **Why:** A plugin with only a name and code gives no way to know which data and effects it requires.
  - **Deliverable:** Optional signed identity, entrypoints, tools/skills/apps, requested permissions, data egress, and compatibility.
  - **Verification:** An unknown field/version, an undeclared entrypoint, and a missing permission block the install preflight.
  - **Prerequisites:** 073, 125, 252, 276.

- [ ] **278. Build a revoke/uninstall lifecycle instead of plugin install, upgrade, and disable.** — `P0`
  - **Why:** A plain disabled state leaves it unclear whether code, data, credentials, and background processes remain.
  - **Deliverable:** An exact diff preview, explicit install, a versioned grant, revoke, a data-retention choice, and an uninstall receipt.
  - **Verification:** Tool/effect authority disappears immediately on revoke, and uninstall does not delete user data by default.
  - **Prerequisites:** 277.

- [ ] **279. Bind plugin execution to the declared scope and the sandbox policy.** — `P0`
  - **Why:** Even if the core is safe, the boundary is bypassed when a plugin uses shell/network/filesystem directly.
  - **Deliverable:** Per-plugin safe roots, a network allowlist, secret handles, process limits, and audit events.
  - **Verification:** Undeclared read/write/network/process access and symlink/path escape are blocked at runtime.
  - **Prerequisites:** 080–081, 277–278.

- [ ] **280. Provide a plugin compatibility matrix and a contract suite.** — `P1`
  - **Why:** If a Muse API change silently breaks a plugin, the user store and effects can be corrupted.
  - **Deliverable:** Supported core versions, tool schema tests, lifecycle tests, and migration checks.
  - **Verification:** An incompatible plugin does not load and provides an exact reason and an upgrade/rollback path.
  - **Prerequisites:** 277–279.

- [ ] **281. Manage the public SDK/API with semver and a deprecation window.** — `P1`
  - **Why:** Exposing the internal package structure as-is as the ecosystem contract makes safe change difficult.
  - **Deliverable:** Minimal stable interfaces, a compatibility policy, deprecation telemetry, and a removal gate.
  - **Verification:** A breaking fixture is detected in CI, and usage/alternatives are confirmed before removing a deprecated path.
  - **Prerequisites:** 137, 280.

- [ ] **282. Verify the minimum contract with three reference plugins.** — `P2`
  - **Why:** It is hard to verify the differences between a notes-like local, a read-only remote, and a draft-effect plugin from documentation alone.
  - **Deliverable:** Local read/write, remote read-only, and draft-first effect examples plus tests.
  - **Verification:** The reference plugins use only the public SDK, with no privileged internal imports.
  - **Prerequisites:** 277–281.

- [ ] **283. Write the plugin developer quickstart together with a threat model.** — `P1`
  - **Why:** Providing only a "Hello world" makes developers miss the permission and untrusted-output boundaries.
  - **Deliverable:** Scaffold, manifest, tests, permission rationale, safe storage, and a publish checklist.
  - **Verification:** In a new checkout, the quickstart plugin reproduces through build/test/install-preview.
  - **Prerequisites:** 282.

- [ ] **284. Integrate the plugin doctor and support bundle into core diagnostics.** — `P1`
  - **Why:** A plugin failure must not be mistaken for a core crash, and the whole personal data set must not be shared.
  - **Deliverable:** Loaded version, health, denied capability, crash count, redacted logs, and an isolate action.
  - **Verification:** Plugin diagnostics contain no secret/user content, and only the unhealthy plugin can be isolated.
  - **Prerequisites:** 150, 278–283.

- [ ] **285. Constrain importing external configuration such as OpenClaw and Hermes to a preview-only migration.** — `P2`
  - **Why:** Importing a competitor's broad permissions and channel settings as-is can weaken Muse's policy.
  - **Deliverable:** The supported subset, source provenance, permission remap, skipped/unsafe items, and explicit apply.
  - **Verification:** Import alone causes no credential copy, external send, skill activation, or daemon start.
  - **Prerequisites:** 121, 226, 277–284.

- [ ] **286. Build the security disclosure and vulnerable-plugin response procedure.** — `P0`
  - **Why:** In an external code ecosystem, receiving a vulnerability report, isolating it, and notifying the user can be delayed.
  - **Deliverable:** A private report channel, severity, an affected-version query, revoke/advisory, and a patch SLA.
  - **Verification:** Drill it end to end: identify a simulated vulnerable plugin, block installation, and guide revocation of existing installs.
  - **Prerequisites:** 147, 273, 277–285.

- [ ] **287. Apply test, license, provenance, and review gates to external contributions.** — `P1`
  - **Why:** A feature contribution can bring supply-chain, license, and personal-information fixture risk.
  - **Deliverable:** A contributor checklist, required tests, a DCO/license policy, and a generated-code/source declaration.
  - **Verification:** Missing provenance, forbidden fixture data, and a bypassed hook do not pass the merge gate.
  - **Prerequisites:** 139, 265–276, 281–286.

- [ ] **288. Close G23 with a bounded ecosystem pilot.** — `P1`
  - **Why:** Reference plugins alone cannot prove the real third-party development experience and permission comprehension.
  - **Deliverable:** A small number of pilot plugins, install/revoke journeys, developer feedback, incidents, and adopt/hold decisions.
  - **Verification:** 0 undeclared effects, 0 core regressions, revoke completeness PASS, evaluator review.
  - **Prerequisites:** 277–287.

---

## Phase 24 — An operating loop that continuously reassesses value, safety, and complexity

**Entry condition:** G23 green and the current/stale status of roadmap 001–288 distinguished.

**Exit gate G24:** Muse's next cycle is approved on the basis of organic value, failure evidence,
security, and maintenance cost, and features without value are held, reduced, or deleted rather than
added to.

- [ ] **289. Run the north-star value review every quarter.** — `P1`
  - **Why:** Growth in features, tests, and commits does not mean growth in actual personal help.
  - **Deliverable:** Time-to-resume, exact answer success, correction burden, unwanted interruption, and an owner trust review.
  - **Verification:** Denominator, dates, negative outcomes, and missing data are present, and technical activity is separated out.
  - **Prerequisites:** 142, 276, 288.

- [ ] **290. Sort the weekly failure triage by severity and recurrence.** — `P1`
  - **Why:** New feature ideas must be prevented from being selected ahead of recurring failures.
  - **Deliverable:** Current incidents, repeated faults, user friction, evidence gaps, and the next narrow slice.
  - **Verification:** Unrelated expansion is not selected as active WIP while a high-risk recurrent failure is open.
  - **Prerequisites:** 147, 155, 289.

- [ ] **291. Perform a monthly memory, privacy, and permission audit.** — `P0`
  - **Why:** Long-term personalization carries the risk of data and authority quietly accumulating.
  - **Deliverable:** Store growth, stale facts, unresolved conflicts, active grants, revoked remnants, and retention actions.
  - **Verification:** Viewing the audit changes nothing, and delete/revoke require an exact preview and a separate authority.
  - **Prerequisites:** 073–084, 157–168, 258, 278, 289.

- [ ] **292. Reassess the quarterly competitor delta through the Muse fit lens.** — `P3`
  - **Why:** New OpenClaw and Hermes features must be connected to real user problems, not reflexively copied.
  - **Deliverable:** Official change, user need, Muse edge, security/maintenance cost, and adopt/reject/defer.
  - **Verification:** A parity item without an owner problem and a measurable gate does not enter the active roadmap.
  - **Prerequisites:** 132, 289.

- [ ] **293. Regularly verify retention, export, and forget completeness.** — `P0`
  - **Why:** A new store, plugin, or device can fall outside the forget/export scope.
  - **Deliverable:** A data inventory, export coverage, delete/tombstone semantics, and backups/derived-index handling.
  - **Verification:** A seeded identity disappears per policy from the active, archive, index, cache, device, and plugin stores.
  - **Prerequisites:** 076, 112, 165, 260, 278, 291.

- [ ] **294. Operate a dependency, secret, and supply-chain maintenance cycle.** — `P0`
  - **Why:** A long-lived resident agent remains continuously exposed to dependency vulnerabilities and credential drift.
  - **Deliverable:** Version updates, vulnerability triage, credential expiry, SBOM delta, and a rollback plan.
  - **Verification:** An unresolved high/critical finding blocks release/update, and automated updates also pass the full gate.
  - **Prerequisites:** 139, 244, 286, 293.

- [ ] **295. Keep accessibility and localization regressions on the core journeys.** — `P1`
  - **Why:** New surfaces and wording can break keyboard, screen reader, and locale safety semantics.
  - **Deliverable:** A supported locale/a11y matrix, golden screenshots where useful, and semantic journey tests.
  - **Verification:** The meanings of permission/held/unverified are the same per locale and the keyboard-only path keeps passing.
  - **Prerequisites:** 106–107, 256–264, 288.

- [ ] **296. Compare the latency, memory, and cost budget trends per release.** — `P1`
  - **Why:** As features accumulate, first response and resident resources can gradually degrade.
  - **Deliverable:** A fixed hardware/profile baseline, median/p95, RSS/CPU, model cost, and a material-regression threshold.
  - **Verification:** Environment, model, and cache differences are stated, and exceeding the threshold holds the release gate.
  - **Prerequisites:** 088–096, 146, 251, 294.

- [ ] **297. Regularly prune features, rules, and adapters that carry no load.** — `P1`
  - **Why:** A 300-item roadmap must not become a justification for preserving complexity forever.
  - **Deliverable:** Usage/evidence, safety load, maintenance cost, and a migration/removal proposal.
  - **Verification:** Nothing is deleted before active dependencies and user-data export are confirmed, and there is no dead path after removal.
  - **Prerequisites:** 289–296.

- [ ] **298. Select exactly one organic experiment for the next 30 days.** — `P1`
  - **Why:** Opening several product hypotheses at once makes it impossible to tell which change created value.
  - **Deliverable:** Hypothesis, target journey, baseline, success/kill criteria, safety hold, and an evidence plan.
  - **Verification:** Behavior/permissions outside the experiment are retained, and a bad result does not auto-expand.
  - **Prerequisites:** 289–297.

- [ ] **299. Rebind the recurring release-readiness to the current HEAD and evidence.** — `P0`
  - **Why:** The first release's PASS does not guarantee the next cycle's code, model, data, and plugin state.
  - **Deliverable:** An aggregate of G0–G23 freshness, source/artifact hash, experiment outcome, and unresolved blockers.
  - **Verification:** If even one gate is failed/unverified/stale, it blocks release and autonomy expansion.
  - **Prerequisites:** 276, 288, 298.

- [ ] **300. Update the roadmap with evidence and approve the next cycle.** — `P1`
  - **Why:** Number 300 is not the end of development; it is the point where completions, rejections, and new failures are reflected to make the next goals smaller and more exact.
  - **Deliverable:** A completed/removed/deferred summary, remaining blockers, and the next numbered successor roadmap or a termination decision.
  - **Verification:** Record-only changes are consolidated under the batch rules, and a new task is added only when it has an owner problem, acceptance, and a gate.
  - **Prerequisites:** 289–299 and the owner's next-cycle decision.

---

## Phase exit gate summary

| Gate | State that must be true | Next action forbidden on failure |
| --- | --- | --- |
| G0 | Provenance and evidence accounting reproducible | Starting implementation |
| G1 | Exactly one resident writer, fresh heartbeat, pass^3 | Activating delivery |
| G2 | local-only/lock/brake/hold agree, 0 unapproved sends | Expanding backlog/automatic sending |
| G3 | Browser/CLI/API/Web terminal reliability pass^3 | Personal journey claims |
| G4 | Capability 11/11 strict pass^3 | personal-agent qualification claim |
| G5 | Multi-date life/work organic Continuity audit PASS | Proactive timing |
| G6 | Privacy/security adversarial review PASS | Expanding MCP/channel/tool authority |
| G7 | 24h resource soak PASS | Expanding background autonomy |
| G8 | Clean onboarding 10-minute journey pass^3 | Broad acquisition/public claims |
| G9 | Shadow and owner-reviewed cohort PASS | Ongoing autonomous delivery |
| G10 | Expansion retains Muse positioning and safety | Adding features for parity's sake |
| G11 | HEAD-bound release readiness PASS | Tag, artifact publication, release |
| G12 | Installed release incident/rollback drill PASS | The next update rollout |
| G13 | Temporal/conflicting/forgotten memory audit PASS | Expanding long-term personalization |
| G14 | Personal-domain multi-date organic audit PASS | Expanding life automation |
| G15 | Browser/computer critical journey strict pass^k | Broader computer action |
| G16 | Wrong-recipient, duplicate, and injection communication audit PASS | Expanding the communication surface |
| G17 | Multi-session project truth/resume audit PASS | Expanding long-running autonomous execution |
| G18 | Proposal-first learning and rollback audit PASS | Expanding self-learning activation |
| G19 | Multi-agent materially improves on the paired baseline | Making multi-agent the default |
| G20 | Cross-provider agent contract qualification PASS | Expanding automatic provider routing |
| G21 | Cross-device privacy/capability audit PASS | Expanding device/voice authority |
| G22 | Versioned full evaluation and drift canary PASS | Expanding claims and releases |
| G23 | Plugin permission/revoke ecosystem pilot PASS | Expanding the public ecosystem |
| G24 | Next cycle approved on value, risk, and maintenance grounds | Successor roadmap and release cycle |

## Per-slice closing checklist

- [ ] Acceptance criteria and out-of-scope were fixed before implementation.
- [ ] The exact affected tests and the boundary tests were run.
- [ ] The affected boundaries among failure, cancellation, retry, stale, and corrupt were verified.
- [ ] A before/after digest of the store/effect, or an explicit receipt, was left behind.
- [ ] Controlled, synthetic, and organic evidence were not mixed.
- [ ] User-facing wording is no stronger than the current evidence.
- [ ] A separate evaluator recorded PASS/FAIL per acceptance criterion.
- [ ] `pnpm test:changed` and the corresponding typecheck passed.
- [ ] For a source/behavior change, the per-task commit+push completed without skipping the pre-push hook.
- [ ] For a record-only change, no per-task commit was made and the next batch checkpoint was stated.
- [ ] WIP returned to 0 before opening the next slice.

## Conditions for closing the current 300-task cycle

All of the following must be satisfied before this roadmap cycle can be closed and Muse can be called
a "continuously verified personal AI agent". Task 300 is not the permanent end of product development
but a checkpoint that redesigns the next cycle from evidence.

1. G0–G24 are all fresh green in the current scope, or any explicitly rejected/de-scoped gate has an
   owner decision and evidence of removal with no user impact.
2. Resident and delivery safety are retained across multiple restarts and runs of 24 hours or more.
3. The 11-axis capability, including corrected-fact recall, is at strict pass^3.
4. Life/work Continuity has been independently audited with organic outcomes and exact receipts across multiple dates.
5. Observe and timing do not operate outside the scope the owner approved.
6. The journey from installation to the first source-backed value within 10 minutes is at pass^3.
7. External sends, deletion, and permission expansion have a draft/preview and explicit authority.
8. The release artifact, source commit, documentation, package metadata, and provenance all point at one version.
9. Even with fewer features than OpenClaw and Hermes, Muse's three proofs actually hold:
   exact personal grounding, explicit outcome adaptation, no silent permission expansion.
10. Long-term memory, personal domains, browser/computer, communication, and project execution retain exact source and
    permission boundaries.
11. Self-learning and multi-agent are not promoted to the default path without held-out baseline improvement.
12. Plugin, device, and provider expansions have revoke, rollback, and unavailable semantics.
13. When organic evidence is insufficient or poor, a held/reject/kill decision can be made instead of opening more features.
14. Record-only changes are batched and only source/behavior changes follow the per-task verification, commit, and push rules.
15. At Task 300, the next cycle's goals or the termination decision are re-approved by the owner.
