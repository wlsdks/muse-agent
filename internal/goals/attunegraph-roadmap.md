---
title: Attunement wow + AttuneGraph roadmap
audience: [product, engineering, agents]
purpose: Run the signature Muse experience and AttuneGraph as a separate long-lived program
status: active
updated: 2026-07-31
related: [../../docs/strategy/attunement.md, ../../docs/design/attunement/attunegraph.md, ../../docs/design/attunement/agent-native-graph-core.md, attunement-implementation-plan.md]
---

# Attunement wow + AttuneGraph roadmap

This program is deliberately separate from the personal-agent core 100/300-task programs.
Those programs harden the general agent substrate. This one builds Muse's signature:

> **A procedural skill teaches an agent how to do a task better. An Attunement Policy
> teaches Muse how to collaborate with this person better.**

The two workstreams are inseparable:

- **Experience:** Shadow Muse → Continuity Capsule → Policy Card.
- **Engine:** **AttuneGraph**, a modular agent-native graph architecture
  optimized for compact context,
  temporal/provenance reasoning, abstention, policy, and action authority—not generic query
  breadth—and able to connect those relations without copying existing stores.

The long-term capture north star is a consented, local, 24-hour personal event stream:
Muse observes approved work/life transitions continuously, projects them into its own
append-oriented AttuneGraph Evidence Graph, and can pause, forget, export, and rebuild that graph
without an external Graph DB. This means continuous coverage of approved sources—not
indiscriminate screen/content surveillance. RAG may nominate semantically relevant items;
the Graph owns exact thread, identity, time, change, provenance, return, and policy
relations.

AttuneGraph is built as an independently extractable product Module inside Muse. A second Git
repository is intentionally deferred until clean-room package, dependency-isolation,
conformance, packed-artifact, export/rebuild, and license/documentation gates pass. Focused
AttuneGraph and Muse-integration commits preserve history for that later split without imposing
dual-repository version churn during rapid development. The accepted boundary is
[ADR 0001](../../docs/architecture/adr/0001-attunegraph-product-module-boundary.md). The TypeScript-first Engine,
worker-isolated SQLite Store, and benchmark-gated Rust hot-kernel policy are fixed in
[ADR 0002](../../docs/architecture/adr/0002-attunegraph-language-runtime-boundary.md).

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
| **AWG-010** | Reference graph kernel | `@attunegraph/core` domain types, invariants, append log, compact in-memory indexes, Activation Subgraph compiler, and conformance tests; no LLM or production DB | completed |
| **AWG-020** | Exact Continuity projection | Rebuildable projection of thread, artifact links, delivery, outcome, policy version, and source provenance without duplicated authority | completed |
| **AWG-030** | Explained change query | “What changed since I stopped?” returns exact temporal paths or abstains; flat/vector/graph baseline recorded | completed |
| **AWG-035a** | Observation Receipt format | Strict content-addressed codec preserves one caller-declared exact projection and source accounting without personal source text | completed |
| **AWG-035b** | Observation capture + query bridge | Raw authoritative observation produces the receipt and receipt→current uses the same AWG-030 comparison core | completed |
| **AWG-040** | Continuity Capsule v1 | Explicit Pack Preview can render the previous observation's recorded next step, changes, current next step, prepared work, expected time, and source drawer from one exact verified comparison | in progress (`AWG-040b/c/d` verified; automatic exact-stop capture and product UI pending) |
| **AWG-045a** | Canonical immutable-envelope kernel | Package-private hostile-input admission and frozen-output re-verification produce byte-identical canonical values without changing v1 codecs or exports | completed |
| **AWG-045b** | Deterministic candidate ledger | Package-private pure reducer gives every core/optional candidate one terminal state, counter vector, reason partition, and monotone fallback | completed |
| **AWG-050a** | Graph v2 semantic hardening | Integrate the verified 045 kernels into scope-safe immutable snapshots, bounded proof settlement, nomination/traversal, freshness, typed completeness, and adversarial isolation | partial (`AWG-050a1` through `050a3d3b` independently verified; explicit Pack Preview now dogfoods process-local `resumeContext`, while durable/current-world semantics remain pending) |
| **AWG-050b** | Shadow Muse ledger | Records `silent|digest|offer`, reason, evidence, bounded alternatives, and later return timing without sending or acting | partial (`AWG-050b1` binds fresh timing-policy snapshots to exact process-local Source/Graph comparison evidence; return/card/durability pending) |
| **AWG-060** | Policy Card v1 | Evidence counts, scope, proposed delta, trial/edit/reject/rollback; no hidden promotion | pending |
| **AWG-065** | Neutral AttuneGraph product boundary | Closed `AttuneGraph*` interface, forbidden-import gate, and Muse integration package keep private Continuity types outside the standalone Engine without copying validation | completed (dependency-free `@attunegraph/core` plus explicit `@muse/attunegraph` integration; no compatibility alias) |
| **AWG-070** | SQLite AttuneGraph Store v1 | Implement the selected worker-isolated `node:sqlite` default behind the AttuneGraph Store contract with version-gated physical profile, journal replay, indexes, restart/crash/corruption tests, portable export, and 10K/100K/1M operator benchmarks; record measured TS/SQLite optimization and activate a Rust kernel only when end-to-end evidence justifies it | partial (`AWG-070a1` durable projection journal, `AWG-070a2` typed Worker boundary, the `.atgx` encoder/decoder/order/budget/non-retention chain through `AWG-070a3a1a4b`, indexed validation `a4c`, POSIX staging lifecycle `a4d`, Admin protocol/fail-stop spine `a4e1`, shared physical-schema/read-only inspector core `a4e2a`, parent-owned closed-store offline snapshot lease `a4e2b1`, dedicated read-only Admin Worker/application `a4e2b2`, and public offline `./admin` plus Muse Lens CLI `a4e2b3` independently verified; export/rebuild/activation, write/repair/live-web Admin, backup, physical forget, complete profile/corpus, and 10K/100K/1M benchmarks pending) |
| **AWG-080** | Durable local graph adapter | Selected adapter passes conformance, export/rebuild, corruption, migration, forget, and crash-recovery gates | pending |
| **AWG-085** | Standalone AttuneGraph qualification | Clean-room build/test, forbidden-import audit, packed install, non-Muse example, license/security/contribution docs, and history-preserving repository split rehearsal pass without workspace dependencies | pending |
| **AWG-090** | Dogfood qualification | Controlled scenarios plus repeated organic use; reconstruction-cost and policy-correction evidence remain separately reported | pending |

