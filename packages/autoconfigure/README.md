# @muse/autoconfigure

The runtime composition root: assembles every other package (model provider, tool registry,
stores, recall pipeline, scheduler) into one running `MuseRuntimeAssembly` from environment
variables, and owns the config-file/storage-path resolution both CLI and server rely on. It
is a package because this wiring is genuinely one cohesive unit of "read the environment,
build the runtime" that every entry point (`apps/cli`, `apps/api`) calls into identically.

## Public surface

- `createMuseRuntimeAssembly`, `MuseRuntimeAssembly`, `MuseEnvironment`, `ConfigurationError`
  — the composition root (`runtime-assembly.js`).
- `createModelProvider`, `resolveDefaultModel`, `resolveModelFallbackChain`,
  `DEFAULT_LOCAL_MODEL` — default-model resolution (env → local-only → config → ambient
  credential → local fallback).
- `resolveNotesDir`, `resolveTasksFile`, `resolveRemindersFile`, `resolveMuseCliConfigFilePath`,
  and ~50 sibling `resolve*File`/`resolve*Dir` functions — the single source of truth for every
  personal-store file path under the user's config directory.
- `collectSetupStatusJson`, `evaluateLocalOnlyPosture`, `evaluateWebEgressStatus` — the
  `muse doctor`-style setup/posture status projection.
- `resolveModelSwitchTarget`, `fetchInstalledOllamaModels`, `writeMuseCliDefaultModel` — the
  model-registry/switch surface.
- `createBudgetedLlmDetector`, `createReviewCommitmentsArm`, `createReviewSkillArm` — the
  background-review LLM arms.
- `buildRuntimeToolRegistry`, `createDefaultLoopbackMcpToolsFromEnv` — assembles the concrete
  `ToolRegistry` from environment configuration.
- `createOverdueContactsTool`, `createWeekAgendaTool`, `createTodayBriefTool`,
  `createDayRecapTool`, `createFindItemsTool` — cross-domain composed tools.

## Depends on

- `@muse/agent-core`, `@muse/model`, `@muse/prompts`, `@muse/tools` — the runtime, model,
  prompt, and tool contracts assembled together.
- `@muse/memory`, `@muse/stores`, `@muse/db`, `kysely` — the persistence layers wired in.
- `@muse/mcp`, `@muse/domain-tools`, `@muse/messaging`, `@muse/voice`, `@muse/macos` — the
  concrete tool/channel/voice implementations composed into the registry.
- `@muse/attunement`, `@muse/attunegraph`, `@muse/recall`, `@muse/proactivity`,
  `@muse/scheduler` — the continuity, recall, proactive, and scheduling subsystems.
- `@muse/auth`, `@muse/cache`, `@muse/observability`, `@muse/resilience`,
  `@muse/runtime-settings`, `@muse/runtime-state`, `@muse/skills`, `@muse/calendar`,
  `@muse/shared` — cross-cutting infra each subsystem needs.

## Rules that bind this package

- [`../../.claude/rules/engineering/architecture.md`](../../.claude/rules/engineering/architecture.md) — `createModelProvider`'s fallback chain and the
  `MUSE_LOCAL_ONLY` gate are resolved here; the model-router throws `LocalOnlyViolationError`
  before ever instantiating a cloud provider.
- [`../../.claude/rules/engineering/cli-product.md`](../../.claude/rules/engineering/cli-product.md) — the `resolve*File` functions are the canonical
  `~/.config/muse/config.json` / `.muse/runs/*.jsonl` storage-path contract for both surfaces.

## Tests

```bash
pnpm --filter @muse/autoconfigure test
```
