# Splitting `@muse/mcp` — migration plan

`@muse/mcp` accreted into a 29k-LOC god-package: the MCP-protocol core
(`McpManager`, transport, validators, allowlist) is only ~1k LOC; the rest is
unrelated domain logic — personal stores, proactive daemons, and domain tools
(email/weather/smart-home/contacts/calendar/tasks/notes). The package name no
longer matches its contents and its blast radius is the whole repo.

This document is the execution spec. It is derived from a read-only dependency
+ consumer audit (131 files categorized, 234 external consumer files cataloged).

## Target layering (verified acyclic)

```
@muse/shared            (existing — gains http-retry)
  └─ @muse/mcp-shared   (NEW, tiny utils: relative-time, due-format, median-gap,
  │                      messaging-retry, loopback-helpers, provider-routing,
  │                      proactive-notice-types)
  │     └─ @muse/stores         (NEW: atomic/encrypted file + all personal-*-store)
  │          └─ @muse/proactivity (NEW: *-loop daemons, objective-*, quiet-hours,
  │          │                     consented/proposed/undo-action, run-outcome-analysis)
  │          │    └─ @muse/domain-tools (NEW: web/pim/ambient tools + loopback
  │          │                            servers + provider registries + run-actuator)
  └────────────────────────→ @muse/mcp (SLIMMED: protocol types, McpManager,
                                          transport, validators, stores, presets,
                                          loopback framework primitive)
```

`@muse/mcp` ends at the TOP, not the bottom: the loopback domain servers need
`createMcpMuseTool` + types from core, so core sits *below* domain-tools. The
`createDefaultLoopbackMcpServers` aggregator (which imports every domain server)
must NOT live in core — it moves to the composition root (`@muse/autoconfigure`),
leaving only the framework primitive `createLoopbackMcpConnection` in core.

Build-graph rule holds throughout: every internal `@muse/*` dep lives in BOTH
`package.json` deps AND `tsconfig.json` `references`; the graph stays acyclic;
no new package may depend on `@muse/agent-core` (the duck-typed shapes in the
loops/stores stay as LOCAL interfaces).

## PR sequence (leaf-first, each green standalone)

### PR 0 — prerequisite refactors inside the still-monolithic `@muse/mcp`
Behavior-preserving; no new package; no external import changes. Breaks the two
real cycles + splits `loopback.ts`. Must land first or the extractions cycle.

- **0a — store↔loop type cycle.** `personal-proactive-history-store.ts` imports
  `type ProactiveFiredKind` from `proactive-notice-loop.js`; `quiet-hours.ts`
  imports `type ProactiveNoticeSink` from it; the loop imports
  `appendProactiveHistory` (value) back. Fix: move `ProactiveFiredKind` DOWN into
  the store (it's the `"calendar"|"task"` union the store persists) and extract
  `ProactiveNoticeSink`/`ProactiveActivitySource` to a new
  `proactive-notice-types.ts`; both the loop and quiet-hours import the type from
  below. Result: `proactivity → stores`, never the reverse.
- **0b — proactivity↔domain cycle.** `run-actuator-by-name.ts` imports VALUES
  from `email-tool`/`smart-home-tool`/`web-action-tool` (domain); domain
  loopback servers (`loopback-status/episodes/notes`) import `proactive-notice-loop`.
  Fix: re-tag `run-actuator-by-name.ts` as domain-tools (it's an actuator
  dispatcher over domain tools). Verify `objective-evaluator.ts` reaches it only
  through the injected `*ObjectiveActuator` seam wired at the composition root,
  never a direct import.
- **0c — split `loopback.ts`.** Keep the framework primitive
  (`createLoopbackMcpConnection`/`createLoopbackMcpMuseTools`/`LoopbackMcpServer`)
  in core; move the `createDefaultLoopbackMcpServers` aggregator to
  `@muse/autoconfigure` (it already has a sibling there). Gate:
  `pnpm --filter @muse/mcp test` + `pnpm --filter @muse/autoconfigure build`.

### PR 1 — `@muse/mcp-shared` (+ `http-retry` → `@muse/shared`)
~9 pure util file moves; ~10 external import lines. Leaf utils used by stores +
domain (relative-time, due-format). `http-retry.ts` goes to `@muse/shared`.

### PR 2 — `@muse/stores` (HEAVIEST tail)
~50 file moves (`atomic-file-store`, `encrypted-file`, every `personal-*-store`,
`reflections-store`, `weakness-ledger`, `swarm-quarantine-store`, …). ~130
consumer files repoint `@muse/mcp` → `@muse/stores`. Batch the rewrite by
consumer package (one commit per app/package). Hot symbols: `readTasks`,
`readReminders`, `PersistedTask`, `queryContacts`, `queryPlaybook`, …

### PR 3 — `@muse/proactivity`
~20 file moves (`*-loop`, `objective-*`, `quiet-hours`, `consented/proposed/undo-action`,
`run-outcome-analysis`). ~35 consumers (mostly `apps/api/*-tick.ts` +
`commands-daemon.ts`). RISK R1: `situational-briefing*` import `weather`/
`email-provider`/`calendar-availability` (domain) — keep these as INJECTED
provider interfaces (`runDueSituationalBriefing` already takes
`EmailProvider`/`WeatherProvider`), or move `calendar-availability.ts` DOWN to
mcp-shared (pure leaf). Resolve before this PR.

### PR 4 — `@muse/domain-tools`
~60 file moves (web/pim/ambient tools + their loopback servers + provider
registries + `run-actuator-by-name`). ~80 consumers; `autoconfigure/src/index.ts`
is the heaviest single file (re-export barrel — must add deps+refs for every new
package it re-exports from, in the SAME commit). Pure-util loopback servers
(math/json/regex/text-utils/url/time/crypto/diff) STAY in mcp-core with the
framework.

### PR 5 — `@muse/mcp` slim residue
No moves. Verify core builds with only `@muse/tools` + `@muse/mcp-shared` deps;
remove now-dead re-exports from the barrel. ~0 external changes (consumers of
`McpManager`/`McpServer`/etc. still import from `@muse/mcp`).

## Risk flags

- **R1** proactivity→domain via `situational-briefing*` — inject providers or
  move `calendar-availability` to mcp-shared (above).
- **R4** `objective-evaluator.ts` must not directly import `run-actuator-by-name`
  (use the injected actuator seam) — verify before PR 3.
- **R5** `upload-path-validator.ts` is uncategorized — find its consumer before
  placing; park in mcp-shared/core until then.
- **R7** `autoconfigure/src/index.ts` barrel fan-out — the highest-risk edit for a
  forgotten `tsconfig` reference; update its references in the same commit as its
  imports (`tsc -b` "stale .d.ts" failure class).
- **R8** no new package may add a real `@muse/agent-core` dep — keep the
  duck-typed `AgentRuntime`/notice-broker shapes as local interfaces.

## Per-step gate

Before each PR run `codegraph_impact` on the moved symbols to catch a consumer
the static catalog missed. After each: `pnpm --filter <new-pkg> build && test`
then `pnpm --filter @muse/autoconfigure build` (the densest consumer) before
touching the next layer. Final: full `pnpm build` + `pnpm lint` + `pnpm smoke:live`.
