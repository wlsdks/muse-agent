import { createApiServerOptions, seedExternalMcpServers } from "@muse/autoconfigure";
import { errorMessage } from "@muse/shared";
import { createGracefulShutdown } from "./graceful-shutdown.js";
import { resolveListenHost, resolveListenPort } from "./listen-config.js";
import { buildServer } from "./server.js";
import { watchParentProcess } from "./parent-watch.js";

type StartupLogger = {
  info: (message: string) => void;
  warn: (message: string) => void;
};

const startupLogger: StartupLogger = {
  info: (message) => {
    process.stdout.write(`[muse] ${message}\n`);
  },
  warn: (message) => {
    process.stderr.write(`[muse] ${message}\n`);
  }
};

// When spawned by the desktop app, self-exit if that parent dies (no orphans).
watchParentProcess();

const port = resolveListenPort(process.env.PORT);
const host = resolveListenHost(process.env.HOST);

const options = createApiServerOptions();
if (!options.agentRuntime) {
  startupLogger.warn("Agent runtime is not configured — set MUSE_MODEL (e.g. gemini/gemini-2.0-flash) or export GEMINI_API_KEY / OPENAI_API_KEY / ANTHROPIC_API_KEY / OPENROUTER_API_KEY for auto-default. /api/chat will return 503 until one is set.");
}
const seeded = await seedExternalMcpServers(
  options.mcpBootstrap.serverStore,
  options.mcpBootstrap.externalServerInputs
);
if (seeded.length > 0) {
  startupLogger.info(`seeded ${seeded.length} external MCP server(s) from ~/.muse/mcp.json: ${seeded.join(", ")}`);
  for (const name of seeded) {
    void options.mcp.manager.connect(name).catch((cause: unknown) => {
      startupLogger.warn(`failed to connect external MCP server '${name}': ${errorMessage(cause, "external MCP server connect failed")}`);
    });
  }
}

const server = buildServer(options);

await server.listen({ host, port });

// Graceful shutdown: drain in-flight cron runs before the process exits.
const schedulerService = options.scheduler?.service;
const shutdown = createGracefulShutdown({
  drainScheduler: schedulerService ? () => schedulerService.shutdown() : undefined,
  closeServer: () => server.close(),

  log: (message) => { startupLogger.info(message); }
});
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
