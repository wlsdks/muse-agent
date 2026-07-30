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
- `@muse/attunegraph/shadow-decision-receipt`
- `@muse/attunegraph/loop-lineage`

The integration accesses engine capabilities exclusively through the public
`@attunegraph/core` and `@attunegraph/core/extension-kit` entrypoints.
