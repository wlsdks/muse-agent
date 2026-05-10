/**
 * MCP server / transport validators.
 *
 * Lifted out of `packages/mcp/src/index.ts` (round 140, after the
 * Kysely store split in round 139) so the validation logic — input
 * shape checks, allowed-command lists, URL safety — lives in its
 * own focused module.
 *
 * What stays in `index.ts`: the abstractions (`McpServer`,
 * `McpSecurityPolicy`, `McpServerValidationOptions` types), the
 * runtime classes (`McpManager`, `DefaultMcpTransportConnector`),
 * the in-memory stores, and the normalisers. The transport
 * connector + the manager call the validators imported back from
 * here.
 *
 * `resolveStdioArgs` is duplicated here (1 line) rather than
 * exported from `index.ts`, since the transport connector also
 * needs its own private copy and adding exports of internal
 * helpers would widen `@muse/mcp`'s public API.
 */

import net from "node:net";

import type {
  McpSecurityPolicy,
  McpServer,
  McpServerValidationOptions
} from "./index.js";

export function validateMcpServer(
  server: McpServer,
  policy: McpSecurityPolicy,
  options: McpServerValidationOptions = {}
): {
  readonly reason?: string;
  readonly valid: boolean;
} {
  if (server.name.trim().length === 0) {
    return { reason: "MCP server name is required", valid: false };
  }

  if (server.transportType === "stdio") {
    const command = typeof server.config.command === "string" ? server.config.command : undefined;

    if (!command || !validateStdioCommand(command, server.name, policy)) {
      return { reason: "STDIO command is not allowed", valid: false };
    }

    if (!validateStdioArgs(resolveStdioArgs(server), server.name)) {
      return { reason: "STDIO args contain unsafe control characters", valid: false };
    }
  }

  if (server.transportType === "http") {
    return { reason: "HTTP MCP transport is deprecated; use streamable instead", valid: false };
  }

  if (server.transportType === "sse" || server.transportType === "streamable") {
    const url = typeof server.config.url === "string" ? server.config.url : undefined;

    if (!url || !isPublicHttpUrl(url, options)) {
      return { reason: "Remote MCP URL is not allowed", valid: false };
    }
  }

  return { valid: true };
}

export function validateStdioCommand(command: string, _serverName: string, policy: McpSecurityPolicy): boolean {
  return !command.includes("..") &&
    !command.includes("/") &&
    !command.includes("\\") &&
    policy.allowedStdioCommands.includes(command);
}

export function validateStdioArgs(args: readonly string[], _serverName: string): boolean {
  return args.every((arg) => !/[\x00-\x08\x0B-\x1F]/u.test(arg));
}

export function isPrivateOrReservedHost(host: string | undefined): boolean {
  if (!host) {
    return true;
  }

  const normalized = host.toLowerCase();

  if (normalized === "localhost" || normalized.endsWith(".localhost")) {
    return true;
  }

  const ipVersion = net.isIP(normalized);

  if (ipVersion === 0) {
    return false;
  }

  if (ipVersion === 4) {
    const parts = normalized.split(".").map(Number);
    const [a = 0, b = 0] = parts;

    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      a >= 224
    );
  }

  return normalized === "::1" ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    normalized.startsWith("fe80");
}

export function isPublicHttpUrl(value: string, options: McpServerValidationOptions = {}): boolean {
  try {
    const url = new URL(value);

    return (url.protocol === "https:" || url.protocol === "http:") &&
      (options.allowPrivateAddresses || !isPrivateOrReservedHost(url.hostname));
  } catch {
    return false;
  }
}

function resolveStdioArgs(server: McpServer): readonly string[] {
  return Array.isArray(server.config.args)
    ? server.config.args.filter((arg): arg is string => typeof arg === "string")
    : [];
}
