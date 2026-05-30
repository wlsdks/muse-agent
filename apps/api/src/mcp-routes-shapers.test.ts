import { McpRegistryError, type McpManager, type McpSecurityPolicy, type McpServer } from "@muse/mcp";
import { describe, expect, it } from "vitest";

import {
  isSensitiveConfigKey,
  sanitizeConfig,
  sendMcpError,
  sendMcpServerNotFound,
  stringifyToolOutput,
  toCompatEnum,
  toMcpSecurityPolicyResponse,
  toServerDetail,
  toServerSummary
} from "./mcp-routes-shapers.js";

// Direct coverage for the MCP route shapers (untested module). Two behaviors are
// SECURITY-critical: sanitizeConfig must redact credential fields (authorization
// / password / token / api-key / credential) — recursively — before any MCP
// config payload leaves the server, and sendMcpError must NOT leak an internal
// error message to the network client (only the curated McpRegistryError 409
// message is client-safe).

interface CapturedReply { status: number | null; payload: unknown }
const reply = (): { r: { status(c: number): { send(p: unknown): void } }; captured: CapturedReply } => {
  const captured: CapturedReply = { payload: null, status: null };
  return { captured, r: { status: (c: number) => { captured.status = c; return { send: (p: unknown) => { captured.payload = p; } }; } } };
};

describe("isSensitiveConfigKey", () => {
  it("matches credential-bearing key names case-insensitively, and nothing benign", () => {
    for (const k of ["authorization", "Password", "API_KEY", "api-key", "apikey", "X-Secret", "accessToken", "credential"]) {
      expect(isSensitiveConfigKey(k)).toBe(true);
    }
    expect(isSensitiveConfigKey("name")).toBe(false);
    expect(isSensitiveConfigKey("url")).toBe(false);
  });
});

describe("sanitizeConfig", () => {
  it("redacts sensitive values RECURSIVELY (nested object + object-in-array) while preserving benign ones", () => {
    expect(sanitizeConfig({ headers: { accept: "json", authorization: "Bearer z" }, list: [{ note: "ok", password: "p" }], token: "abc", url: "http://x" }))
      .toEqual({ headers: { accept: "json", authorization: "[redacted]" }, list: [{ note: "ok", password: "[redacted]" }], token: "[redacted]", url: "http://x" });
  });
});

describe("sendMcpError", () => {
  it("returns a 409 with the curated message for an McpRegistryError", () => {
    const { captured, r } = reply();
    sendMcpError(r, new McpRegistryError("duplicate server name"));
    expect(captured.status).toBe(409);
    expect(captured.payload).toEqual({ code: "MCP_REGISTRY_ERROR", message: "duplicate server name" });
  });

  it("returns a GENERIC 500 for an unexpected error — never leaking the internal message", () => {
    const { captured, r } = reply();
    sendMcpError(r, new Error("postgres dsn user:pass@host leaked"));
    expect(captured.status).toBe(500);
    expect(captured.payload).toEqual({ code: "MCP_OPERATION_FAILED", message: "MCP operation failed" });
    expect(JSON.stringify(captured.payload)).not.toContain("postgres"); // no leak
  });
});

describe("response shapers", () => {
  const server = {
    autoConnect: true, config: { cmd: "node", token: "secret-x" }, createdAt: new Date(1_000),
    description: null, id: "s1", name: "notes", transportType: "stdio", updatedAt: new Date(2_000), version: "1.0"
  } as unknown as McpServer;
  const manager = { getStatus: () => "connected", getToolCatalog: () => [{ name: "a" }, { name: "b" }] } as unknown as McpManager;

  it("toServerSummary upper-cases status/transport and counts tools", () => {
    expect(toServerSummary(server, manager)).toMatchObject({ id: "s1", name: "notes", status: "CONNECTED", toolCount: 2, transportType: "STDIO" });
  });

  it("toServerDetail redacts the config and lists tool names", () => {
    const detail = toServerDetail(server, manager);
    expect(detail.config).toEqual({ cmd: "node", token: "[redacted]" });
    expect(detail.tools).toEqual(["a", "b"]);
  });

  it("toCompatEnum upper-cases; stringifyToolOutput passes strings through and JSON-stringifies the rest", () => {
    expect(toCompatEnum("pending")).toBe("PENDING");
    expect(stringifyToolOutput("hi")).toBe("hi");
    expect(stringifyToolOutput({ a: 1 })).toBe('{"a":1}');
  });

  it("toMcpSecurityPolicyResponse exposes the allowlist + cap as epoch-stamped JSON", () => {
    const policy = { allowedServerNames: ["a", "b"], createdAt: new Date(1_000), maxToolOutputLength: 5_000, updatedAt: new Date(2_000) } as unknown as McpSecurityPolicy;
    expect(toMcpSecurityPolicyResponse(policy)).toEqual({ allowedServerNames: ["a", "b"], createdAt: 1_000, maxToolOutputLength: 5_000, updatedAt: 2_000 });
  });

  it("sendMcpServerNotFound returns a 404 with the server name in the message", () => {
    const { captured, r } = reply();
    sendMcpServerNotFound(r, "ghost");
    expect(captured.status).toBe(404);
    expect(captured.payload).toMatchObject({ code: "MCP_SERVER_NOT_FOUND" });
    expect(JSON.stringify(captured.payload)).toContain("ghost");
  });
});
