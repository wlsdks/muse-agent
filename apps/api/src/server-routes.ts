/**
 * Barrel re-exporting the per-domain Fastify route registrars so
 * server.ts and existing test imports keep working unchanged after
 * the domain split into routes-*.ts.
 */

export {
  registerCoreRoutes,
  registerChatRoutes,
  parseChatRateLimitCapacity,
  isChatRateLimitDisabled
} from "./routes-core-chat.js";

export { registerAdminRunRoutes } from "./routes-admin-run.js";

export { registerAuthRoutes } from "./routes-auth.js";

export { registerAgentSpecRoutes, registerToolsRoutes } from "./routes-agent-tools.js";

export { registerSessionSummaryRoutes, registerRuntimeSettingsRoutes } from "./routes-session-runtime.js";

// `/api/calendar/*` routes live in `./calendar-routes.ts` (lifted out
// to keep the calendar surface focused). Re-exported here so server.ts
// and any future consumers keep working through `./server-routes.js`.
export { registerCalendarRoutes } from "./calendar-routes.js";

// `/api/tasks/*` routes live in `./tasks-routes.ts` (lifted out so
// the on-disk tasks store helpers stay close to the route surface).
// Re-exported here so server.ts keeps working through
// `./server-routes.js`.
export { registerTasksRoutes } from "./tasks-routes.js";
