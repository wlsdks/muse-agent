import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";
import { setTimeout as sleep } from "node:timers/promises";


import {
  DefaultMcpTransportConnector,
  InMemoryMcpServerStore,
  McpConnectionError,
  McpManager,
  normalizeMcpSecurityPolicy,
  type McpConnection,
  type McpRemoteTool
} from "../src/index.js";

const MCP_PACKAGE_DIR = fileURLToPath(new URL("..", import.meta.url));
const CONTEXT = { runId: "run-1" } as const;

const PING_TOOL: McpRemoteTool = { description: "Ping", name: "ping", risk: "read" };

/**
 * A test-double MCP connection whose transport liveness is mutable, so a
 * test can simulate the SDK client's onclose/onerror flipping `connected`
 * to false the way a dead stdio child would.
 */
interface FakeConnection extends McpConnection {
  connected: boolean;
  disconnectReason?: string;
  callTool: (toolName: string, args: Record<string, unknown>) => Promise<string>;
  listTools: () => Promise<readonly McpRemoteTool[]>;
  close: ReturnType<typeof vi.fn>;
}

function makeConnection(reply: string): FakeConnection {
  return {
    connected: true,
    disconnectReason: undefined,
    callTool: async () => reply,
    listTools: async () => [PING_TOOL],
    close: vi.fn(async () => {})
  };
}

async function connectServer(manager: McpManager): Promise<void> {
  await manager.register({ config: { command: "node" }, name: "local", transportType: "stdio" });
  await manager.connect("local");
}

