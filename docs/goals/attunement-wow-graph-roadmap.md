---
title: Attunement wow + graph roadmap
audience: [product, engineering, agents]
purpose: Run the signature Muse experience and Attunement Graph as a separate long-lived program
status: active
updated: 2026-07-29
related: [../strategy/attunement.md, ../design/attunement-graph.md, ../design/agent-native-graph-core.md, attunement-implementation-plan.md]
---

# Attunement wow + graph roadmap

This program is deliberately separate from the personal-agent core 100/300-task programs.
Those programs harden the general agent substrate. This one builds Muse's signature:

> **A procedural skill teaches an agent how to do a task better. An Attunement Policy
> teaches Muse how to collaborate with this person better.**

The two workstreams are inseparable:

- **Experience:** Shadow Muse → Continuity Capsule → Policy Card.
- **Engine:** a modular, agent-native Graph DB/Engine optimized for compact context,
  temporal/provenance reasoning, abstention, policy, and action authority—not generic query
  breadth—and able to connect those relations without copying existing stores.

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

1. a real unfinished thread can be resumed with a grounded Capsule that identifies changes,
   evidence, next step, prepared action, and expected time; an exact stopping point is a
   later capability that requires explicit stop-marker/capture evidence, while the current
   substrate resumes from the previous observation's recorded next step;
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
| **AWG-040** | Continuity Capsule v1 | User-invoked, library-only Capsule renders the previous observation's recorded next step, changes, current next step, prepared work, expected time, and source drawer | in progress (`AWG-040b/c` verified library-only; application integration and exact-stop capture pending) |
| **AWG-045a** | Canonical immutable-envelope kernel | Package-private hostile-input admission and frozen-output re-verification produce byte-identical canonical values without changing v1 codecs or exports | completed |
| **AWG-045b** | Deterministic candidate ledger | Package-private pure reducer gives every core/optional candidate one terminal state, counter vector, reason partition, and monotone fallback | completed |
| **AWG-050a** | Graph v2 semantic hardening | Integrate the verified 045 kernels into scope-safe immutable snapshots, bounded proof settlement, nomination/traversal, freshness, typed completeness, and adversarial isolation | partial (`AWG-050a1` settlement, `050a2a` exact thread-rooted witnesses, and `050a2b1` fair opportunity ordering independently verified; fair settlement integration `050a2b2` and Providers `050a3` pending) |
| **AWG-050b** | Shadow Muse ledger | Records `silent|digest|offer`, reason, evidence, bounded alternatives, and later return timing without sending or acting | pending |
| **AWG-060** | Policy Card v1 | Evidence counts, scope, proposed delta, trial/edit/reject/rollback; no hidden promotion | pending |
| **AWG-070** | Storage bake-off | Prove the Muse-owned local default first; compare PostgreSQL and at most one embedded candidate only as optional Adapters on correctness, cost, recovery, portability, and maintenance | pending |
| **AWG-080** | Durable local graph adapter | Selected adapter passes conformance, export/rebuild, corruption, migration, forget, and crash-recovery gates | pending |
| **AWG-090** | Dogfood qualification | Controlled scenarios plus repeated organic use; reconstruction-cost and policy-correction evidence remain separately reported | pending |

Raw numbering does not activate work. Before each BUILD slice, inspect current source and
classify it as `missing`, `partial`, `built-unverified`, `verified-current`, `monitoring`,
`blocked`, `deferred`, `rejected`, or `superseded`. Implement only the missing delta.

## Next eligible activation: AWG-050a2b2 fair witness-settlement integration PLAN

Independent Sol-class architecture reviews converged on a semantic prerequisite before the
Shadow ledger or durable database:

- **AWG-045a (completed):** hostile external mutable data and Muse-frozen output now pass
  through two exact, uniform descriptor profiles that normalize to the same canonical bytes
  and ID. The independently verified helper remains package-private and leaves every v1
  codec and public export untouched.
- **AWG-045b (completed):** the private pure reducer settles abstract core/optional
  candidates as exactly `admitted`, `rejected`, `failed`, or `skipped`; diagnostics describe
  only the selected logical ledger. Mandatory-overhead fallback selects fresh
  `normal → core-only → abstain` ledgers, then returns a separate `invalid-input`
  capacity-error envelope only when the minimum abstention cannot fit.
- **AWG-050a1 (completed private seam):** hostile caller-nominated documents now pass
  through exact request/document identities, scope/snapshot/freshness coherence, local
  proof closure, deterministic candidate settlement, and retained canonical context-byte
  materialization. All outputs remain partial or abstained and grant no absence,
  freshness, action, traversal-coverage, or source-authority claim.
