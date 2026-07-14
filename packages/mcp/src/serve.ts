/**
 * Expose a set of `MuseTool`s AS an MCP server over stdio — the server-side
 * counterpart of `loopback.ts`'s client-side `createLoopbackMcpConnection`
 * (which wraps an EXTERNAL MCP server as a Muse tool). This wraps Muse's OWN
 * tools as an MCP server so another agent (Claude Code, Cursor, Codex, …) can
 * connect to Muse and call them. Backs `muse mcp serve`.
 *
 * Deliberately the LOW-LEVEL `Server` (not the high-level `McpServer`): the
 * high-level API models tool schemas as Zod, while every `MuseTool` already
 * carries a plain JSON-Schema `inputSchema` (the contract `tool-calling.md`
 * and the rest of Muse's tool system are built on) — routing through Zod here
 * would add a second schema language for one surface. The low-level `Server`
 * takes the JSON Schema as-is and speaks the exact same `tools/list` /
 * `tools/call` JSON-RPC shapes `transport.ts`'s `Client` consumes on the way
 * in, so the two sides of Muse's MCP support share one wire contract.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { once } from "node:events";
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult, type Tool } from "@modelcontextprotocol/sdk/types.js";

import type { JsonObject, JsonValue } from "@muse/shared";
import type { MuseTool, MuseToolContext } from "@muse/tools";

export interface MuseToolsMcpServerOptions {
  readonly serverName: string;
  readonly serverVersion?: string;
  readonly tools: readonly MuseTool[];
  /** Surfaced to the connecting client (e.g. Claude Code) as server instructions. */
  readonly instructions?: string;
}

/**
 * Build an MCP `Server` that answers `initialize` / `tools/list` / `tools/call`
 * for exactly the given `tools`. Callers `connect()` it to a transport
 * (`StdioServerTransport` in production; `InMemoryTransport` / a custom
 * `Transport` in tests) — this function never touches stdio itself.
 */
export function createMuseToolsMcpServer(options: MuseToolsMcpServerOptions): Server {
  const toolsByName = new Map(options.tools.map((tool) => [tool.definition.name, tool] as const));

  const server = new Server(
    { name: options.serverName, version: options.serverVersion ?? "1.0.0" },
    {
      capabilities: { tools: {} },
      ...(options.instructions ? { instructions: options.instructions } : {})
    }
  );

  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: options.tools.map((tool): Tool => ({
      annotations: { readOnlyHint: tool.definition.risk === "read" },
      description: tool.definition.description,
      inputSchema: toMcpInputSchema(tool.definition.inputSchema),
      name: tool.definition.name
    }))
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
    const tool = toolsByName.get(request.params.name);
    if (!tool) {
      return errorResult(`Unknown tool '${request.params.name}'. Call tools/list first.`);
    }

    const args = (request.params.arguments ?? {}) as JsonObject;
    const missing = missingRequiredArgs(tool.definition.inputSchema, args);
    if (missing.length > 0) {
      return errorResult(`'${tool.definition.name}' is missing required argument(s): ${missing.join(", ")}`);
    }

    const context: MuseToolContext = { runId: `mcp-serve-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}` };
    try {
      const value = await tool.execute(args, context);
      return toolResult(value);
    } catch (error) {
      // A thrown error (a failed model call, a store read failure, …) MUST
      // reach the client as a structured tool error — never crash the server
      // process and never silently degrade into an uncited/empty "success".
      return errorResult(`'${tool.definition.name}' failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  });

  return server;
}

/**
 * Run `server` over the real process stdio until the client disconnects
 * (stdin closes) — the CLI's `muse mcp serve` production entrypoint. Kept
 * here (not in the CLI) so the `@modelcontextprotocol/sdk` dependency stays
 * confined to `@muse/mcp`, matching how `transport.ts` is the SDK's only
 * client-side entry point.
 */
export async function runStdioMcpServer(server: Server, onListening?: () => void): Promise<void> {
  const transport = new StdioServerTransport();
  transport.onclose = () => {
    // Align with prior behavior where STDIO transport completion closes the
    // server command loop; no-op here because process stdin close remains the
    // lifetime signal in this harness.
  };
  await server.connect(transport);
  onListening?.();
  await once(process.stdin, "close");
}

/**
 * `MuseToolDefinition.inputSchema` is already `{ type: "object", properties,
 * required, additionalProperties }` by convention (every Muse tool schema is
 * shaped this way per `tool-calling.md`) — this only narrows the loosely-typed
 * `JsonObject` into the SDK's `Tool["inputSchema"]` shape without touching the
 * content, so a tool's real schema reaches the client byte-identical.
 */
function toMcpInputSchema(schema: JsonObject): Tool["inputSchema"] {
  const properties = schema.properties && typeof schema.properties === "object" && !Array.isArray(schema.properties)
    ? (schema.properties as Record<string, object>)
    : undefined;
  const required = Array.isArray(schema.required)
    ? schema.required.filter((entry): entry is string => typeof entry === "string")
    : undefined;
  return {
    type: "object",
    ...(properties ? { properties } : {}),
    ...(required && required.length > 0 ? { required } : {}),
    ...(schema.additionalProperties !== undefined ? { additionalProperties: schema.additionalProperties } : {})
  } as Tool["inputSchema"];
}

function missingRequiredArgs(schema: JsonObject, args: JsonObject): readonly string[] {
  const required = Array.isArray(schema.required)
    ? schema.required.filter((entry): entry is string => typeof entry === "string")
    : [];
  return required.filter((key) => args[key] === undefined || args[key] === null);
}

function toolResult(value: string | JsonValue): CallToolResult {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return { content: [{ text, type: "text" }] };
}

function errorResult(message: string): CallToolResult {
  return { content: [{ text: message, type: "text" }], isError: true };
}
