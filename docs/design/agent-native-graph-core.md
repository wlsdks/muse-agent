---
title: Muse Agent-Native Graph Core — semantic engine and local storage blueprint
audience: [engineering, product, security, agents]
purpose: Fix the core architecture and staged delivery plan for Muse's built-in graph engine
status: decision-proposal
updated: 2026-07-29
related: [attunement-graph.md, ../goals/attunement-wow-graph-roadmap.md, ../../CONTEXT.md]
---

# Muse Agent-Native Graph Core

> **Decision:** Muse owns the graph semantics, temporal/provenance model, operator
> algebra, completeness rules, portable journal, and local lifecycle. A small embedded
> database may provide transactions and indexes, but it is an internal Adapter—not Muse's
> graph product, public API, or a requirement for the flagship experience.

This is the implementation blueprint beneath
[Attunement Graph Engine](attunement-graph.md). It synthesizes independent Sol-class
architecture reviews, direct source inspection, and current primary-source research. It
does not claim the durable engine is implemented.

The target is not a smaller Neo4j. It is a graph engine optimized for an AI agent that must
assemble a small truthful context, reason over change, show its evidence, know when its
answer is incomplete, and avoid expanding action authority.

## Product-level invariants

The complete Shadow Muse, Continuity Capsule, and Policy Card path must work with Muse
alone.

- No external Graph DB, graph daemon, graph account, hosted graph service, or graph-specific
  model/embedding call is required. A configured Muse model may phrase a result, but exact
  graph operators do not depend on it.
- Authoritative task, note, calendar, contact, memory, and Attunement stores remain the
  sources of truth.
- The Evidence Graph is a disposable, rebuildable projection.
- The model receives a proof-closed Working Graph, not arbitrary database access.
- Absence is asserted only when the result carries a valid completeness proof for its exact
  scope, snapshot, and operator.
- Graph evidence may inform a proposal; it never grants permission, promotes feedback,
  infers causality, or authorizes an action.
- Forget means physical removal from the selected generation and its derived closure, not
  merely hiding a row from queries.

## Current-state decision

| Area | Classification | Consequence |
|---|---|---|
| Assertion ontology, epistemic class, bi-temporal fields, provenance | `verified-current` | Preserve the v1 semantic kernel. |
| In-memory append/traverse/forget adapter | `verified-current` as a reference adapter | Keep it as the semantic oracle, not as durable storage. |
| Activation Subgraph v1 | `partial` | It is bounded, but not yet scope-safe or proof-closed enough for flagship decisions. |
| Continuity projection/change/observation/Capsule Modules | `verified-current` at their documented pure boundaries | Reuse them as the first operator workload; do not reimplement them in a database layer. |
| Logical append journal and immutable lifecycle | `partial` | Current live insertion order is not a durable append-only history; later retraction needs separate events. |
| Shadow Muse, Policy Card, runtime composition | `missing` | They remain the next product-shaped workloads. |
| Durable local engine, recovery, migration, physical forget | `missing` | Do not select or build storage before the v2 semantic contract. |

Two current contracts need explicit correction:

1. `GraphQueryPlan` has no projection scope. An artifact shared by two threads can bridge
   from one thread to another within two hops.
2. `GraphAssertion.supersededAt` is immutable assertion content, while append collision
   rules correctly reject changing the same assertion. Later supersession therefore
   belongs in a separate immutable lifecycle event.

## Architecture

```text
authoritative Muse stores
  ├─ source resolvers
  ├─ Source Observation Receipt vault
  │    └─ personal display truth and its own retention policy
  └─ deterministic projectors
       └─ Projection Commit
            └─ Muse Evidence Graph
                 ├─ logical commit journal
                 ├─ assertion, scope, time, and provenance indexes
                 ├─ immutable lifecycle events
                 ├─ observation receipts and projection heads
                 └─ scoped read snapshots
                      └─ versioned operator compiler
                           ├─ changesSince
                           ├─ resumeContext
                           ├─ decisionCounterfactual
                           ├─ policyEvidence
                           └─ forgetImpact
                                └─ proof-closed Working Graph
                                     └─ value | partial | abstained
```

The Source Observation Receipt vault and graph storage are intentionally separate. Source
receipts contain personal display text such as titles, summaries, URLs, locations, and
relationships. The graph stores exact receipt IDs and bounded relational assertions, not
those display bodies. A Capsule joins them only through the already verified receipt
binding contract.

