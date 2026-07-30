# Muse AttuneGraph integration

`@muse/attunegraph` contains Muse-specific Continuity, Shadow, policy/lineage,
receipt, and provider integration built on the agent-neutral
[`@attunegraph/core`](../attunegraph/README.md) engine.

It deliberately has no root export. Consumers import one explicit surface:

- `@muse/attunegraph/continuity`
- `@muse/attunegraph/continuity-changes`
- `@muse/attunegraph/continuity-observations`
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
and observation time, and records freshness as `unknown`. Calls are serialized
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
