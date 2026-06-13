import { describe, expect, it } from "vitest";

import {
  GITHUB_MCP_SERVER_NAME,
  InMemoryMcpServerStore,
  McpManager,
  McpSecurityPolicyProvider,
  NOTION_MCP_SERVER_NAME,
  OFFICIAL_MCP_PRESETS,
  createGitHubMcpServer,
  createNotionMcpServer,
  githubMcpToolRisk,
  normalizeMcpSecurityPolicy,
  notionMcpToolRisk,
  resolveOfficialMcpPreset,
  validateMcpServer,
  withOfficialMcpRisk,
  type McpConnection
} from "../src/index.js";
import type { MuseTool } from "@muse/tools";

describe("official MCP presets — factory shape + officially-public provenance", () => {
  it("builds the GitHub streamable connector at the official remote endpoint", () => {
    const server = createGitHubMcpServer();
    expect(server.name).toBe(GITHUB_MCP_SERVER_NAME);
    expect(server.transportType).toBe("streamable");
    expect(server.autoConnect).toBe(false);
    expect((server.config as { url: string }).url).toBe("https://api.githubcopilot.com/mcp/");
    expect("headers" in (server.config ?? {})).toBe(false);
  });

  it("builds the Notion streamable connector at the official hosted endpoint", () => {
    const server = createNotionMcpServer();
    expect(server.name).toBe(NOTION_MCP_SERVER_NAME);
    expect(server.transportType).toBe("streamable");
    expect((server.config as { url: string }).url).toBe("https://mcp.notion.com/mcp");
  });

  it("forwards user-supplied auth headers only when provided (ships no secret)", () => {
    const withAuth = createGitHubMcpServer({ headers: { Authorization: "Bearer ghp_x" } });
    expect((withAuth.config as { headers?: Record<string, string> }).headers).toEqual({
      Authorization: "Bearer ghp_x"
    });
    expect("headers" in (createGitHubMcpServer().config ?? {})).toBe(false);
  });

  it("each preset carries an official anyone-may-connect provenance URL", () => {
    expect(OFFICIAL_MCP_PRESETS[GITHUB_MCP_SERVER_NAME]?.provenanceUrl).toMatch(
      /github\.com\/github\/github-mcp-server/u
    );
    expect(OFFICIAL_MCP_PRESETS[NOTION_MCP_SERVER_NAME]?.provenanceUrl).toMatch(
      /developers\.notion\.com/u
    );
  });

  it("resolves a curated preset by name and refuses an arbitrary/unauthorized name", () => {
    expect(resolveOfficialMcpPreset(GITHUB_MCP_SERVER_NAME)?.name).toBe(GITHUB_MCP_SERVER_NAME);
    expect(resolveOfficialMcpPreset("evil-unlisted-server")).toBeUndefined();
  });

  it("passes the MCP security validator (public https url) under the default policy", () => {
    const input = createNotionMcpServer();
    const now = new Date();
    const result = validateMcpServer(
      {
        autoConnect: input.autoConnect ?? false,
        config: input.config ?? {},
        createdAt: now,
        id: "srv-1",
        name: input.name,
        transportType: input.transportType,
        updatedAt: now
      },
      normalizeMcpSecurityPolicy({}, now)
    );
    expect(result.valid).toBe(true);
  });
});

describe("official MCP presets — fail-close write classification (outbound-safety)", () => {
  it("classifies GitHub read tools as read and EVERY write/unknown tool as write (gated)", () => {
    expect(githubMcpToolRisk("get_issue")).toBe("read");
    expect(githubMcpToolRisk("list_pull_requests")).toBe("read");
    for (const name of ["create_issue", "create_pull_request", "add_issue_comment", "some_future_tool"]) {
      expect(githubMcpToolRisk(name), name).toBe("write");
    }
  });

  it("classifies Notion read tools as read and EVERY write/unknown tool as write (gated)", () => {
    expect(notionMcpToolRisk("search")).toBe("read");
    expect(notionMcpToolRisk("query-database")).toBe("read");
    for (const name of ["create-page", "update-page", "create-comment", "some_future_tool"]) {
      expect(notionMcpToolRisk(name), name).toBe("write");
    }
  });
});

