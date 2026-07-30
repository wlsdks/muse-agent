# Muse Attunement Graph

**Muse Attunement Graph (MAG)** is a local-first, agent-native temporal and provenance
graph. It compiles a small, verified **Working Graph** for one agent decision instead of
making a model search an unbounded personal knowledge graph.

MAG is designed for the questions a continuing personal agent must answer safely:

- What changed since this person stopped?
- Which exact observations support this conclusion?
- Is this context complete, partial, stale, or unavailable?
- Which policy applied when a suggestion was made?
- What would become invalid if the user corrected or forgot a source?
- Does the available evidence support context only, or does it also carry action authority?

MAG is not a generic Graph DB, a vector-memory replacement, or an LLM-generated ontology.
Authoritative notes, tasks, calendars, and external services remain authoritative. MAG
stores rebuildable relations and immutable source references; graph proximity never
creates truth, feedback, policy, permission, or authority.

> RAG can nominate likely context. MAG proves the exact scope, time, change, provenance,
> completeness, and authority boundary.

## Project status

MAG is currently developed as the private `@muse/attunement-graph` workspace package
inside Muse. Muse is its first consumer and dogfood environment. The package is **not
published or standalone-qualified yet**.

The current implementation includes:

- validated temporal/provenance assertions and an immutable logical journal;
- bounded graph traversal and Activation Subgraph compilation;
- a neutral `open → project → execute → close` lifecycle;
- an explicit in-memory semantic oracle and backend conformance harness;
- exact Continuity observation, change, Capsule-presentation, resume-runtime, and Shadow
  decision-receipt compatibility Modules used by Muse.

Still required before a standalone release:

- a worker-isolated durable SQLite Store;
- export/rebuild, migrations, corruption recovery, and physical forget;
- Markdown, Obsidian, and Notion Source Adapters;
- a clean-room build and packed-install gate with no Muse workspace dependency;
- a minimal non-Muse example agent and complete public release metadata.

Passing library tests proves deterministic software contracts. It does not prove that MAG
has learned a person, improved timing, or saved reconstruction time in real use.

## Why an agent-native graph?

A conventional graph API optimizes arbitrary query breadth. MAG optimizes **bounded agent
decisions**:

1. A Source Adapter emits a bounded, exact source observation.
2. A versioned projector commits it to one explicit `(sourceId, threadId)` scope.
3. A versioned operator reads one immutable snapshot.
4. The Engine settles a proof-closed, token-budgeted Working Graph.
5. The result reports `complete`, `partial`, or `abstained` separately from source
   freshness.
6. The model receives only the decision slice and its evidence boundary.

The public Interface intentionally does not expose SQL, Cypher, arbitrary predicates,
storage traversal plans, model prompts, or raw database handles.

## Quick start

The following example uses the process-local in-memory oracle. It is for tests and
experiments, not durable user data.

```ts
import {
  openMag,
  type GraphAssertion,
  type MagScope
} from "@muse/attunement-graph";
import { createInMemoryMagStore } from "@muse/attunement-graph/testing";

const scope: MagScope = {
  sourceId: "notes",
  threadId: "trip-planning"
};

const assertion: GraphAssertion = {
  schemaVersion: 1,
  id: "trip-linked-to-hotel-comparison",
  subject: { kind: "artifact", id: "hotel-comparison" },
  predicate: "LINKED_TO",
  object: { kind: "thread", id: "trip-planning" },
  epistemicClass: "source-observed",
  sourceRefs: [{
    namespace: "example.notes",
    id: "travel.md#hotel-comparison"
  }],
  recordedAt: "2026-07-30T09:00:00.000Z",
  derivation: { kind: "projection", version: "example@1" }
};

const mag = await openMag({
  scope,
  store: createInMemoryMagStore()
});

const snapshot = await mag.project({
  operator: "canonical-projection@1",
  observation: {
    schemaVersion: 1,
    observationKey: "notes-sync-42",
    scope,
    observedAt: "2026-07-30T09:00:00.000Z",
    sourceFreshness: {
      state: "fresh",
      observedAt: "2026-07-30T09:00:00.000Z"
    },
    assertions: [assertion]
  }
});

const result = await mag.execute({
  operator: "working-graph@1",
  seed: { kind: "thread", id: "trip-planning" },
  now: "2026-07-30T09:00:00.000Z",
  maxEstimatedTokens: 2_000
});

console.log(snapshot.commitId, result.status, result.workingGraph);
await mag.close();
```

Commands and operators use immutable versioned identifiers. A persisted value never
contains a moving `latest` alias.

## Target architecture

The neutral Engine and in-memory oracle shown below exist. SQLite and the three Source
Adapters are selected or planned components, not current package Implementations.

```text
Agent or Muse product
  → MAG Interface
    → MAG Engine
      → MagStore capability
        → SQLite Store [planned]
        → in-memory semantic oracle

Markdown / Obsidian / Notion [planned]
  → Source Adapter
    → verified bounded observation
      → versioned projector
```

