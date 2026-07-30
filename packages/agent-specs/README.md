# @muse/agent-specs

Owns the definition and resolution of Muse's named agent personas ("specs"): their system
prompt, tools, keywords, and orchestration mode, plus keyword-based routing from free text to the
matching spec and the A2A-style capability card built from the active toolset. It is a package
rather than a folder because persona storage (in-memory or Kysely) and persona-to-request
resolution need one shared model so the CLI, API, and orchestrator route identically.

## Public surface

- `AgentSpec`, `AgentSpecInput`, `AgentSpecMode`, `normalizeAgentSpecInput` — the persona shape and
  its input-normalization contract.
- `DEFAULT_AGENT_SPECS` — the two built-in orchestration-only personas (Generalist, Critic) seeded
  into a fresh registry so sequential orchestration works before a user authors any spec.
- `AgentSpecRegistry`, `InMemoryAgentSpecRegistry`, `KyselyAgentSpecRegistry` — the persona store
  interface and its in-memory / Postgres-backed implementations.
- `RuleBasedAgentSpecResolver`, `scoreAgentSpec`, `AgentSpecResolution` — keyword-match resolution
  from a request's text to the best-fit enabled spec above a confidence threshold.
- `buildAgentCard`, `AgentCard`, `AgentCapability`, `BuildAgentCardOptions` — builds a
  capability-discovery card (tools + persona descriptions) mirroring A2A's `AgentCard` shape.

## Depends on

- `@muse/db` — the Kysely database handle for `KyselyAgentSpecRegistry`.
- `@muse/shared` — `createRunId` and other common primitives.

## Rules that bind this package

None of this package's own rules are unusual — it owns pure persona data and resolution logic, no
outbound or actuator surface — but the personas it stores are consumed by
`@muse/multi-agent`'s orchestration, so a spec's `toolNames` and `systemPrompt` indirectly gate
what an orchestrated worker can do; keep that in mind when authoring a new default spec.

## Tests

```bash
pnpm --filter @muse/agent-specs test
```
