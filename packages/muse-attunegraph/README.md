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
- `@muse/attunegraph/shadow-decision-receipt`
- `@muse/attunegraph/loop-lineage`

The integration accesses engine capabilities exclusively through the public
`@attunegraph/core` and `@attunegraph/core/extension-kit` entrypoints.

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