### MAG Engine

The Engine owns graph meaning:

- exact scope and immutable snapshot semantics;
- epistemic classes, temporal validity, and provenance;
- versioned projectors and operators;
- proof closure, completeness, and typed abstention;
- deterministic IDs and portable conformance fixtures.

### MAG Store

The current Store seam owns atomic compare-and-swap and detached snapshot reads. A future
durable Store Implementation will own:

- the durable journal and snapshot indexes;
- crash recovery, migrations, export/rebuild, and physical forget;
- writer serialization, WAL/checkpoint policy, and shutdown.

SQLite is the selected local default. PostgreSQL may become an optional deployment
Adapter. Redis may be used only as a disposable cache or queue. MySQL and external
property-graph services are not required for the flagship local experience.

### Planned Source Adapters

The planned Source Adapters will preserve exact source identity without turning MAG into a
second document database:

- Markdown: file identity, frontmatter, headings, and portable links;
- Obsidian: vault-relative paths, wiki-links, embeds, headings, and stable block refs;
- Notion: workspace, database, page, block, and sync-cursor identity.

Source text will remain in the source system. An Adapter must define drift, deletion,
round-trip, and rebuild behavior explicitly.

## Runtime and language strategy

MAG is **TypeScript-first**. TypeScript owns the public Interface, semantics, validation,
operators, and cross-implementation conformance corpus. The planned SQLite Store will
perform durable query and transaction work in its native engine.

The production SQLite Adapter will isolate synchronous database work in a worker so MAG
does not stall an agent host's application event loop.

Rust is an optional, benchmark-gated acceleration layer—not a second MAG implementation
and not a required dependency. Candidate kernels are:

- proof-closure and large bounded traversals;
- canonical hashing;
- compression;
- export/rebuild;
- physical forget and compaction.

A kernel moves to Rust only after the TypeScript/SQLite implementation has been measured,
query shape and allocation have been optimized, and the Rust path shows a material
end-to-end improvement **including boundary and serialization overhead**. Node hosts use
Node-API; portable hosts may use WebAssembly when justified. Every native kernel must
produce byte-stable results against the TypeScript semantic oracle.

The durable performance matrix covers 10K, 100K, and 1M assertions; single and batched
projection; warm/cold Working Graph execution; replay, rebuild, export, and forget;
resident memory; database/WAL size; and application-thread event-loop delay on Apple
Silicon and Linux x86-64.

## Core invariants

- One ordinary operation belongs to exactly one `(sourceId, threadId)`.
- One operator reads one immutable generation and commit.
- Evidence is rebuildable and never outranks its authoritative source.
- A model hypothesis cannot silently become a source-observed fact.
- Factual interaction is not feedback, usefulness, causality, policy, or permission.
- A validated policy audit may establish when the current policy generation occurred;
  its audit ID, candidate, behavior digests, and authority do not become graph evidence.
- Lexical/vector retrieval may nominate candidates only.
- Mandatory proof, source, freshness, scope, policy, or authority branches are never
  silently truncated.
- Current-world absence requires both complete projection coverage and fresh source
  coverage; otherwise MAG abstains.
- Corrupt or future-version durable state becomes unavailable, never an empty graph.
- No Source or Store Adapter may expand action authority.

## Conformance

Every Store Implementation must pass the same backend-neutral corpus before it is used for
benchmarks or product dogfood.

```bash
pnpm --filter @muse/attunement-graph typecheck
pnpm --filter @muse/attunement-graph test
pnpm --filter @muse/attunement-graph build
```

The conformance contract covers atomic compare-and-swap, replay, collision/corruption,
scope isolation, immutable snapshots, detached reads, bounded execution, failure
atomicity, and lifecycle races. Durable Implementations additionally require restart,
crash, migration, export/rebuild, and physical-forget qualification.

The existing Continuity comparison benchmark is a deterministic capability baseline, not
a cross-language throughput result:

```bash
pnpm --filter @muse/attunement-graph benchmark:continuity-changes
```

## Extraction and release boundary

MAG stays in the Muse monorepo until all of these are true:

1. it builds and tests in a generated clean-room workspace;
2. public API scans find no Muse application, UI, scheduler, model, or private-path import;
3. in-memory and SQLite Stores pass the same byte-stable conformance corpus;
4. portable export/rebuild, corruption/future-version handling, migration, and physical
   forget pass;
5. the packed artifact installs in a fresh project without workspace dependencies;
6. one minimal non-Muse agent uses only public package Interfaces;
7. README, changelog, security policy, contribution guide, license, and third-party notices
   are release-ready.

At that point the verified package, tests, examples, and MAG-owned documentation can be
extracted with history into a dedicated repository. Until then, the Muse monorepo remains
the single authoritative history.

## License

The intended standalone project follows Muse's MIT license. Public release still requires
a final third-party notice and package-name/scope ownership review.
