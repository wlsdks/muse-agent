import { CHROME_DEVTOOLS_MCP_SERVER_NAME, createChromeDevToolsMcpServer, DefaultMcpTransportConnector, McpManager, McpSecurityPolicyProvider, OFFICIAL_MCP_PRESETS, type McpSecurityPolicyStore, type McpServerInput, type McpServerStore, type McpTransportConnector } from "@muse/mcp";
import type { MuseDatabase } from "@muse/db";
import type { Kysely } from "kysely";

import { parseBoolean, parseCsv, parseInteger } from "./env-parsers.js";
import { loadExternalMcpConfig } from "./external-mcp-config.js";
import { resolveOfficialMcpAuthHeaders } from "./official-mcp-credentials.js";
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
  // MUSE_CHROME_DEVTOOLS_ENABLED auto-registers the
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
  // Official-public preset opt-in (mirrors the Chrome turnkey above):
  // MUSE_GITHUB_MCP_ENABLED / MUSE_NOTION_MCP_ENABLED register the
  // curated GitHub / Notion remote preset behind an explicit toggle.
  // Default OFF; skipped if the user already declared that server in
  // mcp.json. The credential is resolved from a SECURE source — a
  // dedicated env var (GITHUB_MCP_TOKEN / NOTION_MCP_TOKEN) or the
  // `~/.muse/mcp-credentials.json` file — through the same non-logging
  // seam the model keys use, and injected ONLY as the streamable
  // transport's `Authorization: Bearer` header. NO secret is shipped or
  // logged. FAIL-CLOSED: a toggle ON with NO resolvable credential does
  // NOT enable the preset (no blank-auth / broken half-connection); a
  // credential is never invented here. The fail-close write
  // classification reaches the live approval gate via
  // `withOfficialMcpRisk` in the runtime projection.
  const enabledOfficialPresets = Object.values(OFFICIAL_MCP_PRESETS)
    .filter(
      (preset) =>
        parseBoolean(env[`MUSE_${preset.name.toUpperCase()}_MCP_ENABLED`], false)
        && !externalServerInputs.some((server) => server.name === preset.name)
    )
    .map((preset) => ({ headers: resolveOfficialMcpAuthHeaders(env, preset.name), preset }))
    .filter((candidate): candidate is { headers: Record<string, string>; preset: typeof candidate.preset } =>
      candidate.headers !== undefined
    );
  for (const { preset, headers } of enabledOfficialPresets) {
    externalServerInputs.push(preset.create({ headers }));
  }
  const configuredAllowedServers = parseCsv(env.MUSE_MCP_ALLOWED_SERVERS);
  // An explicit turnkey enable (Chrome or an official preset) must not be
  // silently denied by an unrelated strict allowlist. A non-empty
  // allowlist is strict (undefined / empty = allow-all), so if the user
  // pinned other servers AND turned a turnkey server on, honor that intent
  // by allowing that server too. An empty/absent allowlist is left
  // untouched — adding to it would flip allow-all into a strict list that
  // blocks everything else.
  const turnkeyEnabledServers = [
    ...(parseBoolean(env.MUSE_CHROME_DEVTOOLS_ENABLED, false) ? [CHROME_DEVTOOLS_MCP_SERVER_NAME] : []),
    ...enabledOfficialPresets.map(({ preset }) => preset.name)
  ];
  const allowedServerNames =
    configuredAllowedServers && configuredAllowedServers.length > 0
      ? [
          ...configuredAllowedServers,
          ...turnkeyEnabledServers.filter((name) => !configuredAllowedServers.includes(name))
        ]
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