- **AWG-050a2a (completed private seam):** one exact Continuity thread now seeds
  content-addressed bounded witness traversal. The compiler selects deterministic shortest
  paths over valid assertions, emits locally closed proof documents consumed by 050a1,
  accounts for excluded optional nominations, and abstains when the core witness cannot be
  produced. Coverage remains explicitly partial; caller-declared snapshot/freshness facts
  are validated but not independently observed.
- **AWG-050a2b1 (completed private prerequisite):** caller-declared opportunities carrying
  syntactically valid proof-document IDs are ordered one-per-round across caller-declared
  Continuity, Change, Evidence, Policy, and Authority lanes. The order is deterministic,
  content-addressed, exact over its finite input pool, and partial-only. It does not verify
  the referenced witnesses or prove lane semantics, traversal coverage, or fairness after
  the six-axis budget ledger.
- **AWG-050a2b2 (next PLAN):** derive the five lanes from verified witness semantics and
  compose the fair order with candidate settlement without letting one oversized bundle
  starve all following lanes. It must separately receipt opportunity fairness and actual
  budget-admission outcomes, while retaining partial-only graph coverage. This does not
  open BUILD by itself.
- **AWG-050a3 (after 050a2):** compose authoritative snapshot/freshness Providers and the
  verified Continuity observation/change/Capsule `resumeContext` grammar.

The full decision and dissent are in
[Muse Agent-Native Graph Core](../design/agent-native-graph-core.md). Those earlier
fail-closed findings produced AWG-045a/045b and the now verified
AWG-050a1/050a2a/050a2b1 seams rather than being bypassed. This is still private
deterministic substrate, not shipped `resumeContext` or user-visible wow. AWG-050a2b2
remains closed to source changes until a new bounded PLAN passes. AWG-050b then owns the actual Shadow
`silent | digest | offer` decision receipt and counterfactual.

## Completed slice: AWG-050a2b1

- **Product meaning:** when one caller-declared kind of graph opportunity overwhelms the
  candidate pool, Muse can still give Continuity, Change, Evidence, Policy, and Authority
  lanes a fair turn. This prerequisite does not yet verify or derive those candidate
  meanings. The internal ID is not product language.
- **Classification at activation:** `missing` — exact thread-rooted witnesses existed, but
  the candidate settlement rank could still let a crowded relation family dominate.
- **Status:** `completed private prerequisite` — deterministic opportunity ordering is
  verified; witness-derived lane assignment and budget-admission fairness remain pending.
- **Maker:** Codex root controller, Sol-class semantic-integrity BUILD with inherited
  reasoning.
- **Evaluator:** fresh `gpt-5.6-sol` with high reasoning in separate contexts; the first
  completion pass failed on an internal-ID admission bypass and a new correction pass
  verified the fix.
- **Selection reason:** fair evidence allocation and honest coverage are graph semantic
  boundaries, while this prerequisite can remain a pure package-private TypeScript kernel.
- **Escalation trigger:** public exports, graph/store mutation, authoritative lane
  inference, settlement semantic changes, persistence, runtime/API/UI composition, or any
  claim that ordering fairness already proves budget admission.
- **Acceptance:** five fixed lanes; content-addressed deterministic rotation; one
  indivisible opportunity per active lane per round; exact prefix/exhaustion invariants; dense
  rank and per-lane conservation; permutation stability; hostile-input fail-close; internal
  admission ID rejection; partial-only coverage and no traversal, freshness, completeness,
  permission, or action claim.
- **Evidence:** 7/7 focused tests, 181/181 package tests, 3,125 independently probed lane
  count vectors, package/root typechecks, build, changed tests, standalone literal-ID
  oracle, lint, diff check, zero getter/Proxy-trap probe, and fresh Sol/high correction PASS.
- **Rollback:** delete the three private source/test/verifier files; there is no export,
  migration, stored data, or runtime cleanup.

## Completed slice: AWG-050a2a

- **Product meaning:** Muse can start at one exact Continuity thread and compile the
  shortest deterministic, source-linked graph witnesses that explain the bounded work
  around it. This is the first Muse-owned thread-rooted graph operator, not a complete
  graph database or user-visible feature. `AWG-050a2a` is an internal ledger ID; product
  updates should call this capability **exact thread-rooted graph witnesses**.
- **Classification at activation:** `missing` — 050a1 could settle already nominated
  proof documents, but Muse could not derive those documents from an exact thread seed.
- **Status:** `completed private seam` — the implementation, adversarial probes, focused
  tests, package regression, standalone verifier, and independent completion gate pass.
- **Maker:** Codex root controller, Sol-class semantic-integrity BUILD with inherited
  reasoning, after one bounded Terra/high worker attempt produced no source edits.
- **Evaluator:** fresh `gpt-5.6-sol` with high reasoning and a separate read-only context.
- **Selection reason:** path determinism, hostile admission, temporal truth, and absence
  boundaries are graph semantic-integrity work; the implementation remains a pure,
  package-private TypeScript operator with no persistence or runtime effect.