describe("DS-16 — MCP connection self-heal", () => {
  describe("SdkMcpConnection transport wiring (real stdio child)", () => {
    it("flips connected=false when the stdio child process exits", async () => {
      const serverCode = [
        'import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";',
        'import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";',
        'const server = new McpServer({ name: "dying-fixture", version: "1.0.0" });',
        'server.registerTool("ping", { description: "Ping" }, async () => ({',
        '  content: [{ type: "text", text: "pong" }]',
        "}));",
        "await server.connect(new StdioServerTransport());",
        // Exit shortly after connecting to simulate a crashed server.
        "setTimeout(() => process.exit(0), 200);"
      ].join("\n");
      const policy = normalizeMcpSecurityPolicy({ allowedStdioCommands: ["node"] }, new Date());
      const connector = new DefaultMcpTransportConnector({ requestTimeoutMs: 5_000, stderr: "pipe" });
      const connection = await connector.connect(
        {
          autoConnect: false,
          config: { args: ["--input-type=module", "-e", serverCode], command: "node", cwd: MCP_PACKAGE_DIR },
          createdAt: new Date(),
          id: "server-dying",
          name: "dying",
          transportType: "stdio",
          updatedAt: new Date()
        },
        policy
      );

      try {
        expect(connection.connected).toBe(true);
        expect(await connection.listTools()).toMatchObject([{ name: "ping" }]);

        const deadline = Date.now() + 4_000;
        while (connection.connected !== false && Date.now() < deadline) {
          await sleep(50);
        }

        expect(connection.connected).toBe(false);
        expect(typeof connection.disconnectReason === "string" || connection.disconnectReason === undefined).toBe(true);
      } finally {
        await connection.close?.();
      }
    });
  });

  it("a dead cached connection self-heals: the NEXT tool call retires it, reconnects, and succeeds", async () => {
    const first = makeConnection("dead-reply");
    const second = makeConnection("fresh-reply");
    const connector = { connect: vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second) };
    const manager = new McpManager(new InMemoryMcpServerStore(), { connector });

    await connectServer(manager);
    const [tool] = manager.toMuseTools();

    // The stdio child dies — onclose would flip this in production.
    first.connected = false;
    first.disconnectReason = "transport closed";

    const output = await tool?.execute({}, CONTEXT);

    expect(output).toBe("fresh-reply");
    expect(connector.connect).toHaveBeenCalledTimes(2);
    expect(manager.getStatus("local")).toBe("connected");
    expect(first.close).toHaveBeenCalled();
  });

  it("a reconnect that itself fails surfaces a clear compound error, not the SDK's generic 'Not connected'", async () => {
    const first = makeConnection("dead-reply");
    const connector = {
      connect: vi
        .fn()
        .mockResolvedValueOnce(first)
        .mockRejectedValueOnce(new McpConnectionError("spawn ENOENT", 503))
    };
    const manager = new McpManager(new InMemoryMcpServerStore(), { connector });

    await connectServer(manager);
    const [tool] = manager.toMuseTools();

    first.connected = false;
    first.disconnectReason = "transport closed";

    const output = (await tool?.execute({}, CONTEXT)) as string;

    expect(output).toMatch(/^Error:/u);
    expect(output).toContain("disconnected");
    expect(output).toContain("transport closed");
    expect(output).toContain("reconnect failed");
    expect(output).toContain("spawn ENOENT");
    expect(output).not.toContain("Not connected");
  });

  it("does NOT retry-storm after a permanent (non-retryable) failure — repeated calls surface the error without reconnecting again", async () => {
    const first = makeConnection("dead-reply");
    const connector = {
      connect: vi
        .fn()
        .mockResolvedValueOnce(first)
        .mockRejectedValue(new McpConnectionError("Bad credentials", 401))
    };
    const manager = new McpManager(new InMemoryMcpServerStore(), { connector });

    await connectServer(manager);
    const [tool] = manager.toMuseTools();

    first.connected = false;
    first.disconnectReason = "transport closed";

    // First call attempts one reconnect (2nd connector.connect), which is a
    // permanent 401 → server disabled. Every subsequent call must short out
    // on the disabled status WITHOUT hammering the connector again.
    const outputs: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      outputs.push((await tool?.execute({}, CONTEXT)) as string);
    }

    expect(connector.connect).toHaveBeenCalledTimes(2);
    expect(manager.getStatus("local")).toBe("disabled");
    for (const output of outputs) {
      expect(output).toMatch(/^Error:/u);
      expect(output).toContain("disconnected");
    }
  });

  it("does not retry-storm inside the reconnect backoff window (transient failure)", async () => {
    const nowMs = 1_800_000_000_000;
    const first = makeConnection("dead-reply");
    const connector = {
      connect: vi
        .fn()
        .mockResolvedValueOnce(first)
        .mockRejectedValue(new McpConnectionError("upstream down", 503))
    };
    const manager = new McpManager(new InMemoryMcpServerStore(), {
      connector,
      now: () => new Date(nowMs),
      reconnect: { initialDelayMs: 10_000, maxAttempts: 5 }
    });

    await connectServer(manager);
    const [tool] = manager.toMuseTools();

    first.connected = false;
    first.disconnectReason = "transport closed";

    // First call attempts a reconnect (fails, arms a 10s backoff). Calls
    // inside the window must NOT attempt another connect.
    await tool?.execute({}, CONTEXT);
    await tool?.execute({}, CONTEXT);
    await tool?.execute({}, CONTEXT);

    expect(connector.connect).toHaveBeenCalledTimes(2);
    expect(manager.getStatus("local")).toBe("failed");
  });

  it("mid-catalog-refresh race in connect(): a connection that dies WHILE listTools() runs never caches its stale tools", async () => {
    const dying = makeConnection("reply");
    // The transport closes during the catalog read — tools resolve but the
    // connection is already dead by the time listTools() returns.
    dying.listTools = async () => {
      dying.connected = false;
      dying.disconnectReason = "closed mid-refresh";
      return [PING_TOOL];
    };
    const connector = { connect: vi.fn().mockResolvedValue(dying) };
    const manager = new McpManager(new InMemoryMcpServerStore(), {
      connector,
      reconnect: { initialDelayMs: 1_000, maxAttempts: 3 }
    });

    await manager.register({ config: { command: "node" }, name: "local", transportType: "stdio" });
    const ok = await manager.connect("local");

    expect(ok).toBe(false);
    expect(manager.getStatus("local")).toBe("failed");
    expect(manager.getToolCatalog("local")).toEqual([]);
    expect(manager.toMuseTools()).toEqual([]);
    expect(dying.close).toHaveBeenCalled();
    // A reconnect is armed (transient), not a permanent disable.
    expect(manager.getHealth("local").nextReconnectAt).toBeDefined();
  });

  it("mid-refresh race in healthCheck(): a connection dying during the health probe retires instead of caching stale tools", async () => {
    const conn = makeConnection("reply");
    const connector = { connect: vi.fn().mockResolvedValue(conn) };
    const manager = new McpManager(new InMemoryMcpServerStore(), {
      connector,
      reconnect: { initialDelayMs: 1_000, maxAttempts: 3 }
    });

    await connectServer(manager);
    expect(manager.getToolCatalog("local")).toHaveLength(1);

    // Next health probe: listTools resolves but the transport died meanwhile.
    conn.listTools = async () => {
      conn.connected = false;
      conn.disconnectReason = "closed during health check";
      return [PING_TOOL, { description: "Stale", name: "stale", risk: "read" }];
    };

    const snapshot = await manager.healthCheck("local");

    expect(snapshot.status).toBe("unhealthy");
    expect(manager.getStatus("local")).toBe("failed");
    expect(manager.getToolCatalog("local")).toEqual([]);
    expect(conn.close).toHaveBeenCalled();
  });

  it("a live connection is reused as-is (no needless reconnect) on every tool call", async () => {
    const only = makeConnection("live-reply");
    const connector = { connect: vi.fn().mockResolvedValue(only) };
    const manager = new McpManager(new InMemoryMcpServerStore(), { connector });

    await connectServer(manager);
    const [tool] = manager.toMuseTools();

    expect(await tool?.execute({}, CONTEXT)).toBe("live-reply");
    expect(await tool?.execute({}, CONTEXT)).toBe("live-reply");
    expect(connector.connect).toHaveBeenCalledTimes(1);
  });
});