Raw numbering does not activate work. Before each BUILD slice, inspect current source and
classify it as `missing`, `partial`, `built-unverified`, `verified-current`, `monitoring`,
`blocked`, `deferred`, `rejected`, or `superseded`. Implement only the missing delta.

Engineering completeness and evidence maturity are reported separately. AWG-090 organic
dogfood does not block building the product path to engineering-complete status; it does
block claims that Muse has proved usefulness, saved reconstruction time, or learned better
timing in real life.

## Current 065 activation

- **Classification:** AWG-065 is `completed`. The neutral engine has no Muse dependency;
  Muse-specific Continuity, Shadow, Capsule, evidence, and lineage code lives in the
  separate `@muse/attunegraph` package.
- **Shipped neutral delta:** the package root exports canonical `AttuneGraph*` contracts,
  `AttuneGraphError`, `openAttuneGraph`, and `createAttuneGraphEngine`. One instance binds exactly one
  `(sourceId, threadId)`, accepts only `canonical-projection@1`, executes only the bounded
  `working-graph@1`, and closes through an idempotent drain.
- **Store seam:** root `AttuneGraphStore` is an opaque WeakMap capability. The expert `/backend`
  subpath exposes `createAttuneGraphStore` and Adapter types without an extractor; `/testing`
  exposes the explicit in-memory semantic oracle and backend-neutral conformance corpus.
  No Store is selected implicitly.
- **Fail-closed behavior:** Store output is treated as hostile, canonicalized,
  scope/snapshot/content verified, detached, and deeply frozen. Corrupt/future state,
  cross-scope snapshots, stale CAS, post-close calls, and unsupported operators use typed
  `AttuneGraphError`. Concurrent identical projections converge on one snapshot; different
  projections retain one CAS winner.
