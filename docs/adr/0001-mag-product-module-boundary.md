# ADR 0001: MAG is an independently extractable product Module

- Status: accepted
- Date: 2026-07-30
- Decision owners: Muse architecture
- Related:
  [Muse Attunement Graph](../design/attunement-graph.md),
  [Agent-Native Graph Core](../design/agent-native-graph-core.md),
  [language and runtime boundary](0002-mag-language-runtime-boundary.md),
  [wow + graph roadmap](../../internal/goals/attunement-wow-graph-roadmap.md),
  [standalone readiness audit](../evaluations/mag-standalone-readiness-2026-07-30.md)

## Context

Muse needs an embedded graph optimized for an AI agent's temporal, provenance, policy,
and context-compilation work. The graph must remain lightweight enough for one local
person, work without an external Graph DB, and later be releasable as a focused open-source
project.

Creating a second Git repository during rapid product development would add package
publishing, version synchronization, and cross-repository integration commits to every
semantic change. Leaving MAG as an ordinary Muse-internal folder would create the opposite
problem: Muse application dependencies and product-specific composition would leak into
the engine until clean extraction became impractical.

## Decision

**Muse Attunement Graph (MAG)** is developed inside the Muse monorepo as an independent
product Module. Muse is MAG's first consumer and dogfood environment, not the owner of its
storage semantics.

The eventual standalone repository is provisionally `muse-mag`; the code package remains
`@muse/attunement-graph`. A 2026-07-30 npm registry check found both identifiers
unpublished, while the unscoped `mag` package already exists. Registry absence does not
prove ownership of the `@muse` scope, so scope authority must be verified before public
release. We will create the repository only after the standalone qualification gate
passes. Until then, one monorepo is the authoritative history.

The public product Interface converges on a small lifecycle:

```ts
const mag = await openMag(options);
await mag.project(command);
const result = await mag.execute(command);
await mag.close();
```

Names may receive a compatibility alias during implementation, but persisted operator and
projector identifiers are exact immutable versions such as `resume-context@2`; they never
store a `latest` alias.

Source naming follows one contract:

- prose/product: `Muse Attunement Graph (MAG)`, then `MAG`;
- TypeScript symbols: `MagScope`, `MagSnapshot`, `MagStore`, `MagSourceAdapter`,
  `MagOperatorResult`, and `MagError`;
- factories and values: `openMag`, `openLocalMag`, `createMagEngine`;
- package: `@muse/attunement-graph`;
- durable identifiers: lower-case versioned keys such as `resume-context@2`;
- existing `AttunementGraph*` and Activation Subgraph v1 symbols are compatibility
  vocabulary only. New public Interfaces must not extend that naming family.

The Interface is intentionally closed:

- callers select one explicit `MagScope` and immutable `MagSnapshot`;
- projectors turn verified observations into deterministic MAG projections;
- versioned operators answer agent questions such as `changes-since`, `resume-context`,
  `decision-counterfactual`, `policy-evidence`, and `forget-impact`;
- results report freshness and `complete | partial | abstained`;
- raw SQL, Cypher, arbitrary predicates, model prompts, and storage traversal plans are not
  product Interfaces.

## Module topology

| Module | Package or subpath | Status | Responsibility |
| --- | --- | --- | --- |
| MAG Engine | `@muse/attunement-graph` | neutral lifecycle shipped; standalone package remains partial | Canonical values, projections, versioned operators, proof closure, completeness, errors |
| Local MAG | `@muse/attunement-graph/local` | target | Opinionated `openLocalMag()` composition with the selected SQLite Store hidden as Implementation |
| Source Kit | `@muse/attunement-graph/source` | target | Bounded Source Adapter pages, exact source identity, opaque restart cursors |
| Store Kit | `@muse/attunement-graph/backend` | target | Expert-only transactional journal/snapshot Adapter seam |
| Maintenance | `@muse/attunement-graph/admin` | target | Verify, export, rebuild, migrate, compact, preview/perform physical forget |
| Conformance | `@muse/attunement-graph/testing` | current neutral Store lifecycle + legacy graph contract | In-memory semantic oracle and Store conformance; durable/source/operator expansion is target |
| Markdown source | `@muse/mag-source-markdown` | target | Portable Markdown/frontmatter/link observations |
| Obsidian source | `@muse/mag-source-obsidian` | target | Vault-relative wiki-link, embed, heading, and stable block-ref observations |
| Notion source | `@muse/mag-source-notion` | target | Opt-in sync preserving workspace/database/page/block identities |
| PostgreSQL backend | `@muse/mag-backend-postgres` | optional target after demonstrated need | Optional deployment Adapter |
| Muse Attunement bridge | provisional `@muse/mag-source-attunement` | target | Muse-repository Adapter for private Attunement parsing, capture, Pack, and compatibility subpaths; not a MAG Engine dependency |

