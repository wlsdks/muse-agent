/**
 * MCP transport connector — wires `@modelcontextprotocol/sdk`'s
 * `Client` + transport classes (stdio / sse / streamable) into the
 * provider-neutral `McpConnection` shape Muse runs on.
 *
 * Companion to `packages/mcp/src/index.ts`: the abstractions
 * (`McpConnection`, `McpTransportConnector`,
 * `DefaultMcpTransportConnectorOptions`, the typed errors, the
 * `McpServer` / `McpSecurityPolicy` types) all live in `index.ts`;
 * this file imports them back so the SDK coupling stays in one
 * focused module.
 *
 * What moved:
 *   - DefaultMcpTransportConnector class (~115 LOC)
 *   - SdkMcpConnection class (~40 LOC, private)
 *   - 10 transport-specific helpers: closeQuietly,
 *     createRemoteRequestInit, formatMcpToolResult,
 *     normalizeJsonValue, resolveOptionalString, resolveStdioArgs,
 *     resolveStdioEnv, resolveStringRecord, riskFromMcpAnnotations,
 *     toJsonObject
 *   - defaultMcpRequestTimeoutMs constant
 *
 * `toErrorMessage` (Error.message / String fallback) lives in
 * `./error-utils.js`, shared with `manager.ts` and `index.ts`.
 */

