---
title: Muse personal-agent Core 100 roadmap
audience: [owner, product, engineering, evaluation]
purpose: Finish the smallest essential remaining program for a trusted daily provider-neutral personal AI agent
status: active-authoritative
updated: 2026-07-28
reconciledSourceHead: d693cea6fb1b6bf4889fa99dd38d9e5e0ae04642
supersedesForActivation:
  - personal-agent-productization-roadmap.md
related:
  - ../../docs/strategy/attunement.md
  - ../../docs/development/personal-agent-qualification.md
  - ../../docs/development/ai-agent-testing-strategy.md
  - ../../.claude/harness/contract.md
---

# Muse personal-agent Core 100 roadmap

## Purpose

This document is the authoritative execution document that re-selects, from the existing
300-task program, **excluding work already implemented and verified in the current source**, only
the essential remaining work as 100 execution slices for Muse to become a trusted,
provider-neutral personal AI agent in one user's real daily life.

The product's success statement stays the same.

> Muse connects one user's life and work with exact sources, learns explicitly whether it helped,
> and runs reliably every day without covertly expanding its authority.

The existing
[`personal-agent-productization-roadmap.md`](personal-agent-productization-roadmap.md) remains as
a reference document for looking up requirement history and legacy IDs. This document takes
priority for new task activation and next-task selection.

## Current source reconciliation

This list was built against the source at `d693cea6fb1b6bf4889fa99dd38d9e5e0ae04642` and fresh
evaluator results. The following are not reimplemented in the new 100.

- the closed baseline, resident runtime, delivery brake, terminal reliability, corrected-fact
  recall, and owner memory inspect/correct/forget/undo contracts from legacy Task 001–058
- the CLI actuator authority classification and `muse doctor`'s explicit permission repair surface
- the exact-file, `O_NOFOLLOW`, mode-drift, and symlink/out-of-scope rejection contracts that
  `planSensitivePermissionRepair` and `applySensitivePermissionRepair` already provide
- current substrate such as generic draft-first, untrusted tool output, provider adapters, and the
  local personal store
- the 990-minute worst-case monolithic capability run of legacy Task 059–060

legacy 059–060 is not a quality-bar drop — it is replaced by the bounded, cacheable shard contract
in 004–010 of this document. Rather than repeating the CLI permission implementation, 011–020
cover only the remaining independent closure, cross-surface classification, receipt, directory,
and encryption/restore delta.

The fresh qualification at time of writing is as follows.

| Axis | current verdict | Handling in this document |
| --- | --- | --- |
| resident runtime | passed, healthy | not reimplemented — only regression is monitored in 098–099 health/monitor |
| capability | unverified | re-verified via the bounded shard/provenance in 004–010 |
| delivery | unverified, brake engaged | the brake is not weakened; the exact held reason is retained |
| organic effectiveness | not-proven | promotion is judged only in the EVIDENCE/MONITOR of 040 and 099 |
| permission/doctor source | built-unverified | 011 independently closes the current implementation, then only the remaining delta is BUILD |

If an item is found to already be satisfied in the current source at activation time, it is not
reimplemented. It is marked `verified-current` or `superseded` with evidence, and the actual
missing delta in the same area is replanned.

2026-07-30 reconciliation: Core100-075 is `verified-current` via the current timing store and the
API no-send path. legacy-115 is `superseded` as a separate reducer activation; only the
decision-time policy snapshot for fresh decisions and the exact Source/Graph binding were split
out as AWG-050b1's distinct delta. rule-v1/v2 records continue to be read but are not promoted to
Graph provenance.

## 20-minute execution contract

Each number is not an outcome or an epic — it is **a unit of work that can be finished in one real
activation**.

- active wall-clock hard cap: **20 minutes**
- default allocation: 12 minutes investigation/fix + 6 minutes verification + 2 minutes
  receipt/handoff
- allowed timeout for a single command, and its expected normal run time: at most 12 minutes
- If there is no evidence, before starting, that it will finish within 20 minutes, do not open
  BUILD — return it as `blocked` and redesign the scope.
- Do not wait directly for a full suite, soak, cohort, or organic collection whose green/red does
  not land within 12 minutes.
- Run long evaluations as cacheable shards per axis/seed, and have aggregation read only existing
  shards.
- For organic/24h/30d evidence, run the `enroll`, `observe`, and `close` activations each within
  20 minutes. Elapsed wall-clock time is not counted as task work time and does not block other
  BUILD work in the EVIDENCE/MONITOR lane.