### Deep Modules

`@muse/attunement-graph` should expose product operators and keep general traversal,
storage queries, SQL, and backend capabilities internal.

- **Projection Module:** validates and commits deterministic deltas against one expected
  projection head.
- **Snapshot Module:** opens one immutable generation/commit view and never mixes data from
  two commits.
- **Operator Module:** compiles a closed, versioned plan with scope, predicates,
  epistemic filters, mandatory proof branches, and budgets.
- **Explanation Module:** resolves every published relation to its exact source references
  and derivation.
- **Maintenance Module:** rebuild, verify, export, migrate, compact, and physically forget;
  it is an admin boundary and never a model tool.
- **Backend Adapter:** supplies transactions and indexes without defining domain meaning.

Applications remain the composition root. The graph package must not import every personal
store or become an alternative source authority.

## Core contracts for v2

These shapes are design targets. Exact names may change during a fresh PLAN gate, but the
semantics may not be weakened.

```ts
interface GraphScope {
  readonly sourceId: string;
  readonly threadId: string;
}

interface GraphSnapshot {
  readonly generationId: string;
  readonly commitSequence: number;
  readonly commitHash: string;
}

interface GraphOperatorBudget {
  readonly maxDepth: number;
  readonly maxAssertions: number;
  readonly maxConsideredAssertions: number;
  readonly maxVisitedRefs: number;
  readonly maxOutputBytes: number;
  readonly maxEstimatedTokens: number;
}

type GraphCompleteness =
  | {
      readonly status: "complete";
      readonly canAssertAbsenceWithinSnapshot: true;
    }
  | {
      readonly status: "partial";
      readonly canAssertAbsenceWithinSnapshot: false;
      readonly reasons: readonly GraphIncompletenessReason[];
    }
  | {
      readonly status: "abstained";
      readonly canAssertAbsenceWithinSnapshot: false;
      readonly reasons: readonly GraphAbstentionReason[];
    };

interface GraphOperatorEnvelope {
  readonly schemaVersion: 1;
  readonly operatorVersion: string;
  readonly scope: GraphScope;
  readonly snapshot: GraphSnapshot;
  readonly freshness: "fresh" | "stale" | "rebuilding" | "unavailable";
  readonly resultId: string;
}

type GraphOperatorResult<T> =
  | (GraphOperatorEnvelope & {
      readonly completeness: Extract<GraphCompleteness, { status: "complete" }>;
      readonly value: T;
    })
  | (GraphOperatorEnvelope & {
      readonly completeness: Extract<GraphCompleteness, { status: "partial" }>;
      readonly value: T;
    })
  | (GraphOperatorEnvelope & {
      readonly completeness: Extract<GraphCompleteness, { status: "abstained" }>;
      readonly value?: never;
    });
```

An omitted numeric count must not be invented. If bounded work cannot determine an exact
count, the result records a typed reason and
`canAssertAbsenceWithinSnapshot: false`. If a mandatory proof bundle cannot fit, the
operator abstains instead of returning a plausible fragment. Current-world absence may be
asserted only when completeness is `complete` **and** freshness is `fresh`; snapshot
completeness never upgrades stale data. `freshness: "unavailable"` always requires
`status: "abstained"` with no `value`.

`maxEstimatedTokens` is an admission hint, not a safety boundary. Korean and other
tokenizers can diverge sharply from a UTF-8-byte heuristic, so every operator also has a
hard canonical byte limit. A future tokenizer Port may improve packing without changing
the byte gate.

### Scoped snapshots

Every serving query runs inside one `GraphScope` and one immutable `GraphSnapshot`.

- Scope membership is stored explicitly for each assertion.
- Shared artifacts may belong to multiple scopes, but traversal never crosses membership
  without a separately authorized multi-scope operator.
- Projection head, assertions, lifecycle state, and observation receipt are read from the
  same snapshot.
- Freshness is part of the returned contract. Corruption, an unsupported future version,
  or an incomplete rebuild yields `unavailable`, not an empty graph.

### Proof-closed activation

Activation v1 ranks individual assertions after bounded traversal. This can starve a
high-value path when high-degree or early-insertion neighbors consume the work budget.
Activation v2 ranks indivisible explanation bundles while the traversal frontier is being
admitted.

A `resumeContext` bundle contains, as applicable:

