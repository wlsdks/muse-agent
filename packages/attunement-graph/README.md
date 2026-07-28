# `@muse/attunement-graph`

Storage-neutral reference kernel for Muse's Attunement Graph Engine.

This package currently owns closed graph semantics, assertion validation, bounded traversal,
an in-memory conformance adapter, and the Activation Subgraph compiler. Traversal has
independent hard caps for result assertions, considered adjacency assertions, visited
references, and depth; truncation is explicit. It does **not** own
authoritative personal data, durable persistence, LLM extraction, runtime scheduling,
policy promotion, approval, or action execution.

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
