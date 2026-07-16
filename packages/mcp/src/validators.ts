/**
 * MCP server / transport validators.
 *
 * Companion to `packages/mcp/src/index.ts` — the validation logic
 * (input shape checks, allowed-command lists, URL safety) lives in
 * its own focused module.
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

const UNSAFE_MCP_SERVER_NAME_CHARACTER = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;

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

  if (UNSAFE_MCP_SERVER_NAME_CHARACTER.test(server.name)) {
    return { reason: "MCP server name contains unsafe control characters", valid: false };
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

  // Node's `URL.hostname` wraps IPv6 in [brackets]; `net.isIP` rejects
  // the bracketed form. Strip them so the IP-family branches below see
  // the canonical address — without this strip every IPv6 URL (even
  // `[::1]`) slipped past as "not an IP ⇒ public," a real SSRF bypass.
  const normalized = host.toLowerCase().replace(/^\[(.*)\]$/u, "$1");

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

  if (normalized === "::1" || normalized === "::") {
    return true;
  }

  // IPv4-mapped IPv6 addresses an IPv4 host through the v6 stack. Raw
  // user input is the dotted `::ffff:a.b.c.d` form, but Node's URL
  // parser canonicalises that to a hex-only `::ffff:HHHH:LLLL` form —
  // both must re-classify via the v4 rules so a loopback / RFC1918 /
  // 169.254 / 224+ host expressed in v6 syntax is still rejected.
  const mappedIpv4 = decodeIpv4MappedV6(normalized);
  if (mappedIpv4 !== undefined) {
    return isPrivateOrReservedHost(mappedIpv4);
  }

  return normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    isIpv6LinkLocal(normalized);
}

/** RFC 4291 link-local unicast is fe80::/10, not just fe80::/16. */
function isIpv6LinkLocal(value: string): boolean {
  const firstHextet = Number.parseInt(value.split(":", 1)[0] ?? "", 16);
  return Number.isFinite(firstHextet) && (firstHextet & 0xffc0) === 0xfe80;
}

function decodeIpv4MappedV6(value: string): string | undefined {
  const dotted = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/u.exec(value);
  if (dotted) return dotted[1];
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/u.exec(value);
  if (hex) {
    const high = Number.parseInt(hex[1]!, 16);
    const low = Number.parseInt(hex[2]!, 16);
    return `${(high >> 8) & 0xff}.${high & 0xff}.${(low >> 8) & 0xff}.${low & 0xff}`;
  }
  return undefined;
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