- The time limit never lowers the quality floor, pass^k, adversarial cases, provenance, or
  independent evaluation.
- BUILD WIP is 1; non-mutating EVIDENCE/MONITOR WIP is 1.

If acceptance is not fully met within 20 minutes, do not close it as partially complete. Clean up
to a point where the current diff can be safely preserved or reverted, and record
`partial | blocked` along with the exact resume condition.

## Status and activation

Only the following statuses are used.

`missing | partial | built-unverified | verified-current | monitoring | blocked | deferred | rejected | superseded`

Before each task, fill in the following header first.

```text
Task ID:
Status:
Current stage / gate:
lane:
Type (FIX|BUILD|TEST|OPS|EVAL|DOC):
Size (S|M|L):
Current implementation symbol/file:
current evidence:
missing delta:
acceptance criteria:
Verification command and observation:
Commit boundary:
maker model / effort:
Model selection rationale:
evaluator model / effort:
escalation trigger:
Out of scope:
Blocker and resume condition:
```

Permission, credential, persistence, process/concurrency, browser/computer effect,
self-learning, multi-agent authority, and release/provenance always start on Sol/high regardless
of size. Only a safe S/M implementation may be handed to Terra/high after activation. The
completion verdict is made by a fresh Sol evaluator context that reads only the acceptance
criteria and the current diff/artifact.

## Authoritative execution order

The numbers are a stable reference, not an unconditional numeric order. The next wave and the
current dependency-ready state take priority.

Giving each of the 10 areas below 10 rows is purely an editorial structure for 1–100
navigability — it does not mean an equal investment quota or equal priority per area. Current
harm, release blockers, dependencies, and evidence actually determine how much gets selected, and
an optional area stays `deferred` if it lacks the prerequisite gate.

| Wave | default range | pass condition |
| --- | --- | --- |
| A. Bounded truth | 001–010 | shards, caches, and aggregates long qualification; a gap can never be turned green |
| B. Safe agency | 011–030 | permission/privacy and the plan/resume loop fail-close |
| C. Daily personal value | 031–060 | the exact-source loop for Continuity, memory, life domains, and communication |
| D. Controlled action and adaptation | 061–090 | browser/computer, event triggers, learning, and the provider/multi-agent boundary |
| E. Release and value cycle | 091–100 | first value in the existing owner profile, recovery, provenance, and the operations/successor verdict |

Absent an INCIDENT, start at 001. Within a wave, select in the order `P0 safety blocker →
dependency-ready truth/reliability → daily value → optional expansion`. If organic evidence is
insufficient, only that promotion is held, and the next dependency-ready safety/reliability slice
proceeds.

## Core 100

### 1. Bounded qualification and execution control

| ID | 20-minute slice | acceptance | legacyRefs |
| --- | --- | --- | --- |
| 001 | Generate a Core100 input manifest for the current HEAD. | HEAD, tree, dirty, gate artifact digest, and generated-at are in one read-only JSON, and the store digest is the same before and after the source change. | 001–003 |
| 002 | Pin active/command/validation minute-budget fields on the activation artifact. | A fixture missing one of the three fields or exceeding the 20/12/6 cap is rejected at the PLAN gate. | 007, 009, 011 |
| 003 | Add a deterministic admission check that rejects an activation exceeding 20 minutes. | The exact boundary of 20 is allowed; 21, unknown, and unbounded cannot open BUILD WIP. | 007, 010 |
| 004 | Add a selector contract to the capability evaluator that picks exactly one required axis. | Only the selected axis runs, and other axes' counts are not tallied as success. | 059 |
| 005 | Pin a timeout contract that cancels/terminates one axis/seed shard within 12 minutes. | The timeout fixture leaves no child work, and leaves an explicit terminal state and a nonzero exit. | 059, 087 |
| 006 | Record an exact source and input-provenance receipt on each shard. | If any of HEAD, tree, axis, seed, input hash, or model/runtime identity is missing, it is not an aggregation candidate. | 003, 005, 059 |
| 007 | Build a resumable manifest that reuses only completed shards. | Identical provenance is skipped, and if either HEAD or input changes, only that shard is marked stale. | 059 |
| 008 | Build an aggregate path that reads cached shards without executing. | Shard bytes are the same before and after aggregation, and a duplicate axis/seed is computed only once. | 059–060 |
| 009 | Prevent a missing, stale, or skipped shard from turning strict aggregation green. | If even one cell of the required matrix is empty, the result is `unverified`; pass^k and the quality floor are unchanged. | 060 |
| 010 | Independently evaluate the bounded qualification protocol from 004–009. | The evaluator reproduces one axis replay and a corrupted/missing shard within 20 minutes and leaves `PASS` or `FAIL`. | 012, 060 |

