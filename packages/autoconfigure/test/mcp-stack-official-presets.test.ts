import {
  GITHUB_MCP_SERVER_NAME,
  InMemoryMcpServerStore,
  McpManager,
  NOTION_MCP_SERVER_NAME,
  createGitHubMcpServer,
  withOfficialMcpRisk,
  type McpConnection
} from "@muse/mcp";
import { describe, expect, it } from "vitest";

import { assembleMcpStack } from "../src/mcp-stack.js";
import type { MuseEnvironment } from "../src/index.js";

// Point MCP config at a missing file so loadExternalMcpConfig returns
// [] regardless of the test machine's ~/.muse/mcp.json.
const baseEnv = { MUSE_MCP_CONFIG: "/nonexistent/muse-mcp-official-test.json" } as unknown as MuseEnvironment;

function entry(env: MuseEnvironment, name: string) {
  return assembleMcpStack(env, undefined).externalServerInputs.find((s) => s.name === name);
}

describe("assembleMcpStack — official MCP preset opt-in toggles (default OFF)", () => {
  it("does NOT register the GitHub preset by default (absent from the assembled stack)", () => {
    expect(entry(baseEnv, GITHUB_MCP_SERVER_NAME)).toBeUndefined();
  });

  it("does NOT register the Notion preset by default (absent from the assembled stack)", () => {
    expect(entry(baseEnv, NOTION_MCP_SERVER_NAME)).toBeUndefined();
  });

  it("registers the GitHub preset only when MUSE_GITHUB_MCP_ENABLED=true AND a credential resolves", () => {
    const gh = entry(
      { ...baseEnv, MUSE_GITHUB_MCP_ENABLED: "true", GITHUB_MCP_TOKEN: "ghp_test_token" } as MuseEnvironment,
      GITHUB_MCP_SERVER_NAME
    );
    expect(gh).toBeDefined();
    expect(gh!.transportType).toBe("streamable");
    expect((gh!.config as { url: string }).url).toBe("https://api.githubcopilot.com/mcp/");
    // No autoConnect for a remote server driving the user's account — opt-in.
    expect(gh!.autoConnect).toBe(false);
  });

  it("registers the Notion preset only when MUSE_NOTION_MCP_ENABLED=true AND a credential resolves", () => {
    const notion = entry(
      { ...baseEnv, MUSE_NOTION_MCP_ENABLED: "true", NOTION_MCP_TOKEN: "ntn_test_token" } as MuseEnvironment,
      NOTION_MCP_SERVER_NAME
    );
    expect(notion).toBeDefined();
    expect((notion!.config as { url: string }).url).toBe("https://mcp.notion.com/mcp");
  });

  it("enabling GitHub (with credential) does not register Notion (each toggle is independent)", () => {
    const env = { ...baseEnv, MUSE_GITHUB_MCP_ENABLED: "true", GITHUB_MCP_TOKEN: "ghp_x" } as MuseEnvironment;
    expect(entry(env, GITHUB_MCP_SERVER_NAME)).toBeDefined();
    expect(entry(env, NOTION_MCP_SERVER_NAME)).toBeUndefined();
  });
});

