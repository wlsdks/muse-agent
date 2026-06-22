import type { JsonObject, JsonValue } from "@muse/shared";
import type { MuseTool, ToolRisk } from "@muse/tools";
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

import { createSearchMcpServer } from "./loopback-search.js";

export { createSearchMcpServer, type SearchMcpServerOptions } from "./loopback-search.js";

/**
 * `muse.fetch` bounded HTTP GET/HEAD fetcher (allowlist-required).
 *
 * Implementation lives in `./loopback-fetch.ts`. Imported here for
 * the catalog's own use AND re-exported so the `@muse/mcp` barrel
 * and existing tests keep working without import-site edits.
 */
import {
  createFetchMcpServer,
  type FetchMcpServerOptions
} from "./loopback-fetch.js";

export { createFetchMcpServer, type FetchMcpServerOptions };

/**
 * `muse.fs` bounded filesystem reader (allowlist-rooted, read-only).
 *
 * Implementation lives in `./loopback-filesystem.ts` (lifted out so
 * the path-allowlist policy and the small fs/path injection seams
 * stay co-located). Imported here for the catalog's own use AND
 * re-exported so the `@muse/mcp` barrel and existing tests keep
 * working without import-site edits.
 */
import {
  createFilesystemMcpServer,
  type FilesystemMcpServerOptions
} from "./loopback-filesystem.js";

export { createFilesystemMcpServer, type FilesystemMcpServerOptions };

import { MessagingProviderRegistry } from "@muse/messaging";

import { createMessagingMcpServer } from "./loopback-messaging.js";
import { createRemindersMcpServer } from "./loopback-reminders.js";

export interface LoopbackMcpCatalogEntry {
  readonly name: string;
  readonly description: string;
  readonly optIn: boolean;
  /** Env hints that operators must set when `optIn` is true. */
  readonly requires?: readonly string[];
  readonly tools: readonly { readonly name: string; readonly description: string; readonly risk: ToolRisk | undefined }[];
}

/**
 * Describes every loopback MCP server Muse ships out of the box — the eight
 * default servers plus the two opt-in ones (`muse.fetch`, `muse.fs`). The
 * catalog is metadata-only (no IO, no construction of opt-in servers), so it
 * is safe to expose via a public discovery endpoint without leaking secrets.
 */
export function describeBuiltinLoopbackMcpServers(): readonly LoopbackMcpCatalogEntry[] {
  const defaults = createDefaultLoopbackMcpServers().map((server): LoopbackMcpCatalogEntry => ({
    description: server.description ?? "",
    name: server.name,
    optIn: false,
    tools: server.tools.map((tool) => ({
      description: tool.description ?? "",
      name: tool.name,
      risk: tool.risk
    }))
  }));

  const fetchServer = createFetchMcpServer({ allowedHosts: [] });
  const fsServer = createFilesystemMcpServer({ allowedRoots: [] });
  // The messaging catalog entry is metadata-only — describe a placeholder
  // server backed by an empty registry. The runtime only registers the
  // real one when buildMessagingRegistry(env) returns at least one
  // provider, so a zero-config user sees this entry but won't see the
  // tools as callable until they set a token. Pass a stub `pollNow` so
  // the catalog advertises `poll_now` in the same way it advertises
  // `send`/`inbox` — the LLM can see the full surface from the catalog,
  // not just whichever subset happens to be wired right now.
  const messagingServer = createMessagingMcpServer({
    pollAll: async () => { throw new Error("muse.messaging.poll_all is not wired in this runtime"); },
    pollNow: async () => { throw new Error("muse.messaging.poll_now is not wired in this runtime"); },
    registry: new MessagingProviderRegistry()
  });
  // Reminders is always-on at the default path — the placeholder file
  // is never read because `describe()` only walks the tools array.
  const remindersServer = createRemindersMcpServer({ file: "/dev/null" });

  const optIn: readonly LoopbackMcpCatalogEntry[] = [
    {
      description: fetchServer.description ?? "",
      name: fetchServer.name,
      optIn: true,
      requires: ["allowedHosts (FetchMcpServerOptions.allowedHosts)"],
      tools: fetchServer.tools.map((tool) => ({
        description: tool.description ?? "",
        name: tool.name,
        risk: tool.risk
      }))
    },
    {
      description: fsServer.description ?? "",
      name: fsServer.name,
      optIn: true,
      requires: ["allowedRoots (FilesystemMcpServerOptions.allowedRoots)"],
      tools: fsServer.tools.map((tool) => ({
        description: tool.description ?? "",
        name: tool.name,
        risk: tool.risk
      }))
    },
    {
      description: messagingServer.description ?? "",
      name: messagingServer.name,
      optIn: true,
      requires: [
        "MUSE_TELEGRAM_BOT_TOKEN | MUSE_DISCORD_BOT_TOKEN | MUSE_SLACK_BOT_TOKEN | MUSE_LINE_CHANNEL_ACCESS_TOKEN"
      ],
      tools: messagingServer.tools.map((tool) => ({
        description: tool.description ?? "",
        name: tool.name,
        risk: tool.risk
      }))
    },
    {
      description: remindersServer.description ?? "",
      name: remindersServer.name,
      optIn: false,
      tools: remindersServer.tools.map((tool) => ({
        description: tool.description ?? "",
        name: tool.name,
        risk: tool.risk
      }))
    }
  ];

  return [...defaults, ...optIn];
}

/**
 * Reference loopback server: filesystem-backed markdown notes for a personal
 * user. The agent reads/writes/searches `.md` files inside a single
 * sandboxed `notesDir` (defaults to `~/.muse/notes` via autoconfigure).
 *
 * Implementation lives in `./loopback-notes.ts` (lifted out when this
 * file passed 2,300 LOC). Re-exported here so the `@muse/mcp` barrel
 * and existing tests keep working without import-site edits.
 */
export {
  createNotesMcpServer,
  type NotesMcpServerOptions
} from "./loopback-notes.js";

/** All nine default loopback servers (time / text / math / json / url / crypto / diff / regex / search). `muse.fetch` is opt-in via `createFetchMcpServer`. */
export function createDefaultLoopbackMcpServers(options: BuiltinLoopbackOptions = {}): readonly LoopbackMcpServer[] {
  return [
    createTimeMcpServer(options),
    createTextUtilsMcpServer(),
    createMathMcpServer(),
    createJsonMcpServer(),
    createUrlMcpServer(),
    createCryptoMcpServer(options),
    createDiffMcpServer(),
    createRegexMcpServer(),
    createSearchMcpServer({
      ...(options.searxngUrl ? { searxngUrl: options.searxngUrl } : {}),
      ...(options.searxngEngines ? { searxngEngines: options.searxngEngines } : {})
    })
  ];
}



/**
 * `muse.calendar` provider-neutral calendar surface.
 *
 * Implementation lives in `./loopback-calendar.ts` (lifted out so
 * `serializeEvent` / `parseIsoDate` / `readBoolean` stay close to
 * the calendar tool definitions). Re-exported here so the
 * `@muse/mcp` barrel and existing tests keep working without
 * import-site edits.
 */
export {
  createCalendarMcpServer,
  resolveEventByRef,
  type EventRefLike,
  type EventRefResolution
} from "./loopback-calendar.js";

/**
 * `muse.tasks` personal todo list backed by a single JSON file.
 *
 * Implementation lives in `./loopback-tasks.ts` (lifted out so the
 * on-disk storage helpers stay close to the tool definitions).
 * Re-exported here so the `@muse/mcp` barrel and existing tests
 * keep working without import-site edits.
 */
export {
  createTasksMcpServer
} from "./loopback-tasks.js";