import { lookup } from "node:dns/promises";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import {
  getDefaultEnvironment,
  StdioClientTransport,
  type StdioServerParameters
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { ListRootsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

import { pathToFileURL } from "node:url";

import { isRecord, type JsonObject, type JsonValue } from "@muse/shared";
import type { ToolRisk } from "@muse/tools";

import { toErrorMessage } from "./error-utils.js";
import {
  McpConnectionError,
  McpExternalTransportBlockedError,
  type DefaultMcpTransportConnectorOptions,
  type McpConnection,
  type McpRemoteTool,
  type McpSecurityPolicy,
  type McpServer,
  type McpTransportConnector
} from "./index.js";
import { MuseMcpOAuthProvider } from "./oauth-provider.js";
import {
  isPrivateOrReservedHost,
  isPublicHttpUrl,
  validateMcpServer,
  validateStdioArgs,
  validateStdioCommand
} from "./validators.js";

const defaultMcpRequestTimeoutMs = 15_000;

export class DefaultMcpTransportConnector implements McpTransportConnector {
  private readonly clientName: string;
  private readonly clientVersion: string;
  private readonly requestTimeoutMs: number;
  private readonly allowPrivateAddresses: boolean;
  private readonly externalTransportAllowed: boolean;
  private readonly stderr: StdioServerParameters["stderr"];
  private readonly clientRoots: readonly string[];
  private readonly oauthConfig: DefaultMcpTransportConnectorOptions["oauthConfig"];

  constructor(options: DefaultMcpTransportConnectorOptions = {}) {
    this.allowPrivateAddresses = options.allowPrivateAddresses ?? false;
    this.externalTransportAllowed = options.externalTransportAllowed ?? true;
    this.clientName = options.clientName ?? "muse";
    this.clientVersion = options.clientVersion ?? "1.0.0";
    this.requestTimeoutMs = options.requestTimeoutMs ?? defaultMcpRequestTimeoutMs;
    this.stderr = options.stderr ?? "inherit";
    this.clientRoots = (options.clientRoots ?? []).filter((path) => path.trim().length > 0);
    this.oauthConfig = options.oauthConfig;
  }

  async connect(server: McpServer, policy: McpSecurityPolicy): Promise<McpConnection> {
    if (!this.externalTransportAllowed) {
      throw new McpExternalTransportBlockedError();
    }

    const validation = validateMcpServer(server, policy, {
      allowPrivateAddresses: this.allowPrivateAddresses
    });

    if (!validation.valid) {
      throw new McpConnectionError(validation.reason ?? "MCP server validation failed");
    }

    const client = new Client(
      { name: this.clientName, version: this.clientVersion },
      { capabilities: { roots: { listChanged: false } } }
    );
    const exposedRoots = this.clientRoots;
    client.setRequestHandler(ListRootsRequestSchema, async () => ({
      roots: exposedRoots.map((path) => ({
        name: path,
        uri: pathToFileURL(path).href
      }))
    }));

    try {
      await this.validateRemoteHost(server);
      const transport = this.createTransport(server, policy);

      await client.connect(transport, { timeout: this.requestTimeoutMs });
      return new SdkMcpConnection(client, this.requestTimeoutMs);
    } catch (error) {
      await closeQuietly(client);
      throw new McpConnectionError(toErrorMessage(error), mcpConnectErrorStatus(error));
    }
  }

  private createTransport(server: McpServer, policy: McpSecurityPolicy): Transport {
    if (server.transportType === "stdio") {
      return this.createStdioTransport(server, policy);
    }

    const authProvider = resolveOAuthProviderForServer(server, this.oauthConfig, this.clientName);

    if (server.transportType === "sse") {
      return new SSEClientTransport(this.resolveRemoteUrl(server), {
        requestInit: createRemoteRequestInit(server),
        ...(authProvider ? { authProvider } : {})
      });
    }

    if (server.transportType === "streamable") {
      return new StreamableHTTPClientTransport(this.resolveRemoteUrl(server), {
        requestInit: createRemoteRequestInit(server),
        ...(authProvider ? { authProvider } : {})
      });
    }

    throw new McpConnectionError("HTTP MCP transport is deprecated; use streamable instead");
  }

  private createStdioTransport(server: McpServer, policy: McpSecurityPolicy): StdioClientTransport {
    const command = typeof server.config.command === "string" ? server.config.command : undefined;
    const args = resolveStdioArgs(server);

    if (!command || !validateStdioCommand(command, server.name, policy)) {
      throw new McpConnectionError("STDIO command is not allowed");
    }

    if (!validateStdioArgs(args, server.name)) {
      throw new McpConnectionError("STDIO args contain unsafe control characters");
    }

    return new StdioClientTransport({
      args: [...args],
      command,
      cwd: resolveOptionalString(server.config.cwd),
      env: resolveStdioEnv(server.config.env),
      stderr: this.stderr
    });
  }

  private resolveRemoteUrl(server: McpServer): URL {
    const url = resolveOptionalString(server.config.url);

    if (!url || !isPublicHttpUrl(url, { allowPrivateAddresses: this.allowPrivateAddresses })) {
      throw new McpConnectionError("Remote MCP URL is not allowed");
    }

    return new URL(url);
  }

  private async validateRemoteHost(server: McpServer): Promise<void> {
    if (this.allowPrivateAddresses || (server.transportType !== "sse" && server.transportType !== "streamable")) {
      return;
    }

    const url = this.resolveRemoteUrl(server);

    try {
      const addresses = await lookup(url.hostname, { all: true });

      if (addresses.length === 0 || addresses.some((address) => isPrivateOrReservedHost(address.address))) {
        throw new McpConnectionError("Remote MCP URL resolves to a private or reserved address");
      }
    } catch (error) {
      if (error instanceof McpConnectionError) {
        throw error;
      }

      throw new McpConnectionError("Remote MCP URL host could not be verified");
    }
  }
}

class SdkMcpConnection implements McpConnection {
  private alive = true;
  private closeReason: string | undefined;

  constructor(
    private readonly client: Client,
    private readonly requestTimeoutMs: number
  ) {
    // Nothing else told Muse when a stdio child died: without these the
    // connection stayed cached as a live object forever and every later
    // call failed the same way until a human reconnected. onclose/onerror
    // are the SDK's designated user hooks (Protocol invokes them from its
    // internal transport handlers) — flip liveness so the manager retires
    // and rebuilds this connection on the next use.
    this.client.onclose = () => {
      this.alive = false;
      this.closeReason ??= "transport closed";
    };
    this.client.onerror = (error: Error) => {
      this.alive = false;
      this.closeReason = error instanceof Error ? error.message : String(error);
    };
  }

  get connected(): boolean {
    return this.alive;
  }

  get disconnectReason(): string | undefined {
    return this.closeReason;
  }

  async listTools(): Promise<readonly McpRemoteTool[]> {
    // Wrap into the typed error carrying the HTTP status so the manager
    // can fail-fast on a permanent 4xx (token revoked mid-session) here
    // too — not just on the initial connect handshake.
    let result;
    try {
      result = await this.client.listTools(undefined, { timeout: this.requestTimeoutMs });
    } catch (error) {
      throw new McpConnectionError(toErrorMessage(error), mcpConnectErrorStatus(error));
    }

    return result.tools.map((tool) => ({
      description: tool.description ?? tool.title ?? tool.name,
      inputSchema: toJsonObject(normalizeJsonValue(tool.inputSchema)),
      name: tool.name,
      risk: riskFromMcpAnnotations(tool.annotations)
    }));
  }

  async callTool(toolName: string, args: JsonObject): Promise<string | JsonValue> {
    const result = await this.client.callTool(
      {
        arguments: args,
        name: toolName
      },
      undefined,
      { timeout: this.requestTimeoutMs }
    );

    return formatMcpToolResult(result);
  }

  async close(): Promise<void> {
    await this.client.close();
  }
}

function resolveStdioArgs(server: McpServer): readonly string[] {
  return Array.isArray(server.config.args)
    ? server.config.args.filter((arg): arg is string => typeof arg === "string")
    : [];
}

function resolveOptionalString(value: JsonValue | undefined): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function resolveStdioEnv(value: JsonValue | undefined): Record<string, string> | undefined {
  const custom = resolveStringRecord(value);
  return custom ? { ...getDefaultEnvironment(), ...custom } : undefined;
}

function resolveStringRecord(value: JsonValue | undefined): Record<string, string> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const entries = Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string");
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

/**
 * Build the RequestInit the SDK reuses for EVERY request to a remote MCP server.
 *
 * `config.headers` is the field every config path actually writes — the mcp.json
 * loader, `muse mcp config-add --header`, and the official-preset credential seam
 * (`<NAME>_MCP_TOKEN` → `Authorization: Bearer …`). It used to be dropped on the
 * floor: this only read the `authToken`/`bearerToken` convenience keys, which
 * NOTHING writes, so a supplied `Authorization` header never reached the wire and
 * every authenticated remote server (GitHub/Notion/Linear/Sentry/Atlassian) 401'd.
 * The headers are now merged, with an explicit `authToken`/`bearerToken` (the more
 * specific "this is the credential" signal) winning the `Authorization` slot.
 */
export function createRemoteRequestInit(server: McpServer): RequestInit | undefined {
  const headers = resolveStringRecord(server.config.headers) ?? {};
  const token = resolveOptionalString(server.config.authToken) ?? resolveOptionalString(server.config.bearerToken);
  const merged = token ? { ...headers, Authorization: `Bearer ${token}` } : headers;
  return Object.keys(merged).length > 0 ? { headers: merged } : undefined;
}

/**
 * A remote server opts into OAuth 2.1 by declaring `config.auth === "oauth"`
 * (a plain string in the server registry — the tokens themselves live in the
 * dedicated oauth store, never in `config`).
 */
export function serverUsesOAuth(server: McpServer): boolean {
  return (
    (server.transportType === "sse" || server.transportType === "streamable") &&
    typeof server.config.auth === "string" &&
    server.config.auth.trim().toLowerCase() === "oauth"
  );
}

/**
 * Build the OAuth `authProvider` for a server IFF it opted in AND the
 * connector was given an oauth store dir. Returns `undefined` for every
 * non-OAuth server (or when oauth isn't configured), so the transport stays
 * byte-identical to the header/token path in that case.
 */
export function resolveOAuthProviderForServer(
  server: McpServer,
  oauthConfig: DefaultMcpTransportConnectorOptions["oauthConfig"],
  clientName: string
): OAuthClientProvider | undefined {
  if (!oauthConfig || !serverUsesOAuth(server)) {
    return undefined;
  }
  return new MuseMcpOAuthProvider({
    clientName,
    env: oauthConfig.env,
    oauthDir: oauthConfig.dir,
    // A RUNTIME connect must NEVER spawn a browser: a daemon/headless start with
    // no stored tokens would otherwise pop the user's browser mid-connect. So the
    // runtime provider's opener THROWS instead — the SDK's redirectToAuthorization
    // surfaces as a clear "authorize first" connect failure. The interactive
    // `muse mcp login` builds its OWN provider with a real opener.
    openBrowser: () => {
      throw new Error(
        `MCP server '${server.name}' requires OAuth authorization. ` +
          `Run \`muse mcp login ${server.name}\` first — Muse does not open a browser during a background connection.`
      );
    },
    redirectPort: oauthConfig.redirectPort,
    // Keyed by the STABLE server name, not the random runtime `id`: this is the
    // one identifier `muse mcp login` (file-backed, no running store) and the
    // runtime connector both know, so a token saved by login is found on connect.
    serverId: server.name
  });
}

/**
 * Classify an external MCP tool's risk from its (optional, advisory) MCP
 * annotations. FAIL-CLOSED: a tool is the ungated `read` tier ONLY when it
 * EXPLICITLY declares `readOnlyHint: true`. An un-annotated tool — the common
 * case, since `ToolAnnotations` are optional — defaults to the gated `write`
 * tier, matching the MCP spec (an unspecified `destructiveHint` is treated as
 * destructive) and CLAUDE.md's "guards are fail-close". The previous default of
 * `read` let an un-annotated external tool that posts/sends/creates execute
 * with no approval — an autonomous third-party action outbound-safety forbids.
 * Curated presets (Notion/GitHub/…) re-stamp risk downstream via
 * `withOfficialMcpRisk`, so this only tightens generic/un-curated servers.
 */
export function riskFromMcpAnnotations(annotations: unknown): ToolRisk {
  if (!isRecord(annotations)) {
    return "write";
  }

  const values = annotations;

  if (values.destructiveHint === true) {
    return "execute";
  }

  if (values.readOnlyHint === true) {
    return "read";
  }

  return "write";
}

function formatMcpToolResult(result: unknown): string | JsonValue {
  if (!isRecord(result)) {
    return normalizeJsonValue(result);
  }

  const value = result;
  const prefix = value.isError === true ? "Error: " : "";

  if ("structuredContent" in value && value.structuredContent !== undefined) {
    return value.isError === true
      ? `${prefix}${JSON.stringify(value.structuredContent)}`
      : normalizeJsonValue(value.structuredContent);
  }

  if (Array.isArray(value.content)) {
    const textBlocks = value.content
      .map((item) => {
        if (!isRecord(item)) {
          return undefined;
        }

        return item.type === "text" && typeof item.text === "string" ? item.text : undefined;
      })
      .filter((text): text is string => typeof text === "string");

    if (textBlocks.length === value.content.length) {
      return `${prefix}${textBlocks.join("\n")}`;
    }

    return value.isError === true ? `${prefix}${JSON.stringify(value.content)}` : normalizeJsonValue(value.content);
  }

  if ("toolResult" in value) {
    return value.isError === true ? `${prefix}${String(value.toolResult)}` : normalizeJsonValue(value.toolResult);
  }

  return value.isError === true ? `${prefix}${JSON.stringify(value)}` : normalizeJsonValue(value);
}

function normalizeJsonValue(value: unknown): JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return Number.isNaN(value) ? null : value;
  }

  if (Array.isArray(value)) {
    return value.map(normalizeJsonValue);
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter((entry) => entry[1] !== undefined && typeof entry[1] !== "function" && typeof entry[1] !== "symbol")
        .map(([key, item]) => [key, normalizeJsonValue(item)])
    );
  }

  return String(value);
}

function toJsonObject(value: unknown): JsonObject {
  // value is untrusted MCP wire data (already JSON-decoded), so a record
  // here is already JSON-safe — narrow to JsonObject accordingly.
  return isRecord(value) ? (value as JsonObject) : {};
}

async function closeQuietly(client: Client): Promise<void> {
  try {
    await client.close();
  } catch {
    // Best-effort cleanup after failed MCP initialization.
  }
}

/**
 * The SDK's HTTP transports surface the server's response status on a
 * numeric `code` field (StreamableHTTPError, SseError). Extract it so
 * the manager can fail-fast on a permanent 4xx (revoked/expired token)
 * instead of arming a reconnect loop. The SDK's internal `code: -1`
 * (e.g. an unexpected content-type, not an HTTP status) is ignored so a
 * non-status sentinel never poses as a retry classification.
 */
function mcpConnectErrorStatus(error: unknown): number | undefined {
  if (!isRecord(error) || !("code" in error)) return undefined;
  const code = error.code;
  if (typeof code !== "number" || !Number.isFinite(code) || code < 100 || code > 599) {
    return undefined;
  }
  return code;
}
