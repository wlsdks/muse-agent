import { MessagingProviderRegistry } from "@muse/messaging";
import {
  type BuiltinLoopbackOptions,
  type LoopbackMcpServer,
  createCryptoMcpServer,
  createDiffMcpServer,
  createJsonMcpServer,
  createMathMcpServer,
  createRegexMcpServer,
  createTextUtilsMcpServer,
  createTimeMcpServer,
  createUrlMcpServer
} from "@muse/mcp";
import type { ToolRisk } from "@muse/tools";

import { createFetchMcpServer } from "./loopback-fetch.js";
import { createFilesystemMcpServer } from "./loopback-filesystem.js";
import { createMessagingMcpServer } from "./loopback-messaging.js";
import { createRemindersMcpServer } from "./loopback-reminders.js";
import { createSearchMcpServer } from "./loopback-search.js";

export interface LoopbackMcpCatalogEntry {
  readonly name: string;
  readonly description: string;
  readonly optIn: boolean;
  /** Env hints that operators must set when `optIn` is true. */
  readonly requires?: readonly string[];
  readonly tools: readonly { readonly name: string; readonly description: string; readonly risk: ToolRisk | undefined }[];
}

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