### 2. Permission, privacy, persistence

| ID | 20-minute slice | acceptance | legacyRefs |
| --- | --- | --- | --- |
| 011 | Independently close out the current CLI actuator authority and sensitive permission repair. | A fresh evaluator reproduces the public CLI classification, dry-run/apply, mode drift, and symlink/scope rejection and leaves `PASS` or `FAIL`, with zero source changes. | 073–074 |
| 012 | Generate a permission-gap report for public tools, CLI commands, API routes, and MCP surfaces. | Each surface comes out as exactly one authority class or an explicit unmapped, and report generation makes no changes. | 073 |
| 013 | Classify exactly one highest-risk unmapped surface from 012 as fail-close. | That surface's read/write/process/network/send class and negative fixture are pinned, and no other surface is touched. | 073 |
| 014 | Add one authority-parity fixture across CLI/API/Web/MCP for the same effect. | Regardless of adapter name, the same target and effect produce the same permission/approval result. | 073 |
| 015 | Close one contract that binds the exact target, payload digest, and expiry to the approval receipt. | A replay with a changed target, payload, or time cannot reuse the existing approval. | 073, 200, 214 |
| 016 | Inventory one batch of sensitive directories not yet covered by owner-only repair. | The exact owned paths and the expected 0700 are shown, and a symlink, out-of-scope, or unknown path is not a repair candidate. | 074 |
| 017 | Add a plan hash and before/after mode to the existing permission repair receipt. | dry-run has zero mutation; apply records the 0600 transition and plan hash for each successful file. | 074 |
| 018 | Close one directory-permission repair as descriptor-relative and non-recursive. | Only the exact directory becomes 0700, with zero child traversal, symlink following, or scope swap. | 074 |
| 019 | Generate a current missing-path report for encryption, backup, and restore. | Per-store encrypted/plaintext/unsupported, key state, backup version, and restore support are separated read-only. | 075–076 |
| 020 | Run an independent permission/privacy adversarial review covering only the 011–019 changes. | If any of unmapped authority, symlink escape, stale approval, or plaintext restore is reproduced, the gate is red. | 084 |

### 3. Core agent loop, planning, checkpoint

| ID | 20-minute slice | acceptance | legacyRefs |
| --- | --- | --- | --- |
| 021 | Pin a read model that separates project execution state from conversation/Continuity thread IDs. | A project mutation does not implicitly change a linked thread/evidence/outcome. | 205 |
| 022 | Generate goal-decomposition results only as an effect-free editable draft. | Before confirmation, task creation, store mutation, and tool execution are all zero. | 206 |
| 023 | Make acceptance, non-goals, and a kill condition mandatory on an active plan. | An empty or contradictory plan fixture is not transitioned into an executing state. | 207 |
| 024 | Add a pure selector that picks exactly one ready action from exact dependencies. | An item with an unmet dependency, a pending owner decision, or missing authority is not runnable. | 208 |
| 025 | Close one transition contract that makes blocker and no-progress terminal states. | If the same blocker recurs without new evidence, it leaves a blocker and resume condition instead of retrying. | 209 |
| 026 | Bind a plan digest and pending-effect set to the checkpoint. | A plan/pending-effect mismatch rejects automatic resume. | 129, 210 |
| 027 | Add one negative fixture each for corrupt and stale checkpoint resume. | Both fixtures satisfy zero effect, an explicit recovery path, and preservation of the original checkpoint. | 129, 210 |
| 028 | Apply an attempt/time/tool/model/effect budget to one plan step. | A single budget exhaustion does not pass through as success — it becomes an explicit terminal state. | 087–095, 212 |
| 029 | Compute progress only from verified effect receipts. | An assistant claim, tool error, or unverifiable output does not raise the completed ratio. | 213 |
| 030 | Independently evaluate a deterministic two-session fixture for plan→blocker→checkpoint→resume. | Zero duplicate effects, zero unsupported completions, zero stale resumes, reproducing only 021–029. | 211, 216 |

### 4. Personal Continuity and daily conversation

