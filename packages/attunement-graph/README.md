# `@muse/attunement-graph`

Storage-neutral reference kernel for Muse's Attunement Graph Engine.

This package currently owns closed graph semantics, assertion validation, bounded traversal,
an in-memory conformance adapter, the Activation Subgraph compiler, and a pure per-thread
Continuity projection. The projection accepts unknown state through the same I/O-free
parser used by the authoritative Attunement store, emits content-addressed assertions with
exact versioned provenance, and computes scope-safe snapshot deltas. It never reads the
store. Traversal has independent hard caps for result assertions, considered adjacency
assertions, visited references, and depth; truncation is explicit.

The next planned layer is not arbitrary model-generated graph querying. It is a small,
versioned set of deterministic personal-temporal operators such as explained change,
resumption context, policy evidence, forget impact, and bounded decision counterfactuals.
Each operator must return a content-addressed source path plus completeness, or abstain.
AWG-030, the first explained-change operator, is currently blocked at its PLAN gate and is
not exported or claimed as shipped.

It does **not** own authoritative personal data, durable persistence, LLM extraction,
runtime scheduling, policy promotion, approval, or action execution. Factual task
interaction receipts are projected only as evidence/correlation, never as user outcomes.
The adapter is exposed from `@muse/attunement-graph/continuity`, so importing the kernel
root does not eagerly load Attunement validation or personal-store dependencies.

The in-memory adapter is the executable specification for future storage adapters. Every
adapter must pass `runAttunementGraphStoreConformance` from
`@muse/attunement-graph/testing` before product benchmarks or dogfood can select it.

```bash
pnpm --filter @muse/attunement-graph typecheck
pnpm --filter @muse/attunement-graph test
```

Architecture and roadmap:

- [`docs/design/attunement-graph.md`](../../docs/design/attunement-graph.md)
- [`docs/goals/attunement-wow-graph-roadmap.md`](../../docs/goals/attunement-wow-graph-roadmap.md)