- **Escalation trigger:** stop if the slice requires a public export, store mutation,
  authoritative snapshot claim, persistence/backend choice, runtime/API/UI composition,
  action authority, or weakening partial/abstained truth rules.
- **Acceptance:** exact thread seed and scope; normalized semantic request identity;
  deterministic shortest witness paths with raw-field tie order; closed proof documents;
  optional exclusion accounting; core-unavailable abstention; hostile accessor/prototype/
  alias/cycle/sparse/unsafe-number rejection; strict scope, time, direction, supersession,
  freshness, and six-axis bounds; deeply frozen content-addressed output; partial-only
  coverage and no absence, freshness, source-authority, permission, or action claim.
- **Evidence:** 7/7 focused tests, 174/174 package tests, package and root typechecks,
  package build, changed tests, standalone literal receipt verifier, lint, diff check, and
  fresh independent Sol/high adversarial PASS.
- **Rollback:** delete the three private source/test/verifier files; there is no export,
  migration, stored data, or runtime cleanup.

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
  AWG-050b Shadow timing remains separate.

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

## Completed sub-slice: AWG-040a1

- **Classification at activation:** `missing`; current graph receipts preserve relational
  proof, while current `ContinuityPack` resolver display values had no single canonical,
  bounded projection contract for a later source receipt and Capsule compiler.
- **Status:** `completed`; the revised PLAN passed a fresh independent evaluator, and a
  separate fresh completion evaluator passed the final null-prototype-hardened
  implementation with no blocker.
- **Architecture decision:** reject a direct live-Pack + graph-result wrapper because it
  could join stale display truth to graph proof. The all-source projection Module belongs
  internally to `@muse/attunement`, which owns `ResolvedArtifact` semantics; the graph
  package remains independent of provider display rules.
- **Built boundary:** pure `unknown → ContinuitySourceProjection` normalization for all 11
  current artifact types. It uses own data descriptors, closed type/provider/role and field
  matrices, semantic-time and set canonicalization, observable Pack-coherence checks,
  explicit work/byte limits, and recursive freezing. It strips `evidenceRefs` and the
  interaction anchor after validation, so it carries no delivery, feedback, permission, or
  action authority.
- **Truth boundary:** generic `updatedAt` remains an opaque source version/display string;
  semantic instant fields normalize to ISO. The Module reads no clock or source and proves
  no freshness, observation time, receipt integrity, source comparison, or graph binding.
- **Privacy boundary:** the output intentionally includes personal thread/artifact titles,
  summaries, owner prompts, URLs, locations, relationships, and birthdays. It is local
  personal data, not anonymous or telemetry-safe. Retention, forget, export, and migration
  are required before durable use.
- **Core-roadmap overlap:** none found. The slice does not implement onboarding task 103,
  session-handoff task 211, automatic observation, UI, scheduling, or general memory work.
- **Verification:** focused `25/25`; full `@muse/attunement` `32 files / 220 tests`;
  changed tests; package/root typechecks and builds; root ESLint; executable dependency
  probe; diff hygiene. Root build retained only the existing Vite chunk-size warning.
- **Next eligible sub-slice:** AWG-040a2 source receipt—add caller-declared observation
  time, temporal-state coherence, content addressing, and capture/verify over this exact
  projection before any Capsule-to-graph manifest or UI.

## Completed sub-slice: AWG-040a2

- **Classification at activation:** `missing`; the source projection was canonical and
  bounded but had no observation-time coherence, portable content address, or independent
  JSON-round-trip verifier. The existing graph receipt seals relational assertions rather
  than all-source display truth.
- **Architecture decision:** keep a second domain-specific receipt inside
  `@muse/attunement`; do not wrap display truth in the graph receipt or introduce a generic
  receipt abstraction. The Pack producer and receipt verifier share one versioned Temporal
  Rule Module, giving callers leverage and keeping all task/reminder/calendar time truth in
  one Implementation.
- **Built boundary:** pure internal capture/verify over
  `muse.continuity-source-observation.v1`. It binds the canonical all-source projection,
  caller-declared canonical observation time, and
  `muse.continuity-temporal-state.v1` under a domain-separated SHA-256 receipt ID. Exact
  envelope, semantic, temporal, UTF-8 work/byte, and integrity failures remain distinct.
- **Producer hardening:** clean Pack output remains compatible. Resolver-supplied derived
  state is stripped when task/reminder due or calendar interval prerequisites are absent,
  invalid, non-pending, incomplete, or reversed; reversed source times remain visible for
  the projection's fail-closed interval rejection.