- **Independent gate:** Terra/high implemented the bounded slice. Fresh Sol/high EVAL
  cycle 1 found six capability, conformance, traversal, detachment, replay, and close-race
  blockers; cycle 2 found one remaining concurrent-replay blocker. After correction, a
  third fresh Sol/high evaluator passed all nine acceptance items. The final evidence was
  325/325 package tests, 11/11 focused lifecycle tests, build, package/root typechecks,
  `test:changed` (380), focused lint, diff check, forbidden source/dist import scans, and
  public/private subpath probes.
- **Scope truth:** this is a neutral TypeScript lifecycle and in-memory semantic oracle,
  not SQLite durability, a clean-room package, a Source Adapter, a standalone release, or
  evidence of user-visible usefulness.

## Current 070a4e2b3 activation

- **Classification:** the private read-only Admin application was `verified-current`;
  its public Interface and user entry point were `missing`.
- **Maker / evaluator:** `gpt-5.6-sol` / `high` implemented the persistence-facing
  public Interface and Muse Adapter; a fresh `gpt-5.6-sol` / `high` instance performed
  the independent FULL completion gate.
- **Selection reason / escalation trigger:** the slice combines a public Interface,
  owner-local path admission, Worker lifecycle cleanup, and a user CLI, so it stayed on
  Sol. Any live-store authority, write/repair operation, broader deletion scope,
  credential/permission change, migration, or release decision escalates to a separate
  Sol/xhigh persistence or security evaluation.
- **Shipped neutral delta:** `@attunegraph/core/admin` exposes only the read-only opener,
  application/error/result/options contracts, and `AttuneGraphScope`. Qualification,
  filesystem, SQLite, snapshot, Worker transport, and inspector authority remain private.
- **Muse Adapter:** `muse attunegraph inspect` reports summary, optional integrity, and an
  optional exact scope head from one absolute normalized database path. The caller must
  explicitly pass `--source-state closed-quiescent`; invocation alone is not lifecycle proof.
  Output is single-document, path/scope-redacted, and cleanup preserves the first failure.
- **Scope truth:** this is the first AttuneGraph Lens CLI, not the future live web Admin,
  write/repair, backup/restore, export/rebuild activation, or organic usefulness evidence.
- **Independent gate:** a fresh Sol/high evaluator passed every acceptance item after
  reproducing the public builds, 35/35 focused core tests, 31/31 focused CLI tests,
  real closed-store built CLI smoke, 19/19 Module/naming gates, 391/391 changed-scope
  tests, TS7 typecheck, and lint. Full `pnpm check` also passed across all 43 tested
  workspace projects, including AttuneGraph 330/330 and CLI 4,970/4,970.

## Current 050b activation

- **Core100-075 is `verified-current`:** the existing timing store already persists
  deterministic `silent | digest | offer` candidates, bounded reasons, category-only
  evidence IDs, a decision-matched counterfactual, consent lifecycle, and zero delivery.
- **Legacy-115 activation is `superseded`:** Core100-075 owns the reducer/no-send contract.
  Its previously missing decision-time policy provenance is now covered for fresh
  candidates by `AWG-050b1`; legacy rule-v1/v2 candidates remain readable but cannot be
  AttuneGraph-bound retroactively.
- **AWG-050b1 is `verified-current`:** a fresh independent completion gate passed after
  the full Attunement suite (334/334), full AttuneGraph suite (313/313), changed-scope tests,
  builds, typechecks, focused lint, export-boundary probe, and hostile identity/dependency
  probes. Fresh
  rule-v3 timing candidates retain the exact bounded policy snapshot, and a dedicated
  `shadow-decision-receipt` subpath can bind that projection only to the original compared
  runtime result that owns its Pack and four Source/Graph receipts. The receipt is bounded,
  content-addressed, and dependency-verified only with the exact originating
  coordinator/result/Pack/timing and Source/Graph bundle; a naked serialized receipt fails
  closed. It grants no delivery, feedback, policy, or action authority. This is a library
  foundation, not automatic Shadow timing, portable restart verification, return evidence,
  a user-facing card, or durable AttuneGraph storage.

