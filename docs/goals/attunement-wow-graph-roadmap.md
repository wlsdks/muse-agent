---
title: Attunement wow + graph roadmap
audience: [product, engineering, agents]
purpose: Run the signature Muse experience and Attunement Graph as a separate long-lived program
status: active
updated: 2026-07-29
related: [../strategy/attunement.md, ../design/attunement-graph.md, attunement-implementation-plan.md]
---

# Attunement wow + graph roadmap

This program is deliberately separate from the personal-agent core 100/300-task programs.
Those programs harden the general agent substrate. This one builds Muse's signature:

> **A procedural skill teaches an agent how to do a task better. An Attunement Policy
> teaches Muse how to collaborate with this person better.**

The two workstreams are inseparable:

- **Experience:** Shadow Muse → Continuity Capsule → Policy Card.
- **Engine:** a modular Attunement Graph that can connect intent, change, time, evidence,
  policy, and authority without copying existing stores.

## Program boundary

This roadmap consumes current memory, tasks, calendar, contacts, Continuity, timing,
receipt, trace, browser, and policy seams. It does not rebuild them or claim their existing
tests prove this program. A task that duplicates an active core-roadmap contract is marked
`superseded` here and left to the core program.

Only one source-changing graph BUILD slice may be active at a time. Research, benchmark
preparation, and organic evidence monitoring may run beside it when they do not mutate the
same source.

## Definition of done

The program is not done when Muse has a graph database. It is done when:

1. a real unfinished thread can be resumed with a grounded Capsule that identifies the
   stopping point, changes, evidence, next step, prepared action, and expected time;
2. Muse can explain why it surfaced or stayed silent and show a bounded counterfactual;
3. a Policy Card proposes a scoped collaboration change with evidence and reversible
   controls;
4. the user can inspect, correct, reject, roll back, and forget every learned relation;
5. controlled baselines and repeated dogfood show the graph path improves temporal,
   relational, or reconstruction outcomes enough to justify its cost;
6. every claim remains traceable to exact source evidence and no graph inference expands
   action authority.

## Execution order

| ID | Slice | Exit gate | Status |
|---|---|---|---|
| **AWG-001** | Product signature and research contract | Canonical wow scenario, honest shipped/roadmap boundary, research-backed graph design, and docs cross-links | completed |
| **AWG-010** | Reference graph kernel | `@muse/attunement-graph` domain types, invariants, append log, compact in-memory indexes, Activation Subgraph compiler, and conformance tests; no LLM or production DB | completed |
| **AWG-020** | Exact Continuity projection | Rebuildable projection of thread, artifact links, delivery, outcome, policy version, and source provenance without duplicated authority | completed |
| **AWG-030** | Explained change query | “What changed since I stopped?” returns exact temporal paths or abstains; flat/vector/graph baseline recorded | completed |
| **AWG-035a** | Observation Receipt format | Strict content-addressed codec preserves one caller-declared exact projection and source accounting without personal source text | completed |
| **AWG-035b** | Observation capture + query bridge | Raw authoritative observation produces the receipt and receipt→current uses the same AWG-030 comparison core | completed |
| **AWG-040** | Continuity Capsule v1 | User-invoked Capsule renders stopping point, changes, next step, prepared work, expected time, and source drawer | pending |
| **AWG-050** | Shadow Muse ledger | Records `silent|digest|offer`, reason, evidence, bounded alternatives, and later return timing without sending or acting | pending |
| **AWG-060** | Policy Card v1 | Evidence counts, scope, proposed delta, trial/edit/reject/rollback; no hidden promotion | pending |
| **AWG-070** | Storage bake-off | Reference adapter vs PostgreSQL vs at most one embedded graph candidate on correctness, cost, recovery, portability, and maintenance | pending |
| **AWG-080** | Durable local graph adapter | Selected adapter passes conformance, export/rebuild, corruption, migration, forget, and crash-recovery gates | pending |
| **AWG-090** | Dogfood qualification | Controlled scenarios plus repeated organic use; reconstruction-cost and policy-correction evidence remain separately reported | pending |

Raw numbering does not activate work. Before each BUILD slice, inspect current source and
classify it as `missing`, `partial`, `built-unverified`, `verified-current`, `monitoring`,
`blocked`, `deferred`, `rejected`, or `superseded`. Implement only the missing delta.

## Completed slice: AWG-010

- **Classification at activation:** `missing` — current Attunement stores provided authoritative exact
  links and receipts, but no storage-neutral graph kernel or Activation Subgraph compiler.
- **Status:** `completed` — focused and changed-scope gates pass; a fresh independent
  evaluator passed after two bounded correction rounds.
- **Maker:** Codex root session, Sol-class persistence/architecture slice, inherited
  reasoning.
- **Evaluator:** fresh `gpt-5.6-sol` with high reasoning.
- **Selection reason:** this slice defines a future persistence boundary and public module
  semantics, while remaining isolated from disk formats, database SDKs, and runtime wiring.
- **Escalation trigger:** stop if completion requires a durable format, migration,
  cross-process coordination, authoritative-store mutation, runtime action authority, or
  edits in another roadmap's active source area.