describe("withOfficialMcpRisk", () => {
  const tool = (name: string, risk: "read" | "write" | "execute"): MuseTool => ({
    definition: { description: name, inputSchema: {}, name, risk },
    execute: async () => "ok"
  });

  it("re-stamps an external server's misleading 'read' write tool to write + domain 'external'", () => {
    const out = withOfficialMcpRisk([
      tool("github.create_issue", "read"),
      tool("github.get_issue", "read"),
      tool("notion.create-page", "read"),
      tool("notes.search", "read")
    ]);
    const byRisk = new Map(out.map((t) => [t.definition.name, t.definition.risk]));
    const byDomain = new Map(out.map((t) => [t.definition.name, t.definition.domain]));
    expect(byRisk.get("github.create_issue")).toBe("write");
    expect(byRisk.get("github.get_issue")).toBe("read");
    expect(byRisk.get("notion.create-page")).toBe("write");
    expect(byDomain.get("github.create_issue")).toBe("external");
    // a non-preset tool is untouched
    expect(byRisk.get("notes.search")).toBe("read");
    expect(byDomain.get("notes.search")).toBeUndefined();
  });
});

describe("official MCP presets — end-to-end via the manager (contract-faithful transport fake)", () => {
  // Stands at the transport seam only: the real McpManager
  // register/connect/tool-projection path runs. Mirrors the GitHub
  // remote MCP read + write surface.
  const fakeConnection: McpConnection = {
    callTool: async (toolName) => {
      if (toolName === "get_me") return JSON.stringify({ login: "octocat" });
      if (toolName === "create_issue") return "issue created";
      return `Error: unknown tool ${toolName}`;
    },
    listTools: () => [
      { description: "Get the authenticated user", inputSchema: { type: "object" }, name: "get_me", risk: "read" },
      { description: "Create a new issue", inputSchema: { type: "object" }, name: "create_issue", risk: "read" }
    ]
  };

  it("registers an ALLOWLISTED official preset, connects, and the read tool reaches the agent surface", async () => {
    const manager = new McpManager(new InMemoryMcpServerStore(), {
      connector: { connect: async () => fakeConnection },
      securityPolicyProvider: new McpSecurityPolicyProvider(undefined, {
        allowedServerNames: [GITHUB_MCP_SERVER_NAME]
      })
    });

    const registered = await manager.register(createGitHubMcpServer());
    expect(registered).toBeDefined();
    await expect(manager.connect(GITHUB_MCP_SERVER_NAME)).resolves.toBe(true);
    expect(manager.getStatus(GITHUB_MCP_SERVER_NAME)).toBe("connected");

    const tools = withOfficialMcpRisk(manager.toMuseTools());
    const readTool = tools.find((t) => t.definition.name === "github.get_me");
    expect(readTool, "get_me must be projected").toBeDefined();
    expect(readTool?.definition.risk).toBe("read");
    await expect(readTool?.execute({}, { runId: "run-1" })).resolves.toBe(
      JSON.stringify({ login: "octocat" })
    );

    // The write tool is present but classified write (fail-close) — the
    // AgentRuntime approval gate, not this projection, performs the send.
    const writeTool = tools.find((t) => t.definition.name === "github.create_issue");
    expect(writeTool?.definition.risk).toBe("write");
  });

  it("REFUSES a non-allowlisted official preset — no connection, no tool surface (fail-close)", async () => {
    const manager = new McpManager(new InMemoryMcpServerStore(), {
      connector: { connect: async () => fakeConnection },
      securityPolicyProvider: new McpSecurityPolicyProvider(undefined, {
        allowedServerNames: ["some-other-server"]
      })
    });

    const registered = await manager.register(createGitHubMcpServer());
    expect(registered).toBeUndefined();
    expect(manager.getStatus(GITHUB_MCP_SERVER_NAME)).toBe("disabled");
    expect(manager.toMuseTools()).toHaveLength(0);
  });
});