## Current 050a3 activation

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
- **AWG-050a2b2 (completed private integration):** the nominated focus assertion at the
  end of each locally closed witness now derives one of the five lanes; generic
  `LINKED_TO` remains undetermined. A bounded subset-feasibility composer separately
  receipts fair opportunity rank and actual six-axis admission, continues after oversized
  bundles, and preserves the existing v1 ledger. This verifies local witness structure and
  selection—not source truth, causality, authoritative freshness, or runtime behavior.
- **AWG-050a2c (completed private integration):** one verified caller-declared Continuity
  Observation Receipt now rebuilds a fresh private Muse graph, derives its opaque thread
  seed, performs exactly one bounded Activation traversal, and binds that captured plan and
  result to graph-owned witness paths and the existing settlement receipts. Duplicate
  logical nominations are conserved behind deterministic `core > change > support`
  representatives, while model hypotheses, caller-supplied paths/internal IDs, surplus
  frontier outcomes, and source/action authority fail closed. The linked evidence artifacts
  are content-addressed and independently capped; the aggregate is not advertised as one
  prompt payload.
- **AWG-050a3a (completed trusted-host boundary):** one Provider performs a single
  byte-bounded read of the configured local Attunement file and returns a whole-state,
  content-addressed process-local capture. Its serializable receipt proves integrity only;
  exact Provider provenance is bound to the in-process minted object, freshness remains
  `unassessed`, and missing scope abstains without asserting absence. File I/O remains
  outside `@muse/attunegraph`.
- **AWG-050a3b (completed private integration):** the private composer verifies the minted
  capture
  before state access, recomputes its bytes/digest, binds its exact scope into the existing
  graph projection and Observation Receipt, and feeds only that verified result to
  receipt-bound AttuneGraph evidence. The shared grammar represents Provider provenance
  without inventing a graph commit or generation; `unassessed` freshness forces
  settlement abstention. Focused, package, workspace, verifier, and independent completion
  gates pass.
- **AWG-050a3c (completed trusted-host temporal seam):** one Provider instance owns two
  sequential captures under a caller-required `1..30_000 ms` bound. A process-local mint
  classifies the pair as fresh, stale, or abstained; only byte-identical normalized
  endpoints within the bound enter the existing five-consumer Graph chain. The Graph
  observation remains the subject capture while the head time is recorded only as the
  assessment boundary. Scope-bound fresh provenance can settle `partial`; stale and
  abstained artifacts contain no Graph document/context fields. This proves neither
  continuous interval stability nor freshness after assessment.
- **AWG-050a3d1 (completed private prerequisite):** the exact final thread-rooted
  compilation object now retains the complete bounded pre-settlement witness pool in a
  process-local exact-identity side registry. Separate content-addressed core/optional
  entries bind canonical focus bodies and reuse the existing frozen proof
  document/assertion instances. A compact manifest conserves every fair-ranked and
  lane-undetermined optional, including candidates not admitted by the earlier settlement,
  without changing public fields, JSON, receipt/frontier IDs, settlement behavior, or
  package exports. This is evidence retention for a future resumption compiler, not a
  previous stopping boundary or `resumeContext`.
- **AWG-050a3d3a (completed runtime integration):** one coordinator instance now owns a
  bounded process-local baseline per exact `(sourceId, threadId)`, verifies the previous
  boundary and exact current Source/Graph pair, and settles the retained witness pool once
  under a fixed six-axis budget. Its 16-entry LRU, global/same-scope concurrency guards,
  capture-span/timeout/generation checks, and monotonic observation rules prevent stale or
  late work from advancing state. The returned value contains semantic-only frozen resume
  facts and grants no current-world, completeness, or action authority.
- **AWG-050a3d3b (completed application dogfood):** the existing read-only
  `muse.continuity.pack.preview` creates one Provider/coordinator per runtime assembly.
  Exact successful results reuse their same immutable Pack through a non-enumerable
  exact-identity sidecar; every unavailable result falls back to the ordinary Pack.
  Pack digest/open/delivery remain isolated and raw Provider, Source, Graph, boundary,
  audit, inventory, and budget objects never enter the tool response.
