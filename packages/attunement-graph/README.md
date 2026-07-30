# Muse Attunement Graph

**Muse Attunement Graph (MAG)** is a deployment-flexible, agent-native temporal and
provenance graph. Its current reference store is local and replaceable. MAG compiles a
small, verified **Working Graph** for one agent decision instead of making a model search
an unbounded personal knowledge graph.

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

## Public surface

- `.` — the neutral engine lifecycle: `openMag({ scope, store }) → project → execute → close`,
  its domain types and invariants.
- `./backend` · `./local` — the store contract, and the worker-isolated local SQLite adapter.
- `./continuity` · `./continuity-changes` · `./continuity-observations` — exact Continuity
  projection, the "what changed since I stopped" query, and content-addressed observation
  receipts.
- `./continuity-capsules` · `./continuity-resume-runtime` — Capsule render data, and the
  process-local resume compiler.
- `./shadow-decision-receipt` — the Shadow Muse decision record.
- `./testing` — the in-memory semantic oracle and the backend conformance harness.

## Depends on

- `@muse/attunement` — the Continuity threads, links and receipts this graph projects. It is
  the only internal dependency, deliberately: MAG is being kept extractable.

## Rules that bind this package

- [`architecture.md`](../../.claude/rules/engineering/architecture.md) — storage stays behind
  the adapter boundary; no external graph server is required.
- [ADR 0001](../../docs/architecture/adr/0001-mag-product-module-boundary.md) fixes the closed
  interface and the repository-split plan; [ADR 0002](../../docs/architecture/adr/0002-mag-language-runtime-boundary.md)
  fixes TypeScript-first with Rust only for benchmark-proven kernels.

## Tests

```bash
pnpm --filter @muse/attunement-graph test
pnpm --filter @muse/attunement-graph verify:local-mag
pnpm --filter @muse/attunement-graph verify:portable-fixtures
pnpm --filter @muse/attunement-graph verify:continuity-capsules
pnpm --filter @muse/attunement-graph verify:continuity-resume-runtime
```

## Project status

MAG is currently developed as the private `@muse/attunement-graph` workspace package
inside Muse. Muse is its first consumer and dogfood environment. The package is **not
published or standalone-qualified yet**.

The current implementation includes validated temporal/provenance assertions over an
immutable logical journal; bounded traversal and Activation Subgraph compilation; the neutral
`open → project → execute → close` lifecycle; an in-memory semantic oracle plus a backend
conformance harness; a worker-isolated SQLite adapter with an append-only projection journal,
exact per-scope heads, compare-and-swap writes and restart recovery; a checked runtime
boundary separating protocol, physical profile, execution and worker dispatch; and a
transactional portable encoder against the normative `.magx` v1 contract in
[`PORTABLE-FORMAT.md`](PORTABLE-FORMAT.md), with a checked-in golden corpus and a streaming
non-retention qualification.

The portable path also includes a package-private streaming decoder, an exact
raw-UTF-8-keyed SQLite indexed-validation sink, and an owner-private POSIX Admin staging
lifecycle. The staging boundary pins directory/file device and inode identities, observes
native close outcome monotonically, deletes only capability-recorded files, and requires
parent-directory fsync before `cleanup-complete`.

The Admin foundation also includes a package-private, descriptor-safe 64 KiB protocol and
one-in-flight parent fail-stop spine. It validates exact typed messages, correlates one
monotonic request ID, discards untrusted Worker error text, pins the first terminal failure,
and performs timer/listener cleanup before a non-authoritative termination attempt. Its
qualification uses a fake transport and clock; it is not a real Worker or database reader.

These surfaces remain validated-but-unpublished infrastructure. They do not ship a public
decoder, serving or separate Admin Worker command, destination generation activation, or
public `./admin` API. Unknown close outcomes and unexpected artifacts remain toxic; native
directory-FD/`openat` same-UID race closure, non-POSIX profiles, crash-residue discovery,
and production-scale proof remain unverified.

Still roadmap:

- portable export/rebuild end to end, backup, and physical forget;
- the complete physical profile and corpus;
- the 10K/100K/1M performance and event-loop-delay benchmark matrix;
- Markdown, Obsidian, and Notion Source Adapters;
- Muse default-path composition and unsupported-platform profile work where needed;
- a clean-room build and packed-install gate with no Muse workspace dependency;
- a minimal non-Muse example agent and complete public release metadata.

