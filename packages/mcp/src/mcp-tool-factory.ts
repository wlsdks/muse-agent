import type { MuseTool } from "@muse/tools";

import { toErrorMessage } from "./error-utils.js";
import type { Awaitable, McpConnection, McpConnectionResolution, McpRemoteTool } from "./index.js";

import { isCancellationLikeError } from "@muse/resilience";

export function createMcpMuseTool(
  serverName: string,
  tool: McpRemoteTool,
  connection: McpConnection,
  /**
   * Optional per-invocation resolver for the CURRENT live connection.
   * When supplied (the manager's `toMuseTools` path), execute re-resolves
   * the connection on every call — so a dead stdio server is retired and
   * reconnected transparently and this tool keeps working, instead of the
   * closure staying pinned to a connection object that died. When omitted
   * (loopback in-process tools that never lose their transport), execute
   * uses the captured `connection` unchanged.
   */
  resolveConnection?: () => Awaitable<McpConnectionResolution>
): MuseTool {
  return {
    definition: {
      description: tool.description,
      ...(tool.domain ? { domain: tool.domain } : {}),
      ...(tool.keywords && tool.keywords.length > 0 ? { keywords: tool.keywords } : {}),
      ...(tool.groundedArgs && tool.groundedArgs.length > 0 ? { groundedArgs: tool.groundedArgs } : {}),
      inputSchema: tool.inputSchema ?? {},
      name: `${serverName}.${tool.name}`,
      risk: tool.risk ?? "read"
    },
    execute: async (args) => {
      let activeConnection = connection;

      if (resolveConnection) {
        const resolved = await resolveConnection();
        if (resolved.error !== undefined) {
          // A dead, un-reconnectable server. Surface the compound
          // "disconnected: <reason>; reconnect failed: <reason2>" the
          // manager built — never the SDK's opaque "Not connected" —
          // and redact any secret the reason text may echo.
          return `Error: MCP tool '${tool.name}' failed: ${redactMcpSecrets(resolved.error)}`;
        }
        activeConnection = resolved.connection;
      }

      if (!activeConnection.callTool) {
        return `Error: MCP tool '${tool.name}' is not callable`;
      }

      try {
        return await activeConnection.callTool(tool.name, args);
      } catch (error) {
        if (isCancellationLikeError(error)) {
          throw error;
        }
        // A mid-session callTool rejection (auth expired → 401, server
        // 500, request timeout, an SDK throw) MUST surface to the agent
        // as a clear, actionable error — never escape unhandled (which
        // would crash the tool loop on a non-ToolExecutor consumer) and
        // never be silently read as an empty/successful result (a
        // grounding hole: the model would report "no results" when the
        // call actually FAILED). Redact secrets first: the SDK's HTTP
        // error message can echo the request's `Authorization: Bearer
        // <token>` header, which must never reach the model or a log.
        return `Error: MCP tool '${tool.name}' failed: ${redactMcpSecrets(toErrorMessage(error))}`;
      }
    }
  };
}

/**
 * Redact credential-shaped substrings from an MCP error message before it
 * reaches the model or a log. Bias is strictly toward over-redaction: a
 * regex that masks a non-secret word is an acceptable cost, a regex that
 * misses a real credential is not — so every pattern below is intentionally
 * broad rather than tightly scoped to one exact header shape.
 *
 * Exported for direct unit-test coverage (see `test/redact-secrets.test.ts`).
 */
export function redactMcpSecrets(message: string): string {
  return message
    .replace(/Bearer\s+\S+/giu, "Bearer [redacted]")
    // `Basic <base64>` — HTTP Basic auth. Requires 8+ base64-alphabet chars
    // after "Basic " so ordinary phrases ("Basic auth", "Basic usage") with
    // short words fall through untouched.
    .replace(/\bBasic\s+[A-Za-z0-9+/]{8,}=*/gu, "Basic [redacted]")
    // Any OTHER `Authorization:` scheme (Digest, AWS4-HMAC-SHA256, a custom
    // scheme, or a bare token with no scheme word) — Bearer/Basic are
    // already handled above and excluded here so their redaction isn't
    // re-masked into a less specific label. Consumes to end of line/string
    // since a signature-style Authorization value can hold several
    // space-separated key=value segments, not just one token.
    .replace(/Authorization:\s*(?!Bearer\b)(?!Basic\b)\S[^\n\r]*/giu, "Authorization: [redacted]")
    // API-key style headers: `X-API-Key: ...`, `api-key: ...`, `apikey: ...`.
    .replace(/\b((?:x[-_])?api[-_]?key)\s*:\s*\S+/giu, "$1: [redacted]")
    // Query / form params carrying a token value: `token=`, `api_key=`,
    // `apikey=`, `access_token=`. Requires the literal `=` so ordinary text
    // ("token bucket") never matches.
    .replace(/\b(access_token|api_key|apikey|token)=([^&\s"'<>]+)/giu, "$1=[redacted]");
}