- **AWG-040d (completed explicit Capsule composition):** Pack Preview accepts one optional
  strict owner-declared preparation request. Only an exact compared runtime result that
  privately owns both its immutable Pack and the matching previous/current Source+Graph
  receipts can produce the already verified English/Korean Capsule render-data
  presentation. Preparation time is bound to the current Source observation; callers
  cannot supply timing or action authority. Seeded/unavailable/copied/cloned/wrapped/forged
  results receive one bounded `exact-compared-evidence-unavailable` Capsule result.

The full decision and dissent are in
[Muse Agent-Native Graph Core](../../docs/design/attunement/agent-native-graph-core.md). Those earlier
fail-closed findings produced AWG-045a/045b and the now verified
AWG-050a1/050a2a/050a2b1/050a2b2/050a2c seams rather than being bypassed. The Provider
capture and head-revalidation are trusted host seams, while the graph compiler remains
private deterministic substrate. The later runtime coordinator now ships bounded,
process-local `resumeContext` semantics through explicit Pack Preview, but this is not
durable/current-world truth, automatic timing, or proven user-visible wow. Its independent
completion gates forced per-Provider process ownership,
shell-before-hidden-state verification, closed Graph binding-receipt semantics, and exact
scope-derived seed verification before passing. AWG-050b now owns the actual Shadow
`silent | digest | offer` decision receipt and counterfactual.

## Completed slices: AWG-050a3d3a/b and AWG-040d

- **Product meaning:** call this capability **AttuneGraph-backed explicit resume preview**. The
  first qualifying Preview seeds one exact process-local baseline; later calls return
  bounded change and supporting facts from the verified AttuneGraph path.
- **Runtime bounds:** one assembly-local coordinator retains at most 16 baselines, admits
  four concurrent captures globally, rejects same-scope overlap, caps head revalidation at
  `1,000 ms`, and times out at `5,000 ms` without allowing a late cache write.
- **Identity and fallback:** successful exact results privately bind the immutable Pack
  used for their Source receipt. All twelve unavailable reasons use the ordinary Pack;
  copied, spread, cloned, wrapped, or proxy results cannot recover side state.
- **Tool compatibility:** no new tool was added. `previewDigest` hashes only the Pack,
  `pack.open` stays on its ordinary Pack dependency and records no Graph baseline work, and
  the Preview remains read-only with no delivery/outcome/policy write. The optional
  Capsule contains verified render data and content-addressed source-drawer receipt IDs,
  never raw receipts, audits, boundaries, retained inventories, or authority.
- **Verification:** Graph `312/312`, autoconfigure `1087/1087`, focused and changed suites,
  package/root typechecks and builds, lint, built-output verifier, full workspace checks
  before and after rebase, and separate independent completion gates passed.
- **Still not shipped:** cross-process/durable baseline storage, continuous/current-world
  freshness, exact automatic stop capture, automatic surfacing, Capsule product UI, Shadow/Policy,
  action authority, and organic usefulness qualification remain pending.

## Completed slice: AWG-050a3d1

- **Product meaning:** call this capability **bounded retained witness inventory**. A
  future resumption compiler can inspect every valid witnessed candidate from the exact
  compilation, not only documents admitted by its earlier settlement.
- **Identity and privacy contract:** one module-private `WeakMap` is keyed only by the
  exact frozen compilation object. Spread, clone, JSON, and proxy identities cannot
  recover it; no body enters the compact manifest or any public serialization.
- **Evidence contract:** core and optional entries are separately content-addressed.
  Focus assertion digests bind canonical bodies, while document IDs bind complete proof
  documents. The registry reuses the already detached/frozen pre-settlement instances
  rather than copying or recanonicalizing personal evidence.
- **Conservation and bound:** every witnessed optional appears exactly once in the fair
  ranked or raw-ID lane-undetermined partition; excluded nominations remain absent. A
  controlled boundary retains all 255 optionals with long multibyte IDs while each entry
  and the compact manifest remain inside canonical envelope limits.
- **Compatibility:** compilation keys/spread/JSON, enclosing graph-result serialization,
  old receipt/frontier IDs, settlement/context stream, package exports, runtime,
  persistence, and authority semantics are unchanged.