| ID | 20-minute slice | acceptance | legacyRefs |
| --- | --- | --- | --- |
| 031 | Turn normal chat's current Continuity seam into a read-only gap map. | Existing symbols and missing surfaces are distinguished per select/link/preview/open/outcome. | 061 |
| 032 | Expose only the one main-chat Continuity tool schema that was missing in 031. | The schema alone distinguishes allowed effects from forbidden auto-link/outcome, and reuses the existing store. | 061 |
| 033 | Separate life/work thread binding into suggestion and explicit confirm. | Before confirmation, persistent mutation of thread, kind, and link is zero. | 062 |
| 034 | Close the link preview for one exact local task or note domain. | Only a canonical ID is allowed; an ambiguous, renamed, deleted, or duplicate title is rejected before mutation. | 063 |
| 035 | Separate Pack preview and explicit open authority within one store contract. | A repeated preview is byte-identical, and only open produces an exactly-one delivery receipt. | 064 |
| 036 | Restrict chat outcome input to four explicit values plus an optional owner note. | A timeout, sentiment, task receipt, or assistant guess does not generate an outcome. | 065 |
| 037 | Add a parity fixture that connects one surface to the shared Attunement reducer. | The same operation sequence produces the same digest/projection as the existing surface. | 066 |
| 038 | Update the read-only projection that computes life/work eligible coverage. | Exact receipt, explicit outcome, distinct dates, and exclusion reason are separated, and store bytes are unchanged. | 067–069 |
| 039 | Add an owner-authored reason projection for ignored/rejected/adjusted. | It is linked to the exact delivery, and a model-inferred reason is not tallied as an organic negative. | 070 |
| 040 | Independently evaluate the 031–039 engineering contracts, and separate out organic shortfall as monitoring. | The deterministic contract and organic evidence are judged separately, and an evidence-day shortfall does not block other BUILD work. | 071–072 |

### 5. Long-term memory and knowledge

| ID | 20-minute slice | acceptance | legacyRefs |
| --- | --- | --- | --- |
| 041 | Add observed-at/valid-from/invalidated-at states to the memory read projection. | A past fact and a currently active fact are not merged into the same confidence number. | 157 |
| 042 | Make one contradiction cluster with exact sources read-only. | Conflicting fact IDs and sources are visible, and automatic winner mutation is zero. | 158 |
| 043 | Generate stale-fact reconfirmation as a mutation-free draft. | No answer or cancel does not change current memory or policy. | 159 |
| 044 | Update one fact version via explicit owner confirmation. | The old version stays as history, and the new version's provenance and receipt are linked. | 160 |
| 045 | Close one transition that distinguishes invalidation from correction and forget. | An invalidated fact drops out of active recall but is not silently deleted from history/export. | 161 |
| 046 | Expose retention and forget scope as an owner-readable projection. | Exact IDs, affected stores, the irreversible boundary, and the undoable range are visible before mutation. | 162–163 |
| 047 | Add a fact→source→version provenance completeness check to memory export. | If even one link among active/history/invalidation is missing, the export is marked incomplete. | 164 |
| 048 | Show one cross-store conflict between memory and notes/tasks without mutation. | A domain receipt is not automatically promoted into a memory correction or preference promotion. | 165 |
| 049 | Run one deterministic shard for correction→invalidation→forget→recovery. | Proves zero stale resurrection, zero unrelated fact loss, and exact source preservation. | 166–167 |
| 050 | Get a long-term memory evaluator verdict covering only 041–049. | If any of temporal truth, deletion truth, or export provenance is unclear, it does not PASS. | 168 |

### 6. Tasks, calendar, reminders, contacts, notes, communication

| ID | 20-minute slice | acceptance | legacyRefs |
| --- | --- | --- | --- |
| 051 | Close one contract that produces only a task draft from vague user intent. | Before owner confirmation, task writes are zero, and missing next-action/due information remains as a question. | 169–171 |
| 052 | Make one exact task-status transition an idempotent receipt. | A duplicate replay changes state only once, and completion is not an outcome/permission. | 172 |
| 053 | Add a projection that separates calendar free/busy from event-detail permission. | When detail permission is absent, title/attendee/location does not leak into model context. | 173–174 |
| 054 | Build a Continuity Pack draft from an exact calendar occurrence. | Only the selected occurrence ID is linked, not the entire recurring series, and delivery is zero. | 175 |
| 055 | Pin the failure matrix for one of the reminder cancel/retry/stale transitions. | Zero firings after cancellation, zero retry duplicates, zero stale-state mistaken-for-success. | 176–177 |
| 056 | Pin contact context and communication recipient as distinct authorities. | Contact recall alone does not generate a send target or future permission. | 178, 193–196 |
| 057 | Verify one note-capture→grounded-recall round trip against the exact source. | Unsupported synthesis abstains, and note citations resolve back to the original location. | 179–180 |
| 058 | Pin an exact recipient/account/channel preview to one send adapter. | Alias collision, account drift, and ambiguous recipient are rejected before the provider call. | 193–198 |
| 059 | Bind the communication content/attachment digest to final approval. | If the text, attachment, or order changes, the existing approval expires and the send count is zero. | 199–201 |
| 060 | Reconcile an ambiguous provider acknowledgement by effect ID. | Zero duplicate sends under success-before-ack and restart replay; unknown is left on the manual path. | 202–204 |

