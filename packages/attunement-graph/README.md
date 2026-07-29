# `@muse/attunement-graph`

Storage-neutral reference kernel for Muse's Attunement Graph Engine.

This package currently owns closed graph semantics, assertion validation, bounded traversal,
an in-memory conformance adapter, the Activation Subgraph compiler, and a pure per-thread
Continuity projection, and the first verified personal-temporal operator. The projection
accepts unknown state through the same I/O-free
parser used by the authoritative Attunement store, emits content-addressed assertions with
exact versioned provenance, and computes scope-safe snapshot deltas. It never reads the
store. Traversal has independent hard caps for result assertions, considered adjacency
assertions, visited references, and depth; truncation is explicit.

`@muse/attunement-graph/continuity-changes` now compares two exact observations inside a
caller-declared, version-bound interval. It normalizes no-op re-observation, distinguishes
world-valid changes from facts learned later, pairs only unambiguous revisions, builds one
bounded deterministic thread path, and returns typed abstentions instead of inventing
removal time or incomplete explanations. Unknown-input parsing, projection, diff,
traversal, output, model calls, and embedding calls are all explicitly bounded/accounted.

Future operators—resumption context, policy evidence, forget impact, and bounded decision
counterfactuals—remain roadmap work. They must follow the same content-addressed source
path plus completeness-or-abstention contract, not arbitrary model-generated graph queries.

It does **not** own authoritative personal data, durable persistence, LLM extraction,
runtime scheduling, policy promotion, approval, or action execution. Factual task
interaction receipts are projected only as evidence/correlation, never as user outcomes.
The configured-local snapshot Provider therefore lives behind
`@muse/attunement/host`, while its I/O-free receipt and process-local mint verifiers live
behind `@muse/attunement/continuity-snapshots`. A package-private composition seam now
accepts only that exact verified mint, independently rechecks the normalized-state
bytes/digest, creates and verifies a Continuity Observation Receipt, and feeds truthful
Provider provenance plus `unassessed` freshness into receipt-bound graph evidence.
Unassessed freshness forces abstention; the seam preserves exact receipt links and bounded
nomination overflow accounting without inventing a graph commit, generation, durable
authority, or absence proof. It has no root export and the graph still never reads the
Attunement file itself.
An independently verified sibling seam accepts only a process-minted, Provider-owned
two-endpoint head revalidation. Equal complete normalized endpoints within the declared
capture span may settle as `fresh-at-assessment` and `partial`; changed, over-span, or
unavailable endpoints never enter Graph compilation. The verifier closes Provider
ownership, scope, endpoint timing, coverage vocabulary, and the exact scope-derived thread
seed. It proves neither continuous stability nor freshness after assessment and remains
absent from the package root, runtime, and persistence surfaces.
The thread-rooted compiler also keeps a bounded retained-witness inventory in a
module-private exact-identity `WeakMap`. Individual core/optional entries and a compact
manifest preserve the complete pre-settlement pool, fair/lane-undetermined partition, and
body-bound focus digests while reusing the existing frozen document/assertion instances.
The inventory is available only to the exact in-process compilation object; cloning,
spreading, JSON serialization, and proxies do not carry it, and existing receipt IDs,
enumerable fields, JSON, settlement behavior, and package exports are unchanged. This is a
private prerequisite for a later caller-budgeted resumption operator, not a shipped
`resumeContext`, persistence layer, or runtime feature.
The adapter is exposed from `@muse/attunement-graph/continuity`, so importing the kernel
root does not eagerly load Attunement validation or personal-store dependencies.

The in-memory adapter is the executable specification for future storage adapters. Every
adapter must pass `runAttunementGraphStoreConformance` from
`@muse/attunement-graph/testing` before product benchmarks or dogfood can select it.

```bash
pnpm --filter @muse/attunement-graph typecheck
pnpm --filter @muse/attunement-graph test
pnpm --filter @muse/attunement-graph benchmark:continuity-changes
```

Architecture and roadmap:

- [`docs/design/attunement-graph.md`](../../docs/design/attunement-graph.md)
- [`docs/goals/attunement-wow-graph-roadmap.md`](../../docs/goals/attunement-wow-graph-roadmap.md)
