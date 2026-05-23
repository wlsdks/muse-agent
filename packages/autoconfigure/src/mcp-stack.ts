import {
  CHROME_DEVTOOLS_MCP_SERVER_NAME,
  createChromeDevToolsMcpServer,
  DefaultMcpTransportConnector,
  McpManager,
  McpSecurityPolicyProvider,
  type McpSecurityPolicyStore,
  type McpServerInput,
  type McpServerStore,
  type McpTransportConnector
} from "@muse/mcp";
import type { MuseDatabase } from "@muse/db";
import type { Kysely } from "kysely";

import { parseBoolean, parseCsv, parseInteger } from "./env-parsers.js";
import { loadExternalMcpConfig } from "./external-mcp-config.js";
import { createMcpSecurityPolicyStore, createMcpServerStore } from "./store-factories.js";

import type { MuseEnvironment } from "./index.js";

export interface McpStack {
  readonly manager: McpManager;
  readonly securityPolicyProvider: McpSecurityPolicyProvider;
  readonly securityPolicyStore: McpSecurityPolicyStore;
  readonly serverStore: McpServerStore;
  /**
   * External MCP servers parsed from `~/.muse/mcp.json` (or the path
   * in `MUSE_MCP_CONFIG`). Empty when the file is absent. Callers
   * must `await seedExternalMcpServers(serverStore, ...)` BEFORE
   * `manager.start()` so the connector picks them up.
   */
  readonly externalServerInputs: readonly McpServerInput[];
}

/**
 * Wire the full MCP stack: server store, security policy store +
 * provider, transport connector, manager, and the
 * `~/.muse/mcp.json`-driven external-server input list.
 *
 * The five outputs map 1:1 onto `MuseRuntimeAssembly.mcp.*`.
 */
export function assembleMcpStack(
  env: MuseEnvironment,
  db: Kysely<MuseDatabase> | undefined,
  connectorOverride?: McpTransportConnector
): McpStack {
  const serverStore = createMcpServerStore(db, env);
  const externalServerInputs = [...loadExternalMcpConfig(env)];
  // Turnkey P18: MUSE_CHROME_DEVTOOLS_ENABLED auto-registers the
  // Chrome DevTools MCP preset (auto-connect) so the user need not
  // hand-write the npx command + --browser-url in mcp.json. Skipped
  // if they already declared `chrome-devtools` themselves.
  if (
    parseBoolean(env.MUSE_CHROME_DEVTOOLS_ENABLED, false)
    && !externalServerInputs.some((server) => server.name === CHROME_DEVTOOLS_MCP_SERVER_NAME)
  ) {
    const browserUrl = env.MUSE_CHROME_DEVTOOLS_BROWSER_URL?.trim();
    externalServerInputs.push(createChromeDevToolsMcpServer({
      autoConnect: true,
      ...(browserUrl && browserUrl.length > 0 ? { browserUrl } : {})
    }));
  }
  const configuredAllowedServers = parseCsv(env.MUSE_MCP_ALLOWED_SERVERS);
  // An explicit Chrome enable must not be silently denied by an
  // unrelated strict allowlist. A non-empty allowlist is strict
  // (undefined / empty = allow-all), so if the user pinned other servers
  // AND turned Chrome on, honor that intent by allowing chrome-devtools
  // too. An empty/absent allowlist is left untouched — adding to it would
  // flip allow-all into a 1-entry strict list that blocks everything else.
  const allowedServerNames =
    parseBoolean(env.MUSE_CHROME_DEVTOOLS_ENABLED, false)
    && configuredAllowedServers
    && configuredAllowedServers.length > 0
    && !configuredAllowedServers.includes(CHROME_DEVTOOLS_MCP_SERVER_NAME)
      ? [...configuredAllowedServers, CHROME_DEVTOOLS_MCP_SERVER_NAME]
      : configuredAllowedServers;
  const initialPolicy = {
    allowedServerNames,
    allowedStdioCommands: parseCsv(env.MUSE_MCP_ALLOWED_STDIO_COMMANDS),
    maxToolOutputLength: parseInteger(env.MUSE_MCP_MAX_TOOL_OUTPUT_LENGTH, 50_000)
  };
  const securityPolicyStore = createMcpSecurityPolicyStore(db, initialPolicy);
  const securityPolicyProvider = new McpSecurityPolicyProvider(securityPolicyStore, initialPolicy);
  const allowPrivateAddresses = parseBoolean(env.MUSE_MCP_ALLOW_PRIVATE_ADDRESSES, false);
  const manager = new McpManager(serverStore, {
    connector: connectorOverride ?? new DefaultMcpTransportConnector({
      allowPrivateAddresses,
      clientRoots: parseCsv(env.MUSE_MCP_CLIENT_ROOTS),
      requestTimeoutMs: parseInteger(env.MUSE_MCP_REQUEST_TIMEOUT_MS, 15_000)
    }),
    reconnect: {
      enabled: parseBoolean(env.MUSE_MCP_RECONNECT_ENABLED, true),
      initialDelayMs: parseInteger(env.MUSE_MCP_RECONNECT_INITIAL_DELAY_MS, 1_000),
      maxAttempts: parseInteger(env.MUSE_MCP_RECONNECT_MAX_ATTEMPTS, 3),
      maxDelayMs: parseInteger(env.MUSE_MCP_RECONNECT_MAX_DELAY_MS, 30_000)
    },
    validation: {
      allowPrivateAddresses
    },
    securityPolicyProvider
  });
  return { externalServerInputs, manager, securityPolicyProvider, securityPolicyStore, serverStore };
}
