import { describe, expect, it } from "vitest";

import { createMcpMuseTool, type McpConnection, type McpRemoteTool } from "../src/index.js";

const READ_FILE: McpRemoteTool = {
  description: "Read a file",
  inputSchema: { type: "object" },
  name: "read_file",
  risk: "read"
};

const CONTEXT = { runId: "run-1" } as const;

describe("createMcpMuseTool — call-time error surfacing", () => {
  it("surfaces a callTool rejection as a clear Error string, never empty content or a thrown crash", async () => {
    const connection: McpConnection = {
      callTool: async () => {
        throw new Error("HTTP 500 Internal Server Error");
      },
      listTools: () => [READ_FILE]
    };

    const tool = createMcpMuseTool("github", READ_FILE, connection);

    const output = await tool.execute({ path: "README.md" }, CONTEXT);

    expect(typeof output).toBe("string");
    expect(output as string).toMatch(/^Error:/u);
    expect(output as string).toContain("read_file");
    expect(output as string).toContain("HTTP 500");
    expect(output).not.toBe("");
    expect(output).not.toBeUndefined();
    expect(output).not.toBeNull();
  });

  it("surfaces a non-Error rejection (string throw) as a clear Error string", async () => {
    const connection: McpConnection = {
      callTool: async () => {
        throw "socket hang up";
      },
      listTools: () => [READ_FILE]
    };

    const tool = createMcpMuseTool("github", READ_FILE, connection);
    const output = await tool.execute({ path: "README.md" }, CONTEXT);

    expect(output as string).toMatch(/^Error:/u);
    expect(output as string).toContain("socket hang up");
  });

  it("NEVER echoes the auth token into the surfaced error (no-secret-leak)", async () => {
    const token = "ghp_SUPERSECRETtoken1234567890";
    const connection: McpConnection = {
      callTool: async () => {
        throw new Error(`401 Unauthorized — sent Authorization: Bearer ${token}`);
      },
      listTools: () => [READ_FILE]
    };

    const tool = createMcpMuseTool("github", READ_FILE, connection);
    const output = await tool.execute({ path: "README.md" }, CONTEXT);

    expect(output as string).toMatch(/^Error:/u);
    expect(output as string).not.toContain(token);
    expect(output as string).toContain("Bearer [redacted]");
    expect(output as string).toContain("401");
  });

  it("leaves a SUCCESSFUL call's content unchanged", async () => {
    const connection: McpConnection = {
      callTool: async (toolName, args) => ({ args, toolName }),
      listTools: () => [READ_FILE]
    };

    const tool = createMcpMuseTool("github", READ_FILE, connection);
    const output = await tool.execute({ path: "docs/input.md" }, CONTEXT);

    expect(output).toEqual({ args: { path: "docs/input.md" }, toolName: "read_file" });
  });

  it("passes through an isError-style string result unchanged (formatMcpToolResult already prefixed it)", async () => {
    const connection: McpConnection = {
      callTool: async () => "Error: the upstream tool reported a failure",
      listTools: () => [READ_FILE]
    };

    const tool = createMcpMuseTool("github", READ_FILE, connection);
    const output = await tool.execute({ path: "README.md" }, CONTEXT);

    expect(output).toBe("Error: the upstream tool reported a failure");
  });
});
