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
  prior stopping point, current next step, selected available supporting evidence, prepared
  work, expected time, receipt/change IDs, and the exact provenance required to verify them.
  It does not join live stores. A `draft` is display-only; an `action-preview` always requires
  a new approval. Neither form contains a UI, persistence, action, or tool payload.
- A **Temporal Rule** is the versioned deterministic Module that derives task, reminder,
  and calendar display state at one declared observation time. Producers and receipt
  verification use the same Implementation; old receipts are never silently reinterpreted
  through an unversioned new rule.
- The **Evidence Graph** holds rebuildable provenance and temporal assertions. The
  **Working Graph** is an expiring, token-budgeted decision slice.
- An **Activation Subgraph** is the smallest sufficient graph context compiled for one
  agent decision. The model never receives or queries the whole personal graph by default.
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
  operators, explanations, backend conformance, and the internal AWG-040b Capsule compiler—
  not personal-store adapters or a presentation layer.
- The compiler may consume the narrow `@muse/attunement/continuity-source-observations`
  facade, but it must not become a second composition root, graph database/backend, durable
  store, or action/tool boundary. A later, user-invoked presentation adapter owns rendering.
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
- [Attunement Graph design](docs/design/attunement-graph.md)
- [Wow + graph roadmap](docs/goals/attunement-wow-graph-roadmap.md)
