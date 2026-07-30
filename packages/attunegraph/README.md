# AttuneGraph Core

`@attunegraph/core` is an agent-neutral temporal and provenance graph engine.
It turns bounded source observations into immutable projections and compiles a
small Working Graph for one agent decision.

The package does not treat graph proximity as truth, feedback, policy,
permission, or action authority. Authoritative data remains in its source
system; AttuneGraph stores rebuildable relations and exact source references.

## Package boundary

This directory is a neutral package boundary inside a larger monorepo. It has:

- no package dependencies;
- no TypeScript project references;
- no host-product imports;
- a provider-neutral engine and store capability;
- an in-memory semantic oracle and a worker-isolated SQLite adapter;
- a canonical NDJSON portable format with checked-in golden fixtures.

That boundary makes extraction possible, but it is not a claim that a separate
public repository, registry release, or hosted service already exists.

## Public exports

- `@attunegraph/core` — engine lifecycle, graph contracts, and bounded
  Activation Subgraph compilation.
- `@attunegraph/core/backend` — the expert store-adapter seam.
- `@attunegraph/core/local` — the durable local SQLite adapter.
- `@attunegraph/core/testing` — in-memory adapters and executable conformance
  contracts.
- `@attunegraph/core/extension-kit` — a narrow set of canonicalization,
  validation, settlement, and witness-path primitives for integration
  packages.

Source filenames and all other package subpaths are private.

## Quick start

```ts
import {
  openAttuneGraph,
  type AttuneGraphScope,
  type GraphAssertion
} from "@attunegraph/core";
import {
  createInMemoryAttuneGraphStore
} from "@attunegraph/core/testing";

const scope: AttuneGraphScope = {
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

const attuneGraph = await openAttuneGraph({
  scope,
  store: createInMemoryAttuneGraphStore()
});

const snapshot = await attuneGraph.project({
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

const result = await attuneGraph.execute({
  operator: "working-graph@1",
  seed: { kind: "thread", id: "trip-planning" },
  now: "2026-07-30T09:00:00.000Z",
  maxEstimatedTokens: 2_000
});

console.log(snapshot.commitId, result.status, result.workingGraph);
await attuneGraph.close();
```

The process-local in-memory adapter is intended for tests and experiments. It
does not provide durable storage.

## Durable local store

```ts
import { openLocalAttuneGraph } from "@attunegraph/core/local";

const attuneGraph = await openLocalAttuneGraph({
  databasePath: "/absolute/local/path/attunegraph.sqlite",
  scope: {
    sourceId: "notes",
    threadId: "trip-planning"
  }
});

// project and execute use the same contracts as the root engine.
await attuneGraph.close();
```

The local adapter keeps SQLite, SQL, worker lifecycle, and physical schema
private. It validates the runtime, filesystem, ownership, file mode, exact
physical identity, schema, and safety pragmas before serving data. Unsupported,
future, corrupt, and incompatible stores fail closed.

## Portable format

Portable artifacts use the `.atgx` extension and the
`attunegraph-portable` manifest identity. The format is canonical NDJSON, not a
binary container. Exact framing, hashes, ordering, limits, and validation-sink
requirements are specified in [PORTABLE-FORMAT.md](PORTABLE-FORMAT.md).

Artifacts and databases created with the superseded identities are
intentionally incompatible. The package rejects them before mutation; it does
not carry a compatibility alias or migration path.

## Development

```bash
pnpm --filter @attunegraph/core typecheck
pnpm --filter @attunegraph/core build
pnpm --filter @attunegraph/core test
pnpm --filter @attunegraph/core fixtures:portable
pnpm --filter @attunegraph/core verify:portable-fixtures
pnpm --filter @attunegraph/core verify:local
```

Fixture generation is deterministic. Regeneration must reproduce the checked-in
inputs, `.atgx` artifacts, manifest hashes, byte counts, record identities, and
state identities exactly.

Passing these checks proves the package contracts. It does not prove that an
agent has learned a person, improved its timing, or produced a real-world
outcome.
