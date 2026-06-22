/**
 * Input validation + readers extracted from `mcp-routes.ts`.
 *
 * Pure data-shape work — no Fastify dependency, so the route file
 * is left with HTTP wiring and response shaping. The route handlers
 * call `parseMcpServerInput` / `parseToolCallBody` /
 * `parseMcpSecurityPolicyInput` and inspect `result.ok` to either
 * forward `result.value` or reply with `result.error`.
 *
 * `ApiError`, `ParseResult`, and `JsonObject` move with the parsers
 * since they're the parsers' return shape. `isRecord` is re-exported
 * because the sanitizer cluster in mcp-routes.ts still uses it for
 * the nested-config walk.
 */

import type { McpSecurityPolicyInput, McpServer, McpServerInput, McpTransportType } from "@muse/mcp";

import type { ApiError, ParseResult } from "./compat-responses.js";
export type { ApiError, ParseResult };

export type JsonObject = NonNullable<McpServerInput["config"]>;

export function parseMcpServerInput(value: unknown, existing?: McpServer): ParseResult<McpServerInput> {
  if (!isRecord(value)) {
    return invalid("INVALID_MCP_SERVER", "Body must be an object");
  }

  const name = existing?.name ?? readString(value, "name");
  const transportType = parseTransportType(readString(value, "transportType", existing?.transportType));

  if (!name || name.trim().length === 0) {
    return invalid("INVALID_MCP_SERVER", "Body must include a non-empty name");
  }

  if (!transportType) {
    return invalid("INVALID_MCP_SERVER", "transportType must be stdio, sse, streamable, or http");
  }

  const config = readJsonObject(value, "config", existing?.config);

  if (config === false) {
    return invalid("INVALID_MCP_SERVER", "config must be a JSON object");
  }

  return {
    ok: true,
    value: {
      autoConnect: readBoolean(value, "autoConnect", existing?.autoConnect ?? true),
      config: config ?? {},
      description: readNullableString(value, "description", existing?.description),
      name,
      transportType,
      version: readNullableString(value, "version", existing?.version)
    }
  };
}

export function parseToolCallBody(value: unknown): ParseResult<JsonObject> {
  if (!isRecord(value)) {
    return invalid("INVALID_MCP_TOOL_CALL", "Body must be an object");
  }

  const args = hasOwn(value, "args") ? value.args : value.arguments;

  if (!isJsonObject(args)) {
    return invalid("INVALID_MCP_TOOL_CALL", "Body must include args or arguments as a JSON object");
  }

  return {
    ok: true,
    value: args
  };
}

export function parseMcpSecurityPolicyInput(value: unknown): ParseResult<McpSecurityPolicyInput> {
  if (!isRecord(value)) {
    return invalid("INVALID_MCP_SECURITY_POLICY", "Body must be an object");
  }

  const allowedServerNames = readStringArray(value, "allowedServerNames");
  const allowedStdioCommands = readStringArray(value, "allowedStdioCommands");

  if (allowedServerNames === false || allowedStdioCommands === false) {
    return invalid("INVALID_MCP_SECURITY_POLICY", "Allowlist fields must be arrays of strings");
  }

  const maxToolOutputLength = readNumber(value, "maxToolOutputLength");

  if (allowedServerNames && allowedServerNames.length > 500) {
    return invalid("INVALID_MCP_SECURITY_POLICY", "allowedServerNames must not exceed 500 entries");
  }
  if (allowedStdioCommands && allowedStdioCommands.length > 500) {
    return invalid("INVALID_MCP_SECURITY_POLICY", "allowedStdioCommands must not exceed 500 entries");
  }

  if (
    maxToolOutputLength !== undefined &&
    (!Number.isInteger(maxToolOutputLength) || maxToolOutputLength < 1024 || maxToolOutputLength > 500000)
  ) {
    return invalid("INVALID_MCP_SECURITY_POLICY", "maxToolOutputLength must be between 1024 and 500000");
  }

  return {
    ok: true,
    value: {
      allowedServerNames,
      allowedStdioCommands,
      maxToolOutputLength
    }
  };
}

export function parseTransportType(value: unknown): McpTransportType | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim().toLowerCase();
  return normalized === "stdio" || normalized === "sse" || normalized === "streamable" || normalized === "http"
    ? normalized
    : undefined;
}

function invalid(code: string, message: string): ParseResult<never> {
  return {
    error: { code, message },
    ok: false
  };
}

import { hasOwn, isJsonObject, isJsonValue, isRecord, readBoolean, readJsonObject, readNullableString, readNumber, readString, readStringArray } from "./server-input-utils.js";
export { hasOwn, isJsonObject, isJsonValue, isRecord, readBoolean, readJsonObject, readNullableString, readNumber, readString, readStringArray };

