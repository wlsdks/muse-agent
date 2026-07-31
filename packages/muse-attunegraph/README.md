# Muse AttuneGraph integration

`@muse/attunegraph` contains Muse-specific Continuity, Shadow, policy/lineage,
receipt, and provider integration built on the agent-neutral
[`@attunegraph/core`](../attunegraph/README.md) engine.

It deliberately has no root export. Consumers import one explicit surface:

- `@muse/attunegraph/continuity`
- `@muse/attunegraph/continuity-changes`
- `@muse/attunegraph/continuity-observations`
- `@muse/attunegraph/continuity-shadow-returns`
- `@muse/attunegraph/continuity-capsules`
- `@muse/attunegraph/continuity-resume-runtime`
- `@muse/attunegraph/continuity-durable-projection`
- `@muse/attunegraph/policy-card`
- `@muse/attunegraph/shadow-decision-receipt`
- `@muse/attunegraph/loop-lineage`

The integration accesses engine capabilities exclusively through the public
`@attunegraph/core` and `@attunegraph/core/extension-kit` entrypoints.

## Claim-safe Policy Card preview

```ts
import {
  compileAttuneGraphPolicyCard
} from "@muse/attunegraph/policy-card";

const result = compileAttuneGraphPolicyCard({
  schemaVersion: 1,
  headRevalidation,
  opportunityId,
  draft,
  evidenceCases,
  locale: "ko"
});
```

The compiler accepts only one process-minted, provider-head-matched local
Attunement snapshot and derives scope from that provider receipt. A rendered
card keeps three evidence classes visibly separate:

1. the authoritative owner experience already recorded by Attunement;
2. structurally self-consistent caller-supplied replay claims whose execution
   provenance is explicitly unverified;
3. an exact four-relation AttuneGraph explanation locally derived from the
   assessed snapshot.

It returns only `{ status: "rendered", card }` or a bounded
`{ status: "held", reason }`. `cardId` is locale-neutral and `renderId` is
locale-specific. Every control is inert: this surface performs no trial, edit,
rejection, approval, policy write, rollback, action, or persistence. Apply is a
separate stale-safe approval flow. Muse exposes the compiler through the
read-only `muse.continuity.learning.policy-card.preview` tool.

## Durable Continuity projection

```ts
import {
  createContinuityAttuneGraphProjector
} from "@muse/attunegraph/continuity-durable-projection";

const projector = createContinuityAttuneGraphProjector({
  databasePath: "/absolute/local/path/attunegraph.sqlite"
});

const result = await projector.project(verifiedContinuityObservationReceipt);
```

This Module verifies the receipt again, preserves its exact scope, assertions,
and observation time, derives the same opaque thread root used by the public
Continuity projection, and submits `canonical-projection@2`. AttuneGraph rejects
the whole observation before persistence if any assertion is disconnected from
that exact root. Historical reset and undo policies receive source-bound thread
scope assertions so a valid non-current history remains connected without
inventing provenance. Freshness is recorded as `unknown`. Calls are serialized
in invocation order. It reads the persisted scope head before the Engine's
atomic compare-and-swap, so restart works without overwriting an unseen
generation; an external writer race rejects, and identical receipt replay does
not advance generation. Every opened Local AttuneGraph instance is closed, with
the primary operation failure taking precedence over cleanup failure.

Muse activates this writer only when `MUSE_ATTUNEGRAPH_DATABASE` is a non-empty
absolute normalized path. There is intentionally no default until portable
export/rebuild clears the default-persistence gate. This Module does not read
Attunement, Notes, Tasks, Notion, or Obsidian stores itself; applications remain
the composition root and authoritative sources remain authoritative.

## Durable Shadow-return relations

The provider/source-revalidated v1 observation remains unchanged. Muse then reads one immutable
capability returned by `readTimingState`, rebuilds the exact Attunement state under the reserved
`muse.local-attunement-timing` source scope, and seals a separately versioned complete observation:

```ts
import {
  captureContinuityShadowReturnObservation,
  readContinuityShadowReturnWorkingGraph
} from "@muse/attunegraph/continuity-shadow-returns";

const composite = captureContinuityShadowReturnObservation({
  baseObservationReceipt,
  state: currentAttunementState,
  timingState: persistedTimingState
});

await projector.project(composite);

const result = await readContinuityShadowReturnWorkingGraph({
  databasePath,
  threadId,
  now,
  maxEstimatedTokens: 8_192
});
```

Each exact in-scope return adds only:

- `Decision --PRECEDED--> Delivery`
- content-addressed return `Evidence --OBSERVED_DURING--> Thread`

Both are `source-observed`, cite the exact return evidence ref, and carry no feedback, outcome,
usefulness, causality, policy, action, or permission. Delivery id, thread, and canonical
`openedAt` must join one existing base Delivery or the whole composition fails closed. The source
and projection versions bind the complete return set; order and replay are deterministic.

The reserved composite scope prevents a legacy provider-only v1 write from replacing these
relations. The Engine also refuses an observation older than its active head. Timing-session
forget removes the receipts from the source ledger, and the next configured full rebuild removes
their relations from the active graph head. Historical SQLite journal bytes are not physically
erased by this logical rebuild.

## Read-only Shadow Return inspection

```ts
import {
  inspectContinuityShadowReturns
} from "@muse/attunegraph/continuity-shadow-returns";

const report = await inspectContinuityShadowReturns({
  databasePath,
  limit: 20,
  maxEstimatedTokens: 12_000,
  now,
  timingState: persistedTimingState
});
```

The inspector accepts only the capability-authenticated frozen snapshot returned by
`readTimingState`, selects at most 20 receipts by newest `openedAt` and stable receipt id, and
deduplicates the optional Working Graph read by thread. Each detached, recursively frozen row
keeps the full source receipt primary and reports one graph status:

- `linked` — one complete, untruncated reserved-scope read contains exactly one active
  receipt-derived `PRECEDED` assertion and one active `OBSERVED_DURING` assertion;
- `not-linked` — a complete read does not contain that exact pair;
- `incomplete` — the bounded operator was partial, truncated, abstained, or structurally
  insufficient to prove cardinality;
- `unavailable` — the configured graph could not be read for that thread;
- `not-configured` — the database setting is absent or exactly empty.

The inspector never writes either store, retries a repair, returns a database path or raw graph
error, or promotes temporal proximity into feedback, outcome, usefulness, causality, policy,
permission, action, or a successful-return claim. Muse's authenticated Continuity API and
English/Korean card are product adapters over this surface; they are not the physical
`@attunegraph/core/admin` Interface.