- **Verification:** focused tests `15/15`, Graph `264/264`, changed tests `75/75`, package
  build/typecheck, TS7 fast typecheck, built-dist verifier, full workspace check, diff
  checks, mutation-sensitive hash recomputation, and a fresh Sol completion gate pass.
- **Still not shipped:** previous stopping-boundary capture/verification, a current
  source/Graph pair resolver, one caller-budgeted `resumeContext` settlement, Capsule
  delivery, Shadow Muse, Policy Card, durable graph storage, and user-visible wow remain
  pending.

## Completed slice: AWG-050a3c

- **Product meaning:** call this capability **provider-owned bounded head
  revalidation**. The same configured-local Provider instance observes one Continuity
  subject and then its head under a required `1..30_000 ms` capture-span bound.
- **Truthful time contract:** equal endpoint state proves only
  `fresh-at-assessment`. It does not prove uninterrupted stability between reads, detect
  ABA changes, or claim freshness after the head assessment instant.
- **Process contract:** an unforgeable per-Provider owner token binds both captures.
  Revalidation verifies both endpoint mint/owner/scope shells before reading either
  hidden normalized state. A one-read Provider abstention never claims a two-capture pair.
- **Graph contract:** only exact byte count, digest, and normalized JSON equality within
  the bound enters the existing bounded five-consumer chain. The subject remains the
  observation; the head contributes only the assessment time. Stale or unavailable
  results produce no Graph document/context fields.
- **Anti-replay contract:** Provider provenance and freshness are bound to the exact
  request scope at all five direct consumer entries. The Graph binding verifier closes
  provider, reason, coverage order, endpoint cross-links, and the exact
  `continuityThreadGraphRef(providerScope)` seed.
- **Authority boundary:** fresh can settle `partial`, but still grants no absence,
  current-world, durable-source, action, permission, or policy-promotion authority.
- **Verification:** full Attunement and Graph suites, package builds/typechecks, TS7 fast
  typecheck, changed tests, seven standalone verifiers, fixed legacy IDs, adversarial
  forged-owner/receipt/seed probes, and a fresh Sol completion gate pass.
- **Still not shipped:** there is no root/runtime/API/UI/persistence/external Graph DB
  surface, verified `resumeContext`, Shadow decision runtime, Continuity Capsule delivery,
  or Policy Card promotion in this slice.

## Completed slice: AWG-050a3b

- **Product meaning:** call this capability **provider-bound AttuneGraph evidence**. Muse
  can bind one exact configured-local process mint through a verified Continuity
  Observation into its own bounded graph-evidence path without an external graph database.
- **Classification at activation:** `missing` — Provider capture and receipt-bound Graph
  compilation existed separately, but no seam could prove that the graph input was the
  exact process-minted configured-local state.
- **Status:** `completed private integration`. It has no root export, persistence,
  runtime/API/UI composition, Capsule `resumeContext`, Shadow decision, current-freshness
  proof, or action authority.
- **Truth boundary:** the composer verifies the mint before state access, independently
  recomputes normalized bytes/digest, creates and verifies the Observation Receipt, and
  uses a dedicated Provider snapshot grammar. It never maps a Provider digest to a graph
  commit/generation. A single read is `unassessed`, so the downstream result must abstain.
- **Bounds and conservation:** exactly one `SCOPED_TO` assertion becomes core; at most 255
  sorted non-model assertions become change/support nominations. Every overflow assertion
  is conserved by count and a deterministic digest, and existing six-axis graph budgets
  remain authoritative.
- **Privacy and authority:** normalized personal state is parsed once inside the private
  process seam and never serialized into Graph or binding receipts. Errors are stable and
  bounded. Receipts assert integrity links only, not current-world absence, durable
  Provider authority, permission, or action safety.
- **Maker and evaluator:** Codex root/high implemented the bounded source/test/document
  slice after Sol/high PLAN and impact gates; a fresh separate `gpt-5.6-sol`/high context
  inspected the complete tracked and untracked diff and issued `COMPLETION PASS` with no
  blockers.
