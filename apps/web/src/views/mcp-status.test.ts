import { describe, expect, it } from "vitest";

import { canConnect, canDisconnect, mcpStatusTone, summarizeAllowlist, summarizeMcpServers } from "./mcp-status.js";
import type { McpServerSummary } from "../api/types.js";

function server(name: string, status: string): McpServerSummary {
  return {
    autoConnect: false,
    createdAt: 0,
    description: null,
    id: name,
    name,
    status,
    toolCount: 0,
    transportType: "STDIO",
    updatedAt: 0
  };
}

describe("mcpStatusTone", () => {
  it("connected is ok, failed/disabled is err, everything else is warn", () => {
    expect(mcpStatusTone("CONNECTED")).toBe("ok");
    expect(mcpStatusTone("FAILED")).toBe("err");
    expect(mcpStatusTone("DISABLED")).toBe("err");
    expect(mcpStatusTone("PENDING")).toBe("warn");
    expect(mcpStatusTone("DISCONNECTED")).toBe("warn");
  });

  it("is case-insensitive (API may not always upper-case)", () => {
    expect(mcpStatusTone("connected")).toBe("ok");
  });
});

describe("canConnect / canDisconnect — mutually exclusive on connection state", () => {
  it("a disconnected server can connect but not disconnect", () => {
    expect(canConnect("DISCONNECTED")).toBe(true);
    expect(canDisconnect("DISCONNECTED")).toBe(false);
  });

  it("a connected server can disconnect but not connect", () => {
    expect(canConnect("CONNECTED")).toBe(false);
    expect(canDisconnect("CONNECTED")).toBe(true);
  });

  it("a failed server can still be (re)connected", () => {
    expect(canConnect("FAILED")).toBe(true);
  });
});

describe("summarizeMcpServers", () => {
  it("counts total and connected", () => {
    const out = summarizeMcpServers([server("a", "CONNECTED"), server("b", "PENDING"), server("c", "CONNECTED")]);
    expect(out).toEqual({ total: 3, connected: 2 });
  });

  it("an empty registry is zero/zero, not NaN", () => {
    expect(summarizeMcpServers([])).toEqual({ total: 0, connected: 0 });
  });
});

describe("summarizeAllowlist", () => {
  it("empty allowlist → unrestricted:true (every server is allowed, not zero)", () => {
    expect(summarizeAllowlist({ allowedServerNames: [] })).toEqual({ allowedCount: 0, unrestricted: true });
  });

  it("two-entry allowlist → allowedCount:2, unrestricted:false", () => {
    expect(summarizeAllowlist({ allowedServerNames: ["a", "b"] })).toEqual({ allowedCount: 2, unrestricted: false });
  });

  it("single-entry allowlist → allowedCount:1, unrestricted:false", () => {
    expect(summarizeAllowlist({ allowedServerNames: ["only-server"] })).toEqual({ allowedCount: 1, unrestricted: false });
  });
});