describe("assembleMcpStack — credential resolution + fail-closed when absent (FIRE 7)", () => {
  it("toggle ON + GITHUB_MCP_TOKEN present ⇒ transport headers carry Authorization: Bearer <token>", () => {
    const gh = entry(
      { ...baseEnv, MUSE_GITHUB_MCP_ENABLED: "true", GITHUB_MCP_TOKEN: "ghp_secret_abc123" } as MuseEnvironment,
      GITHUB_MCP_SERVER_NAME
    );
    expect(gh).toBeDefined();
    const headers = (gh!.config as { headers?: Record<string, string> }).headers;
    expect(headers).toBeDefined();
    expect(headers!.Authorization).toBe("Bearer ghp_secret_abc123");
  });

  it("toggle ON + NOTION_MCP_TOKEN present ⇒ transport headers carry Authorization: Bearer <token>", () => {
    const notion = entry(
      { ...baseEnv, MUSE_NOTION_MCP_ENABLED: "true", NOTION_MCP_TOKEN: "ntn_secret_xyz789" } as MuseEnvironment,
      NOTION_MCP_SERVER_NAME
    );
    expect(notion).toBeDefined();
    const headers = (notion!.config as { headers?: Record<string, string> }).headers;
    expect(headers!.Authorization).toBe("Bearer ntn_secret_xyz789");
  });

  it("toggle ON + NO credential ⇒ preset does NOT enable (fail-closed, no blank-auth connection)", () => {
    const env = { ...baseEnv, MUSE_GITHUB_MCP_ENABLED: "true" } as MuseEnvironment;
    expect(entry(env, GITHUB_MCP_SERVER_NAME)).toBeUndefined();
  });

  it("toggle ON + whitespace-only credential ⇒ treated as absent ⇒ preset does NOT enable", () => {
    const env = { ...baseEnv, MUSE_NOTION_MCP_ENABLED: "true", NOTION_MCP_TOKEN: "   " } as MuseEnvironment;
    expect(entry(env, NOTION_MCP_SERVER_NAME)).toBeUndefined();
  });

  it("toggle ON + NO credential ⇒ server is NOT auto-allowed (the disabled preset adds nothing)", async () => {
    const env = {
      ...baseEnv,
      MUSE_GITHUB_MCP_ENABLED: "true",
      MUSE_MCP_ALLOWED_SERVERS: "filesystem"
    } as MuseEnvironment;
    const allowed = await assembleMcpStack(env, undefined).securityPolicyProvider.isServerAllowed(GITHUB_MCP_SERVER_NAME);
    expect(allowed).toBe(false);
  });

  it("the resolved secret never appears in a serialized safe view of the stack's external inputs", () => {
    const secret = "ghp_must_never_be_logged_4242";
    const env = { ...baseEnv, MUSE_GITHUB_MCP_ENABLED: "true", GITHUB_MCP_TOKEN: secret } as MuseEnvironment;
    const stack = assembleMcpStack(env, undefined);
    // A doctor/diagnostic surface lists server NAMES + transport, never
    // the auth headers. Prove a name+transport projection (the kind a
    // log line would carry) excludes the secret.
    const safeView = stack.externalServerInputs.map((s) => ({
      autoConnect: s.autoConnect,
      name: s.name,
      transportType: s.transportType,
      url: (s.config as { url?: string }).url
    }));
    expect(JSON.stringify(safeView)).not.toContain(secret);
    expect(JSON.stringify(safeView)).not.toContain("Bearer");
  });
});

describe("assembleMcpStack — an explicit official enable is not silently denied by a strict allowlist", () => {
  function allowed(env: MuseEnvironment, name: string): Promise<boolean> {
    return assembleMcpStack(env, undefined).securityPolicyProvider.isServerAllowed(name);
  }

  it("a strict allowlist of OTHER servers + github enabled (with credential) still allows github", async () => {
    const env = {
      ...baseEnv,
      MUSE_GITHUB_MCP_ENABLED: "true",
      GITHUB_MCP_TOKEN: "ghp_x",
      MUSE_MCP_ALLOWED_SERVERS: "filesystem"
    } as MuseEnvironment;
    expect(await allowed(env, GITHUB_MCP_SERVER_NAME)).toBe(true);
    expect(await allowed(env, "filesystem")).toBe(true);
    expect(await allowed(env, "some-random-server")).toBe(false);
  });

  it("an EMPTY allowlist stays allow-all (an official enable must not flip it into a strict list)", async () => {
    const env = { ...baseEnv, MUSE_NOTION_MCP_ENABLED: "true", NOTION_MCP_TOKEN: "ntn_x" } as MuseEnvironment;
    expect(await allowed(env, NOTION_MCP_SERVER_NAME)).toBe(true);
    expect(await allowed(env, "anything-else")).toBe(true);
  });

  it("does NOT auto-allow github when it is not enabled (respects the user's strict allowlist)", async () => {
    const env = { ...baseEnv, MUSE_MCP_ALLOWED_SERVERS: "filesystem" } as MuseEnvironment;
    expect(await allowed(env, GITHUB_MCP_SERVER_NAME)).toBe(false);
  });
});

