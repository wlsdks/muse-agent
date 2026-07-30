# Muse architecture context

This file names the durable domain language and dependency direction for architectural
work. Product status and execution history belong in the linked strategy, design, and goal
documents rather than here.

## Domain language

- **Attunement** is the loop by which Muse gets better at collaborating with one person:
  personal thread → Continuity Pack/Capsule → explicit outcome → inspectable policy change.
- An **authoritative source** is the existing task, note, calendar, contact, memory, or
  Attunement store that owns a fact. A graph, index, receipt, or Capsule is a projection,
  never a second authority.
- A **Source Projection** is a bounded, deterministic, immutable view of already-resolved
  source truth. It validates identity and coherence but does not prove freshness.
- An **Observation Receipt** content-addresses what a caller declared it observed. A
  **Source Observation Receipt** preserves canonical personal display truth; a Graph
  Observation Receipt preserves relational assertions. Each proves self-consistency, not
  that an external observer witnessed the state or time. The AWG-040b Capsule compiler uses
  previous and current *scoped* Source and Graph Receipt pairs: each pair binds exact
  `sourceId`, thread, observation time, complete link roles, and policy provenance before a
  receipt-to-receipt change result is computed. This remains caller-declared evidence, not an
  authenticated witness, freshness proof, or independent authority.
- A **Continuity Capsule Manifest** is a bounded, immutable, render-ready display snapshot:
  the previous observation's recorded next step (not an observed exact stopping point), its
  current availability, the current next step, selected available supporting evidence,
  prepared work, expected time, receipt/change IDs, and the exact provenance required to
  verify them. It does not join live stores. A `draft` is display-only; an `action-preview`
  always requires a new approval. Neither form contains a UI, persistence, action, or tool
  payload. Exact-stop experience remains future work until an explicit stop-marker/capture
  contract exists.
- A **Continuity Capsule Presentation** is the bounded, bilingual library view over verified
  Capsule dependencies. Its owner-request reason is only
  `caller-declared-owner-request`; automatic timing is `not-performed`. Standalone
  verification establishes canonical self-consistency, not authenticated observation,
  source freshness, or proof that the caller request occurred. It has no UI, delivery,
  persistence, source/store join, policy mutation, or action authority.
- A **Continuity Resume Runtime** is the bounded, assembly-local process-memory bridge from
  one exact previous Source/Graph boundary to a current Provider-revalidated pair. The
  existing explicit Pack Preview dogfoods its semantic result. Its LRU and side registries
  are not a durable graph, and its successful or unavailable result grants no source
  completeness, current-world, timing, policy, or action authority. An optional explicit
  request may present a verified bilingual Capsule only when the exact result owns both its
  Pack and four receipt-bound Capsule dependencies; it adds no automatic delivery or UI.
- A **Temporal Rule** is the versioned deterministic Module that derives task, reminder,
  and calendar display state at one declared observation time. Producers and receipt
  verification use the same Implementation; old receipts are never silently reinterpreted
  through an unversioned new rule.
- The **Evidence Graph** holds rebuildable provenance and temporal assertions. The
  **Working Graph** is an expiring, token-budgeted decision slice.
- **Muse Attunement Graph (MAG)** is the canonical name for the whole agent-native graph
  architecture. **MAG Engine** is the semantics/operators/compiler; **MAG Store** is the
  built-in durable journal and index layer whose selected default is capability-gated
  `node:sqlite`. The AWG-070a1 worker-isolated projection-journal foundation exists;
  export/rebuild, backup, physical forget, complete benchmarks, and default Muse composition
  remain. PostgreSQL is optional; Redis/MySQL/external Graph DBs are not required. A
  receipt is evidence projected into MAG, not a database.