- **Acceptance:** atomic/idempotent append; strict temporal/provenance/epistemic invariants;
  bounded deterministic traversal; token-budgeted Activation Subgraph; conformance and
  adversarial tests; no LLM, production database, or store projection.
- **Next eligible slice:** AWG-020 exact Continuity projection, after fresh source
  reconciliation with the core roadmap.

## Completed slice: AWG-020

- **Classification at activation:** `missing` — the kernel can validate, store, forget,
  traverse, and compile assertions, while current Continuity state remains an exact
  authoritative substrate with no graph projection.
- **Status:** `completed` — focused/root checks pass and the fresh independent evaluator
  passed after two bounded correction rounds.
- **Maker:** Codex root session, Sol-class provenance/architecture slice, inherited
  reasoning.
- **Evaluator:** fresh `gpt-5.6-sol` with high reasoning.
- **Selection reason:** this slice defines the one-way boundary between an on-disk
  authoritative store and a disposable graph projection. It changes no persisted source
  format and grants no runtime authority.
- **Escalation trigger:** stop if completion requires reading or mutating personal stores
  inside the graph package, changing the Attunement schema, adding a production database,
  inferring outcomes, or editing another roadmap's active source area.
- **Acceptance:** pure deterministic projection; exact versioned source references;
  content-addressed replay; deletion/forget delta; rebuild/delta equivalence; interaction
  receipts never promoted to outcomes; cross-scope and cross-thread fail-close tests.
- **Core-roadmap overlap:** none found in current source. This slice shares the I/O-free
  Attunement state parser at runtime and imports its domain types, but does not read a store
  or edit the memory work currently in progress on local `main`.
- **Next eligible slice:** AWG-030 explained change query, after fresh source reconciliation
  and a flat exact-lookup baseline contract.

## Prior blocked activation: AWG-030

- **Classification at activation:** `missing`.
- **Status:** `blocked` on 2026-07-29 before BUILD. Three fresh PLAN reviews made material
  progress but exhausted the declared three-review hard cap without a PASS. No AWG-030
  runtime source was changed.
- **Resolved in the contract:** caller-declared versioned boundary rather than a false
  “proven stop”; strict `(boundary, current]` temporal classification; immutable I/O-free
  projections; bounded source parsing, projection, diff, traversal, and result work;
  canonical bipartite revision components; deterministic shortest explanation paths; and
  executable flat/vector/graph qualification.
- **Last correction after the gate closed:** raw-delta overflow is a typed pre-result
  budget error, because component-based `candidateCount` does not exist before pairing.
  It must not fabricate a global abstention count or digest.
- **Reactivation condition:** a new controller context must reconcile current source,
  reconstruct this exact contract in a fresh handoff, and obtain an independent PLAN PASS
  before opening BUILD. Do not duplicate Core100 Continuity UI/store work or treat this
  blocked design as shipped behavior.

## Completed slice: AWG-030

- **Classification at reactivation:** `missing`; current source still ended at the
  AWG-020 projection and the separate Core100 work owned no equivalent pure graph query.
- **Status:** `completed` after a fresh controller rebuilt the contract, a fresh
  independent PLAN evaluator passed review 2/2, and a separate fresh completion evaluator
  passed after two bounded correction rounds. The earlier blocked activation remains above
  as provenance rather than being rewritten.
- **Shipped boundary:** pure `@muse/attunement-graph/continuity-changes` library subpath;
  unknown-input/source/projection/diff/traversal/output budgets; authoritative no-op replay
  normalization; strict temporal truth table; conservative revision components; exact
  source-bearing paths; typed abstention; content-addressed deterministic results.
- **Controlled qualification:** nine immutable generated-synthetic families, seven in
  semantic metric denominators. Flat and graph both recorded `1.0` detection
  precision/recall and `1.0` exact path precision; graph exact full-path coverage was
  `1.0` versus flat `0.75`. Vector was `not-applicable`/not run because AWG-020 contains
  no semantic text. This proves controlled relational path assembly only, not user wow,
  organic effectiveness, or generic graph superiority.
- **No authority expansion:** no source I/O, durable adapter, model/embedding call, UI,
  scheduler, policy promotion, permission, or action.
- **Then-proposed next slice:** AWG-040. Fresh source reconciliation subsequently found
  that a changed authoritative store could not reconstruct its prior observation, so
  AWG-035a/035b became truth-preserving prerequisites instead of guessing inside the UI.
  AWG-050 Shadow timing remains separate.

## Completed slice: AWG-035a

- **Classification at activation:** `missing`; AWG-030 could compare two simultaneously
  supplied raw states, but no durable/portable prior projection existed after an
  authoritative source changed.
- **Status:** `completed` after the initial PLAN activation and R1 each stopped on executable
  verification-manifest defects, R2 obtained a fresh PLAN PASS, and a separate fresh
  completion evaluator passed the implementation with no blocker. The stopped attempts
  remain in the temporary handoff provenance rather than being rewritten.
