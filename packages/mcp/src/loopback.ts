import type { JsonObject, JsonValue } from "@muse/shared";
import type { MuseTool } from "@muse/tools";
import { createMcpMuseTool, type McpConnection, type McpRemoteTool } from "./index.js";

/**
 * Loopback MCP servers — provider-neutral built-in MCP surfaces.
 *
 * The MCP layer in Muse normally connects to external MCP servers over stdio /
 * SSE / streamable HTTP. To prove the MCP path works without external
 * processes (and to ship a Muse ambient baseline), this module supplies an
 * in-process `McpConnection` adapter plus three reference servers (time,
 * text-utils, math) that operators can register alongside any external MCP
 * server.
 *
 * Each loopback server exposes a curated set of tools whose `execute` runs
 * in-process. They are read-risk by default, deterministic, and require no
 * credentials so they can ship by default.
 */

export interface LoopbackMcpToolDefinition extends McpRemoteTool {
  execute(args: JsonObject): Promise<string | JsonValue> | string | JsonValue;
}

export interface LoopbackMcpServer {
  readonly name: string;
  readonly description?: string;
  readonly tools: readonly LoopbackMcpToolDefinition[];
}

/**
 * Wrap a loopback server as an `McpConnection` so the rest of the MCP stack
 * (tool catalog, security policy, MuseTool adapter, span tracer) can treat it
 * exactly like an external MCP server.
 */
export function createLoopbackMcpConnection(server: LoopbackMcpServer): McpConnection {
  const tools = new Map(server.tools.map((tool) => [tool.name, tool] as const));
  return {
    callTool: async (toolName, args) => {
      const tool = tools.get(toolName);
      if (!tool) {
        return `Error: MCP tool '${toolName}' is not registered on '${server.name}'`;
      }
      try {
        const result = await tool.execute(args);
        return result;
      } catch (error) {
        return `Error: MCP tool '${toolName}' on '${server.name}' threw — ${error instanceof Error ? error.message : String(error)}`;
      }
    },
    close: async () => {
      // Loopback servers have no resource to release.
    },
    listTools: async () =>
      server.tools.map((tool) => ({
        description: tool.description,
        ...(tool.groundedArgs && tool.groundedArgs.length > 0 ? { groundedArgs: tool.groundedArgs } : {}),
        inputSchema: tool.inputSchema ?? {},
        name: tool.name,
        ...(tool.risk ? { risk: tool.risk } : {})
      } satisfies McpRemoteTool))
  };
}

/**
 * Convenience: register every tool of the loopback server as a Muse tool with
 * the same `<server>.<tool>` namespacing used by external MCP servers.
 */
export function createLoopbackMcpMuseTools(server: LoopbackMcpServer): readonly MuseTool[] {
  const connection = createLoopbackMcpConnection(server);
  return server.tools.map((tool) =>
    createMcpMuseTool(
      server.name,
      {
        description: tool.description,
        ...(tool.domain ? { domain: tool.domain } : {}),
        ...(tool.groundedArgs && tool.groundedArgs.length > 0 ? { groundedArgs: tool.groundedArgs } : {}),
        ...(tool.keywords && tool.keywords.length > 0 ? { keywords: tool.keywords } : {}),
        inputSchema: tool.inputSchema ?? {},
        name: tool.name,
        ...(tool.risk ? { risk: tool.risk } : {})
      },
      connection
    )
  );
}

export interface BuiltinLoopbackOptions {
  readonly now?: () => Date;
  readonly uuid?: () => string;
  /** Forwarded to `createSearchMcpServer` so a self-hosted SearXNG instance becomes the preferred backend. */
  readonly searxngUrl?: string;
  /** Forwarded to `createSearchMcpServer` — comma-separated engine list passed through to SearXNG. */
  readonly searxngEngines?: string;
}

import { createJsonMcpServer } from "./loopback-json-server.js";
import { createMathMcpServer, evaluateArithmeticExpression } from "./loopback-math-server.js";
import { createTextUtilsMcpServer } from "./loopback-text-utils-server.js";
import { createTimeMcpServer } from "./loopback-time-server.js";
import { createUrlMcpServer } from "./loopback-url-server.js";

export {
  createJsonMcpServer,
  createMathMcpServer,
  evaluateArithmeticExpression,
  createTextUtilsMcpServer,
  createTimeMcpServer,
  createUrlMcpServer
};

/**
 * `muse.crypto` deterministic crypto digests + base64/hex encoding +
 * v4 UUID. Implementation lives in `./loopback-crypto.ts` (lifted
 * out as the next-biggest ambient factory after regex). Imported
 * here for the catalog's own use AND re-exported so the `@muse/mcp`
 * barrel and existing tests keep working without import-site edits.
 */
import { createCryptoMcpServer } from "./loopback-crypto.js";

export { createCryptoMcpServer };

/**
 * Reference loopback server: line-level diff utilities. Uses a deterministic
 * Longest Common Subsequence backtrack so two callers with identical inputs
 * always get the same diff order. Bounded at 2,000 lines per side to keep the
 * O(M*N) DP within ~4MB of memory.
 */
import { createDiffMcpServer } from "./loopback-diff-server.js";
export { createDiffMcpServer };

/**
 * `muse.regex` bounded regex utilities (test / match / replace).
 *
 * Implementation lives in `./loopback-regex.ts` (lifted out as the
 * largest single ambient factory). Imported here for the catalog's
 * own use AND re-exported so the `@muse/mcp` barrel and existing
 * tests keep working without import-site edits.
 */
import { createRegexMcpServer } from "./loopback-regex.js";

export { createRegexMcpServer };