- MAG is an independently extractable product Module developed inside Muse until its
  clean-room package gate passes. Muse applications depend on the MAG public Interface;
  the Engine never depends on Muse API/web/CLI/scheduler/autoconfigure/model/UI packages.
  Planned Markdown, Obsidian, and Notion integrations are Source Adapters, not Store
  Implementations; their MAG-specific contracts are not shipped. See
  [ADR 0001](docs/architecture/adr/0001-mag-product-module-boundary.md). The Engine remains
  TypeScript-first, synchronous SQLite work is isolated from the application thread, and
  only measured hot kernels may move behind a byte-stable Rust Implementation; see
  [ADR 0002](docs/architecture/adr/0002-mag-language-runtime-boundary.md).
- The long-term Observe target is a consented local 24-hour event stream over approved
  sources. It feeds Muse-owned append-oriented Graph storage with pause, retention, export,
  rebuild, and physical-forget controls; it is not indiscriminate screen capture.
- A **Graph Scope** is an explicit `(sourceId, threadId)` membership boundary. A shared
  artifact never authorizes traversal from one scope into another. A **Graph Snapshot**
  binds one generation and commit so an operator cannot mix projection heads, assertions,
  lifecycle state, or receipts from different transactions.
- An **Activation Subgraph** is the smallest sufficient graph context compiled for one
  agent decision. Its v2 target is a proof-closed bundle: a published change cannot lose
  its explanation path, policy, source resolution, completeness, freshness, or authority
  boundary to truncation. The model never receives or queries the whole personal graph by
  default.
- **Shadow Muse**, **Continuity Capsule**, and **Policy Card** are the signature product
  surfaces. None may infer permission, usefulness, causality, or feedback from proximity or
  factual interaction.

## Module boundaries

Dependency direction is one-way:

```text
authoritative stores
  → source-specific resolvers
  → @muse/attunement source projection and receipts
  → @muse/attunement-graph assertions/operators
  → bounded Capsule/Shadow/Policy presentation
  → existing approval and action boundaries
```

- `@muse/attunement` owns Personal Continuity and `ResolvedArtifact` semantics, including
  the internal all-source projection contract.
- `@muse/attunement-graph` owns storage-neutral graph invariants, projections, bounded
  operators, explanations, backend conformance, the internal AWG-040b Capsule compiler,
  the AWG-040c pure render-data presentation Module, and the bounded process-local resume
  coordinator. `@muse/autoconfigure` owns the narrow explicit Preview composition—not
  personal-store authority, UI, or a second application composition root.
- Muse's own local graph default must support the complete flagship experience. External
  Graph DBs and hosted graph services are optional, removable storage/interoperability
  Adapters; no Capsule, Shadow Muse, Policy Card, or qualification gate may require one.
- The compiler may consume the narrow `@muse/attunement/continuity-source-observations`
  facade, but it must not become a second composition root, graph database/backend, durable
  store, or action/tool boundary. The user-invoked presentation Module owns render-ready
  bilingual data only; applications own actual rendering and delivery.
- Applications compose the modules. A package must not become a second composition root by
  importing every personal store.
- Database SDKs, model providers, embeddings, clocks, files, and networks stay behind
  replaceable adapters. Domain interfaces must survive replacing the graph backend.
- Exact identity, time, provenance, epistemic class, policy scope, and authority are
  established deterministically. Lexical/vector retrieval may nominate candidates only.

## Architecture test

A new graph feature is justified only when it provides measurable relational, temporal, or
reconstruction leverage over flat exact lookup and any relevant vector baseline. It must
remain bounded, source-resolvable, locally forgettable, rebuildable, and cheaper than
loading unrelated personal context into the model.

Canonical contracts:

- [Attunement strategy](docs/strategy/attunement.md)
- [Attunement Graph design](docs/design/attunement/attunement-graph.md)
- [Agent-Native Graph Core blueprint](docs/design/attunement/agent-native-graph-core.md)
- [MAG language and runtime boundary](docs/architecture/adr/0002-mag-language-runtime-boundary.md)
- [Wow + graph roadmap](internal/goals/attunement-wow-graph-roadmap.md)
