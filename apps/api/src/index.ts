import { createApiServerOptions, seedExternalMcpServers } from "@muse/autoconfigure";
import { buildServer } from "./server.js";

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? "127.0.0.1";

const options = createApiServerOptions();
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