- **Acceptance evidence:** 10 focused Provider-bound tests, 86 tests across the seven
  changed Graph contracts, all 243 Agent Graph tests, and all 323 Attunement tests pass.
  Both packages typecheck/build; repository TS7 fast typecheck, changed tests, full
  workspace check, changed-file lint, six standalone verifiers, diff checks, fresh
  CodeGraph, and the independent completion gate pass. The overflow fixture proves exact
  `1 core + 85 change + 170 support + 15 omitted` conservation and fixes the omitted-ID
  digest as a regression oracle.
- **Rollback:** delete the private Provider-bound source/test/verifier, remove the shared
  Provider provenance grammar and restore the five consumers to legacy snapshot grammar.
  No public API, migration, persisted state, or user-data cleanup is involved.

## Completed slice: AWG-050a3a

- **Product meaning:** call this capability **provider-observed configured-local
  Attunement snapshot**. Muse can now take one bounded, coherent local source read and
  hand the future Agent Graph an immutable whole-state snapshot without making the graph
  package read files or depend on an external graph database.
- **Classification at activation:** `missing` — graph projection and receipt integrity
  existed, but no trusted host capability could attest that input came from one configured
  local Attunement read.
- **Status:** `completed trusted-host boundary`. The host factory and narrow verification
  subpath are exported; the root barrel, persisted store schema/bytes, graph exports,
  runtime/UI, source observation codecs, recall freshness reducer, and stores are
  unchanged. It does not yet produce graph evidence, Capsule `resumeContext`, Shadow
  decisions, durable authority, or a user-visible feature.
- **Authority boundary:** the serializable receipt is `receipt-integrity-only`; Provider
  provenance belongs only to the exact module-minted process-local capture. JSON clones
  and correctly intact receipts cannot recreate it. `captureCompletedAt` is a terminal
  completion bound, not observation freshness, and coverage never asserts source,
  snapshot, or current-world absence.
- **Privacy and bounds:** raw and normalized state are independently capped at 4 MiB; the
  receipt is capped at 8 KiB. The normalized whole state is a non-enumerable immutable
  in-memory string and is excluded from receipt/capture serialization, errors, paths,
  traces, persistence, and external transmission in this seam.
- **Maker and gates:** Codex root/high implemented the Provider and adversarial tests from
  a Sol/high-approved PLAN; an independent Terra/high worker produced the standalone
  boundary verifier. Fresh independent completion evaluation is recorded in the landing
  commit.
- **Acceptance evidence:** 26 focused adversarial tests, all 323 Attunement tests, and all
  228 existing Agent Graph tests passed. Attunement/Graph typechecks, Attunement build,
  repository TS7 fast typecheck, changed tests, standalone public-subpath verification,
  changed-file lint, diff check, and fresh CodeGraph passed.
- **Rollback:** delete the Provider source/test/verifier, remove the trusted-host export,
  narrow `continuity-snapshots` export-map entry and surface test additions, and remove
  this documentation. No migration or user-data cleanup is required.

## Completed slice: AWG-050a2c

- **Product meaning:** call this capability **receipt-bound AttuneGraph evidence
  compilation**. It is the first complete private execution path from an exact Continuity
  receipt through Muse's own temporal graph, one bounded Activation traversal, graph-owned
  explanation paths, and budget settlement.
- **Classification at activation:** `missing` — all constituent kernels existed, but no
  compiler bound one verified receipt, opaque graph identity, actual traversal, duplicate
  nominations, and settled proof evidence into one fail-closed composition.
- **Status:** `completed private integration`. It has no public export, persistence,
  external graph database, Provider/runtime/UI integration, source/freshness authority, or
  user-visible wow claim.
- **Maker:** Codex root/high for the compiler and tests; a bounded fresh
  `gpt-5.6-terra`/high worker produced the standalone verifier after the PLAN gate.
- **Evaluators:** independent Sol/high PLAN gate passed after two material correction
  rounds; a separate fresh Sol/high architecture review passed; the fresh Sol/high
  completion gate failed once on frontier conservation and adversarial coverage, then
  issued `COMPLETION PASS` after both were closed.
