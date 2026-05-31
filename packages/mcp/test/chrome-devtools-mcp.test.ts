import { describe, expect, it } from "vitest";

import {
  CHROME_DEVTOOLS_MCP_SERVER_NAME,
  InMemoryMcpServerStore,
  McpManager,
  chromeDevToolsToolRisk,
  createChromeDevToolsMcpServer,
  withChromeDevToolsRisk,
  validateMcpServer,
  normalizeMcpSecurityPolicy,
  McpSecurityPolicyProvider,
  type McpConnection
} from "../src/index.js";
import type { MuseTool } from "@muse/tools";

describe("createChromeDevToolsMcpServer", () => {
  it("builds a stdio npx connector attaching to the user's real Chrome on the default debugging port", () => {
    const server = createChromeDevToolsMcpServer();
    expect(server.name).toBe(CHROME_DEVTOOLS_MCP_SERVER_NAME);
    expect(server.transportType).toBe("stdio");
    expect(server.autoConnect).toBe(false);
    expect(server.config).toMatchObject({
      args: ["chrome-devtools-mcp@latest", "--browser-url", "http://127.0.0.1:9222"],
      command: "npx"
    });
  });

  it("honours a custom browserUrl (attach to a non-default remote-debugging port)", () => {
    const server = createChromeDevToolsMcpServer({ browserUrl: "http://127.0.0.1:9333" });
    expect((server.config as { args: readonly string[] }).args).toEqual([
      "chrome-devtools-mcp@latest",
      "--browser-url",
      "http://127.0.0.1:9333"
    ]);
  });

  it("falls back to the default debugging port when browserUrl is blank / whitespace", () => {
    // A blank option must not become a literal empty --browser-url; it falls back
    // to the default 9222 port (the > 0 length guard).
    const server = createChromeDevToolsMcpServer({ browserUrl: "   " });
    expect((server.config as { args: readonly string[] }).args).toEqual([
      "chrome-devtools-mcp@latest",
      "--browser-url",
      "http://127.0.0.1:9222"
    ]);
  });

  it("includes fingerprintSha256 in the config only when provided", () => {
    expect((createChromeDevToolsMcpServer({ fingerprintSha256: "abc123" }).config as { fingerprintSha256?: string }).fingerprintSha256).toBe("abc123");
    expect("fingerprintSha256" in createChromeDevToolsMcpServer({}).config).toBe(false);
  });

  it("passes the MCP security validator under the default policy (npx is an allowed stdio command)", () => {
    const input = createChromeDevToolsMcpServer();
    const now = new Date();
    const policy = normalizeMcpSecurityPolicy({}, now);
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
      policy
    );
    expect(result.valid).toBe(true);
  });
});

describe("chromeDevToolsToolRisk — fail-close risk classification", () => {
  it("classifies pure-observation tools as read (every member of the read-only set — they must stay ungated)", () => {
    // The full set: an observation tool wrongly dropped from it would suddenly
    // require approval for a screenshot / console read. Assert each one.
    for (const name of [
      "take_snapshot", "take_screenshot", "list_pages", "list_console_messages",
      "get_console_message", "list_network_requests", "get_network_request",
      "wait_for", "performance_analyze_insight"
    ]) {
      expect(chromeDevToolsToolRisk(name), name).toBe("read");
    }
  });

  it("classifies arbitrary-code / file / dialog tools as execute", () => {
    for (const name of ["evaluate_script", "upload_file", "handle_dialog"]) {
      expect(chromeDevToolsToolRisk(name), name).toBe("execute");
    }
  });

  it("classifies state-changing tools as write, and defaults UNKNOWN tools to write (fail-close)", () => {
    for (const name of ["click", "fill", "fill_form", "navigate_page", "press_key", "some_future_tool"]) {
      expect(chromeDevToolsToolRisk(name), name).toBe("write");
    }
  });
});