- exact thread identity and scope;
- previous and current next-step bindings;
- every returned change's complete explanation path;
- exact source-resolution state;
- governing policy version and scope;
- action-authority boundary;
- contradictions, missing evidence, and freshness state.

Dropping any mandatory member drops the whole bundle. Ranking can choose between complete
bundles; it cannot publish a change without its proof or a proposed action without its
authority boundary.

### Versioned operators, not arbitrary graph queries

The model may select a known operator and phrase a verified result. It may not generate
SQL, Cypher, arbitrary predicates, or unbounded traversal plans.

| Operator | Direct product use | Required negative outcome |
|---|---|---|
| `changesSince` | What changed after a receipt-bound boundary? | Typed abstention when time, revision, path, or observation evidence is ambiguous. |
| `resumeContext` | Smallest sufficient Capsule context | Abstain when mandatory proof does not fit or freshness is unavailable. |
| `decisionCounterfactual` | Why Shadow Muse spoke or stayed quiet; what bounded alternative existed? | Store reason codes and selected alternatives, never chain-of-thought. |
| `policyEvidence` | Evidence for a scoped, reversible Policy Card | Never infer a global rule or promote proximity/factual interaction to feedback. |
| `forgetImpact` | Preview exactly what a source removal invalidates | Never execute deletion or source mutation. |

## Logical journal and projection commits

The durable history is a hash-linked logical journal even if SQLite stores it physically.
Canonical records are append-only within one retained generation:

```ts
type GraphJournalRecord =
  | { readonly kind: "assertion-added"; readonly assertion: GraphAssertion }
  | {
      readonly kind: "assertion-retracted";
      readonly assertionId: string;
      readonly recordedAt: string;
      readonly reason: "projection-replaced" | "source-invalidated";
      readonly sourceRefs: readonly GraphEvidenceRef[];
    }
  | {
      readonly kind: "assertion-superseded";
      readonly assertionId: string;
      readonly replacementAssertionId: string;
      readonly recordedAt: string;
      readonly sourceRefs: readonly GraphEvidenceRef[];
    }
  | { readonly kind: "graph-observation-stored"; readonly receiptId: string }
  | { readonly kind: "projection-head-moved"; readonly scope: GraphScope };
```

A projection commit is one transaction:

1. Verify source/graph receipt binding, projection digest, assertion invariants, scope, and
   every declared resource bound.
2. Compare-and-swap the expected projection head.
3. Validate all assertion IDs and fingerprints before mutation.
4. Append canonical journal records.
5. Materialize assertions, scope membership, provenance, lifecycle, and adjacency/time
   indexes.
6. Store the Graph Observation Receipt.
7. Move the projection head and commit once.

Replaying the same commit ID with identical bytes is idempotent. Reusing an ID with
different bytes is a collision and fails closed.

## Lightweight local storage

### Recommended default candidate

Use a Muse-owned schema over capability-gated `node:sqlite` as the first durable candidate.
SQLite supplies crash consistency, atomic transactions, compact indexes, and a single-file
local deployment. It does not define graph semantics, expose SQL publicly, or become a
required external Graph DB.

This is a candidate decision, not implementation authorization:

- Muse currently supports Node `>=22.12`; Node 22.12 requires
  `--experimental-sqlite`, while Node 22.13 unflags the module. AWG-070 must decide whether
  to raise the effective durable-engine minimum, ship a capability-gated fallback, or use a
  different binding.
- SQLite's official WAL documentation records a rare multi-connection reset/checkpoint
  corruption bug through 3.51.2, fixed in 3.51.3 with selected backports. Any WAL profile
  must inspect the bundled SQLite version and fail closed or choose a safe non-WAL mode.
- Start with one writer. Reader concurrency, checkpoints, durability pragmas, file
  permissions, and shutdown behavior are explicit conformance inputs.
- Extension loading remains disabled.

Do not build a custom physical WAL. Muse owns the logical journal; SQLite or another proven
embedded substrate owns fsync, locking, and crash recovery.

### Candidate physical layout

```text
~/.muse/attunement-graph/
  CURRENT
  graph-<generation-id>.sqlite
  graph-<generation-id>.sqlite-wal
  graph-<generation-id>.sqlite-shm
  quarantine/
```

The directory and files use owner-only permissions. `CURRENT` points to a fully verified
generation. Rebuild, migration, compaction, and physical forget create and verify a new
generation before an atomic pointer swap.

