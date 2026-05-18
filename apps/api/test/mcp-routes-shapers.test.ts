import { McpRegistryError } from "@muse/mcp";
import { describe, expect, it } from "vitest";

import { sendMcpError } from "../src/mcp-routes-shapers.js";

function fakeReply(): {
  readonly captured: { status?: number; payload?: unknown };
  readonly reply: Parameters<typeof sendMcpError>[0];
} {
  const captured: { status?: number; payload?: unknown } = {};
  const reply = {
    status: (s: number) => ({
      send: (p: unknown): void => {
        captured.status = s;
        captured.payload = p;
      }
    })
  } as unknown as Parameters<typeof sendMcpError>[0];
  return { captured, reply };
}

describe("sendMcpError", () => {
  it("returns a curated 409 for McpRegistryError (typed branch unchanged)", () => {
    const { captured, reply } = fakeReply();
    sendMcpError(reply, new McpRegistryError("server 'x' not allowed by policy"));
    expect(captured.status).toBe(409);
    expect(captured.payload).toEqual({
      code: "MCP_REGISTRY_ERROR",
      message: "server 'x' not allowed by policy"
    });
  });

  it("does not leak a raw internal error message on a 500", () => {
    const { captured, reply } = fakeReply();
    sendMcpError(reply, new Error("ECONNREFUSED 10.0.0.5:6379 /Users/internal/secret/path"));
    expect(captured.status).toBe(500);
    expect(captured.payload).toEqual({ code: "MCP_OPERATION_FAILED", message: "MCP operation failed" });
    const serialized = JSON.stringify(captured.payload);
    expect(serialized).not.toContain("ECONNREFUSED");
    expect(serialized).not.toContain("/Users/internal/secret/path");
  });

  it("does not leak a non-Error thrown value either", () => {
    const { captured, reply } = fakeReply();
    sendMcpError(reply, "raw string with /secret/path");
    expect(captured.status).toBe(500);
    expect(captured.payload).toEqual({ code: "MCP_OPERATION_FAILED", message: "MCP operation failed" });
  });
});