SQLite is the selected local MAG Store but is hidden behind `openLocalMag()`. Its tables,
WAL/checkpoint policy, migrations, and connection objects must not leak into the MAG Engine
Interface. The in-memory implementation is an executable semantic oracle, not a silent
durability fallback. Redis, MySQL, and an external property-graph service are not required.

Markdown, Obsidian, and Notion are Source Adapters, not graph storage Adapters. Source
documents remain authoritative; MAG stores exact references, immutable evidence, and
rebuildable relations rather than becoming a second document database.

## Dependency direction

```text
Muse applications and product composition
  -> MAG public Interface
    -> MAG Engine semantics and versioned operators
      -> private Store Interface
        -> SQLite or in-memory oracle

Markdown / Obsidian / Notion
  -> Source Adapter
    -> verified bounded observation
      -> MAG projector
```

The MAG Engine cannot import Muse API, web, CLI, scheduler, autoconfigure, model-provider,
or user-interface packages. Source and backend packages may depend on the MAG Interface;
the MAG Engine must not depend on their SDKs.

Where existing MAG semantics currently depend on `@muse/attunement`, extraction work must
move only the smallest durable receipt/value contracts into a neutral MAG contract Module
or accept them through a narrow Adapter. Attunement-specific parsing, local-store I/O,
capture minting, and current Continuity compatibility subpaths move behind the Muse
Attunement bridge. The split must not copy or fork Attunement validation.

## Interface invariants

- Evidence Graph state is rebuildable and never outranks its authoritative source.
- Every ordinary projection and operator is confined to one `(sourceId, threadId)`.
- Every operator pins one generation and commit snapshot.
- Published Working Graphs are proof-closed; a mandatory source, policy, freshness, scope,
  or authority branch is never silently truncated.
- Absence is claimable only for a complete pinned snapshot; current-world absence also
  requires fresh source coverage.
- Factual interaction never becomes feedback, permission, policy promotion, usefulness,
  or causality.
- Exact operators make no model or embedding call.
- Corrupt or future-version durable state becomes unavailable; it is never replaced with an
  empty in-memory graph.
- Portable export and deterministic rebuild exist before the SQLite format becomes a
  default user-data commitment.

## Standalone qualification gate

MAG is ready to split into its own repository only when all of the following are true:

1. the MAG package builds and tests from a generated clean-room workspace without the Muse
   application graph;
2. public API extraction tests prove no import from Muse apps, UI, scheduler,
   autoconfigure, model providers, or private paths;
3. in-memory and SQLite implementations pass the same byte-stable conformance corpus;
4. package metadata, README, changelog, security policy, contribution guide, license, and
   third-party notices are complete;
5. portable journal export, rebuild, corruption/future-version handling, migration, and
   physical-forget behavior pass;
6. at least one minimal non-Muse example agent uses only the public package;
7. the packed artifact installs and runs in a fresh project with no workspace dependency.

Before this gate, documentation must say “standalone-ready target,” not “independently
publishable today.”

## Git and release strategy

MAG Engine, MAG Adapter, and MAG-only documentation changes should use focused commits.
Muse integration changes should be separate commits whenever practical. This preserves a
meaningful history for later extraction without slowing current development with dual-repo
version churn.

At qualification:

1. freeze one verified Muse commit;
2. extract only the MAG packages, MAG-owned docs, tests, examples, and required neutral
   contracts with history-preserving repository filtering;
3. create the new repository once;
4. run the clean-room and packed-artifact gates against the extracted commit;
5. publish an immutable initial package version;
6. change Muse from workspace composition to the released package in a separate integration
   commit.

No automated bidirectional mirroring is planned. After extraction, the standalone MAG
repository becomes authoritative and Muse consumes released versions.

## Consequences

The boundary adds conformance work now, especially for the in-memory/SQLite Store seam and
neutral receipt contracts. In return it gives MAG real Depth, Leverage, and Locality:
removing the Engine would force every caller to recreate scope, snapshots, provenance,
temporal meaning, proof closure, completeness, authority filtering, canonical IDs, and
error behavior, while removing one Store or Source Adapter affects only that
Implementation.