Minimum tables:

- `meta` — engine, journal, assertion, index, and compatibility versions;
- `commits` and `commit_records` — sequence, hashes, scope, and canonical records;
- `refs` and `source_refs` — compact interned identifiers;
- `assertions` — canonical bytes plus extracted hot-path columns;
- `assertion_sources` and derived dependencies — reverse provenance;
- `assertion_scopes` — mandatory isolation membership;
- `assertion_lifecycle` — immutable retraction/supersession;
- `projection_heads` — version, receipt, freshness, and commit per scope;
- `graph_observations` — verified relational receipts only.

Canonical assertion bytes remain the export/conformance truth. SQL columns and indexes are
materializations, not an alternative semantic representation.

### Three-temperature runtime

1. **Cold truth:** authoritative stores and source receipts; no graph-owned copy of personal
   display text.
2. **Warm thread projection:** compact indexes for active/recently requested scopes,
   evictable and rebuildable.
3. **Hot Working Graph:** one frozen, proof-closed, byte/token-bounded operator result;
   discarded candidates and private reasoning are not persisted.

This keeps cost proportional to active threads and selected operators, not to the user's
entire digital life.

## Recovery, migration, and physical forget

- Startup checks format/capability versions, database integrity, journal hash tail,
  projection heads, and index consistency.
- Corrupt or future-version state is quarantined and reported `unavailable`; Muse never
  silently opens an empty graph and claims no change.
- Index-only migrations rebuild freely. Semantic/journal migrations create a new
  generation and retain a portable verified export until the replacement passes.
- Normal compaction may rebuild indexes and remove dead generations. Historical provenance
  is not pruned until a reviewed retention contract exists.
- Projection eviction is not privacy forget.
- Physical forget requires an authoritative disposition receipt, computes the exact
  dependency closure, rewrites a generation without those records and identifiers,
  verifies it, swaps `CURRENT`, and deletes the old database plus WAL/SHM files.
- The removal inventory includes portable exports, quarantined generations, temporary
  rewrite files, and backups owned by this Module; a retained export is still retained
  personal data.
- If old-generation cleanup fails, the receipt reports `pending-physical-deletion`; it must
  not claim completion.

SQLite documents that ordinary deletion can leave recoverable page content. A generation
rewrite or verified `VACUUM`/secure-delete policy is therefore part of the privacy gate,
not an optional optimization.

## Benchmark and qualification matrix

All numbers below are provisional gates to test on recorded reference hardware, not current
performance claims.

| Path | Initial target |
|---|---|
| Warm scoped operator | p95 at or below 50 ms |
| Cold thread load plus operator | p95 at or below 200 ms |
| Typical projection commit | p95 at or below 100 ms |
| Normal startup | p95 at or below 300 ms |
| Crash reopen/recovery | p95 at or below 2 s |
| Deterministic rebuild at 100k assertions | at or below 30 s |
| Baseline engine memory | at or below 64 MiB |
| One warm-thread cache | at or below 16 MiB |
| Exact operators | zero model and zero embedding calls |

Every benchmark compares:

- flat exact lookup;
- the in-memory semantic oracle;
- the durable candidate;
- vector/lexical retrieval only where semantic seed nomination is relevant;
- at most one embedded property-graph candidate.

Required correctness scenarios include cross-thread shared-artifact leakage, high-degree
starvation, snapshot mixing, missing proof closure, stale projection, crash tails, corrupt
and future versions, commit collisions, deterministic rebuild, physical forget, Korean
byte/token divergence, and cross-backend result identity.

Latency never compensates for a wrong source path, temporal answer, scope, completeness
claim, or authority boundary.

## Research synthesis

Research was refreshed from primary or project-maintained sources on 2026-07-29.

