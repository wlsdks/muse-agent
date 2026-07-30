# muse api

The Fastify HTTP/SSE server (`@muse/api`) that runs `packages/agent-core` as a remote-mode
backend for the CLI, web, and desktop surfaces — same runtime and guard contracts as CLI local
mode, per `../../.claude/rules/cli-product.md`.

## Public surface

`apps/api/src/server.ts` wires ~50 Fastify route registrars from `apps/api/src/routes-*.ts` and
per-domain `*-routes.ts` files. Grouped by area:

- **Chat & core** — `registerCoreRoutes`, `registerChatRoutes` (`routes-core-chat.ts`),
  `registerAskRoutes`, `registerConversationsRoutes`, `registerPromptRoutes`.
- **Auth & admin** — `registerAuthRoutes`, `registerAdminRunRoutes`, `registerAdminRoutes`,
  `registerAgentSpecRoutes`, `registerToolsRoutes`, `registerRuntimeSettingsRoutes`,
  `registerSettingsRoutes`, `registerSetupRoutes`, `registerDoctorRoutes`.
- **Personal data & continuity** — `registerCalendarRoutes`, `registerTasksRoutes`,
  `registerNotesRoutes`, `registerRemindersRoutes`, `registerTodayRoutes`,
  `registerJourneyRoutes`, `registerHistoryRoutes`, `registerAttunementRoutes`,
  `registerActiveContextRoutes`, `registerUserModelReconfirmRoutes`.
- **Proactive & automation** — `registerProactiveRoutes`, `registerAutomationRoutes`,
  `registerAutomationProposalsRoutes`, `registerFlowsRoutes`, `registerFlowDraftRoutes`,
  `registerSchedulerRoutes`, `registerWebhookTriggerRoutes`, `registerProgressiveAutonomyRoutes`,
  `registerAgentNoticesRoutes`, `registerSelfImprovementRoutes`.
- **Multi-agent & orchestration** — `registerMultiAgentRoutes`, `registerSwarmRoutes`,
  `registerWorksRoutes`, `registerBoardRoutes`, `registerAccountabilityRoutes`.
- **Connections** — `registerMcpRoutes`, `registerMessagingRoutes`,
  `registerMessagingSetupRoutes`, `registerVoiceRoutes`, `registerEmailStatusRoutes`.
- **Compatibility shims** — `registerCompatibilityRoutes` (`compat-routes.ts` and its
  `compat-*.ts` helpers) for older client contracts.
- **Static hosting** — `registerStaticWeb` serves the bundled `apps/web` build under
  `MUSE_WEB_DIR`.

### Development

```bash
pnpm --filter @muse/api dev     # tsx src/index.ts, listens on $HOST:$PORT (defaults apply)
pnpm --filter @muse/api build   # tsc -b
```

## Depends on

`@muse/api` assembles the server from most domain packages: agent-core, agent-specs, auth,
attunement, autoconfigure, calendar, domain-tools, macos, mcp, mcp-shared, memory, messaging,
model, multi-agent, observability, policy, proactivity, prompts, recall, runtime-settings,
runtime-state, scheduler, shared, skills, stores, tools, voice, plus `fastify` as the HTTP layer.

## Rules that bind this package

- Server and CLI share the same `agent-core` runtime, guard semantics, and approval gates — no
  behavior fork, per `../../.claude/rules/cli-product.md`.
- Outbound sends toward a third party (messaging routes, webhook triggers) are draft-first and
  fail-close per `../../.claude/rules/outbound-safety.md` — never an autonomous send.
- Tool output reaching a route handler is untrusted per `../../.claude/rules/architecture.md`.

## Tests

`pnpm --filter @muse/api test`
