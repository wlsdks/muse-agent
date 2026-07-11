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

import type { JsonObject, JsonValue } from "@muse/shared";
import type { ToolRisk } from "@muse/tools";

import { toErrorMessage } from "./error-utils.js";
import {
  McpConnectionError,
  type DefaultMcpTransportConnectorOptions,
  type McpConnection,
  type McpRemoteTool,
  type McpSecurityPolicy,
  type McpServer,
  type McpTransportConnector
} from "./index.js";
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
  private readonly stderr: StdioServerParameters["stderr"];
  private readonly clientRoots: readonly string[];

  constructor(options: DefaultMcpTransportConnectorOptions = {}) {
    this.allowPrivateAddresses = options.allowPrivateAddresses ?? false;
    this.clientName = options.clientName ?? "muse";
    this.clientVersion = options.clientVersion ?? "1.0.0";
    this.requestTimeoutMs = options.requestTimeoutMs ?? defaultMcpRequestTimeoutMs;
    this.stderr = options.stderr ?? "inherit";
    this.clientRoots = (options.clientRoots ?? []).filter((path) => path.trim().length > 0);
  }

  async connect(server: McpServer, policy: McpSecurityPolicy): Promise<McpConnection> {
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

    if (server.transportType === "sse") {
      return new SSEClientTransport(this.resolveRemoteUrl(server), {
        requestInit: createRemoteRequestInit(server)
      });
    }

    if (server.transportType === "streamable") {
      return new StreamableHTTPClientTransport(this.resolveRemoteUrl(server), {
        requestInit: createRemoteRequestInit(server)
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

function createRemoteRequestInit(server: McpServer): RequestInit | undefined {
  const token = resolveOptionalString(server.config.authToken) ?? resolveOptionalString(server.config.bearerToken);

  return token ? { headers: { Authorization: `Bearer ${token}` } } : undefined;
}

function riskFromMcpAnnotations(annotations: unknown): ToolRisk {
  if (!annotations || typeof annotations !== "object" || Array.isArray(annotations)) {
    return "read";
  }

  const values = annotations as Record<string, unknown>;

  if (values.destructiveHint === true) {
    return "execute";
  }

  if (values.readOnlyHint === false || values.idempotentHint === false) {
    return "write";
  }

  return "read";
}

function formatMcpToolResult(result: unknown): string | JsonValue {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return normalizeJsonValue(result);
  }

  const value = result as Record<string, unknown>;
  const prefix = value.isError === true ? "Error: " : "";

  if ("structuredContent" in value && value.structuredContent !== undefined) {
    return value.isError === true
      ? `${prefix}${JSON.stringify(value.structuredContent)}`
      : normalizeJsonValue(value.structuredContent);
  }

  if (Array.isArray(value.content)) {
    const textBlocks = value.content
      .map((item) => {
        if (!item || typeof item !== "object" || Array.isArray(item)) {
          return undefined;
        }

        const block = item as Record<string, unknown>;
        return block.type === "text" && typeof block.text === "string" ? block.text : undefined;
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
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : {};
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
  if (typeof error !== "object" || error === null) return undefined;
  const code = (error as { code?: unknown }).code;
  if (typeof code !== "number" || !Number.isFinite(code) || code < 100 || code > 599) {
    return undefined;
  }
  return code;
}