### 7. Browser and computer action safety

In this area, `computer` means the currently permitted browser and Muse-owned artifact/action
surface. It does not add arbitrary desktop-wide autonomy.

| ID | 20-minute slice | acceptance | legacyRefs |
| --- | --- | --- | --- |
| 061 | Build a current authority-gap report for browser/computer public actions. | Per-class inspect/fill/submit/upload/download/clipboard/screen/process, and unmapped, are shown. | 181–183 |
| 062 | Build one mutation-free action plan from the inspect result. | Click/type/upload/download/system effects are zero during plan generation. | 184 |
| 063 | Add a re-verification contract for stale DOM/accessibility targets. | If node identity or page generation changes, it fail-closes right before the action. | 185 |
| 064 | Separate fill and submit into different authorities and receipts. | Fill approval does not execute submit, and the submit target/payload is shown again. | 186 |
| 065 | Close one browser-download path with a quarantine + content-bound receipt. | Zero writes outside the final destination, zero executable auto-open, and a hash/type/size receipt is left. | 187 |
| 066 | Pin an exact local path/destination/field preview to one upload path. | A symlink/scope swap, a changed file hash, or a hidden field change is rejected before upload. | 188 |
| 067 | Bind the active account identity to the action receipt. | If account/session drift is detected, it does not act on the old approval. | 189 |
| 068 | Add a fixture that abstains when the accessibility target and screenshot inference conflict. | If the two pieces of evidence disagree, click/type is zero and it falls back to an inspect request. | 190 |
| 069 | Re-verify pending effects on browser/computer checkpoint resume. | After a crash, an uncertain effect is not auto-replayed — it leaves a reconcile state. | 191 |
| 070 | Evaluate one adversarial journey shard among stale target, injection, upload swap, and ambiguous effect. | An independent evaluator reproduces zero unapproved effects and the exact terminal reason for the selected case. | 192 |

### 8. Event-driven proactivity, Observe, governed adaptation

| ID | 20-minute slice | acceptance | legacyRefs |
| --- | --- | --- | --- |
| 071 | Pin an explicit consent grant for one Observe/event source. | Enrollment is rejected without source, fields, cadence, retention, and pause. | 109–111 |
| 072 | Close one Observe lifecycle transition among pause/resume/forget. | Collection is zero after pause, resume creates a new consent generation, and forget leaves an exact-scope receipt. | 112 |
| 073 | Turn one task/calendar/reminder event into an idempotent trigger envelope. | It has a source ID, generation, occurred-at, and dedup key, and a replay creates the trigger only once. | 113, 265–266 |
| 074 | Compute trigger eligibility read-only from permission, quiet hours, and relevance. | An ineligible event leaves an explicit suppression reason with no delivery. | 114–115 |
| 075 | Record one proactive timing decision only as a shadow log. | Candidate, chosen/suppressed reason, and counterfactual are left, but notification/send is zero. | 116 |
| 076 | Add cooldown and repeated-trigger suppression contracts. | Duplicate interruption is zero under burst/restart/clock-skew fixtures. | 117, 267 |
| 077 | Make one negative outcome produce only a bounded display/timing rollback proposal. | Source, permission, recipient, and action scope are not expanded, and automatic promotion is zero. | 118–120 |
| 078 | Generate a learning candidate from experience only as a proposal. | Without an explicit outcome and source run, there is no candidate, and the active behavior digest is unchanged. | 217–218 |
| 079 | Advance one candidate through a quarantine held-out test. | The active registry/prompt is unchanged, and a single safety regression blocks activation. | 219–223 |
| 080 | Independently governance-audit the event→shadow→outcome→proposal chain. | Zero silent collection/delivery/activation, and a receipt is not promoted into a permission. | 224–228 |

### 9. Provider-neutral runtime, resource, multi-agent, evaluation