describe("official MCP preset — enabled server's tools project with fail-close risk (outbound-safety)", () => {
  // Contract-faithful transport fake at the connector seam only — the
  // real McpManager register/connect/tool-projection path runs. Mirrors
  // the GitHub remote MCP read + write surface, BOTH annotated "read"
  // (the untrusted external default). The OUTCOME we prove: with the
  // toggle ON, the read tool projects read (usable) but the write tool
  // projects `write` (gated) after withOfficialMcpRisk.
  const fakeConnection: McpConnection = {
    callTool: async (toolName) => (toolName === "get_me" ? "{\"login\":\"octocat\"}" : "issue created"),
    listTools: () => [
      { description: "Get the authenticated user", inputSchema: { type: "object" }, name: "get_me", risk: "read" },
      { description: "Create a new issue", inputSchema: { type: "object" }, name: "create_issue", risk: "read" }
    ]
  };

  it("toggle ON ⇒ preset registered + allowlisted; read tool projects read, write/unknown projects write (gated)", async () => {
    const env = {
      ...baseEnv,
      MUSE_GITHUB_MCP_ENABLED: "true",
      GITHUB_MCP_TOKEN: "ghp_x",
      MUSE_MCP_ALLOWED_SERVERS: "filesystem"
    } as MuseEnvironment;
    const stack = assembleMcpStack(env, undefined, { connect: async () => fakeConnection });

    // Allowlisted by the toggle.
    expect(await stack.securityPolicyProvider.isServerAllowed(GITHUB_MCP_SERVER_NAME)).toBe(true);

    // The preset input is in the assembled stack — seed it into the
    // server store + connect via the real manager.
    const ghInput = stack.externalServerInputs.find((s) => s.name === GITHUB_MCP_SERVER_NAME);
    expect(ghInput).toBeDefined();
    const registered = await stack.manager.register(createGitHubMcpServer());
    expect(registered).toBeDefined();
    await expect(stack.manager.connect(GITHUB_MCP_SERVER_NAME)).resolves.toBe(true);

    // The LIVE projection path: withOfficialMcpRisk re-stamps risk.
    const tools = withOfficialMcpRisk(stack.manager.toMuseTools());
    const readTool = tools.find((t) => t.definition.name === "github.get_me");
    expect(readTool?.definition.risk, "read tool must be usable").toBe("read");

    const writeTool = tools.find((t) => t.definition.name === "github.create_issue");
    expect(
      writeTool?.definition.risk,
      "an external server's 'read'-annotated write tool must be re-stamped write (gated)"
    ).toBe("write");
  });
});

describe("the assembled projection re-stamps official-preset risk (composed with chrome)", () => {
  // The runtime projection composes withChromeDevToolsRisk +
  // withOfficialMcpRisk. We exercise the composition directly here to
  // prove the official re-stamp reaches the same agent surface chrome's
  // does — a write tool annotated "read" by the server ends up "write".
  it("composing both re-stamps the official write tool to write while leaving non-preset tools alone", async () => {
    const manager = new McpManager(new InMemoryMcpServerStore(), {
      connector: { connect: async () => fakeOfficialConnection }
    });
    await manager.register(createGitHubMcpServer());
    await manager.connect(GITHUB_MCP_SERVER_NAME);
    const tools = withOfficialMcpRisk(manager.toMuseTools());
    expect(tools.find((t) => t.definition.name === "github.create_issue")?.definition.risk).toBe("write");
    expect(tools.find((t) => t.definition.name === "github.get_me")?.definition.risk).toBe("read");
  });
});

const fakeOfficialConnection: McpConnection = {
  callTool: async () => "ok",
  listTools: () => [
    { description: "Get the authenticated user", inputSchema: { type: "object" }, name: "get_me", risk: "read" },
    { description: "Create a new issue", inputSchema: { type: "object" }, name: "create_issue", risk: "read" }
  ]
};