- **Shipped boundary:** pure
  `@muse/attunement-graph/continuity-observations` library subpath with two functions:
  seal and verify. The v1 receipt binds caller-declared observation time, exact scope,
  projection, timestamp basis, prior source-accounting diagnostics, and strict size/work
  limits with a domain-separated SHA-256 ID.
- **Truth and privacy boundary:** content addressing proves receipt self-consistency only;
  it does not prove an external observation, recompute the raw source version, or make the
  data anonymous. Personal titles, owner notes, artifact summaries, provider IDs, and raw
  provider artifact IDs are not copied, while opaque hashes/scope remain personal linkage
  data requiring future retention/forget policy.
- **No authority expansion:** no source I/O, persistence, migration, model/embedding call,
  UI/API/CLI, delivery, outcome, policy, permission, scheduler, or action. Core100 030–040
  contracts remain unchanged.
- **Verification:** package 7 files / 66 tests, focused adversarial 10/10, changed tests,
  package/root typechecks, build, ESLint, public ESM import, and independent rehashed-tamper
  probe passed.
- **AWG-035b1a shared preparation seam:** completed — the existing public query now calls
  one internal `prepareContinuitySourceObservation` boundary exactly once for previous and
  current. It preserves strict parsing, all source budgets, diagnostics, projection error
  mapping, public error identity, validation precedence, and complete result/error bytes.
  It adds no package subpath, source I/O, persistence, or user-facing capture claim.
- **AWG-035b1b raw capture adapter:** completed — the existing observation subpath exposes
  `captureContinuityObservation`, which accepts one caller-supplied raw projection input,
  uses the shared preparation seam once, and seals through the existing codec once.
  Preparation failures become observation-domain errors; unknown internal failures retain
  identity. This is pure manual capture, not source I/O, automatic observation, or storage.
- **AWG-035b2a prepared comparison core:** completed — the existing state-to-state query is
  now a strict raw-input adapter over one internal prepared-observation comparison core.
  Metadata-only scope/interval checks precede lazy previous projection, exact boundary
  binding, and lazy current projection. Public exports, error identity and precedence,
  complete result bytes/result IDs, work bounds, and benchmark evidence remain unchanged.
  This is reusable truth-operator groundwork, not a public receipt comparison function.
- **AWG-035b2b receipt→current bridge:** completed — the existing observation subpath
  verifies the prior receipt before touching current state, derives its exact
  scope/time/source boundary, projects current once, and delegates to the shared core.
  Controlled no-op, addition, revision, and abstention outputs are byte-identical to the
  raw query. This is still a pure manual library surface with no source I/O, persistence,
  automatic stop detection, Capsule/UI, timing policy, or action authority.
- **Next eligible slice:** AWG-040 Continuity Capsule v1, beginning with a pure
  receipt→current Capsule assembly contract before any UI or automatic delivery.

## Architecture gates

Every source-changing slice must preserve:

- domain semantics independent of a database SDK;
- authoritative existing stores plus rebuildable graph projection;
- append-oriented, versioned, provenance-bearing assertions;
- bi-temporal validity and transaction time;
- explicit epistemic class;
- bounded traversal and fail-closed source resolution;
- deterministic projection where deterministic evidence exists;
- LLM extraction isolated behind a replaceable port and never treated as authority;
- portable export, migration, forget cascade, and rollback;
- provider-neutral core and local-first default.

## Dogfood loop

Each meaningful vertical slice follows:

```text
product-shaped scenario
  → flat/vector baseline
  → graph implementation
  → deterministic grader + adversarial faults
  → local dogfood
  → independent completion evaluation
  → commit, sync main, merge, push
  → evidence-backed next activation
```

The first canonical scenario is the interrupted trip:

- three lodging candidates were being compared;
- the flight changed afterward;
- one cancellation deadline is tomorrow;
- an 18-minute gap is available;
- prior evidence suggests short gaps fit a change-only comparison;
- the user can see why now, sources, changes, execution boundary, and suppression control.

The grader must also test the opposite outcome: if timing evidence is weak, the correct
graph-assisted decision is silence.

## Research and open-source policy

Before selecting algorithms or storage:

1. read primary papers and standards;
2. inspect current open-source code and licenses;
3. record the exact version/commit used;
4. reproduce relevant claims when practical;
5. include a negative or simpler baseline;
6. document failures, contradictions, and unresolved gaps;
7. adapt mechanisms, not proprietary code or vendor claims.

Current starting references and limitations are recorded in
[the graph design](../design/attunement-graph.md). Research is refreshed at storage
selection and qualification gates because projects, APIs, and benchmark results drift.

## Continuous integration with `main`

This dedicated worktree remains a long-lived program branch, not a forked product:

1. fetch and incorporate `origin/main` before activating a slice;
2. keep BUILD WIP at one and resolve overlap with the core roadmap before editing;
3. run the slice-specific checks and a fresh-context independent evaluation;
4. commit product-behavior boundaries, not every checkbox;
5. fetch/rebase once more, merge the verified slice into local `main`, and push normally;
6. fast-forward this worktree to the resulting `main` merge before the next slice.

No force push, moving tag, bypassed hook, alternate refspec, or silent conflict resolution
is authorized.