- [Microsoft GraphRAG indexing](https://microsoft.github.io/graphrag/index/overview/)
  validates useful entity, relationship, claim, community, and vector pipelines, but its
  standard path is an LLM-based transformation pipeline over unstructured corpora. It is
  not Muse's hot per-turn engine.
- [Graphiti](https://github.com/getzep/graphiti) validates temporal validity, episodes,
  lineage, incremental construction, and hybrid retrieval. Its open-source path still asks
  users to bring a graph backend and defaults to model/embedding services, so Muse adopts
  the concepts rather than the dependency topology or authority model.
- [Mem0's maintained v2-to-v3 migration](https://github.com/mem0ai/mem0/blob/main/docs/migration/oss-v2-to-v3.mdx)
  removed external graph-store paths and replaced them with built-in entity linking. This
  is strong maintenance evidence against carrying backend breadth without product proof;
  Muse still needs directly traversable provenance and temporal operators, so it should
  not reduce its graph to a ranking boost.
- [LadybugDB](https://github.com/LadybugDB/ladybug) is an embedded, serverless property
  graph with Node bindings and serious analytical machinery. That breadth makes it a useful
  optional bake-off candidate, not the default semantic architecture.
- [Node SQLite](https://nodejs.org/download/release/v22.12.0/docs/api/sqlite.html),
  [SQLite WAL](https://www.sqlite.org/wal.html), and
  [SQLite VACUUM](https://www.sqlite.org/lang_vacuum.html) support a lightweight local
  candidate while exposing concrete version, concurrency, and deletion requirements that
  must be gated.
- [W3C PROV-O](https://www.w3.org/TR/prov-o/) supplies useful meanings for derivation,
  revision, primary source, generation, invalidation, and provenance bundles. Muse adopts
  selected semantics without making RDF or OWL a runtime requirement.

Recent preprints may inspire bounded operator and memory designs, but their reported
benchmarks are not Muse evidence. They cannot select the backend or qualify the product.

### Independent review synthesis

| Review lens | Strongest recommendation | Concern retained in this blueprint |
|---|---|---|
| Semantic-core review, Sol ultra | Keep Muse's domain and operator semantics independent; use SQLite only for durability/indexes | Current scope-less traversal and mutable-looking supersession model must be fixed before storage. |
| Research/architecture critic, Sol xhigh | Use one per-thread in-memory Working Graph over a local durable Adapter; require typed completeness | Ranking after traversal, token estimation, freshness, and physical forget are insufficiently explicit in v1. |
| Product/maintenance synthesis | Build Shadow and Policy workloads before choosing the durable backend | A generic graph engine or broad backend matrix can consume years without producing the Muse moment. |

The reviews disagreed mainly on how strongly to name SQLite before a bake-off. This
blueprint names it as the first candidate because it is the smallest credible transactional
substrate, while withholding selection until capability, recovery, forget, portability,
and product-query gates pass.

## Alternatives and dissent

### Recommended: Muse semantics over an embedded transactional substrate

This keeps the product unique while delegating filesystem correctness to a mature storage
layer. The in-memory implementation remains the executable semantic oracle.

The implementation language is also an Adapter decision, not a product identity. TypeScript
remains the semantic oracle while it is fast enough and keeps the verified contracts closest
to Muse's runtime. Rust or another native implementation is allowed only after profiling
finds a real bottleneck or isolation/recovery need, and only when it reproduces canonical
bytes, content IDs, settlement modes/reasons/counters, context bytes, and fault vectors
byte-for-byte. No FFI or sidecar is added merely because a native rewrite sounds faster.

### Custom segmented log plus in-memory indexes

It is attractive for control and small installs, but rejected as the default durable path.
It would make Muse responsible for WAL recovery, fsync semantics, file locking, concurrent
read snapshots, compaction, migration, and cross-platform failure modes before those
provide user-visible Attunement value.

### Embedded property graph

Keep one candidate for AWG-070. It wins only if measured product operators justify its
binary size, query/runtime breadth, binding lifecycle, and maintenance coupling. Cypher
support alone has no value to Muse.

### PostgreSQL

It can remain an optional conformance Adapter for installations already using it. It cannot
be required for the local flagship path.

### Raw JSON or NDJSON

Use it as a canonical portable export, not as transactional serving storage.

### Unresolved decisions

- Node 22.12 compatibility strategy for an unflagged SQLite path;
- exact durability/checkpoint policy after crash and power-loss tests;
- whether LadybugDB remains healthy enough at AWG-070 to merit the one comparison slot;
- source-receipt vault retention and encryption policy;
- measured cache sizes and eviction rhythm from real dogfood;
- whether any operator benefits enough from lexical/vector seed nomination to pay its cost.

## Pre-integration semantic kernels

The first `resumeContext` PLAN reviews found two contracts that must be proven separately.
They are internal semantic kernels, not new product surfaces or shipped Graph DB features.

### Canonical immutable envelope

Canonical content and JavaScript object representation are different concerns. A value
freshly parsed from JSON normally has writable descriptors; the same value returned by Muse
has non-writable array indices and `length` after deep freeze. Requiring one descriptor
shape for both makes normal capture → verify → resume impossible.

The v2 kernel therefore admits exactly two uniform whole-tree profiles:

| Profile | Container | Ordinary/index data properties | Array `length` |
|---|---|---|---|
| `external-mutable` | extensible | writable, enumerable, configurable | writable, non-enumerable, non-configurable |
| `muse-frozen` | `Object.isFrozen` | non-writable, enumerable, non-configurable | non-writable, non-enumerable, non-configurable |

Both profiles rebuild a detached canonical tree and produce identical canonical JSON,
bytes, and IDs. A mixed, shallow-frozen, merely sealed, accessor-bearing, symbolic, sparse,
aliased/cyclic, proxy, or unsupported-prototype tree fails closed. Verification never
returns caller-owned data. The canonical encoder orders object keys by raw UTF-16 code
units directly; it does not depend on `JSON.stringify` property enumeration for
integer-like keys. Descriptor accounting charges each container and ordinary/index field
but not the one permitted array `length`.

The lifecycle is fixed:

```text
inspect profile → detach → domain normalize → enforce caps
→ canonical UTF-8 → domain-NUL SHA-256 → attach ID
→ full-envelope cap → deep-freeze children first → verify frozen postconditions
```

This helper stays package-private until more than one proven domain requires the same
surface. Existing v1 observation, change, and Capsule codecs remain byte-for-byte
untouched.

### Candidate settlement ledger

`resumeContext` must not derive diagnostics by mutating a partially serialized result.
It first builds an abstract candidate inventory and settles it through one pure reducer.
Every candidate has exactly one published terminal state:

```text
admitted | rejected | failed | skipped
```

Core settles before optionals. Semantic preflight does not consume traversal work;
rejected candidates never rank. Eligible optionals rank deterministically, then pass gates
in the fixed order `depth → considered → visited → assertions → token → bytes`. Each gate
commits an explicit delta. Token or output failure retains already committed
considered/visited work, rolls back only staged publication, and assigns one reason.

The selected logical ledger—not discarded speculative serialization—is diagnostic truth:

```text
candidateCount = admitted + rejected + failed + skipped
```

If the mandatory reason and diagnostic envelope itself no longer fits, the reducer selects
a fresh ledger through a monotone fallback:

```text
normal → core-only(first violated axis)
       → abstain(first violated axis)
       → invalid-input(exact minimum required)
```

This makes rollback, counters, reasons, IDs, and exact-limit golden vectors unique. Physical
attempt counts, if later useful for performance tracing, belong in a separate trace metric
and never change the semantic result.

## Staged delivery

Do not build the database first.

1. **AWG-045a — canonical immutable-envelope kernel:** one package-private v2 helper
   admits hostile external mutable values or re-verifies Muse-frozen values through two
   exact, whole-tree descriptor profiles. Both profiles rebuild a detached value with the
   same direct canonical encoding, byte count, and content ID. Dense arrays permit only
   indexed data properties plus `length`; mutable admission requires writable ordinary
   descriptors, while frozen re-verification requires the corresponding non-writable,
   non-configurable descriptors. Mixed, shallow-frozen, sealed, accessor-bearing, symbolic,
   sparse, aliased/cyclic, proxy, and unsupported-prototype graphs fail. Descriptor
   accounting excludes only array `length`. No export map or existing v1 codec changes.
2. **AWG-045b — deterministic candidate ledger:** one package-private pure reducer owns
   candidate terminal states, budget-gate order, counters, reason partition, and fallback.
   Core is settled first; semantic rejects do not rank or consume work counters; eligible
   optionals rank deterministically. Candidate conservation is exact:
   `candidateCount = admitted + rejected + failed + skipped`. Token/byte failure rolls back
   staged publication but retains that candidate's committed considered/visited work.
   Mandatory-overhead failure selects a new logical ledger through the monotone lattice
   `normal → core-only → abstain → invalid-input`; diagnostics describe only the selected
   ledger, never discarded speculative attempts.
3. **AWG-050a — semantic hardening integration:** split into bounded private seams.
   **AWG-050a1 is complete:** hostile caller-nominated scoped proof documents pass through
   AWG-045a, exact local proof/freshness validation, AWG-045b settlement, and byte-exact
   context materialization without a public export or completeness claim.
   **AWG-050a2a is complete:** one exact Continuity thread seeds a content-addressed,
   bounded, deterministic witness traversal that produces locally closed documents for
   050a1, accounts for excluded optional nominations, and abstains when the core witness is
   unavailable. **AWG-050a2b1 is complete:** caller-declared opportunities carrying
   syntactically valid proof-document IDs receive a content-addressed one-per-lane
   round-robin order across caller-declared Continuity, Change, Evidence, Policy, and
   Authority lanes without claiming the referenced witnesses are verified or the lanes
   are authoritative or budget-admitted.
   **AWG-050a2b2 is complete:** the exact nominated focus assertion derives a lane for each
   locally closed witness, generic `LINKED_TO` abstains, and a bounded subset-feasibility
   composer separately receipts fair opportunity order and actual six-axis admission while
   continuing after an oversized bundle. The generic v1 ledger is unchanged.
   **AWG-050a3a is complete:** one trusted-host Provider now performs a byte-bounded read
   of its configured local Attunement file, produces a whole-state content-addressed
   capture, and separates process-local mint provenance from serializable receipt
   integrity. Freshness remains `unassessed`; missing scope does not establish absence.
   **AWG-050a3b is independently verified as a private process-local seam:** it verifies
   the mint
   before state access, independently checks normalized bytes/digest, produces and verifies
   the Continuity Observation Receipt, derives bounded nominations, and composes the
   existing receipt-bound evidence path under truthful Provider snapshot provenance.
   `unassessed` freshness forces settlement abstention rather than an invented graph
   generation or current-world claim.
   **AWG-050a3c is independently verified:** a single
   Provider-owned capability validates a required capture-span bound before I/O, performs
   two sequential same-instance captures, and mints a process-local classification.
   Byte-identical normalized endpoints within the bound produce fresh-at-assessment-only,
   scope-bound Graph provenance; changed, over-span, or unavailable endpoints produce no
   Graph document/context fields. The subject remains the Graph observation and the head
   is only the assessment instant. This is not ABA detection, continuous stability,
   durable source authority, or freshness after assessment. Continuity `resumeContext`
   remains a later 050a3 seam. Pure and in-memory until those semantics pass.
4. **AWG-050b — Shadow decision receipt:** `silent | digest | offer`, bounded reason and
   counterfactual, later return timing; no sending, action, or chain-of-thought storage.
5. **AWG-060 — Policy evidence/Card contract:** scoped proposal, evidence, trial, edit,
   reject, rollback, and no hidden promotion.
6. **AWG-070a — backend v2 conformance:** snapshot identity, projection compare-and-swap,
   restart, crash, corruption, future version, lifecycle, physical-forget fixtures, and
   byte-identical operator results.
7. **AWG-070b — storage bake-off:** prototype the capability-gated SQLite candidate and at
   most one embedded property graph against the oracle and flat baseline.
8. **AWG-080 — durable engine:** recovery/export/rebuild, generation migration/compaction,
   authorized physical forget, then local runtime composition.
9. **AWG-090 — qualification:** controlled scenarios followed by repeated local dogfood;
   usefulness, reconstruction cost, policy correction, and silence quality stay separate.

AWG-045a, AWG-045b, AWG-050a1, AWG-050a2a, AWG-050a2b1, AWG-050a2b2, AWG-050a2c,
AWG-050a3a, AWG-050a3b, and AWG-050a3c are independently verified bounded kernels or
trusted-host seams. All retain no Provider-bound graph root export or existing v1 codec
expansion.
Together they now prove deterministic hostile admission → exact thread-rooted witness
traversal → local proof validation → focus-derived lane → fair opportunity order → bounded
subset feasibility → exact context bytes → verified process-local Provider ownership →
bounded two-endpoint assessment → observation and receipt-bound graph evidence. This is an
end-to-end claim only over one configured-local subject, one bounded head assessment, and
their finite evidence pool; it is not continuous or current freshness, causality,
completeness, persistence, or user value. The Provider-bound paths make no authoritative
absence, permission, or action claim.
Persistence remains explicitly out of scope until freshness, Shadow, and Policy workloads
make the backend requirements real.

Core semantic and persistence PLAN work uses `gpt-5.6-sol` at `ultra` or `xhigh`;
implementation begins only from a bounded accepted handoff, and completion uses a fresh
independent Sol context. Maker and evaluator roles may not share context.
