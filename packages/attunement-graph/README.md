# `@muse/attunement-graph`

Storage-neutral reference kernel for **Muse Attunement Graph (MAG)**, Muse's
agent-native temporal/provenance graph architecture.

MAG is being developed as an independently extractable product Module inside the Muse
monorepo. Muse is its first consumer and dogfood environment. It is not independently
publishable today: the package is still private, its durable SQLite MAG Store and
clean-room package gate are roadmap work, and part of the current semantic contract still
depends on `@muse/attunement`. The accepted package, Adapter, and future repository boundary
is recorded in
[`ADR 0001`](../../docs/adr/0001-mag-product-module-boundary.md).
The measured blockers and qualification sequence are recorded in the
[2026-07-30 standalone readiness audit](../../docs/evaluations/mag-standalone-readiness-2026-07-30.md).

Canonical terms:

- **MAG** is the whole architecture and future standalone product.
- **MAG Engine** owns graph meaning, verified projection, versioned operators, proof
  closure, and Working Graph compilation.
- **MAG Store** owns durable journal, snapshots, indexes, recovery, export, and rebuild.
- An immutable **receipt** is evidence projected into MAG; it is not the graph database.
- Markdown, Obsidian, and Notion are planned Source Adapters, not current MAG package
  exports. SQLite is the selected but unshipped local Store Implementation; PostgreSQL is
  an optional future Adapter.

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

The verified resumption-context operator and its bounded process-local coordinator are now
implemented behind the dedicated `continuity-resume-runtime` subpath and dogfooded by
explicit Pack Preview. The same subpath validates an optional strict preparation request
and presents the existing bilingual Capsule contract only for the exact compared result
that owns both its Pack and receipt evidence. Policy evidence, forget impact, and bounded decision
counterfactuals remain roadmap work. They must follow the same content-addressed source
path plus completeness-or-abstention contract, not arbitrary model-generated graph queries.

The dedicated `shadow-decision-receipt` subpath now binds a fresh timing decision and its
decision-time policy snapshot to that same exact compared-result identity. It serializes
only bounded IDs, status, category-observation digest, and no-authority claims; the private
WeakMap binder is not package-exported. Verified capture requires the exact originating
coordinator, compared result, Pack, timing projection, and Source/Graph dependencies; a
naked serialized receipt fails closed. This is process-local decision provenance, not a
portable restart verifier, delivery path, return signal, policy learner, user-facing card,
or durable ledger.

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
enumerable fields, JSON, settlement behavior, and package exports are unchanged. The
caller-budgeted resumption compiler now settles this inventory, while the coordinator keeps
only exact previous boundaries plus Source/Graph receipts in a 16-entry process-local LRU
and returns semantic-only partial or unavailable results. This is not a persistence layer,
automatic timing system, Capsule product UI, or action path.
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