| ID | 20-minute slice | acceptance | legacyRefs |
| --- | --- | --- | --- |
| 081 | Project one provider adapter's capability probe onto a common contract. | tool/stream/structured-output/vision support is decided by probe result, not adapter name. | 085, 241–243 |
| 082 | Wire a personal/local-only egress gate into one auxiliary-model callsite. | Under a local-only fixture, cloud auxiliary calls are zero, and an explicit unavailable/fallback reason is left. | 073, 242 |
| 083 | Close one contract that enforces no pending tool/effect before fallback. | Zero provider swap after a partial output or uncertain effect; only a safe pre-effect failure may fall back. | 244–245 |
| 084 | Compare the same tool-loop fixture across two providers via normalized trace. | Provider wire differences are allowed, but the user-visible outcome, tool args, and permission result are the same. | 246 |
| 085 | Add one resource-admission conflict fixture between foreground and background work. | Background claims are zero under foreground pressure, and starvation is left as explicit deferred. | 085–096 |
| 086 | Settle budget and pending effects after model/tool cancellation. | Token/time/tool counters are terminal, and child/process/pending approval leaks are zero. | 087–095 |
| 087 | Pin a single-agent baseline shard for one multi-agent-candidate task family. | Artifact, rubric, budget, and seed are the same, and quality/cost/latency/effect count are recorded. | 229 |
| 088 | Pin decomposition and writable scope to one handoff schema. | A task with a shared-state/ordering dependency is not fanned out, and a write outside allowed paths/tools is rejected. | 230–233 |
| 089 | Add a negative fixture where a subagent cannot expand the maker's authority. | Delegated tool/effect permission is the parent intersection, and handoff spoof/replay is rejected. | 234–238 |
| 090 | Independently evaluate a paired shard of single vs. multi, or provider A vs. B. | Under the same inputs/rubric/budget, a more complex candidate with no quality gain is not promoted. | 239–252 |

### 10. Onboarding, release, operations, value cycle

| ID | 20-minute slice | acceptance | legacyRefs |
| --- | --- | --- | --- |
| 091 | Build an isolated `MUSE_HOME` onboarding preflight within the existing owner macOS profile. | Diagnoses stable entrypoint, writable local root, and provider state without a separate OS user or reboot. | 097–099 |
| 092 | Show the local/cloud data path and egress in onboarding before the actual request. | Provider, base-URL locality, and sent-field classes are visible, and network calls are zero on cancel. | 100–101 |
| 093 | Close one provider-credential diagnostic path as secret-safe. | Distinguishes missing/invalid/unreachable, and the raw token is zero in stdout, trace, and artifact. | 102 |
| 094 | Unify one doctor-repair path into a preview→apply→verify receipt. | Preview mutation is zero, only explicit apply has effect, and a postcondition failure is not green. | 103–105 |
| 095 | Run one first-cited-answer or Continuity Pack journey shard in a clean `MUSE_HOME`. | setup→request→exact source→next safe action ends in a terminal state within 12 minutes. | 106–108 |
| 096 | Run one verify-only and isolated-restore fixture for encrypted backup. | Source is unchanged, the empty-target digest matches, and a wrong key/version fail-closes. | 075–076, 145–156 |
| 097 | Run a secret/personal-remnant/provenance-signature-state scan on the current tree and one package candidate. | HEAD/tree/build digest and signing state match, and an unclassified finding or a scanner skip makes the release gate red. | 077, 133–140 |
| 098 | Verify one install-health and rollback path against a fresh artifact. | A failed health probe reverts to the previous known-good state and does not delete user data. | 133–140, 145–156 |
| 099 | Enroll an organic dogfood/value monitor, or review an existing snapshot within 20 minutes. | The synthetic/controlled/organic denominators are separated, and after leaving only the next observation time, BUILD is released. | 068–072, 141–143, 289–299 |
| 100 | Record the release/successor/terminate decision using fresh evidence from every applicable gate. | One of `release-ready`, `continue-with-successor`, or `terminate` is recorded with blockers, provenance, and rollback, and red/unknown is never assumed green. | 144, 300 |

## After Task 100

100 is not a task that unconditionally ships a release. `release-ready` is chosen only when the
source/behavior, controlled-live, and organic-production gates are all fresh enough to back that
claim. External publication, tags, and release creation follow separate owner authority and the
release gate.

If a required gate is red but Muse's value keeps being confirmed, build the next bounded roadmap
under `continue-with-successor`. If the risk/operating cost/complexity outweighs the value and
there is no recoverable next experiment, choose `terminate` with supporting evidence.
