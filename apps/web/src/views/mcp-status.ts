import type { McpServerSummary } from "../api/types.js";

/** Badge tone for an MCP server's connection status (status is UPPERCASE from the API). */
export function mcpStatusTone(status: string): "ok" | "warn" | "err" {
  const s = status.toUpperCase();
  if (s === "CONNECTED") {
    return "ok";
  }
  if (s === "FAILED" || s === "DISABLED") {
    return "err";
  }
  return "warn"; // PENDING / DISCONNECTED / anything else: actionable, not broken
}

/** A server can be connected only when it is not already connected. */
export function canConnect(status: string): boolean {
  return status.toUpperCase() !== "CONNECTED";
}

/** A server can be disconnected only when it is currently connected. */
export function canDisconnect(status: string): boolean {
  return status.toUpperCase() === "CONNECTED";
}

/** Counts for the header subtitle: how many servers, how many currently connected. */
export function summarizeMcpServers(servers: readonly McpServerSummary[]): {
  total: number;
  connected: number;
} {
  return {
    total: servers.length,
    connected: servers.filter((s) => s.status.toUpperCase() === "CONNECTED").length
  };
}

/**
 * Summarises the MCP security allowlist policy.
 * IMPORTANT: empty allowedServerNames means EVERY server is allowed (opt-in posture),
 * not "nothing allowed". unrestricted:true when the list is empty.
 */
export function summarizeAllowlist(policy: { allowedServerNames: readonly string[] }): {
  allowedCount: number;
  unrestricted: boolean;
} {
  return {
    allowedCount: policy.allowedServerNames.length,
    unrestricted: policy.allowedServerNames.length === 0
  };
}