- **Truth/privacy boundary:** content addressing proves canonical self-consistency only,
  not authenticated observation, source freshness, stop detection, causality, usefulness,
  or permission. The receipt intentionally contains personal titles, summaries, prompts,
  URLs, locations, relationships, birthdays, provider IDs, and artifact IDs; persistence
  remains prohibited pending retention, forget, export, migration, and recovery contracts.
- **Core-roadmap overlap:** none. No onboarding 103, session-handoff 211, application
  wiring, UI, automatic capture, source read, scheduling, or delivery was implemented.
- **Status:** `verified-current`; the independent completion evaluator returned `PASS`
  after independently rerunning the focused, package, changed-scope, typecheck, lint,
  build, structural-import, internal-export, exact-byte-boundary, and diff-hygiene gates.
- **Verification:** focused `4 files / 95 tests`; full `@muse/attunement`
  `34 files / 270 tests`; changed scope `20 files / 207 tests`; package/root typechecks
  and builds; root ESLint; executable import and export probes; exact
  `1,000,000`-byte receipt acceptance plus one-byte UTF-8 overflow rejection. Root build
  retained only the existing Vite chunk-size warning.
- **Completed sub-slice:** AWG-040b Capsule manifest/compiler—the paired-receipt,
  source-to-graph-bound assembly contract below is now independently verified.

## Completed sub-slice: AWG-040b

- **Classification at activation:** `missing`; AWG-040a2 preserved one canonical Source
  Observation Receipt, but an honest Capsule still needed bi-temporal previous-next-step/current truth,
  exact Graph provenance, a receipt-to-receipt change result, and bounded display data that a
  later presenter could use without rejoining live sources.
- **Implemented boundary:** an internal `@muse/attunement-graph` compiler consumes previous
  and current scoped Source Observation Receipts plus previous and current Graph Observation
  Receipts. Every pair requires exact `sourceId`, thread ID, canonical observation time,
  complete `CONTEXT_FOR`/`NEXT_STEP_FOR` source-link roles, and policy source/ref binding;
  valid graph receipts then produce the deterministic receipt-to-receipt change result.
- **Capsule contract:** the frozen, byte-bounded manifest binds all four receipt IDs and the
  change-result ID, with render-ready source snapshots for the previous observation's
  recorded next step and its current availability, the current next step, and selected
  current supporting evidence. Snapshot text is exact verified source text when present,
  never model-created text. It is not evidence of an exact observed stopping point;
  explicit stop-marker/capture remains future work. Standalone manifest verification proves
  only canonical self-consistency; dependency-aware verification receives all four receipts
  and recomputes bindings, selections, and the change result.
- **Authority and privacy:** a `draft` is display-only. An `action-preview` contains no tool
  or action payload and always requires a new approval. The compiler is caller-invoked and
  pure: no UI, persistence, source I/O, automatic observation/delivery, action, tool call,
  Graph DB/backend, or dogfooding claim. Receipt IDs, exact references, display text, thread
  title, and prepared content are local personal/linkable data, not telemetry-safe.
- **Core-roadmap overlap:** none. AWG-040b does not implement onboarding task 103,
  session-handoff task 211, application wiring, or general-purpose memory/session behavior.
- **Status:** `verified-current`. A fresh `gpt-5.6-sol`/high completion evaluator, separate
  from the makers, passed the gate after full `@muse/attunement` (35 files / 280 tests),
  full `@muse/attunement-graph` (9 files / 94 tests), changed-scope (6 files / 81 tests),
  two locale probes, package/root typechecks and builds, lint, export/import probes, and
  diff hygiene all passed. This is not a claim of product integration or user-facing
  Capsule availability.
- **Completed sub-slice: AWG-040c.** The pure, user-invoked
  `@muse/attunement-graph/continuity-capsules` library Module presents the verified bounded
  snapshots in English or Korean. It visibly attributes the reason to
  `caller-declared-owner-request`, reports automatic timing as `not-performed`, and keeps
  drafts display-only while action previews require a new approval. Its standalone verifier
  establishes canonical self-consistency only; request authentication, source freshness, and
  independent observation remain unproven. This is not a Capsule UI, CLI/API/MCP entry point,
  delivery, persistence layer, source/store join, automatic timing system, policy mutation,
  or action authority. Graph-source evidence is never silently omitted: a row or drawer over
  its verified cap fails closed instead of publishing an unverifiable omitted count. The
  fresh completion gate passed after the 128-item saturation adversary, focused manifest and
  presentation tests (`45/45`), full graph tests (`121/121`), typecheck, built export/boundary
  probes, and diff hygiene passed. AWG-040 remains `in progress` until application integration
  and an explicit-stop capture substrate are separately scoped and verified.

## Architecture gates

Every source-changing slice must preserve:

- domain semantics independent of a database SDK;
- the complete flagship experience on Muse's own local default, with every external Graph DB
  or hosted graph service remaining an optional, removable Adapter;
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