- **Acceptance evidence:** 34 focused adversarial tests and all 228 package tests passed;
  package typecheck/build, repository-authoritative `pnpm typecheck:fast`,
  `pnpm test:changed`, standalone verifier, changed-file lint, diff check, and a fresh
  CodeGraph index passed. The compatibility `pnpm typecheck` probe still reports the
  pre-existing untouched `packages/eval-datasets/src/seams.ts` schema-version mismatch;
  that unrelated repair was not absorbed into this Graph slice.
- **Rollback:** delete the three private compiler/test/verifier files and their exact
  ignored dist artifacts plus package build info, then rebuild. No public or persisted
  state requires migration.

## Completed slice: AWG-050a2b2

- **Product meaning:** the private compiler selects compact graph context from its finite,
  locally validated thread-rooted witness pool, then continues testing later relations
  when an earlier witness is over budget. Product updates should call this capability
  **witness-derived fair context admission**, not its internal ledger ID.
- **Classification at activation:** `missing` — fair opportunity order existed, but lane
  meanings were caller-declared and the generic first-failure ledger could starve every
  later candidate.
- **Status:** `completed private integration` — locally validated focus semantics, fair
  opportunity rank, and actual six-axis admission are composed and separately receipted.
  Source truth, causality, authoritative freshness, persistence, runtime/UI, and user
  usefulness remain unproved.
- **Maker:** Codex root worker, Sol-class semantic-integrity BUILD with inherited high
  reasoning.
- **Evaluator:** independent PLAN evaluator after one material correction round; fresh
  `gpt-5.6-sol` with high reasoning issued `COMPLETION PASS` in a separate context.
- **Selection reason:** graph relations only help an agent when they determine which
  grounded context enters a bounded turn. This remains pure, private TypeScript and reuses
  the verified proof and ledger kernels.
- **Acceptance:** exact focus/path/body parity; explicit mapping for all 17 predicates;
  `LINKED_TO` abstention; one-per-lane fair order; core-first settlement; partial,
  abstained, and minimum-capacity-invalid partitions; exact six-axis translation;
  oversized-candidate continuation; cross-receipt conservation; content-addressed frozen
  output; no authority or completeness expansion.
- **Evidence:** 13/13 focused tests, 187/187 package tests, package/root typechecks, build,
  changed tests, lint, diff check, two standalone literal receipt verifiers, and fresh
  Sol/high PASS. The 255-optional verifier conserved every disposition, used exactly 256
  settlement invocations, admitted a later fit after the first oversized candidate, and
  observed about 1.65 seconds locally without promoting that observation to a production
  performance claim.
- **Rollback:** remove the new private composer/test/verifier and restore the compiler's
  previous direct settlement call. There is no export, migration, stored data, or runtime
  cleanup.

## Completed slice: AWG-050a2b1

- **Product meaning:** when one caller-declared kind of graph opportunity overwhelms the
  candidate pool, Muse can still give Continuity, Change, Evidence, Policy, and Authority
  lanes a fair turn. This prerequisite does not yet verify or derive those candidate
  meanings. The internal ID is not product language.
- **Classification at activation:** `missing` — exact thread-rooted witnesses existed, but
  the candidate settlement rank could still let a crowded relation family dominate.
- **Status:** `completed private prerequisite` — deterministic opportunity ordering is
  verified at its caller-declared boundary; the later AWG-050a2b2 integration now supplies
  locally witness-derived lane assignment and actual budget-admission accounting.
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
- **Shipped boundary:** pure `@muse/attunegraph/continuity-changes` library subpath;
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
  `@muse/attunegraph/continuity-observations` library subpath with two functions:
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
- **Implemented boundary:** an internal `@muse/attunegraph` compiler consumes previous
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
  full `@muse/attunegraph` (9 files / 94 tests), changed-scope (6 files / 81 tests),
  two locale probes, package/root typechecks and builds, lint, export/import probes, and
  diff hygiene all passed. This is not a claim of product integration or user-facing
  Capsule availability.
- **Completed sub-slice: AWG-040c.** The pure, user-invoked
  `@muse/attunegraph/continuity-capsules` library Module presents the verified bounded
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
- provider-neutral core, explicit deployment placement, and a fully supported opt-in
  local-only posture.

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
[the graph design](../../docs/design/attunement/attunegraph.md). Research is refreshed at storage
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
