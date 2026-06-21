import { createApiServerOptions, seedExternalMcpServers } from "@muse/autoconfigure";
import { resolveListenHost, resolveListenPort } from "./listen-config.js";
import { buildServer } from "./server.js";
import { watchParentProcess } from "./parent-watch.js";

// When spawned by the desktop app, self-exit if that parent dies (no orphans).
watchParentProcess();

const port = resolveListenPort(process.env.PORT);
const host = resolveListenHost(process.env.HOST);

const options = createApiServerOptions();
if (!options.agentRuntime) {

  console.warn("[muse] Agent runtime is not configured — set MUSE_MODEL (e.g. gemini/gemini-2.0-flash) or export GEMINI_API_KEY / OPENAI_API_KEY / ANTHROPIC_API_KEY / OPENROUTER_API_KEY for auto-default. /api/chat will return 503 until one is set.");
}
const seeded = await seedExternalMcpServers(
  options.mcpBootstrap.serverStore,
  options.mcpBootstrap.externalServerInputs
);
if (seeded.length > 0) {
   
  console.log(`[muse] seeded ${seeded.length} external MCP server(s) from ~/.muse/mcp.json: ${seeded.join(", ")}`);
  for (const name of seeded) {
    void options.mcp.manager.connect(name).catch((cause: unknown) => {
       
      console.warn(`[muse] failed to connect external MCP server '${name}': ${cause instanceof Error ? cause.message : String(cause)}`);
    });
  }
}

const server = buildServer(options);

await server.listen({ host, port });