Per-task status — the `AWG-` identifiers and what each one verified — lives in the program
that owns it, [the wow + graph roadmap](../../internal/goals/attunement-wow-graph-roadmap.md),
rather than here: a package README that tracks ticket numbers goes stale the week it is
written.

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

### Durable local store

The public `@muse/attunement-graph/local` subpath adds durability without exposing SQLite,
SQL, Workers, or migrations. It exports `openLocalMag` and `OpenLocalMagOptions`; the
returned value has the same `project → execute → close` Interface as `openMag`.

```ts
import { openLocalMag } from "@muse/attunement-graph/local";
import type { MagScope } from "@muse/attunement-graph";

const scope: MagScope = {
  sourceId: "notes",
  threadId: "trip-planning"
};

const mag = await openLocalMag({
  databasePath: "/absolute/local/path/attunement-graph.sqlite",
  scope
});

// Use the same mag.project(...) and mag.execute(...) commands shown above.
await mag.close();
```

Callers must provide an explicit absolute regular-file path and exact scope. The shipped
physical profile requires Node `>=24.12.0`, SQLite
`3.44.6–3.44.x`, `3.50.7–3.50.x`, or `>=3.51.3`, defensive mode, and a runtime-probed
local filesystem from this allowlist:

- macOS APFS or HFS+;
- Linux ext4, XFS, Btrfs, overlayfs, or tmpfs.

The Adapter fails closed before opening or mutating unsupported state. Relative, URI,
special, NUL-containing, symlinked/noncanonical component, non-regular, and non-local paths
are rejected before SQLite opens the file. Windows, network filesystems, and unknown or
unclassified operating-system/filesystem profiles are not supported. The database, WAL,
and shared-memory files must belong to the current effective user and remain owner-only.

## Target architecture

The neutral Engine, in-memory oracle, and the SQLite projection-journal foundation
shown below exist. The three Source Adapters and the remaining SQLite maintenance and
qualification work are planned, not current package Implementations.

```text
Agent or Muse product
  → MAG Interface
    → MAG Engine
      → MagStore capability
        → SQLite Store [durable projection journal]
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

The Store seam owns atomic compare-and-swap and detached snapshot reads. The shipped local
Adapter adds:

- an append-only durable projection journal and exact head for each encoded
  `(sourceId, threadId)`;
- transactionally serialized compare-and-swap, restart recovery, and same-file writer
  races;
- a capability/version-gated safe WAL profile, bounded passive checkpoint, and deterministic
  Worker shutdown.

It does not yet provide portable export/rebuild, destructive migration, backup, physical
forget/compaction, or their full qualification corpus.

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

### Dedicated Admin surface

Standalone MAG requires its own administration surface; it is not merely a tab coupled
to the Muse application. A shared `@muse/attunement-graph/admin` core will back both a
CLI and any future local Admin UI/API so operational semantics cannot drift between
surfaces.

The surface is read-only by default and must expose health, physical profile, scopes,
exact heads, provenance coverage, integrity results, storage size, and pending
maintenance. Its controlled operations are `verify`, `export`, `rebuild`, `backup`,
`forget`, and `compact`. Destructive operations require an exact impact preview,
explicit confirmation at the application boundary, an immutable audit receipt, and a
verified recovery or replacement path. The Maintenance Module is never an agent/model
tool, and no graph-derived fact grants permission to invoke it.

The first normative API is the future `./admin` portable export/rebuild contract in
[`PORTABLE-FORMAT.md`](PORTABLE-FORMAT.md). Backup, physical forget, compaction, and the
visual administration surface remain separately gated work.

## Runtime and language strategy

MAG is **TypeScript-first**. TypeScript owns the public Interface, semantics, validation,
operators, and cross-implementation conformance corpus. The SQLite Store performs durable
query and transaction work in its native engine.

The SQLite Adapter imports `node:sqlite` only inside one long-lived Worker so synchronous
database work does not stall an agent host's application event loop. Importing the root
package does not load SQLite.

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

The durable projection-journal subset covers restart, same-file
writer races, bounded close/checkpoint behavior, and fail-stop crash boundaries.
The typed worker boundary hardens that same v1 profile with an internal protocol, explicit runtime
artifact manifest, source-to-dist declaration checks, and a pre-refactor SQLite reopen
fixture. It changes neither the public Interface nor the physical schema and does not
claim the remaining migration, export/rebuild, backup, physical-forget, or complete
cross-backend corpus gates.

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
