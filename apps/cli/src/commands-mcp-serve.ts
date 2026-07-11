/**
 * Production wiring for `muse mcp serve` — connects the 6 tools
 * (`mcp-serve-tools.ts`) to a real `StdioServerTransport` and runs until
 * stdin closes. All logging goes to stderr; stdout carries ONLY the MCP
 * JSON-RPC wire protocol.
 */

import { createMuseToolsMcpServer, runStdioMcpServer } from "@muse/mcp";

import { buildMcpServeTools, resolveMcpServeDependencies } from "./mcp-serve-tools.js";
import { MUSE_CLI_VERSION } from "./muse-version.js";
import type { ProgramIO } from "./program.js";

const MCP_SERVE_INSTRUCTIONS =
  "Muse's own tools — five read-only: muse_recall (cited grounded Q&A over the user's notes), " +
  "knowledge_search (deterministic ranked search over the user's notes + remembered facts/preferences), " +
  "user_model_read (the user's facts/preferences with confidence), calendar_read (events in a given " +
  "window), and tasks_read (the user's to-do tasks) — plus one write-proxy: propose_action, which only " +
  "PARKS a proposed action in the user's approval queue for them to review and never executes it. " +
  "Everything runs locally; nothing leaves this machine, and nothing here writes or changes anything " +
  "without the user's explicit approval.";

export async function runMcpServeCommand(io: ProgramIO): Promise<void> {
  const deps = resolveMcpServeDependencies(process.env as Record<string, string | undefined>);
  const tools = buildMcpServeTools(deps);
  const server = createMuseToolsMcpServer({
    instructions: MCP_SERVE_INSTRUCTIONS,
    serverName: "muse",
    serverVersion: MUSE_CLI_VERSION,
    tools
  });
  server.onerror = (error: Error) => {
    io.stderr(`muse mcp serve: ${error.message}\n`);
  };

  await runStdioMcpServer(server, () => {
    io.stderr(`muse mcp serve: listening on stdio (${tools.length.toString()} tools) — Ctrl-D or client disconnect to stop\n`);
  });
}
