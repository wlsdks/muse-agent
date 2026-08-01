# ADR 0001: AttuneGraph is an independently extractable product Module

- Status: accepted; extraction completed 2026-07-31
- Date: 2026-07-30
- Decision owners: Muse architecture
- Related:
  [AttuneGraph](../../design/attunement/attunegraph.md),
  [Agent-Native Graph Core](../../design/attunement/agent-native-graph-core.md),
  [language and runtime boundary](0002-attunegraph-language-runtime-boundary.md),
  [wow + graph roadmap](../../../internal/goals/attunegraph-roadmap.md),
  [standalone readiness audit](../../evaluations/attunegraph-standalone-readiness-2026-07-30.md)

## Context

Muse needs an embedded graph optimized for an AI agent's temporal, provenance, policy,
and context-compilation work. The graph must remain lightweight enough for one local
person, work without an external Graph DB, and later be releasable as a focused open-source
project.

Creating a second Git repository during rapid product development would add package
publishing, version synchronization, and cross-repository integration commits to every
semantic change. Leaving AttuneGraph as an ordinary Muse-internal folder would create the opposite
problem: Muse application dependencies and product-specific composition would leak into
the engine until clean extraction became impractical.

## Decision

**AttuneGraph** is developed in the public
[`wlsdks/attunegraph`](https://github.com/wlsdks/attunegraph) repository and consumed by Muse as a
pinned same-path submodule at `packages/attunegraph`. The neutral package is
`@attunegraph/core`; Muse-specific product integration remains isolated in
`@muse/attunegraph`. Muse is AttuneGraph's first consumer and dogfood environment, not the owner
of its storage semantics. The standalone repository is authoritative for Engine changes; the
Muse repository owns only the reviewed submodule pin and integration.

The public product Interface converges on a small lifecycle:

```ts
const attuneGraph = await openAttuneGraph(options);
await attuneGraph.project(command);
const result = await attuneGraph.execute(command);
const evidence = await attuneGraph.query(decisionQuery);
await attuneGraph.close();
```

There are no compatibility aliases for the superseded product vocabulary. Persisted
operator and projector identifiers are exact immutable versions such as
`resume-context@2`; they never store a `latest` alias.

Source naming follows one contract:

- prose/product: `AttuneGraph`;
- TypeScript symbols: `AttuneGraphScope`, `AttuneGraphSnapshot`, `AttuneGraphStore`, `AttuneGraphSourceAdapter`,
  `AttuneGraphOperatorResult`, `AttuneGraphDecisionQueryResult`, and `AttuneGraphError`;
- factories and values: `openAttuneGraph`, `openLocalAttuneGraph`, `createAttuneGraphEngine`;
- packages: neutral `@attunegraph/core`, Muse integration `@muse/attunegraph`;
- durable identifiers: lower-case versioned keys such as `resume-context@2`;
- Activation Subgraph remains a descriptive query result, not an alternate product name.

The Interface is intentionally closed:

- callers select one explicit `AttuneGraphScope` and immutable `AttuneGraphSnapshot`;
- projectors turn verified observations into deterministic AttuneGraph projections;
- `decision-query@1` compiles one fixed evidence frontier from typed input or bounded AttuneQL;
- Muse integrations may cross-bind that evidence-only receipt to stricter host proof artifacts, but
  must not reinterpret it as authority, conflict closure, persistence, retention, or permission;
- versioned operators answer agent questions such as `changes-since`, `resume-context`,
  `decision-counterfactual`, `policy-evidence`, and `forget-impact`;
- results report freshness and `complete | partial | abstained`;
- raw SQL, Cypher, arbitrary predicates, model prompts, and storage traversal plans are not
  product Interfaces.

## Module topology

| Module | Package or subpath | Status | Responsibility |
| --- | --- | --- | --- |
| AttuneGraph Engine | `@attunegraph/core` | shipped standalone and pinned here | Canonical values, projections, versioned operators, explicit completeness/non-closure, errors |
| Local AttuneGraph | `@attunegraph/core/local` | shipped | `openLocalAttuneGraph()` with SQLite isolated behind a worker boundary |
| Read-only Admin | `@attunegraph/core/admin` | shipped offline Interface | Summary, integrity, and exact-head inspection from an explicitly closed/quiescent snapshot |
| Store Kit | `@attunegraph/core/backend` | shipped expert seam | Transactional journal/snapshot adapter contract |
| Conformance | `@attunegraph/core/testing` | shipped | In-memory semantic oracle and store conformance |
| Extension Kit | `@attunegraph/core/extension-kit` | shipped narrow seam | Canonical envelopes, settlement, normalization, and witness-path helpers |
| Muse integration | `@muse/attunegraph/*` | shipped explicit subpaths | Continuity, Shadow, Capsule, Policy Card, evidence, and lineage composition |
| Muse durable projection | `@muse/attunegraph/continuity-durable-projection` | shipped explicit opt-in | Verified Continuity Graph receipts to the embedded Store; serialized writer, restart head recovery, unknown freshness, no source authority |
| Muse Policy Card preview | `@muse/attunegraph/policy-card` | shipped explicit read-only | One fresh provider-matched Attunement snapshot to inert bilingual render data; authoritative experience, caller replay claims, and graph explanation stay separate; no mutation or action |
| Markdown source | future standalone adapter | target | Portable Markdown/frontmatter/link observations |
| Obsidian source | future standalone adapter | target | Vault-relative wiki-link, embed, heading, and stable block-ref observations |
| Notion source | future standalone adapter | target | Opt-in sync preserving workspace/database/page/block identities |
| PostgreSQL backend | future optional adapter | deferred until demonstrated need | Optional deployment adapter |

SQLite is the selected local AttuneGraph Store but is hidden behind `openLocalAttuneGraph()`. Its tables,
WAL/checkpoint policy, migrations, and connection objects must not leak into the AttuneGraph Engine
Interface. The in-memory implementation is an executable semantic oracle, not a silent
durability fallback. Redis, MySQL, and an external property-graph service are not required.

Markdown, Obsidian, and Notion are Source Adapters, not graph storage Adapters. Source
documents remain authoritative; AttuneGraph stores exact references, immutable evidence, and
rebuildable relations rather than becoming a second document database.

Muse's first write composition is shipped but deliberately has no default:
`MUSE_ATTUNEGRAPH_DATABASE` must name an absolute normalized database path.
The existing provider-revalidated Continuity Preview supplies a verified Graph
Observation Receipt to the Muse composition. That v1 receipt remains unchanged.
The composition re-reads validated Attunement and the immutable capability
returned by `readTimingState`, verifies the source version, and seals a complete
v2 observation under the reserved `muse.local-attunement-timing` scope. This
scope separation prevents a later provider-only v1 write from erasing return
relations. The durable-projection Module reads the current snapshot through the
public Engine Interface, supplies that exact optimistic token to the Engine's
atomic compare-and-swap, serializes in-process calls, and closes each Local
AttuneGraph instance. Older source observations are refused; an
external-writer race rejects without retry or overwrite; an identical receipt
replay does not advance the generation. Receipt integrity does not prove
freshness, so the stored source-freshness state remains `unknown`.

## Dependency direction

```text
Muse applications and product composition
  -> AttuneGraph public Interface
    -> AttuneGraph Engine semantics and versioned operators
      -> private Store Interface
        -> SQLite or in-memory oracle

Markdown / Obsidian / Notion
  -> Source Adapter
    -> verified bounded observation
      -> AttuneGraph projector
```

The AttuneGraph Engine cannot import Muse API, web, CLI, scheduler, autoconfigure, model-provider,
or user-interface packages. Source and backend packages may depend on the AttuneGraph Interface;
the AttuneGraph Engine must not depend on their SDKs.

Where existing AttuneGraph semantics currently depend on `@muse/attunement`, extraction work must
move only the smallest durable receipt/value contracts into a neutral AttuneGraph contract Module
or accept them through a narrow Adapter. Attunement-specific parsing, local-store I/O,
capture minting, and current Continuity compatibility subpaths move behind the Muse
Attunement bridge. The split must not copy or fork Attunement validation.

## Interface invariants

- Evidence Graph state is rebuildable and never outranks its authoritative source.
- Every ordinary projection and operator is confined to one `(sourceId, threadId)`.
- Every operator pins one generation and commit snapshot.
- `head()` exposes only the detached snapshot needed for optimistic
  concurrency; it exposes no assertions, source authority, or permission.
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

## Standalone split outcome and remaining qualification

The original split gate tracked the following evidence. The repository split is complete; items
that remain incomplete are still explicit product or release qualification work rather than reasons
to describe AttuneGraph as an in-tree or future standalone module:

1. the AttuneGraph package builds and tests from a generated clean-room workspace without the Muse
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

The first public snapshot passed items 1–4 and 6 plus a clean package dry-run and the shipped
portable/corruption contracts. Registry publication, physical forget, write/repair Admin, and
complete migration/export qualification remain separate roadmap claims.

## Git and release strategy

AttuneGraph Engine, AttuneGraph Adapter, and AttuneGraph-only documentation changes should use focused commits.
Muse integration changes should be separate commits whenever practical. This preserves a
meaningful history for later extraction without slowing current development with dual-repo
version churn.

The extraction used a clean-room current snapshot instead of publishing Muse's reachable history.
The standalone repository is authoritative. Muse consumes a reviewed immutable git commit through
the same-path submodule, so its existing `workspace:*` and TypeScript references stay intact.
Engine work lands in AttuneGraph first; Muse then advances the pin and verifies integration.
Registry publication remains optional and is not required for Muse source builds. No automated
bidirectional mirroring is planned.

## Consequences

The boundary adds conformance work now, especially for the in-memory/SQLite Store seam and
neutral receipt contracts. In return it gives AttuneGraph real Depth, Leverage, and Locality:
removing the Engine would force every caller to recreate scope, snapshots, provenance,
temporal meaning, proof closure, completeness, authority filtering, canonical IDs, and
error behavior, while removing one Store or Source Adapter affects only that
Implementation.