describe("withChromeDevToolsRisk", () => {
  const tool = (name: string, risk: "read" | "write" | "execute"): MuseTool => ({
    definition: { description: name, inputSchema: {}, name, risk },
    execute: async () => "ok"
  });

  it("re-stamps the curated chrome-devtools tools by classifier, drops non-curated ones, leaves others untouched", () => {
    const out = withChromeDevToolsRisk([
      tool("chrome-devtools.fill_form", "read"),
      tool("chrome-devtools.take_snapshot", "read"),
      tool("chrome-devtools.evaluate_script", "read"),
      tool("notes.search", "read")
    ]);
    const byName = new Map(out.map((entry) => [entry.definition.name, entry.definition.risk]));
    expect(byName.get("chrome-devtools.fill_form")).toBe("write");
    expect(byName.get("chrome-devtools.take_snapshot")).toBe("read");
    // evaluate_script is a web-developer tool — curated OUT of the agent catalog.
    expect(byName.has("chrome-devtools.evaluate_script")).toBe(false);
    expect(byName.get("notes.search")).toBe("read");
  });

  it("stamps domain 'web' on chrome tools (so the relevance filter gates them) and leaves others", () => {
    const out = withChromeDevToolsRisk([tool("chrome-devtools.take_snapshot", "read"), tool("notes.search", "read")]);
    const byName = new Map(out.map((e) => [e.definition.name, e.definition.domain]));
    expect(byName.get("chrome-devtools.take_snapshot")).toBe("web");
    expect(byName.get("notes.search")).toBeUndefined();
  });
});

describe("Chrome DevTools MCP — end-to-end perception via the manager (contract-faithful fake)", () => {
  // Mirrors the real chrome-devtools-mcp read surface: a page-snapshot
  // tool returning the LIVE (logged-in) page's text content, and a
  // navigation tool. The fake stands at the transport seam only — the
  // real McpManager register/connect/tool-projection code path runs.
  const liveSnapshot = "Inbox (live, logged-in): 2 unread — invoice from Acme, standup notes.";
  const fakeConnection: McpConnection = {
    callTool: async (toolName, args) => {
      if (toolName === "take_snapshot") return liveSnapshot;
      if (toolName === "navigate_page") return `navigated to ${String((args as { url?: string }).url)}`;
      return `Error: unknown tool ${toolName}`;
    },
    listTools: () => [
      { description: "Navigate the attached Chrome tab to a URL", inputSchema: { type: "object" }, name: "navigate_page", risk: "read" },
      { description: "Return a text snapshot of the live page", inputSchema: { type: "object" }, name: "take_snapshot", risk: "read" }
    ]
  };

  it("registers the preset, connects under the allowlist, and the live page snapshot reaches the agent tool surface", async () => {
    const manager = new McpManager(new InMemoryMcpServerStore(), {
      connector: { connect: async () => fakeConnection }
    });

    const registered = await manager.register(createChromeDevToolsMcpServer());
    expect(registered).toBeDefined();

    await expect(manager.connect(CHROME_DEVTOOLS_MCP_SERVER_NAME)).resolves.toBe(true);
    expect(manager.getStatus(CHROME_DEVTOOLS_MCP_SERVER_NAME)).toBe("connected");

    const tools = manager.toMuseTools();
    const snapshot = tools.find((tool) => tool.definition.name === "chrome-devtools.take_snapshot");
    expect(snapshot, "take_snapshot must be projected as an agent tool").toBeDefined();
    expect(snapshot?.definition.risk).toBe("read");

    await expect(snapshot?.execute({}, { runId: "run-1" })).resolves.toBe(liveSnapshot);
  });

  it("denies the preset when the allowlist excludes it — no connection, no tool surface", async () => {
    const manager = new McpManager(new InMemoryMcpServerStore(), {
      connector: { connect: async () => fakeConnection },
      securityPolicyProvider: new McpSecurityPolicyProvider(undefined, { allowedServerNames: ["some-other-server"] })
    });

    const registered = await manager.register(createChromeDevToolsMcpServer());
    expect(registered).toBeUndefined();
    expect(manager.getStatus(CHROME_DEVTOOLS_MCP_SERVER_NAME)).toBe("disabled");
    expect(manager.toMuseTools()).toHaveLength(0);
  });
});
