import { fileURLToPath } from "node:url";

import type { MuseDatabase } from "@muse/db";
import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler
} from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { compareFollowupsByScheduledFor, compareRemindersByDueAt, compareTasksByDueDate, createLoopbackMcpConnection, createLoopbackMcpMuseTools, createCryptoMcpServer, createDiffMcpServer, createJsonMcpServer, createMathMcpServer, createRegexMcpServer, createUrlMcpServer, createMcpSecurityPolicyInsert, createMcpServerInsert, createMcpServerUpdate, createTextUtilsMcpServer, createTimeMcpServer, DefaultMcpTransportConnector, InMemoryMcpSecurityPolicyStore, InMemoryMcpServerStore, isPrivateOrReservedHost, isPublicHttpUrl, KyselyMcpSecurityPolicyStore, KyselyMcpServerStore, mapMcpSecurityPolicyRow, mapMcpServerRow, McpConnectionError, isRetryableMcpConnectStatus, McpManager, McpSecurityPolicyProvider, normalizeMcpSecurityPolicy, validateMcpServer, validateStdioArgs, validateStdioCommand, type McpConnection } from "../src/index.js";
import { createDefaultLoopbackMcpServers, createSearchMcpServer, createFetchMcpServer, createFilesystemMcpServer, createEpisodesMcpServer, createFollowupsMcpServer, createPatternsMcpServer, createMessagingMcpServer, createNotesMcpServer, createRemindersMcpServer, createNotesRegistryMcpServer, createTasksMcpServer, AppleNotesProvider, AppleRemindersProvider, LocalDirNotesProvider, LocalFileTasksProvider, NotesProviderError, NotesProviderRegistry, NotesValidationError, NotionNotesProvider, NotionTasksProvider, TasksProviderError, TasksProviderRegistry, TasksValidationError, createContextReferenceMcpServer, createTasksRegistryMcpServer } from "@muse/domain-tools";

// The stdio fixtures below spawn `node -e <inline ESM>` that bare-imports
// `@modelcontextprotocol/sdk`. pnpm keeps that dep only under this package's
// node_modules (not hoisted to the repo root), and the vitest worker's cwd is
// the repo root — so without an explicit cwd the child can't resolve the SDK,
// exits immediately, and the client sees "Connection closed". Spawn it from
// the package dir where the SDK resolves.
const MCP_PACKAGE_DIR = fileURLToPath(new URL("..", import.meta.url));

describe("InMemoryMcpServerStore", () => {
  it("saves, updates, lists, and deletes MCP servers", () => {
    const now = new Date("2026-01-01T00:00:00.000Z");
    const store = new InMemoryMcpServerStore({
      idFactory: () => "server-1",
      now: () => now
    });

    const saved = store.save({
      config: { url: "https://example.test/mcp" },
      name: "research",
      transportType: "streamable"
    });
    const updated = store.update("research", {
      autoConnect: true,
      config: { command: "node" },
      name: "ignored",
      transportType: "stdio"
    });

    expect(saved).toMatchObject({
      id: "server-1",
      name: "research",
      transportType: "streamable"
    });
    expect(updated).toMatchObject({
      autoConnect: true,
      config: { command: "node" },
      id: "server-1",
      name: "research",
      transportType: "stdio"
    });
    expect(store.list()).toHaveLength(1);

    store.delete("research");
    expect(store.findByName("research")).toBeUndefined();
  });

  it("rejects duplicate names and evicts oldest entries when bounded", () => {
    const store = new InMemoryMcpServerStore({
      idFactory: sequentialIds("server"),
      maxServers: 1
    });

    store.save({ name: "first", transportType: "stdio", config: { command: "node" } });
    expect(() => store.save({ name: "first", transportType: "stdio", config: { command: "node" } })).toThrow(
      /already exists/
    );

    store.save({ name: "second", transportType: "stdio", config: { command: "node" } });
    expect(store.findByName("first")).toBeUndefined();
    expect(store.findByName("second")).toBeDefined();
  });
});

describe("MCP security policy", () => {
  it("normalizes allowlists and output length boundaries", () => {
    expect(
      normalizeMcpSecurityPolicy(
        {
          allowedServerNames: [" research ", "", "research"],
          allowedStdioCommands: [" node ", "node", ""],
          maxToolOutputLength: 1
        },
        new Date("2026-01-01T00:00:00.000Z")
      )
    ).toMatchObject({
      allowedServerNames: ["research"],
      allowedStdioCommands: ["node"],
      maxToolOutputLength: 1_024
    });
  });

  it("stores and resolves dynamic policy over defaults", async () => {
    const store = new InMemoryMcpSecurityPolicyStore({
      initial: {
        allowedServerNames: ["research"]
      }
    });
    const provider = new McpSecurityPolicyProvider(store, {
      allowedServerNames: ["default"]
    });

    await expect(provider.isServerAllowed("research")).resolves.toBe(true);
    await expect(provider.isServerAllowed("default")).resolves.toBe(false);

    store.delete();
    await expect(provider.isServerAllowed("default")).resolves.toBe(true);
  });

  it("validates remote URLs and stdio commands with fail-close defaults", () => {
    const policy = normalizeMcpSecurityPolicy({ allowedStdioCommands: ["node"] }, new Date());

    expect(isPrivateOrReservedHost("127.0.0.1")).toBe(true);
    expect(isPrivateOrReservedHost("localhost")).toBe(true);
    expect(isPrivateOrReservedHost("8.8.8.8")).toBe(false);
    expect(isPublicHttpUrl("https://example.test/mcp")).toBe(true);
    expect(isPublicHttpUrl("http://127.0.0.1/mcp")).toBe(false);
    expect(
      validateMcpServer(
        {
          autoConnect: false,
          config: { command: "sh" },
          createdAt: new Date(),
          id: "server-1",
          name: "local",
          transportType: "stdio",
          updatedAt: new Date()
        },
        policy
      )
    ).toMatchObject({ valid: false });
    expect(validateStdioCommand("node", "local", policy)).toBe(true);
    expect(validateStdioCommand("./node", "local", policy)).toBe(false);
    expect(validateStdioCommand("node/child", "local", policy)).toBe(false);
    expect(validateStdioArgs(["--input-type=module", "line\nbreak"], "local")).toBe(true);
    expect(validateStdioArgs([`bad${String.fromCharCode(0)}`], "local")).toBe(false);
  });

  it("allows private remote MCP URLs only when explicitly configured", () => {
    expect(isPublicHttpUrl("http://127.0.0.1/mcp")).toBe(false);
    expect(isPublicHttpUrl("http://127.0.0.1/mcp", { allowPrivateAddresses: true })).toBe(true);
  });

  it("rejects bracketed IPv6 addresses from URL.hostname (Node wraps IPv6 in [brackets] — net.isIP rejects them — so without bracket-strip every IPv6 URL slipped past as `public`)", () => {
    // The fundamental SSRF gap: `new URL("http://[::1]/").hostname` is
    // `[::1]` (with brackets), and `net.isIP("[::1]")` returns 0, so the
    // host was classified as "not an IP ⇒ public" — every IPv6 URL
    // skipped the check.
    expect(isPrivateOrReservedHost("[::1]")).toBe(true);
    expect(isPrivateOrReservedHost("[fc00::1]")).toBe(true);
    expect(isPrivateOrReservedHost("[fe80::1]")).toBe(true);
    expect(isPublicHttpUrl("http://[::1]/mcp")).toBe(false);
    expect(isPublicHttpUrl("https://[fc00::1]/mcp")).toBe(false);
  });

  it("rejects IPv4-mapped IPv6 loopback / private hosts as SSRF (`::ffff:127.0.0.1` is loopback under a v6 disguise — both dotted and Node-canonical hex forms)", () => {
    // Dotted form (raw user input).
    expect(isPrivateOrReservedHost("::ffff:127.0.0.1")).toBe(true);
    expect(isPrivateOrReservedHost("::ffff:10.0.0.1")).toBe(true);
    expect(isPrivateOrReservedHost("::ffff:192.168.1.1")).toBe(true);
    expect(isPrivateOrReservedHost("::ffff:172.16.0.1")).toBe(true);
    expect(isPrivateOrReservedHost("::ffff:169.254.169.254")).toBe(true);
    expect(isPrivateOrReservedHost("::ffff:224.0.0.1")).toBe(true);
    expect(isPrivateOrReservedHost("::ffff:0.0.0.0")).toBe(true);
    expect(isPrivateOrReservedHost("::ffff:8.8.8.8")).toBe(false);

    // Hex-canonical form (what Node URL produces). 127.0.0.1 = 0x7f00:0001.
    expect(isPrivateOrReservedHost("::ffff:7f00:1")).toBe(true);
    // 169.254.169.254 (cloud metadata service) = 0xa9fe:a9fe.
    expect(isPrivateOrReservedHost("::ffff:a9fe:a9fe")).toBe(true);
    // 8.8.8.8 = 0x0808:0808 — still public.
    expect(isPrivateOrReservedHost("::ffff:808:808")).toBe(false);

    // End-to-end via URL parsing (Node canonicalises the dotted form
    // to hex on its own; the v6 URL above hits the hex branch).
    expect(isPublicHttpUrl("http://[::ffff:127.0.0.1]/mcp")).toBe(false);
    expect(isPublicHttpUrl("https://[::ffff:192.168.1.5]/mcp")).toBe(false);
    expect(isPublicHttpUrl("http://[::ffff:169.254.169.254]/latest/meta-data")).toBe(false);
    expect(isPublicHttpUrl("https://[::ffff:8.8.8.8]/mcp")).toBe(true);
  });

  it("rejects the IPv6 unspecified address `::` (not a routable destination)", () => {
    expect(isPrivateOrReservedHost("::")).toBe(true);
    expect(isPrivateOrReservedHost("[::]")).toBe(true);
    expect(isPublicHttpUrl("http://[::]/mcp")).toBe(false);
  });

  it("regression: bare `::1` (loopback) and fc/fd/fe80 prefixes still reject as before", () => {
    expect(isPrivateOrReservedHost("::1")).toBe(true);
    expect(isPrivateOrReservedHost("fc00::1")).toBe(true);
    expect(isPrivateOrReservedHost("fd12:3456:789a::1")).toBe(true);
    expect(isPrivateOrReservedHost("fe80::1")).toBe(true);
    // A v6 public address (Cloudflare's public DNS) is allowed.
    expect(isPrivateOrReservedHost("2606:4700:4700::1111")).toBe(false);
    expect(isPublicHttpUrl("https://[2606:4700:4700::1111]/mcp")).toBe(true);
  });
});

describe("DefaultMcpTransportConnector", () => {
  it("connects stdio MCP servers and calls tools through the SDK client", async () => {
    const serverCode = [
      'import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";',
      'import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";',
      'const server = new McpServer({ name: "fixture-mcp", version: "1.0.0" });',
      'server.registerTool("ping", { description: "Ping tool" }, async () => ({',
      '  content: [{ type: "text", text: "pong" }]',
      "}));",
      "await server.connect(new StdioServerTransport());"
    ].join("\n");
    const policy = normalizeMcpSecurityPolicy({ allowedStdioCommands: ["node"] }, new Date());
    const connector = new DefaultMcpTransportConnector({
      requestTimeoutMs: 5_000,
      stderr: "pipe"
    });
    const connection = await connector.connect(
      {
        autoConnect: false,
        config: {
          args: ["--input-type=module", "-e", serverCode],
          command: "node",
          cwd: MCP_PACKAGE_DIR
        },
        createdAt: new Date(),
        id: "server-1",
        name: "local",
        transportType: "stdio",
        updatedAt: new Date()
      },
      policy
    );

    try {
      expect(await connection.listTools()).toMatchObject([
        {
          description: "Ping tool",
          name: "ping",
          risk: "read"
        }
      ]);
      await expect(connection.callTool?.("ping", {})).resolves.toBe("pong");
    } finally {
      await connection.close?.();
    }
  });

  it("advertises the roots capability and serves clientRoots over the SDK roots/list request", async () => {
    const serverCode = [
      'import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";',
      'import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";',
      'const server = new McpServer({ name: "roots-fixture", version: "1.0.0" });',
      'server.registerTool("dump-roots", { description: "Return the client-advertised roots" }, async () => {',
      '  const result = await server.server.listRoots();',
      '  return { content: [{ type: "text", text: JSON.stringify(result.roots) }] };',
      "});",
      "await server.connect(new StdioServerTransport());"
    ].join("\n");
    const policy = normalizeMcpSecurityPolicy({ allowedStdioCommands: ["node"] }, new Date());
    const connector = new DefaultMcpTransportConnector({
      clientRoots: ["/tmp/muse-test-root", "/Users/example/notes"],
      requestTimeoutMs: 5_000,
      stderr: "pipe"
    });
    const connection = await connector.connect(
      {
        autoConnect: false,
        config: {
          args: ["--input-type=module", "-e", serverCode],
          command: "node",
          cwd: MCP_PACKAGE_DIR
        },
        createdAt: new Date(),
        id: "server-roots",
        name: "roots",
        transportType: "stdio",
        updatedAt: new Date()
      },
      policy
    );

    try {
      const raw = await connection.callTool?.("dump-roots", {});
      const roots = JSON.parse(raw as string) as Array<{ name?: string; uri: string }>;
      expect(roots).toHaveLength(2);
      expect(roots[0]?.uri).toBe("file:///tmp/muse-test-root");
      expect(roots[0]?.name).toBe("/tmp/muse-test-root");
      expect(roots[1]?.uri).toBe("file:///Users/example/notes");
    } finally {
      await connection.close?.();
    }
  });

  it("returns an empty roots list when no clientRoots are configured (capability still advertised)", async () => {
    const serverCode = [
      'import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";',
      'import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";',
      'const server = new McpServer({ name: "roots-empty", version: "1.0.0" });',
      'server.registerTool("dump-roots", { description: "Return the client-advertised roots" }, async () => {',
      '  const result = await server.server.listRoots();',
      '  return { content: [{ type: "text", text: JSON.stringify(result.roots) }] };',
      "});",
      "await server.connect(new StdioServerTransport());"
    ].join("\n");
    const policy = normalizeMcpSecurityPolicy({ allowedStdioCommands: ["node"] }, new Date());
    const connector = new DefaultMcpTransportConnector({
      requestTimeoutMs: 5_000,
      stderr: "pipe"
    });
    const connection = await connector.connect(
      {
        autoConnect: false,
        config: {
          args: ["--input-type=module", "-e", serverCode],
          command: "node",
          cwd: MCP_PACKAGE_DIR
        },
        createdAt: new Date(),
        id: "server-empty",
        name: "empty",
        transportType: "stdio",
        updatedAt: new Date()
      },
      policy
    );

    try {
      const raw = await connection.callTool?.("dump-roots", {});
      expect(JSON.parse(raw as string)).toEqual([]);
    } finally {
      await connection.close?.();
    }
  });
});

describe("McpManager", () => {
  it("connects allowed servers and projects MCP tools into Muse tools", async () => {
    const connection: McpConnection = {
      callTool: async (toolName, args) => ({ args, toolName }),
      listTools: () => [
        {
          description: "Read a file",
          inputSchema: { type: "object" },
          name: "read_file",
          risk: "read"
        }
      ]
    };
    const manager = new McpManager(new InMemoryMcpServerStore(), {
      connector: {
        connect: async () => connection
      }
    });

    await manager.register({
      config: { command: "node" },
      name: "local",
      transportType: "stdio"
    });

    await expect(manager.connect("local")).resolves.toBe(true);
    expect(manager.getStatus("local")).toBe("connected");
    expect(manager.getToolCatalog()).toEqual([
      {
        description: "Read a file",
        inputSchema: { type: "object" },
        name: "read_file",
        risk: "read"
      }
    ]);

    const [tool] = manager.toMuseTools();
    expect(tool?.definition).toMatchObject({
      name: "local.read_file",
      risk: "read"
    });
    await expect(tool?.execute({ path: "docs/input.md" }, { runId: "run-1" })).resolves.toEqual({
      args: { path: "docs/input.md" },
      toolName: "read_file"
    });
  });

  it("connect() returns false + sets status='disabled' when the name is absent from allowedServerNames (goal 032)", async () => {
    const store = new InMemoryMcpServerStore();
    const policyStore = new InMemoryMcpSecurityPolicyStore({
      initial: { allowedServerNames: ["only-this-one"] }
    });
    // Pre-seed a server that bypasses the register-time allowlist check
    // (could exist from a prior policy era). The connect-time gate is
    // what we're testing — the defense-in-depth layer that keeps
    // policy drift from silently activating a now-disallowed server.
    await store.save({
      autoConnect: false,
      config: { command: "node" },
      name: "stale-server",
      transportType: "stdio"
    });
    const manager = new McpManager(store, {
      securityPolicyProvider: new McpSecurityPolicyProvider(policyStore)
    });

    const result = await manager.connect("stale-server");
    expect(result).toBe(false);
    expect(manager.getStatus("stale-server")).toBe("disabled");

    // Allowlist EMPTY means everything's allowed — the original
    // 'optional opt-in' contract. Lock that in too.
    const openStore = new InMemoryMcpSecurityPolicyStore({ initial: { allowedServerNames: [] } });
    expect(await new McpSecurityPolicyProvider(openStore).isServerAllowed("anything")).toBe(true);
  });

  it("connect() denial is terminal — disabled with NO reconnect loop (mirrors register-time denial)", async () => {
    const store = new InMemoryMcpServerStore();
    const policyStore = new InMemoryMcpSecurityPolicyStore({
      initial: { allowedServerNames: ["only-this-one"] }
    });
    await store.save({
      autoConnect: false,
      config: { command: "node" },
      name: "stale-server",
      transportType: "stdio"
    });
    const manager = new McpManager(store, {
      securityPolicyProvider: new McpSecurityPolicyProvider(policyStore)
    });

    expect(await manager.connect("stale-server")).toBe(false);
    expect(manager.getStatus("stale-server")).toBe("disabled");

    // A policy-forbidden server must NOT be armed for reconnect — the
    // allowlist gates connections, it must not retry one it denies.
    const health = manager.getHealth("stale-server");
    expect(health.nextReconnectAt).toBeUndefined();
    expect(health.reconnectAttempts).toBe(0);
    await expect(manager.reconnectDue()).resolves.toEqual([]);
  });

  it("marks denied or invalid servers without throwing", async () => {
    const store = new InMemoryMcpServerStore();
    const policyStore = new InMemoryMcpSecurityPolicyStore({
      initial: {
        allowedServerNames: ["allowed"]
      }
    });
    const manager = new McpManager(store, {
      securityPolicyProvider: new McpSecurityPolicyProvider(policyStore)
    });

    await expect(
      manager.register({
        config: { command: "node" },
        name: "blocked",
        transportType: "stdio"
      })
    ).resolves.toBeUndefined();
    expect(manager.getStatus("blocked")).toBe("disabled");
  });

  it("tracks health failures and reconnects due servers with backoff", async () => {
    let nowMs = 1_767_228_800_000;
    const firstConnection: McpConnection = {
      close: vi.fn(),
      listTools: vi.fn()
        .mockResolvedValueOnce([{ description: "Ping", name: "ping", risk: "read" }])
        .mockRejectedValueOnce(new Error("connection lost"))
    };
    const secondConnection: McpConnection = {
      listTools: vi.fn().mockResolvedValue([{ description: "Ping v2", name: "ping", risk: "read" }])
    };
    const connector = {
      connect: vi.fn()
        .mockResolvedValueOnce(firstConnection)
        .mockResolvedValueOnce(secondConnection)
    };
    const manager = new McpManager(new InMemoryMcpServerStore(), {
      connector,
      now: () => new Date(nowMs),
      reconnect: {
        initialDelayMs: 100,
        maxAttempts: 2
      }
    });

    await manager.register({
      config: { command: "node" },
      name: "local",
      transportType: "stdio"
    });

    await expect(manager.connect("local")).resolves.toBe(true);
    await expect(manager.healthCheck("local")).resolves.toMatchObject({
      error: "connection lost",
      reconnectAttempts: 1,
      status: "unhealthy"
    });
    expect(firstConnection.close).toHaveBeenCalledOnce();
    expect(manager.getStatus("local")).toBe("failed");
    expect(await manager.reconnectDue()).toEqual([]);

    nowMs += 100;
    await expect(manager.reconnectDue()).resolves.toEqual([
      expect.objectContaining({
        reconnectAttempts: 0,
        status: "healthy",
        toolCount: 1
      })
    ]);
    expect(connector.connect).toHaveBeenCalledTimes(2);
    expect(manager.getStatus("local")).toBe("connected");
  });

  it("grows reconnect backoff across REPEATED failures and goes terminal at maxAttempts (no infinite fastest-interval retry)", async () => {
    let nowMs = 1_767_228_800_000;
    const connector = {
      // Connect resolves, but listTools always rejects → every connect attempt fails.
      connect: vi.fn().mockResolvedValue({
        close: vi.fn(),
        listTools: vi.fn().mockRejectedValue(new Error("still down"))
      } as McpConnection)
    };
    const manager = new McpManager(new InMemoryMcpServerStore(), {
      connector,
      now: () => new Date(nowMs),
      reconnect: { initialDelayMs: 100, maxAttempts: 3 }
    });
    await manager.register({ config: { command: "node" }, name: "local", transportType: "stdio" });

    // Initial failure → attempts 1, next due at +100ms (initial * 2^0).
    await expect(manager.connect("local")).resolves.toBe(false);
    expect(manager.getHealth("local")).toMatchObject({ reconnectAttempts: 1 });
    const firstDue = manager.getHealth("local").nextReconnectAt?.getTime();
    expect(firstDue).toBe(nowMs + 100);

    // Second failure must grow attempts to 2 and the delay to 200ms (2^1) —
    // the bug reset attempts to 1 here, pinning the delay at 100ms forever.
    nowMs = firstDue!;
    await manager.reconnectDue();
    expect(manager.getHealth("local")).toMatchObject({ reconnectAttempts: 2 });
    expect(manager.getHealth("local").nextReconnectAt?.getTime()).toBe(nowMs + 200);

    // Third failure → attempts 3, delay 400ms (2^2).
    nowMs = manager.getHealth("local").nextReconnectAt!.getTime();
    await manager.reconnectDue();
    expect(manager.getHealth("local")).toMatchObject({ reconnectAttempts: 3 });
    expect(manager.getHealth("local").nextReconnectAt?.getTime()).toBe(nowMs + 400);

    // Fourth failure exceeds maxAttempts(3) → terminal, no further reconnect armed.
    nowMs = manager.getHealth("local").nextReconnectAt!.getTime();
    await manager.reconnectDue();
    expect(manager.getHealth("local").reconnectAttempts).toBe(4);
    expect(manager.getHealth("local").nextReconnectAt).toBeUndefined();
    await expect(manager.reconnectDue()).resolves.toEqual([]);
  });

  it("classifies a permanent 401/403 auth failure as NON-retryable → fails fast, NO reconnect loop", () => {
    // architecture.md retry classification: 4xx (bad key) fails fast; 5xx/429 may retry.
    expect(isRetryableMcpConnectStatus(401)).toBe(false);
    expect(isRetryableMcpConnectStatus(403)).toBe(false);
    expect(isRetryableMcpConnectStatus(404)).toBe(false);
    expect(isRetryableMcpConnectStatus(400)).toBe(false);
    expect(isRetryableMcpConnectStatus(500)).toBe(true);
    expect(isRetryableMcpConnectStatus(503)).toBe(true);
    expect(isRetryableMcpConnectStatus(429)).toBe(true);
    // No status (a bare network error) → transient, may retry.
    expect(isRetryableMcpConnectStatus(undefined)).toBe(true);
    expect(new McpConnectionError("Server returned 401", 401).retryable).toBe(false);
    expect(new McpConnectionError("Error POSTing to endpoint: 503", 503).retryable).toBe(true);
    expect(new McpConnectionError("network down").retryable).toBe(true);
  });

  it("does NOT arm a reconnect loop when an external server rejects the credential (401) — terminal, disabled", async () => {
    let nowMs = 1_767_228_800_000;
    // Contract-faithful: the REAL DefaultMcpTransportConnector wraps the SDK's
    // StreamableHTTPError(401) into McpConnectionError(msg, 401). A revoked/expired
    // external token (e.g. GitHub PAT) is permanent — retrying hammers the server
    // with a credential that will never work.
    const connector = {
      connect: vi.fn().mockRejectedValue(
        new McpConnectionError("Error POSTing to endpoint: Bad credentials", 401)
      )
    };
    const manager = new McpManager(new InMemoryMcpServerStore(), {
      connector,
      now: () => new Date(nowMs),
      reconnect: { initialDelayMs: 100, maxAttempts: 3 }
    });
    await manager.register({ config: { command: "node" }, name: "ext", transportType: "stdio" });

    await expect(manager.connect("ext")).resolves.toBe(false);

    const health = manager.getHealth("ext");
    expect(manager.getStatus("ext")).toBe("disabled");
    expect(health.status).toBe("unhealthy");
    expect(health.nextReconnectAt).toBeUndefined();
    expect(health.reconnectAttempts).toBe(0);

    // No reconnect armed → reconnectDue does nothing and the connector is NOT called again.
    nowMs += 100_000;
    await expect(manager.reconnectDue()).resolves.toEqual([]);
    expect(connector.connect).toHaveBeenCalledTimes(1);
  });

  it("STILL arms a bounded reconnect loop when the external server fails transiently (503)", async () => {
    let nowMs = 1_767_228_800_000;
    const connector = {
      connect: vi.fn().mockRejectedValue(
        new McpConnectionError("Error POSTing to endpoint: upstream down", 503)
      )
    };
    const manager = new McpManager(new InMemoryMcpServerStore(), {
      connector,
      now: () => new Date(nowMs),
      reconnect: { initialDelayMs: 100, maxAttempts: 3 }
    });
    await manager.register({ config: { command: "node" }, name: "ext", transportType: "stdio" });

    await expect(manager.connect("ext")).resolves.toBe(false);

    const health = manager.getHealth("ext");
    expect(manager.getStatus("ext")).toBe("failed");
    expect(health.status).toBe("unhealthy");
    expect(health.reconnectAttempts).toBe(1);
    expect(health.nextReconnectAt?.getTime()).toBe(nowMs + 100);

    // The bound still holds: a transient failure escalates and eventually goes terminal.
    nowMs = health.nextReconnectAt!.getTime();
    await manager.reconnectDue();
    expect(manager.getHealth("ext").reconnectAttempts).toBe(2);
  });

  it("reports local preflight diagnostics before live MCP execution", async () => {
    const policyStore = new InMemoryMcpSecurityPolicyStore({
      initial: {
        allowedServerNames: ["local"],
        allowedStdioCommands: ["node"]
      }
    });
    const manager = new McpManager(new InMemoryMcpServerStore(), {
      securityPolicyProvider: new McpSecurityPolicyProvider(policyStore)
    });

    await manager.register({
      config: { command: "node" },
      name: "local",
      transportType: "stdio"
    });
    await manager.register({
      config: { command: "node" },
      name: "blocked",
      transportType: "stdio"
    });

    await expect(manager.preflight("local")).resolves.toMatchObject({
      ok: true,
      readyForProduction: false,
      serverName: "local",
      summary: { failCount: 0, warnCount: 2 }
    });
    await expect(manager.preflight("blocked")).resolves.toMatchObject({
      ok: false,
      serverName: "blocked",
      summary: { failCount: 1 }
    });
    await expect(manager.preflight("missing")).resolves.toMatchObject({
      ok: false,
      serverName: "missing",
      summary: { failCount: 1 }
    });
  });

  it("verifyServerFingerprint passes when no fingerprint is pinned (goal 083)", async () => {
    const { verifyServerFingerprint } = await import("../src/manager.js");
    const server = {
      id: "id-1",
      name: "n",
      transportType: "stdio" as const,
      config: { command: "/nonexistent/whatever", args: [] },
      autoConnect: false,
      createdAt: new Date(),
      updatedAt: new Date()
    };
    expect(verifyServerFingerprint(server).matched).toBe(true);
  });

  it("verifyServerFingerprint matches a pinned sha256 + refuses on mismatch (goal 083)", async () => {
    const { verifyServerFingerprint } = await import("../src/manager.js");
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { createHash } = await import("node:crypto");
    const dir = mkdtempSync(join(tmpdir(), "muse-mcp-fingerprint-"));
    const binPath = join(dir, "fake-mcp");
    writeFileSync(binPath, "#!/bin/sh\necho hello\n", { mode: 0o755 });
    const actualHash = createHash("sha256").update("#!/bin/sh\necho hello\n").digest("hex");

    const baseServer = {
      id: "id-1",
      name: "fake",
      transportType: "stdio" as const,
      autoConnect: false,
      createdAt: new Date(),
      updatedAt: new Date()
    };

    // Matching pin → allowed.
    const matched = verifyServerFingerprint({
      ...baseServer,
      config: { command: binPath, args: [], fingerprintSha256: actualHash }
    });
    expect(matched.matched).toBe(true);

    // Mismatched pin → refused with a clear reason.
    const mismatch = verifyServerFingerprint({
      ...baseServer,
      config: { command: binPath, args: [], fingerprintSha256: "0".repeat(64) }
    });
    expect(mismatch.matched).toBe(false);
    expect(mismatch.reason).toMatch(/fingerprint mismatch/i);

    // Non-stdio transport rejects pinning attempts up front.
    const wrongTransport = verifyServerFingerprint({
      ...baseServer,
      transportType: "http" as const,
      config: { command: binPath, args: [], fingerprintSha256: actualHash }
    });
    expect(wrongTransport.matched).toBe(false);
    expect(wrongTransport.reason).toMatch(/only supported for stdio/i);

    // Malformed pin (not 64 hex chars) is silently treated as "no pin".
    const malformedPin = verifyServerFingerprint({
      ...baseServer,
      config: { command: binPath, args: [], fingerprintSha256: "deadbeef" }
    });
    expect(malformedPin.matched).toBe(true);
  });
});

describe("Kysely MCP stores", () => {
  it("builds and maps MCP server persistence payloads", () => {
    const db = createPostgresBuilder();
    const now = new Date("2026-01-01T00:00:00.000Z");
    const insert = createMcpServerInsert(
      {
        config: { url: "https://example.test/mcp" },
        name: "remote",
        transportType: "streamable"
      },
      { idFactory: () => "server-1", now: () => now }
    );
    const update = createMcpServerUpdate(
      {
        autoConnect: true,
        config: { command: "node" },
        name: "remote",
        transportType: "stdio"
      },
      () => now
    );
    const compiled = db.insertInto("mcp_servers").values(insert).returningAll().compile();

    expect(compiled.sql).toContain('insert into "mcp_servers"');
    expect(insert).toMatchObject({
      config: { url: "https://example.test/mcp" },
      id: "server-1",
      name: "remote",
      transport_type: "streamable"
    });
    expect(update).toMatchObject({
      auto_connect: true,
      config: { command: "node" },
      transport_type: "stdio"
    });
    expect(mapMcpServerRow(insert)).toMatchObject({
      id: "server-1",
      name: "remote",
      transportType: "streamable"
    });
  });

  it("builds and maps MCP security policy persistence payloads", () => {
    const now = new Date("2026-01-01T00:00:00.000Z");
    const insert = createMcpSecurityPolicyInsert(
      {
        allowedServerNames: ["remote"],
        allowedStdioCommands: ["node"],
        maxToolOutputLength: 60_000
      },
      () => now
    );

    expect(insert).toMatchObject({
      allowed_server_names: ["remote"],
      allowed_stdio_commands: ["node"],
      id: "default",
      max_tool_output_length: 60_000
    });
    expect(mapMcpSecurityPolicyRow(insert)).toMatchObject({
      allowedServerNames: ["remote"],
      allowedStdioCommands: ["node"],
      maxToolOutputLength: 60_000
    });
  });

  it("constructs Kysely stores", () => {
    const db = createPostgresBuilder();

    expect(new KyselyMcpServerStore(db)).toBeDefined();
    expect(new KyselyMcpSecurityPolicyStore(db)).toBeDefined();
  });
});

function sequentialIds(prefix: string): () => string {
  let next = 0;
  return () => `${prefix}-${++next}`;
}

function createPostgresBuilder(): Kysely<MuseDatabase> {
  return new Kysely<MuseDatabase>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => new DummyDriver(),
      createIntrospector: (db) => new PostgresIntrospector(db),
      createQueryCompiler: () => new PostgresQueryCompiler()
    }
  });
}

describe("loopback MCP servers", () => {
  it("createDefaultLoopbackMcpServers ships nine reference servers (time/text/math/json/url/crypto/diff/regex/search) by default", () => {
    const servers = createDefaultLoopbackMcpServers({ now: () => new Date("2026-05-15T00:00:00.000Z") });
    expect(servers.map((server) => server.name).sort()).toEqual([
      "muse.crypto",
      "muse.diff",
      "muse.json",
      "muse.math",
      "muse.regex",
      "muse.search",
      "muse.text",
      "muse.time",
      "muse.url"
    ]);
    for (const server of servers) {
      expect(server.tools.length).toBeGreaterThan(0);
    }
  });

  it("createLoopbackMcpConnection returns the registered tools through listTools()", async () => {
    const server = createTimeMcpServer({ now: () => new Date("2026-05-15T00:00:00.000Z") });
    const connection = createLoopbackMcpConnection(server);
    const tools = await connection.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual(["diff_ms", "now"]);
  });

  it("muse.time#now returns ISO + epoch + day-of-week using the injected clock", async () => {
    const server = createTimeMcpServer({ now: () => new Date("2026-05-07T01:23:45.000Z") });
    const connection = createLoopbackMcpConnection(server);
    const result = await connection.callTool!("now", {});
    expect(result).toMatchObject({ dayOfWeek: "Thursday", iso: "2026-05-07T01:23:45.000Z" });
  });

  it("muse.time#diff_ms computes the signed millisecond difference", async () => {
    const server = createTimeMcpServer();
    const connection = createLoopbackMcpConnection(server);
    expect(
      await connection.callTool!("diff_ms", {
        from: "2026-05-07T00:00:00.000Z",
        to: "2026-05-07T00:01:30.000Z"
      })
    ).toEqual({ milliseconds: 90_000 });
  });

  it("muse.time#diff_ms rejects an impossible date instead of rolling it over (matches its 'valid ISO-8601' contract)", async () => {
    const connection = createLoopbackMcpConnection(createTimeMcpServer());
    // "2026-02-30" is not a valid calendar date; new Date() silently rolls it to
    // Mar 2, which would compute a diff ~2 days off. The tool PROMISES "valid
    // ISO-8601 strings" — so it must error, not return a wrong duration.
    expect(await connection.callTool!("diff_ms", { from: "2026-02-30", to: "2026-03-05" }))
      .toMatchObject({ error: expect.stringContaining("valid ISO-8601") });
    // A real date / full timestamp still computes.
    expect(await connection.callTool!("diff_ms", { from: "2026-03-01", to: "2026-03-02" }))
      .toEqual({ milliseconds: 86_400_000 });
  });

  it("muse.text#stats counts words/characters/lines and treats whitespace as zero", async () => {
    const server = createTextUtilsMcpServer();
    const connection = createLoopbackMcpConnection(server);
    expect(await connection.callTool!("stats", { text: "hello\nworld\nfrom muse" })).toEqual({
      characters: 21,
      lines: 3,
      words: 4
    });
    expect(await connection.callTool!("stats", { text: "   " })).toEqual({ characters: 0, lines: 0, words: 0 });
  });

  it("muse.text#reverse reverses the input safely", async () => {
    const server = createTextUtilsMcpServer();
    const connection = createLoopbackMcpConnection(server);
    expect(await connection.callTool!("reverse", { text: "muse" })).toEqual({ reversed: "esum" });
  });

  it("muse.math#evaluate accepts safe arithmetic and rejects unsafe characters", async () => {
    const server = createMathMcpServer();
    const connection = createLoopbackMcpConnection(server);
    expect(await connection.callTool!("evaluate", { expression: "2 + 3 * 4" })).toEqual({
      expression: "2 + 3 * 4",
      result: 14
    });
    expect(await connection.callTool!("evaluate", { expression: "1 + globalThis" })).toEqual({
      error: expect.stringContaining("digits, parentheses")
    });
    expect(await connection.callTool!("evaluate", { expression: "1 / 0" })).toEqual({
      error: expect.stringContaining("division by zero")
    });
  });

  it("muse.math#evaluate rejects a malformed multi-dot number, not silently truncate it", async () => {
    const server = createMathMcpServer();
    const connection = createLoopbackMcpConnection(server);
    // parseFloat("1.2.3") === 1.2 → "1.2.3 * 100" would SILENTLY return 120. The math
    // tool's entire contract is an EXACT digit the local model can't compute, so a wrong
    // digit with no model in the loop is the worst failure — it must error, not guess.
    expect(await connection.callTool!("evaluate", { expression: "1.2.3 * 100" })).toEqual({
      error: expect.stringContaining("invalid number literal: 1.2.3")
    });
    // controls: a leading/trailing dot is still a valid number (parity with the old behavior)
    expect(await connection.callTool!("evaluate", { expression: "5. + .5" })).toEqual({
      expression: "5. + .5",
      result: 5.5
    });
  });

  it("muse.math#evaluate accepts tabs/newlines between tokens — the whitelist admits all whitespace", async () => {
    const server = createMathMcpServer();
    const connection = createLoopbackMcpConnection(server);
    // SAFE_MATH_PATTERN admits \s, so a pasted multi-line or tab-separated sum is
    // contract-valid; the tokenizer's skip() must advance over it, not throw
    // "expected number" / "trailing characters" on a tab the whitelist let through.
    expect(await connection.callTool!("evaluate", { expression: "2 *\t3" })).toMatchObject({ result: 6 });
    expect(await connection.callTool!("evaluate", { expression: "1000\n+ 2000" })).toMatchObject({ result: 3000 });
    expect(await connection.callTool!("evaluate", { expression: "(1 +\n2) * 3" })).toMatchObject({ result: 9 });
  });

  it("returns a structured error when an unknown tool is called", async () => {
    const server = createMathMcpServer();
    const connection = createLoopbackMcpConnection(server);
    expect(await connection.callTool!("nonexistent", {})).toMatch(/not registered on 'muse\.math'/u);
  });

  it("createLoopbackMcpMuseTools wraps each tool with the <server>.<tool> namespace", async () => {
    const server = createMathMcpServer();
    const tools = createLoopbackMcpMuseTools(server);
    expect(tools.map((tool) => tool.definition.name)).toEqual(["muse.math.evaluate"]);
    const evaluator = tools[0]!;
    const result = await evaluator.execute({ expression: "10 / 2" }, { runId: "run-1" });
    expect(result).toEqual({ expression: "10 / 2", result: 5 });
  });

  it("createLoopbackMcpMuseTools forwards `domain` from the loopback tool definition to MuseToolDefinition (Phase 4 wire)", async () => {
    const { MessagingProviderRegistry } = await import("@muse/messaging");
    const messaging = createMessagingMcpServer({ registry: new MessagingProviderRegistry() });
    const tools = createLoopbackMcpMuseTools(messaging);
    const providers = tools.find((tool) => tool.definition.name === "muse.messaging.providers");
    expect(providers).toBeDefined();
    // Tagged in loopback-messaging.ts at server-definition time so the
    // tool-filter heuristic doesn't have to fall back to the name-prefix
    // path — explicit always beats inferred.
    expect((providers!.definition as { readonly domain?: string }).domain).toBe("messaging");
  });

  it("close() resolves without error for loopback connections", async () => {
    const connection = createLoopbackMcpConnection(createTimeMcpServer());
    await expect(connection.close!()).resolves.toBeUndefined();
  });

  it("muse.time#now returns an error payload when the timezone is unsupported", async () => {
    const server = createTimeMcpServer();
    const connection = createLoopbackMcpConnection(server);
    expect(await connection.callTool!("now", { timezone: "Mars/Olympus" })).toEqual({
      error: expect.stringContaining("unsupported timezone")
    });
  });

  it("muse.json#format pretty-prints with the requested indent and minifies on demand", async () => {
    const connection = createLoopbackMcpConnection(createJsonMcpServer());
    expect(
      await connection.callTool!("format", { json: '{"a":1}', mode: "pretty", indent: 4 })
    ).toEqual({ formatted: '{\n    "a": 1\n}', mode: "pretty" });
    expect(await connection.callTool!("format", { json: '{ "a": 1 }', mode: "minify" })).toEqual({
      formatted: '{"a":1}',
      mode: "minify"
    });
    expect(await connection.callTool!("format", { json: "{not json", mode: "pretty" })).toEqual({
      error: expect.stringContaining("invalid JSON")
    });
  });

  it("muse.json#query resolves dot/bracket paths and returns found=false on misses", async () => {
    const connection = createLoopbackMcpConnection(createJsonMcpServer());
    expect(
      await connection.callTool!("query", { value: { foo: { bar: [10, 20, 30] } }, path: "foo.bar[1]" })
    ).toEqual({ found: true, value: 20 });
    expect(
      await connection.callTool!("query", { json: '{"foo":{"bar":"hello"}}', path: "$.foo.bar" })
    ).toEqual({ found: true, value: "hello" });
    expect(
      await connection.callTool!("query", { value: { foo: 1 }, path: "missing.key" })
    ).toEqual({ found: false, value: null });
    expect(await connection.callTool!("query", { value: {}, path: "foo[notnum]" })).toEqual({
      error: "path is malformed"
    });
  });

  it("muse.json#query resolves OWN keys only — an inherited prototype key never leaks", async () => {
    const connection = createLoopbackMcpConnection(createJsonMcpServer());
    expect(await connection.callTool!("query", { value: { a: 1 }, path: "a" })).toEqual({ found: true, value: 1 });
    // `key in cursor` walked the prototype chain, so these leaked an inherited value
    // (a function / Object.prototype) into the tool result — must be found:false.
    for (const proto of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
      expect(await connection.callTool!("query", { value: { a: 1 }, path: proto })).toEqual({ found: false, value: null });
    }
  });

  it("muse.json#merge deep-merges objects with override-wins semantics", async () => {
    const connection = createLoopbackMcpConnection(createJsonMcpServer());
    expect(
      await connection.callTool!("merge", {
        base: { a: 1, nested: { keep: true, value: "old" } },
        overrides: { b: 2, nested: { value: "new" } }
      })
    ).toEqual({
      merged: { a: 1, b: 2, nested: { keep: true, value: "new" } }
    });
    expect(
      await connection.callTool!("merge", {
        base: { items: [1, 2, 3] },
        overrides: { items: [9] }
      })
    ).toEqual({ merged: { items: [9] } });
    expect(await connection.callTool!("merge", { base: { a: 1 } })).toEqual({
      error: "overrides is required"
    });
  });

  it("muse.json#merge does NOT let a __proto__ key hijack the result's prototype (pollution vector)", async () => {
    const connection = createLoopbackMcpConnection(createJsonMcpServer());
    // Model tool args arrive via JSON.parse, which makes "__proto__" an OWN data
    // property (a literal `{__proto__:…}` in source would set the prototype instead).
    const overrides = JSON.parse('{"__proto__":{"isAdmin":true},"b":2}') as Record<string, unknown>;
    const out = (await connection.callTool!("merge", { base: { a: 1 }, overrides })) as { merged: Record<string, unknown> };
    const merged = out.merged;
    expect(Object.getPrototypeOf(merged)).toBe(Object.prototype); // prototype NOT swapped
    expect((merged as { isAdmin?: unknown }).isAdmin).toBeUndefined(); // no inherited field injected
    expect(merged.b).toBe(2); // the real data still merges
    expect(({} as { isAdmin?: unknown }).isAdmin).toBeUndefined(); // global prototype clean
  });

  it("muse.url#parse splits a URL into components and surfaces its query map", async () => {
    const connection = createLoopbackMcpConnection(createUrlMcpServer());
    expect(
      await connection.callTool!("parse", { url: "https://example.com:8443/api/v1?x=1&x=2&y=hello#frag" })
    ).toMatchObject({
      hostname: "example.com",
      pathname: "/api/v1",
      port: "8443",
      protocol: "https:",
      query: { x: ["1", "2"], y: "hello" },
      hash: "#frag"
    });
    expect(await connection.callTool!("parse", { url: "::not::a::url" })).toEqual({
      error: expect.stringContaining("invalid URL")
    });
  });

  it("muse.url#parse keeps __proto__ / constructor query params as plain data (no prototype pollution)", async () => {
    const connection = createLoopbackMcpConnection(createUrlMcpServer());
    // The query map was a prototype-bearing {}, so `__proto__=a` hit the proto setter
    // (param vanished + object polluted) and `constructor=c` collided with the inherited
    // Object constructor (corrupted to an array). A null-prototype map keeps them as data.
    const result = await connection.callTool!("parse", { url: "https://x.com/?__proto__=a&constructor=c&x=1" }) as { query: Record<string, unknown> };
    const q = result.query;
    expect(Object.getOwnPropertyDescriptor(q, "__proto__")?.value).toBe("a"); // own data, not the setter
    expect(q.constructor).toBe("c"); // own "c", not the inherited Object function / a corrupted array
    expect(q.x).toBe("1");
  });

  it("muse.url#encode_query joins string and array values into urlencoded form", async () => {
    const connection = createLoopbackMcpConnection(createUrlMcpServer());
    const result = await connection.callTool!("encode_query", {
      params: { name: "muse jarvis", tags: ["a", "b"], hidden: null }
    });
    expect(result).toEqual({ query: "name=muse+jarvis&tags=a&tags=b" });
    expect(await connection.callTool!("encode_query", { params: "nope" })).toEqual({
      error: "params must be a JSON object"
    });
  });

  it("muse.url#encode_query rejects a nested object value instead of silently encoding '[object Object]'", async () => {
    const connection = createLoopbackMcpConnection(createUrlMcpServer());
    // String({nested:1}) === "[object Object]" — a silently corrupt query param. Must error.
    expect(await connection.callTool!("encode_query", { params: { a: { nested: 1 } } })).toEqual({
      error: expect.stringContaining("string/number/boolean")
    });
    // an object INSIDE an array value is also rejected (not "[object Object]")
    expect(await connection.callTool!("encode_query", { params: { a: ["ok", { bad: 1 }] } })).toEqual({
      error: expect.stringContaining("string/number/boolean")
    });
    // scalars + scalar arrays still encode fine (no regression)
    expect(await connection.callTool!("encode_query", { params: { arr: [1, 2], b: true, n: 5 } })).toEqual({
      query: "arr=1&arr=2&b=true&n=5"
    });
  });

  it("muse.crypto#hash returns deterministic digests for known inputs", async () => {
    const connection = createLoopbackMcpConnection(createCryptoMcpServer());
    expect(await connection.callTool!("hash", { text: "muse", algorithm: "sha256" })).toEqual({
      algorithm: "sha256",
      digest: "4016c3db3bc3c731a4148022f43ebd6d4422b77976763135b9d9afcb9b71b2c1",
      encoding: "hex"
    });
    expect(await connection.callTool!("hash", { text: "muse", algorithm: "sha256", encoding: "base64" })).toEqual({
      algorithm: "sha256",
      digest: "QBbD2zvDxzGkFIAi9D69bUQit3l2djE1udmvy5txssE=",
      encoding: "base64"
    });
    expect(await connection.callTool!("hash", { text: "muse", algorithm: "rot13" })).toEqual({
      error: expect.stringContaining("algorithm must be")
    });
  });

  it("muse.crypto#base64 round-trips encode/decode and rejects bad mode", async () => {
    const connection = createLoopbackMcpConnection(createCryptoMcpServer());
    const encoded = await connection.callTool!("base64", { text: "hello jarvis" });
    expect(encoded).toEqual({ mode: "encode", output: "aGVsbG8gamFydmlz" });
    const decoded = await connection.callTool!("base64", { text: "aGVsbG8gamFydmlz", mode: "decode" });
    expect(decoded).toEqual({ mode: "decode", output: "hello jarvis" });
    expect(await connection.callTool!("base64", { text: "x", mode: "shuffle" })).toEqual({
      error: "mode must be 'encode' or 'decode'"
    });
  });

  it("muse.crypto#base64 decode rejects malformed input instead of silently returning garbled bytes (sibling-parity with the hex decode validation — pre-fix `Buffer.from('not-base64!', 'base64')` dropped invalid chars and returned a nonsense decoded string)", async () => {
    const connection = createLoopbackMcpConnection(createCryptoMcpServer());
    expect(await connection.callTool!("base64", { text: "not-base64!", mode: "decode" })).toEqual({
      error: "input is not a valid base64 string"
    });
    expect(await connection.callTool!("base64", { text: "abc", mode: "decode" })).toEqual({
      error: "input is not a valid base64 string"
    });
    expect(await connection.callTool!("base64", { text: "aGVsbG8 jarvis", mode: "decode" })).toEqual({
      error: "input is not a valid base64 string"
    });
    expect(await connection.callTool!("base64", { text: "aGVsbG8=jarvis", mode: "decode" })).toEqual({
      error: "input is not a valid base64 string"
    });
    expect(await connection.callTool!("base64", { text: "aGVsbG8gamFydmlz", mode: "decode" })).toEqual({
      mode: "decode",
      output: "hello jarvis"
    });
    expect(await connection.callTool!("base64", { text: "", mode: "decode" })).toEqual({
      mode: "decode",
      output: ""
    });
  });

  it("muse.crypto base64/hex decode of non-UTF-8 (binary) bytes errors instead of silent U+FFFD garbage", async () => {
    const connection = createLoopbackMcpConnection(createCryptoMcpServer());
    // "/w==" is the base64 of the single byte 0xFF — valid base64 FORMAT, but the bytes
    // are not valid UTF-8, so toString("utf8") used to silently return the U+FFFD char.
    expect(await connection.callTool!("base64", { text: "/w==", mode: "decode" })).toEqual({
      error: expect.stringContaining("non-UTF-8")
    });
    // "ff" is the hex of the same 0xFF byte.
    expect(await connection.callTool!("hex", { text: "ff", mode: "decode" })).toEqual({
      error: expect.stringContaining("non-UTF-8")
    });
    // a non-ASCII but VALID UTF-8 string still round-trips (no false reject)
    const heHex = Buffer.from("héllo", "utf8").toString("hex");
    expect(await connection.callTool!("hex", { text: heHex, mode: "decode" })).toEqual({ mode: "decode", output: "héllo" });
  });

  it("muse.crypto#hex encodes and decodes UTF-8 and rejects malformed input", async () => {
    const connection = createLoopbackMcpConnection(createCryptoMcpServer());
    expect(await connection.callTool!("hex", { text: "abc" })).toEqual({ mode: "encode", output: "616263" });
    expect(await connection.callTool!("hex", { text: "616263", mode: "decode" })).toEqual({
      mode: "decode",
      output: "abc"
    });
    expect(await connection.callTool!("hex", { text: "xyz", mode: "decode" })).toEqual({
      error: "input is not a valid hex string"
    });
  });

  it("muse.crypto#uuid uses the injected factory for deterministic tests", async () => {
    let counter = 0;
    const connection = createLoopbackMcpConnection(
      createCryptoMcpServer({ uuid: () => `00000000-0000-0000-0000-${String(++counter).padStart(12, "0")}` })
    );
    expect(await connection.callTool!("uuid", {})).toEqual({ uuid: "00000000-0000-0000-0000-000000000001" });
    expect(await connection.callTool!("uuid", {})).toEqual({ uuid: "00000000-0000-0000-0000-000000000002" });
  });

  it("muse.diff#lines computes deletes / inserts / equals against a known fixture", async () => {
    const connection = createLoopbackMcpConnection(createDiffMcpServer());
    const result = await connection.callTool!("lines", {
      left: "alpha\nbeta\ngamma",
      right: "alpha\nBETA\ngamma\ndelta"
    });
    expect(result.equals).toBe(2);
    expect(result.inserts).toBe(2);
    expect(result.deletes).toBe(1);
    const kinds = result.diff.map((entry) => entry.kind);
    // The exact ordering of the BETA / beta block is governed by the LCS
    // backtrack, which can place delete-before-insert or vice versa depending
    // on dp ties. Both orderings are valid; assert the multiset.
    expect(kinds.filter((k) => k === "equal")).toHaveLength(2);
    expect(kinds.filter((k) => k === "insert")).toHaveLength(2);
    expect(kinds.filter((k) => k === "delete")).toHaveLength(1);
    const lines = result.diff.map((entry) => entry.line);
    expect(lines).toContain("BETA");
    expect(lines).toContain("delta");
  });

  it("muse.diff#lines treats identical inputs as all equals", async () => {
    const connection = createLoopbackMcpConnection(createDiffMcpServer());
    const result = await connection.callTool!("lines", { left: "x\ny", right: "x\ny" });
    expect(result.equals).toBe(2);
    expect(result.inserts).toBe(0);
    expect(result.deletes).toBe(0);
    expect(result.diff.every((entry) => entry.kind === "equal")).toBe(true);
  });

  it("muse.diff#lines rejects oversized input", async () => {
    const connection = createLoopbackMcpConnection(createDiffMcpServer());
    const oversized = Array.from({ length: 2_001 }, (_, index) => `line-${index}`).join("\n");
    expect(await connection.callTool!("lines", { left: oversized, right: "tiny" })).toEqual({
      error: "each side must be at most 2000 lines"
    });
  });

  it("muse.diff#equal reports byte-equal status and per-side digests", async () => {
    const connection = createLoopbackMcpConnection(createDiffMcpServer());
    const equalResult = await connection.callTool!("equal", { left: "muse", right: "muse" });
    expect(equalResult).toMatchObject({
      equal: true,
      leftDigest: "4016c3db3bc3c731a4148022f43ebd6d4422b77976763135b9d9afcb9b71b2c1"
    });
    const diffResult = await connection.callTool!("equal", { left: "muse", right: "Muse" });
    expect(diffResult.equal).toBe(false);
    expect(diffResult.leftDigest).not.toBe(diffResult.rightDigest);
  });

  it("muse.regex#test returns boolean match status", async () => {
    const connection = createLoopbackMcpConnection(createRegexMcpServer());
    expect(await connection.callTool!("test", { text: "hello jarvis", pattern: "j[ae]rvis" })).toEqual({
      matched: true
    });
    expect(await connection.callTool!("test", { text: "hello", pattern: "muse" })).toEqual({ matched: false });
    expect(await connection.callTool!("test", { text: "x", pattern: "(unbalanced" })).toEqual({
      error: expect.stringContaining("invalid pattern")
    });
  });

  it("muse.regex#match enumerates matches with index and capture groups, honouring maxMatches", async () => {
    const connection = createLoopbackMcpConnection(createRegexMcpServer());
    const result = await connection.callTool!("match", {
      text: "alpha-1 beta-2 gamma-3",
      pattern: "([a-z]+)-(\\d+)"
    });
    expect(result.matches).toHaveLength(3);
    expect(result.matches[0]).toEqual({ index: 0, value: "alpha-1", groups: ["alpha", "1"] });
    expect(result.matches[1]?.groups).toEqual(["beta", "2"]);
    expect(result.truncated).toBe(false);

    const limited = await connection.callTool!("match", {
      text: "abcdefgh",
      pattern: ".",
      maxMatches: 3
    });
    expect(limited.matches).toHaveLength(3);
    expect(limited.truncated).toBe(true);
  });

  it("muse.regex#replace replaces every occurrence (forces global)", async () => {
    const connection = createLoopbackMcpConnection(createRegexMcpServer());
    expect(
      await connection.callTool!("replace", {
        text: "foo and foo and foo",
        pattern: "foo",
        replacement: "bar"
      })
    ).toEqual({ result: "bar and bar and bar" });
    expect(
      await connection.callTool!("replace", {
        text: "FOO foo Foo",
        pattern: "foo",
        replacement: "X",
        flags: "i"
      })
    ).toEqual({ result: "X X X" });
  });

  it("muse.regex rejects oversized text and pattern lengths", async () => {
    const connection = createLoopbackMcpConnection(createRegexMcpServer());
    const oversized = "a".repeat(50_001);
    expect(await connection.callTool!("test", { text: oversized, pattern: "a" })).toEqual({
      error: expect.stringContaining("text must be at most")
    });
    const longPattern = "a".repeat(257);
    expect(await connection.callTool!("test", { text: "a", pattern: longPattern })).toEqual({
      error: expect.stringContaining("pattern must be at most")
    });
  });
});

describe("muse.fetch loopback server", () => {
  it("rejects URLs whose host is not in the allowlist", async () => {
    const fakeFetch = (() => {
      throw new Error("fetch should not be called for blocked hosts");
    }) as unknown as typeof globalThis.fetch;
    const server = createFetchMcpServer({ allowedHosts: ["api.example.test"], fetch: fakeFetch });
    const connection = createLoopbackMcpConnection(server);
    const result = await connection.callTool!("get", { url: "https://evil.test/data" });
    expect(result).toEqual({
      error: "host 'evil.test' is not in the configured allowlist"
    });
  });

  it("rejects non-http(s) protocols", async () => {
    const server = createFetchMcpServer({ allowedHosts: ["api.example.test"] });
    const connection = createLoopbackMcpConnection(server);
    expect(await connection.callTool!("get", { url: "file:///etc/passwd" })).toEqual({
      error: "unsupported protocol: file:"
    });
  });

  it("rejects malformed URLs", async () => {
    const server = createFetchMcpServer({ allowedHosts: ["api.example.test"] });
    const connection = createLoopbackMcpConnection(server);
    expect(await connection.callTool!("get", { url: "::not::a::url" })).toEqual({
      error: expect.stringContaining("invalid URL")
    });
  });

  it("returns body, status, and headers for an allowlisted GET", async () => {
    let capturedUrl = "";
    const fakeFetch = (async (url: string) => {
      capturedUrl = url;
      return new Response("hello world", {
        headers: { "content-type": "text/plain", "x-custom": "1" },
        status: 200
      });
    }) as unknown as typeof globalThis.fetch;
    const server = createFetchMcpServer({ allowedHosts: ["api.example.test"], fetch: fakeFetch });
    const connection = createLoopbackMcpConnection(server);
    const result = await connection.callTool!("get", { url: "https://api.example.test/path" });
    expect(capturedUrl).toBe("https://api.example.test/path");
    expect(result).toMatchObject({
      body: "hello world",
      status: 200,
      truncated: false
    });
    expect(result.headers["content-type"]).toBe("text/plain");
    expect(result.headers["x-custom"]).toBe("1");
  });

  it("truncates the body at maxBodyBytes and surfaces truncated=true", async () => {
    const longBody = "x".repeat(200);
    const fakeFetch = (async () =>
      new Response(longBody, { headers: {}, status: 200 })) as unknown as typeof globalThis.fetch;
    const server = createFetchMcpServer({
      allowedHosts: ["api.example.test"],
      fetch: fakeFetch,
      maxBodyBytes: 50
    });
    const connection = createLoopbackMcpConnection(server);
    const result = await connection.callTool!("get", { url: "https://api.example.test/" });
    expect(result.body).toHaveLength(50);
    expect(result.truncated).toBe(true);
  });

  it("truncates a multi-byte UTF-8 body on a character boundary — no U+FFFD at the cut", async () => {
    // "가나다라" is 12 bytes (3/char); an 8-byte cap lands inside "다". A raw
    // non-streaming decode of the cut chunk flushes the partial sequence to a
    // replacement char ("가나�"); the stream-flag decode drops it → "가나".
    const fakeFetch = (async () =>
      new Response("가나다라", { headers: {}, status: 200 })) as unknown as typeof globalThis.fetch;
    const server = createFetchMcpServer({ allowedHosts: ["api.example.test"], fetch: fakeFetch, maxBodyBytes: 8 });
    const connection = createLoopbackMcpConnection(server);
    const result = await connection.callTool!("get", { url: "https://api.example.test/" });
    expect(result.truncated).toBe(true);
    expect(result.body).toBe("가나");
    expect(result.body as string).not.toContain("�");
  });

  it("drops a first character split by the cap rather than emitting U+FFFD (cap < one char)", async () => {
    const fakeFetch = (async () =>
      new Response("가나", { headers: {}, status: 200 })) as unknown as typeof globalThis.fetch;
    const server = createFetchMcpServer({ allowedHosts: ["api.example.test"], fetch: fakeFetch, maxBodyBytes: 2 });
    const connection = createLoopbackMcpConnection(server);
    const result = await connection.callTool!("get", { url: "https://api.example.test/" });
    expect(result.truncated).toBe(true);
    expect(result.body).toBe(""); // 2 bytes is mid-"가" → dropped, not "�"
  });

  it("forwards caller-supplied headers (string values only)", async () => {
    let capturedInit: RequestInit | undefined;
    const fakeFetch = (async (_url: string, init: RequestInit) => {
      capturedInit = init;
      return new Response("ok", { headers: {}, status: 200 });
    }) as unknown as typeof globalThis.fetch;
    const server = createFetchMcpServer({ allowedHosts: ["api.example.test"], fetch: fakeFetch });
    const connection = createLoopbackMcpConnection(server);
    await connection.callTool!("get", {
      headers: { authorization: "Bearer x", "x-trace": "abc", num: 42 },
      url: "https://api.example.test/"
    });
    expect(capturedInit?.headers).toMatchObject({
      authorization: "Bearer x",
      "x-trace": "abc"
    });
    expect((capturedInit?.headers as Record<string, string>).num).toBeUndefined();
  });

  it("passes redirect=\"error\" to the underlying fetch impl so a 302 Location to a non-allowlisted host can't bypass the allowlist via auto-redirect — operators wanting redirect chains must allowlist each hop explicitly", async () => {
    let capturedInit: RequestInit | undefined;
    const fakeFetch = (async (_url: string, init: RequestInit) => {
      capturedInit = init;
      return new Response("ok", { headers: {}, status: 200 });
    }) as unknown as typeof globalThis.fetch;
    const server = createFetchMcpServer({ allowedHosts: ["api.example.test"], fetch: fakeFetch });
    const connection = createLoopbackMcpConnection(server);
    await connection.callTool!("get", { url: "https://api.example.test/redirect-source" });
    expect(capturedInit?.redirect).toBe("error");
  });

  it("surfaces a redirect that the runtime fetch refuses (TypeError on follow=error) as a structured fetch-failed payload — the agent sees a clear error, not a silent fall-through to a bypassed host", async () => {
    const fakeFetch = (async () => {
      throw new TypeError("unexpected redirect");
    }) as unknown as typeof globalThis.fetch;
    const server = createFetchMcpServer({ allowedHosts: ["api.example.test"], fetch: fakeFetch });
    const connection = createLoopbackMcpConnection(server);
    const result = await connection.callTool!("get", { url: "https://api.example.test/redirect-source" });
    expect(result).toMatchObject({ error: expect.stringContaining("unexpected redirect") });
  });

  it("muse.fetch#head returns status + headers without a body", async () => {
    const fakeFetch = (async () =>
      new Response("body should not be returned for HEAD", {
        headers: { "content-length": "9" },
        status: 200
      })) as unknown as typeof globalThis.fetch;
    const server = createFetchMcpServer({ allowedHosts: ["api.example.test"], fetch: fakeFetch });
    const connection = createLoopbackMcpConnection(server);
    const result = await connection.callTool!("head", { url: "https://api.example.test/" });
    expect(result).toMatchObject({
      status: 200,
      headers: { "content-length": "9" }
    });
    expect(result.body).toBeUndefined();
  });

  it("matches allowlist hosts case-insensitively", async () => {
    const fakeFetch = (async () =>
      new Response("ok", { status: 200 })) as unknown as typeof globalThis.fetch;
    const server = createFetchMcpServer({
      allowedHosts: ["API.example.test"],
      fetch: fakeFetch
    });
    const connection = createLoopbackMcpConnection(server);
    const result = await connection.callTool!("get", { url: "https://api.example.TEST/" });
    expect(result.status).toBe(200);
  });

  it("surfaces fetch errors as a structured error payload", async () => {
    const fakeFetch = (async () => {
      throw new Error("network down");
    }) as unknown as typeof globalThis.fetch;
    const server = createFetchMcpServer({ allowedHosts: ["api.example.test"], fetch: fakeFetch });
    const connection = createLoopbackMcpConnection(server);
    const result = await connection.callTool!("get", { url: "https://api.example.test/" });
    expect(result).toEqual({ error: "fetch failed: network down" });
  });

  it("stream-reads the body and stops pulling chunks once the maxBodyBytes cap is reached (never buffers a 1 GB allowlisted response into memory)", async () => {
    // Pre-fix `response.text()` reads the ENTIRE body into a single
    // string before the get tool's slice trims it back to maxBodyBytes.
    // A 1 GB response from an allowlisted-but-misbehaving host would
    // consume that much memory just to be sliced down to 64KB after
    // the fact. The streaming-cap fix uses ReadableStream's reader
    // to stop pulling chunks the moment the cap is reached, so the
    // in-flight buffer can never grow past maxBodyBytes.
    //
    // The mock emits 100 × 1KB chunks then closes — a finite, deterministic
    // stream. Pre-fix: the get tool pulls ALL 100 chunks (chunksPulled ≈ 101
    // including the final close-signaling pull). Post-fix: the reader is
    // cancelled after the very first chunk (1024 bytes > 64-byte cap),
    // so chunksPulled stays at 1.
    let chunksPulled = 0;
    const totalChunks = 100;
    let emitted = 0;
    const fakeFetch = (async () => {
      const stream = new ReadableStream<Uint8Array>({
        pull(streamController) {
          chunksPulled += 1;
          if (emitted >= totalChunks) {
            streamController.close();
            return;
          }
          emitted += 1;
          streamController.enqueue(new TextEncoder().encode("x".repeat(1024)));
        }
      });
      return new Response(stream, { status: 200, headers: { "content-type": "text/plain" } });
    }) as unknown as typeof globalThis.fetch;
    const server = createFetchMcpServer({
      allowedHosts: ["bigbody.example.test"],
      fetch: fakeFetch,
      maxBodyBytes: 64
    });
    const connection = createLoopbackMcpConnection(server);
    const result = await connection.callTool!("get", { url: "https://bigbody.example.test/" });
    expect(result.truncated).toBe(true);
    expect(result.body).toHaveLength(64);
    // Cap is 64 bytes and the first chunk is 1024 bytes, so the reader's
    // cancel() must trip on chunk 1. Pre-fix this would be ≥100.
    expect(
      chunksPulled,
      `expected ≤2 chunk pulls (cap is 64 bytes, chunk is 1024); pulled ${chunksPulled.toString()}`
    ).toBeLessThanOrEqual(2);
  });

  it("timeoutMs bounds the body read too, not just the connect+headers phase (a slow body stream is aborted, the call doesn't hang past the cap)", async () => {
    // Pre-fix `callFetch` cleared the timer in its `finally` before
    // the caller's `response.text()` ran, so a body that streams
    // slowly (or never closes) hung indefinitely past the documented
    // timeoutMs. The mock returns a Response whose body is a stream
    // that NEVER closes naturally — its only completion path is via
    // the abort signal. With the fix, the timer fires within the
    // timeoutMs window and aborts the controller, which propagates
    // to the body read via fetch's signal contract.
    const fakeFetch = (async (_url: string, init: RequestInit) => {
      const signal = init.signal as AbortSignal;
      const stream = new ReadableStream<Uint8Array>({
        start(streamController) {
          signal.addEventListener("abort", () => {
            streamController.error(new Error("aborted by signal"));
          });
        }
      });
      return new Response(stream, { status: 200 });
    }) as unknown as typeof globalThis.fetch;
    const server = createFetchMcpServer({
      allowedHosts: ["slow.example.test"],
      fetch: fakeFetch,
      timeoutMs: 50
    });
    const connection = createLoopbackMcpConnection(server);
    const start = Date.now();
    const result = await connection.callTool!("get", { url: "https://slow.example.test/" });
    const elapsed = Date.now() - start;
    expect(result.error, `expected an error for the timed-out body read, got: ${JSON.stringify(result)}`).toMatch(/fetch failed/iu);
    // Generous bound: timeoutMs:50 + scheduling slop. Without the fix
    // the test would hang until vitest's own 5_000ms test timeout.
    expect(elapsed, `body read must abort within the bounded window; took ${elapsed.toString()}ms`).toBeLessThan(2_000);
  });

  it("retries a transient 503 then succeeds (idempotent read), and fails fast on a permanent 404", async () => {
    let flakyCalls = 0;
    const flaky = (async () => {
      flakyCalls += 1;
      return flakyCalls === 1
        ? new Response("busy", { status: 503 })
        : new Response("recovered", { status: 200, headers: { "content-type": "text/plain" } });
    }) as unknown as typeof globalThis.fetch;
    const server = createFetchMcpServer({
      allowedHosts: ["api.example.test"],
      fetch: flaky,
      retryOptions: { sleep: async () => {} }
    });
    const ok = await createLoopbackMcpConnection(server).callTool!("get", { url: "https://api.example.test/data" });
    expect(ok).toMatchObject({ status: 200, body: "recovered" });
    expect(flakyCalls, "a transient 503 must be retried").toBe(2);

    let notFoundCalls = 0;
    const permanent = (async () => {
      notFoundCalls += 1;
      return new Response("nope", { status: 404 });
    }) as unknown as typeof globalThis.fetch;
    const server2 = createFetchMcpServer({
      allowedHosts: ["api.example.test"],
      fetch: permanent,
      retryOptions: { sleep: async () => {} }
    });
    const notFound = await createLoopbackMcpConnection(server2).callTool!("get", { url: "https://api.example.test/missing" });
    expect(notFound).toMatchObject({ status: 404 });
    expect(notFoundCalls, "a permanent 404 must NOT be retried").toBe(1);
  });
});

describe("muse.notes loopback server (filesystem-backed)", () => {
  let tmpRoot: string;

  beforeEach(async () => {
    const os = await import("node:os");
    const fs = await import("node:fs/promises");
    tmpRoot = await fs.mkdtemp(`${os.tmpdir()}/muse-notes-test-`);
  });

  afterEach(async () => {
    const fs = await import("node:fs/promises");
    await fs.rm(tmpRoot, { force: true, recursive: true });
  });

  it("save creates a markdown note + read returns its UTF-8 content", async () => {
    const conn = createLoopbackMcpConnection(createNotesMcpServer({ notesDir: tmpRoot }));
    const saved = await conn.callTool!("save", {
      content: "# Mom's birthday\n\nMay 15. White roses.",
      path: "people/mom.md"
    });
    expect(saved).toMatchObject({ created: true, path: "people/mom.md" });
    const read = await conn.callTool!("read", { path: "people/mom.md" });
    expect(read).toMatchObject({
      content: "# Mom's birthday\n\nMay 15. White roses.",
      path: "people/mom.md"
    });
  });

  it("save without overwrite errors on an existing path; with overwrite=true replaces", async () => {
    const conn = createLoopbackMcpConnection(createNotesMcpServer({ notesDir: tmpRoot }));
    await conn.callTool!("save", { content: "first", path: "n.md" });
    const dup = await conn.callTool!("save", { content: "second", path: "n.md" });
    expect(dup).toMatchObject({ error: expect.stringContaining("already exists") });
    const replaced = await conn.callTool!("save", { content: "second", overwrite: true, path: "n.md" });
    expect(replaced).toMatchObject({ created: false, path: "n.md" });
    const read = await conn.callTool!("read", { path: "n.md" });
    expect(read).toMatchObject({ content: "second" });
  });

  it("append creates the file when missing and tail-appends on subsequent calls", async () => {
    const conn = createLoopbackMcpConnection(createNotesMcpServer({ notesDir: tmpRoot }));
    await conn.callTool!("append", { content: "line one\n", path: "journal.md" });
    await conn.callTool!("append", { content: "line two\n", path: "journal.md" });
    const read = await conn.callTool!("read", { path: "journal.md" });
    expect(read).toMatchObject({ content: "line one\nline two\n" });
  });

  it("append that would exceed maxFileBytes is REJECTED before writing — a failed append mutates NOTHING (no partial side-effect)", async () => {
    const conn = createLoopbackMcpConnection(createNotesMcpServer({ maxFileBytes: 1024, notesDir: tmpRoot }));
    const seed = `${"a".repeat(600)}\n`; // 601 bytes, under the 1024 cap
    await conn.callTool!("append", { content: seed, path: "log.md" });
    const before = await conn.callTool!("read", { path: "log.md" }) as { content: string };
    // this append (600 bytes) would push the file to 1201 > 1024 → must be refused WITHOUT writing
    const over = await conn.callTool!("append", { content: "b".repeat(600), path: "log.md" });
    expect(over).toMatchObject({ error: expect.stringContaining("exceed") });
    const after = await conn.callTool!("read", { path: "log.md" }) as { content: string };
    expect(after.content).toBe(before.content); // UNCHANGED — the oversized bytes never hit disk
  });

  it("list returns directory entries with sizeBytes for files; skips hidden + non-.md is ignored by search", async () => {
    const conn = createLoopbackMcpConnection(createNotesMcpServer({ notesDir: tmpRoot }));
    await conn.callTool!("save", { content: "abc", path: "a.md" });
    await conn.callTool!("save", { content: "def", path: "sub/b.md" });
    const fs = await import("node:fs/promises");
    await fs.writeFile(`${tmpRoot}/.hidden`, "secret");
    const listed = await conn.callTool!("list", {}) as { entries: Array<{ name: string; isDirectory: boolean }> };
    expect(listed.entries.map((e) => e.name).sort()).toEqual(["a.md", "sub"]);
    const subListed = await conn.callTool!("list", { subdir: "sub" }) as { entries: Array<{ name: string }> };
    expect(subListed.entries.map((e) => e.name)).toEqual(["b.md"]);
  });

  it("search finds case-insensitive substring matches with line numbers + snippet", async () => {
    const conn = createLoopbackMcpConnection(createNotesMcpServer({ notesDir: tmpRoot }));
    await conn.callTool!("save", { content: "Mom's BIRTHDAY is May 15.\nBuy white roses.", path: "people/mom.md" });
    await conn.callTool!("save", { content: "Garage opener battery.", path: "house.md" });
    const result = await conn.callTool!("search", { query: "birthday" }) as { matches: Array<{ path: string; line: number; snippet: string }> };
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]).toMatchObject({ line: 1, path: "people/mom.md" });
    expect(result.matches[0]?.snippet).toContain("BIRTHDAY");
  });

  it("search snippet drops a lone trailing high surrogate when the cap straddles an emoji mid-pair", async () => {
    const conn = createLoopbackMcpConnection(createNotesMcpServer({ notesDir: tmpRoot }));
    const pre = "needle " + "x".repeat(232);
    const grin = "😀";
    const line = `${pre}${grin}rest`;
    expect(pre.length).toBe(239);
    await conn.callTool!("save", { content: line, path: "snippet.md" });
    const result = await conn.callTool!("search", { query: "needle" }) as { matches: Array<{ snippet: string }> };
    expect(result.matches).toHaveLength(1);
    const snippet = result.matches[0]!.snippet;
    expect(snippet.endsWith("...")).toBe(true);
    const head = snippet.slice(0, snippet.length - 3);
    for (let i = 0; i < head.length; i += 1) {
      const c = head.charCodeAt(i);
      expect(c >= 0xd800 && c <= 0xdfff, `loopback snippet index ${i.toString()} must not be a lone surrogate`).toBe(false);
    }
  });

  it("rejects path traversal attempts and absolute paths", async () => {
    const conn = createLoopbackMcpConnection(createNotesMcpServer({ notesDir: tmpRoot }));
    expect(await conn.callTool!("read", { path: "../etc/passwd" })).toEqual({
      error: "path escapes the notes directory"
    });
    expect(await conn.callTool!("save", { content: "x", path: "/tmp/leak.md" })).toEqual({
      error: "path must be relative to the notes directory"
    });
    expect(await conn.callTool!("read", { path: "" })).toEqual({ error: "path must not be empty" });
  });

  it("registers as 6 Muse tools (list/read/search/save/append/delete) with correct risk levels", () => {
    const tools = createLoopbackMcpMuseTools(createNotesMcpServer({ notesDir: tmpRoot }));
    expect(tools.map((t) => t.definition.name).sort()).toEqual([
      "muse.notes.append",
      "muse.notes.delete",
      "muse.notes.list",
      "muse.notes.read",
      "muse.notes.save",
      "muse.notes.search"
    ]);
    const byName = new Map(tools.map((t) => [t.definition.name, t.definition.risk] as const));
    expect(byName.get("muse.notes.list")).toBe("read");
    expect(byName.get("muse.notes.read")).toBe("read");
    expect(byName.get("muse.notes.search")).toBe("read");
    expect(byName.get("muse.notes.save")).toBe("write");
    expect(byName.get("muse.notes.append")).toBe("write");
    expect(byName.get("muse.notes.delete")).toBe("write");
  });

  it("muse.notes.search mode=llm-judge rejects without modelProvider; returns mode field in substring path", async () => {
    const { mkdtempSync, writeFileSync, mkdirSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "muse-notes-judge-noprov-"));
    mkdirSync(join(dir, "journal"), { recursive: true });
    writeFileSync(join(dir, "journal", "hello.md"), "Hello world!", "utf8");
    const connection = createLoopbackMcpConnection(createNotesMcpServer({ notesDir: dir }));

    // Substring path now also reports mode in the payload.
    const substring = await connection.callTool!("search", { query: "hello" });
    expect(substring.mode).toBe("substring");

    // llm-judge rejects without provider.
    const refused = await connection.callTool!("search", { mode: "llm-judge", query: "anything" });
    expect(refused).toMatchObject({ error: expect.stringContaining("llm-judge mode requires modelProvider") });
  });

  it("muse.notes.search mode=llm-judge: model picks paths from previews; drops hallucinated paths", async () => {
    const { mkdtempSync, writeFileSync, mkdirSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "muse-notes-judge-ok-"));
    mkdirSync(join(dir, "journal"), { recursive: true });
    mkdirSync(join(dir, "projects"), { recursive: true });
    writeFileSync(join(dir, "journal", "2026-05-12.md"), "Q3 budget memo planning. Drafting in Notion.", "utf8");
    writeFileSync(join(dir, "journal", "2026-05-11.md"), "Wedding venue shortlist.", "utf8");
    writeFileSync(join(dir, "projects", "routine.md"), "Routine setup notes.", "utf8");

    let seenUser = "";
    const modelProvider = {
      generate: async (req: { messages: ReadonlyArray<{ role: "system" | "user" | "assistant"; content: string }> }) => {
        seenUser = req.messages.find((m) => m.role === "user")?.content ?? "";
        return { output: '["journal/2026-05-12.md", "fake/hallucinated.md"]' };
      }
    };
    const connection = createLoopbackMcpConnection(createNotesMcpServer({
      model: "stub",
      modelProvider,
      notesDir: dir
    }));

    const result = await connection.callTool!("search", { mode: "llm-judge", query: "Notion thing" });
    expect(result.mode).toBe("llm-judge");
    expect((result.matches as Array<{ path: string }>).map((m) => m.path)).toEqual(["journal/2026-05-12.md"]);
    // The hallucinated path is dropped — never appears in the result set.
    expect((result.matches as Array<{ path: string }>).map((m) => m.path)).not.toContain("fake/hallucinated.md");
    // Goal 058 — and the dropped count is surfaced as a diagnostic
    // so callers can spot prompt drift without leaking the bad
    // strings themselves.
    expect(result.hallucinatedDropped).toBe(1);
    // User message contained the actual file previews.
    expect(seenUser).toContain("Query: Notion thing");
    expect(seenUser).toContain("[journal/2026-05-12.md]");
    expect(seenUser).toContain("Q3 budget memo");
  });

  it("muse.notes.search mode=llm-judge omits hallucinatedDropped when all paths are valid (goal 058)", async () => {
    const { mkdtempSync, writeFileSync, mkdirSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "muse-notes-judge-clean-"));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "a.md"), "alpha content", "utf8");
    writeFileSync(join(dir, "b.md"), "beta content", "utf8");
    const connection = createLoopbackMcpConnection(createNotesMcpServer({
      model: "stub",
      modelProvider: { generate: async () => ({ output: '["a.md","b.md"]' }) },
      notesDir: dir
    }));
    const result = await connection.callTool!("search", { mode: "llm-judge", query: "anything" });
    // Both paths exist → diagnostic field is omitted entirely.
    expect(result.hallucinatedDropped).toBeUndefined();
    expect((result.matches as Array<{ path: string }>).length).toBe(2);
  });

  it("muse.notes.search mode=llm-judge tolerates prose wrap; returns [] on malformed JSON", async () => {
    const { mkdtempSync, writeFileSync, mkdirSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "muse-notes-judge-edge-"));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "note.md"), "Some content.", "utf8");

    const wrapped = createLoopbackMcpConnection(createNotesMcpServer({
      model: "stub",
      modelProvider: { generate: async () => ({ output: 'Sure, here you go: ["note.md"] — hope this helps!' }) },
      notesDir: dir
    }));
    const wrapResult = await wrapped.callTool!("search", { mode: "llm-judge", query: "x" });
    expect((wrapResult.matches as Array<{ path: string }>).map((m) => m.path)).toEqual(["note.md"]);

    const bad = createLoopbackMcpConnection(createNotesMcpServer({
      model: "stub",
      modelProvider: { generate: async () => ({ output: "not-json-at-all" }) },
      notesDir: dir
    }));
    const badResult = await bad.callTool!("search", { mode: "llm-judge", query: "x" });
    expect((badResult.matches as Array<{ path: string }>).length).toBe(0);
  });
});

describe("muse.fs loopback server", () => {
  function fakeFs(layout: Record<string, string | "dir">) {
    const entries = new Map(Object.entries(layout));
    const now = new Date("2026-05-07T00:00:00.000Z");
    return {
      readFile: async (path: string) => {
        const value = entries.get(path);
        if (value === undefined || value === "dir") {
          throw Object.assign(new Error(`ENOENT: no such file '${path}'`), { code: "ENOENT" });
        }
        return Buffer.from(value, "utf8");
      },
      readdir: async (path: string, _opts: { withFileTypes: true }) => {
        if (entries.get(path) !== "dir") {
          throw Object.assign(new Error(`ENOTDIR: not a directory '${path}'`), { code: "ENOTDIR" });
        }
        const prefix = path.endsWith("/") ? path : `${path}/`;
        return [...entries.entries()]
          .filter(([key]) => key.startsWith(prefix) && !key.slice(prefix.length).includes("/"))
          .map(([key, value]) => {
            const name = key.slice(prefix.length);
            return {
              isDirectory: () => value === "dir",
              isFile: () => value !== "dir",
              isSymbolicLink: () => false,
              name
            };
          });
      },
      stat: async (path: string) => {
        const value = entries.get(path);
        if (value === undefined) {
          throw Object.assign(new Error(`ENOENT: no such file '${path}'`), { code: "ENOENT" });
        }
        return {
          isDirectory: () => value === "dir",
          isFile: () => value !== "dir",
          isSymbolicLink: () => false,
          mtime: now,
          size: value === "dir" ? 0 : Buffer.byteLength(value, "utf8")
        };
      }
    };
  }

  const posixPath = {
    resolve: (...segments: string[]) => {
      if (segments.length === 0) {
        return "/";
      }
      const last = segments[segments.length - 1] ?? "/";
      if (last.startsWith("/")) {
        return last.replace(/\/{2,}/gu, "/").replace(/\/$/u, "") || "/";
      }
      return `/${segments.join("/").replace(/\/{2,}/gu, "/").replace(/\/$/u, "")}`;
    },
    sep: "/"
  };

  it("rejects read paths that escape the allowlist", async () => {
    const server = createFilesystemMcpServer({
      allowedRoots: ["/workspace"],
      fs: fakeFs({ "/workspace": "dir", "/workspace/note.md": "hello" }),
      path: posixPath
    });
    const connection = createLoopbackMcpConnection(server);
    expect(await connection.callTool!("read", { path: "/etc/passwd" })).toEqual({
      error: "path '/etc/passwd' is not under any configured allowlist root"
    });
  });

  it("rejects allowlist-prefix collisions ('/etc' must not match '/etc-passwd')", async () => {
    const server = createFilesystemMcpServer({
      allowedRoots: ["/etc"],
      fs: fakeFs({ "/etc": "dir", "/etc-passwd": "secrets", "/etc/hosts": "127.0.0.1" }),
      path: posixPath
    });
    const connection = createLoopbackMcpConnection(server);
    const sibling = await connection.callTool!("read", { path: "/etc-passwd" });
    expect(sibling).toEqual({
      error: "path '/etc-passwd' is not under any configured allowlist root"
    });
    const inside = await connection.callTool!("read", { path: "/etc/hosts" });
    expect(inside).toMatchObject({ content: "127.0.0.1", truncated: false });
  });

  it("reads UTF-8 file content with bytes/truncated metadata", async () => {
    const server = createFilesystemMcpServer({
      allowedRoots: ["/workspace"],
      fs: fakeFs({ "/workspace": "dir", "/workspace/note.md": "hello world" }),
      path: posixPath
    });
    const connection = createLoopbackMcpConnection(server);
    const result = await connection.callTool!("read", { path: "/workspace/note.md" });
    expect(result).toMatchObject({ bytes: 11, content: "hello world", truncated: false });
  });

  it("truncates content at maxBodyBytes and surfaces truncated=true", async () => {
    const server = createFilesystemMcpServer({
      allowedRoots: ["/workspace"],
      fs: fakeFs({ "/workspace": "dir", "/workspace/note.md": "x".repeat(200) }),
      maxBodyBytes: 50,
      path: posixPath
    });
    const connection = createLoopbackMcpConnection(server);
    const result = await connection.callTool!("read", { path: "/workspace/note.md" });
    expect(result.bytes).toBe(200);
    expect(typeof result.content).toBe("string");
    expect((result.content as string).length).toBe(50);
    expect(result.truncated).toBe(true);
  });

  it("truncates a multi-byte UTF-8 (Korean) file on a CHARACTER boundary, not mid-codepoint", async () => {
    // "가나다라" is 12 bytes (3 each); an 8-byte cap lands inside "다". A raw byte
    // slice would decode to "가나�" — the agent ingesting replacement-char garbage.
    const server = createFilesystemMcpServer({
      allowedRoots: ["/workspace"],
      fs: fakeFs({ "/workspace": "dir", "/workspace/ko.md": "가나다라" }),
      maxBodyBytes: 8,
      path: posixPath
    });
    const connection = createLoopbackMcpConnection(server);
    const result = await connection.callTool!("read", { path: "/workspace/ko.md" });
    expect(result.bytes).toBe(12);
    expect(result.truncated).toBe(true);
    expect(result.content).toBe("가나");
    expect(result.content as string).not.toContain("�");
  });

  it("lists directory entries with kind classification and respects maxListEntries", async () => {
    const server = createFilesystemMcpServer({
      allowedRoots: ["/workspace"],
      fs: fakeFs({
        "/workspace": "dir",
        "/workspace/sub": "dir",
        "/workspace/a.md": "a",
        "/workspace/b.md": "b",
        "/workspace/c.md": "c"
      }),
      maxListEntries: 2,
      path: posixPath
    });
    const connection = createLoopbackMcpConnection(server);
    const result = await connection.callTool!("list", { path: "/workspace" });
    expect(result).toMatchObject({ total: 4, truncated: true });
    expect(Array.isArray(result.entries)).toBe(true);
    expect((result.entries as readonly { kind: string }[]).length).toBe(2);
  });

  it("returns kind/size/mtime metadata from stat", async () => {
    const server = createFilesystemMcpServer({
      allowedRoots: ["/workspace"],
      fs: fakeFs({ "/workspace": "dir", "/workspace/note.md": "hello" }),
      path: posixPath
    });
    const connection = createLoopbackMcpConnection(server);
    const fileStat = await connection.callTool!("stat", { path: "/workspace/note.md" });
    expect(fileStat).toMatchObject({ kind: "file", size: 5, mtime: "2026-05-07T00:00:00.000Z" });
    const dirStat = await connection.callTool!("stat", { path: "/workspace" });
    expect(dirStat).toMatchObject({ kind: "directory", size: 0 });
  });

  it("returns a structured error when fs operations throw", async () => {
    const server = createFilesystemMcpServer({
      allowedRoots: ["/workspace"],
      fs: fakeFs({ "/workspace": "dir" }),
      path: posixPath
    });
    const connection = createLoopbackMcpConnection(server);
    const missing = await connection.callTool!("read", { path: "/workspace/missing.md" });
    expect(missing).toEqual({ error: expect.stringContaining("read failed: ENOENT") });
  });

  it("requires an explicit path argument", async () => {
    const server = createFilesystemMcpServer({ allowedRoots: ["/workspace"], fs: fakeFs({ "/workspace": "dir" }), path: posixPath });
    const connection = createLoopbackMcpConnection(server);
    expect(await connection.callTool!("stat", {})).toEqual({ error: "path is required" });
  });

  it("works against the real node:fs in a tmp directory (defaults wired correctly)", async () => {
    const { mkdtempSync, writeFileSync, mkdirSync } = await import("node:fs");
    const tmpdir = await import("node:os").then((m) => m.tmpdir());
    const root = mkdtempSync(`${tmpdir}/muse-fs-loopback-`);
    mkdirSync(`${root}/sub`, { recursive: true });
    writeFileSync(`${root}/note.md`, "real content");
    writeFileSync(`${root}/sub/nested.txt`, "nested");

    const server = createFilesystemMcpServer({ allowedRoots: [root] });
    const connection = createLoopbackMcpConnection(server);

    const read = await connection.callTool!("read", { path: `${root}/note.md` });
    expect(read).toMatchObject({ content: "real content", truncated: false });

    const list = await connection.callTool!("list", { path: root });
    expect((list.entries as readonly { name: string; kind: string }[]).map((entry) => entry.name).sort()).toEqual(["note.md", "sub"]);

    const escapeAttempt = await connection.callTool!("read", { path: `${root}/../etc/passwd` });
    expect(escapeAttempt).toMatchObject({ error: expect.stringContaining("not under any configured allowlist root") });
  });
});

describe("muse.search loopback server", () => {
  // Minimal DDG HTML fixture in the shape parseDuckDuckGoHtml expects.
  const HTML = `
    <html><body>
    <div class="result">
      <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa&amp;rut=x">First &amp; result</a>
      <a class="result__snippet" href="https://example.com/a">Snippet for the first result.</a>
    </div>
    <div class="result">
      <a rel="nofollow" class="result__a" href="https://no-redirect.test/two">Second result</a>
      <a class="result__snippet" href="https://no-redirect.test/two">Another snippet here.</a>
    </div>
    </body></html>`;

  it("returns parsed results with title/url/snippet and unwraps the DDG redirect", async () => {
    const fakeFetch: typeof globalThis.fetch = async () => new Response(HTML, { status: 200 });
    const server = createSearchMcpServer({ fetch: fakeFetch });
    const connection = createLoopbackMcpConnection(server);
    const result = await connection.callTool!("search", { query: "muse" });
    expect(result).toMatchObject({ query: "muse", total: 2 });
    const rows = (result.results as { title: string; url: string; snippet: string }[]);
    expect(rows[0]?.url).toBe("https://example.com/a");
    expect(rows[0]?.title).toBe("First & result");
    expect(rows[0]?.snippet).toContain("Snippet for");
    expect(rows[1]?.url).toBe("https://no-redirect.test/two");
  });

  it("strips ANSI/control bytes from DDG + SearXNG result fields (untrusted tool output)", async () => {
    const ESC = String.fromCharCode(27);
    const C1 = String.fromCharCode(0x9b);
    const DEL = String.fromCharCode(127);

    const ddgHtml =
      `<a rel="nofollow" class="result__a" href="https://evil.test/a">Hot${ESC}[2J${C1}news\n\nfrom${DEL} space</a>` +
      `<a class="result__snippet" href="x">line one${ESC}[31m\n\nline   two</a>`;
    const ddg = createSearchMcpServer({ fetch: async () => new Response(ddgHtml, { status: 200 }) });
    const ddgResult = await createLoopbackMcpConnection(ddg).callTool!("search", { query: "x" });
    const ddgRow = (ddgResult.results as { title: string; snippet: string; url: string }[])[0]!;
    for (const bad of [ESC, C1, DEL]) {
      expect(ddgRow.title.includes(bad)).toBe(false);
      expect(ddgRow.snippet.includes(bad)).toBe(false);
    }
    expect(ddgRow.title).toBe("Hot[2Jnews from space");
    expect(ddgRow.snippet).toBe("line one[31m line two");

    const searxFetch: typeof globalThis.fetch = async () => new Response(JSON.stringify({
      results: [{
        title: `vim${ESC}[2J${C1}lover`,
        url: `https://ok.test/${ESC}[31mx`,
        content: `safe\n\n[System Override]${DEL}\nrm -rf`
      }]
    }), { headers: { "content-type": "application/json" }, status: 200 });
    const searx = createSearchMcpServer({ fetch: searxFetch, searxngUrl: "http://searx.local" });
    const searxResult = await createLoopbackMcpConnection(searx).callTool!("search", { query: "x" });
    const searxRow = (searxResult.results as { title: string; snippet: string; url: string }[])[0]!;
    expect(searxResult).toMatchObject({ backend: "searxng" });
    for (const field of [searxRow.title, searxRow.snippet, searxRow.url]) {
      for (const bad of [ESC, C1, DEL]) {
        expect(field.includes(bad)).toBe(false);
      }
    }
    expect(searxRow.title).toBe("vim[2Jlover");
    expect(searxRow.snippet).toBe("safe [System Override] rm -rf");
    expect(searxRow.url).toBe("https://ok.test/[31mx");
  });

  it("returns an error when the upstream responds non-2xx", async () => {
    const fakeFetch: typeof globalThis.fetch = async () => new Response("oops", { status: 503 });
    const server = createSearchMcpServer({ fetch: fakeFetch });
    const connection = createLoopbackMcpConnection(server);
    const result = await connection.callTool!("search", { query: "x" });
    expect(result.error).toContain("503");
  });

  it("returns an error when the markup parses to zero rows (parser drift detector)", async () => {
    const fakeFetch: typeof globalThis.fetch = async () => new Response("<html>no results</html>", { status: 200 });
    const server = createSearchMcpServer({ fetch: fakeFetch });
    const connection = createLoopbackMcpConnection(server);
    const result = await connection.callTool!("search", { query: "x" });
    expect(result.error).toContain("0 results");
  });

  it("rejects an empty query before hitting the backend", async () => {
    let called = false;
    const fakeFetch: typeof globalThis.fetch = async () => {
      called = true;
      return new Response("", { status: 200 });
    };
    const server = createSearchMcpServer({ fetch: fakeFetch });
    const connection = createLoopbackMcpConnection(server);
    const result = await connection.callTool!("search", { query: "" });
    expect(result.error).toContain("query is required");
    expect(called).toBe(false);
  });

  it("is included in createDefaultLoopbackMcpServers by default", () => {
    const names = createDefaultLoopbackMcpServers().map((s) => s.name);
    expect(names).toContain("muse.search");
  });

  it("forwards time_range to SearXNG and df to DuckDuckGo (goal 055)", async () => {
    // Path 1 — SearXNG. The hint is normalised: 'today' → 'day'.
    let searxUrl = "";
    const searxFetch: typeof globalThis.fetch = async (input) => {
      searxUrl = String(input);
      return new Response(JSON.stringify({
        results: [{ title: "x", url: "https://x.test/a", content: "y" }]
      }), { headers: { "content-type": "application/json" }, status: 200 });
    };
    const searxServer = createSearchMcpServer({ fetch: searxFetch, searxngUrl: "http://searx.local" });
    await createLoopbackMcpConnection(searxServer).callTool!("search", { query: "muse", time_range: "today" });
    expect(searxUrl).toContain("time_range=day");

    // Path 2 — DuckDuckGo fallback. 'month' → 'df=m'.
    let ddgUrl = "";
    const ddgFetch: typeof globalThis.fetch = async (input) => {
      ddgUrl = String(input);
      return new Response(
        `<div class="result"><a class="result__a" href="https://e.test/p">e</a>` +
        `<a class="result__snippet" href="https://e.test/p">snip</a></div>`,
        { status: 200 }
      );
    };
    const ddgServer = createSearchMcpServer({ fetch: ddgFetch });
    await createLoopbackMcpConnection(ddgServer).callTool!("search", { query: "muse", time_range: "month" });
    expect(ddgUrl).toContain("df=m");

    // Unknown values fall through cleanly — no time_range / df is added.
    let plainUrl = "";
    const plainFetch: typeof globalThis.fetch = async (input) => {
      plainUrl = String(input);
      return new Response(
        `<div class="result"><a class="result__a" href="https://e.test/p">e</a>` +
        `<a class="result__snippet" href="https://e.test/p">snip</a></div>`,
        { status: 200 }
      );
    };
    const plainServer = createSearchMcpServer({ fetch: plainFetch });
    await createLoopbackMcpConnection(plainServer).callTool!("search", { query: "muse", time_range: "nonsense" });
    expect(plainUrl).not.toContain("df=");
    expect(plainUrl).not.toContain("time_range=");
  });

  it("when searxngUrl is set, hits SearXNG JSON first and returns its results with backend=searxng", async () => {
    let calledSearxng = false;
    let calledDdg = false;
    const fakeFetch: typeof globalThis.fetch = async (input) => {
      const url = String(input);
      if (url.startsWith("http://searx.local")) {
        calledSearxng = true;
        return new Response(JSON.stringify({
          results: [
            { title: "Searx First", url: "https://searx.example/a", content: "first searx snippet" },
            { title: "Searx Second", url: "https://searx.example/b", content: "second searx snippet" }
          ]
        }), { headers: { "content-type": "application/json" }, status: 200 });
      }
      calledDdg = true;
      return new Response("should not be called", { status: 500 });
    };
    const server = createSearchMcpServer({ fetch: fakeFetch, searxngUrl: "http://searx.local" });
    const connection = createLoopbackMcpConnection(server);
    const result = await connection.callTool!("search", { query: "muse" });
    expect(calledSearxng).toBe(true);
    expect(calledDdg).toBe(false);
    expect(result).toMatchObject({ backend: "searxng", query: "muse", total: 2 });
    const rows = result.results as { title: string; url: string; snippet: string }[];
    expect(rows[0]?.url).toBe("https://searx.example/a");
    expect(rows[0]?.snippet).toBe("first searx snippet");
  });

  it("when SearXNG fails (non-2xx, bad JSON, or zero results), falls through to the DDG HTML backend", async () => {
    // Path 1: HTTP error on searxng → DDG runs.
    const httpErrFetch: typeof globalThis.fetch = async (input) => {
      const url = String(input);
      if (url.startsWith("http://searx.local")) return new Response("down", { status: 503 });
      return new Response(`<a rel="nofollow" class="result__a" href="https://example.com/a">title</a><a class="result__snippet" href="x">snip</a>`, { status: 200 });
    };
    const r1 = await createLoopbackMcpConnection(createSearchMcpServer({ fetch: httpErrFetch, searxngUrl: "http://searx.local" }))
      .callTool!("search", { query: "x" });
    expect(r1).toMatchObject({ backend: "duckduckgo", total: 1 });

    // Path 2: SearXNG returns zero hits → DDG runs.
    const zeroFetch: typeof globalThis.fetch = async (input) => {
      const url = String(input);
      if (url.startsWith("http://searx.local")) return new Response(JSON.stringify({ results: [] }), { status: 200 });
      return new Response(`<a rel="nofollow" class="result__a" href="https://example.com/b">t</a><a class="result__snippet" href="x">s</a>`, { status: 200 });
    };
    const r2 = await createLoopbackMcpConnection(createSearchMcpServer({ fetch: zeroFetch, searxngUrl: "http://searx.local" }))
      .callTool!("search", { query: "x" });
    expect(r2).toMatchObject({ backend: "duckduckgo", total: 1 });

    // Path 3: SearXNG returns malformed JSON (no `results` array) → DDG runs.
    const badJsonFetch: typeof globalThis.fetch = async (input) => {
      const url = String(input);
      if (url.startsWith("http://searx.local")) return new Response(JSON.stringify({ oops: "wrong shape" }), { status: 200 });
      return new Response(`<a rel="nofollow" class="result__a" href="https://example.com/c">t</a><a class="result__snippet" href="x">s</a>`, { status: 200 });
    };
    const r3 = await createLoopbackMcpConnection(createSearchMcpServer({ fetch: badJsonFetch, searxngUrl: "http://searx.local" }))
      .callTool!("search", { query: "x" });
    expect(r3).toMatchObject({ backend: "duckduckgo", total: 1 });
  });

  it("forwards searxngEngines through as the `engines` query param", async () => {
    let seenUrl = "";
    const fakeFetch: typeof globalThis.fetch = async (input) => {
      seenUrl = String(input);
      return new Response(JSON.stringify({ results: [{ title: "x", url: "https://x", content: "y" }] }), { status: 200 });
    };
    await createLoopbackMcpConnection(createSearchMcpServer({
      fetch: fakeFetch,
      searxngEngines: "google,brave",
      searxngUrl: "http://searx.local"
    })).callTool!("search", { query: "muse" });
    expect(seenUrl).toContain("engines=google");
    expect(seenUrl).toContain("brave");
  });
});

describe("compareTasksByDueDate", () => {
  const mk = (id: string, dueAt: string | undefined, createdAt: string) => ({
    createdAt, dueAt, id, status: "open" as const, title: id
  });

  it("puts the most-imminent dueAt first", () => {
    const tasks = [
      mk("late", "2026-05-20T00:00:00Z", "2026-05-13T10:00:00Z"),
      mk("soon", "2026-05-14T00:00:00Z", "2026-05-13T09:00:00Z"),
      mk("now", "2026-05-13T12:00:00Z", "2026-05-13T08:00:00Z")
    ];
    const sorted = [...tasks].sort(compareTasksByDueDate).map((t) => t.id);
    expect(sorted).toEqual(["now", "soon", "late"]);
  });

  it("sinks tasks without a dueAt to the bottom, newest-created first within that bucket", () => {
    const tasks = [
      mk("undated-old", undefined, "2026-05-10T00:00:00Z"),
      mk("dated", "2026-05-14T00:00:00Z", "2026-05-13T00:00:00Z"),
      mk("undated-new", undefined, "2026-05-13T00:00:00Z")
    ];
    const sorted = [...tasks].sort(compareTasksByDueDate).map((t) => t.id);
    expect(sorted).toEqual(["dated", "undated-new", "undated-old"]);
  });

  it("orders by instant, not raw string (mixed ms precision / timezone offset)", () => {
    const tasks = [
      // 09:00:00.500Z — later instant, but string-sorts BEFORE "…00Z".
      mk("ms-late", "2026-05-14T09:00:00.500Z", "2026-05-13T01:00:00Z"),
      mk("ms-early", "2026-05-14T09:00:00Z", "2026-05-13T02:00:00Z"),
      // 18:00+09:00 == 09:00Z — earliest instant, string-sorts LAST.
      mk("offset-earliest", "2026-05-14T18:00:00+09:00", "2026-05-13T03:00:00Z"),
      mk("utc-latest", "2026-05-14T12:00:00Z", "2026-05-13T04:00:00Z")
    ];
    const sorted = [...tasks].sort(compareTasksByDueDate).map((t) => t.id);
    // Instants: offset-earliest 09:00:00.000, ms-early 09:00:00.000,
    // ms-late 09:00:00.500, utc-latest 12:00:00. The two 09:00:00.000
    // ties fall to createdAt-desc (offset-earliest created later).
    expect(sorted).toEqual(["offset-earliest", "ms-early", "ms-late", "utc-latest"]);
  });

  it("breaks dueAt ties by newest-created first", () => {
    const tasks = [
      mk("same-due-old", "2026-05-14T00:00:00Z", "2026-05-12T00:00:00Z"),
      mk("same-due-new", "2026-05-14T00:00:00Z", "2026-05-13T00:00:00Z")
    ];
    const sorted = [...tasks].sort(compareTasksByDueDate).map((t) => t.id);
    expect(sorted).toEqual(["same-due-new", "same-due-old"]);
  });

  it("falls through to id ASC when dueAt AND createdAt are both equal — bulk-import duplicates and fast successive creates must surface in a deterministic order", () => {
    const tasks = [
      mk("zeta", "2026-05-14T00:00:00Z", "2026-05-12T00:00:00Z"),
      mk("alpha", "2026-05-14T00:00:00Z", "2026-05-12T00:00:00Z"),
      mk("mu", "2026-05-14T00:00:00Z", "2026-05-12T00:00:00Z")
    ];
    expect([...tasks].sort(compareTasksByDueDate).map((t) => t.id))
      .toEqual(["alpha", "mu", "zeta"]);
    expect([...tasks].reverse().sort(compareTasksByDueDate).map((t) => t.id))
      .toEqual(["alpha", "mu", "zeta"]);
  });
});

describe("compareRemindersByDueAt", () => {
  const mk = (id: string, dueAt: string, createdAt: string) => ({
    createdAt, dueAt, id, status: "pending" as const, text: id
  });

  it("orders soonest-due-first by instant, not raw string", () => {
    const reminders = [
      mk("late", "2026-05-20T00:00:00Z", "2026-05-13T10:00:00Z"),
      // 18:00+09:00 == 09:00Z — earliest instant but string-sorts last.
      mk("offset-soonest", "2026-05-14T18:00:00+09:00", "2026-05-13T09:00:00Z"),
      // 09:00:00.500Z — later than offset-soonest, string-sorts BEFORE "…Z".
      mk("ms-mid", "2026-05-14T09:00:00.500Z", "2026-05-13T08:00:00Z")
    ];
    const sorted = [...reminders].sort(compareRemindersByDueAt).map((r) => r.id);
    expect(sorted).toEqual(["offset-soonest", "ms-mid", "late"]);
  });

  it("breaks equal-instant ties by newest-created first (matches task ordering)", () => {
    const reminders = [
      mk("old", "2026-05-14T09:00:00Z", "2026-05-12T00:00:00Z"),
      // Same instant as `old`, different string form.
      mk("new", "2026-05-14T18:00:00+09:00", "2026-05-13T00:00:00Z")
    ];
    expect([...reminders].sort(compareRemindersByDueAt).map((r) => r.id)).toEqual(["new", "old"]);
  });

  it("falls through to id ASC when dueAt AND createdAt are both equal — deterministic across input permutations", () => {
    const reminders = [
      mk("zeta", "2026-05-14T09:00:00Z", "2026-05-12T00:00:00Z"),
      mk("alpha", "2026-05-14T09:00:00Z", "2026-05-12T00:00:00Z"),
      mk("mu", "2026-05-14T09:00:00Z", "2026-05-12T00:00:00Z")
    ];
    expect([...reminders].sort(compareRemindersByDueAt).map((r) => r.id))
      .toEqual(["alpha", "mu", "zeta"]);
    expect([...reminders].reverse().sort(compareRemindersByDueAt).map((r) => r.id))
      .toEqual(["alpha", "mu", "zeta"]);
  });
});

describe("compareFollowupsByScheduledFor", () => {
  const mk = (id: string, scheduledFor: string, createdAt: string) => ({
    createdAt, id, scheduledFor, status: "scheduled" as const,
    summary: id, userId: "u", runId: "r"
  });

  it("orders soonest-first by instant across mixed ISO forms", () => {
    const followups = [
      mk("late", "2026-05-20T00:00:00Z", "2026-05-13T01:00:00Z"),
      // 18:00+09:00 == 09:00Z — earliest instant, string-sorts last.
      mk("offset-soonest", "2026-05-14T18:00:00+09:00", "2026-05-13T02:00:00Z"),
      // 09:00:00.500Z — later than offset-soonest, string-sorts BEFORE "…Z".
      mk("ms-mid", "2026-05-14T09:00:00.500Z", "2026-05-13T03:00:00Z")
    ];
    expect([...followups].sort(compareFollowupsByScheduledFor).map((f) => f.id))
      .toEqual(["offset-soonest", "ms-mid", "late"]);
  });

  it("breaks equal-instant ties by newest-created first (matches task/reminder ordering)", () => {
    const followups = [
      mk("old", "2026-05-14T09:00:00Z", "2026-05-12T00:00:00Z"),
      mk("new", "2026-05-14T18:00:00+09:00", "2026-05-13T00:00:00Z")
    ];
    expect([...followups].sort(compareFollowupsByScheduledFor).map((f) => f.id))
      .toEqual(["new", "old"]);
  });

  it("falls through to id ASC when scheduledFor AND createdAt are both equal — deterministic across input permutations", () => {
    const followups = [
      mk("zeta", "2026-05-14T09:00:00Z", "2026-05-12T00:00:00Z"),
      mk("alpha", "2026-05-14T09:00:00Z", "2026-05-12T00:00:00Z"),
      mk("mu", "2026-05-14T09:00:00Z", "2026-05-12T00:00:00Z")
    ];
    expect([...followups].sort(compareFollowupsByScheduledFor).map((f) => f.id))
      .toEqual(["alpha", "mu", "zeta"]);
    expect([...followups].reverse().sort(compareFollowupsByScheduledFor).map((f) => f.id))
      .toEqual(["alpha", "mu", "zeta"]);
  });
});

describe("muse.tasks loopback server", () => {
  it("supports the add → list → complete → search lifecycle", async () => {
    const { mkdtempSync } = await import("node:fs");
    const tmpdir = await import("node:os").then((m) => m.tmpdir());
    const dir = mkdtempSync(`${tmpdir}/muse-tasks-`);
    let counter = 0;
    const idFactory = () => `task_${++counter}`;
    const server = createTasksMcpServer({ file: `${dir}/tasks.json`, idFactory });
    const connection = createLoopbackMcpConnection(server);

    const add1 = await connection.callTool!("add", { title: "Buy groceries", tags: ["home"] });
    expect(add1).toMatchObject({ task: { id: "task_1", status: "open", title: "Buy groceries" } });

    const add2 = await connection.callTool!("add", { notes: "weekly", title: "Pay rent" });
    expect(add2).toMatchObject({ task: { id: "task_2", status: "open" } });

    const listOpen = await connection.callTool!("list", {});
    expect(listOpen).toMatchObject({ status: "open", total: 2 });

    const completed = await connection.callTool!("complete", { id: "task_1" });
    expect(completed).toMatchObject({ task: { id: "task_1", status: "done" } });
    expect((completed.task as { completedAt?: string }).completedAt).toBeDefined();

    const listOpenAfter = await connection.callTool!("list", {});
    expect(listOpenAfter).toMatchObject({ total: 1 });

    const listAll = await connection.callTool!("list", { status: "all" });
    expect(listAll).toMatchObject({ status: "all", total: 2 });

    const search = await connection.callTool!("search", { query: "rent", status: "open" });
    expect(search).toMatchObject({ total: 1, tasks: [{ id: "task_2" }] });

    const noMatches = await connection.callTool!("search", { query: "nonexistent" });
    expect(noMatches).toMatchObject({ total: 0 });
  });

  it("update is lost-update-safe — two concurrent updates to DIFFERENT fields both persist", async () => {
    const { mkdtempSync, readFileSync } = await import("node:fs");
    const tmpdir = await import("node:os").then((m) => m.tmpdir());
    const dir = mkdtempSync(`${tmpdir}/muse-tasks-rmw-`);
    const file = `${dir}/tasks.json`;
    let counter = 0;
    const connection = createLoopbackMcpConnection(createTasksMcpServer({ file, idFactory: () => `task_${(++counter).toString()}` }));
    await connection.callTool!("add", { title: "Plan trip" });
    // Two concurrent updates to DIFFERENT fields. Before the fix, each `update` built
    // its WHOLE stale snapshot outside the write queue and wrote it back, so the later
    // write reverted the other's change (last-writer-wins → lost update).
    await Promise.all([
      connection.callTool!("update", { id: "task_1", title: "Plan trip v2" }),
      connection.callTool!("update", { id: "task_1", notes: "book flights" })
    ]);
    const persisted = JSON.parse(readFileSync(file, "utf8")) as { tasks: { notes?: string; title: string }[] };
    expect(persisted.tasks[0]!.title).toBe("Plan trip v2"); // the title change survived
    expect(persisted.tasks[0]!.notes).toBe("book flights"); // AND the notes change (not clobbered)
  });

  it("delete REMOVES a task (by id or title word) — parity with `muse tasks delete`, distinct from complete", async () => {
    const { mkdtempSync } = await import("node:fs");
    const tmpdir = await import("node:os").then((m) => m.tmpdir());
    const dir = mkdtempSync(`${tmpdir}/muse-tasks-delete-`);
    let counter = 0;
    const idFactory = () => `task_${++counter}`;
    const connection = createLoopbackMcpConnection(createTasksMcpServer({ file: `${dir}/tasks.json`, idFactory }));

    await connection.callTool!("add", { title: "Buy milk" });
    await connection.callTool!("add", { title: "Renew passport" });

    // Delete BY A TITLE WORD (the dominant agent path — the model rarely knows the id).
    const removed = await connection.callTool!("delete", { id: "milk" });
    expect(removed).toMatchObject({ id: "task_1", removed: true });

    // It is GONE from every status view (not merely marked done — that's `complete`).
    const all = await connection.callTool!("list", { status: "all" }) as { tasks: { id: string }[]; total: number };
    expect(all.total).toBe(1);
    expect(all.tasks.map((t) => t.id)).toEqual(["task_2"]);

    // Guards: an ambiguous word returns candidates (never a blind delete); an unknown ref errors.
    await connection.callTool!("add", { title: "Call the dentist" });
    await connection.callTool!("add", { title: "Email the dentist about insurance" });
    const ambiguous = await connection.callTool!("delete", { id: "dentist" }) as { error?: string; candidates?: unknown[] };
    expect(ambiguous.error).toContain("multiple");
    expect((ambiguous.candidates ?? []).length).toBe(2);
    expect(await connection.callTool!("delete", { id: "task_404" })).toMatchObject({ error: expect.stringContaining("not found") });
    // The ambiguous + not-found attempts removed nothing.
    expect((await connection.callTool!("list", { status: "all" }) as { total: number }).total).toBe(3);
  });

  it("update reschedules / renames / toggles urgent on an existing task (parity with `muse tasks edit`)", async () => {
    const { mkdtempSync } = await import("node:fs");
    const tmpdir = await import("node:os").then((m) => m.tmpdir());
    const dir = mkdtempSync(`${tmpdir}/muse-tasks-update-`);
    let counter = 0;
    const idFactory = () => `task_${++counter}`;
    const connection = createLoopbackMcpConnection(createTasksMcpServer({ file: `${dir}/tasks.json`, idFactory }));

    await connection.callTool!("add", { title: "Dentist", dueAt: "2030-01-01T09:00:00Z", urgent: true });

    // Reschedule + rename + clear urgent in one call.
    const updated = await connection.callTool!("update", {
      id: "task_1", title: "Dentist (rescheduled)", dueAt: "2030-02-02T09:00:00Z", urgent: false
    });
    expect(updated).toMatchObject({ task: { id: "task_1", title: "Dentist (rescheduled)", dueAt: "2030-02-02T09:00:00.000Z" } });
    expect((updated.task as { urgent?: boolean }).urgent).toBeUndefined();

    // 'none' clears the due date; the change persists to the store.
    await connection.callTool!("update", { id: "task_1", dueAt: "none" });
    const all = await connection.callTool!("list", { status: "all" }) as { tasks: { id: string; dueAt?: string }[] };
    expect(all.tasks.find((t) => t.id === "task_1")?.dueAt).toBeUndefined();

    // Guards: unknown id, and no-fields-to-change.
    expect(await connection.callTool!("update", { id: "task_404", title: "x" })).toMatchObject({ error: expect.stringContaining("not found") });
    expect(await connection.callTool!("update", { id: "task_1" })).toMatchObject({ error: expect.stringContaining("at least one") });
  });

  it("add accepts urgent:true and round-trips it through list (CRUD parity with `muse tasks add --urgent`)", async () => {
    const { mkdtempSync } = await import("node:fs");
    const tmpdir = await import("node:os").then((m) => m.tmpdir());
    const dir = mkdtempSync(`${tmpdir}/muse-tasks-urgent-`);
    let counter = 0;
    const idFactory = () => `task_${++counter}`;
    const connection = createLoopbackMcpConnection(createTasksMcpServer({ file: `${dir}/tasks.json`, idFactory }));

    const urgent = await connection.callTool!("add", { title: "Pay rent today", urgent: true });
    expect(urgent).toMatchObject({ task: { id: "task_1", title: "Pay rent today", urgent: true } });

    // A normal add (urgent omitted) must NOT carry the flag.
    const normal = await connection.callTool!("add", { title: "Water the plants" });
    expect((normal.task as { urgent?: boolean }).urgent).toBeUndefined();

    // The flag survives the store round-trip into list output.
    const all = await connection.callTool!("list", { status: "all" }) as { tasks: { id: string; urgent?: boolean }[] };
    expect(all.tasks.find((t) => t.id === "task_1")?.urgent).toBe(true);
    expect(all.tasks.find((t) => t.id === "task_2")?.urgent).toBeUndefined();
  });

  it("list returns tasks due-soonest first so the agent prioritises correctly (goal 256)", async () => {
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const tmpdir = await import("node:os").then((m) => m.tmpdir());
    const dir = mkdtempSync(`${tmpdir}/muse-tasks-order-`);
    const file = `${dir}/tasks.json`;
    const soon = new Date(Date.now() + 2 * 3_600_000).toISOString();
    const far = new Date(Date.now() + 30 * 86_400_000).toISOString();
    // Imminent deadline created long ago vs a recent far-due task —
    // createdAt-desc buried t_soon; due-soonest must surface it.
    writeFileSync(file, JSON.stringify({
      tasks: [
        { id: "t_soon", title: "Ship", status: "open", dueAt: soon, createdAt: "2026-04-01T00:00:00Z" },
        { id: "t_far", title: "Review", status: "open", dueAt: far, createdAt: "2026-05-15T00:00:00Z" },
        { id: "t_new_undated", title: "Capture", status: "open", createdAt: "2026-05-16T09:00:00Z" },
        { id: "t_old_undated", title: "Stale", status: "open", createdAt: "2026-03-01T00:00:00Z" }
      ]
    }), "utf8");
    const connection = createLoopbackMcpConnection(createTasksMcpServer({ file }));
    const listed = await connection.callTool!("list", {}) as { tasks: Array<{ id: string }> };
    expect(listed.tasks.map((t) => t.id)).toEqual(["t_soon", "t_far", "t_new_undated", "t_old_undated"]);
  });

  it("returns errors for invalid input and missing ids", async () => {
    const { mkdtempSync } = await import("node:fs");
    const tmpdir = await import("node:os").then((m) => m.tmpdir());
    const dir = mkdtempSync(`${tmpdir}/muse-tasks-err-`);
    const connection = createLoopbackMcpConnection(createTasksMcpServer({ file: `${dir}/tasks.json` }));

    const noTitle = await connection.callTool!("add", {});
    expect(noTitle).toMatchObject({ error: expect.stringContaining("title is required") });

    const missing = await connection.callTool!("complete", { id: "task_does_not_exist" });
    expect(missing).toMatchObject({ error: expect.stringContaining("not found") });

    const emptyQuery = await connection.callTool!("search", { query: "  " });
    expect(emptyQuery).toMatchObject({ error: expect.stringContaining("query is required") });
  });

  it("treats a missing or corrupt file as empty", async () => {
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const tmpdir = await import("node:os").then((m) => m.tmpdir());
    const dir = mkdtempSync(`${tmpdir}/muse-tasks-corrupt-`);
    const file = `${dir}/tasks.json`;

    const connection = createLoopbackMcpConnection(createTasksMcpServer({ file }));
    const empty = await connection.callTool!("list", { status: "all" });
    expect(empty).toMatchObject({ total: 0 });

    writeFileSync(file, "not valid json");
    const recovered = await connection.callTool!("list", { status: "all" });
    expect(recovered).toMatchObject({ total: 0 });
  });

  it("quarantines a corrupt store instead of silently destroying it on next write (goal 189)", async () => {
    const { readTasks, writeTasks } = await import("../src/index.js");
    const { mkdtempSync, writeFileSync, readdirSync, readFileSync } = await import("node:fs");
    const tmpdir = await import("node:os").then((m) => m.tmpdir());
    const dir = mkdtempSync(`${tmpdir}/muse-tasks-quarantine-`);
    const file = `${dir}/tasks.json`;

    // Simulate a partial write / crash corruption of a real store.
    const original = `{"tasks":[{"id":"t_keep","title":"important","status":"open","createdAt":"2026-01-01T00:00:00Z"}]} TRAILING GARBAGE`;
    writeFileSync(file, original);

    // Read degrades to empty (list still works)...
    expect(await readTasks(file)).toEqual([]);

    // ...but the original bytes are preserved in a quarantine file.
    const quarantined = readdirSync(dir).filter((n) => n.startsWith("tasks.json.corrupt-"));
    expect(quarantined).toHaveLength(1);
    expect(readFileSync(`${dir}/${quarantined[0]!}`, "utf8")).toBe(original);

    // A subsequent write starts fresh (the live file is gone), so the
    // new task lands cleanly and the recoverable data is NOT clobbered.
    await writeTasks(file, [
      { id: "t_new", title: "new", status: "open", createdAt: "2026-05-16T00:00:00Z" }
    ]);
    const after = await readTasks(file);
    expect(after.map((t) => t.id)).toEqual(["t_new"]);
    // Quarantine still there for manual recovery.
    expect(readdirSync(dir).filter((n) => n.startsWith("tasks.json.corrupt-"))).toHaveLength(1);
  });

  it("accepts a dueAt ISO timestamp on add and surfaces it in list / search", async () => {
    const { mkdtempSync } = await import("node:fs");
    const tmpdir = await import("node:os").then((m) => m.tmpdir());
    const dir = mkdtempSync(`${tmpdir}/muse-tasks-due-`);
    let counter = 0;
    const idFactory = () => `task_${++counter}`;
    const server = createTasksMcpServer({ file: `${dir}/tasks.json`, idFactory });
    const connection = createLoopbackMcpConnection(server);

    const added = await connection.callTool!("add", {
      dueAt: "2026-05-15T18:00:00Z",
      title: "Buy milk"
    }) as { task: { dueAt?: string; id: string } };
    expect(added.task.dueAt).toBe("2026-05-15T18:00:00.000Z");

    const list = await connection.callTool!("list", {}) as {
      tasks: ReadonlyArray<{ dueAt?: string; id: string }>;
    };
    expect(list.tasks[0]?.dueAt).toBe("2026-05-15T18:00:00.000Z");

    const search = await connection.callTool!("search", { query: "milk" }) as {
      tasks: ReadonlyArray<{ dueAt?: string }>;
    };
    expect(search.tasks[0]?.dueAt).toBe("2026-05-15T18:00:00.000Z");
  });

  it("a time-only reschedule keeps the task's existing DATE (does not jump to today)", async () => {
    const { mkdtempSync } = await import("node:fs");
    const tmpdir = await import("node:os").then((m) => m.tmpdir());
    const dir = mkdtempSync(`${tmpdir}/muse-tasks-reschedule-`);
    let counter = 0;
    const connection = createLoopbackMcpConnection(createTasksMcpServer({
      file: `${dir}/tasks.json`,
      idFactory: () => `task_${++counter}`,
      now: () => new Date("2026-06-06T03:00:00.000Z") // "today" — deliberately far from the due day
    }));
    const seedIso = "2026-06-12T05:00:00.000Z"; // the original due day (a Friday)
    const added = await connection.callTool!("add", { dueAt: seedIso, title: "Submit report" }) as { task: { id: string } };

    // The bug: "오후 6시로 바꿔줘" resolved against `now`, moving the deadline to
    // today. A time-only phrase must keep the task's existing DATE.
    const updated = await connection.callTool!("update", { dueAt: "오후 6시", id: added.task.id }) as { task: { dueAt?: string } };
    const due = new Date(updated.task.dueAt!);
    expect(due.toDateString()).toBe(new Date(seedIso).toDateString()); // DATE preserved (TZ-independent)
    expect(due.getHours()).toBe(18); // 오후 6시 local

    // A date-bearing / ISO reschedule is honored exactly, not re-anchored.
    const moved = await connection.callTool!("update", { dueAt: "2026-06-20T01:00:00.000Z", id: added.task.id }) as { task: { dueAt?: string } };
    expect(moved.task.dueAt).toBe("2026-06-20T01:00:00.000Z");
  });

  it("a date-only reschedule ('2026-06-20', no time) keeps the task's TIME-of-day", async () => {
    // The dual bug: moving a 2pm deadline to another DAY reset it to midnight/9am.
    const { mkdtempSync } = await import("node:fs");
    const tmpdir = await import("node:os").then((m) => m.tmpdir());
    const dir = mkdtempSync(`${tmpdir}/muse-tasks-dateonly-`);
    let counter = 0;
    const connection = createLoopbackMcpConnection(createTasksMcpServer({
      file: `${dir}/tasks.json`,
      idFactory: () => `task_${++counter}`,
      now: () => new Date("2026-06-06T03:00:00.000Z")
    }));
    const seedIso = "2026-06-12T05:00:00.000Z"; // Friday, a non-midnight time
    const added = await connection.callTool!("add", { dueAt: seedIso, title: "Submit report" }) as { task: { id: string } };

    const moved = await connection.callTool!("update", { dueAt: "2026-06-20", id: added.task.id }) as { task: { dueAt?: string } };
    const due = new Date(moved.task.dueAt!);
    expect(due.getHours()).toBe(new Date(seedIso).getHours()); // TIME-of-day preserved (TZ-safe)
    expect(due.getMinutes()).toBe(new Date(seedIso).getMinutes());
    expect(due.toDateString()).not.toBe(new Date(seedIso).toDateString()); // moved to a different day
    expect(due.getTime()).toBeGreaterThan(new Date(seedIso).getTime());
  });

  it("rejects an invalid dueAt with a clear error", async () => {
    const { mkdtempSync } = await import("node:fs");
    const tmpdir = await import("node:os").then((m) => m.tmpdir());
    const dir = mkdtempSync(`${tmpdir}/muse-tasks-due-bad-`);
    const connection = createLoopbackMcpConnection(createTasksMcpServer({ file: `${dir}/tasks.json` }));

    const result = await connection.callTool!("add", {
      dueAt: "not a date",
      title: "Test"
    }) as { error?: string };
    expect(result.error).toContain("dueAt must be an ISO-8601 timestamp or a supported relative phrase");
    // Actionable: shows accepted EN + KO grammar so the user can
    // self-correct without reading docs (goal 186).
    expect(result.error).toContain("tomorrow 9am");
    expect(result.error).toContain("내일 오후 3시");
    expect(result.error).toContain("다음 주 월요일");
    // The refreshed examples must surface the now-rich grammar.
    expect(result.error).toContain("in half an hour");
    expect(result.error).toContain("day after tomorrow");
    expect(result.error).toContain("May 20");
    // Invariant: EVERY quoted example after "Examples:" must
    // actually resolve — the error message is a user contract and
    // must never advertise a phrasing the grammar can't parse.
    const { resolveRelativeTimePhrase } = await import("@muse/mcp-shared");
    const examplesPart = (result.error ?? "").split("Examples:")[1] ?? "";
    const examples = [...examplesPart.matchAll(/"([^"]+)"/gu)].map((m) => m[1]!);
    expect(examples.length).toBeGreaterThanOrEqual(10);
    const now = (): Date => new Date("2026-05-18T09:00:00Z");
    for (const phrase of examples) {
      expect(resolveRelativeTimePhrase(phrase, now), `example "${phrase}" must parse`).toBeDefined();
    }
  });

  it("ignores dueAt when omitted (back-compat with pre-dueAt entries)", async () => {
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const tmpdir = await import("node:os").then((m) => m.tmpdir());
    const dir = mkdtempSync(`${tmpdir}/muse-tasks-due-back-`);
    const file = `${dir}/tasks.json`;
    writeFileSync(file, JSON.stringify({
      tasks: [
        { createdAt: "2026-05-01T00:00:00Z", id: "old-1", status: "open", title: "Legacy task" }
      ]
    }), "utf8");
    const connection = createLoopbackMcpConnection(createTasksMcpServer({ file }));
    const list = await connection.callTool!("list", { status: "all" }) as {
      tasks: ReadonlyArray<{ dueAt?: string; id: string }>;
    };
    expect(list.tasks[0]).toMatchObject({ id: "old-1" });
    expect(list.tasks[0]?.dueAt).toBeUndefined();
  });

  it("resolves relative dueAt phrases server-side ('in 3 hours', 'tomorrow at 6pm', 'next Monday')", async () => {
    const { mkdtempSync } = await import("node:fs");
    const tmpdir = await import("node:os").then((m) => m.tmpdir());
    const dir = mkdtempSync(`${tmpdir}/muse-tasks-rel-`);
    let counter = 0;
    const fixedNow = new Date("2026-05-10T12:00:00Z");
    const server = createTasksMcpServer({
      file: `${dir}/tasks.json`,
      idFactory: () => `task_${++counter}`,
      now: () => fixedNow
    });
    const connection = createLoopbackMcpConnection(server);

    const inHours = await connection.callTool!("add", {
      dueAt: "in 3 hours",
      title: "Stand-up follow-up"
    }) as { task: { dueAt?: string } };
    expect(inHours.task.dueAt).toBe("2026-05-10T15:00:00.000Z");

    const tomorrowEvening = await connection.callTool!("add", {
      dueAt: "tomorrow at 6pm",
      title: "Call mom"
    }) as { task: { dueAt?: string } };
    // 09:00 default replaced with 18:00; date wall-clock is local; ISO normalises.
    expect(tomorrowEvening.task.dueAt).toMatch(/^2026-05-1[12]T/u);

    const nextMonday = await connection.callTool!("add", {
      dueAt: "next monday",
      title: "File expenses"
    }) as { task: { dueAt?: string } };
    // 2026-05-10 is a Sunday → next Monday is 2026-05-11 wall-clock.
    expect(nextMonday.task.dueAt).toMatch(/^2026-05-1[12]T/u);
  });

  describe("resolveRelativeTimePhrase", () => {
    it("resolves 'this <weekday>' like 'next <weekday>' (the model emits 'this friday')", async () => {
      const { resolveRelativeTimePhrase } = await import("@muse/mcp-shared");
      const now = () => new Date("2026-05-25T12:00:00+09:00"); // a Monday
      // "this friday at 3pm" was mis-parsed ("this" as a weekday) → undefined,
      // so the model's natural calendar prompt failed at calendar.add.
      const thisFri = resolveRelativeTimePhrase("this friday at 3pm", now);
      const nextFri = resolveRelativeTimePhrase("next friday at 3pm", now);
      expect(thisFri).toBeInstanceOf(Date);
      expect(thisFri?.toISOString()).toBe(nextFri?.toISOString());
      expect(resolveRelativeTimePhrase("this friday", now)).toBeInstanceOf(Date);
    });

    it("parses 'in N <unit>' offsets", async () => {
      const { resolveRelativeTimePhrase } = await import("@muse/mcp-shared");
      const fixed = new Date("2026-05-10T12:00:00Z");
      const now = () => fixed;
      expect(resolveRelativeTimePhrase("in 30 seconds", now)?.toISOString())
        .toBe("2026-05-10T12:00:30.000Z");
      expect(resolveRelativeTimePhrase("in 1 second", now)?.toISOString())
        .toBe("2026-05-10T12:00:01.000Z");
      expect(resolveRelativeTimePhrase("in a second", now)?.toISOString())
        .toBe("2026-05-10T12:00:01.000Z");
      expect(resolveRelativeTimePhrase("in 30 minutes", now)?.toISOString())
        .toBe("2026-05-10T12:30:00.000Z");
      expect(resolveRelativeTimePhrase("in 3 hours", now)?.toISOString())
        .toBe("2026-05-10T15:00:00.000Z");
      expect(resolveRelativeTimePhrase("in 2 days", now)?.toISOString())
        .toBe("2026-05-12T12:00:00.000Z");
      expect(resolveRelativeTimePhrase("in 1 week", now)?.toISOString())
        .toBe("2026-05-17T12:00:00.000Z");
    });

    it("parses compact unit-suffix offsets ('in 1h', 'in 30m', 'in 5 hrs')", async () => {
      const { resolveRelativeTimePhrase } = await import("@muse/mcp-shared");
      const now = () => new Date("2026-05-10T12:00:00Z");
      expect(resolveRelativeTimePhrase("in 1h", now)?.toISOString())
        .toBe("2026-05-10T13:00:00.000Z");
      expect(resolveRelativeTimePhrase("in 30m", now)?.toISOString())
        .toBe("2026-05-10T12:30:00.000Z");
      expect(resolveRelativeTimePhrase("in 2d", now)?.toISOString())
        .toBe("2026-05-12T12:00:00.000Z");
      expect(resolveRelativeTimePhrase("in 15s", now)?.toISOString())
        .toBe("2026-05-10T12:00:15.000Z");
      expect(resolveRelativeTimePhrase("in 1w", now)?.toISOString())
        .toBe("2026-05-17T12:00:00.000Z");
      expect(resolveRelativeTimePhrase("in 3 hr", now)?.toISOString())
        .toBe("2026-05-10T15:00:00.000Z");
      expect(resolveRelativeTimePhrase("in 5 hrs", now)?.toISOString())
        .toBe("2026-05-10T17:00:00.000Z");
      expect(resolveRelativeTimePhrase("in 10 mins", now)?.toISOString())
        .toBe("2026-05-10T12:10:00.000Z");
      expect(resolveRelativeTimePhrase("in 1 h", now)?.toISOString())
        .toBe("2026-05-10T13:00:00.000Z");
      expect(resolveRelativeTimePhrase("in 5 sec", now)?.toISOString())
        .toBe("2026-05-10T12:00:05.000Z");
      // `mo` is NOT a recognised abbrev (collides with `m`=minute);
      // the full-word month handler is unaffected (no regression).
      expect(resolveRelativeTimePhrase("in 5mo", now)).toBeUndefined();
      expect(resolveRelativeTimePhrase("in 2 months", now)?.toISOString())
        .toBe("2026-07-10T12:00:00.000Z");
      // "in" is OPTIONAL — a bare compact duration parses as that offset from
      // now; an unknown unit stays unrecognised (no false positive).
      expect(resolveRelativeTimePhrase("1h", now)?.toISOString()).toBe("2026-05-10T13:00:00.000Z");
      expect(resolveRelativeTimePhrase("in 3 horses", now)).toBeUndefined();
    });

    it("treats the indefinite article 'a'/'an' as quantity 1", async () => {
      const { resolveRelativeTimePhrase } = await import("@muse/mcp-shared");
      const now = () => new Date("2026-05-10T12:00:00Z");
      expect(resolveRelativeTimePhrase("in a minute", now)?.toISOString())
        .toBe("2026-05-10T12:01:00.000Z");
      expect(resolveRelativeTimePhrase("in an hour", now)?.toISOString())
        .toBe("2026-05-10T13:00:00.000Z");
      expect(resolveRelativeTimePhrase("in a day", now)?.toISOString())
        .toBe("2026-05-11T12:00:00.000Z");
      expect(resolveRelativeTimePhrase("in a week", now)?.toISOString())
        .toBe("2026-05-17T12:00:00.000Z");
      // Calendar-month semantics still apply for the article form.
      expect(resolveRelativeTimePhrase("in a month", now)?.toISOString())
        .toBe("2026-06-10T12:00:00.000Z");
      // The numeric form is unchanged (no regression).
      expect(resolveRelativeTimePhrase("in 2 hours", now)?.toISOString())
        .toBe("2026-05-10T14:00:00.000Z");
      // A vague quantifier is still correctly unrecognized.
      expect(resolveRelativeTimePhrase("in a few minutes", now)).toBeUndefined();
    });

    it("resolves precise fractional / compound durations (half / quarter / and-a-half)", async () => {
      const { resolveRelativeTimePhrase } = await import("@muse/mcp-shared");
      const base = new Date("2026-05-18T09:00:00.000Z");
      const now = () => base;
      const mins = (p: string): number | undefined => {
        const d = resolveRelativeTimePhrase(p, now);
        return d ? (d.getTime() - base.getTime()) / 60_000 : undefined;
      };

      expect(mins("in half an hour")).toBe(30);
      expect(mins("in half a minute")).toBe(0.5);
      expect(mins("in half a day")).toBe(720);
      expect(mins("in half a week")).toBe(5040);
      expect(mins("in a quarter of an hour")).toBe(15);
      expect(mins("in quarter of an hour")).toBe(15);
      expect(mins("in three quarters of an hour")).toBe(45);
      expect(mins("in an hour and a half")).toBe(90);
      expect(mins("in a day and a half")).toBe(2160);
      expect(mins("in 2 hours and a half")).toBe(150);
      // No regression: plain + article forms unchanged; vague stays undefined.
      expect(mins("in 3 hours")).toBe(180);
      expect(mins("in an hour")).toBe(60);
      expect(resolveRelativeTimePhrase("in a few minutes", now)).toBeUndefined();
      expect(resolveRelativeTimePhrase("in a couple of hours", now)).toBeUndefined();
    });

    it("resolves decimal-notation durations ('in 1.5 hours', 'in 2.5 days')", async () => {
      const { resolveRelativeTimePhrase } = await import("@muse/mcp-shared");
      const base = new Date("2026-05-18T09:00:00.000Z");
      const now = () => base;
      const mins = (p: string): number | undefined => {
        const d = resolveRelativeTimePhrase(p, now);
        return d ? (d.getTime() - base.getTime()) / 60_000 : undefined;
      };

      expect(mins("in 1.5 hours")).toBe(90);
      expect(mins("in 0.5 hours")).toBe(30);
      expect(mins("in 0.25 hours")).toBe(15);
      expect(mins("in 2.5 days")).toBe(3600);
      expect(mins("in 1.5 minutes")).toBe(1.5);
      expect(mins("in 1.5 weeks")).toBe(15120);
      expect(mins("in 1.5 hour")).toBe(90); // singular unit still valid
      // Sub-millisecond exactness preserved (Math.round keeps it integer ms).
      expect(resolveRelativeTimePhrase("in 0.5 seconds", now)?.toISOString())
        .toBe("2026-05-18T09:00:00.500Z");

      // No regression: integer / word-fraction / compact paths untouched.
      expect(mins("in 2 hours")).toBe(120);
      expect(mins("in half an hour")).toBe(30);
      expect(mins("in 90 mins")).toBe(90);

      // Correctly rejected: fractional calendar months are ill-defined
      // (month is excluded here exactly as in the word-fraction
      // resolvers); a missing leading or trailing digit is not a
      // decimal; unknown units fail.
      for (const bad of ["in 1.5 months", "in .5 hours", "in 1. hours", "in 1.5 fortnights"]) {
        expect(resolveRelativeTimePhrase(bad, now)).toBeUndefined();
      }
    });

    it("resolves two-unit compound durations ('in 2 hours 30 minutes')", async () => {
      const { resolveRelativeTimePhrase } = await import("@muse/mcp-shared");
      const base = new Date("2026-05-18T09:00:00.000Z");
      const now = () => base;
      const mins = (p: string): number | undefined => {
        const d = resolveRelativeTimePhrase(p, now);
        return d ? (d.getTime() - base.getTime()) / 60_000 : undefined;
      };

      expect(mins("in 2 hours 30 minutes")).toBe(150);
      expect(mins("in 1 hour 15 minutes")).toBe(75);
      expect(mins("in 2 hours and 30 minutes")).toBe(150); // optional "and"
      expect(mins("in 1 day 6 hours")).toBe(30 * 60);
      expect(mins("in 1 week 2 days")).toBe(9 * 24 * 60);
      expect(mins("in 0 hours 45 minutes")).toBe(45);

      // No regression: integer / decimal / word-fraction / compact
      // / and-a-half paths untouched.
      expect(mins("in 2 hours")).toBe(120);
      expect(mins("in 1.5 hours")).toBe(90);
      expect(mins("in half an hour")).toBe(30);
      expect(mins("in 2 hours and a half")).toBe(150);
      expect(mins("in 90 mins")).toBe(90);

      // Correctly rejected: month is not a flat-ms unit (excluded
      // like every fractional sibling); three+ pairs are a distinct
      // grammar, not this bounded two-unit slice.
      for (const bad of ["in 1 month 2 days", "in 2 hours 30 minutes 10 seconds"]) {
        expect(resolveRelativeTimePhrase(bad, now)).toBeUndefined();
      }
    });

    it("parses 'in N month(s)' with calendar-month math (goal 110)", async () => {
      const { resolveRelativeTimePhrase } = await import("@muse/mcp-shared");
      const fixed = new Date("2026-05-10T12:00:00Z");
      const now = () => fixed;

      // Singular + plural both work.
      const oneMonth = resolveRelativeTimePhrase("in 1 month", now);
      expect(oneMonth?.getUTCMonth()).toBe(5);          // June (0-indexed)
      expect(oneMonth?.getUTCDate()).toBe(10);
      expect(oneMonth?.getUTCHours()).toBe(12);

      const threeMonths = resolveRelativeTimePhrase("in 3 months", now);
      expect(threeMonths?.getUTCMonth()).toBe(7);       // August
      expect(threeMonths?.getUTCDate()).toBe(10);

      // Crossing the year boundary is fine.
      const twelve = resolveRelativeTimePhrase("in 12 months", now);
      expect(twelve?.getUTCFullYear()).toBe(2027);
      expect(twelve?.getUTCMonth()).toBe(4);            // back to May
    });

    it("clamps month-end overflow instead of rolling into a later month", async () => {
      const { resolveRelativeTimePhrase } = await import("@muse/mcp-shared");
      const { parseTaskDueAt } = await import("@muse/stores");
      const jan31 = () => new Date("2026-01-31T12:00:00Z");

      // "in 1 month" from Jan 31 → Feb 28 (2026 non-leap), NOT
      // Mar 3 (raw Date.setMonth overflow).
      const en = resolveRelativeTimePhrase("in 1 month", jan31);
      expect(en?.getUTCMonth()).toBe(1);
      expect(en?.getUTCDate()).toBe(28);

      // The Korean native-language path has the same guarantee.
      const ko = resolveRelativeTimePhrase("1개월 후", jan31);
      expect(ko?.getUTCMonth()).toBe(1);
      expect(ko?.getUTCDate()).toBe(28);

      // Mar 31 + 1mo → Apr 30 (April has 30 days).
      const apr = resolveRelativeTimePhrase("in 1 month", () => new Date("2026-03-31T09:00:00Z"));
      expect(apr?.getUTCMonth()).toBe(3);
      expect(apr?.getUTCDate()).toBe(30);

      // A non-overflow day is untouched: Jan 15 + 1mo → Feb 15.
      const mid = resolveRelativeTimePhrase("in 1 month", () => new Date("2026-01-15T12:00:00Z"));
      expect(mid?.getUTCMonth()).toBe(1);
      expect(mid?.getUTCDate()).toBe(15);

      // End-to-end through parseTaskDueAt: valid ISO, no RangeError.
      const iso = parseTaskDueAt("in 1 month", jan31);
      expect(typeof iso).toBe("string");
      expect(String(iso).startsWith("2026-02-28")).toBe(true);
    });

    it("returns undefined (not an Invalid Date) for out-of-range offsets", async () => {
      const { resolveRelativeTimePhrase } = await import("@muse/mcp-shared");
      const { parseTaskDueAt } = await import("@muse/stores");
      const now = () => new Date("2026-05-10T12:00:00Z");
      for (const phrase of [
        "in 9999999999 days",
        "in 99999999999 weeks",
        "in 999999999 months",
        "99999999999일 후",
        "9999999999개월 후"
      ]) {
        expect(resolveRelativeTimePhrase(phrase, now)).toBeUndefined();
        // The caller must surface the actionable grammar error,
        // never throw a RangeError from `.toISOString()`.
        const result = parseTaskDueAt(phrase, now);
        expect(result).toBeInstanceOf(Error);
      }
    });

    it("resolves the 'N <unit> from now/today' phrasing the same as 'in N <unit>'", async () => {
      const { parseTaskDueAt } = await import("@muse/stores");
      const now = () => new Date("2026-06-07T12:00:00Z");
      // The spoken form must land on the same date the "in N" form already did.
      expect(parseTaskDueAt("100 days from now", now)).toBe(parseTaskDueAt("in 100 days", now));
      expect(parseTaskDueAt("45 days from today", now)).toBe(parseTaskDueAt("in 45 days", now));
      expect(parseTaskDueAt("2 weeks from now", now)).toBe(parseTaskDueAt("in 2 weeks", now));
      // 100 days after 2026-06-07 is 2026-09-15 (the 8B answered "June 10").
      expect(parseTaskDueAt("100 days from now", now)).toMatch(/^2026-09-15/u);
    });

    it("resolves a small spelled-out number before a time unit ('in two weeks', 'three days from now')", async () => {
      const { parseTaskDueAt } = await import("@muse/stores");
      const now = () => new Date("2026-06-07T12:00:00Z");
      expect(parseTaskDueAt("in two weeks", now)).toBe(parseTaskDueAt("in 2 weeks", now));
      expect(parseTaskDueAt("two weeks from today", now)).toBe(parseTaskDueAt("in 2 weeks", now));
      expect(parseTaskDueAt("three days from now", now)).toMatch(/^2026-06-10/u);
      // A spelled number NOT before a time unit is left alone (still unparseable prose).
      expect(parseTaskDueAt("call three people", now)).toBeInstanceOf(Error);
    });

    it("resolves the filler 'coming' in a weekday phrase ('this coming Monday')", async () => {
      const { parseTaskDueAt } = await import("@muse/stores");
      const now = () => new Date("2026-06-07T12:00:00Z"); // a Sunday
      expect(parseTaskDueAt("this coming Monday", now)).toBe(parseTaskDueAt("this Monday", now));
      expect(parseTaskDueAt("coming Monday", now)).toBe(parseTaskDueAt("Monday", now));
      expect(parseTaskDueAt("this coming Monday", now)).toMatch(/^2026-06-08/u);
    });

    it("resolves a Korean absolute date ('2026년 8월 15일' / '8월 15일'), with or without a time", async () => {
      const { parseTaskDueAt } = await import("@muse/stores");
      const now = () => new Date("2026-06-07T12:00:00Z");
      // Full Korean date → that exact ISO day (2026-08-15 is a Saturday).
      expect(parseTaskDueAt("2026년 8월 15일", now)).toMatch(/^2026-08-15/u);
      // Year-less Korean month-day → its NEXT occurrence (Aug 15 is still ahead of Jun 7).
      expect(parseTaskDueAt("8월 15일", now)).toMatch(/^2026-08-15/u);
      expect(parseTaskDueAt("12월 25일", now)).toMatch(/^2026-12-25/u);
      // Korean absolute date PLUS a Korean time — the LOCAL clock is asserted
      // (TZ-agnostic: setHours is local), so "오후 3시" is 15:00 wherever it runs.
      const withTime = new Date(parseTaskDueAt("8월 15일 오후 3시", now) as string);
      expect([withTime.getMonth(), withTime.getDate(), withTime.getHours()]).toEqual([7, 15, 15]);
      const withYear = new Date(parseTaskDueAt("2026년 8월 20일 오전 9시", now) as string);
      expect([withYear.getFullYear(), withYear.getMonth(), withYear.getDate(), withYear.getHours()]).toEqual([2026, 7, 20, 9]);
      // An impossible calendar day is rejected, not rolled over.
      expect(parseTaskDueAt("2월 30일", now)).toBeInstanceOf(Error);
    });

    it("rejects impossible calendar dates instead of silently rolling them over", async () => {
      const { parseTaskDueAt } = await import("@muse/stores");
      const { parseReminderDueAt } = await import("@muse/stores");
      const now = () => new Date("2026-05-19T12:00:00Z");

      // `new Date("2026-02-30")` rolls to Mar 2 — accepting it would
      // schedule the reminder/task on the wrong day. These must error
      // exactly like the already-rejected "2026-13-45", not roll.
      for (const bad of [
        "2026-02-30",
        "2026-02-29", // 2026 is not a leap year
        "2026-04-31",
        "2026-06-31",
        "2026-09-31",
        "2026-11-31",
        "2026-00-10",
        "2026-13-01",
        // The impossible date carried on a FULL ISO datetime — the shape the
        // chat model actually emits for a reminder. The date-only forms above
        // can't catch a "full datetimes are valid, skip the day-check" shortcut;
        // these do (Date silently rolls "2026-02-30T..." to Mar 2 ~2 days off).
        "2026-02-30T09:00:00Z",
        "2026-04-31T23:59:59Z"
      ]) {
        expect(parseTaskDueAt(bad, now)).toBeInstanceOf(Error);
        expect(parseReminderDueAt(bad, now)).toBeInstanceOf(Error);
      }

      // No regression: real dates, a genuine leap day, a full ISO
      // datetime, and relative phrases all still resolve.
      expect(String(parseTaskDueAt("2026-05-20", now))).toMatch(/^2026-05-20T/u);
      expect(String(parseTaskDueAt("2026-12-31", now))).toMatch(/^2026-12-31T/u);
      expect(String(parseTaskDueAt("2028-02-29", now))).toMatch(/^2028-02-29T/u); // 2028 is a leap year
      expect(parseTaskDueAt("2026-05-20T15:30:00Z", now)).toBe("2026-05-20T15:30:00.000Z");
      expect(typeof parseTaskDueAt("in 30 minutes", now)).toBe("string");
    });

    it("supports time-of-day suffixes (am/pm/HH:MM/noon/midnight)", async () => {
      const { resolveRelativeTimePhrase } = await import("@muse/mcp-shared");
      const tomorrow6pm = resolveRelativeTimePhrase("tomorrow at 6pm", () => new Date("2026-05-10T12:00:00Z"));
      expect(tomorrow6pm?.getHours()).toBe(18);
      expect(tomorrow6pm?.getMinutes()).toBe(0);

      const tomorrow1430 = resolveRelativeTimePhrase("tomorrow at 14:30", () => new Date("2026-05-10T12:00:00Z"));
      expect(tomorrow1430?.getHours()).toBe(14);
      expect(tomorrow1430?.getMinutes()).toBe(30);

      const todayNoon = resolveRelativeTimePhrase("today at noon", () => new Date("2026-05-10T08:00:00Z"));
      expect(todayNoon?.getHours()).toBe(12);

      const tomorrowMidnight = resolveRelativeTimePhrase("tomorrow at midnight", () => new Date("2026-05-10T12:00:00Z"));
      expect(tomorrowMidnight?.getHours()).toBe(0);
    });

    it("accepts the time without the 'at' keyword (goal 159)", async () => {
      const { resolveRelativeTimePhrase } = await import("@muse/mcp-shared");
      const ref = () => new Date("2026-05-10T12:00:00Z"); // Sunday

      const tomorrow9am = resolveRelativeTimePhrase("tomorrow 9am", ref);
      expect(tomorrow9am?.getHours()).toBe(9);
      expect(tomorrow9am?.getMinutes()).toBe(0);

      const today6pm = resolveRelativeTimePhrase("today 6pm", ref);
      expect(today6pm?.getHours()).toBe(18);

      const tomorrow1430 = resolveRelativeTimePhrase("tomorrow 14:30", ref);
      expect(tomorrow1430?.getHours()).toBe(14);
      expect(tomorrow1430?.getMinutes()).toBe(30);

      const nextMon6pm = resolveRelativeTimePhrase("next monday 6pm", ref);
      expect(nextMon6pm?.getDay()).toBe(1);
      expect(nextMon6pm?.getHours()).toBe(18);

      const todayNoon = resolveRelativeTimePhrase("today noon", ref);
      expect(todayNoon?.getHours()).toBe(12);

      // The 'at' form still works unchanged.
      const stillAt = resolveRelativeTimePhrase("tomorrow at 9am", ref);
      expect(stillAt?.getHours()).toBe(9);

      // Bare day phrase (no time) still defaults to 09:00.
      const bareTomorrow = resolveRelativeTimePhrase("tomorrow", ref);
      expect(bareTomorrow?.getHours()).toBe(9);
    });

    it("accepts a bare hour as a 24h time, symmetric with Korean 시 and HH:MM", async () => {
      const { resolveRelativeTimePhrase } = await import("@muse/mcp-shared");
      const ref = () => new Date("2026-05-10T12:00:00Z"); // Sunday

      const at3 = resolveRelativeTimePhrase("tomorrow at 3", ref);
      expect(at3?.getHours()).toBe(3);
      expect(at3?.getMinutes()).toBe(0);

      const at15 = resolveRelativeTimePhrase("tomorrow at 15", ref);
      expect(at15?.getHours()).toBe(15);

      // 'at'-less form and weekday head both work.
      const today9 = resolveRelativeTimePhrase("today 9", ref);
      expect(today9?.getHours()).toBe(9);
      const mon7 = resolveRelativeTimePhrase("next monday 7", ref);
      expect(mon7?.getDay()).toBe(1);
      expect(mon7?.getHours()).toBe(7);

      // Hour 0 = midnight; out-of-range hour stays unrecognized.
      expect(resolveRelativeTimePhrase("tomorrow at 0", ref)?.getHours()).toBe(0);
      expect(resolveRelativeTimePhrase("tomorrow at 24", ref)).toBeUndefined();

      // pm/HH:MM forms still take precedence (no regression).
      expect(resolveRelativeTimePhrase("tomorrow at 3pm", ref)?.getHours()).toBe(15);
    });

    it("resolves named day-parts (morning/afternoon/evening/night)", async () => {
      const { resolveRelativeTimePhrase } = await import("@muse/mcp-shared");
      const ref = () => new Date("2026-05-10T12:00:00Z"); // Sunday

      const morn = resolveRelativeTimePhrase("tomorrow morning", ref);
      expect(morn?.getDate()).toBe(11);
      expect(morn?.getHours()).toBe(9);
      expect(morn?.getMinutes()).toBe(0);

      expect(resolveRelativeTimePhrase("tomorrow afternoon", ref)?.getHours()).toBe(15);
      expect(resolveRelativeTimePhrase("today evening", ref)?.getHours()).toBe(18);
      expect(resolveRelativeTimePhrase("tomorrow night", ref)?.getHours()).toBe(21);

      // Weekday head + day-part, and the explicit 'at' form.
      const monEve = resolveRelativeTimePhrase("next monday evening", ref);
      expect(monEve?.getDay()).toBe(1);
      expect(monEve?.getHours()).toBe(18);
      expect(resolveRelativeTimePhrase("tomorrow at morning", ref)?.getHours()).toBe(9);

      // noon/midnight still resolve via their dedicated branches.
      expect(resolveRelativeTimePhrase("tomorrow noon", ref)?.getHours()).toBe(12);
      expect(resolveRelativeTimePhrase("tomorrow midnight", ref)?.getHours()).toBe(0);

      // An unknown word is still correctly unrecognized.
      expect(resolveRelativeTimePhrase("tomorrow lunchtime", ref)).toBeUndefined();
    });

    it("resolves a standalone day-part as today at that hour", async () => {
      const { resolveRelativeTimePhrase } = await import("@muse/mcp-shared");
      const ref = () => new Date("2026-05-18T09:00:00Z"); // Monday

      const tonight = resolveRelativeTimePhrase("tonight", ref);
      expect(tonight?.getDate()).toBe(18);
      expect(tonight?.getHours()).toBe(21);
      expect(tonight?.getMinutes()).toBe(0);

      expect(resolveRelativeTimePhrase("this evening", ref)?.getHours()).toBe(18);
      expect(resolveRelativeTimePhrase("this afternoon", ref)?.getHours()).toBe(15);
      expect(resolveRelativeTimePhrase("this morning", ref)?.getHours()).toBe(9);
      expect(resolveRelativeTimePhrase("evening", ref)?.getHours()).toBe(18);

      // Same-day (today), not tomorrow.
      expect(resolveRelativeTimePhrase("this evening", ref)?.getDate()).toBe(18);
      // Day-headed forms are unaffected (still go through dayPattern).
      expect(resolveRelativeTimePhrase("tomorrow evening", ref)?.getDate()).toBe(19);
      expect(resolveRelativeTimePhrase("tomorrow evening", ref)?.getHours()).toBe(18);
      // A non-day-part word is still unrecognized.
      expect(resolveRelativeTimePhrase("this lunchtime", ref)).toBeUndefined();
    });

    it("resolves a bare time (no day word) as today at that time", async () => {
      const { resolveRelativeTimePhrase } = await import("@muse/mcp-shared");
      const ref = () => new Date("2026-05-18T09:00:00Z"); // Monday

      const at5 = resolveRelativeTimePhrase("at 5pm", ref);
      expect(at5?.getDate()).toBe(18);
      expect(at5?.getHours()).toBe(17);
      expect(at5?.getMinutes()).toBe(0);

      expect(resolveRelativeTimePhrase("5pm", ref)?.getHours()).toBe(17);
      expect(resolveRelativeTimePhrase("at 17:30", ref)?.getHours()).toBe(17);
      expect(resolveRelativeTimePhrase("at 17:30", ref)?.getMinutes()).toBe(30);
      expect(resolveRelativeTimePhrase("noon", ref)?.getHours()).toBe(12);
      expect(resolveRelativeTimePhrase("at midnight", ref)?.getHours()).toBe(0);
      // All resolve to TODAY (the reference date), not tomorrow.
      expect(resolveRelativeTimePhrase("5pm", ref)?.getDate()).toBe(18);

      // Day-headed forms are unaffected (still go via dayPattern).
      expect(resolveRelativeTimePhrase("tomorrow at 5pm", ref)?.getDate()).toBe(19);
      expect(resolveRelativeTimePhrase("tomorrow at 5pm", ref)?.getHours()).toBe(17);
      // A non-time word is still unrecognized.
      expect(resolveRelativeTimePhrase("at lunch", ref)).toBeUndefined();
    });

    it("resolves an absolute month-name date (with next-occurrence + impossible-date rejection)", async () => {
      const { resolveRelativeTimePhrase } = await import("@muse/mcp-shared");
      const ref = () => new Date("2026-05-18T12:00:00Z"); // Monday

      const may20 = resolveRelativeTimePhrase("May 20", ref);
      expect(may20?.getFullYear()).toBe(2026);
      expect(may20?.getMonth()).toBe(4); // May
      expect(may20?.getDate()).toBe(20);
      expect(may20?.getHours()).toBe(9); // bare-day default

      expect(resolveRelativeTimePhrase("dec 25", ref)?.getMonth()).toBe(11);
      // Day-first form.
      expect(resolveRelativeTimePhrase("20 may", ref)?.getDate()).toBe(20);
      // Trailing time-of-day is parsed.
      const dec25pm = resolveRelativeTimePhrase("December 25 at 3pm", ref);
      expect(dec25pm?.getMonth()).toBe(11);
      expect(dec25pm?.getHours()).toBe(15);
      // Explicit year is honoured.
      expect(resolveRelativeTimePhrase("May 20 2027", ref)?.getFullYear()).toBe(2027);
      // Already-past this year → next occurrence (weekday convention).
      const may15 = resolveRelativeTimePhrase("May 15", ref); // today is May 18
      expect(may15?.getFullYear()).toBe(2027);
      expect(may15?.getMonth()).toBe(4);
      // Impossible / malformed → undefined (not silently defaulted).
      expect(resolveRelativeTimePhrase("Feb 30", ref)).toBeUndefined();
      expect(resolveRelativeTimePhrase("Apr 31", ref)).toBeUndefined();
      expect(resolveRelativeTimePhrase("May 20 garbage", ref)).toBeUndefined();
      // No regression: weekday / today still go through dayPattern.
      expect(resolveRelativeTimePhrase("monday", ref)?.getDay()).toBe(1);
      expect(resolveRelativeTimePhrase("tomorrow", ref)?.getDate()).toBe(19);
    });

    it("resolves 'day after tomorrow' (+2 days, English counterpart of 모레)", async () => {
      const { resolveRelativeTimePhrase } = await import("@muse/mcp-shared");
      const ref = () => new Date("2026-05-18T12:00:00Z"); // Monday May 18

      const dat = resolveRelativeTimePhrase("day after tomorrow", ref);
      expect(dat?.getDate()).toBe(20);
      expect(dat?.getHours()).toBe(9); // bare-day default
      expect(dat?.getMinutes()).toBe(0);

      expect(resolveRelativeTimePhrase("the day after tomorrow", ref)?.getDate()).toBe(20);
      const atThree = resolveRelativeTimePhrase("day after tomorrow at 3pm", ref);
      expect(atThree?.getDate()).toBe(20);
      expect(atThree?.getHours()).toBe(15);
      expect(resolveRelativeTimePhrase("Day After Tomorrow at noon", ref)?.getHours()).toBe(12);
      // Malformed trailing time → undefined (not a silent default).
      expect(resolveRelativeTimePhrase("day after tomorrow garbage", ref)).toBeUndefined();
      // No regression: plain "tomorrow" still +1 via dayPattern.
      expect(resolveRelativeTimePhrase("tomorrow", ref)?.getDate()).toBe(19);
    });

    it("resolves Korean day + time phrases (goal 160)", async () => {
      const { resolveRelativeTimePhrase } = await import("@muse/mcp-shared");
      const ref = () => new Date("2026-05-15T12:00:00Z"); // Friday

      const tomorrowPm3 = resolveRelativeTimePhrase("내일 오후 3시", ref);
      expect(tomorrowPm3?.getDate()).toBe(16);
      expect(tomorrowPm3?.getHours()).toBe(15);
      expect(tomorrowPm3?.getMinutes()).toBe(0);

      const todayAm930 = resolveRelativeTimePhrase("오늘 오전 9시 30분", ref);
      expect(todayAm930?.getDate()).toBe(15);
      expect(todayAm930?.getHours()).toBe(9);
      expect(todayAm930?.getMinutes()).toBe(30);

      const moreNoon = resolveRelativeTimePhrase("모레 정오", ref);
      expect(moreNoon?.getDate()).toBe(17);
      expect(moreNoon?.getHours()).toBe(12);

      const tomorrowMidnight = resolveRelativeTimePhrase("내일 자정", ref);
      expect(tomorrowMidnight?.getDate()).toBe(16);
      expect(tomorrowMidnight?.getHours()).toBe(0);

      const today15 = resolveRelativeTimePhrase("오늘 15시", ref);
      expect(today15?.getHours()).toBe(15);

      // Bare day → 09:00 default, matching the English semantics.
      const bareTomorrow = resolveRelativeTimePhrase("내일", ref);
      expect(bareTomorrow?.getDate()).toBe(16);
      expect(bareTomorrow?.getHours()).toBe(9);

      // 오후 12시 → noon; 오전 12시 → midnight.
      expect(resolveRelativeTimePhrase("오늘 오후 12시", ref)?.getHours()).toBe(12);
      expect(resolveRelativeTimePhrase("오늘 오전 12시", ref)?.getHours()).toBe(0);
    });

    it("resolves a bare Korean time with no day word → today at that time (symmetric with English bare time)", async () => {
      const { resolveRelativeTimePhrase } = await import("@muse/mcp-shared");
      const ref = () => new Date("2026-05-15T12:00:00Z"); // Friday
      const today = ref().getDate();

      const pm5 = resolveRelativeTimePhrase("오후 5시", ref);
      expect(pm5?.getDate()).toBe(today);
      expect(pm5?.getHours()).toBe(17);
      expect(pm5?.getMinutes()).toBe(0);

      const noon = resolveRelativeTimePhrase("정오", ref);
      expect(noon?.getDate()).toBe(today);
      expect(noon?.getHours()).toBe(12);

      const midnight = resolveRelativeTimePhrase("자정", ref);
      expect(midnight?.getDate()).toBe(today);
      expect(midnight?.getHours()).toBe(0);

      expect(resolveRelativeTimePhrase("17시", ref)?.getHours()).toBe(17);

      const am930 = resolveRelativeTimePhrase("오전 9시 30분", ref);
      expect(am930?.getHours()).toBe(9);
      expect(am930?.getMinutes()).toBe(30);

      // Non-time Korean still falls through to undefined — the new
      // bare-time branch must not become a catch-all false positive.
      expect(resolveRelativeTimePhrase("아무거나", ref)).toBeUndefined();
    });

    it("resolves the 반 (half-past) shorthand (goal 163)", async () => {
      const { resolveRelativeTimePhrase } = await import("@muse/mcp-shared");
      const ref = () => new Date("2026-05-15T12:00:00Z"); // Friday

      const tomorrowPm330 = resolveRelativeTimePhrase("내일 오후 3시 반", ref);
      expect(tomorrowPm330?.getDate()).toBe(16);
      expect(tomorrowPm330?.getHours()).toBe(15);
      expect(tomorrowPm330?.getMinutes()).toBe(30);

      // No space, no meridiem (24h): "오늘 9시반" → 09:30.
      const today930 = resolveRelativeTimePhrase("오늘 9시반", ref);
      expect(today930?.getHours()).toBe(9);
      expect(today930?.getMinutes()).toBe(30);

      // 오전 + 반.
      const am1130 = resolveRelativeTimePhrase("내일 오전 11시 반", ref);
      expect(am1130?.getHours()).toBe(11);
      expect(am1130?.getMinutes()).toBe(30);

      // Weekday + 반 (composes with goal-162 path).
      const monday6pm30 = resolveRelativeTimePhrase("다음 주 월요일 오후 6시 반", ref);
      expect(monday6pm30?.getDate()).toBe(18);
      expect(monday6pm30?.getHours()).toBe(18);
      expect(monday6pm30?.getMinutes()).toBe(30);

      // Explicit 분 still wins / unaffected.
      expect(resolveRelativeTimePhrase("오늘 오후 3시 15분", ref)?.getMinutes()).toBe(15);
    });

    it("resolves Korean duration offsets — 후 / 뒤 (goal 161)", async () => {
      const { resolveRelativeTimePhrase } = await import("@muse/mcp-shared");
      const ref = () => new Date("2026-05-15T12:00:00Z");

      expect(resolveRelativeTimePhrase("30분 후", ref)?.toISOString())
        .toBe(new Date("2026-05-15T12:30:00Z").toISOString());
      expect(resolveRelativeTimePhrase("2시간 후", ref)?.toISOString())
        .toBe(new Date("2026-05-15T14:00:00Z").toISOString());
      expect(resolveRelativeTimePhrase("3일 뒤", ref)?.toISOString())
        .toBe(new Date("2026-05-18T12:00:00Z").toISOString());
      expect(resolveRelativeTimePhrase("2주 후", ref)?.toISOString())
        .toBe(new Date("2026-05-29T12:00:00Z").toISOString());

      // 개월 / 달 use calendar-month semantics (May 15 → Aug 15).
      const threeMonths = resolveRelativeTimePhrase("3개월 후", ref);
      expect(threeMonths?.getUTCMonth()).toBe(7);
      expect(threeMonths?.getUTCDate()).toBe(15);
      const oneMonthDal = resolveRelativeTimePhrase("1달 후", ref);
      expect(oneMonthDal?.getUTCMonth()).toBe(5);

      // Spacing-tolerant: "3 일 후" with stray space still parses.
      expect(resolveRelativeTimePhrase("3 일 후", ref)?.toISOString())
        .toBe(new Date("2026-05-18T12:00:00Z").toISOString());
    });

    it("resolves Korean weekday phrases — 다음 주 / 이번 주 (goal 162)", async () => {
      const { resolveRelativeTimePhrase } = await import("@muse/mcp-shared");
      const ref = () => new Date("2026-05-15T12:00:00Z"); // Friday

      // Bare weekday → next occurrence (always future), default 09:00.
      const monday = resolveRelativeTimePhrase("월요일", ref);
      expect(monday?.getDate()).toBe(18); // Mon 2026-05-18
      expect(monday?.getHours()).toBe(9);

      // Bare = today's weekday → +7 (matches English next-occurrence).
      expect(resolveRelativeTimePhrase("금요일", ref)?.getDate()).toBe(22);

      // 이번 주 = this ISO-week's occurrence (may be past).
      expect(resolveRelativeTimePhrase("이번 주 월요일", ref)?.getDate()).toBe(11);
      expect(resolveRelativeTimePhrase("이번 주 일요일", ref)?.getDate()).toBe(17);

      // 다음 주 = next ISO-week's occurrence.
      expect(resolveRelativeTimePhrase("다음 주 월요일", ref)?.getDate()).toBe(18);
      expect(resolveRelativeTimePhrase("다음주 금요일", ref)?.getDate()).toBe(22);

      // Weekday + time.
      const nextMon3pm = resolveRelativeTimePhrase("다음 주 월요일 오후 3시", ref);
      expect(nextMon3pm?.getDate()).toBe(18);
      expect(nextMon3pm?.getHours()).toBe(15);

      const wed10am = resolveRelativeTimePhrase("수요일 오전 10시", ref);
      expect(wed10am?.getDate()).toBe(20); // next Wed
      expect(wed10am?.getHours()).toBe(10);
    });

    it("returns undefined for unsupported phrases (caller decides fallback)", async () => {
      const { resolveRelativeTimePhrase } = await import("@muse/mcp-shared");
      const now = () => new Date("2026-05-10T12:00:00Z");
      expect(resolveRelativeTimePhrase("sometime", now)).toBeUndefined();
      expect(resolveRelativeTimePhrase("yesterday", now)).toBeUndefined();
      expect(resolveRelativeTimePhrase("", now)).toBeUndefined();
      expect(resolveRelativeTimePhrase("tomorrow at 25:00", now)).toBeUndefined();
      // Korean: unsupported day word + out-of-range hour reject.
      expect(resolveRelativeTimePhrase("어제 오후 3시", now)).toBeUndefined();
      expect(resolveRelativeTimePhrase("내일 오후 13시", now)).toBeUndefined();
      expect(resolveRelativeTimePhrase("내일 25시", now)).toBeUndefined();
    });
  });

  it("rejects dueAt phrases that don't match ISO or any supported relative form", async () => {
    const { mkdtempSync } = await import("node:fs");
    const tmpdir = await import("node:os").then((m) => m.tmpdir());
    const dir = mkdtempSync(`${tmpdir}/muse-tasks-rel-bad-`);
    const connection = createLoopbackMcpConnection(createTasksMcpServer({ file: `${dir}/tasks.json` }));

    const result = await connection.callTool!("add", {
      dueAt: "sometime soon",
      title: "Vague"
    }) as { error?: string };
    expect(result.error).toMatch(/ISO-8601 timestamp or a supported relative phrase/u);
  });
});

describe("notes provider abstraction", () => {
  it("registers and routes providers via NotesProviderRegistry", () => {
    const apple = new AppleNotesProvider();
    const notion = new NotionNotesProvider({ token: "fake" });
    const registry = new NotesProviderRegistry([apple, notion]);

    expect(registry.has("apple")).toBe(true);
    expect(registry.has("notion")).toBe(true);
    expect(registry.has("ghost")).toBe(false);
    expect(registry.describe()).toHaveLength(2);
    expect(registry.primary()?.id).toBe("apple");
  });

  it("throws PROVIDER_NOT_FOUND for unknown providerId", () => {
    const registry = new NotesProviderRegistry([new AppleNotesProvider()]);
    expect(() => registry.require("ghost")).toThrowError(NotesProviderError);
  });

  it("the unknown-id NotesProviderRegistry error names the registered providers so a misconfigured notes id is recoverable", () => {
    const empty = new NotesProviderRegistry();
    expect(() => empty.require("apple")).toThrow(/none registered/u);

    const registry = new NotesProviderRegistry([new AppleNotesProvider()]);
    expect(() => registry.require("aple")).toThrow(/registered: apple/u);
  });

  it("AppleNotesProvider describes itself as a local osascript adapter", () => {
    const apple = new AppleNotesProvider();
    const info = apple.describe();
    expect(info.id).toBe("apple");
    expect(info.local).toBe(true);
    expect(info.displayName).toBe("Apple Notes");
    expect(info.description).toContain("AppleScript");
  });

  it("AppleNotesProvider validates inputs before invoking osascript", async () => {
    const apple = new AppleNotesProvider();
    await expect(apple.read("")).rejects.toMatchObject({ code: "EMPTY_ID" });
    await expect(apple.search("   ", 5)).rejects.toMatchObject({ code: "EMPTY_QUERY" });
    await expect(apple.save({ body: "b", title: "  " })).rejects.toMatchObject({ code: "EMPTY_TITLE" });
    await expect(apple.append({ body: "b", id: "" })).rejects.toMatchObject({ code: "EMPTY_ID" });
  });

  it("AppleNotesProvider surfaces osascript failures as typed provider errors", async () => {
    const apple = new AppleNotesProvider({ osascriptPath: "/usr/bin/false" });
    const error = await apple.list().catch((err) => err);
    expect(error).toBeInstanceOf(NotesProviderError);
    expect((error as NotesProviderError).providerId).toBe("apple");
    expect((error as NotesProviderError).code).toMatch(/^EXIT_/);
  });

  it("NotionNotesProvider describes itself with the right id", () => {
    const notion = new NotionNotesProvider({ databaseId: "db1", token: "t" });
    const info = notion.describe();
    expect(info).toMatchObject({ id: "notion", local: false });
    expect(info.description).toContain("db1");
  });

  it("NotionNotesProvider rejects empty token at construction", () => {
    expect(() => new NotionNotesProvider({ token: "" })).toThrow(NotesValidationError);
  });

  it("NotionNotesProvider.list requires databaseId", async () => {
    const notion = new NotionNotesProvider({ token: "secret_x", fetchImpl: async () => new Response("{}") });
    const error = await notion.list().catch((err) => err);
    expect(error).toBeInstanceOf(NotesProviderError);
    expect((error as NotesProviderError).code).toBe("MISSING_DATABASE_ID");
  });

  it("NotionNotesProvider.list parses database query results", async () => {
    const fetchImpl = async (url: string, init: RequestInit) => {
      expect(url).toContain("/v1/databases/db_xyz/query");
      expect(init.method).toBe("POST");
      const headers = init.headers as Record<string, string>;
      expect(headers.Authorization).toBe("Bearer secret_token");
      expect(headers["Notion-Version"]).toBe("2022-06-28");
      return new Response(
        JSON.stringify({
          results: [
            {
              id: "page-1",
              last_edited_time: "2026-05-09T10:00:00Z",
              parent: { database_id: "db_xyz" },
              properties: { Name: { title: [{ plain_text: "Daily standup" }] } }
            }
          ]
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    };
    const notion = new NotionNotesProvider({ databaseId: "db_xyz", fetchImpl, token: "secret_token" });
    const entries = await notion.list();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ id: "page-1", providerId: "notion", title: "Daily standup", folder: "db_xyz" });
  });

  it("NotionNotesProvider.list paginates via has_more / next_cursor until exhaustion", async () => {
    const requestBodies: Array<Record<string, unknown>> = [];
    const fetchImpl = async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string) as Record<string, unknown>;
      requestBodies.push(body);
      // Page 1 → has_more, Page 2 → has_more, Page 3 → done.
      if (!body.start_cursor) {
        return new Response(JSON.stringify({
          has_more: true,
          next_cursor: "cursor-2",
          results: [
            { id: "p1", properties: { Name: { title: [{ plain_text: "first" }] } } },
            { id: "p2", properties: { Name: { title: [{ plain_text: "second" }] } } }
          ]
        }), { status: 200 });
      }
      if (body.start_cursor === "cursor-2") {
        return new Response(JSON.stringify({
          has_more: true,
          next_cursor: "cursor-3",
          results: [
            { id: "p3", properties: { Name: { title: [{ plain_text: "third" }] } } }
          ]
        }), { status: 200 });
      }
      return new Response(JSON.stringify({
        has_more: false,
        next_cursor: null,
        results: [
          { id: "p4", properties: { Name: { title: [{ plain_text: "fourth" }] } } }
        ]
      }), { status: 200 });
    };
    const notion = new NotionNotesProvider({ databaseId: "db_xyz", fetchImpl, token: "t" });
    const entries = await notion.list();

    expect(requestBodies).toHaveLength(3);
    expect(requestBodies[0]).toMatchObject({ page_size: 100 });
    expect(requestBodies[0]).not.toHaveProperty("start_cursor");
    expect(requestBodies[1]).toMatchObject({ start_cursor: "cursor-2" });
    expect(requestBodies[2]).toMatchObject({ start_cursor: "cursor-3" });
    expect(entries.map((entry) => entry.id)).toEqual(["p1", "p2", "p3", "p4"]);
  });

  it("NotionNotesProvider.read returns undefined on 404 and joins paragraph blocks", async () => {
    const calls: string[] = [];
    const fetchImpl = async (url: string) => {
      calls.push(url);
      if (url.endsWith("/v1/pages/missing")) {
        return new Response(JSON.stringify({ message: "not found" }), { status: 404 });
      }
      if (url.endsWith("/v1/pages/p1")) {
        return new Response(JSON.stringify({
          id: "p1",
          last_edited_time: "2026-05-09T10:00:00Z",
          properties: { Name: { title: [{ plain_text: "Hello" }] } }
        }), { status: 200 });
      }
      if (url.endsWith("/v1/blocks/p1/children?page_size=100")) {
        return new Response(JSON.stringify({
          results: [
            { id: "b1", paragraph: { rich_text: [{ plain_text: "first line" }] }, type: "paragraph" },
            { id: "b2", paragraph: { rich_text: [{ plain_text: "second line" }] }, type: "paragraph" },
            { id: "b3", type: "code" }
          ]
        }), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    };
    const notion = new NotionNotesProvider({ fetchImpl, token: "t" });
    expect(await notion.read("missing")).toBeUndefined();
    const content = await notion.read("p1");
    expect(content).toBeDefined();
    expect(content!.title).toBe("Hello");
    expect(content!.body).toBe("first line\nsecond line");
  });

  it("NotionNotesProvider.read paginates block children via has_more / next_cursor", async () => {
    const blockUrls: string[] = [];
    const fetchImpl = async (url: string) => {
      const path = String(url);
      if (path.endsWith("/v1/pages/long")) {
        return new Response(JSON.stringify({
          id: "long",
          properties: { Name: { title: [{ plain_text: "Long page" }] } }
        }), { status: 200 });
      }
      if (path.includes("/v1/blocks/long/children")) {
        blockUrls.push(path);
        if (!path.includes("start_cursor=")) {
          return new Response(JSON.stringify({
            has_more: true,
            next_cursor: "blk-2",
            results: [
              { id: "b1", paragraph: { rich_text: [{ plain_text: "alpha" }] }, type: "paragraph" }
            ]
          }), { status: 200 });
        }
        if (path.includes("start_cursor=blk-2")) {
          return new Response(JSON.stringify({
            has_more: false,
            next_cursor: null,
            results: [
              { id: "b2", paragraph: { rich_text: [{ plain_text: "beta" }] }, type: "paragraph" }
            ]
          }), { status: 200 });
        }
      }
      return new Response("{}", { status: 200 });
    };
    const notion = new NotionNotesProvider({ fetchImpl, token: "t" });
    const content = await notion.read("long");

    expect(content?.body).toBe("alpha\nbeta");
    expect(blockUrls).toHaveLength(2);
    expect(blockUrls[0]).not.toContain("start_cursor=");
    expect(blockUrls[1]).toContain("start_cursor=blk-2");
  });

  it("NotionNotesProvider maps 401 to NOTION_AUTH", async () => {
    const fetchImpl = async () => new Response("Unauthorized", { status: 401 });
    const notion = new NotionNotesProvider({ databaseId: "db1", fetchImpl, token: "bad" });
    const error = await notion.list().catch((err) => err);
    expect(error).toBeInstanceOf(NotesProviderError);
    expect((error as NotesProviderError).code).toBe("NOTION_AUTH");
    // Goal 136 — 401 is a permanent auth error, never retryable.
    expect((error as NotesProviderError).retryable).toBe(false);
    expect((error as NotesProviderError).status).toBe(401);
  });

  it("NotionNotesProvider 429 / 5xx errors land as retryable (goal 136)", async () => {
    const make429 = async () => new Response("Too Many Requests", { status: 429 });
    const notion429 = new NotionNotesProvider({ databaseId: "db1", fetchImpl: make429, token: "t" });
    const e429 = await notion429.list().catch((err) => err);
    expect(e429).toBeInstanceOf(NotesProviderError);
    expect((e429 as NotesProviderError).retryable).toBe(true);
    expect((e429 as NotesProviderError).status).toBe(429);

    const make503 = async () => new Response("Bad Gateway", { status: 503 });
    const notion503 = new NotionNotesProvider({ databaseId: "db1", fetchImpl: make503, token: "t" });
    const e503 = await notion503.list().catch((err) => err);
    expect((e503 as NotesProviderError).retryable).toBe(true);
    expect((e503 as NotesProviderError).status).toBe(503);

    // 404 stays fail-fast.
    const make404 = async () => new Response("Not Found", { status: 404 });
    const notion404 = new NotionNotesProvider({ databaseId: "db1", fetchImpl: make404, token: "t" });
    const e404 = await notion404.list().catch((err) => err);
    expect((e404 as NotesProviderError).retryable).toBe(false);

    // Legacy 3-arg constructor (local / apple providers) → not retryable.
    const local = new NotesProviderError("local", "FILE_TOO_LARGE", "200KB > 100KB");
    expect(local.retryable).toBe(false);
    expect(local.status).toBeUndefined();
  });

  it("NotionNotesProvider.search hits /v1/search and maps to NotesSearchHit", async () => {
    const fetchImpl = async (url: string, init: RequestInit) => {
      expect(url).toContain("/v1/search");
      const body = JSON.parse(init.body as string);
      expect(body.query).toBe("standup");
      expect(body.filter).toMatchObject({ property: "object", value: "page" });
      return new Response(JSON.stringify({
        results: [
          { id: "p9", properties: { Name: { title: [{ plain_text: "standup notes" }] } } }
        ]
      }), { status: 200 });
    };
    const notion = new NotionNotesProvider({ fetchImpl, token: "t" });
    const hits = await notion.search("standup", 5);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ id: "p9", providerId: "notion", title: "standup notes" });
  });

  it("LocalDirNotesProvider supports save → list → read → search → append", async () => {
    const { mkdtempSync } = await import("node:fs");
    const tmpdir = await import("node:os").then((m) => m.tmpdir());
    const root = mkdtempSync(`${tmpdir}/muse-localdir-`);
    const provider = new LocalDirNotesProvider({ notesDir: root });

    const saved = await provider.save({ body: "First line\nKeyword here\n", title: "note.md" });
    expect(saved).toMatchObject({ id: "note.md", providerId: "local", title: "note.md" });

    const listed = await provider.list();
    expect(listed.map((entry) => entry.id)).toEqual(["note.md"]);

    const fetched = await provider.read("note.md");
    expect(fetched?.body).toContain("Keyword here");

    const hits = await provider.search("keyword", 5);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ id: "note.md", line: 2 });

    const appended = await provider.append({ body: "Second keyword\n", id: "note.md" });
    expect(appended.body).toContain("Second keyword");

    const missing = await provider.read("nope.md");
    expect(missing).toBeUndefined();
  });

  it("LocalDirNotesProvider rejects sandbox escapes", async () => {
    const { mkdtempSync } = await import("node:fs");
    const tmpdir = await import("node:os").then((m) => m.tmpdir());
    const root = mkdtempSync(`${tmpdir}/muse-localdir-escape-`);
    const provider = new LocalDirNotesProvider({ notesDir: root });

    await expect(provider.read("../etc/passwd")).rejects.toBeInstanceOf(NotesValidationError);
    await expect(provider.read("/etc/passwd")).rejects.toBeInstanceOf(NotesValidationError);
    await expect(provider.save({ body: "x", title: "/abs.md" })).rejects.toBeInstanceOf(NotesValidationError);
    await expect(provider.search("   ", 5)).rejects.toBeInstanceOf(NotesValidationError);
  });

  it("LocalDirNotesProvider blocks overwrite without explicit flag", async () => {
    const { mkdtempSync } = await import("node:fs");
    const tmpdir = await import("node:os").then((m) => m.tmpdir());
    const root = mkdtempSync(`${tmpdir}/muse-localdir-overwrite-`);
    const provider = new LocalDirNotesProvider({ notesDir: root });

    await provider.save({ body: "v1", title: "doc.md" });
    await expect(provider.save({ body: "v2", title: "doc.md" })).rejects.toMatchObject({ code: "ALREADY_EXISTS" });
    const replaced = await provider.save({ body: "v2", overwrite: true, title: "doc.md" });
    expect(replaced.body).toBe("v2");
  });
});

describe("createNotesRegistryMcpServer", () => {
  it("exposes the muse.notes-multi tool surface", () => {
    const registry = new NotesProviderRegistry([new AppleNotesProvider()]);
    const server = createNotesRegistryMcpServer({ registry });
    expect(server.name).toBe("muse.notes-multi");
    const toolNames = server.tools.map((tool) => tool.name);
    expect(toolNames).toEqual(["providers", "list", "read", "search", "save", "append"]);
  });

  it("providers tool reports describe() output for every registered provider", async () => {
    const apple = new AppleNotesProvider();
    const notion = new NotionNotesProvider({ databaseId: "db1", fetchImpl: async () => new Response("{}"), token: "t" });
    const registry = new NotesProviderRegistry([apple, notion]);
    const conn = createLoopbackMcpConnection(createNotesRegistryMcpServer({ registry }));
    const result = await conn.callTool!("providers", {}) as { providers: Array<{ id: string }> };
    expect(result.providers.map((p) => p.id).sort()).toEqual(["apple", "notion"]);
  });

  it("read routes to the named provider and serializes the response", async () => {
    const { mkdtempSync } = await import("node:fs");
    const tmpdir = await import("node:os").then((m) => m.tmpdir());
    const root = mkdtempSync(`${tmpdir}/muse-notes-multi-read-`);
    const local = new LocalDirNotesProvider({ notesDir: root });
    await local.save({ body: "alpha\nbeta\n", title: "diary.md" });
    const registry = new NotesProviderRegistry([local]);
    const conn = createLoopbackMcpConnection(createNotesRegistryMcpServer({ registry }));

    const result = await conn.callTool!("read", { id: "diary.md", providerId: "local" }) as { note?: { body?: string; title?: string } };
    expect(result.note?.title).toBe("diary.md");
    expect(result.note?.body).toBe("alpha\nbeta\n");
  });

  it("search fans out across providers when providerId is omitted", async () => {
    const { mkdtempSync } = await import("node:fs");
    const tmpdir = await import("node:os").then((m) => m.tmpdir());
    const root = mkdtempSync(`${tmpdir}/muse-notes-multi-search-`);
    const local = new LocalDirNotesProvider({ notesDir: root });
    await local.save({ body: "needle is here", title: "haystack.md" });
    const registry = new NotesProviderRegistry([local]);
    const conn = createLoopbackMcpConnection(createNotesRegistryMcpServer({ registry }));

    const result = await conn.callTool!("search", { limit: 5, query: "needle" }) as { hits: Array<{ providerId: string }> };
    expect(result.hits.length).toBeGreaterThan(0);
    expect(result.hits[0]!.providerId).toBe("local");
  });

  it("save / append round-trip via the registry", async () => {
    const { mkdtempSync } = await import("node:fs");
    const tmpdir = await import("node:os").then((m) => m.tmpdir());
    const root = mkdtempSync(`${tmpdir}/muse-notes-multi-rw-`);
    const local = new LocalDirNotesProvider({ notesDir: root });
    const registry = new NotesProviderRegistry([local]);
    const conn = createLoopbackMcpConnection(createNotesRegistryMcpServer({ registry }));

    const saved = await conn.callTool!("save", {
      body: "first\n",
      providerId: "local",
      title: "log.md"
    }) as { note: { id: string; body: string } };
    expect(saved.note.id).toBe("log.md");

    const appended = await conn.callTool!("append", {
      body: "second\n",
      id: "log.md",
      providerId: "local"
    }) as { note: { body: string } };
    expect(appended.note.body).toContain("first");
    expect(appended.note.body).toContain("second");
  });

  it("save creates on the primary provider for a fabricated 'default' / omitted providerId, but still requires a real id to UPDATE", async () => {
    const { mkdtempSync } = await import("node:fs");
    const tmpdir = await import("node:os").then((m) => m.tmpdir());
    const root = mkdtempSync(`${tmpdir}/muse-notes-multi-sentinel-`);
    const local = new LocalDirNotesProvider({ notesDir: root });
    const registry = new NotesProviderRegistry([local]);
    const conn = createLoopbackMcpConnection(createNotesRegistryMcpServer({ registry }));

    const viaSentinel = await conn.callTool!("save", { body: "a\n", providerId: "default", title: "one.md" }) as { note?: { id: string }; error?: string };
    expect(viaSentinel.error).toBeUndefined();
    expect(viaSentinel.note?.id).toBe("one.md");

    const omitted = await conn.callTool!("save", { body: "b\n", title: "two.md" }) as { note?: { id: string }; error?: string };
    expect(omitted.note?.id).toBe("two.md");

    const updateNoProvider = await conn.callTool!("save", { body: "c\n", id: "one.md", title: "one.md" }) as { error?: string };
    expect(updateNoProvider.error).toContain("providerId is required to update");
  });

  it("surfaces NotesProviderError with code in the tool response", async () => {
    const registry = new NotesProviderRegistry([new AppleNotesProvider()]);
    const conn = createLoopbackMcpConnection(createNotesRegistryMcpServer({ registry }));

    const missingProvider = await conn.callTool!("read", { id: "x", providerId: "ghost" }) as { code?: string; error?: string };
    expect(missingProvider.code).toBe("PROVIDER_NOT_FOUND");
    expect(missingProvider.error).toContain("ghost");
  });

  it("rejects writes with missing required fields without invoking providers", async () => {
    const registry = new NotesProviderRegistry([new AppleNotesProvider()]);
    const conn = createLoopbackMcpConnection(createNotesRegistryMcpServer({ registry }));

    expect(await conn.callTool!("save", { body: "x", providerId: "apple" }))
      .toMatchObject({ error: expect.stringContaining("title") });
    expect(await conn.callTool!("append", { id: "x", providerId: "apple" }))
      .toMatchObject({ error: expect.stringContaining("body") });
  });
});

describe("tasks provider abstraction", () => {
  it("LocalFileTasksProvider round-trips add → list → complete → search against the JSON file", async () => {
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const tmpdir = await import("node:os").then((m) => m.tmpdir());
    const join = await import("node:path").then((m) => m.join);
    const root = mkdtempSync(`${tmpdir}/muse-tasks-provider-`);
    const file = join(root, "tasks.json");

    let counter = 0;
    const provider = new LocalFileTasksProvider({
      file,
      idFactory: () => `task-${++counter}`,
      now: () => new Date(2026, 0, counter, 12, 0, 0)
    });

    expect(provider.describe()).toMatchObject({ id: "local", local: true });

    const added = await provider.add({
      notes: "investigate before tomorrow",
      tags: ["urgent"],
      title: "Review the PR"
    });
    expect(added).toMatchObject({
      id: "task-1",
      providerId: "local",
      status: "open",
      title: "Review the PR"
    });
    expect(added.notes).toBe("investigate before tomorrow");
    expect(added.tags).toEqual(["urgent"]);

    await provider.add({ title: "Buy groceries" });

    const openList = await provider.list("open");
    // Newest-first ordering by createdAt: task-2 came after task-1.
    expect(openList.map((task) => task.id)).toEqual(["task-2", "task-1"]);
    expect(openList[0]?.providerId).toBe("local");

    const completed = await provider.complete("task-1");
    expect(completed).toMatchObject({ id: "task-1", status: "done" });
    expect(completed?.completedAt).toBeInstanceOf(Date);

    // Idempotency: re-completing the same task does not move the timestamp.
    const idempotent = await provider.complete("task-1");
    expect(idempotent?.completedAt?.getTime()).toBe(completed?.completedAt?.getTime());

    const doneList = await provider.list("done");
    expect(doneList.map((task) => task.id)).toEqual(["task-1"]);

    const allList = await provider.list("all");
    expect(allList).toHaveLength(2);

    const hits = await provider.search("groceries", 10);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ id: "task-2", providerId: "local", status: "open" });

    const notesHits = await provider.search("INVESTIGATE", 10);
    expect(notesHits[0]?.snippet).toBe("investigate before tomorrow");

    // The on-disk JSON shape stays stable (compatible with createTasksMcpServer
    // in loopback-tasks.ts).
    const { readFileSync } = await import("node:fs");
    const persisted = JSON.parse(readFileSync(file, "utf8"));
    expect(persisted.tasks).toHaveLength(2);
    expect(persisted.tasks[0]).toMatchObject({ id: "task-1", status: "done" });

    // Crash protection — partial / missing / unparseable file still yields
    // an empty list (no throw on a fresh user).
    const crashFile = join(root, "missing.json");
    const fresh = new LocalFileTasksProvider({ file: crashFile });
    expect(await fresh.list()).toEqual([]);

    const badFile = join(root, "bad.json");
    writeFileSync(badFile, "{not valid json", "utf8");
    const corrupted = new LocalFileTasksProvider({ file: badFile });
    expect(await corrupted.list()).toEqual([]);
  });

  it("rejects empty title + empty query with TasksValidationError", async () => {
    const { mkdtempSync } = await import("node:fs");
    const tmpdir = await import("node:os").then((m) => m.tmpdir());
    const join = await import("node:path").then((m) => m.join);
    const root = mkdtempSync(`${tmpdir}/muse-tasks-validation-`);
    const provider = new LocalFileTasksProvider({ file: join(root, "tasks.json") });

    await expect(provider.add({ title: "   " })).rejects.toBeInstanceOf(TasksValidationError);
    await expect(provider.search("", 10)).rejects.toBeInstanceOf(TasksValidationError);
    await expect(provider.complete("")).rejects.toBeInstanceOf(TasksValidationError);
  });

  it("TasksProviderRegistry routes by providerId and surfaces TasksProviderError on miss", async () => {
    const { mkdtempSync } = await import("node:fs");
    const tmpdir = await import("node:os").then((m) => m.tmpdir());
    const join = await import("node:path").then((m) => m.join);
    const root = mkdtempSync(`${tmpdir}/muse-tasks-registry-`);
    const local = new LocalFileTasksProvider({ file: join(root, "tasks.json") });
    const registry = new TasksProviderRegistry([local]);

    expect(registry.list().map((p) => p.id)).toEqual(["local"]);
    expect(registry.describe()[0]).toMatchObject({ id: "local", local: true });
    expect(registry.has("local")).toBe(true);
    expect(registry.has("ghost")).toBe(false);
    expect(registry.primary()?.id).toBe("local");
    expect(registry.require("local")).toBe(local);
    expect(() => registry.require("ghost")).toThrow(TasksProviderError);
  });

  it("the unknown-id TasksProviderRegistry error names the registered providers so a misconfigured tasks id is recoverable", async () => {
    const { mkdtempSync } = await import("node:fs");
    const tmpdir = await import("node:os").then((m) => m.tmpdir());
    const join = await import("node:path").then((m) => m.join);

    const empty = new TasksProviderRegistry();
    expect(() => empty.require("local")).toThrow(/none registered/u);

    const root = mkdtempSync(`${tmpdir}/muse-tasks-registry-hint-`);
    const local = new LocalFileTasksProvider({ file: join(root, "tasks.json") });
    const registry = new TasksProviderRegistry([local]);
    expect(() => registry.require("locale")).toThrow(/registered: local/u);
  });

  it("constructor rejects empty file path with TasksValidationError", () => {
    expect(() => new LocalFileTasksProvider({ file: "" })).toThrow(TasksValidationError);
    expect(() => new LocalFileTasksProvider({ file: "   " })).toThrow(TasksValidationError);
  });

  it("AppleRemindersProvider describes itself as a local osascript adapter", () => {
    const apple = new AppleRemindersProvider();
    const info = apple.describe();
    expect(info.id).toBe("apple-reminders");
    expect(info.local).toBe(true);
    expect(info.displayName).toBe("Apple Reminders");
    expect(info.description).toContain("AppleScript");
  });

  it("AppleRemindersProvider scopes the description when a list filter is set", () => {
    const scoped = new AppleRemindersProvider({ list: "Groceries" });
    expect(scoped.describe().description).toContain("Groceries");
  });

  it("AppleRemindersProvider validates inputs before invoking osascript", async () => {
    const apple = new AppleRemindersProvider();
    await expect(apple.add({ title: "  " })).rejects.toMatchObject({ code: "EMPTY_TITLE" });
    await expect(apple.complete("")).rejects.toMatchObject({ code: "EMPTY_ID" });
    await expect(apple.search("   ", 10)).rejects.toMatchObject({ code: "EMPTY_QUERY" });
  });

  it("AppleRemindersProvider surfaces osascript failures as typed provider errors", async () => {
    // /usr/bin/false exits non-zero with empty stdout/stderr — exercises the
    // generic EXIT_<code> code path without needing a real Reminders.app.
    const apple = new AppleRemindersProvider({ osascriptPath: "/usr/bin/false" });
    const error = await apple.list().catch((err) => err);
    expect(error).toBeInstanceOf(TasksProviderError);
    expect((error as TasksProviderError).providerId).toBe("apple-reminders");
    expect((error as TasksProviderError).code).toMatch(/^EXIT_/);
  });

  it("createTasksRegistryMcpServer round-trips list / add / complete / search through the registry", async () => {
    const { mkdtempSync } = await import("node:fs");
    const tmpdir = await import("node:os").then((m) => m.tmpdir());
    const join = await import("node:path").then((m) => m.join);
    const root = mkdtempSync(`${tmpdir}/muse-tasks-multi-`);

    let counter = 0;
    const local = new LocalFileTasksProvider({
      file: join(root, "tasks.json"),
      idFactory: () => `task-${++counter}`,
      now: () => new Date(2026, 0, counter, 12, 0, 0)
    });
    const registry = new TasksProviderRegistry([local]);
    const conn = createLoopbackMcpConnection(createTasksRegistryMcpServer({ registry }));

    const providers = await conn.callTool!("providers", {}) as { providers: { id: string }[] };
    expect(providers.providers.map((p) => p.id)).toEqual(["local"]);

    const added = await conn.callTool!("add", {
      providerId: "local",
      title: "Buy groceries"
    }) as { task: { id: string; status: string; title: string } };
    expect(added.task).toMatchObject({ id: "task-1", status: "open", title: "Buy groceries" });

    const listed = await conn.callTool!("list", { providerId: "local", status: "open" }) as { total: number; tasks: { id: string }[] };
    expect(listed.total).toBe(1);
    expect(listed.tasks[0]?.id).toBe("task-1");

    const completed = await conn.callTool!("complete", { id: "task-1", providerId: "local" }) as { task: { status: string } };
    expect(completed.task.status).toBe("done");

    const searched = await conn.callTool!("search", { providerId: "local", query: "groceries" }) as { hits: { id: string; status: string }[] };
    expect(searched.hits[0]).toMatchObject({ id: "task-1", status: "done" });
  });

  it("createTasksRegistryMcpServer surfaces TasksProviderError with code in the tool response", async () => {
    const registry = new TasksProviderRegistry([new AppleRemindersProvider()]);
    const conn = createLoopbackMcpConnection(createTasksRegistryMcpServer({ registry }));

    const missingProvider = await conn.callTool!("complete", { id: "x", providerId: "ghost" }) as { code?: string; error?: string };
    expect(missingProvider.code).toBe("PROVIDER_NOT_FOUND");
    expect(missingProvider.error).toContain("ghost");
  });

  it("createTasksRegistryMcpServer rejects writes with missing required fields without invoking providers", async () => {
    const registry = new TasksProviderRegistry([new AppleRemindersProvider()]);
    const conn = createLoopbackMcpConnection(createTasksRegistryMcpServer({ registry }));

    expect(await conn.callTool!("add", { providerId: "apple-reminders" }))
      .toMatchObject({ error: expect.stringContaining("title") });
    expect(await conn.callTool!("complete", { providerId: "apple-reminders" }))
      .toMatchObject({ error: expect.stringContaining("id") });
    expect(await conn.callTool!("search", { providerId: "apple-reminders" }))
      .toMatchObject({ error: expect.stringContaining("query") });
  });

  it("add routes a fabricated 'default' providerId (and an omitted one) to the primary provider", async () => {
    const { mkdtempSync } = await import("node:fs");
    const tmpdir = await import("node:os").then((m) => m.tmpdir());
    const join = await import("node:path").then((m) => m.join);
    const root = mkdtempSync(`${tmpdir}/muse-tasks-multi-sentinel-`);
    let counter = 0;
    const local = new LocalFileTasksProvider({
      file: join(root, "tasks.json"),
      idFactory: () => `task-${++counter}`,
      now: () => new Date(2026, 0, 1, 12, 0, 0)
    });
    const registry = new TasksProviderRegistry([local]);
    const conn = createLoopbackMcpConnection(createTasksRegistryMcpServer({ registry }));

    const viaSentinel = await conn.callTool!("add", { providerId: "default", title: "Buy milk" }) as { task?: { providerId: string; title: string }; error?: string };
    expect(viaSentinel.error).toBeUndefined();
    expect(viaSentinel.task).toMatchObject({ providerId: "local", title: "Buy milk" });

    const omitted = await conn.callTool!("add", { title: "Walk the dog" }) as { task?: { providerId: string } };
    expect(omitted.task?.providerId).toBe("local");

    const unknown = await conn.callTool!("add", { providerId: "notion", title: "x" }) as { code?: string; error?: string };
    expect(unknown.code).toBe("PROVIDER_NOT_FOUND");
  });

  it("NotionTasksProvider rejects empty token + empty databaseId at construction", () => {
    expect(() => new NotionTasksProvider({ databaseId: "db", token: "" })).toThrow(TasksValidationError);
    expect(() => new NotionTasksProvider({ databaseId: "", token: "secret" })).toThrow(TasksValidationError);
  });

  it("NotionTasksProvider describes itself with the configured database", () => {
    const provider = new NotionTasksProvider({
      databaseId: "db_tasks",
      fetchImpl: async () => new Response("{}"),
      token: "secret"
    });
    expect(provider.describe()).toMatchObject({ id: "notion", local: false });
    expect(provider.describe().description).toContain("db_tasks");
  });

  it("NotionTasksProvider.list passes a Status select filter and parses rows into Tasks", async () => {
    const recorded: Array<{ url: string; body: unknown }> = [];
    const fetchImpl = async (url: string, init: RequestInit) => {
      recorded.push({ body: JSON.parse(init.body as string), url });
      return new Response(
        JSON.stringify({
          has_more: false,
          next_cursor: null,
          results: [
            {
              created_time: "2026-05-09T08:00:00Z",
              id: "page-A",
              last_edited_time: "2026-05-09T09:00:00Z",
              parent: { database_id: "db_tasks" },
              properties: {
                Name: { title: [{ plain_text: "Ship Muse 1.0" }] },
                Status: { select: { name: "Open" } }
              }
            }
          ]
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    };
    const provider = new NotionTasksProvider({
      databaseId: "db_tasks",
      fetchImpl,
      token: "secret_token"
    });

    const open = await provider.list("open");

    expect(recorded[0]?.url).toContain("/v1/databases/db_tasks/query");
    expect(recorded[0]?.body).toMatchObject({
      filter: { property: "Status", select: { equals: "Open" } }
    });
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({
      id: "page-A",
      providerId: "notion",
      status: "open",
      title: "Ship Muse 1.0"
    });
    expect(open[0]?.createdAt).toEqual(new Date("2026-05-09T08:00:00Z"));
  });

  it("NotionTasksProvider.add posts to /pages with parent.database_id and the open status option", async () => {
    let posted: { url: string; body: Record<string, unknown> } | undefined;
    const fetchImpl = async (url: string, init: RequestInit) => {
      posted = { body: JSON.parse(init.body as string) as Record<string, unknown>, url };
      return new Response(
        JSON.stringify({
          created_time: "2026-05-10T12:00:00Z",
          id: "page-new",
          parent: { database_id: "db_tasks" },
          properties: {
            Name: { title: [{ plain_text: "Refactor model loop" }] },
            Status: { select: { name: "Open" } }
          }
        }),
        { status: 200 }
      );
    };
    const provider = new NotionTasksProvider({
      databaseId: "db_tasks",
      fetchImpl,
      token: "secret"
    });

    const created = await provider.add({ title: "Refactor model loop" });

    expect(posted?.url).toContain("/v1/pages");
    expect(posted?.body).toMatchObject({
      parent: { database_id: "db_tasks" },
      properties: {
        Name: { title: [{ text: { content: "Refactor model loop" } }] },
        Status: { select: { name: "Open" } }
      }
    });
    expect(created).toMatchObject({
      id: "page-new",
      providerId: "notion",
      status: "open",
      title: "Refactor model loop"
    });
  });

  it("NotionTasksProvider.complete patches the Status select to Done and surfaces completedAt", async () => {
    let patched: { url: string; method: string; body: Record<string, unknown> } | undefined;
    const fetchImpl = async (url: string, init: RequestInit) => {
      patched = {
        body: JSON.parse(init.body as string) as Record<string, unknown>,
        method: init.method ?? "",
        url
      };
      return new Response(
        JSON.stringify({
          created_time: "2026-05-09T08:00:00Z",
          id: "page-A",
          last_edited_time: "2026-05-10T15:30:00Z",
          parent: { database_id: "db_tasks" },
          properties: {
            Name: { title: [{ plain_text: "Ship Muse 1.0" }] },
            Status: { select: { name: "Done" } }
          }
        }),
        { status: 200 }
      );
    };
    const provider = new NotionTasksProvider({
      databaseId: "db_tasks",
      fetchImpl,
      token: "secret"
    });

    const done = await provider.complete("page-A");

    expect(patched?.method).toBe("PATCH");
    expect(patched?.url).toContain("/v1/pages/page-A");
    expect(patched?.body).toMatchObject({
      properties: { Status: { select: { name: "Done" } } }
    });
    expect(done).toMatchObject({ id: "page-A", status: "done" });
    expect(done?.completedAt).toEqual(new Date("2026-05-10T15:30:00Z"));
  });

  it("NotionTasksProvider.complete returns undefined on a 404 instead of throwing", async () => {
    const fetchImpl = async () => new Response("not found", { status: 404 });
    const provider = new NotionTasksProvider({
      databaseId: "db_tasks",
      fetchImpl,
      token: "secret"
    });
    expect(await provider.complete("page-missing")).toBeUndefined();
  });

  it("NotionTasksProvider.search filters /search hits to the configured database", async () => {
    const fetchImpl = async () => new Response(
      JSON.stringify({
        results: [
          {
            created_time: "2026-05-09T08:00:00Z",
            id: "in-db",
            parent: { database_id: "db_tasks" },
            properties: {
              Name: { title: [{ plain_text: "Hit inside the tasks DB" }] },
              Status: { select: { name: "Open" } }
            }
          },
          {
            created_time: "2026-05-09T08:00:00Z",
            id: "outside-db",
            parent: { database_id: "other_database" },
            properties: {
              Name: { title: [{ plain_text: "Unrelated page" }] }
            }
          }
        ]
      }),
      { status: 200 }
    );
    const provider = new NotionTasksProvider({
      databaseId: "db_tasks",
      fetchImpl,
      token: "secret"
    });

    const hits = await provider.search("hit", 10);

    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({
      id: "in-db",
      providerId: "notion",
      status: "open",
      title: "Hit inside the tasks DB"
    });
  });

  it("NotionTasksProvider maps 401/403 to NOTION_AUTH and 429 to NOTION_RATE_LIMIT", async () => {
    const make401 = new NotionTasksProvider({
      databaseId: "db_tasks",
      fetchImpl: async () => new Response("unauthorized", { status: 401 }),
      token: "secret"
    });
    const auth = await make401.list().catch((err) => err);
    expect(auth).toBeInstanceOf(TasksProviderError);
    expect((auth as TasksProviderError).code).toBe("NOTION_AUTH");

    const make429 = new NotionTasksProvider({
      databaseId: "db_tasks",
      fetchImpl: async () => new Response("slow down", { status: 429 }),
      token: "secret"
    });
    const rate = await make429.list().catch((err) => err);
    expect(rate).toBeInstanceOf(TasksProviderError);
    expect((rate as TasksProviderError).code).toBe("NOTION_RATE_LIMIT");
  });

  it("NotionTasksProvider honors custom titleProperty + statusProperty + statusOpenValue", async () => {
    const recorded: Array<{ body: Record<string, unknown> }> = [];
    const fetchImpl = async (_url: string, init: RequestInit) => {
      recorded.push({ body: JSON.parse(init.body as string) as Record<string, unknown> });
      return new Response(
        JSON.stringify({
          created_time: "2026-05-09T08:00:00Z",
          id: "page-1",
          parent: { database_id: "db_tasks" },
          properties: {
            Title: { title: [{ plain_text: "Custom" }] },
            State: { select: { name: "Active" } }
          }
        }),
        { status: 200 }
      );
    };
    const provider = new NotionTasksProvider({
      databaseId: "db_tasks",
      fetchImpl,
      statusOpenValue: "Active",
      statusProperty: "State",
      titleProperty: "Title",
      token: "secret"
    });

    const created = await provider.add({ title: "Custom" });

    expect(recorded[0]?.body).toMatchObject({
      properties: {
        State: { select: { name: "Active" } },
        Title: { title: [{ text: { content: "Custom" } }] }
      }
    });
    expect(created.status).toBe("open");
    expect(created.title).toBe("Custom");
  });
});

describe("muse.context loopback server", () => {
  it("fetch returns content for a known ref and { found: false } for unknown / expired", async () => {
    const { InMemoryContextReferenceStore } = await import("@muse/memory");
    let now = new Date("2026-05-10T00:00:00.000Z");
    const store = new InMemoryContextReferenceStore({
      now: () => now,
      ttlMs: 30_000
    });
    store.put({
      content: "the full body of a large tool output",
      contentType: "text/plain",
      id: "ref-abc",
      originalLength: 200_000,
      source: "muse.fs.read"
    });

    const conn = createLoopbackMcpConnection(createContextReferenceMcpServer({ store }));

    const fetched = await conn.callTool!("fetch", { ref: "ref-abc" }) as {
      content?: string;
      contentType?: string;
      found: boolean;
      originalLength?: number;
      ref: string;
      source?: string;
    };
    expect(fetched.found).toBe(true);
    expect(fetched.content).toBe("the full body of a large tool output");
    expect(fetched.contentType).toBe("text/plain");
    expect(fetched.originalLength).toBe(200_000);
    expect(fetched.source).toBe("muse.fs.read");

    const missing = await conn.callTool!("fetch", { ref: "nope" }) as { found: boolean; ref: string };
    expect(missing.found).toBe(false);
    expect(missing.ref).toBe("nope");

    // Empty ref → typed error.
    const bad = await conn.callTool!("fetch", { ref: "" }) as { error?: string };
    expect(bad.error).toContain("ref is required");

    // Advance past TTL → fetch returns not-found.
    now = new Date("2026-05-10T00:00:31.000Z");
    const expired = await conn.callTool!("fetch", { ref: "ref-abc" }) as { found: boolean };
    expect(expired.found).toBe(false);
  });

  it("list returns the cached refs without their bodies", async () => {
    const { InMemoryContextReferenceStore } = await import("@muse/memory");
    const store = new InMemoryContextReferenceStore();
    store.put({ content: "x".repeat(1_000), id: "r1", originalLength: 1_000, source: "tool-a" });
    store.put({ content: "y".repeat(2_000), id: "r2", originalLength: 2_000, source: "tool-b" });

    const conn = createLoopbackMcpConnection(createContextReferenceMcpServer({ store }));
    const listed = await conn.callTool!("list", {}) as {
      refs: { id: string; originalLength?: number; source?: string }[];
      total: number;
    };
    expect(listed.total).toBe(2);
    const ids = listed.refs.map((entry) => entry.id);
    expect(ids).toEqual(expect.arrayContaining(["r1", "r2"]));
    // No `content` field on the list response — only metadata.
    for (const entry of listed.refs) {
      expect((entry as { content?: string }).content).toBeUndefined();
    }
  });

  it("active is omitted when no activeContextProvider is wired", async () => {
    const { InMemoryContextReferenceStore } = await import("@muse/memory");
    const store = new InMemoryContextReferenceStore();
    const server = createContextReferenceMcpServer({ store });
    const toolNames = server.tools.map((tool) => tool.name);
    expect(toolNames).toEqual(["fetch", "list"]);
  });

  it("active resolves the snapshot and forwards userId / sessionId", async () => {
    const { InMemoryContextReferenceStore } = await import("@muse/memory");
    const store = new InMemoryContextReferenceStore();
    const received: { userId?: string; sessionId?: string } = {};
    const provider = {
      resolve(options?: { readonly userId?: string; readonly sessionId?: string } | string) {
        const opts = typeof options === "string" ? { userId: options } : options;
        if (opts?.userId) { received.userId = opts.userId; }
        if (opts?.sessionId) { received.sessionId = opts.sessionId; }
        return {
          localHour: 14,
          nowIso: "2026-05-11T05:00:00.000Z",
          timezone: "Asia/Seoul",
          weekday: "Monday"
        };
      }
    };
    const conn = createLoopbackMcpConnection(
      createContextReferenceMcpServer({ activeContextProvider: provider, store })
    );
    const result = await conn.callTool!("active", { sessionId: "session-42", userId: "alice" }) as {
      found: boolean;
      snapshot?: { timezone?: string; weekday?: string };
    };
    expect(result.found).toBe(true);
    expect(result.snapshot?.timezone).toBe("Asia/Seoul");
    expect(received).toEqual({ sessionId: "session-42", userId: "alice" });
  });

  it("active returns { found: false } when the provider returns nothing", async () => {
    const { InMemoryContextReferenceStore } = await import("@muse/memory");
    const store = new InMemoryContextReferenceStore();
    const provider = { resolve: () => undefined };
    const conn = createLoopbackMcpConnection(
      createContextReferenceMcpServer({ activeContextProvider: provider, store })
    );
    const result = await conn.callTool!("active", {}) as { found: boolean };
    expect(result.found).toBe(false);
  });
});

describe("muse.messaging loopback server", () => {
  it("exposes providers + send tools backed by the registry", async () => {
    const { MessagingProviderRegistry, TelegramProvider } = await import("@muse/messaging");
    let seenUrl = "";
    let seenBody = "";
    const tg = new TelegramProvider({
      baseUrl: "https://tg.test",
      fetch: async (url, init) => {
        seenUrl = String(url);
        seenBody = String(init?.body);
        return new Response(JSON.stringify({ ok: true, result: { message_id: 42 } }), { status: 200 });
      },
      token: "FAKE-TOKEN"
    });
    const registry = new MessagingProviderRegistry([tg]);
    const server = createMessagingMcpServer({ registry });
    const connection = createLoopbackMcpConnection(server);

    const tools = await connection.listTools();
    expect(tools.map((entry) => entry.name)).toEqual(expect.arrayContaining(["providers", "send", "inbox"]));

    const list = await connection.callTool!("providers", {});
    expect(list).toMatchObject({ providers: [{ id: "telegram", displayName: "Telegram" }] });

    // Outbound-safety: a messaging server built WITHOUT approval-gate + action-log
    // wiring must REFUSE to send (fail-closed) — never transmit unguarded to a
    // third party. The contract-faithful HTTP fake proves NO external effect: the
    // Telegram endpoint is never hit.
    const sent = await connection.callTool!("send", {
      destination: "@me",
      providerId: "telegram",
      text: "hi"
    });
    expect(sent).toMatchObject({ refused: true });
    expect(String(sent.error)).toMatch(/refusing to send unguarded/);
    expect(seenUrl).toBe(""); // no HTTP call was made — fail-closed, no external effect
    expect(seenBody).toBe("");
  });

  it("errors (no send) when NO messaging provider is configured", async () => {
    const { MessagingProviderRegistry } = await import("@muse/messaging");
    const server = createMessagingMcpServer({ registry: new MessagingProviderRegistry() });
    const connection = createLoopbackMcpConnection(server);

    const result = await connection.callTool!("send", {
      destination: "x",
      providerId: "telegram",
      text: "hi"
    });
    expect(result).toMatchObject({ error: expect.stringContaining("no messaging provider is configured") });
  });

  it("rejects empty input fields without calling the provider", async () => {
    const { MessagingProviderRegistry, TelegramProvider } = await import("@muse/messaging");
    let calls = 0;
    const tg = new TelegramProvider({
      fetch: async () => {
        calls += 1;
        return new Response("{}");
      },
      token: "x"
    });
    const server = createMessagingMcpServer({ registry: new MessagingProviderRegistry([tg]) });
    const connection = createLoopbackMcpConnection(server);

    await expect(connection.callTool!("send", { destination: "x", providerId: "telegram", text: "" }))
      .resolves.toMatchObject({ error: expect.stringContaining("text is required") });
    await expect(connection.callTool!("send", { destination: "", providerId: "telegram", text: "hi" }))
      .resolves.toMatchObject({ error: expect.stringContaining("destination is required") });
    // The empty-field checks short-circuit BEFORE provider resolution → the provider is never called.
    expect(calls).toBe(0);
  });

  it("inbox routes through registry.fetchInbound and returns the mapped messages", async () => {
    const { MessagingProviderRegistry, TelegramProvider } = await import("@muse/messaging");
    let seenLimit = "";
    const tg = new TelegramProvider({
      baseUrl: "https://tg.test",
      fetch: async (url) => {
        const u = String(url);
        const match = u.match(/limit=(\d+)/u);
        seenLimit = match ? match[1]! : "";
        return new Response(JSON.stringify({
          ok: true,
          result: [{
            message: {
              chat: { id: 42, username: "stark" },
              date: 1700000000,
              from: { username: "stark97" },
              message_id: 1,
              text: "ping"
            },
            update_id: 1
          }]
        }));
      },
      token: "TOKEN"
    });
    const server = createMessagingMcpServer({ registry: new MessagingProviderRegistry([tg]) });
    const connection = createLoopbackMcpConnection(server);

    const result = await connection.callTool!("inbox", { limit: 5, providerId: "telegram" });
    expect(seenLimit).toBe("5");
    expect(result).toMatchObject({ providerId: "telegram", total: 1 });
    const inbound = (result.inbound as Array<{ messageId: string; sender?: string; text: string }>);
    expect(inbound[0]).toMatchObject({ messageId: "1", sender: "stark97", text: "ping" });
  });

  it("inbox surfaces 'not supported' as a structured error when the provider lacks fetchInbound", async () => {
    // All four shipped providers now implement fetchInbound. The
    // guard still matters for future providers added without
    // inbound; assert via a minimal stub.
    const { MessagingProviderRegistry } = await import("@muse/messaging");
    const stub = {
      describe: () => ({ description: "stub", displayName: "Stub", id: "stub" }),
      id: "stub",
      send: async () => { throw new Error("not used"); }
    } as unknown as Parameters<typeof MessagingProviderRegistry.prototype.register>[0];
    const server = createMessagingMcpServer({ registry: new MessagingProviderRegistry([stub]) });
    const connection = createLoopbackMcpConnection(server);

    const result = await connection.callTool!("inbox", { providerId: "stub" });
    expect(result).toMatchObject({
      error: expect.stringContaining("does not support inbound"),
      providerErrorCode: "UPSTREAM_FAILED"
    });
  });

  it("muse.messaging.poll_now is hidden when no pollNow dispatcher is supplied", async () => {
    const { MessagingProviderRegistry } = await import("@muse/messaging");
    const server = createMessagingMcpServer({ registry: new MessagingProviderRegistry() });
    const connection = createLoopbackMcpConnection(server);
    const tools = await connection.listTools();
    expect(tools.map((t) => t.name)).not.toContain("poll_now");
  });

  it("muse.messaging.poll_now invokes the supplied dispatcher and returns ingested count", async () => {
    const { MessagingProviderRegistry } = await import("@muse/messaging");
    const calls: { providerId: string; source?: string }[] = [];
    const server = createMessagingMcpServer({
      pollNow: async (providerId, source) => {
        calls.push({ providerId, ...(source !== undefined ? { source } : {}) });
        return { ingested: 3 };
      },
      registry: new MessagingProviderRegistry()
    });
    const connection = createLoopbackMcpConnection(server);
    const tools = await connection.listTools();
    expect(tools.map((t) => t.name)).toContain("poll_now");
    const result = await connection.callTool!("poll_now", { providerId: "telegram" });
    expect(result).toMatchObject({ ingested: 3, providerId: "telegram" });
    expect(calls).toEqual([{ providerId: "telegram" }]);
    const withSource = await connection.callTool!("poll_now", { providerId: "discord", source: "ch-9" });
    expect(withSource).toMatchObject({ ingested: 3, providerId: "discord" });
    expect(calls[1]).toEqual({ providerId: "discord", source: "ch-9" });
  });

  it("muse.messaging.poll_now surfaces dispatcher errors as structured tool errors", async () => {
    const { MessagingProviderRegistry } = await import("@muse/messaging");
    const server = createMessagingMcpServer({
      pollNow: async () => { throw new Error("source (channel id) is required for discord"); },
      registry: new MessagingProviderRegistry()
    });
    const connection = createLoopbackMcpConnection(server);
    const result = await connection.callTool!("poll_now", { providerId: "discord" });
    expect(result).toMatchObject({
      error: expect.stringContaining("source (channel id) is required")
    });
  });

  it("muse.messaging.poll_all is hidden when no pollAll dispatcher is supplied", async () => {
    const { MessagingProviderRegistry } = await import("@muse/messaging");
    const server = createMessagingMcpServer({ registry: new MessagingProviderRegistry() });
    const connection = createLoopbackMcpConnection(server);
    const tools = await connection.listTools();
    expect(tools.map((t) => t.name)).not.toContain("poll_all");
  });

  it("muse.messaging.poll_all invokes the supplied dispatcher and returns per-provider counts", async () => {
    const { MessagingProviderRegistry } = await import("@muse/messaging");
    let calls = 0;
    const server = createMessagingMcpServer({
      pollAll: async () => {
        calls += 1;
        return {
          errors: [{ message: "channel ch-bad: not_found", providerId: "discord" }],
          ingestedByProvider: { discord: 1, slack: 0, telegram: 3 }
        };
      },
      registry: new MessagingProviderRegistry()
    });
    const connection = createLoopbackMcpConnection(server);
    const tools = await connection.listTools();
    expect(tools.map((t) => t.name)).toContain("poll_all");
    const result = await connection.callTool!("poll_all", {});
    expect(result).toMatchObject({
      ingestedByProvider: { discord: 1, slack: 0, telegram: 3 },
      errors: [{ providerId: "discord", message: expect.stringContaining("not_found") }]
    });
    expect(calls).toBe(1);
  });

  it("muse.messaging.poll_now rejects calls without providerId before invoking the dispatcher", async () => {
    const { MessagingProviderRegistry } = await import("@muse/messaging");
    let called = 0;
    const server = createMessagingMcpServer({
      pollNow: async () => { called += 1; return { ingested: 0 }; },
      registry: new MessagingProviderRegistry()
    });
    const connection = createLoopbackMcpConnection(server);
    const result = await connection.callTool!("poll_now", {});
    expect(result).toMatchObject({ error: expect.stringContaining("providerId") });
    expect(called).toBe(0);
  });
});

describe("parseReminderVia", () => {
  it("returns undefined when input is undefined (caller spreads result optionally)", async () => {
    const { parseReminderVia } = await import("../src/index.js");
    expect(parseReminderVia(undefined)).toBeUndefined();
  });

  it("trims and returns the cleaned ReminderVia on valid input", async () => {
    const { parseReminderVia } = await import("../src/index.js");
    expect(parseReminderVia({ destination: "  C123  ", providerId: " slack " })).toEqual({
      destination: "C123",
      providerId: "slack"
    });
  });

  it("returns an Error explaining the rejection branches", async () => {
    const { parseReminderVia } = await import("../src/index.js");
    expect(parseReminderVia(null)).toBeInstanceOf(Error);
    expect(parseReminderVia("string")).toBeInstanceOf(Error);
    expect(parseReminderVia({ destination: "x" })).toMatchObject({ message: expect.stringContaining("non-empty") });
    expect(parseReminderVia({ destination: "", providerId: "slack" })).toMatchObject({
      message: expect.stringContaining("non-empty")
    });
    expect(parseReminderVia({ destination: "   ", providerId: "slack" })).toMatchObject({
      message: expect.stringContaining("non-empty")
    });
  });
});

describe("muse.reminders loopback server", () => {
  it("supports the add → due → clear lifecycle with relative dueAt", async () => {
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "muse-rem-"));
    let counter = 0;
    const fixedNow = new Date("2026-05-11T08:00:00Z");
    const server = createRemindersMcpServer({
      file: join(dir, "reminders.json"),
      idFactory: () => `rem_${++counter}`,
      now: () => fixedNow
    });
    const connection = createLoopbackMcpConnection(server);

    const added = await connection.callTool!("add", {
      dueAt: "2026-05-11T07:00:00Z", // overdue relative to fixedNow
      text: "Buy milk"
    });
    expect(added).toMatchObject({
      reminder: {
        dueAt: "2026-05-11T07:00:00.000Z",
        id: "rem_1",
        status: "pending",
        text: "Buy milk"
      }
    });

    const future = await connection.callTool!("add", {
      dueAt: "2026-05-12T09:00:00Z",
      text: "Pay rent"
    });
    expect(future).toMatchObject({ reminder: { id: "rem_2", status: "pending" } });

    const due = await connection.callTool!("list", { status: "due" });
    expect(due).toMatchObject({ status: "due", total: 1 });
    expect((due.reminders as Array<{ id: string }>)[0]?.id).toBe("rem_1");

    const all = await connection.callTool!("list", { status: "all" });
    expect(all).toMatchObject({ status: "all", total: 2 });

    const removed = await connection.callTool!("clear", { id: "rem_1" });
    expect(removed).toMatchObject({ id: "rem_1", removed: true });

    const after = await connection.callTool!("list", { status: "all" });
    expect(after).toMatchObject({ total: 1 });
  });

  it("records a time-parse weakness when a reminder `add` dueAt FAILS to parse (the agent-path sibling of `calendar add`, fire 26 follow-up)", async () => {
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { readWeaknesses } = await import("@muse/stores");
    const dir = mkdtempSync(join(tmpdir(), "muse-rem-tp-"));
    const weaknessesFile = join(dir, "weaknesses.json");
    const server = createRemindersMcpServer({ file: join(dir, "reminders.json"), weaknessesFile });
    const connection = createLoopbackMcpConnection(server);
    const bad = await connection.callTool!("add", { dueAt: "blarghday at quux o'clock", text: "Buy milk" });
    expect(bad).toHaveProperty("error");
    expect((await readWeaknesses(weaknessesFile)).some((e) => e.axis === "time-parse")).toBe(true);
    // a VALID dueAt records nothing
    await connection.callTool!("add", { dueAt: "2026-05-12T09:00:00Z", text: "Pay rent" });
    expect((await readWeaknesses(weaknessesFile)).filter((e) => e.axis === "time-parse")).toHaveLength(1);

    // SIBLING: snooze with an unparseable dueAt records the same time-parse signal
    const created = await connection.callTool!("add", { dueAt: "2026-05-12T09:00:00Z", text: "Renew" });
    const rid = (created.reminder as { id: string }).id;
    const snoozed = await connection.callTool!("snooze", { dueAt: "flurbsday at norp o'clock", id: rid });
    expect(snoozed).toHaveProperty("error");
    expect((await readWeaknesses(weaknessesFile)).filter((e) => e.axis === "time-parse")).toHaveLength(2);
  });

  it("returns structured errors for invalid input + missing ids", async () => {
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "muse-rem-err-"));
    const connection = createLoopbackMcpConnection(createRemindersMcpServer({ file: join(dir, "reminders.json") }));

    const noText = await connection.callTool!("add", { dueAt: "2026-05-11T07:00:00Z" });
    expect(noText).toMatchObject({ error: expect.stringContaining("text is required") });

    const noDue = await connection.callTool!("add", { text: "x" });
    expect(noDue).toMatchObject({ error: expect.stringContaining("dueAt is required") });

    const badPhrase = await connection.callTool!("add", { dueAt: "lolwhen", text: "x" });
    expect(badPhrase).toMatchObject({ error: expect.stringContaining("ISO-8601") });

    const missing = await connection.callTool!("clear", { id: "rem_does_not_exist" });
    expect(missing).toMatchObject({ error: expect.stringContaining("not found") });

    const noQuery = await connection.callTool!("search", {});
    expect(noQuery).toMatchObject({ error: expect.stringContaining("query is required") });
  });

  it("a failed clear (ambiguous word OR unknown ref) deletes NOTHING — the populated store is left intact", async () => {
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "muse-rem-clear-"));
    let counter = 0;
    const connection = createLoopbackMcpConnection(
      createRemindersMcpServer({ file: join(dir, "reminders.json"), idFactory: () => `rem_${++counter}` })
    );
    await connection.callTool!("add", { dueAt: "2026-05-12T09:00:00Z", text: "dentist appointment" });
    await connection.callTool!("add", { dueAt: "2026-05-13T09:00:00Z", text: "dentist follow-up" });
    await connection.callTool!("add", { dueAt: "2026-05-14T09:00:00Z", text: "buy milk" });

    // An ambiguous WORD ("dentist" matches two) must return candidates, not delete a guess.
    const ambiguous = await connection.callTool!("clear", { id: "dentist" });
    expect(ambiguous).toMatchObject({ error: expect.stringContaining("multiple") });
    expect((ambiguous.candidates as unknown[]).length).toBe(2);
    expect(await connection.callTool!("list", { status: "all" })).toMatchObject({ total: 3 });

    // An unknown ref must error WITHOUT touching the store.
    const unknown = await connection.callTool!("clear", { id: "passport" });
    expect(unknown).toMatchObject({ error: expect.stringContaining("not found") });
    expect(await connection.callTool!("list", { status: "all" })).toMatchObject({ total: 3 });
  });

  it("a failed snooze (ambiguous word OR unknown ref) bumps NO reminder's dueAt — the store is left intact", async () => {
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "muse-rem-snooze-"));
    let counter = 0;
    const connection = createLoopbackMcpConnection(
      // A FIXED now so that, had a guess-and-snooze regression fired, the bumped
      // dueAt would land on this now-anchored value — distinct from every seeded
      // dueAt, so the unchanged-assertion below would catch it.
      createRemindersMcpServer({ file: join(dir, "reminders.json"), idFactory: () => `rem_${++counter}`, now: () => new Date("2026-05-11T08:00:00Z") })
    );
    await connection.callTool!("add", { dueAt: "2026-05-12T09:00:00Z", text: "dentist appointment" });
    await connection.callTool!("add", { dueAt: "2026-05-13T09:00:00Z", text: "dentist follow-up" });
    await connection.callTool!("add", { dueAt: "2026-05-14T09:00:00Z", text: "buy milk" });

    const dueByText = async (): Promise<Record<string, string>> => {
      const all = await connection.callTool!("list", { status: "all" });
      return Object.fromEntries((all.reminders as Array<{ text: string; dueAt: string }>).map((r) => [r.text, r.dueAt]));
    };
    const original = {
      "dentist appointment": "2026-05-12T09:00:00.000Z",
      "dentist follow-up": "2026-05-13T09:00:00.000Z",
      "buy milk": "2026-05-14T09:00:00.000Z"
    };
    expect(await dueByText()).toEqual(original);

    // An ambiguous WORD ("dentist" matches two) must return candidates, not snooze a guess.
    const ambiguous = await connection.callTool!("snooze", { id: "dentist" });
    expect(ambiguous).toMatchObject({ error: expect.stringContaining("multiple") });
    expect((ambiguous.candidates as unknown[]).length).toBe(2);
    expect(await dueByText()).toEqual(original);

    // An unknown ref must error WITHOUT bumping any dueAt.
    const unknown = await connection.callTool!("snooze", { id: "passport" });
    expect(unknown).toMatchObject({ error: expect.stringContaining("not found") });
    expect(await dueByText()).toEqual(original);
  });

  it("a failed fire (ambiguous word OR unknown ref) flips NO reminder's status — all stay pending", async () => {
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "muse-rem-fire-"));
    let counter = 0;
    const connection = createLoopbackMcpConnection(
      createRemindersMcpServer({ file: join(dir, "reminders.json"), idFactory: () => `rem_${++counter}` })
    );
    await connection.callTool!("add", { dueAt: "2026-05-12T09:00:00Z", text: "dentist appointment" });
    await connection.callTool!("add", { dueAt: "2026-05-13T09:00:00Z", text: "dentist follow-up" });
    await connection.callTool!("add", { dueAt: "2026-05-14T09:00:00Z", text: "buy milk" });

    const statusByText = async (): Promise<Record<string, string>> => {
      const all = await connection.callTool!("list", { status: "all" });
      return Object.fromEntries((all.reminders as Array<{ text: string; status: string }>).map((r) => [r.text, r.status]));
    };
    const allPending = { "dentist appointment": "pending", "dentist follow-up": "pending", "buy milk": "pending" };
    expect(await statusByText()).toEqual(allPending);

    // An ambiguous WORD ("dentist" matches two) must return candidates, not fire a guess.
    const ambiguous = await connection.callTool!("fire", { id: "dentist" });
    expect(ambiguous).toMatchObject({ error: expect.stringContaining("multiple") });
    expect((ambiguous.candidates as unknown[]).length).toBe(2);
    expect(await statusByText()).toEqual(allPending);

    // An unknown ref must error WITHOUT flipping any status to fired.
    const unknown = await connection.callTool!("fire", { id: "passport" });
    expect(unknown).toMatchObject({ error: expect.stringContaining("not found") });
    expect(await statusByText()).toEqual(allPending);
  });

  it("search greps reminder text case-insensitively, defaulting to status=all", async () => {
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "muse-rem-search-"));
    let counter = 0;
    const server = createRemindersMcpServer({
      file: join(dir, "reminders.json"),
      idFactory: () => `rem_${++counter}`,
      now: () => new Date("2026-05-11T08:00:00Z")
    });
    const connection = createLoopbackMcpConnection(server);

    await connection.callTool!("add", { dueAt: "2026-05-12T09:00:00Z", text: "Buy milk" });
    await connection.callTool!("add", { dueAt: "2026-05-13T09:00:00Z", text: "Pick up dry MILK cleaning" });
    await connection.callTool!("add", { dueAt: "2026-05-14T09:00:00Z", text: "Pay rent" });

    const milk = await connection.callTool!("search", { query: "milk" });
    expect(milk).toMatchObject({ status: "all", total: 2, query: "milk" });
    const ids = (milk.reminders as Array<{ id: string }>).map((entry) => entry.id);
    expect(ids).toEqual(["rem_1", "rem_2"]);

    const none = await connection.callTool!("search", { query: "submarine" });
    expect(none).toMatchObject({ total: 0 });

    // status filter narrows to pending only when explicitly set
    const pendingOnly = await connection.callTool!("search", { query: "milk", status: "pending" });
    expect(pendingOnly).toMatchObject({ status: "pending", total: 2 });
  });

  it("add IGNORES a model-supplied via (the chat model can't ground a delivery destination — it fabricates one)", async () => {
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "muse-rem-via-"));
    const server = createRemindersMcpServer({
      file: join(dir, "reminders.json"),
      idFactory: () => "rem_via_1",
      now: () => new Date("2026-05-11T08:00:00Z")
    });
    const connection = createLoopbackMcpConnection(server);

    // A via passed by the model is dropped — the reminder is created on the
    // user's configured default route, not a model-invented destination.
    const ok = await connection.callTool!("add", {
      dueAt: "2026-05-11T09:00:00Z",
      text: "Deploy alert",
      via: { destination: "1234567890", providerId: "telegram" }
    });
    expect(ok).toMatchObject({ reminder: { id: "rem_via_1", text: "Deploy alert" } });
    expect((ok as { reminder: Record<string, unknown> }).reminder).not.toHaveProperty("via");
  });

  it("fire flips a pending reminder to status='fired' with a timestamp", async () => {
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "muse-rem-fire-"));
    let counter = 0;
    const fixedNow = new Date("2026-05-11T08:00:00Z");
    const server = createRemindersMcpServer({
      file: join(dir, "reminders.json"),
      idFactory: () => `rem_${++counter}`,
      now: () => fixedNow
    });
    const connection = createLoopbackMcpConnection(server);

    await connection.callTool!("add", { dueAt: "2026-05-11T07:00:00Z", text: "Buy milk" });

    // Default firedAt: now.
    const fired = await connection.callTool!("fire", { id: "rem_1" });
    expect(fired).toMatchObject({
      reminder: { firedAt: "2026-05-11T08:00:00.000Z", id: "rem_1", status: "fired", text: "Buy milk" }
    });

    // After firing, `due` no longer surfaces it (status filter excludes "fired").
    const due = await connection.callTool!("list", { status: "due" });
    expect(due).toMatchObject({ total: 0 });

    // Explicit firedAt is preserved.
    await connection.callTool!("add", { dueAt: "2026-05-11T07:30:00Z", text: "Pay rent" });
    const explicit = await connection.callTool!("fire", { firedAt: "2026-05-11T09:15:00Z", id: "rem_2" });
    expect(explicit).toMatchObject({ reminder: { firedAt: "2026-05-11T09:15:00.000Z", id: "rem_2" } });

    // Missing id → error.
    const missing = await connection.callTool!("fire", { id: "rem_does_not_exist" });
    expect(missing).toMatchObject({ error: expect.stringContaining("not found") });

    // Bad firedAt → error.
    const bad = await connection.callTool!("fire", { firedAt: "lolwhen", id: "rem_2" });
    expect(bad).toMatchObject({ error: expect.stringContaining("ISO-8601") });
  });

  it("snooze bumps dueAt forward and revives fired reminders to pending", async () => {
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "muse-rem-snooze-"));
    let counter = 0;
    const fixedNow = new Date("2026-05-11T08:00:00Z");
    const server = createRemindersMcpServer({
      file: join(dir, "reminders.json"),
      idFactory: () => `rem_${++counter}`,
      now: () => fixedNow
    });
    const connection = createLoopbackMcpConnection(server);

    await connection.callTool!("add", { dueAt: "2026-05-11T07:00:00Z", text: "Buy milk" });

    // Default snooze: +10 minutes from fixedNow.
    const defaulted = await connection.callTool!("snooze", { id: "rem_1" });
    expect(defaulted).toMatchObject({
      reminder: { dueAt: "2026-05-11T08:10:00.000Z", id: "rem_1", status: "pending" }
    });

    // Explicit relative snooze.
    const explicit = await connection.callTool!("snooze", { dueAt: "in 30 minutes", id: "rem_1" });
    expect(explicit).toMatchObject({ reminder: { dueAt: "2026-05-11T08:30:00.000Z" } });

    // Missing id surfaces a clean error.
    const missing = await connection.callTool!("snooze", { id: "rem_does_not_exist" });
    expect(missing).toMatchObject({ error: expect.stringContaining("not found") });

    // Bad dueAt phrase surfaces a clean error too.
    const bad = await connection.callTool!("snooze", { dueAt: "lolwhen", id: "rem_1" });
    expect(bad).toMatchObject({ error: expect.stringContaining("ISO-8601") });
  });

  it("a time-only reschedule keeps a FUTURE reminder's date, but snoozes a firing one to today", async () => {
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "muse-rem-reschedule-"));
    let counter = 0;
    const connection = createLoopbackMcpConnection(createRemindersMcpServer({
      file: join(dir, "reminders.json"),
      idFactory: () => `rem_${++counter}`,
      now: () => new Date("2026-06-06T03:00:00.000Z") // "today"
    }));

    // FUTURE reminder (next Friday) → "오후 6시" keeps Friday, just changes the time.
    const futureIso = "2026-06-12T05:00:00.000Z";
    await connection.callTool!("add", { dueAt: futureIso, text: "약 먹기" });
    const rescheduled = await connection.callTool!("snooze", { dueAt: "오후 6시", id: "rem_1" }) as { reminder: { dueAt: string } };
    const due = new Date(rescheduled.reminder.dueAt);
    expect(due.toDateString()).toBe(new Date(futureIso).toDateString()); // DATE preserved
    expect(due.getHours()).toBe(18);

    // FIRING/overdue reminder (already past) → "오후 6시" is the ordinary snooze:
    // later TODAY, anchored to now — NOT its stale past date.
    await connection.callTool!("add", { dueAt: "2026-06-01T05:00:00.000Z", text: "운동하기" });
    const snoozed = await connection.callTool!("snooze", { dueAt: "오후 6시", id: "rem_2" }) as { reminder: { dueAt: string } };
    const snoozedDue = new Date(snoozed.reminder.dueAt);
    expect(snoozedDue.toDateString()).toBe(new Date("2026-06-06T03:00:00.000Z").toDateString()); // today, not 2026-06-01
    expect(snoozedDue.getHours()).toBe(18);
  });

  it("a DATE-only reschedule ('2026-06-20', no time) keeps the reminder's TIME-of-day", async () => {
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "muse-rem-dateonly-"));
    let counter = 0;
    const connection = createLoopbackMcpConnection(createRemindersMcpServer({
      file: join(dir, "reminders.json"),
      idFactory: () => `rem_${++counter}`,
      now: () => new Date("2026-06-06T03:00:00.000Z")
    }));
    const seedIso = "2026-06-12T05:00:00.000Z"; // Friday, a non-midnight time
    await connection.callTool!("add", { dueAt: seedIso, text: "약 먹기" });

    const moved = await connection.callTool!("snooze", { dueAt: "2026-06-20", id: "rem_1" }) as { reminder: { dueAt: string } };
    const due = new Date(moved.reminder.dueAt);
    expect(due.getHours()).toBe(new Date(seedIso).getHours()); // TIME-of-day preserved (TZ-safe)
    expect(due.getMinutes()).toBe(new Date(seedIso).getMinutes());
    expect(due.toDateString()).not.toBe(new Date(seedIso).toDateString()); // moved to a different day
    expect(due.getTime()).toBeGreaterThan(new Date(seedIso).getTime());
  });
});

describe("runDueReminders", () => {
  it("delivers due reminders, fires them, persists once at the end", async () => {
    const { runDueReminders } = await import("../src/index.js");
    const { mkdtempSync, writeFileSync, readFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "muse-fire-loop-"));
    const file = join(dir, "reminders.json");
    writeFileSync(file, JSON.stringify({
      reminders: [
        {
          createdAt: "2026-01-01T00:00:00Z",
          dueAt: "1970-01-01T00:00:00Z", // past
          id: "rem_overdue",
          status: "pending",
          text: "Buy milk"
        },
        {
          createdAt: "2026-05-11T00:00:00Z",
          dueAt: "2030-01-01T00:00:00Z", // future
          id: "rem_future",
          status: "pending",
          text: "Pay rent"
        }
      ]
    }), "utf8");

    const sent: Array<{ providerId: string; destination: string; text: string }> = [];
    const fakeRegistry = {
      send: async (providerId: string, message: { destination: string; text: string }) => {
        sent.push({ destination: message.destination, providerId, text: message.text });
        return { destination: message.destination, messageId: "stub", providerId };
      }
    };

    const summary = await runDueReminders({
      destination: "@me",
      file,
      now: () => new Date("2026-05-11T08:00:00Z"),
      providerId: "telegram",
      registry: fakeRegistry as unknown as Parameters<typeof runDueReminders>[0]["registry"]
    });

    expect(summary).toMatchObject({ delivered: 1, due: 1, errors: [] });
    expect(sent).toEqual([{ destination: "@me", providerId: "telegram", text: "Buy milk" }]);

    const persisted = JSON.parse(readFileSync(file, "utf8")) as {
      reminders: Array<{ id: string; status: string; firedAt?: string }>;
    };
    expect(persisted.reminders.find((r) => r.id === "rem_overdue")).toMatchObject({ status: "fired" });
    expect(persisted.reminders.find((r) => r.id === "rem_future")).toMatchObject({ status: "pending" });
  });

  it("readReminders drops an entry with an unparseable dueAt instead of letting it sit un-fireable", async () => {
    const { readReminders } = await import("../src/index.js");
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "muse-rem-badtime-"));
    const file = join(dir, "reminders.json");
    writeFileSync(file, JSON.stringify({
      reminders: [
        { createdAt: "2026-05-17T00:00:00Z", dueAt: "2030-01-01T00:00:00Z", id: "rem_ok", status: "pending", text: "valid" },
        { createdAt: "2026-05-17T00:00:00Z", dueAt: "tomorrow", id: "rem_bad", status: "pending", text: "corrupt" }
      ]
    }), "utf8");
    // rem_bad is excluded at load: an unparseable dueAt makes
    // filterReminders' `Date.parse(dueAt) <= now` NaN, so it would
    // never be "due", never fire, and sit "pending" forever. Drop it
    // at the type-guard — consistent + visible, not silently dead.
    expect((await readReminders(file)).map((r) => r.id)).toEqual(["rem_ok"]);
  });

  it("does not write when no reminders are due (idempotent zero-call)", async () => {
    const { runDueReminders } = await import("../src/index.js");
    const { mkdtempSync, writeFileSync, statSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "muse-fire-empty-"));
    const file = join(dir, "reminders.json");
    writeFileSync(file, JSON.stringify({ reminders: [] }), "utf8");
    const before = statSync(file).mtimeMs;
    await new Promise((resolve) => setTimeout(resolve, 5));

    const summary = await runDueReminders({
      destination: "@me",
      file,
      providerId: "telegram",
      registry: { send: async () => { throw new Error("must not be called"); } } as unknown as Parameters<typeof runDueReminders>[0]["registry"]
    });
    expect(summary).toMatchObject({ delivered: 0, due: 0, errors: [] });
    // mtime unchanged → no write happened.
    expect(statSync(file).mtimeMs).toBe(before);
  });

  it("collects per-reminder errors without aborting the loop", async () => {
    const { runDueReminders } = await import("../src/index.js");
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "muse-fire-err-"));
    const file = join(dir, "reminders.json");
    writeFileSync(file, JSON.stringify({
      reminders: [
        { createdAt: "2026-01-01T00:00:00Z", dueAt: "1970-01-01T00:00:00Z", id: "rem_a", status: "pending", text: "A" },
        { createdAt: "2026-01-01T00:00:00Z", dueAt: "1970-01-01T00:00:00Z", id: "rem_b", status: "pending", text: "B" }
      ]
    }), "utf8");

    // Goal 149 — rem_a fails non-retryably (401 bad token) so the
    // new retry path doesn't mask it. The test still demonstrates
    // "errors don't abort the loop" — rem_b still gets sent.
    const { MessagingProviderError } = await import("@muse/messaging");
    let calls = 0;
    const fakeRegistry = {
      send: async () => {
        calls += 1;
        if (calls === 1) {
          throw new MessagingProviderError("telegram", "UPSTREAM_FAILED", "upstream 401", 401);
        }
        return { destination: "@me", messageId: "ok", providerId: "telegram" };
      }
    };
    const summary = await runDueReminders({
      destination: "@me",
      file,
      providerId: "telegram",
      registry: fakeRegistry as unknown as Parameters<typeof runDueReminders>[0]["registry"]
    });
    expect(summary.delivered).toBe(1);
    expect(summary.due).toBe(2);
    expect(summary.errors).toHaveLength(1);
    expect(summary.errors[0]).toContain("rem_a");
    expect(summary.errors[0]).toContain("upstream 401");
  });

  it("persists the status flip after EACH delivery so a crash mid-tick doesn't re-fire (goal 069)", async () => {
    const { runDueReminders, readReminders } = await import("../src/index.js");
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "muse-fire-idempotent-"));
    const file = join(dir, "reminders.json");
    writeFileSync(file, JSON.stringify({
      reminders: [
        { createdAt: "2026-01-01T00:00:00Z", dueAt: "1970-01-01T00:00:00Z", id: "rem_first", status: "pending", text: "first" },
        { createdAt: "2026-01-01T00:00:00Z", dueAt: "1970-01-01T00:00:00Z", id: "rem_second", status: "pending", text: "second" }
      ]
    }));

    // Simulate "delivery #2 fails": first send succeeds (gets
    // persisted), second send throws (so its status stays pending).
    // The pre-069 behavior would lose the rem_first flip because the
    // final batched write happened only at the end of the tick.
    //
    // Goal 149 — the failure is a non-retryable MessagingProviderError
    // (401) so the new shared retry-with-backoff doesn't mask it.
    // Pre-149 a plain Error here meant a single attempt; with retry
    // wired in, plain errors would trigger 3 attempts and we'd need
    // a different sentinel for "this one always fails". Non-retryable
    // matches the spirit (a bad token mid-tick) and keeps the
    // accounting (1 delivered, 1 failed, mid-tick state persisted).
    const { MessagingProviderError } = await import("@muse/messaging");
    const sentDuringFirstTick: Array<{ destination: string; text: string }> = [];
    const flakyRegistry = {
      send: async (_providerId: string, msg: { destination: string; text: string }) => {
        sentDuringFirstTick.push({ destination: msg.destination, text: msg.text });
        if (sentDuringFirstTick.length === 2) {
          throw new MessagingProviderError(
            "telegram", "UPSTREAM_FAILED", "simulated upstream failure mid-tick", 401
          );
        }
      }
    };

    const firstSummary = await runDueReminders({
      destination: "@me",
      file,
      providerId: "telegram",
      registry: flakyRegistry as unknown as Parameters<typeof runDueReminders>[0]["registry"]
    });
    expect(firstSummary.delivered).toBe(1);
    expect(firstSummary.errors.length).toBe(1);
    // Goal 069 — the per-delivery write means rem_first is already
    // `fired` on disk even though the tick failed mid-way.
    const midTickState = await readReminders(file);
    expect(midTickState.find((e) => e.id === "rem_first")?.status).toBe("fired");
    expect(midTickState.find((e) => e.id === "rem_second")?.status).toBe("pending");

    // Restart: only the still-pending reminder fires.
    const sentAfterRestart: Array<{ destination: string }> = [];
    const fineRegistry = {
      send: async (_providerId: string, msg: { destination: string; text: string }) => {
        sentAfterRestart.push({ destination: msg.destination });
      }
    };
    const secondSummary = await runDueReminders({
      destination: "@me",
      file,
      providerId: "telegram",
      registry: fineRegistry as unknown as Parameters<typeof runDueReminders>[0]["registry"]
    });
    expect(secondSummary.delivered).toBe(1);
    expect(sentAfterRestart.length).toBe(1);
    // After both ticks, both reminders are fired exactly once.
    const finalState = await readReminders(file);
    const firedIds = finalState.filter((e) => e.status === "fired").map((e) => e.id).sort();
    expect(firedIds).toEqual(["rem_first", "rem_second"]);
  });

  it("respects per-reminder via override (Phase C); falls back to defaults when via is absent", async () => {
    const { runDueReminders } = await import("../src/index.js");
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "muse-fire-via-"));
    const file = join(dir, "reminders.json");
    writeFileSync(file, JSON.stringify({
      reminders: [
        // Has via → goes to Slack channel C123 even though defaults are telegram/@me.
        {
          createdAt: "2026-01-01T00:00:00Z",
          dueAt: "1970-01-01T00:00:00Z",
          id: "rem_via",
          status: "pending",
          text: "Deploy alert",
          via: { destination: "C123", providerId: "slack" }
        },
        // No via → uses the daemon defaults.
        {
          createdAt: "2026-01-01T00:00:00Z",
          dueAt: "1970-01-01T00:00:00Z",
          id: "rem_default",
          status: "pending",
          text: "Buy milk"
        }
      ]
    }), "utf8");

    const sent: Array<{ providerId: string; destination: string; text: string }> = [];
    const fakeRegistry = {
      send: async (providerId: string, message: { destination: string; text: string }) => {
        sent.push({ destination: message.destination, providerId, text: message.text });
        return { destination: message.destination, messageId: "stub", providerId };
      }
    };
    const summary = await runDueReminders({
      destination: "@me",
      file,
      providerId: "telegram",
      registry: fakeRegistry as unknown as Parameters<typeof runDueReminders>[0]["registry"]
    });
    expect(summary.delivered).toBe(2);
    expect(sent).toEqual(expect.arrayContaining([
      { destination: "C123", providerId: "slack", text: "Deploy alert" },
      { destination: "@me", providerId: "telegram", text: "Buy milk" }
    ]));
  });

  it("retries transient messaging failures with exponential backoff (goal 149)", async () => {
    const { runDueReminders } = await import("../src/index.js");
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "muse-fire-retry-"));
    const file = join(dir, "reminders.json");
    writeFileSync(file, JSON.stringify({
      reminders: [
        { createdAt: "2026-01-01T00:00:00Z", dueAt: "1970-01-01T00:00:00Z", id: "rem_flaky", status: "pending", text: "Standup" }
      ]
    }), "utf8");

    // First two sends throw (plain Error → looks like a transient
    // 5xx / network blip to sendWithRetry); third succeeds. Pre-149
    // this would have been recorded as a single failure even though
    // the next attempt would have landed.
    const attempts: string[] = [];
    const flakyRegistry = {
      send: async (providerId: string, msg: { destination: string; text: string }) => {
        attempts.push(`${providerId}:${msg.destination}`);
        if (attempts.length < 3) {
          throw new Error("upstream 503");
        }
        return { destination: msg.destination, messageId: "ok", providerId };
      }
    };

    const summary = await runDueReminders({
      destination: "@me",
      file,
      providerId: "telegram",
      registry: flakyRegistry as unknown as Parameters<typeof runDueReminders>[0]["registry"]
    });
    expect(summary.delivered).toBe(1);
    expect(summary.errors).toEqual([]);
    expect(attempts.length).toBe(3);
  });

  it("breaks out of the retry loop early on non-retryable messaging errors (goal 149)", async () => {
    const { runDueReminders } = await import("../src/index.js");
    const { MessagingProviderError } = await import("@muse/messaging");
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "muse-fire-non-retry-"));
    const file = join(dir, "reminders.json");
    writeFileSync(file, JSON.stringify({
      reminders: [
        { createdAt: "2026-01-01T00:00:00Z", dueAt: "1970-01-01T00:00:00Z", id: "rem_permanent", status: "pending", text: "Standup" }
      ]
    }), "utf8");

    let attempts = 0;
    const alwaysFailing = {
      send: async (_pid: string, _msg: { destination: string; text: string }) => {
        attempts += 1;
        throw new MessagingProviderError(
          "telegram", "UPSTREAM_FAILED", "401 bad token", 401
        );
      }
    };

    const summary = await runDueReminders({
      destination: "@me",
      file,
      providerId: "telegram",
      registry: alwaysFailing as unknown as Parameters<typeof runDueReminders>[0]["registry"]
    });
    expect(summary.delivered).toBe(0);
    expect(summary.errors).toHaveLength(1);
    expect(summary.errors[0]).toContain("rem_permanent");
    expect(summary.errors[0]).toContain("401 bad token");
    expect(attempts).toBe(1);
  });
});

describe("corrupt-store quarantine — reminders + followups + history audit logs", () => {
  it("readReminders quarantines a corrupt file instead of destroying it on next write", async () => {
    const { readReminders, writeReminders } = await import("../src/index.js");
    const { mkdtempSync, writeFileSync, readdirSync, readFileSync } = await import("node:fs");
    const tmpdir = await import("node:os").then((m) => m.tmpdir());
    const dir = mkdtempSync(`${tmpdir}/muse-rem-quarantine-`);
    const file = `${dir}/reminders.json`;
    const original = `{"reminders":[{"id":"r_keep","text":"important","status":"pending","createdAt":"2026-01-01T00:00:00Z"}]} GARBAGE`;
    writeFileSync(file, original);

    expect(await readReminders(file)).toEqual([]);
    const quar = readdirSync(dir).filter((n) => n.startsWith("reminders.json.corrupt-"));
    expect(quar).toHaveLength(1);
    expect(readFileSync(`${dir}/${quar[0]!}`, "utf8")).toBe(original);

    await writeReminders(file, [
      { id: "r_new", text: "new", dueAt: "2030-01-01T00:00:00Z", status: "pending", createdAt: "2026-05-16T00:00:00Z" }
    ]);
    expect((await readReminders(file)).map((r) => r.id)).toEqual(["r_new"]);
    expect(readdirSync(dir).filter((n) => n.startsWith("reminders.json.corrupt-"))).toHaveLength(1);
  });

  it("readFollowups quarantines a corrupt file instead of destroying it on next write", async () => {
    const { readFollowups, writeFollowups } = await import("../src/index.js");
    const { mkdtempSync, writeFileSync, readdirSync, readFileSync } = await import("node:fs");
    const tmpdir = await import("node:os").then((m) => m.tmpdir());
    const dir = mkdtempSync(`${tmpdir}/muse-fu-quarantine-`);
    const file = `${dir}/followups.json`;
    const original = `{"followups":[{"id":"fu_keep","userId":"stark","summary":"keep","scheduledFor":"2030-01-01T00:00:00Z","status":"scheduled","createdAt":"2026-01-01T00:00:00Z"}]} GARBAGE`;
    writeFileSync(file, original);

    expect(await readFollowups(file)).toEqual([]);
    const quar = readdirSync(dir).filter((n) => n.startsWith("followups.json.corrupt-"));
    expect(quar).toHaveLength(1);
    expect(readFileSync(`${dir}/${quar[0]!}`, "utf8")).toBe(original);

    await writeFollowups(file, [
      { id: "fu_new", userId: "stark", summary: "new", scheduledFor: "2030-02-01T00:00:00Z", status: "scheduled", createdAt: "2026-05-16T00:00:00Z" }
    ]);
    expect((await readFollowups(file)).map((f) => f.id)).toEqual(["fu_new"]);
  });

  it("readProactiveHistory quarantines a corrupt audit log instead of destroying it on next append", async () => {
    const { readProactiveHistory, appendProactiveHistory } = await import("../src/index.js");
    const { mkdtempSync, writeFileSync, readdirSync, readFileSync } = await import("node:fs");
    const tmpdir = await import("node:os").then((m) => m.tmpdir());
    const dir = mkdtempSync(`${tmpdir}/muse-ph-quarantine-`);
    const file = `${dir}/proactive-history.json`;
    const original = `{"version":1,"entries":[{"kind":"task","itemId":"keep"}]} GARBAGE`;
    writeFileSync(file, original);

    expect(await readProactiveHistory(file)).toEqual([]);
    const quar = readdirSync(dir).filter((n) => n.startsWith("proactive-history.json.corrupt-"));
    expect(quar).toHaveLength(1);
    expect(readFileSync(`${dir}/${quar[0]!}`, "utf8")).toBe(original);

    await appendProactiveHistory(file, {
      destination: "555",
      firedAtIso: "2026-05-16T00:00:00Z",
      itemId: "t1",
      kind: "task",
      providerId: "telegram",
      startIso: "2030-01-01T00:00:00Z",
      status: "delivered",
      text: "hi",
      title: "t"
    });
    expect((await readProactiveHistory(file)).map((e) => e.itemId)).toEqual(["t1"]);
    expect(readdirSync(dir).filter((n) => n.startsWith("proactive-history.json.corrupt-"))).toHaveLength(1);
  });

  it("readReminderHistory quarantines a corrupt audit log instead of destroying it on next append", async () => {
    const { readReminderHistory, appendReminderHistory } = await import("../src/index.js");
    const { mkdtempSync, writeFileSync, readdirSync, readFileSync } = await import("node:fs");
    const tmpdir = await import("node:os").then((m) => m.tmpdir());
    const dir = mkdtempSync(`${tmpdir}/muse-rh-quarantine-`);
    const file = `${dir}/reminder-history.json`;
    const original = `{"version":1,"entries":[{"reminderId":"keep"}]} GARBAGE`;
    writeFileSync(file, original);

    expect(await readReminderHistory(file)).toEqual([]);
    const quar = readdirSync(dir).filter((n) => n.startsWith("reminder-history.json.corrupt-"));
    expect(quar).toHaveLength(1);
    expect(readFileSync(`${dir}/${quar[0]!}`, "utf8")).toBe(original);

    await appendReminderHistory(file, {
      destination: "555",
      firedAtIso: "2026-05-16T00:00:00Z",
      providerId: "telegram",
      reminderId: "r1",
      status: "delivered",
      text: "hi"
    });
    expect((await readReminderHistory(file)).map((e) => e.reminderId)).toEqual(["r1"]);
    expect(readdirSync(dir).filter((n) => n.startsWith("reminder-history.json.corrupt-"))).toHaveLength(1);
  });

  it("a MISSING history file is NOT quarantined (absence is not corruption)", async () => {
    const { readProactiveHistory, readReminderHistory } = await import("../src/index.js");
    const { mkdtempSync, readdirSync } = await import("node:fs");
    const tmpdir = await import("node:os").then((m) => m.tmpdir());
    const dir = mkdtempSync(`${tmpdir}/muse-hist-missing-`);
    expect(await readProactiveHistory(`${dir}/proactive-history.json`)).toEqual([]);
    expect(await readReminderHistory(`${dir}/reminder-history.json`)).toEqual([]);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("readFollowups drops an entry with an unparseable scheduledFor instead of letting it sit un-fireable", async () => {
    const { readFollowups } = await import("../src/index.js");
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const tmpdir = await import("node:os").then((m) => m.tmpdir());
    const dir = mkdtempSync(`${tmpdir}/muse-fu-badtime-`);
    const file = `${dir}/followups.json`;
    writeFileSync(file, JSON.stringify({
      followups: [
        { id: "fu_ok", userId: "stark", summary: "valid", scheduledFor: "2030-01-01T00:00:00Z", status: "scheduled", createdAt: "2026-05-17T00:00:00Z" },
        { id: "fu_bad", userId: "stark", summary: "corrupt", scheduledFor: "tomorrow", status: "scheduled", createdAt: "2026-05-17T00:00:00Z" }
      ]
    }));
    // fu_bad is excluded at load: an unparseable scheduledFor makes
    // the firing loop's `Date.parse(scheduledFor) <= now` NaN, so it
    // would never fire and sit "scheduled" forever. Dropping it at
    // the type-guard is consistent + visible (gone everywhere) rather
    // than silently un-fireable while still listed.
    expect((await readFollowups(file)).map((f) => f.id)).toEqual(["fu_ok"]);
  });

  it("readEpisodes quarantines a corrupt store so upsert doesn't wipe episodic memory", async () => {
    const { readEpisodes, upsertEpisode } = await import("../src/index.js");
    const { mkdtempSync, writeFileSync, readdirSync, readFileSync } = await import("node:fs");
    const tmpdir = await import("node:os").then((m) => m.tmpdir());
    const dir = mkdtempSync(`${tmpdir}/muse-ep-quarantine-`);
    const file = `${dir}/episodes.json`;
    const original = `{"episodes":[{"id":"ep_keep","userId":"stark","startedAt":"2026-01-01T00:00:00Z","endedAt":"2026-01-01T01:00:00Z","summary":"do not lose me"}]} GARBAGE`;
    writeFileSync(file, original);

    expect(await readEpisodes(file)).toEqual([]);
    const quar = readdirSync(dir).filter((n) => n.startsWith("episodes.json.corrupt-"));
    expect(quar).toHaveLength(1);
    expect(readFileSync(`${dir}/${quar[0]!}`, "utf8")).toBe(original);

    await upsertEpisode(file, {
      id: "ep_new",
      userId: "stark",
      startedAt: "2026-05-16T00:00:00Z",
      endedAt: "2026-05-16T01:00:00Z",
      summary: "new session"
    });
    expect((await readEpisodes(file)).map((e) => e.id)).toEqual(["ep_new"]);
    expect(readdirSync(dir).filter((n) => n.startsWith("episodes.json.corrupt-"))).toHaveLength(1);
  });
});

describe("reminder-history-store", () => {
  it("readReminderHistory returns empty for missing or malformed files", async () => {
    const { readReminderHistory } = await import("../src/index.js");
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "muse-rem-hist-"));
    expect(await readReminderHistory(join(dir, "missing.json"))).toEqual([]);
    const garbage = join(dir, "garbage.json");
    const { promises: fs } = await import("node:fs");
    await fs.writeFile(garbage, "not json", "utf8");
    expect(await readReminderHistory(garbage)).toEqual([]);
  });

  it("appends entries (newest-last on disk) and reads newest-first with limit", async () => {
    const { appendReminderHistory, readReminderHistory } = await import("../src/index.js");
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "muse-rem-hist-"));
    const file = join(dir, "h.json");
    await appendReminderHistory(file, {
      destination: "@me",
      firedAtIso: "2026-05-11T08:00:00.000Z",
      providerId: "telegram",
      reminderId: "rem_1",
      status: "delivered",
      text: "Buy milk"
    });
    await appendReminderHistory(file, {
      destination: "@me",
      error: "503",
      firedAtIso: "2026-05-11T09:00:00.000Z",
      providerId: "telegram",
      reminderId: "rem_2",
      status: "failed",
      text: "Pay rent"
    });
    const entries = await readReminderHistory(file);
    expect(entries.map((e) => e.reminderId)).toEqual(["rem_2", "rem_1"]);
    expect(entries[0]).toMatchObject({ error: "503", status: "failed" });
    const limited = await readReminderHistory(file, 1);
    expect(limited.map((e) => e.reminderId)).toEqual(["rem_2"]);
  });
});

describe("runDueReminders Phase D (agent synthesis)", () => {
  function seedReminders(file: string): void {
    const { writeFileSync } = require("node:fs") as typeof import("node:fs");
    writeFileSync(file, JSON.stringify({
      reminders: [{
        createdAt: "2026-05-12T00:00:00Z",
        dueAt: "1970-01-01T00:00:00Z", // past = due
        id: "rem_phaseD",
        status: "pending",
        text: "Pay rent"
      }]
    }), "utf8");
  }

  function makeFakeRegistry() {
    const sent: Array<{ providerId: string; destination: string; text: string }> = [];
    return {
      registry: {
        send: async (providerId: string, message: { destination: string; text: string }) => {
          sent.push({ destination: message.destination, providerId, text: message.text });
          return { destination: message.destination, messageId: "stub", providerId };
        }
      },
      sent
    };
  }

  it("synthesises the reminder text via agent when activity window is fresh", async () => {
    const { runDueReminders } = await import("../src/index.js");
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "muse-reminder-phaseD-"));
    const file = join(dir, "reminders.json");
    seedReminders(file);

    const fixedNow = new Date("2026-05-11T08:00:00Z");
    const runCalls: Array<{ model: string; userMessage: string }> = [];
    const agentRuntime = {
      run: async (input: { model: string; messages: readonly { role: string; content: string }[] }) => {
        const userMessage = input.messages.find((m) => m.role === "user")?.content ?? "";
        runCalls.push({ model: input.model, userMessage });
        return { response: { output: "Rent is due — want me to open the bank transfer page?" } };
      }
    };
    const activitySource = { lastActivityMs: () => fixedNow.getTime() - 30_000 };
    const msg = makeFakeRegistry();

    const summary = await runDueReminders({
      activeSessionWindowMs: 5 * 60_000,
      activitySource,
      agentModel: "claude-opus-4-7",
      agentRuntime,
      destination: "@me",
      file,
      now: () => fixedNow,
      providerId: "telegram",
      registry: msg.registry as unknown as Parameters<typeof runDueReminders>[0]["registry"]
    });
    expect(summary).toMatchObject({ delivered: 1, errors: [] });
    expect(runCalls).toHaveLength(1);
    expect(runCalls[0]!.userMessage).toContain("Pay rent");
    expect(msg.sent[0]?.text).toBe("Rent is due — want me to open the bank transfer page?");
  });

  it("falls back to flat text when activity window has lapsed", async () => {
    const { runDueReminders } = await import("../src/index.js");
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "muse-reminder-phaseD-stale-"));
    const file = join(dir, "reminders.json");
    seedReminders(file);

    const fixedNow = new Date("2026-05-11T08:00:00Z");
    let agentCalled = false;
    const agentRuntime = {
      run: async () => {
        agentCalled = true;
        return { response: { output: "(should not be used)" } };
      }
    };
    const activitySource = { lastActivityMs: () => fixedNow.getTime() - 30 * 60_000 };
    const msg = makeFakeRegistry();
    await runDueReminders({
      activitySource,
      agentModel: "claude-opus-4-7",
      agentRuntime,
      destination: "@me",
      file,
      now: () => fixedNow,
      providerId: "telegram",
      registry: msg.registry as unknown as Parameters<typeof runDueReminders>[0]["registry"]
    });
    expect(agentCalled).toBe(false);
    expect(msg.sent[0]?.text).toBe("Pay rent");
  });

  it("records the synthesis error in summary + still delivers the flat text", async () => {
    const { runDueReminders } = await import("../src/index.js");
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "muse-reminder-phaseD-err-"));
    const file = join(dir, "reminders.json");
    seedReminders(file);

    const fixedNow = new Date("2026-05-11T08:00:00Z");
    const agentRuntime = {
      run: async () => { throw new Error("model timeout"); }
    };
    const activitySource = { lastActivityMs: () => fixedNow.getTime() - 1_000 };
    const msg = makeFakeRegistry();
    const summary = await runDueReminders({
      activitySource,
      agentModel: "claude-opus-4-7",
      agentRuntime,
      destination: "@me",
      file,
      now: () => fixedNow,
      providerId: "telegram",
      registry: msg.registry as unknown as Parameters<typeof runDueReminders>[0]["registry"]
    });
    expect(summary.delivered).toBe(1); // still fires
    expect(msg.sent[0]?.text).toBe("Pay rent"); // flat fallback
    expect(summary.errors.some((e) => e.includes("model timeout"))).toBe(true);
  });
});

describe("runDueReminders historyFile", () => {
  it("appends a 'delivered' entry on success and a 'failed' entry with error on failure", async () => {
    const { runDueReminders, readReminderHistory } = await import("../src/index.js");
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "muse-rem-hist-fire-"));
    const file = join(dir, "reminders.json");
    const historyFile = join(dir, "history.json");
    writeFileSync(file, JSON.stringify({
      reminders: [
        { createdAt: "2026-01-01T00:00:00Z", dueAt: "1970-01-01T00:00:00Z", id: "rem_ok", status: "pending", text: "OK" },
        { createdAt: "2026-01-01T00:00:00Z", dueAt: "1970-01-01T00:00:00Z", id: "rem_fail", status: "pending", text: "FAIL" }
      ]
    }), "utf8");
    // Goal 149 — rem_fail throws a non-retryable MessagingProviderError
    // so the shared retry path short-circuits on attempt 1 (instead of
    // 3 calls of "upstream 503"). The test still asserts the history
    // records a 'failed' entry with the original error message.
    const { MessagingProviderError } = await import("@muse/messaging");
    let calls = 0;
    const fakeRegistry = {
      send: async (_pid: string, message: { destination: string; text: string }) => {
        calls += 1;
        if (message.text === "FAIL") {
          throw new MessagingProviderError(
            "telegram", "UPSTREAM_FAILED", "upstream 401", 401
          );
        }
        return { destination: message.destination, messageId: "stub", providerId: "telegram" };
      }
    };
    await runDueReminders({
      destination: "@me",
      file,
      historyFile,
      now: () => new Date("2026-05-11T08:00:00Z"),
      providerId: "telegram",
      registry: fakeRegistry as unknown as Parameters<typeof runDueReminders>[0]["registry"]
    });
    expect(calls).toBe(2);
    const history = await readReminderHistory(historyFile);
    expect(history).toHaveLength(2);
    expect(history.find((e) => e.reminderId === "rem_ok")).toMatchObject({
      destination: "@me",
      providerId: "telegram",
      status: "delivered"
    });
    expect(history.find((e) => e.reminderId === "rem_fail")).toMatchObject({
      error: "upstream 401",
      status: "failed"
    });
  });
});

describe("muse.reminders.history tool", () => {
  it("is hidden when no historyFile is supplied", async () => {
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "muse-rem-history-tool-"));
    const server = createRemindersMcpServer({ file: join(dir, "reminders.json") });
    const connection = createLoopbackMcpConnection(server);
    const tools = await connection.listTools();
    expect(tools.map((t) => t.name)).not.toContain("history");
  });

  it("returns persisted entries newest-first with optional limit", async () => {
    const { appendReminderHistory } = await import("../src/index.js");
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "muse-rem-history-tool-"));
    const historyFile = join(dir, "history.json");
    await appendReminderHistory(historyFile, {
      destination: "@me", firedAtIso: "2026-05-11T08:00:00Z",
      providerId: "telegram", reminderId: "rem_1", status: "delivered", text: "first"
    });
    await appendReminderHistory(historyFile, {
      destination: "C123", firedAtIso: "2026-05-11T09:00:00Z",
      providerId: "slack", reminderId: "rem_2", status: "delivered", text: "second"
    });
    const server = createRemindersMcpServer({
      file: join(dir, "reminders.json"),
      historyFile
    });
    const connection = createLoopbackMcpConnection(server);
    const tools = await connection.listTools();
    expect(tools.map((t) => t.name)).toContain("history");
    const result = await connection.callTool!("history", {}) as { entries: unknown[]; total: number };
    expect(result.total).toBe(2);
    expect((result.entries[0] as { reminderId: string }).reminderId).toBe("rem_2");
  });
});

describe("runDueProactiveNotices", () => {
  function makeFakeCalendarRegistry(events: Array<{
    id: string;
    title: string;
    startsAt: Date;
    endsAt: Date;
    allDay?: boolean;
    location?: string;
  }>) {
    return {
      listEvents: async () => events.map((event) => ({
        allDay: event.allDay ?? false,
        endsAt: event.endsAt,
        id: event.id,
        providerId: "local",
        startsAt: event.startsAt,
        title: event.title,
        ...(event.location ? { location: event.location } : {})
      }))
    };
  }

  function makeFakeMessagingRegistry() {
    const sent: Array<{ providerId: string; destination: string; text: string }> = [];
    return {
      registry: {
        send: async (providerId: string, message: { destination: string; text: string }) => {
          sent.push({ destination: message.destination, providerId, text: message.text });
          return { destination: message.destination, messageId: "stub", providerId };
        }
      },
      sent
    };
  }

  it("retries transient messaging failures with exponential backoff (goal 070)", async () => {
    const { runDueProactiveNotices } = await import("../src/index.js");
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "muse-proactive-retry-"));
    const sidecarFile = join(dir, "proactive-fired.json");

    const fixedNow = new Date("2026-05-12T14:55:00Z");
    const cal = makeFakeCalendarRegistry([
      { endsAt: new Date("2026-05-12T16:00:00Z"), id: "evt-retry", startsAt: new Date("2026-05-12T15:00:00Z"), title: "Standup" }
    ]);

    // First two sends throw, third succeeds.
    const attempts: string[] = [];
    const flakyRegistry = {
      send: async (providerId: string, msg: { destination: string; text: string }) => {
        attempts.push(`${providerId}:${msg.destination}`);
        if (attempts.length < 3) {
          throw new Error("upstream 503");
        }
        return { destination: msg.destination, messageId: "ok", providerId };
      }
    };

    const summary = await runDueProactiveNotices({
      calendarRegistry: cal as unknown as Parameters<typeof runDueProactiveNotices>[0]["calendarRegistry"],
      destination: "@me",
      messagingRegistry: flakyRegistry as unknown as Parameters<typeof runDueProactiveNotices>[0]["messagingRegistry"],
      now: () => fixedNow,
      providerId: "telegram",
      sidecarFile
    });
    expect(summary.fired).toBe(1);
    expect(summary.errors).toEqual([]);
    expect(attempts.length).toBe(3);
  });

  it("suppresses the MESSAGING sink during quiet hours (no night-time nag bypass)", async () => {
    const { runDueProactiveNotices } = await import("../src/index.js");
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "muse-proactive-quiet-"));

    const fixedNow = new Date("2026-05-12T14:55:00Z");
    const localHour = fixedNow.getHours();
    // A window that definitely includes the local hour of fixedNow, TZ-agnostic.
    const quietHours = { startHour: localHour, endHour: (localHour + 1) % 24 };
    const makeCal = () => makeFakeCalendarRegistry([
      { endsAt: new Date("2026-05-12T16:00:00Z"), id: "evt-quiet", startsAt: new Date("2026-05-12T15:00:00Z"), title: "Standup" }
    ]);
    const sent: string[] = [];
    const registry = {
      send: async (providerId: string, msg: { destination: string; text: string }) => {
        sent.push(`${providerId}:${msg.destination}`);
        return { destination: msg.destination, messageId: "ok", providerId };
      }
    } as unknown as Parameters<typeof runDueProactiveNotices>[0]["messagingRegistry"];

    // During quiet hours: the event is imminent but the messaging sink must NOT fire.
    const quiet = await runDueProactiveNotices({
      calendarRegistry: makeCal() as unknown as Parameters<typeof runDueProactiveNotices>[0]["calendarRegistry"],
      destination: "@me",
      messagingRegistry: registry,
      now: () => fixedNow,
      providerId: "telegram",
      quietHours,
      sidecarFile: join(dir, "quiet.json")
    });
    expect(quiet.imminent).toBe(1); // the event WAS detected as imminent…
    expect(sent).toEqual([]); // …but nothing was messaged (suppressed, no nag)

    // Same input, no quiet window → it DOES message (proves the suppression is what gated it).
    await runDueProactiveNotices({
      calendarRegistry: makeCal() as unknown as Parameters<typeof runDueProactiveNotices>[0]["calendarRegistry"],
      destination: "@me",
      messagingRegistry: registry,
      now: () => fixedNow,
      providerId: "telegram",
      sidecarFile: join(dir, "loud.json")
    });
    expect(sent).toEqual(["telegram:@me"]);
  });

  it("treats a non-finite leadMinutes as the default instead of silently surfacing nothing", async () => {
    const { runDueProactiveNotices } = await import("../src/index.js");
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "muse-proactive-nan-"));
    const sidecarFile = join(dir, "proactive-fired.json");

    const fixedNow = new Date("2026-05-12T14:55:00Z");
    // Event starts 5 min out — inside the 10-min default window
    // but only if NaN falls back rather than poisoning the cutoff.
    const cal = makeFakeCalendarRegistry([
      { endsAt: new Date("2026-05-12T16:00:00Z"), id: "evt-nan", startsAt: new Date("2026-05-12T15:00:00Z"), title: "Standup" }
    ]);
    const sent: string[] = [];
    const registry = {
      send: async (providerId: string, msg: { destination: string; text: string }) => {
        sent.push(`${providerId}:${msg.destination}`);
        return { destination: msg.destination, messageId: "ok", providerId };
      }
    };

    const summary = await runDueProactiveNotices({
      calendarRegistry: cal as unknown as Parameters<typeof runDueProactiveNotices>[0]["calendarRegistry"],
      destination: "@me",
      leadMinutes: Number.NaN,
      messagingRegistry: registry as unknown as Parameters<typeof runDueProactiveNotices>[0]["messagingRegistry"],
      now: () => fixedNow,
      providerId: "telegram",
      sidecarFile
    });
    // Pre-fix: NaN → Invalid Date cutoff → 0 fired (silent dead).
    expect(summary.fired).toBe(1);
    expect(sent).toEqual(["telegram:@me"]);
  });

  it("gives up after 3 attempts and records failure in history (goal 070)", async () => {
    const { runDueProactiveNotices } = await import("../src/index.js");
    const { mkdtempSync, readFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "muse-proactive-retry-fail-"));
    const sidecarFile = join(dir, "proactive-fired.json");
    const historyFile = join(dir, "proactive-history.json");

    const fixedNow = new Date("2026-05-12T14:55:00Z");
    const cal = makeFakeCalendarRegistry([
      { endsAt: new Date("2026-05-12T16:00:00Z"), id: "evt-fail", startsAt: new Date("2026-05-12T15:00:00Z"), title: "Standup" }
    ]);

    const attempts: number[] = [];
    const alwaysFailing = {
      send: async (_providerId: string, _msg: { destination: string; text: string }) => {
        attempts.push(1);
        throw new Error("upstream 503");
      }
    };

    const summary = await runDueProactiveNotices({
      calendarRegistry: cal as unknown as Parameters<typeof runDueProactiveNotices>[0]["calendarRegistry"],
      destination: "@me",
      historyFile,
      messagingRegistry: alwaysFailing as unknown as Parameters<typeof runDueProactiveNotices>[0]["messagingRegistry"],
      now: () => fixedNow,
      providerId: "telegram",
      sidecarFile
    });
    expect(summary.fired).toBe(0);
    expect(summary.errors.length).toBe(1);
    expect(summary.errors[0]).toContain("upstream 503");
    expect(attempts.length).toBe(3); // three attempts, then give up
    // History records the failure so the user can audit.
    const historyRaw = readFileSync(historyFile, "utf8");
    expect(historyRaw).toContain("\"status\": \"failed\"");
    expect(historyRaw).toContain("upstream 503");
  });

  it("breaks out of the retry loop early on non-retryable messaging errors (goal 148)", async () => {
    const { runDueProactiveNotices } = await import("../src/index.js");
    const { MessagingProviderError } = await import("@muse/messaging");
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "muse-proactive-non-retryable-"));
    const sidecarFile = join(dir, "proactive-fired.json");
    const historyFile = join(dir, "proactive-history.json");

    const fixedNow = new Date("2026-05-12T14:55:00Z");
    const cal = makeFakeCalendarRegistry([
      { endsAt: new Date("2026-05-12T16:00:00Z"), id: "evt-401", startsAt: new Date("2026-05-12T15:00:00Z"), title: "Standup" }
    ]);

    // 401 → MessagingProviderError with retryable=false. The loop
    // should record one attempt + bail, not burn the full 3.
    const attempts: number[] = [];
    const auth401 = {
      send: async (_providerId: string, _msg: { destination: string; text: string }) => {
        attempts.push(1);
        throw new MessagingProviderError("telegram", "UPSTREAM_FAILED", "Telegram 401: invalid token", 401);
      }
    };

    const summary = await runDueProactiveNotices({
      calendarRegistry: cal as unknown as Parameters<typeof runDueProactiveNotices>[0]["calendarRegistry"],
      destination: "@me",
      historyFile,
      messagingRegistry: auth401 as unknown as Parameters<typeof runDueProactiveNotices>[0]["messagingRegistry"],
      now: () => fixedNow,
      providerId: "telegram",
      sidecarFile
    });
    expect(summary.fired).toBe(0);
    expect(summary.errors.length).toBe(1);
    // Pre-goal-148 this was 3; now exactly 1 — the loop respects
    // the goal-134 retryable boolean.
    expect(attempts.length).toBe(1);
  });

  it("scrubs accidental credentials from delivered notice text (goal 086)", async () => {
    const { runDueProactiveNotices } = await import("../src/index.js");
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "muse-proactive-redact-"));
    const sidecarFile = join(dir, "proactive-fired.json");
    const tasksFile = join(dir, "tasks.json");
    // Task title includes an OpenAI-shaped secret — would otherwise
    // round-trip back via the messaging sink.
    writeFileSync(tasksFile, JSON.stringify({
      tasks: [{
        id: "task-leak",
        title: "rotate API key sk-proj-abcdefghijklmnopqrstuvwxyz today",
        status: "open",
        dueAt: "2026-05-12T15:00:00Z",
        createdAt: "2026-05-12T14:00:00Z"
      }]
    }));
    const fixedNow = new Date("2026-05-12T14:55:00Z");
    const msg = makeFakeMessagingRegistry();

    await runDueProactiveNotices({
      destination: "@me",
      messagingRegistry: msg.registry as unknown as Parameters<typeof runDueProactiveNotices>[0]["messagingRegistry"],
      now: () => fixedNow,
      providerId: "log",
      sidecarFile,
      tasksFile
    });
    expect(msg.sent.length).toBe(1);
    const delivered = msg.sent[0]?.text ?? "";
    // The credential shape is scrubbed.
    expect(delivered).not.toContain("sk-proj-abcdefghijklmnopqrstuvwxyz");
    expect(delivered).toContain("[redacted-openai-key]");
  });

  it("skips firing when sessionLockFile points at an active marker (goal 052)", async () => {
    const { runDueProactiveNotices, writeSessionLock } = await import("../src/index.js");
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "muse-proactive-lock-"));
    const sidecarFile = join(dir, "proactive-fired.json");
    const lockFile = join(dir, "session-lock.json");

    const fixedNow = new Date("2026-05-12T14:55:00Z");
    const cal = makeFakeCalendarRegistry([
      { endsAt: new Date("2026-05-12T16:00:00Z"), id: "evt-lock", startsAt: new Date("2026-05-12T15:00:00Z"), title: "Standup" }
    ]);
    const msg = makeFakeMessagingRegistry();

    // Lock active — until is 30 min in the future.
    await writeSessionLock(lockFile, {
      setAt: fixedNow.toISOString(),
      until: new Date(fixedNow.getTime() + 30 * 60_000).toISOString(),
      reason: "deep work"
    });

    const blocked = await runDueProactiveNotices({
      calendarRegistry: cal as unknown as Parameters<typeof runDueProactiveNotices>[0]["calendarRegistry"],
      destination: "@me",
      messagingRegistry: msg.registry as unknown as Parameters<typeof runDueProactiveNotices>[0]["messagingRegistry"],
      now: () => fixedNow,
      providerId: "telegram",
      sessionLockFile: lockFile,
      sidecarFile
    });
    // Sidecar is honored — nothing was probed.
    expect(blocked.fired).toBe(0);
    expect(blocked.imminent).toBe(0);
    expect(blocked.sessionLockedUntil).toBeTruthy();
    expect(msg.sent).toEqual([]);

    // Move the clock past `until` — firing resumes.
    const afterLock = new Date(fixedNow.getTime() + 45 * 60_000);
    const unlocked = await runDueProactiveNotices({
      calendarRegistry: makeFakeCalendarRegistry([
        { endsAt: new Date(afterLock.getTime() + 60 * 60_000), id: "evt-lock-after", startsAt: new Date(afterLock.getTime() + 5 * 60_000), title: "Standup later" }
      ]) as unknown as Parameters<typeof runDueProactiveNotices>[0]["calendarRegistry"],
      destination: "@me",
      messagingRegistry: msg.registry as unknown as Parameters<typeof runDueProactiveNotices>[0]["messagingRegistry"],
      now: () => afterLock,
      providerId: "telegram",
      sessionLockFile: lockFile,
      sidecarFile
    });
    expect(unlocked.fired).toBe(1);
    expect(unlocked.sessionLockedUntil).toBeUndefined();
  });

  it("fires imminent events, persists the sidecar, dedupes on a second run", async () => {
    const { runDueProactiveNotices, readProactiveFired } = await import("../src/index.js");
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "muse-proactive-"));
    const sidecarFile = join(dir, "proactive-fired.json");

    const fixedNow = new Date("2026-05-12T14:55:00Z");
    const cal = makeFakeCalendarRegistry([
      { endsAt: new Date("2026-05-12T16:00:00Z"), id: "evt-1", startsAt: new Date("2026-05-12T15:00:00Z"), title: "Standup" }
    ]);
    const msg = makeFakeMessagingRegistry();

    const first = await runDueProactiveNotices({
      calendarRegistry: cal as unknown as Parameters<typeof runDueProactiveNotices>[0]["calendarRegistry"],
      destination: "@me",
      messagingRegistry: msg.registry as unknown as Parameters<typeof runDueProactiveNotices>[0]["messagingRegistry"],
      now: () => fixedNow,
      providerId: "telegram",
      sidecarFile
    });
    expect(first).toMatchObject({ fired: 1, imminent: 1, errors: [] });
    expect(msg.sent).toEqual([{ destination: "@me", providerId: "telegram", text: "⏰ Standup in 5 min" }]);
    const persisted = await readProactiveFired(sidecarFile);
    expect(persisted).toHaveLength(1);
    expect(persisted[0]).toMatchObject({ id: "evt-1", kind: "calendar" });

    const second = await runDueProactiveNotices({
      calendarRegistry: cal as unknown as Parameters<typeof runDueProactiveNotices>[0]["calendarRegistry"],
      destination: "@me",
      messagingRegistry: msg.registry as unknown as Parameters<typeof runDueProactiveNotices>[0]["messagingRegistry"],
      now: () => fixedNow,
      providerId: "telegram",
      sidecarFile
    });
    expect(second).toMatchObject({ fired: 0, imminent: 1, errors: [] });
    expect(msg.sent).toHaveLength(1);
  });

  it("re-fires when an event's startsAt changes (moved meeting)", async () => {
    const { runDueProactiveNotices } = await import("../src/index.js");
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "muse-proactive-move-"));
    const sidecarFile = join(dir, "proactive-fired.json");

    const fixedNow = new Date("2026-05-12T14:55:00Z");
    const msg = makeFakeMessagingRegistry();
    const cal1 = makeFakeCalendarRegistry([
      { endsAt: new Date("2026-05-12T16:00:00Z"), id: "evt-1", startsAt: new Date("2026-05-12T15:00:00Z"), title: "Standup" }
    ]);
    await runDueProactiveNotices({
      calendarRegistry: cal1 as unknown as Parameters<typeof runDueProactiveNotices>[0]["calendarRegistry"],
      destination: "@me",
      messagingRegistry: msg.registry as unknown as Parameters<typeof runDueProactiveNotices>[0]["messagingRegistry"],
      now: () => fixedNow,
      providerId: "telegram",
      sidecarFile
    });

    const cal2 = makeFakeCalendarRegistry([
      { endsAt: new Date("2026-05-12T16:01:00Z"), id: "evt-1", startsAt: new Date("2026-05-12T15:01:00Z"), title: "Standup" }
    ]);
    const moved = await runDueProactiveNotices({
      calendarRegistry: cal2 as unknown as Parameters<typeof runDueProactiveNotices>[0]["calendarRegistry"],
      destination: "@me",
      messagingRegistry: msg.registry as unknown as Parameters<typeof runDueProactiveNotices>[0]["messagingRegistry"],
      now: () => fixedNow,
      providerId: "telegram",
      sidecarFile
    });
    expect(moved.fired).toBe(1);
    expect(msg.sent).toHaveLength(2);
  });

  it("skips all-day events", async () => {
    const { runDueProactiveNotices } = await import("../src/index.js");
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "muse-proactive-allday-"));
    const sidecarFile = join(dir, "proactive-fired.json");

    const fixedNow = new Date("2026-05-12T14:55:00Z");
    const msg = makeFakeMessagingRegistry();
    const cal = makeFakeCalendarRegistry([
      { allDay: true, endsAt: new Date("2026-05-12T23:59:00Z"), id: "evt-1", startsAt: new Date("2026-05-12T15:00:00Z"), title: "OOO" }
    ]);
    const summary = await runDueProactiveNotices({
      calendarRegistry: cal as unknown as Parameters<typeof runDueProactiveNotices>[0]["calendarRegistry"],
      destination: "@me",
      messagingRegistry: msg.registry as unknown as Parameters<typeof runDueProactiveNotices>[0]["messagingRegistry"],
      now: () => fixedNow,
      providerId: "telegram",
      sidecarFile
    });
    expect(summary).toMatchObject({ fired: 0, imminent: 0 });
  });

  it("appends location when present", async () => {
    const { runDueProactiveNotices } = await import("../src/index.js");
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "muse-proactive-loc-"));
    const sidecarFile = join(dir, "proactive-fired.json");

    const fixedNow = new Date("2026-05-12T14:55:00Z");
    const msg = makeFakeMessagingRegistry();
    const cal = makeFakeCalendarRegistry([
      { endsAt: new Date("2026-05-12T16:00:00Z"), id: "evt-1", location: "Room 3", startsAt: new Date("2026-05-12T15:00:00Z"), title: "Sync" }
    ]);
    await runDueProactiveNotices({
      calendarRegistry: cal as unknown as Parameters<typeof runDueProactiveNotices>[0]["calendarRegistry"],
      destination: "@me",
      messagingRegistry: msg.registry as unknown as Parameters<typeof runDueProactiveNotices>[0]["messagingRegistry"],
      now: () => fixedNow,
      providerId: "telegram",
      sidecarFile
    });
    expect(msg.sent[0]?.text).toBe("⏰ Sync in 5 min (Room 3)");
  });

  it("returns an error string but does not crash when messaging.send throws", async () => {
    const { runDueProactiveNotices } = await import("../src/index.js");
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "muse-proactive-err-"));
    const sidecarFile = join(dir, "proactive-fired.json");

    const fixedNow = new Date("2026-05-12T14:55:00Z");
    const cal = makeFakeCalendarRegistry([
      { endsAt: new Date("2026-05-12T16:00:00Z"), id: "evt-1", startsAt: new Date("2026-05-12T15:00:00Z"), title: "Sync" }
    ]);
    const summary = await runDueProactiveNotices({
      calendarRegistry: cal as unknown as Parameters<typeof runDueProactiveNotices>[0]["calendarRegistry"],
      destination: "@me",
      messagingRegistry: {
        send: async () => { throw new Error("upstream 500"); }
      } as unknown as Parameters<typeof runDueProactiveNotices>[0]["messagingRegistry"],
      now: () => fixedNow,
      providerId: "telegram",
      sidecarFile
    });
    expect(summary.fired).toBe(0);
    expect(summary.imminent).toBe(1);
    expect(summary.errors[0]).toContain("upstream 500");
  });

  it("returns an error and does not crash when calendar.listEvents throws", async () => {
    const { runDueProactiveNotices } = await import("../src/index.js");
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "muse-proactive-calerr-"));
    const sidecarFile = join(dir, "proactive-fired.json");

    const fixedNow = new Date("2026-05-12T14:55:00Z");
    const summary = await runDueProactiveNotices({
      calendarRegistry: {
        listEvents: async () => { throw new Error("caldav down"); }
      } as unknown as Parameters<typeof runDueProactiveNotices>[0]["calendarRegistry"],
      destination: "@me",
      messagingRegistry: makeFakeMessagingRegistry().registry as unknown as Parameters<typeof runDueProactiveNotices>[0]["messagingRegistry"],
      now: () => fixedNow,
      providerId: "telegram",
      sidecarFile
    });
    expect(summary).toMatchObject({ fired: 0, imminent: 0 });
    expect(summary.errors[0]).toContain("caldav down");
  });

  it("fires due-soon open tasks (Phase B) and dedupes the same way as calendar", async () => {
    const { runDueProactiveNotices, readProactiveFired } = await import("../src/index.js");
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "muse-proactive-task-"));
    const tasksFile = join(dir, "tasks.json");
    const sidecarFile = join(dir, "proactive-fired.json");

    writeFileSync(tasksFile, JSON.stringify({
      tasks: [
        {
          createdAt: "2026-05-12T00:00:00Z",
          dueAt: "2026-05-12T15:00:00Z",
          id: "task-soon",
          status: "open",
          title: "Send invoice"
        },
        {
          createdAt: "2026-05-12T00:00:00Z",
          dueAt: "2030-01-01T00:00:00Z", // far future
          id: "task-far",
          status: "open",
          title: "Year-end review"
        },
        {
          createdAt: "2026-05-12T00:00:00Z",
          dueAt: "2026-05-12T15:02:00Z",
          id: "task-done",
          status: "done", // not open — must skip
          title: "Already finished"
        }
      ]
    }), "utf8");

    const msg = makeFakeMessagingRegistry();
    const fixedNow = new Date("2026-05-12T14:55:00Z");

    const first = await runDueProactiveNotices({
      destination: "@me",
      messagingRegistry: msg.registry as unknown as Parameters<typeof runDueProactiveNotices>[0]["messagingRegistry"],
      now: () => fixedNow,
      providerId: "telegram",
      sidecarFile,
      tasksFile
    });
    expect(first).toMatchObject({ fired: 1, imminent: 1, errors: [] });
    expect(msg.sent).toEqual([{ destination: "@me", providerId: "telegram", text: "📋 Send invoice due in 5 min" }]);

    const persisted = await readProactiveFired(sidecarFile);
    expect(persisted).toHaveLength(1);
    expect(persisted[0]).toMatchObject({ id: "task-soon", kind: "task" });

    // Dedupe on a second run within the same window.
    const second = await runDueProactiveNotices({
      destination: "@me",
      messagingRegistry: msg.registry as unknown as Parameters<typeof runDueProactiveNotices>[0]["messagingRegistry"],
      now: () => fixedNow,
      providerId: "telegram",
      sidecarFile,
      tasksFile
    });
    expect(second.fired).toBe(0);
    expect(msg.sent).toHaveLength(1);
  });

  it("re-fires a rescheduled task (same id, new dueAt)", async () => {
    const { runDueProactiveNotices } = await import("../src/index.js");
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "muse-proactive-task-move-"));
    const tasksFile = join(dir, "tasks.json");
    const sidecarFile = join(dir, "proactive-fired.json");

    const fixedNow = new Date("2026-05-12T14:55:00Z");
    const msg = makeFakeMessagingRegistry();

    writeFileSync(tasksFile, JSON.stringify({
      tasks: [{
        createdAt: "2026-05-12T00:00:00Z",
        dueAt: "2026-05-12T15:00:00Z",
        id: "task-1",
        status: "open",
        title: "Send invoice"
      }]
    }), "utf8");
    await runDueProactiveNotices({
      destination: "@me",
      messagingRegistry: msg.registry as unknown as Parameters<typeof runDueProactiveNotices>[0]["messagingRegistry"],
      now: () => fixedNow,
      providerId: "telegram",
      sidecarFile,
      tasksFile
    });

    // Reschedule the same task.
    writeFileSync(tasksFile, JSON.stringify({
      tasks: [{
        createdAt: "2026-05-12T00:00:00Z",
        dueAt: "2026-05-12T15:01:00Z",
        id: "task-1",
        status: "open",
        title: "Send invoice"
      }]
    }), "utf8");
    const moved = await runDueProactiveNotices({
      destination: "@me",
      messagingRegistry: msg.registry as unknown as Parameters<typeof runDueProactiveNotices>[0]["messagingRegistry"],
      now: () => fixedNow,
      providerId: "telegram",
      sidecarFile,
      tasksFile
    });
    expect(moved.fired).toBe(1);
    expect(msg.sent).toHaveLength(2);
  });

  it("Phase C: skips calendar events whose title or notes contain [no-proactive]", async () => {
    const { runDueProactiveNotices } = await import("../src/index.js");
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "muse-proactive-optout-cal-"));
    const sidecarFile = join(dir, "proactive-fired.json");

    const fixedNow = new Date("2026-05-12T14:55:00Z");
    const cal = {
      listEvents: async () => [
        // Opted out via title marker (case-insensitive).
        {
          allDay: false,
          endsAt: new Date("2026-05-12T16:00:00Z"),
          id: "evt-quiet",
          providerId: "local",
          startsAt: new Date("2026-05-12T15:00:00Z"),
          title: "Standup [No-Proactive]"
        },
        // Opted out via notes marker.
        {
          allDay: false,
          endsAt: new Date("2026-05-12T16:01:00Z"),
          id: "evt-quiet-notes",
          notes: "private — [no-proactive]",
          providerId: "local",
          startsAt: new Date("2026-05-12T15:01:00Z"),
          title: "1:1"
        },
        // No marker — fires normally.
        {
          allDay: false,
          endsAt: new Date("2026-05-12T16:02:00Z"),
          id: "evt-loud",
          providerId: "local",
          startsAt: new Date("2026-05-12T15:02:00Z"),
          title: "Loud meeting"
        }
      ]
    };
    const msg = makeFakeMessagingRegistry();
    const summary = await runDueProactiveNotices({
      calendarRegistry: cal as unknown as Parameters<typeof runDueProactiveNotices>[0]["calendarRegistry"],
      destination: "@me",
      messagingRegistry: msg.registry as unknown as Parameters<typeof runDueProactiveNotices>[0]["messagingRegistry"],
      now: () => fixedNow,
      providerId: "telegram",
      sidecarFile
    });
    expect(summary).toMatchObject({ fired: 1, imminent: 1 });
    expect(msg.sent[0]?.text).toContain("Loud meeting");
  });

  it("Phase C: skips tasks with proactive: false even when imminent", async () => {
    const { runDueProactiveNotices } = await import("../src/index.js");
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "muse-proactive-optout-task-"));
    const tasksFile = join(dir, "tasks.json");
    const sidecarFile = join(dir, "proactive-fired.json");

    writeFileSync(tasksFile, JSON.stringify({
      tasks: [
        {
          createdAt: "2026-05-12T00:00:00Z",
          dueAt: "2026-05-12T15:00:00Z",
          id: "task-quiet",
          proactive: false,
          status: "open",
          title: "Silent task"
        },
        {
          createdAt: "2026-05-12T00:00:00Z",
          dueAt: "2026-05-12T15:01:00Z",
          id: "task-loud",
          status: "open",
          title: "Normal task"
        }
      ]
    }), "utf8");
    const msg = makeFakeMessagingRegistry();
    const summary = await runDueProactiveNotices({
      destination: "@me",
      messagingRegistry: msg.registry as unknown as Parameters<typeof runDueProactiveNotices>[0]["messagingRegistry"],
      now: () => new Date("2026-05-12T14:55:00Z"),
      providerId: "telegram",
      sidecarFile,
      tasksFile
    });
    expect(summary).toMatchObject({ fired: 1, imminent: 1 });
    expect(msg.sent[0]?.text).toContain("Normal task");
  });

  it("Phase D: synthesises notice text via agent when active-session window is in range", async () => {
    const { runDueProactiveNotices } = await import("../src/index.js");
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "muse-proactive-phaseD-"));
    const sidecarFile = join(dir, "proactive-fired.json");

    const fixedNow = new Date("2026-05-12T14:55:00Z");
    const cal = makeFakeCalendarRegistry([
      { endsAt: new Date("2026-05-12T16:00:00Z"), id: "evt-1", startsAt: new Date("2026-05-12T15:00:00Z"), title: "Standup" }
    ]);
    const msg = makeFakeMessagingRegistry();

    const runCalls: Array<{ model: string; userMessage: string }> = [];
    const agentRuntime = {
      run: async (input: { model: string; messages: readonly { role: string; content: string }[] }) => {
        const userMessage = input.messages.find((m) => m.role === "user")?.content ?? "";
        runCalls.push({ model: input.model, userMessage });
        return { response: { output: "Standup in 5 — want me to pull up yesterday's notes?" } };
      }
    };
    const activitySource = {
      lastActivityMs: () => fixedNow.getTime() - 60_000 // 1 min ago
    };

    const summary = await runDueProactiveNotices({
      activeSessionWindowMs: 5 * 60_000,
      activitySource,
      agentModel: "claude-opus-4-7",
      agentRuntime,
      calendarRegistry: cal as unknown as Parameters<typeof runDueProactiveNotices>[0]["calendarRegistry"],
      destination: "@me",
      messagingRegistry: msg.registry as unknown as Parameters<typeof runDueProactiveNotices>[0]["messagingRegistry"],
      now: () => fixedNow,
      providerId: "telegram",
      sidecarFile
    });
    expect(summary).toMatchObject({ fired: 1, errors: [] });
    expect(runCalls).toHaveLength(1);
    expect(runCalls[0]!.model).toBe("claude-opus-4-7");
    expect(runCalls[0]!.userMessage).toContain("Standup");
    expect(runCalls[0]!.userMessage).toContain("starts in: 5");
    // Notice text comes from the agent + the emoji prefix.
    expect(msg.sent[0]?.text).toBe("⏰ Standup in 5 — want me to pull up yesterday's notes?");
  });

  it("Phase D: falls back to flat text when no recent activity", async () => {
    const { runDueProactiveNotices } = await import("../src/index.js");
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "muse-proactive-phaseD-stale-"));
    const sidecarFile = join(dir, "proactive-fired.json");

    const fixedNow = new Date("2026-05-12T14:55:00Z");
    const cal = makeFakeCalendarRegistry([
      { endsAt: new Date("2026-05-12T16:00:00Z"), id: "evt-1", startsAt: new Date("2026-05-12T15:00:00Z"), title: "Standup" }
    ]);
    const msg = makeFakeMessagingRegistry();

    let runCalled = false;
    const agentRuntime = {
      run: async () => {
        runCalled = true;
        return { response: { output: "ignored" } };
      }
    };
    const activitySource = {
      lastActivityMs: () => fixedNow.getTime() - 10 * 60_000 // 10 min ago, outside the 5-min default
    };

    const summary = await runDueProactiveNotices({
      activitySource,
      agentModel: "claude-opus-4-7",
      agentRuntime,
      calendarRegistry: cal as unknown as Parameters<typeof runDueProactiveNotices>[0]["calendarRegistry"],
      destination: "@me",
      messagingRegistry: msg.registry as unknown as Parameters<typeof runDueProactiveNotices>[0]["messagingRegistry"],
      now: () => fixedNow,
      providerId: "telegram",
      sidecarFile
    });
    expect(summary.fired).toBe(1);
    expect(runCalled).toBe(false);
    expect(msg.sent[0]?.text).toBe("⏰ Standup in 5 min");
  });

  it("Phase D: falls back to flat text + records error when synthesis throws", async () => {
    const { runDueProactiveNotices } = await import("../src/index.js");
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "muse-proactive-phaseD-err-"));
    const sidecarFile = join(dir, "proactive-fired.json");

    const fixedNow = new Date("2026-05-12T14:55:00Z");
    const cal = makeFakeCalendarRegistry([
      { endsAt: new Date("2026-05-12T16:00:00Z"), id: "evt-1", startsAt: new Date("2026-05-12T15:00:00Z"), title: "Standup" }
    ]);
    const msg = makeFakeMessagingRegistry();

    const agentRuntime = {
      run: async () => { throw new Error("model timeout"); }
    };
    const activitySource = {
      lastActivityMs: () => fixedNow.getTime() - 30_000
    };

    const summary = await runDueProactiveNotices({
      activitySource,
      agentModel: "claude-opus-4-7",
      agentRuntime,
      calendarRegistry: cal as unknown as Parameters<typeof runDueProactiveNotices>[0]["calendarRegistry"],
      destination: "@me",
      messagingRegistry: msg.registry as unknown as Parameters<typeof runDueProactiveNotices>[0]["messagingRegistry"],
      now: () => fixedNow,
      providerId: "telegram",
      sidecarFile
    });
    expect(summary.fired).toBe(1);
    expect(msg.sent[0]?.text).toBe("⏰ Standup in 5 min"); // flat fallback
    expect(summary.errors.some((e) => e.includes("model timeout"))).toBe(true);
  });

  it("Phase D: prefers modelProvider over agentRuntime when both set", async () => {
    const { runDueProactiveNotices } = await import("../src/index.js");
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "muse-proactive-phaseD-provider-"));
    const sidecarFile = join(dir, "proactive-fired.json");

    const fixedNow = new Date("2026-05-12T14:55:00Z");
    const cal = makeFakeCalendarRegistry([
      { endsAt: new Date("2026-05-12T16:00:00Z"), id: "evt-1", startsAt: new Date("2026-05-12T15:00:00Z"), title: "Standup" }
    ]);
    const msg = makeFakeMessagingRegistry();

    let providerCalled = false;
    let runtimeCalled = false;
    const modelProvider = {
      generate: async (request: { model: string; messages: readonly { role: string; content: string }[] }) => {
        providerCalled = true;
        expect(request.model).toBe("local/qwen2.5:7b");
        return { output: "Standup in 5 — want a quick agenda?" };
      }
    };
    const agentRuntime = {
      run: async () => {
        runtimeCalled = true;
        return { response: { output: "should not run" } };
      }
    };
    const activitySource = { lastActivityMs: () => fixedNow.getTime() - 60_000 };

    const summary = await runDueProactiveNotices({
      activeSessionWindowMs: 5 * 60_000,
      activitySource,
      agentModel: "local/qwen2.5:7b",
      agentRuntime,
      calendarRegistry: cal as unknown as Parameters<typeof runDueProactiveNotices>[0]["calendarRegistry"],
      destination: "@me",
      messagingRegistry: msg.registry as unknown as Parameters<typeof runDueProactiveNotices>[0]["messagingRegistry"],
      modelProvider,
      now: () => fixedNow,
      providerId: "telegram",
      sidecarFile
    });
    expect(summary).toMatchObject({ fired: 1, errors: [] });
    expect(providerCalled).toBe(true);
    expect(runtimeCalled).toBe(false);
    expect(msg.sent[0]?.text).toBe("⏰ Standup in 5 — want a quick agenda?");
  });

  it("Phase D: publishes to the agent-initiated-notice broker alongside the messaging send", async () => {
    const { runDueProactiveNotices } = await import("../src/index.js");
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "muse-proactive-phaseD-broker-"));
    const sidecarFile = join(dir, "proactive-fired.json");

    const fixedNow = new Date("2026-05-12T14:55:00Z");
    const cal = makeFakeCalendarRegistry([
      { endsAt: new Date("2026-05-12T16:00:00Z"), id: "evt-1", startsAt: new Date("2026-05-12T15:00:00Z"), title: "Standup" }
    ]);
    const msg = makeFakeMessagingRegistry();
    const published: Array<{ userId: string; notice: { kind: string; text: string; sourceId?: string } }> = [];
    const broker = {
      publish: (userId: string, notice: { kind: string; text: string; generatedAt: string; sourceId?: string }) => {
        published.push({ notice, userId });
      }
    };

    const summary = await runDueProactiveNotices({
      agentInitiatedNoticeBroker: broker,
      agentInitiatedNoticeUserId: "stark",
      calendarRegistry: cal as unknown as Parameters<typeof runDueProactiveNotices>[0]["calendarRegistry"],
      destination: "@me",
      messagingRegistry: msg.registry as unknown as Parameters<typeof runDueProactiveNotices>[0]["messagingRegistry"],
      now: () => fixedNow,
      providerId: "telegram",
      sidecarFile
    });
    expect(summary).toMatchObject({ fired: 1, errors: [] });

    // Both sinks fired with the same text.
    expect(msg.sent).toHaveLength(1);
    expect(published).toHaveLength(1);
    expect(published[0]?.userId).toBe("stark");
    expect(published[0]?.notice.text).toBe(msg.sent[0]?.text);
    expect(published[0]?.notice.kind).toBe("calendar");
    expect(published[0]?.notice.sourceId).toBe("evt-1");
  });

  it("Phase D: does not publish to the broker when agentInitiatedNoticeUserId is missing", async () => {
    const { runDueProactiveNotices } = await import("../src/index.js");
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "muse-proactive-phaseD-broker-noUser-"));
    const sidecarFile = join(dir, "proactive-fired.json");
    const fixedNow = new Date("2026-05-12T14:55:00Z");
    const cal = makeFakeCalendarRegistry([
      { endsAt: new Date("2026-05-12T16:00:00Z"), id: "evt-1", startsAt: new Date("2026-05-12T15:00:00Z"), title: "Standup" }
    ]);
    const msg = makeFakeMessagingRegistry();
    let publishCalls = 0;
    const broker = { publish: () => { publishCalls += 1; } };

    await runDueProactiveNotices({
      agentInitiatedNoticeBroker: broker,
      // intentionally no agentInitiatedNoticeUserId
      calendarRegistry: cal as unknown as Parameters<typeof runDueProactiveNotices>[0]["calendarRegistry"],
      destination: "@me",
      messagingRegistry: msg.registry as unknown as Parameters<typeof runDueProactiveNotices>[0]["messagingRegistry"],
      now: () => fixedNow,
      providerId: "telegram",
      sidecarFile
    });
    expect(publishCalls).toBe(0);
    expect(msg.sent).toHaveLength(1); // messaging still fired
  });

  it("Phase D: drops back to flat text when synthesis emits tool-call JSON", async () => {
    const { runDueProactiveNotices } = await import("../src/index.js");
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "muse-proactive-phaseD-jsonleak-"));
    const sidecarFile = join(dir, "proactive-fired.json");

    const fixedNow = new Date("2026-05-12T14:55:00Z");
    const cal = makeFakeCalendarRegistry([
      { endsAt: new Date("2026-05-12T16:00:00Z"), id: "evt-1", startsAt: new Date("2026-05-12T15:00:00Z"), title: "Standup" }
    ]);
    const msg = makeFakeMessagingRegistry();

    // Small-model failure mode: instruction-tuned 1.5B sometimes
    // emits the tool-call payload verbatim instead of prose.
    const modelProvider = {
      generate: async () => ({
        output: '{"name": "muse.calendar.list", "arguments": {"range": "today"}}'
      })
    };
    const activitySource = { lastActivityMs: () => fixedNow.getTime() - 60_000 };

    const summary = await runDueProactiveNotices({
      activeSessionWindowMs: 5 * 60_000,
      activitySource,
      agentModel: "ollama/qwen2.5:1.5b-instruct",
      calendarRegistry: cal as unknown as Parameters<typeof runDueProactiveNotices>[0]["calendarRegistry"],
      destination: "@me",
      messagingRegistry: msg.registry as unknown as Parameters<typeof runDueProactiveNotices>[0]["messagingRegistry"],
      modelProvider,
      now: () => fixedNow,
      providerId: "telegram",
      sidecarFile
    });
    expect(summary).toMatchObject({ fired: 1, errors: [] });
    // Must NOT deliver the JSON; the safety net should engage.
    expect(msg.sent[0]?.text).toBe("⏰ Standup in 5 min");
  });

  it("combines calendar + task sources in one run", async () => {
    const { runDueProactiveNotices } = await import("../src/index.js");
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "muse-proactive-combined-"));
    const tasksFile = join(dir, "tasks.json");
    const sidecarFile = join(dir, "proactive-fired.json");

    writeFileSync(tasksFile, JSON.stringify({
      tasks: [{
        createdAt: "2026-05-12T00:00:00Z",
        dueAt: "2026-05-12T15:00:00Z",
        id: "task-1",
        status: "open",
        title: "Send invoice"
      }]
    }), "utf8");
    const cal = makeFakeCalendarRegistry([
      { endsAt: new Date("2026-05-12T16:00:00Z"), id: "evt-1", startsAt: new Date("2026-05-12T15:00:00Z"), title: "Standup" }
    ]);
    const msg = makeFakeMessagingRegistry();
    const fixedNow = new Date("2026-05-12T14:55:00Z");

    const summary = await runDueProactiveNotices({
      calendarRegistry: cal as unknown as Parameters<typeof runDueProactiveNotices>[0]["calendarRegistry"],
      destination: "@me",
      messagingRegistry: msg.registry as unknown as Parameters<typeof runDueProactiveNotices>[0]["messagingRegistry"],
      now: () => fixedNow,
      providerId: "telegram",
      sidecarFile,
      tasksFile
    });
    expect(summary).toMatchObject({ fired: 2, imminent: 2, errors: [] });
    expect(msg.sent.map((entry) => entry.text)).toEqual([
      "⏰ Standup in 5 min",
      "📋 Send invoice due in 5 min"
    ]);
  });

  it("appends a delivered-row to historyFile when configured", async () => {
    const { runDueProactiveNotices, readProactiveHistory } = await import("../src/index.js");
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "muse-proactive-history-ok-"));
    const sidecarFile = join(dir, "proactive-fired.json");
    const historyFile = join(dir, "proactive-history.json");

    const fixedNow = new Date("2026-05-12T14:55:00Z");
    const cal = makeFakeCalendarRegistry([
      { endsAt: new Date("2026-05-12T16:00:00Z"), id: "evt-1", startsAt: new Date("2026-05-12T15:00:00Z"), title: "Standup" }
    ]);
    const msg = makeFakeMessagingRegistry();
    await runDueProactiveNotices({
      calendarRegistry: cal as unknown as Parameters<typeof runDueProactiveNotices>[0]["calendarRegistry"],
      destination: "@me",
      historyFile,
      messagingRegistry: msg.registry as unknown as Parameters<typeof runDueProactiveNotices>[0]["messagingRegistry"],
      now: () => fixedNow,
      providerId: "telegram",
      sidecarFile
    });
    const entries = await readProactiveHistory(historyFile);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      destination: "@me",
      itemId: "evt-1",
      kind: "calendar",
      providerId: "telegram",
      status: "delivered",
      text: "⏰ Standup in 5 min",
      title: "Standup"
    });
  });

  it("appends a failed-row to historyFile when messaging.send throws", async () => {
    const { runDueProactiveNotices, readProactiveHistory } = await import("../src/index.js");
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "muse-proactive-history-fail-"));
    const sidecarFile = join(dir, "proactive-fired.json");
    const historyFile = join(dir, "proactive-history.json");

    const fixedNow = new Date("2026-05-12T14:55:00Z");
    const cal = makeFakeCalendarRegistry([
      { endsAt: new Date("2026-05-12T16:00:00Z"), id: "evt-1", startsAt: new Date("2026-05-12T15:00:00Z"), title: "Standup" }
    ]);
    const summary = await runDueProactiveNotices({
      calendarRegistry: cal as unknown as Parameters<typeof runDueProactiveNotices>[0]["calendarRegistry"],
      destination: "@me",
      historyFile,
      messagingRegistry: {
        send: async () => { throw new Error("upstream 503"); }
      } as unknown as Parameters<typeof runDueProactiveNotices>[0]["messagingRegistry"],
      now: () => fixedNow,
      providerId: "telegram",
      sidecarFile
    });
    expect(summary.fired).toBe(0);
    const entries = await readProactiveHistory(historyFile);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      destination: "@me",
      error: "upstream 503",
      itemId: "evt-1",
      providerId: "telegram",
      status: "failed",
      title: "Standup"
    });
  });

  it("readProactiveHistory returns empty + tolerates missing / corrupt files", async () => {
    const { readProactiveHistory } = await import("../src/index.js");
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "muse-proactive-history-edge-"));
    expect(await readProactiveHistory(join(dir, "missing.json"))).toEqual([]);
    const garbled = join(dir, "garbled.json");
    writeFileSync(garbled, "not json", "utf8");
    expect(await readProactiveHistory(garbled)).toEqual([]);
  });

  it("skips an Invalid-Date calendar event instead of crashing the whole tick", async () => {
    const { runDueProactiveNotices } = await import("../src/index.js");
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "muse-proactive-baddate-"));
    const sidecarFile = join(dir, "proactive-fired.json");

    const fixedNow = new Date("2026-05-12T14:55:00Z");
    // A malformed feed / hand-edited calendar.json yields an Invalid
    // Date. It appears BEFORE a valid imminent event — pre-fix the
    // throw on `.toISOString()` aborted the loop and the valid event
    // (Standup) was silently lost every tick.
    const cal = makeFakeCalendarRegistry([
      { endsAt: new Date("2026-05-12T16:00:00Z"), id: "evt-bad", startsAt: new Date("not-a-date"), title: "Corrupt" },
      { endsAt: new Date("2026-05-12T16:00:00Z"), id: "evt-ok", startsAt: new Date("2026-05-12T15:00:00Z"), title: "Standup" }
    ]);
    const msg = makeFakeMessagingRegistry();

    const summary = await runDueProactiveNotices({
      calendarRegistry: cal as unknown as Parameters<typeof runDueProactiveNotices>[0]["calendarRegistry"],
      destination: "@me",
      messagingRegistry: msg.registry as unknown as Parameters<typeof runDueProactiveNotices>[0]["messagingRegistry"],
      now: () => fixedNow,
      providerId: "telegram",
      sidecarFile
    });

    expect(summary).toMatchObject({ fired: 1, imminent: 1, errors: [] });
    expect(msg.sent).toEqual([{ destination: "@me", providerId: "telegram", text: "⏰ Standup in 5 min" }]);
  });

  it("selectProactiveSink: terminal only when a sink is wired AND presence is recorded", async () => {
    const { selectProactiveSink } = await import("../src/index.js");
    expect(selectProactiveSink({ lastActivityMs: () => 1 }, false)).toBe("messaging");
    expect(selectProactiveSink({ lastActivityMs: () => 1 }, true)).toBe("terminal");
    expect(selectProactiveSink({ lastActivityMs: () => undefined }, true)).toBe("messaging");
    expect(selectProactiveSink(undefined, true)).toBe("messaging");
  });

  it("selectProactiveSink: presence older than the freshness window falls back to messaging", async () => {
    const { selectProactiveSink } = await import("../src/index.js");
    const now = 1_700_000_000_000;
    const win = { maxAgeMs: 300_000, nowMs: now };
    expect(selectProactiveSink({ lastActivityMs: () => now - 60_000 }, true, win)).toBe("terminal");
    expect(selectProactiveSink({ lastActivityMs: () => now - 600_000 }, true, win)).toBe("messaging");
    // No freshness arg keeps slice-1 semantics (defined → terminal).
    expect(selectProactiveSink({ lastActivityMs: () => now - 600_000 }, true)).toBe("terminal");
  });

  it("routes the notice to the terminal sink (not messaging) when local presence is recorded", async () => {
    const { runDueProactiveNotices } = await import("../src/index.js");
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "muse-proactive-route-"));
    const sidecarFile = join(dir, "proactive-fired.json");

    const fixedNow = new Date("2026-05-12T14:55:00Z");
    const cal = makeFakeCalendarRegistry([
      { endsAt: new Date("2026-05-12T16:00:00Z"), id: "evt-route", startsAt: new Date("2026-05-12T15:00:00Z"), title: "Standup" }
    ]);
    const msg = makeFakeMessagingRegistry();
    const delivered: Array<{ kind: string; text: string; title: string }> = [];
    const terminalSink = { deliver: (n: { kind: string; text: string; title: string }) => { delivered.push(n); } };

    const summary = await runDueProactiveNotices({
      activitySource: { lastActivityMs: () => fixedNow.getTime() - 30_000 },
      calendarRegistry: cal as unknown as Parameters<typeof runDueProactiveNotices>[0]["calendarRegistry"],
      destination: "@me",
      messagingRegistry: msg.registry as unknown as Parameters<typeof runDueProactiveNotices>[0]["messagingRegistry"],
      now: () => fixedNow,
      providerId: "telegram",
      sidecarFile,
      terminalSink
    });

    expect(summary).toMatchObject({ fired: 1, imminent: 1, errors: [] });
    // Assert the chosen sink actually received the notice — not a
    // "messaging wasn't called" fall-back assertion.
    expect(delivered).toEqual([{ kind: "calendar", text: "⏰ Standup in 5 min", title: "Standup" }]);
    expect(msg.sent).toEqual([]);
  });

  it("falls back to messaging when terminal presence is stale (backgrounded terminal, no black-hole)", async () => {
    const { runDueProactiveNotices } = await import("../src/index.js");
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "muse-proactive-stale-"));
    const sidecarFile = join(dir, "proactive-fired.json");

    const fixedNow = new Date("2026-05-12T14:55:00Z");
    const cal = makeFakeCalendarRegistry([
      { endsAt: new Date("2026-05-12T16:00:00Z"), id: "evt-stale", startsAt: new Date("2026-05-12T15:00:00Z"), title: "Standup" }
    ]);
    const msg = makeFakeMessagingRegistry();
    const delivered: unknown[] = [];
    const terminalSink = { deliver: (n: unknown) => { delivered.push(n); } };

    const summary = await runDueProactiveNotices({
      // Last seen 30 min ago — well past the 5-min default window.
      activitySource: { lastActivityMs: () => fixedNow.getTime() - 30 * 60_000 },
      calendarRegistry: cal as unknown as Parameters<typeof runDueProactiveNotices>[0]["calendarRegistry"],
      destination: "@me",
      messagingRegistry: msg.registry as unknown as Parameters<typeof runDueProactiveNotices>[0]["messagingRegistry"],
      now: () => fixedNow,
      providerId: "telegram",
      sidecarFile,
      terminalSink
    });

    expect(summary).toMatchObject({ fired: 1, imminent: 1, errors: [] });
    // The capability: a stale/backgrounded terminal does NOT
    // black-hole the notice — it reaches the user via messaging.
    expect(msg.sent).toEqual([{ destination: "@me", providerId: "telegram", text: "⏰ Standup in 5 min" }]);
    expect(delivered).toEqual([]);
  });

  it("falls back to messaging when a terminal sink is wired but no presence is recorded", async () => {
    const { runDueProactiveNotices } = await import("../src/index.js");
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "muse-proactive-route-fb-"));
    const sidecarFile = join(dir, "proactive-fired.json");

    const fixedNow = new Date("2026-05-12T14:55:00Z");
    const cal = makeFakeCalendarRegistry([
      { endsAt: new Date("2026-05-12T16:00:00Z"), id: "evt-fb", startsAt: new Date("2026-05-12T15:00:00Z"), title: "Standup" }
    ]);
    const msg = makeFakeMessagingRegistry();
    const delivered: unknown[] = [];
    const terminalSink = { deliver: (n: unknown) => { delivered.push(n); } };

    const summary = await runDueProactiveNotices({
      calendarRegistry: cal as unknown as Parameters<typeof runDueProactiveNotices>[0]["calendarRegistry"],
      destination: "@me",
      messagingRegistry: msg.registry as unknown as Parameters<typeof runDueProactiveNotices>[0]["messagingRegistry"],
      now: () => fixedNow,
      providerId: "telegram",
      sidecarFile,
      terminalSink
    });

    expect(summary).toMatchObject({ fired: 1, imminent: 1, errors: [] });
    expect(delivered).toEqual([]);
    expect(msg.sent).toEqual([{ destination: "@me", providerId: "telegram", text: "⏰ Standup in 5 min" }]);
  });

  it("autonomously investigates the unstated need and surfaces the finding in the unasked notice", async () => {
    const { runDueProactiveNotices } = await import("../src/index.js");
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "muse-proactive-investigate-"));
    const sidecarFile = join(dir, "proactive-fired.json");

    const fixedNow = new Date("2026-05-12T14:55:00Z");
    const cal = makeFakeCalendarRegistry([
      { endsAt: new Date("2026-05-12T16:00:00Z"), id: "evt-q3", startsAt: new Date("2026-05-12T15:00:00Z"), title: "Q3 review" }
    ]);
    const msg = makeFakeMessagingRegistry();
    const investigatedTitles: string[] = [];

    const summary = await runDueProactiveNotices({
      calendarRegistry: cal as unknown as Parameters<typeof runDueProactiveNotices>[0]["calendarRegistry"],
      destination: "@me",
      investigate: async ({ title }) => {
        investigatedTitles.push(title);
        return title.includes("Q3")
          ? "📎 Found 2 related notes: q3-plan.md, q3-metrics.md"
          : undefined;
      },
      messagingRegistry: msg.registry as unknown as Parameters<typeof runDueProactiveNotices>[0]["messagingRegistry"],
      now: () => fixedNow,
      providerId: "telegram",
      sidecarFile
    });

    expect(summary).toMatchObject({ fired: 1, imminent: 1, errors: [] });
    // Inferred the need (Q3 → its notes), investigated, surfaced
    // the finding unasked — the base notice PLUS the finding.
    expect(investigatedTitles).toEqual(["Q3 review"]);
    expect(msg.sent[0]?.text).toContain("Q3 review in 5 min");
    expect(msg.sent[0]?.text).toContain("Found 2 related notes: q3-plan.md, q3-metrics.md");
  });

  it("fail-open: a throwing investigator never drops the notice", async () => {
    const { runDueProactiveNotices } = await import("../src/index.js");
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "muse-proactive-investigate-failopen-"));
    const sidecarFile = join(dir, "proactive-fired.json");

    const fixedNow = new Date("2026-05-12T14:55:00Z");
    const cal = makeFakeCalendarRegistry([
      { endsAt: new Date("2026-05-12T16:00:00Z"), id: "evt-fo", startsAt: new Date("2026-05-12T15:00:00Z"), title: "Standup" }
    ]);
    const msg = makeFakeMessagingRegistry();

    const summary = await runDueProactiveNotices({
      calendarRegistry: cal as unknown as Parameters<typeof runDueProactiveNotices>[0]["calendarRegistry"],
      destination: "@me",
      investigate: () => Promise.reject(new Error("notes index unreadable")),
      messagingRegistry: msg.registry as unknown as Parameters<typeof runDueProactiveNotices>[0]["messagingRegistry"],
      now: () => fixedNow,
      providerId: "telegram",
      sidecarFile
    });

    expect(summary).toMatchObject({ fired: 1, imminent: 1, errors: [] });
    expect(msg.sent).toEqual([{ destination: "@me", providerId: "telegram", text: "⏰ Standup in 5 min" }]);
  });
});

describe("runDueFollowups", () => {
  it("synthesizes, delivers, and marks due followups as fired", async () => {
    const { runDueFollowups } = await import("../src/index.js");
    const { mkdtempSync, writeFileSync, readFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");

    const dir = mkdtempSync(join(tmpdir(), "muse-followup-fire-"));
    const file = join(dir, "followups.json");
    writeFileSync(file, JSON.stringify({
      followups: [
        {
          createdAt: "2026-05-10T00:00:00Z",
          id: "fu_overdue",
          scheduledFor: "2026-05-11T07:30:00Z",
          status: "scheduled",
          summary: "Check on the Q3 budget memo",
          userId: "stark"
        },
        {
          createdAt: "2026-05-10T00:00:00Z",
          id: "fu_future",
          scheduledFor: "2030-01-01T00:00:00Z",
          status: "scheduled",
          summary: "Year-end recap",
          userId: "stark"
        },
        {
          createdAt: "2026-05-10T00:00:00Z",
          firedAt: "2026-05-10T12:00:00Z",
          id: "fu_already_fired",
          scheduledFor: "2026-05-10T00:00:00Z",
          status: "fired",
          summary: "Old one",
          userId: "stark"
        }
      ]
    }), "utf8");

    const sent: Array<{ providerId: string; destination: string; text: string }> = [];
    const fakeRegistry = {
      send: async (providerId: string, message: { destination: string; text: string }) => {
        sent.push({ destination: message.destination, providerId, text: message.text });
        return { destination: message.destination, messageId: "stub", providerId };
      }
    };
    const generateCalls: Array<{ model: string; messages: readonly { role: string; content: string }[] }> = [];
    const modelProvider = {
      generate: async (req: { model: string; messages: readonly { role: "system" | "user" | "assistant"; content: string }[] }) => {
        generateCalls.push({ messages: req.messages, model: req.model });
        return { output: "Quick check on the Q3 budget memo — any blockers I can chase down?" };
      }
    };

    const summary = await runDueFollowups({
      destination: "@me",
      file,
      model: "gemini-2.0-flash",
      modelProvider,
      now: () => new Date("2026-05-11T08:00:00Z"),
      providerId: "telegram",
      registry: fakeRegistry as unknown as Parameters<typeof runDueFollowups>[0]["registry"]
    });

    expect(summary).toMatchObject({ delivered: 1, due: 1, errors: [] });
    expect(summary.fired[0]).toMatchObject({ id: "fu_overdue", status: "fired" });
    expect(sent).toEqual([{
      destination: "@me",
      providerId: "telegram",
      text: "Quick check on the Q3 budget memo — any blockers I can chase down?"
    }]);
    expect(generateCalls).toHaveLength(1);
    expect(generateCalls[0]?.messages[1]?.content).toContain("Check on the Q3 budget memo");

    const persisted = JSON.parse(readFileSync(file, "utf8")) as {
      followups: Array<{ id: string; status: string; firedAt?: string }>;
    };
    expect(persisted.followups.find((f) => f.id === "fu_overdue")).toMatchObject({ status: "fired" });
    expect(persisted.followups.find((f) => f.id === "fu_future")).toMatchObject({ status: "scheduled" });
    expect(persisted.followups.find((f) => f.id === "fu_already_fired")).toMatchObject({ status: "fired" });
  });

  it("zero-due is a no-op: no synthesis, no send, no rewrite", async () => {
    const { runDueFollowups } = await import("../src/index.js");
    const { mkdtempSync, writeFileSync, statSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");

    const dir = mkdtempSync(join(tmpdir(), "muse-followup-empty-"));
    const file = join(dir, "followups.json");
    writeFileSync(file, JSON.stringify({
      followups: [{
        createdAt: "2026-05-10T00:00:00Z",
        id: "fu_future",
        scheduledFor: "2030-01-01T00:00:00Z",
        status: "scheduled",
        summary: "Not yet",
        userId: "stark"
      }]
    }), "utf8");
    const before = statSync(file).mtimeMs;
    await new Promise((resolve) => setTimeout(resolve, 5));

    const summary = await runDueFollowups({
      destination: "@me",
      file,
      model: "gemini-2.0-flash",
      modelProvider: {
        generate: async () => { throw new Error("must not be called"); }
      },
      now: () => new Date("2026-05-11T00:00:00Z"),
      providerId: "telegram",
      registry: {
        send: async () => { throw new Error("must not be called"); }
      } as unknown as Parameters<typeof runDueFollowups>[0]["registry"]
    });
    expect(summary).toMatchObject({ delivered: 0, due: 0, errors: [] });
    expect(statSync(file).mtimeMs).toBe(before);
  });

  it("captures per-followup errors without aborting the loop", async () => {
    const { runDueFollowups } = await import("../src/index.js");
    const { mkdtempSync, writeFileSync, readFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");

    const dir = mkdtempSync(join(tmpdir(), "muse-followup-err-"));
    const file = join(dir, "followups.json");
    writeFileSync(file, JSON.stringify({
      followups: [
        {
          createdAt: "2026-05-10T00:00:00Z",
          id: "fu_a",
          scheduledFor: "2026-05-11T07:30:00Z",
          status: "scheduled",
          summary: "Promise A",
          userId: "stark"
        },
        {
          createdAt: "2026-05-10T00:00:00Z",
          id: "fu_b",
          scheduledFor: "2026-05-11T07:31:00Z",
          status: "scheduled",
          summary: "Promise B",
          userId: "stark"
        }
      ]
    }), "utf8");

    // Goal 156 — fu_a fails non-retryably (401) so the new shared
    // retry path doesn't mask the failure. Test intent ("errors
    // don't abort the loop") preserved; the error class now matches
    // a realistic permanent-failure shape.
    const { MessagingProviderError } = await import("@muse/messaging");
    let sendCalls = 0;
    const fakeRegistry = {
      send: async () => {
        sendCalls += 1;
        if (sendCalls === 1) {
          throw new MessagingProviderError("telegram", "UPSTREAM_FAILED", "upstream 401", 401);
        }
        return { destination: "@me", messageId: "ok", providerId: "telegram" };
      }
    };
    const summary = await runDueFollowups({
      destination: "@me",
      file,
      model: "gemini-2.0-flash",
      modelProvider: {
        generate: async () => ({ output: "Following up." })
      },
      now: () => new Date("2026-05-11T08:00:00Z"),
      providerId: "telegram",
      registry: fakeRegistry as unknown as Parameters<typeof runDueFollowups>[0]["registry"]
    });

    expect(summary.due).toBe(2);
    expect(summary.delivered).toBe(1);
    expect(summary.errors).toHaveLength(1);
    expect(summary.errors[0]).toContain("fu_a");
    expect(summary.errors[0]).toContain("upstream 401");

    const persisted = JSON.parse(readFileSync(file, "utf8")) as {
      followups: Array<{ id: string; status: string }>;
    };
    expect(persisted.followups.find((f) => f.id === "fu_a")).toMatchObject({ status: "scheduled" });
    expect(persisted.followups.find((f) => f.id === "fu_b")).toMatchObject({ status: "fired" });
  });

  it("records an error and skips delivery when synthesis returns empty text", async () => {
    const { runDueFollowups } = await import("../src/index.js");
    const { mkdtempSync, writeFileSync, readFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");

    const dir = mkdtempSync(join(tmpdir(), "muse-followup-empty-synth-"));
    const file = join(dir, "followups.json");
    writeFileSync(file, JSON.stringify({
      followups: [{
        createdAt: "2026-05-10T00:00:00Z",
        id: "fu_blank",
        scheduledFor: "2026-05-11T07:30:00Z",
        status: "scheduled",
        summary: "Anything",
        userId: "stark"
      }]
    }), "utf8");

    let sendCalled = false;
    const summary = await runDueFollowups({
      destination: "@me",
      file,
      model: "gemini-2.0-flash",
      modelProvider: { generate: async () => ({ output: "   " }) },
      now: () => new Date("2026-05-11T08:00:00Z"),
      providerId: "telegram",
      registry: {
        send: async () => {
          sendCalled = true;
          return { destination: "@me", messageId: "x", providerId: "telegram" };
        }
      } as unknown as Parameters<typeof runDueFollowups>[0]["registry"]
    });

    expect(sendCalled).toBe(false);
    expect(summary.delivered).toBe(0);
    expect(summary.errors[0]).toContain("synthesis returned empty text");
    const persisted = JSON.parse(readFileSync(file, "utf8")) as {
      followups: Array<{ id: string; status: string }>;
    };
    expect(persisted.followups.find((f) => f.id === "fu_blank")).toMatchObject({ status: "scheduled" });
  });

  it("respects maxPerTick — leaves overflow due-but-not-fired", async () => {
    const { runDueFollowups } = await import("../src/index.js");
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");

    const dir = mkdtempSync(join(tmpdir(), "muse-followup-cap-"));
    const file = join(dir, "followups.json");
    writeFileSync(file, JSON.stringify({
      followups: [1, 2, 3, 4, 5].map((n) => ({
        createdAt: "2026-05-10T00:00:00Z",
        id: `fu_${n.toString()}`,
        scheduledFor: "2026-05-11T07:00:00Z",
        status: "scheduled",
        summary: `Promise ${n.toString()}`,
        userId: "stark"
      }))
    }), "utf8");

    const summary = await runDueFollowups({
      destination: "@me",
      file,
      maxPerTick: 2,
      model: "gemini-2.0-flash",
      modelProvider: { generate: async () => ({ output: "Following up." }) },
      now: () => new Date("2026-05-11T08:00:00Z"),
      providerId: "telegram",
      registry: {
        send: async () => ({ destination: "@me", messageId: "ok", providerId: "telegram" })
      } as unknown as Parameters<typeof runDueFollowups>[0]["registry"]
    });

    expect(summary).toMatchObject({ delivered: 2, due: 2 });
  });

  it("fires the most-overdue followup first under a tight maxPerTick", async () => {
    const { runDueFollowups } = await import("../src/index.js");
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "muse-followup-order-"));
    const file = join(dir, "followups.json");
    // The OLDEST-due (most overdue) entry is written LAST in file order.
    writeFileSync(file, JSON.stringify({
      followups: [
        { createdAt: "2026-05-10T00:00:00Z", id: "fu_recent", scheduledFor: "2026-05-11T07:30:00Z", status: "scheduled", summary: "recent", userId: "stark" },
        { createdAt: "2026-05-10T00:00:00Z", id: "fu_mid", scheduledFor: "2026-05-11T07:15:00Z", status: "scheduled", summary: "mid", userId: "stark" },
        { createdAt: "2026-05-10T00:00:00Z", id: "fu_oldest", scheduledFor: "2026-05-11T07:00:00Z", status: "scheduled", summary: "oldest", userId: "stark" }
      ]
    }), "utf8");
    const summary = await runDueFollowups({
      destination: "@me", file, maxPerTick: 1, model: "gemini-2.0-flash",
      modelProvider: { generate: async () => ({ output: "Following up." }) },
      now: () => new Date("2026-05-11T08:00:00Z"), providerId: "telegram",
      registry: { send: async () => ({ destination: "@me", messageId: "ok", providerId: "telegram" }) } as unknown as Parameters<typeof runDueFollowups>[0]["registry"]
    });
    expect(summary.delivered).toBe(1);
    expect(summary.fired[0]?.id).toBe("fu_oldest"); // the most-overdue, NOT the file-first fu_recent
    const { readFollowups } = await import("../src/index.js");
    const remaining = (await readFollowups(file)).filter((f) => f.status === "scheduled").map((f) => f.id).sort();
    expect(remaining).toEqual(["fu_mid", "fu_recent"]); // the less-overdue two stay scheduled (not starved-wrong)
  });

  it("a non-finite maxPerTick (NaN from a typo'd env knob) falls back to the default, not silently zero", async () => {
    const { runDueFollowups } = await import("../src/index.js");
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");

    const dir = mkdtempSync(join(tmpdir(), "muse-followup-nan-"));
    const file = join(dir, "followups.json");
    writeFileSync(file, JSON.stringify({
      followups: [1, 2, 3].map((n) => ({
        createdAt: "2026-05-10T00:00:00Z",
        id: `fu_${n.toString()}`,
        scheduledFor: "2026-05-11T07:00:00Z",
        status: "scheduled",
        summary: `Promise ${n.toString()}`,
        userId: "stark"
      }))
    }), "utf8");

    const summary = await runDueFollowups({
      destination: "@me",
      file,
      maxPerTick: Number.NaN,
      model: "ollama/qwen3:8b",
      modelProvider: { generate: async () => ({ output: "Following up." }) },
      now: () => new Date("2026-05-11T08:00:00Z"),
      providerId: "telegram",
      registry: {
        send: async () => ({ destination: "@me", messageId: "ok", providerId: "telegram" })
      } as unknown as Parameters<typeof runDueFollowups>[0]["registry"]
    });

    // NaN → default cap (5), so all 3 due followups fire — not zero.
    expect(summary).toMatchObject({ delivered: 3, due: 3 });
  });

  it("retries transient messaging failures with exponential backoff (goal 156)", async () => {
    const { runDueFollowups } = await import("../src/index.js");
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "muse-followup-retry-"));
    const file = join(dir, "followups.json");
    writeFileSync(file, JSON.stringify({
      followups: [{
        createdAt: "2026-05-10T00:00:00Z",
        id: "fu_flaky",
        scheduledFor: "2026-05-11T07:30:00Z",
        status: "scheduled",
        summary: "Standup follow-up",
        userId: "stark"
      }]
    }), "utf8");

    let synthesizeCalls = 0;
    const attempts: number[] = [];
    const flakyRegistry = {
      send: async () => {
        attempts.push(1);
        if (attempts.length < 3) {
          throw new Error("upstream 503");
        }
        return { destination: "@me", messageId: "ok", providerId: "telegram" };
      }
    };
    const summary = await runDueFollowups({
      destination: "@me",
      file,
      model: "gemini-2.0-flash",
      modelProvider: {
        generate: async () => {
          synthesizeCalls += 1;
          return { output: "Following up." };
        }
      },
      now: () => new Date("2026-05-11T08:00:00Z"),
      providerId: "telegram",
      registry: flakyRegistry as unknown as Parameters<typeof runDueFollowups>[0]["registry"]
    });
    expect(summary.delivered).toBe(1);
    expect(summary.errors).toEqual([]);
    expect(attempts.length).toBe(3);
    // Synthesis runs exactly once even when the send retries — the
    // retry loop wraps the send call only, not the surrounding
    // synthesize-then-send step.
    expect(synthesizeCalls).toBe(1);
  });

  it("breaks out of the retry loop early on non-retryable messaging errors (goal 156)", async () => {
    const { runDueFollowups } = await import("../src/index.js");
    const { MessagingProviderError } = await import("@muse/messaging");
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "muse-followup-non-retry-"));
    const file = join(dir, "followups.json");
    writeFileSync(file, JSON.stringify({
      followups: [{
        createdAt: "2026-05-10T00:00:00Z",
        id: "fu_permanent",
        scheduledFor: "2026-05-11T07:30:00Z",
        status: "scheduled",
        summary: "Doomed follow-up",
        userId: "stark"
      }]
    }), "utf8");

    let attempts = 0;
    const summary = await runDueFollowups({
      destination: "@me",
      file,
      model: "gemini-2.0-flash",
      modelProvider: { generate: async () => ({ output: "Following up." }) },
      now: () => new Date("2026-05-11T08:00:00Z"),
      providerId: "telegram",
      registry: {
        send: async () => {
          attempts += 1;
          throw new MessagingProviderError(
            "telegram", "UPSTREAM_FAILED", "401 bad token", 401
          );
        }
      } as unknown as Parameters<typeof runDueFollowups>[0]["registry"]
    });
    expect(summary.delivered).toBe(0);
    expect(summary.errors).toHaveLength(1);
    expect(summary.errors[0]).toContain("fu_permanent");
    expect(summary.errors[0]).toContain("401 bad token");
    expect(attempts).toBe(1);
  });
});

describe("snoozeFollowup", () => {
  it("updates scheduledFor on a scheduled entry and leaves others untouched", async () => {
    const { snoozeFollowup, readFollowups } = await import("../src/index.js");
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");

    const dir = mkdtempSync(join(tmpdir(), "muse-followup-snooze-"));
    const file = join(dir, "followups.json");
    writeFileSync(file, JSON.stringify({
      followups: [
        { createdAt: "2026-05-10T00:00:00Z", id: "fu_target", scheduledFor: "2026-05-11T09:00:00Z", status: "scheduled", summary: "Push me", userId: "stark" },
        { createdAt: "2026-05-10T00:00:00Z", id: "fu_neighbour", scheduledFor: "2026-05-11T10:00:00Z", status: "scheduled", summary: "Untouched", userId: "stark" }
      ]
    }), "utf8");

    const patched = await snoozeFollowup(file, "fu_target", "2026-05-12T15:00:00Z");
    expect(patched).toMatchObject({ id: "fu_target", scheduledFor: "2026-05-12T15:00:00Z", status: "scheduled" });

    const after = await readFollowups(file);
    expect(after.find((f) => f.id === "fu_target")?.scheduledFor).toBe("2026-05-12T15:00:00Z");
    expect(after.find((f) => f.id === "fu_neighbour")?.scheduledFor).toBe("2026-05-11T10:00:00Z");
  });

  it("returns undefined and does not rewrite when the entry is already fired or cancelled", async () => {
    const { snoozeFollowup, readFollowups } = await import("../src/index.js");
    const { mkdtempSync, writeFileSync, statSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");

    const dir = mkdtempSync(join(tmpdir(), "muse-followup-snooze-guard-"));
    const file = join(dir, "followups.json");
    writeFileSync(file, JSON.stringify({
      followups: [
        { createdAt: "2026-05-10T00:00:00Z", firedAt: "2026-05-11T08:00:00Z", id: "fu_done", scheduledFor: "2026-05-11T07:00:00Z", status: "fired", summary: "Already fired", userId: "stark" },
        { cancelReason: "user-cancelled", createdAt: "2026-05-10T00:00:00Z", id: "fu_dropped", scheduledFor: "2026-05-11T07:00:00Z", status: "cancelled", summary: "Already cancelled", userId: "stark" }
      ]
    }), "utf8");
    const before = statSync(file).mtimeMs;
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(await snoozeFollowup(file, "fu_done", "2026-05-12T00:00:00Z")).toBeUndefined();
    expect(await snoozeFollowup(file, "fu_dropped", "2026-05-12T00:00:00Z")).toBeUndefined();
    expect(await snoozeFollowup(file, "fu_missing", "2026-05-12T00:00:00Z")).toBeUndefined();

    // mtime unchanged → guard short-circuited before writing.
    expect(statSync(file).mtimeMs).toBe(before);
    const after = await readFollowups(file);
    expect(after.find((f) => f.id === "fu_done")?.status).toBe("fired");
    expect(after.find((f) => f.id === "fu_dropped")?.status).toBe("cancelled");
  });
});

describe("muse.followup loopback server", () => {
  it("list filters by status, returns serialized entries sorted by scheduledFor", async () => {
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");

    const dir = mkdtempSync(join(tmpdir(), "muse-followup-mcp-list-"));
    const file = join(dir, "followups.json");
    writeFileSync(file, JSON.stringify({
      followups: [
        { createdAt: "2026-05-10T00:00:00Z", id: "fu_later", scheduledFor: "2026-05-12T10:00:00Z", status: "scheduled", summary: "Later", userId: "stark" },
        { createdAt: "2026-05-10T00:00:00Z", id: "fu_sooner", scheduledFor: "2026-05-11T09:00:00Z", status: "scheduled", summary: "Sooner", userId: "stark" },
        { createdAt: "2026-05-10T00:00:00Z", firedAt: "2026-05-10T13:00:00Z", id: "fu_done", scheduledFor: "2026-05-10T12:00:00Z", status: "fired", summary: "Old", userId: "stark" }
      ]
    }), "utf8");

    const connection = createLoopbackMcpConnection(createFollowupsMcpServer({ file }));

    const def = await connection.callTool!("list", {});
    expect(def).toMatchObject({ status: "scheduled", total: 2 });
    expect((def.followups as Array<{ id: string }>).map((f) => f.id)).toEqual(["fu_sooner", "fu_later"]);

    const all = await connection.callTool!("list", { status: "all" });
    expect(all).toMatchObject({ status: "all", total: 3 });

    const fired = await connection.callTool!("list", { status: "fired" });
    expect(fired).toMatchObject({ status: "fired", total: 1 });
    expect((fired.followups as Array<{ id: string }>)[0]?.id).toBe("fu_done");
  });

  it("cancel transitions scheduled → cancelled; rejects already-fired with a guiding error", async () => {
    const { mkdtempSync, writeFileSync, readFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");

    const dir = mkdtempSync(join(tmpdir(), "muse-followup-mcp-cancel-"));
    const file = join(dir, "followups.json");
    writeFileSync(file, JSON.stringify({
      followups: [
        { createdAt: "2026-05-10T00:00:00Z", id: "fu_drop", scheduledFor: "2026-05-11T09:00:00Z", status: "scheduled", summary: "Drop me", userId: "stark" },
        { createdAt: "2026-05-10T00:00:00Z", firedAt: "2026-05-10T13:00:00Z", id: "fu_already", scheduledFor: "2026-05-10T12:00:00Z", status: "fired", summary: "Fired", userId: "stark" }
      ]
    }), "utf8");

    const connection = createLoopbackMcpConnection(createFollowupsMcpServer({ file }));

    const ok = await connection.callTool!("cancel", { id: "fu_drop", reason: "user-revoked" });
    expect(ok).toMatchObject({ followup: { id: "fu_drop", status: "cancelled", cancelReason: "user-revoked" } });

    const onDisk = JSON.parse(readFileSync(file, "utf8")) as { followups: Array<{ id: string; status: string }> };
    expect(onDisk.followups.find((f) => f.id === "fu_drop")?.status).toBe("cancelled");

    const reFired = await connection.callTool!("cancel", { id: "fu_already" });
    expect(reFired).toMatchObject({ error: expect.stringContaining("already fired") });

    const missing = await connection.callTool!("cancel", { id: "fu_nope" });
    expect(missing).toMatchObject({ error: expect.stringContaining("no followup matches") });

    const noId = await connection.callTool!("cancel", {});
    expect(noId).toMatchObject({ error: expect.stringContaining("id is required") });
  });

  it("cancel resolves a WORD from the summary (one-shot, no prior list) and refuses an ambiguous word", async () => {
    const { mkdtempSync, writeFileSync, readFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");

    const dir = mkdtempSync(join(tmpdir(), "muse-followup-mcp-ref-"));
    const file = join(dir, "followups.json");
    writeFileSync(file, JSON.stringify({
      followups: [
        { createdAt: "2026-05-10T00:00:00Z", id: "fu_budget", scheduledFor: "2026-05-11T09:00:00Z", status: "scheduled", summary: "check the Q3 budget memo", userId: "stark" },
        { createdAt: "2026-05-10T00:00:00Z", id: "fu_sam", scheduledFor: "2026-05-11T10:00:00Z", status: "scheduled", summary: "email Sam back about budget", userId: "stark" }
      ]
    }), "utf8");
    const connection = createLoopbackMcpConnection(createFollowupsMcpServer({ file }));

    // an AMBIGUOUS word ("budget" is in both summaries) → candidates, nothing cancelled
    const ambiguous = await connection.callTool!("cancel", { id: "budget" });
    expect(ambiguous).toMatchObject({ error: expect.stringContaining("matches multiple"), candidates: expect.any(Array) });
    const afterAmbiguous = JSON.parse(readFileSync(file, "utf8")) as { followups: Array<{ id: string; status: string }> };
    expect(afterAmbiguous.followups.every((f) => f.status === "scheduled")).toBe(true); // no partial cancel

    // a DISTINCT word ("memo" only in fu_budget) → cancels that one, no id needed
    const ok = await connection.callTool!("cancel", { id: "memo" });
    expect(ok).toMatchObject({ followup: { id: "fu_budget", status: "cancelled" } });
  });

  it("snooze parses relative scheduledFor and rejects non-scheduled entries", async () => {
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");

    const dir = mkdtempSync(join(tmpdir(), "muse-followup-mcp-snooze-"));
    const file = join(dir, "followups.json");
    writeFileSync(file, JSON.stringify({
      followups: [
        { createdAt: "2026-05-10T00:00:00Z", id: "fu_push", scheduledFor: "2026-05-11T09:00:00Z", status: "scheduled", summary: "Push", userId: "stark" },
        { cancelReason: "x", createdAt: "2026-05-10T00:00:00Z", id: "fu_dropped", scheduledFor: "2026-05-10T08:00:00Z", status: "cancelled", summary: "Dropped", userId: "stark" }
      ]
    }), "utf8");

    // Pin the clock so the "in 2 hours" assertion is deterministic.
    const fixedNow = new Date("2026-05-11T08:00:00Z");
    const connection = createLoopbackMcpConnection(createFollowupsMcpServer({ file, now: () => fixedNow }));

    const ok = await connection.callTool!("snooze", { id: "fu_push", scheduledFor: "in 2 hours" });
    expect(ok).toMatchObject({ followup: { id: "fu_push", status: "scheduled", scheduledFor: "2026-05-11T10:00:00.000Z" } });

    const cancelled = await connection.callTool!("snooze", { id: "fu_dropped", scheduledFor: "tomorrow at 9am" });
    expect(cancelled).toMatchObject({ error: expect.stringContaining("already cancelled") });

    const noWhen = await connection.callTool!("snooze", { id: "fu_push" });
    expect(noWhen).toMatchObject({ error: expect.stringContaining("scheduledFor is required") });

    const badPhrase = await connection.callTool!("snooze", { id: "fu_push", scheduledFor: "lol-not-a-time" });
    expect(badPhrase).toMatchObject({ error: expect.stringContaining("ISO-8601") });
  });
});

describe("personal-patterns-fired-store", () => {
  it("read tolerates missing / bad / wrong-shape files and drops malformed entries", async () => {
    const { readPatternsFired } = await import("../src/index.js");
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");

    const dir = mkdtempSync(join(tmpdir(), "muse-pat-fired-read-"));
    expect(await readPatternsFired(join(dir, "missing.json"))).toEqual([]);

    const bad = join(dir, "bad.json");
    writeFileSync(bad, "not-json", "utf8");
    expect(await readPatternsFired(bad)).toEqual([]);

    const wrong = join(dir, "wrong.json");
    writeFileSync(wrong, JSON.stringify({ wrongKey: 1 }), "utf8");
    expect(await readPatternsFired(wrong)).toEqual([]);

    const mixed = join(dir, "mixed.json");
    writeFileSync(mixed, JSON.stringify({
      fired: [
        { patternId: "p1", firedAtMs: 1000 },
        { patternId: "p2" }, // missing firedAtMs
        { firedAtMs: 2000 }, // missing patternId
        { patternId: "p3", firedAtMs: "stringy" }, // wrong type
        "not-an-object",
        { patternId: "p4", firedAtMs: Number.POSITIVE_INFINITY }, // non-finite drops
        { patternId: "p5", firedAtMs: 3000 }
      ]
    }), "utf8");
    const survivors = await readPatternsFired(mixed);
    expect(survivors.map((r) => r.patternId)).toEqual(["p1", "p5"]);
  });

  it("recordPatternFired appends atomically; isPatternOnCooldown picks the newest entry per id", async () => {
    const { recordPatternFired, readPatternsFired, isPatternOnCooldown } = await import("../src/index.js");
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");

    const dir = mkdtempSync(join(tmpdir(), "muse-pat-fired-rec-"));
    const file = join(dir, "patterns-fired.json");

    await recordPatternFired(file, "abc123", 1_000);
    await recordPatternFired(file, "def456", 2_000);
    await recordPatternFired(file, "abc123", 5_000); // newer than the first, same id

    const all = await readPatternsFired(file);
    expect(all).toHaveLength(3);

    // 1 second after the newest "abc123" entry — under default cooldown.
    expect(isPatternOnCooldown(all, "abc123", 5_500, 24 * 60 * 60_000)).toBe(true);
    // 25 hours after the newest — past cooldown.
    expect(isPatternOnCooldown(all, "abc123", 5_000 + 25 * 60 * 60_000, 24 * 60 * 60_000)).toBe(false);
    // Pattern that was never fired → never on cooldown.
    expect(isPatternOnCooldown(all, "never-fired", 1_000_000, 24 * 60 * 60_000)).toBe(false);
    // cooldownMs <= 0 → always off.
    expect(isPatternOnCooldown(all, "abc123", 5_500, 0)).toBe(false);
  });
});

describe("runDuePatternNotices", () => {
  it("delivers fireable pattern suggestions, records the fire, returns the summary", async () => {
    const { runDuePatternNotices } = await import("../src/index.js");
    const { mkdtempSync, mkdirSync, writeFileSync, utimesSync, readFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");

    const root = mkdtempSync(join(tmpdir(), "muse-pat-fire-"));
    const notesDir = join(root, "notes");
    mkdirSync(notesDir);
    mkdirSync(join(notesDir, "journal"));
    // Five Tuesdays in a row at 21:30 local → strong cluster.
    const tuesdays = [
      new Date(2026, 3, 7, 21, 30),  // Apr 7
      new Date(2026, 3, 14, 21, 30), // Apr 14
      new Date(2026, 3, 21, 21, 30), // Apr 21
      new Date(2026, 3, 28, 21, 30), // Apr 28
      new Date(2026, 4, 5, 21, 30)   // May 5
    ];
    for (let i = 0; i < tuesdays.length; i++) {
      const file = join(notesDir, "journal", `entry-${i.toString()}.md`);
      writeFileSync(file, "x", "utf8");
      const secs = tuesdays[i]!.getTime() / 1000;
      utimesSync(file, secs, secs);
    }

    const firedFile = join(root, "patterns-fired.json");
    const sent: Array<{ providerId: string; destination: string; text: string }> = [];
    const fakeRegistry = {
      send: async (providerId: string, message: { destination: string; text: string }) => {
        sent.push({ destination: message.destination, providerId, text: message.text });
        return { destination: message.destination, messageId: "stub", providerId };
      }
    };

    const summary = await runDuePatternNotices({
      destination: "@me",
      now: () => new Date(2026, 4, 12, 21, 30), // Tuesday May 12
      patternsFiredFile: firedFile,
      providerId: "telegram",
      registry: fakeRegistry as unknown as Parameters<typeof runDuePatternNotices>[0]["registry"],
      signals: {
        activityFile: join(root, "no-activity.jsonl"),
        notesDir,
        tasksFile: join(root, "no-tasks.json")
      }
    });

    expect(summary.fireable).toBe(1);
    expect(summary.delivered).toBe(1);
    expect(summary.errors).toEqual([]);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.text).toContain("journal notes");
    expect(sent[0]!.text).toContain("21-24");

    const persisted = JSON.parse(readFileSync(firedFile, "utf8")) as { fired: Array<{ patternId: string }> };
    expect(persisted.fired).toHaveLength(1);
    expect(persisted.fired[0]!.patternId).toBe(summary.fired[0]!.id);
  });

  it("zero-fireable is a no-op (no send, no record write)", async () => {
    const { runDuePatternNotices } = await import("../src/index.js");
    const { mkdtempSync, mkdirSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const root = mkdtempSync(join(tmpdir(), "muse-pat-fire-noop-"));
    mkdirSync(join(root, "notes"));

    const summary = await runDuePatternNotices({
      destination: "@me",
      now: () => new Date(2026, 4, 12, 21, 30),
      patternsFiredFile: join(root, "patterns-fired.json"),
      providerId: "telegram",
      registry: {
        send: async () => { throw new Error("must not be called"); }
      } as unknown as Parameters<typeof runDuePatternNotices>[0]["registry"],
      signals: {
        activityFile: join(root, "no-activity.jsonl"),
        notesDir: join(root, "notes"),
        tasksFile: join(root, "no-tasks.json")
      }
    });
    expect(summary).toMatchObject({ delivered: 0, errors: [], fireable: 0 });
  });

  it("collects per-pattern errors and does NOT record a failed pattern", async () => {
    const { runDuePatternNotices } = await import("../src/index.js");
    const { mkdtempSync, mkdirSync, writeFileSync, utimesSync, readFileSync, statSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");

    const root = mkdtempSync(join(tmpdir(), "muse-pat-fire-err-"));
    const notesDir = join(root, "notes");
    mkdirSync(notesDir);
    mkdirSync(join(notesDir, "journal"));
    const tuesdays = [
      new Date(2026, 3, 14, 21, 30),
      new Date(2026, 3, 21, 21, 30),
      new Date(2026, 3, 28, 21, 30)
    ];
    for (let i = 0; i < tuesdays.length; i++) {
      const file = join(notesDir, "journal", `entry-${i.toString()}.md`);
      writeFileSync(file, "x", "utf8");
      const secs = tuesdays[i]!.getTime() / 1000;
      utimesSync(file, secs, secs);
    }
    const firedFile = join(root, "patterns-fired.json");

    const summary = await runDuePatternNotices({
      destination: "@me",
      now: () => new Date(2026, 4, 12, 21, 30),
      patternsFiredFile: firedFile,
      providerId: "telegram",
      registry: {
        send: async () => { throw new Error("upstream 503"); }
      } as unknown as Parameters<typeof runDuePatternNotices>[0]["registry"],
      signals: {
        activityFile: join(root, "no-activity.jsonl"),
        notesDir,
        tasksFile: join(root, "no-tasks.json")
      }
    });
    expect(summary.delivered).toBe(0);
    expect(summary.errors).toHaveLength(1);
    expect(summary.errors[0]).toContain("upstream 503");
    // No cooldown record should have been written for a failed send.
    expect(() => statSync(firedFile)).toThrow();
    expect(() => readFileSync(firedFile, "utf8")).toThrow();
  });
});

describe("personal-episodes-store", () => {
  it("round-trips the `trusted:false` provenance bit (episode-laundering defense) and omits it when absent/true", async () => {
    const { readEpisodes, upsertEpisode } = await import("../src/index.js");
    const { mkdtempSync, readFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "muse-ep-trust-"));
    const file = join(dir, "episodes.json");
    const base = { endedAt: "2026-06-21T01:00:00.000Z", startedAt: "2026-06-21T00:00:00.000Z", userId: "u1" };
    await upsertEpisode(file, { ...base, id: "ep_poison", summary: "discussed Acme via a feed", trusted: false });
    await upsertEpisode(file, { ...base, id: "ep_clean", summary: "discussed the Q3 budget" });
    const got = await readEpisodes(file);
    expect(got.find((e) => e.id === "ep_poison")?.trusted).toBe(false);
    expect(got.find((e) => e.id === "ep_clean")?.trusted).toBeUndefined();
    // Only persisted when false — a clean episode's serialized form carries no key.
    expect(readFileSync(file, "utf8")).not.toMatch(/"id":\s*"ep_clean"[^}]*"trusted"/u);
  });

  it("read tolerates missing / corrupt / wrong-shape files and drops invalid entries", async () => {
    const { readEpisodes } = await import("../src/index.js");
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");

    const dir = mkdtempSync(join(tmpdir(), "muse-ep-read-"));
    // Missing file.
    expect(await readEpisodes(join(dir, "missing.json"))).toEqual([]);

    // Bad JSON.
    const garbled = join(dir, "garbled.json");
    writeFileSync(garbled, "not json", "utf8");
    expect(await readEpisodes(garbled)).toEqual([]);

    // Wrong-shape root.
    const wrongShape = join(dir, "wrong.json");
    writeFileSync(wrongShape, JSON.stringify({ wrongKey: "x" }), "utf8");
    expect(await readEpisodes(wrongShape)).toEqual([]);

    // Mixed valid / invalid entries — the invalid ones are silently dropped
    // (empty summary, non-string topic, missing field) so a corrupt entry
    // doesn't sink the whole file.
    const mixed = join(dir, "mixed.json");
    writeFileSync(mixed, JSON.stringify({
      episodes: [
        { id: "ep_ok", userId: "stark", startedAt: "2026-05-12T22:00:00Z", endedAt: "2026-05-12T22:18:00Z", summary: "Good one", topics: ["Q3"] },
        { id: "ep_blank", userId: "stark", startedAt: "x", endedAt: "x", summary: "  " },
        { id: "ep_no_topics_ok", userId: "stark", startedAt: "2026-05-11T22:00:00Z", endedAt: "2026-05-11T22:18:00Z", summary: "No topics field is fine" },
        { id: "ep_bad_topics", userId: "stark", startedAt: "x", endedAt: "x", summary: "yes", topics: [1, 2] },
        "not even an object"
      ]
    }), "utf8");
    const survivors = await readEpisodes(mixed);
    expect(survivors.map((e) => e.id)).toEqual(["ep_ok", "ep_no_topics_ok"]);
  });

  it("upsert replaces by id; remove + clear behave correctly", async () => {
    const { upsertEpisode, removeEpisode, clearEpisodes, readEpisodes } = await import("../src/index.js");
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");

    const dir = mkdtempSync(join(tmpdir(), "muse-ep-crud-"));
    const file = join(dir, "episodes.json");

    await upsertEpisode(file, {
      endedAt: "2026-05-12T22:18:00Z",
      id: "ep_1",
      startedAt: "2026-05-12T22:00:00Z",
      summary: "Original summary",
      topics: ["Q3"],
      userId: "stark"
    });
    await upsertEpisode(file, {
      endedAt: "2026-05-11T22:18:00Z",
      id: "ep_2",
      startedAt: "2026-05-11T22:00:00Z",
      summary: "Second one",
      userId: "stark"
    });
    expect((await readEpisodes(file)).map((e) => e.id)).toEqual(["ep_1", "ep_2"]);

    // Re-upsert ep_1 with a different summary — should replace, not duplicate.
    await upsertEpisode(file, {
      endedAt: "2026-05-12T22:18:00Z",
      id: "ep_1",
      startedAt: "2026-05-12T22:00:00Z",
      summary: "Re-summarised after retry",
      topics: ["Q3", "Notion"],
      userId: "stark"
    });
    const after = await readEpisodes(file);
    expect(after).toHaveLength(2);
    expect(after.find((e) => e.id === "ep_1")?.summary).toBe("Re-summarised after retry");
    expect(after.find((e) => e.id === "ep_1")?.topics).toEqual(["Q3", "Notion"]);

    // remove returns true on hit, false on miss; the file shrinks accordingly.
    expect(await removeEpisode(file, "ep_1")).toBe(true);
    expect(await removeEpisode(file, "ep_does_not_exist")).toBe(false);
    expect((await readEpisodes(file)).map((e) => e.id)).toEqual(["ep_2"]);

    // clear drops everything but keeps the shape readable.
    await clearEpisodes(file);
    expect(await readEpisodes(file)).toEqual([]);
  });

  it("vacuum keeps the N most-recent by endedAt and returns the drop count", async () => {
    const { upsertEpisode, vacuumEpisodes, readEpisodes } = await import("../src/index.js");
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");

    const dir = mkdtempSync(join(tmpdir(), "muse-ep-vacuum-"));
    const file = join(dir, "episodes.json");

    for (let i = 1; i <= 5; i += 1) {
      const day = String(i).padStart(2, "0");
      await upsertEpisode(file, {
        endedAt: `2026-05-${day}T22:18:00Z`,
        id: `ep_${i.toString()}`,
        startedAt: `2026-05-${day}T22:00:00Z`,
        summary: `Session ${i.toString()}`,
        userId: "stark"
      });
    }

    // No-op when under the cap.
    expect(await vacuumEpisodes(file, 10)).toBe(0);
    expect((await readEpisodes(file)).length).toBe(5);

    // Cap to 2 — should drop the three oldest by endedAt.
    expect(await vacuumEpisodes(file, 2)).toBe(3);
    const kept = (await readEpisodes(file)).map((e) => e.id).sort();
    expect(kept).toEqual(["ep_4", "ep_5"]);
  });

  it("vacuum is deterministic when episodes share the same endedAt (id tiebreaker — newer id desc)", async () => {
    const { upsertEpisode, vacuumEpisodes, readEpisodes } = await import("../src/index.js");
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");

    const dir = mkdtempSync(join(tmpdir(), "muse-ep-vacuum-tie-"));
    const file = join(dir, "episodes.json");
    const sameEnd = "2026-05-12T22:18:00Z";
    for (const id of ["ep_a", "ep_b", "ep_c"]) {
      await upsertEpisode(file, {
        endedAt: sameEnd,
        id,
        startedAt: "2026-05-12T22:00:00Z",
        summary: `summary ${id}`,
        userId: "stark"
      });
    }
    expect(await vacuumEpisodes(file, 2)).toBe(1);
    const keptIds = (await readEpisodes(file)).map((e) => e.id).sort();
    expect(keptIds, "lexicographically-larger ids win the tiebreaker → ep_b + ep_c kept, ep_a dropped").toEqual(["ep_b", "ep_c"]);
  });

  it("vacuumEpisodes finite-guards maxEntries so a NaN / Infinity / 0 / negative caller-supplied cap falls back to the default instead of wiping the entire episodes file (NaN: Math.max(1, Math.trunc(NaN)) === NaN, slice(0, NaN) === [], writeEpisodes([]) DESTROYS the file)", async () => {
    const { upsertEpisode, vacuumEpisodes, readEpisodes } = await import("../src/index.js");
    const { mkdtemp } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = await mkdtemp(join(tmpdir(), "muse-episodes-vacuum-guard-"));
    const file = join(dir, "episodes.json");

    for (let i = 0; i < 3; i += 1) {
      await upsertEpisode(file, {
        endedAt: `2026-05-12T22:${(15 + i).toString().padStart(2, "0")}:00Z`,
        id: `ep_${i.toString()}`,
        startedAt: "2026-05-12T22:00:00Z",
        summary: `summary ${i.toString()}`,
        userId: "stark"
      });
    }

    // NaN — pre-fix this WIPED THE FILE. Post-fix: falls to the
    // default cap (well above 3), so nothing is dropped.
    await expect(vacuumEpisodes(file, Number.NaN)).resolves.toBe(0);
    expect((await readEpisodes(file)).map((e) => e.id).sort()).toEqual(["ep_0", "ep_1", "ep_2"]);

    // Infinity — pre-fix `cap === Infinity` skipped the work
    // (slice(0, Infinity) returns the whole array, no episodes
    // dropped — semantically OK but inconsistent with the
    // "guard non-finite" contract). Post-fix: fallback applies.
    await expect(vacuumEpisodes(file, Number.POSITIVE_INFINITY)).resolves.toBe(0);
    expect((await readEpisodes(file)).map((e) => e.id).sort()).toEqual(["ep_0", "ep_1", "ep_2"]);

    // 0 — `0 > 0` false → fallback. Pre-fix Math.max(1, 0) = 1
    // would have kept only the newest; post-fix keeps all under
    // the default 500 cap.
    await expect(vacuumEpisodes(file, 0)).resolves.toBe(0);
    expect((await readEpisodes(file)).map((e) => e.id).sort()).toEqual(["ep_0", "ep_1", "ep_2"]);

    // Negative — same family.
    await expect(vacuumEpisodes(file, -5)).resolves.toBe(0);
    expect((await readEpisodes(file)).map((e) => e.id).sort()).toEqual(["ep_0", "ep_1", "ep_2"]);
  });

  it("serialize emits topics only when present and non-empty", async () => {
    const { serializeEpisode } = await import("../src/index.js");
    const withTopics = serializeEpisode({
      endedAt: "2026-05-12T22:18:00Z",
      id: "ep_t",
      startedAt: "2026-05-12T22:00:00Z",
      summary: "Has topics",
      topics: ["Q3"],
      userId: "stark"
    });
    expect(withTopics).toHaveProperty("topics", ["Q3"]);

    const withoutTopics = serializeEpisode({
      endedAt: "2026-05-12T22:18:00Z",
      id: "ep_nt",
      startedAt: "2026-05-12T22:00:00Z",
      summary: "No topics",
      userId: "stark"
    });
    expect(withoutTopics).not.toHaveProperty("topics");

    const emptyTopics = serializeEpisode({
      endedAt: "2026-05-12T22:18:00Z",
      id: "ep_et",
      startedAt: "2026-05-12T22:00:00Z",
      summary: "Empty topics array",
      topics: [],
      userId: "stark"
    });
    // Empty array is treated as "no topics" — the field is dropped from the
    // serialised form to keep callers' rendering paths simple.
    expect(emptyTopics).not.toHaveProperty("topics");
  });
});

describe("muse.episode loopback server", () => {
  async function seedFile(): Promise<{ file: string }> {
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "muse-ep-mcp-"));
    const file = join(dir, "episodes.json");
    writeFileSync(file, JSON.stringify({
      episodes: [
        { id: "ep_a", userId: "stark", startedAt: "2026-05-12T22:00:00Z", endedAt: "2026-05-12T22:18:00Z", summary: "Discussed Q3 budget memo. Decided Notion.", topics: ["Q3 budget memo", "Notion"] },
        { id: "ep_b", userId: "stark", startedAt: "2026-05-11T22:00:00Z", endedAt: "2026-05-11T22:18:00Z", summary: "Wedding venue shortlist — three candidates.", topics: ["wedding"] },
        { id: "ep_c", userId: "rhodey", startedAt: "2026-05-10T18:00:00Z", endedAt: "2026-05-10T18:30:00Z", summary: "Different user.", topics: ["other"] }
      ]
    }), "utf8");
    return { file };
  }

  it("list sorts newest-first, honours `limit` + `userId`", async () => {
    const { file } = await seedFile();
    const connection = createLoopbackMcpConnection(createEpisodesMcpServer({ file }));

    const all = await connection.callTool!("list", {});
    expect(all.total).toBe(3);
    expect((all.episodes as Array<{ id: string }>).map((e) => e.id)).toEqual(["ep_a", "ep_b", "ep_c"]);

    const scoped = await connection.callTool!("list", { userId: "stark" });
    expect(scoped).toMatchObject({ userId: "stark", total: 2 });

    const limited = await connection.callTool!("list", { limit: 1 });
    expect(limited.total).toBe(3); // the REAL store size (was incidentally 1 = the post-limit slice length)
    expect(limited.shown).toBe(1); // the limit-honored returned count
    expect((limited.episodes as Array<{ id: string }>)[0]!.id).toBe("ep_a");
  });

  it("search matches summary AND topic substrings (case-insensitive); query required", async () => {
    const { file } = await seedFile();
    const connection = createLoopbackMcpConnection(createEpisodesMcpServer({ file }));

    const bySummary = await connection.callTool!("search", { query: "BUDGET" });
    expect(bySummary.total).toBe(1);
    expect((bySummary.episodes as Array<{ id: string }>)[0]!.id).toBe("ep_a");

    const byTopic = await connection.callTool!("search", { query: "wedding" });
    expect(byTopic.total).toBe(1);
    expect((byTopic.episodes as Array<{ id: string }>)[0]!.id).toBe("ep_b");

    const noQuery = await connection.callTool!("search", {});
    expect(noQuery).toMatchObject({ error: expect.stringContaining("query is required") });
  });

  it("show returns the full record by id; missing id yields a structured error", async () => {
    const { file } = await seedFile();
    const connection = createLoopbackMcpConnection(createEpisodesMcpServer({ file }));

    const ok = await connection.callTool!("show", { id: "ep_a" });
    expect((ok.episode as { summary: string }).summary).toContain("Q3 budget memo");

    const missing = await connection.callTool!("show", { id: "ep_nope" });
    expect(missing).toMatchObject({ error: expect.stringContaining("not found") });
  });

  it("remove drops one entry on hit, errors on miss; clear refuses without confirm:true", async () => {
    const { file } = await seedFile();
    const { readFileSync } = await import("node:fs");
    const connection = createLoopbackMcpConnection(createEpisodesMcpServer({ file }));

    const removed = await connection.callTool!("remove", { id: "ep_b" });
    expect(removed).toMatchObject({ id: "ep_b", removed: true });
    let onDisk = JSON.parse(readFileSync(file, "utf8")) as { episodes: Array<{ id: string }> };
    expect(onDisk.episodes.map((e) => e.id)).toEqual(["ep_a", "ep_c"]);

    const missMatch = await connection.callTool!("remove", { id: "ep_nope" });
    expect(missMatch).toMatchObject({ error: expect.stringContaining("not found") });

    const refused = await connection.callTool!("clear", {});
    expect(refused).toMatchObject({ error: expect.stringContaining("confirm:true") });
    onDisk = JSON.parse(readFileSync(file, "utf8")) as { episodes: Array<{ id: string }> };
    expect(onDisk.episodes.length).toBe(2);

    const cleared = await connection.callTool!("clear", { confirm: true });
    expect(cleared).toEqual({ cleared: true, removed: 2 });
    onDisk = JSON.parse(readFileSync(file, "utf8")) as { episodes: unknown[] };
    expect(onDisk.episodes).toEqual([]);
  });

  it("search mode=llm-judge — rejects when no modelProvider wired", async () => {
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "muse-ep-mcp-judge-noprov-"));
    const file = join(dir, "episodes.json");
    writeFileSync(file, JSON.stringify({ episodes: [] }), "utf8");
    const connection = createLoopbackMcpConnection(createEpisodesMcpServer({ file }));
    const result = await connection.callTool!("search", { mode: "llm-judge", query: "anything" });
    expect(result).toMatchObject({ error: expect.stringContaining("llm-judge mode requires modelProvider") });
  });

  it("search mode=llm-judge — picks ids returned by the model in relevance order, drops hallucinated ids", async () => {
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "muse-ep-mcp-judge-ok-"));
    const file = join(dir, "episodes.json");
    writeFileSync(file, JSON.stringify({
      episodes: [
        { id: "ep_a", userId: "stark", startedAt: "2026-05-12T22:00:00Z", endedAt: "2026-05-12T22:18:00Z", summary: "Q3 budget memo discussion. User decided to draft in Notion.", topics: ["Q3 budget memo", "Notion"] },
        { id: "ep_b", userId: "stark", startedAt: "2026-05-11T22:00:00Z", endedAt: "2026-05-11T22:18:00Z", summary: "Wedding venue shortlist.", topics: ["wedding"] },
        { id: "ep_c", userId: "stark", startedAt: "2026-05-10T22:00:00Z", endedAt: "2026-05-10T22:18:00Z", summary: "Routine setup discussion.", topics: ["routine"] }
      ]
    }), "utf8");

    let seenMessages: ReadonlyArray<{ role: string; content: string }> = [];
    const modelProvider = {
      generate: async (req: { messages: ReadonlyArray<{ role: "system" | "user" | "assistant"; content: string }> }) => {
        seenMessages = req.messages;
        // Model returns ep_a first (most relevant), ep_b second, then a fake id that must be dropped.
        return { output: '["ep_a", "ep_b", "ep_does_not_exist"]' };
      }
    };
    const connection = createLoopbackMcpConnection(createEpisodesMcpServer({
      file,
      model: "stub",
      modelProvider
    }));

    const result = await connection.callTool!("search", { mode: "llm-judge", query: "Notion thing" });
    expect(result.mode).toBe("llm-judge");
    expect(result.total).toBe(2);
    expect((result.episodes as Array<{ id: string }>).map((e) => e.id)).toEqual(["ep_a", "ep_b"]);
    // The user message has every candidate id + topic in the prompt.
    const userMsg = seenMessages.find((m) => m.role === "user")?.content ?? "";
    expect(userMsg).toContain("[ep_a]");
    expect(userMsg).toContain("Notion");
    expect(userMsg).toContain("Query: Notion thing");
  });

  it("search mode=llm-judge — tolerates prose wrap + returns [] on malformed JSON", async () => {
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "muse-ep-mcp-judge-edge-"));
    const file = join(dir, "episodes.json");
    writeFileSync(file, JSON.stringify({
      episodes: [
        { id: "ep_x", userId: "stark", startedAt: "2026-05-12T22:00:00Z", endedAt: "2026-05-12T22:18:00Z", summary: "S", topics: ["t"] }
      ]
    }), "utf8");

    const wrappedProvider = {
      generate: async () => ({ output: 'Sure, here you go: ["ep_x"] — hope this helps!' })
    };
    const wrappedConn = createLoopbackMcpConnection(createEpisodesMcpServer({ file, model: "stub", modelProvider: wrappedProvider }));
    const wrapped = await wrappedConn.callTool!("search", { mode: "llm-judge", query: "x" });
    expect((wrapped.episodes as Array<{ id: string }>).map((e) => e.id)).toEqual(["ep_x"]);

    const badProvider = { generate: async () => ({ output: "completely-not-json" }) };
    const badConn = createLoopbackMcpConnection(createEpisodesMcpServer({ file, model: "stub", modelProvider: badProvider }));
    const bad = await badConn.callTool!("search", { mode: "llm-judge", query: "x" });
    expect(bad.total).toBe(0);
  });
});

describe("muse.pattern loopback server", () => {
  async function seedTuesdayJournalsAndFired(): Promise<{ root: string; firedFile: string; notesDir: string }> {
    const { mkdtempSync, mkdirSync, writeFileSync, utimesSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const root = mkdtempSync(join(tmpdir(), "muse-pat-mcp-"));
    const notesDir = join(root, "notes");
    mkdirSync(notesDir);
    mkdirSync(join(notesDir, "journal"));
    const tuesdays = [
      new Date(2026, 3, 14, 21, 30),
      new Date(2026, 3, 21, 21, 30),
      new Date(2026, 3, 28, 21, 30)
    ];
    for (let i = 0; i < tuesdays.length; i++) {
      const f = join(notesDir, "journal", `entry-${i.toString()}.md`);
      writeFileSync(f, "x", "utf8");
      const secs = tuesdays[i]!.getTime() / 1000;
      utimesSync(f, secs, secs);
    }
    const firedFile = join(root, "patterns-fired.json");
    writeFileSync(firedFile, JSON.stringify({
      fired: [
        { patternId: "abc123def456", firedAtMs: 1_700_000_000_000 },
        { patternId: "deadbeef0001", firedAtMs: 1_600_000_000_000 }
      ]
    }), "utf8");
    return { firedFile, notesDir, root };
  }

  it("list runs both detectors on the actual filesystem signals", async () => {
    const { firedFile, notesDir, root } = await seedTuesdayJournalsAndFired();
    const { join } = await import("node:path");
    const connection = createLoopbackMcpConnection(createPatternsMcpServer({
      activityFile: join(root, "no-activity.jsonl"),
      file: firedFile,
      notesDir,
      now: () => new Date(2026, 4, 12, 21, 30),
      tasksFile: join(root, "no-tasks.json")
    }));

    const listed = await connection.callTool!("list", {});
    expect(listed.total).toBeGreaterThan(0);
    const tod = (listed.patterns as Array<{ category: string }>).find((p) => p.category === "time-of-day-action");
    expect(tod).toBeDefined();
  });

  it("fired_history returns the cooldown sidecar newest-first up to `limit`", async () => {
    const { firedFile, notesDir, root } = await seedTuesdayJournalsAndFired();
    const { join } = await import("node:path");
    const connection = createLoopbackMcpConnection(createPatternsMcpServer({
      activityFile: join(root, "no-activity.jsonl"),
      file: firedFile,
      notesDir,
      tasksFile: join(root, "no-tasks.json")
    }));

    const listed = await connection.callTool!("fired_history", {});
    expect(listed.total).toBe(2);
    expect((listed.fired as Array<{ firedAtMs: number }>)[0]!.firedAtMs).toBe(1_700_000_000_000);

    const limited = await connection.callTool!("fired_history", { limit: 1 });
    expect(limited.total).toBe(1);
  });

  it("reset refuses without confirm:true; wipes with confirm and reports prior count", async () => {
    const { firedFile, notesDir, root } = await seedTuesdayJournalsAndFired();
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const connection = createLoopbackMcpConnection(createPatternsMcpServer({
      activityFile: join(root, "no-activity.jsonl"),
      file: firedFile,
      notesDir,
      tasksFile: join(root, "no-tasks.json")
    }));

    const refused = await connection.callTool!("reset", {});
    expect(refused).toMatchObject({ error: expect.stringContaining("confirm:true") });
    let onDisk = JSON.parse(readFileSync(firedFile, "utf8")) as { fired: unknown[] };
    expect(onDisk.fired.length).toBe(2);

    const cleared = await connection.callTool!("reset", { confirm: true });
    expect(cleared).toEqual({ cleared: true, removed: 2 });
    onDisk = JSON.parse(readFileSync(firedFile, "utf8")) as { fired: unknown[] };
    expect(onDisk.fired).toEqual([]);
  });
});

describe("personal-followup-llm-budget-store", () => {
  it("read tolerates missing / bad-JSON / wrong-shape files (returns undefined)", async () => {
    const { readFollowupLlmBudget } = await import("../src/index.js");
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "muse-llm-budget-read-"));

    expect(await readFollowupLlmBudget(join(dir, "missing.json"))).toBeUndefined();

    const bad = join(dir, "bad.json");
    writeFileSync(bad, "not json", "utf8");
    expect(await readFollowupLlmBudget(bad)).toBeUndefined();

    const wrong = join(dir, "wrong.json");
    writeFileSync(wrong, JSON.stringify({ wrongKey: 1 }), "utf8");
    expect(await readFollowupLlmBudget(wrong)).toBeUndefined();

    const nanCalls = join(dir, "nan.json");
    writeFileSync(nanCalls, JSON.stringify({ date: "2026-05-13", calls: "twenty" }), "utf8");
    expect(await readFollowupLlmBudget(nanCalls)).toBeUndefined();
  });

  it("incrementFollowupLlmBudget increments same-day; resets on date change", async () => {
    const { incrementFollowupLlmBudget, readFollowupLlmBudget } = await import("../src/index.js");
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "muse-llm-budget-inc-"));
    const file = join(dir, "budget.json");

    const first = await incrementFollowupLlmBudget(file, "2026-05-13");
    expect(first).toEqual({ calls: 1, date: "2026-05-13" });

    const second = await incrementFollowupLlmBudget(file, "2026-05-13");
    expect(second).toEqual({ calls: 2, date: "2026-05-13" });

    const next = await incrementFollowupLlmBudget(file, "2026-05-14");
    expect(next).toEqual({ calls: 1, date: "2026-05-14" });

    expect(await readFollowupLlmBudget(file)).toEqual({ calls: 1, date: "2026-05-14" });
  });

  it("isFollowupLlmBudgetExhausted: no record / date mismatch → false; cap reached → true; cap <= 0 → true (safety)", async () => {
    const { isFollowupLlmBudgetExhausted } = await import("../src/index.js");
    expect(isFollowupLlmBudgetExhausted(undefined, "2026-05-13", 20)).toBe(false);
    expect(isFollowupLlmBudgetExhausted({ calls: 19, date: "2026-05-13" }, "2026-05-13", 20)).toBe(false);
    expect(isFollowupLlmBudgetExhausted({ calls: 20, date: "2026-05-13" }, "2026-05-13", 20)).toBe(true);
    expect(isFollowupLlmBudgetExhausted({ calls: 100, date: "2026-05-12" }, "2026-05-13", 20)).toBe(false);
    expect(isFollowupLlmBudgetExhausted({ calls: 0, date: "2026-05-13" }, "2026-05-13", 0)).toBe(true);
    expect(isFollowupLlmBudgetExhausted({ calls: 5, date: "2026-05-13" }, "2026-05-13", -1)).toBe(true);
  });
});

describe("personal-status-summary helpers (direct unit tests)", () => {
  it("summariseRemindersRows counts pending/fired/overdue and picks earliest pending dueAt as next", async () => {
    const { summariseRemindersRows } = await import("@muse/domain-tools");
    const past = "2026-05-12T08:00:00Z";
    const future = "2026-05-13T09:00:00Z";
    const nowMs = Date.parse("2026-05-13T00:00:00Z");
    const rows = [
      { id: "rem_pending_overdue", text: "Call vet", dueAt: past, status: "pending", createdAt: past },
      { id: "rem_pending_future", text: "Pick up dry cleaning", dueAt: future, status: "pending", createdAt: past },
      { id: "rem_fired", text: "Already done", dueAt: past, status: "fired", firedAt: past, createdAt: past },
      { id: "rem_bad_status", text: "weird", dueAt: future, status: "snoozed" as never, createdAt: past }
    ];
    const summary = summariseRemindersRows(rows, nowMs);
    expect(summary).toMatchObject({ pending: 2, fired: 1, overdue: 1, total: 4 });
    // Earliest pending wins regardless of overdue-ness.
    expect(summary.nextDueAt).toBe(past);
    expect(summary.nextText).toBe("Call vet");
  });

  it("summariseRemindersRows: empty rows return zero counts and no next", async () => {
    const { summariseRemindersRows } = await import("@muse/domain-tools");
    const summary = summariseRemindersRows([], Date.now());
    expect(summary).toEqual({ fired: 0, nextDueAt: undefined, nextText: undefined, overdue: 0, pending: 0, total: 0 });
  });

  it("summariseRemindersRows skips rows with missing id or unparseable dueAt", async () => {
    const { summariseRemindersRows } = await import("@muse/domain-tools");
    const rows = [
      { id: 42 as never, text: "missing id-string", dueAt: "2026-05-12T08:00:00Z", status: "pending", createdAt: "" },
      { id: "rem_bad_due", text: "no-iso", dueAt: "not-a-date", status: "pending", createdAt: "" }
    ];
    const summary = summariseRemindersRows(rows, Date.now());
    expect(summary.total).toBe(1);
    expect(summary.pending).toBe(1);
    expect(summary.nextDueAt).toBeUndefined();
  });

  it("summariseFollowupsRows filters by userId and counts scheduled/fired/cancelled", async () => {
    const { summariseFollowupsRows } = await import("@muse/domain-tools");
    const rows = [
      { id: "fu_s_a", userId: "stark", scheduledFor: "2030-02-01T00:00:00Z", status: "scheduled", summary: "Later", createdAt: "" },
      { id: "fu_s_b", userId: "stark", scheduledFor: "2030-01-01T00:00:00Z", status: "scheduled", summary: "Earlier", createdAt: "" },
      { id: "fu_fired", userId: "stark", scheduledFor: "2026-05-10T00:00:00Z", status: "fired", summary: "Done", firedAt: "", createdAt: "" },
      { id: "fu_cancelled", userId: "stark", scheduledFor: "2026-05-09T00:00:00Z", status: "cancelled", summary: "Dropped", createdAt: "" },
      { id: "fu_other_user", userId: "rhodey", scheduledFor: "2030-01-01T00:00:00Z", status: "scheduled", summary: "Other", createdAt: "" }
    ];
    const summary = summariseFollowupsRows(rows, "stark");
    expect(summary).toMatchObject({ scheduled: 2, fired: 1, cancelled: 1, total: 4 });
    expect(summary.nextScheduledFor).toBe("2030-01-01T00:00:00Z");
    expect(summary.nextScheduledSummary).toBe("Earlier");
  });

  it("summariseFollowupsRows: rhodey-only rows when filtering as stark → zero", async () => {
    const { summariseFollowupsRows } = await import("@muse/domain-tools");
    const rows = [
      { id: "fu_other", userId: "rhodey", scheduledFor: "2030-01-01T00:00:00Z", status: "scheduled", summary: "Other", createdAt: "" }
    ];
    const summary = summariseFollowupsRows(rows, "stark");
    expect(summary.total).toBe(0);
    expect(summary.nextScheduledFor).toBeUndefined();
  });

  it("summariseEpisodesRows filters by userId and picks newest endedAt as last", async () => {
    const { summariseEpisodesRows } = await import("@muse/domain-tools");
    const rows = [
      { id: "ep_a", userId: "stark", endedAt: "2026-05-12T22:00:00Z", summary: "Older" },
      { id: "ep_b", userId: "stark", endedAt: "2026-05-13T08:00:00Z", summary: "Newest" },
      { id: "ep_other", userId: "rhodey", endedAt: "2030-01-01T00:00:00Z", summary: "Filtered out" },
      "not-an-object" as unknown,
      null
    ];
    const summary = summariseEpisodesRows(rows, "stark");
    expect(summary.total).toBe(2);
    expect(summary.lastEndedAt).toBe("2026-05-13T08:00:00Z");
    expect(summary.lastSummary).toBe("Newest");
  });

  it("summariseEpisodesRows compares parsed instants, not raw strings (mixed precision / tz offsets)", async () => {
    const { summariseEpisodesRows } = await import("@muse/domain-tools");
    // ...00.500Z is LATER than ...00Z, but lexicographically
    // "...00Z" > "...00.500Z" — pre-fix this returned "earlier".
    const precision = [
      { id: "p1", userId: "u", endedAt: "2026-05-19T10:00:00Z", summary: "earlier" },
      { id: "p2", userId: "u", endedAt: "2026-05-19T10:00:00.500Z", summary: "later" }
    ];
    expect(summariseEpisodesRows(precision, "u").lastSummary).toBe("later");

    // 02:00Z is later than 10:00+09:00 (=01:00Z); string compare
    // wrongly picked the +09:00 one.
    const tz = [
      { id: "t1", userId: "u", endedAt: "2026-05-19T10:00:00+09:00", summary: "01:00Z" },
      { id: "t2", userId: "u", endedAt: "2026-05-19T02:00:00Z", summary: "02:00Z latest" }
    ];
    expect(summariseEpisodesRows(tz, "u").lastSummary).toBe("02:00Z latest");

    // An unparseable endedAt no longer wins via lexicographic
    // compare (now consistent with the sibling summarisers).
    const garbage = [
      { id: "g1", userId: "u", endedAt: "zzz-not-a-date", summary: "garbage" },
      { id: "g2", userId: "u", endedAt: "2026-05-19T00:00:00Z", summary: "valid" }
    ];
    const g = summariseEpisodesRows(garbage, "u");
    expect(g.total).toBe(2);
    expect(g.lastEndedAt).toBe("2026-05-19T00:00:00Z");
    expect(g.lastSummary).toBe("valid");
  });

  it("summarisePatternsFiredRows: counts every row with a string patternId; only valid firedAtMs updates last", async () => {
    const { summarisePatternsFiredRows } = await import("@muse/domain-tools");
    const rows = [
      { patternId: "pat_a", firedAtMs: 1_700_000_000_000 },
      { patternId: "pat_b", firedAtMs: 1_800_000_000_000 },
      { patternId: 42 as never, firedAtMs: 1_900_000_000_000 }, // bad patternId — skipped entirely
      { patternId: "pat_c", firedAtMs: "stringy" as never }, // counts in total; doesn't update last
      { patternId: "pat_d", firedAtMs: Number.NaN } // counts in total; non-finite doesn't update last
    ];
    const summary = summarisePatternsFiredRows(rows);
    expect(summary.total).toBe(4);
    expect(summary.lastFiredAtIso).toBe(new Date(1_800_000_000_000).toISOString());
  });

  it("summarisePatternsFiredRows: zero rows → no lastFiredAtIso", async () => {
    const { summarisePatternsFiredRows } = await import("@muse/domain-tools");
    const summary = summarisePatternsFiredRows([]);
    expect(summary).toEqual({ lastFiredAtIso: undefined, total: 0 });
  });

  it("summarisePatternsFiredRows: a finite but out-of-Date-range firedAtMs degrades, never throws", async () => {
    const { summarisePatternsFiredRows } = await import("@muse/domain-tools");
    let summary: ReturnType<typeof summarisePatternsFiredRows>;
    expect(() => {
      summary = summarisePatternsFiredRows([
        { patternId: "pat_corrupt", firedAtMs: 1e30 } // finite, but new Date(1e30) is Invalid
      ]);
    }).not.toThrow();
    expect(summary!).toEqual({ lastFiredAtIso: undefined, total: 1 });
    // A valid row alongside the corrupt one still resolves.
    expect(summarisePatternsFiredRows([
      { patternId: "bad", firedAtMs: 1e30 },
      { patternId: "ok", firedAtMs: 1_800_000_000_000 }
    ])).toEqual({ lastFiredAtIso: new Date(1_800_000_000_000).toISOString(), total: 2 });
  });
});

describe("readActivityFeed — corrupt firedAtMs must not sink the whole feed", () => {
  it("drops a pattern row with an out-of-range firedAtMs instead of throwing", async () => {
    const { readActivityFeed } = await import("@muse/domain-tools");
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "muse-activity-corrupt-"));
    const file = join(dir, "patterns-fired.json");
    writeFileSync(file, JSON.stringify({
      fired: [
        { patternId: "bad", firedAtMs: 1e30 }, // finite but new Date(1e30) is Invalid
        { patternId: "ok", firedAtMs: 1_800_000_000_000, suggestion: "do X" }
      ]
    }));

    let entries: Awaited<ReturnType<typeof readActivityFeed>> = [];
    await expect((async () => {
      entries = await readActivityFeed({ patternsFiredFile: file, kind: "pattern" });
    })()).resolves.toBeUndefined();
    expect(entries.map((e) => e.id)).toEqual(["ok"]);
    expect(entries[0]!.whenIso).toBe(new Date(1_800_000_000_000).toISOString());
  });

  it("orders the merged feed by instant, not raw ISO string (mixed precision / offset)", async () => {
    const { readActivityFeed } = await import("@muse/domain-tools");
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "muse-activity-order-"));
    const file = join(dir, "episodes.json");
    // endedAt is passed straight through as whenIso (no normalisation).
    writeFileSync(file, JSON.stringify({
      episodes: [
        { id: "newest-ms", endedAt: "2026-05-14T09:00:00.500Z", summary: "a" },
        { id: "utc", endedAt: "2026-05-14T09:00:00Z", summary: "b" },
        { id: "offset", endedAt: "2026-05-14T18:00:00+09:00", summary: "c" }
      ]
    }));

    const entries = await readActivityFeed({ episodesFile: file, kind: "episode" });
    // Instants: newest-ms 09:00:00.500, utc & offset both 09:00:00.000
    // (offset 18:00+09:00 == 09:00Z). Newest first; the equal-instant
    // pair keeps file order (stable). Pre-fix localeCompare gave
    // ["offset","utc","newest-ms"] — newest sorted LAST.
    expect(entries.map((e) => e.id)).toEqual(["newest-ms", "utc", "offset"]);
  });
});

describe("muse.status loopback server", () => {
  it("snapshot returns the model from the constructor's `options.model` (overrides env)", async () => {
    const { createLoopbackMcpConnection } = await import("../src/index.js");
    const { createStatusMcpServer } = await import("@muse/domain-tools");
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "muse-status-mcp-"));
    const userMemoryFile = join(dir, "user-memory.json");
    const tasksFile = join(dir, "tasks.json");
    const historyFile = join(dir, "proactive-history.json");
    const logFile = join(dir, "notifications.log");
    const trustFile = join(dir, "trust.json");
    writeFileSync(userMemoryFile, JSON.stringify({ users: { stark: { facts: { name: "Tony" } } } }), "utf8");
    writeFileSync(tasksFile, JSON.stringify({ tasks: [] }), "utf8");

    const prev = process.env.MUSE_MODEL;
    process.env.MUSE_MODEL = "env-model-should-not-win";
    try {
      const connection = createLoopbackMcpConnection(createStatusMcpServer({
        historyFile,
        logFile,
        model: "gemini-2.5-pro",
        tasksFile,
        trustFile,
        userMemoryFile
      }));
      const snap = await connection.callTool!("snapshot", { user_id: "stark" });
      expect((snap as { model?: unknown }).model).toBe("gemini-2.5-pro");
    } finally {
      if (prev === undefined) delete process.env.MUSE_MODEL;
      else process.env.MUSE_MODEL = prev;
    }
  });

  it("notes_index returns each file's byte size — the description promises 'relative path + size'", async () => {
    const { createLoopbackMcpConnection } = await import("../src/index.js");
    const { createStatusMcpServer } = await import("@muse/domain-tools");
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const notesDir = mkdtempSync(join(tmpdir(), "muse-notes-index-"));
    writeFileSync(join(notesDir, "a.md"), "hello", "utf8"); // 5 bytes
    writeFileSync(join(notesDir, "b.md"), "héllo", "utf8"); // 6 bytes (é encodes to 2)
    const prev = process.env.MUSE_NOTES_DIR;
    process.env.MUSE_NOTES_DIR = notesDir;
    try {
      const connection = createLoopbackMcpConnection(createStatusMcpServer({}));
      const out = (await connection.callTool!("notes_index", {})) as { files: { name: string; size: number }[]; total: number };
      expect(out.total).toBe(2);
      const bySize = Object.fromEntries(out.files.map((f) => [f.name, f.size]));
      expect(bySize["a.md"]).toBe(5);
      expect(bySize["b.md"]).toBe(6); // the size field is the contract the description promises
    } finally {
      if (prev === undefined) delete process.env.MUSE_NOTES_DIR;
      else process.env.MUSE_NOTES_DIR = prev;
    }
  });

  it("snapshot surfaces reminders / followups / episodes / patterns summaries from their respective stores", async () => {
    const { createLoopbackMcpConnection } = await import("../src/index.js");
    const { createStatusMcpServer } = await import("@muse/domain-tools");
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "muse-status-mcp-dashboard-"));
    const userMemoryFile = join(dir, "user-memory.json");
    const tasksFile = join(dir, "tasks.json");
    const remindersFile = join(dir, "reminders.json");
    const followupsFile = join(dir, "followups.json");
    const objectivesFile = join(dir, "objectives.json");
    const episodesFile = join(dir, "episodes.json");
    const patternsFiredFile = join(dir, "patterns-fired.json");

    const past = new Date(Date.now() - 60 * 60_000).toISOString();
    const soon = new Date(Date.now() + 30 * 60_000).toISOString();

    writeFileSync(userMemoryFile, JSON.stringify({ users: { stark: { facts: { name: "Tony" } } } }), "utf8");
    writeFileSync(tasksFile, JSON.stringify({ tasks: [] }), "utf8");
    writeFileSync(remindersFile, JSON.stringify({
      reminders: [
        { id: "rem_overdue", text: "Call vet", dueAt: past, status: "pending", createdAt: "2026-05-10T00:00:00Z" },
        { id: "rem_soon", text: "Pick up dry cleaning", dueAt: soon, status: "pending", createdAt: "2026-05-12T00:00:00Z" },
        { id: "rem_done", text: "Already fired", dueAt: past, status: "fired", firedAt: past, createdAt: "2026-05-09T00:00:00Z" }
      ]
    }), "utf8");
    writeFileSync(followupsFile, JSON.stringify({
      followups: [
        { id: "fu_a", userId: "stark", scheduledFor: "2030-01-01T09:00:00Z", status: "scheduled", summary: "Send Q3 memo", createdAt: "2026-05-12T00:00:00Z" },
        { id: "fu_done", userId: "stark", scheduledFor: past, status: "fired", summary: "Fired one", firedAt: past, createdAt: past },
        { id: "fu_other", userId: "rhodey", scheduledFor: "2030-02-01T00:00:00Z", status: "scheduled", summary: "Other user", createdAt: past }
      ]
    }), "utf8");
    writeFileSync(episodesFile, JSON.stringify({
      episodes: [
        { id: "ep_a", userId: "stark", startedAt: "2026-05-12T21:30:00Z", endedAt: "2026-05-12T22:00:00Z", summary: "Reviewed Q3 budget memo" },
        { id: "ep_b", userId: "rhodey", startedAt: "2026-05-11T10:00:00Z", endedAt: "2026-05-11T10:30:00Z", summary: "Other user — filtered" }
      ]
    }), "utf8");
    writeFileSync(patternsFiredFile, JSON.stringify({
      fired: [{ patternId: "pat_walk", firedAtMs: 1_800_000_000_000, suggestion: "morning walk" }]
    }), "utf8");
    writeFileSync(objectivesFile, JSON.stringify({
      objectives: [
        { id: "obj_a", userId: "stark", createdAt: past, spec: "watch the build until green", kind: "until", status: "active" },
        { id: "obj_b", userId: "stark", createdAt: past, spec: "ship Q3 memo — blocked on sign-off", kind: "until", status: "escalated" },
        { id: "obj_done", userId: "stark", createdAt: past, spec: "old done", kind: "notify", status: "done" },
        { id: "obj_other", userId: "rhodey", createdAt: past, spec: "other user", kind: "until", status: "active" }
      ]
    }), "utf8");

    const sessionLockFile = join(dir, "session-lock.json");
    const dndUntil = new Date(Date.now() + 2 * 60 * 60_000).toISOString();
    writeFileSync(sessionLockFile, JSON.stringify({ until: dndUntil, reason: "deep work" }), "utf8");

    const connection = createLoopbackMcpConnection(createStatusMcpServer({
      episodesFile,
      followupsFile,
      objectivesFile,
      patternsFiredFile,
      remindersFile,
      sessionLockFile,
      tasksFile,
      userMemoryFile
    }));
    const snap = await connection.callTool!("snapshot", { user_id: "stark" }) as {
      reminders: { pending: number; fired: number; overdue: number; total: number; next_due_at?: string; next_text?: string };
      followups: { scheduled: number; fired: number; cancelled: number; total: number; next_scheduled_for?: string };
      objectives: { active: number; escalated: number; done: number; cancelled: number; total: number; escalated_sample?: string | null };
      session: { dnd: boolean; until: string | null };
      episodes: { total: number; last_summary?: string };
      patterns: { total: number; last_fired_at?: string };
    };

    expect(snap.reminders).toMatchObject({ pending: 2, fired: 1, overdue: 1, total: 3 });
    expect(snap.reminders.next_due_at).toBe(past);
    expect(snap.reminders.next_text).toBe("Call vet");

    // rhodey's scheduled followup is filtered out by userId.
    expect(snap.followups).toMatchObject({ scheduled: 1, fired: 1, cancelled: 0, total: 2 });
    expect(snap.followups.next_scheduled_for).toBe("2030-01-01T09:00:00Z");

    // rhodey's active objective filtered out by userId; escalated spec surfaced.
    expect(snap.objectives).toMatchObject({ active: 1, escalated: 1, done: 1, cancelled: 0, total: 3 });
    expect(snap.objectives.escalated_sample).toBe("ship Q3 memo — blocked on sign-off");

    // Active DND lock surfaced so the agent knows notices are paused.
    expect(snap.session.dnd).toBe(true);
    expect(snap.session.until).toBe(dndUntil);

    // rhodey's episode filtered out.
    expect(snap.episodes.total).toBe(1);
    expect(snap.episodes.last_summary).toBe("Reviewed Q3 budget memo");

    expect(snap.patterns.total).toBe(1);
    expect(snap.patterns.last_fired_at).toBe(new Date(1_800_000_000_000).toISOString());
  });

  it("snapshot falls back to process.env.MUSE_MODEL when no options.model is set", async () => {
    const { createLoopbackMcpConnection } = await import("../src/index.js");
    const { createStatusMcpServer } = await import("@muse/domain-tools");
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "muse-status-mcp-env-"));
    const userMemoryFile = join(dir, "user-memory.json");
    const tasksFile = join(dir, "tasks.json");
    writeFileSync(userMemoryFile, JSON.stringify({ users: {} }), "utf8");
    writeFileSync(tasksFile, JSON.stringify({ tasks: [] }), "utf8");

    const prev = process.env.MUSE_MODEL;
    process.env.MUSE_MODEL = "env-fallback-model";
    try {
      const connection = createLoopbackMcpConnection(createStatusMcpServer({
        historyFile: join(dir, "no-such-history.json"),
        logFile: join(dir, "no-such-log.log"),
        tasksFile,
        trustFile: join(dir, "no-such-trust.json"),
        userMemoryFile
      }));
      const snap = await connection.callTool!("snapshot", { user_id: "default" });
      expect((snap as { model?: unknown }).model).toBe("env-fallback-model");
    } finally {
      if (prev === undefined) delete process.env.MUSE_MODEL;
      else process.env.MUSE_MODEL = prev;
    }
  });
});

describe("followup write durability + temp-file recovery (goal 038)", () => {
  it("writeFollowups round-trips data through fsync + atomic rename (no tmp orphan on clean write)", async () => {
    const { mkdtempSync, readFileSync, readdirSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { writeFollowups } = await import("../src/index.js");
    const dir = mkdtempSync(join(tmpdir(), "muse-fu-durability-"));
    const file = join(dir, "followups.json");
    await writeFollowups(file, [
      { id: "fu_a", userId: "stark", scheduledFor: "2026-05-15T09:00:00Z", status: "scheduled", summary: "x", createdAt: "2026-05-12T00:00:00Z" }
    ]);
    const onDisk = JSON.parse(readFileSync(file, "utf8")) as { followups: Array<{ id: string }> };
    expect(onDisk.followups[0]!.id).toBe("fu_a");
    // No `.tmp-` files left after a clean write.
    const siblings = readdirSync(dir).filter((n) => n.includes(".tmp-"));
    expect(siblings).toEqual([]);
  });

  it("cleanupFollowupTempFiles removes orphan .tmp-* siblings (crash-recovery)", async () => {
    const { mkdtempSync, writeFileSync, readdirSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { cleanupFollowupTempFiles } = await import("../src/index.js");
    const dir = mkdtempSync(join(tmpdir(), "muse-fu-orphan-"));
    const file = join(dir, "followups.json");
    writeFileSync(file, JSON.stringify({ followups: [] }), "utf8");
    // Simulate a crash mid-write: two leftover .tmp- files.
    writeFileSync(`${file}.tmp-12345-1000`, "{partial", "utf8");
    writeFileSync(`${file}.tmp-12345-2000`, "{partial", "utf8");

    const cleaned = await cleanupFollowupTempFiles(file);
    expect(cleaned.length).toBe(2);
    const after = readdirSync(dir);
    expect(after.some((n) => n.includes(".tmp-"))).toBe(false);
    expect(after).toContain("followups.json");
  });
});

describe("sensitive store file-mode lock-ins (goal 035)", () => {
  it("writeFollowups persists ~/.muse/followups.json with mode 0600", async () => {
    if (process.platform === "win32") return;
    const { mkdtempSync, statSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { writeFollowups } = await import("../src/index.js");
    const dir = mkdtempSync(join(tmpdir(), "muse-store-mode-fu-"));
    const file = join(dir, "followups.json");
    await writeFollowups(file, [
      { id: "fu_a", userId: "stark", scheduledFor: "2026-05-15T09:00:00Z", status: "scheduled", summary: "Send Q3 memo", createdAt: "2026-05-12T00:00:00Z" }
    ]);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it("writeEpisodes / writeReminders / writeTasks all yield mode 0600", async () => {
    if (process.platform === "win32") return;
    const { mkdtempSync, statSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { writeEpisodes, writeReminders, writeTasks } = await import("../src/index.js");
    const dir = mkdtempSync(join(tmpdir(), "muse-store-mode-sweep-"));

    const epFile = join(dir, "episodes.json");
    await writeEpisodes(epFile, [
      { id: "ep_a", userId: "stark", startedAt: "2026-05-12T22:00:00Z", endedAt: "2026-05-12T22:30:00Z", summary: "x" }
    ]);
    expect(statSync(epFile).mode & 0o777).toBe(0o600);

    const remFile = join(dir, "reminders.json");
    await writeReminders(remFile, [
      { id: "rem_a", text: "x", dueAt: "2026-05-15T09:00:00Z", status: "pending", createdAt: "2026-05-12T00:00:00Z" }
    ]);
    expect(statSync(remFile).mode & 0o777).toBe(0o600);

    const taskFile = join(dir, "tasks.json");
    await writeTasks(taskFile, [
      { id: "task_a", title: "x", status: "open", createdAt: "2026-05-12T00:00:00Z" }
    ]);
    expect(statSync(taskFile).mode & 0o777).toBe(0o600);
  });

  it("writeProactiveFired yields mode 0600 — sibling-parity with the other personal stores; ~/.muse/proactive-history.json shows which calendar events / tasks fired when, so a shared-box install must not expose the timeline to other local users (default umask leaves it 0o644)", async () => {
    if (process.platform === "win32") return;
    const { mkdtempSync, statSync, chmodSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { writeProactiveFired } = await import("../src/index.js");
    const dir = mkdtempSync(join(tmpdir(), "muse-proactive-mode-"));
    const file = join(dir, "proactive-fired.json");

    // First write — proves the writeFile `mode: 0o600` option
    // applies on file creation.
    await writeProactiveFired(file, [
      { kind: "calendar", id: "evt_a", startIso: "2026-05-12T08:00:00.000Z", firedAt: "2026-05-12T08:00:00.000Z" }
    ]);
    expect(statSync(file).mode & 0o777).toBe(0o600);

    // Tamper to a looser mode (simulating either a pre-existing
    // file on disk or an external chmod between writes), then
    // re-write — proves the post-rename `chmod(file, 0o600)`
    // step actively locks the mode down rather than relying on
    // the writeFile mode option (which only applies on file
    // creation, not when rename overwrites an existing target).
    chmodSync(file, 0o644);
    await writeProactiveFired(file, [
      { kind: "calendar", id: "evt_a", startIso: "2026-05-12T08:00:00.000Z", firedAt: "2026-05-12T08:00:00.000Z" },
      { kind: "task", id: "task_b", startIso: "2026-05-12T09:00:00.000Z", firedAt: "2026-05-12T09:00:00.000Z" }
    ]);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });
});

describe("muse.history loopback server", () => {
  async function seedFiles() {
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "muse-history-mcp-"));
    const reminderHistoryFile = join(dir, "reminder-history.json");
    const proactiveHistoryFile = join(dir, "proactive-history.json");
    const followupsFile = join(dir, "followups.json");
    const patternsFiredFile = join(dir, "patterns-fired.json");
    const episodesFile = join(dir, "episodes.json");

    const t1 = "2026-05-12T08:00:00.000Z";
    const t2 = "2026-05-12T09:30:00.000Z";
    const t3 = "2026-05-12T10:15:00.000Z";
    const t4 = "2026-05-12T22:00:00.000Z";
    const t5 = "2026-05-13T07:45:00.000Z";

    writeFileSync(reminderHistoryFile, JSON.stringify({
      entries: [
        { reminderId: "rem_a", text: "Pick up dry cleaning", providerId: "telegram", destination: "@me", firedAtIso: t2, status: "delivered" }
      ],
      version: 1
    }), "utf8");
    writeFileSync(proactiveHistoryFile, JSON.stringify({
      entries: [
        { kind: "calendar", itemId: "evt_a", startIso: t5, title: "Standup", providerId: "telegram", destination: "@me", text: "Standup in 5 min", firedAtIso: t5, status: "delivered" }
      ],
      version: 1
    }), "utf8");
    writeFileSync(followupsFile, JSON.stringify({
      followups: [
        { id: "fu_a", userId: "stark", scheduledFor: t3, status: "fired", summary: "Send Q3 memo", firedAt: t3, createdAt: t1 },
        { id: "fu_pending", userId: "stark", scheduledFor: "2030-01-01T00:00:00Z", status: "scheduled", summary: "Later", createdAt: t1 }
      ]
    }), "utf8");
    writeFileSync(patternsFiredFile, JSON.stringify({
      fired: [
        { patternId: "pat_morning_walk", firedAtMs: Date.parse(t1), suggestion: "morning walk routine" }
      ]
    }), "utf8");
    writeFileSync(episodesFile, JSON.stringify({
      episodes: [
        { id: "ep_a", userId: "stark", startedAt: "2026-05-12T21:30:00Z", endedAt: t4, summary: "Reviewed Q3 budget memo" }
      ]
    }), "utf8");

    return { reminderHistoryFile, proactiveHistoryFile, followupsFile, patternsFiredFile, episodesFile };
  }

  it("recent merges every store newest-first and skips non-fired followups", async () => {
    const { createLoopbackMcpConnection } = await import("../src/index.js");
    const { createHistoryMcpServer } = await import("@muse/domain-tools");
    const files = await seedFiles();
    const conn = createLoopbackMcpConnection(createHistoryMcpServer(files));

    const r = await conn.callTool!("recent", {});
    expect(r.total).toBe(5);
    const ids = (r.entries as Array<{ kind: string; id?: string }>).map((e) => `${e.kind}:${e.id ?? ""}`);
    expect(ids).toEqual([
      "proactive:evt_a",
      "episode:ep_a",
      "followup:fu_a",
      "reminder:rem_a",
      "pattern:pat_morning_walk"
    ]);
  });

  it("recent honours kind / sinceIso / limit filters and rejects invalid kind", async () => {
    const { createLoopbackMcpConnection } = await import("../src/index.js");
    const { createHistoryMcpServer } = await import("@muse/domain-tools");
    const files = await seedFiles();
    const conn = createLoopbackMcpConnection(createHistoryMcpServer(files));

    const byKind = await conn.callTool!("recent", { kind: "followup" });
    expect((byKind.entries as Array<{ id?: string }>).map((e) => e.id)).toEqual(["fu_a"]);

    const sinceLate = await conn.callTool!("recent", { sinceIso: "2026-05-12T22:00:00Z" });
    // Only proactive (t5) + episode (t4) survive.
    expect(sinceLate.total).toBe(2);

    const limited = await conn.callTool!("recent", { limit: 2 });
    expect(limited.total).toBe(2);

    const bogus = await conn.callTool!("recent", { kind: "bogus" });
    expect(bogus).toMatchObject({ error: expect.stringContaining("kind must be one of") });

    const badSince = await conn.callTool!("recent", { sinceIso: "not-an-iso" });
    expect(badSince).toMatchObject({ error: expect.stringContaining("parseable ISO timestamp") });
  });

  it("a fractional limit < 1 falls back to the default feed, NOT an empty one", async () => {
    const { createLoopbackMcpConnection } = await import("../src/index.js");
    const { createHistoryMcpServer } = await import("@muse/domain-tools");
    const conn = createLoopbackMcpConnection(createHistoryMcpServer(await seedFiles()));
    const full = await conn.callTool!("recent", {});
    const fractional = await conn.callTool!("recent", { limit: 0.5 });
    expect(full.total as number).toBeGreaterThan(0);
    expect(fractional.total).toBe(full.total); // 0.5 → fallback (20), same feed; the bug returned 0
  });
});

describe("proactive-history rotation on capacity (goal 079)", () => {
  function makeEntry(itemId: string): import("../src/index.js").ProactiveHistoryEntry {
    return {
      destination: "@me",
      firedAtIso: "2026-05-14T00:00:00Z",
      itemId,
      kind: "task",
      providerId: "log",
      startIso: "2026-05-14T01:00:00Z",
      status: "delivered",
      text: `hello ${itemId}`,
      title: itemId
    };
  }

  it("rotates the live file to .1 + shifts older archives + drops past the retention budget", async () => {
    const { appendProactiveHistory, readProactiveHistory, rotateProactiveHistoryFiles } = await import("../src/index.js");
    const { mkdtempSync, readFileSync, existsSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");

    const dir = mkdtempSync(join(tmpdir(), "muse-proactive-rotate-"));
    const file = join(dir, "proactive-history.json");

    // capacity=2 so two appends fill the file; the third triggers
    // rotation with archiveMaxFiles=2 → file → .1, fresh start.
    await appendProactiveHistory(file, makeEntry("a"), { capacity: 2, archiveMaxFiles: 2 });
    await appendProactiveHistory(file, makeEntry("b"), { capacity: 2, archiveMaxFiles: 2 });
    expect((await readProactiveHistory(file)).map((e) => e.itemId).sort()).toEqual(["a", "b"]);
    expect(existsSync(`${file}.1`)).toBe(false);

    // Third append rotates; live file now carries only "c", and
    // the previous two move to .1.
    await appendProactiveHistory(file, makeEntry("c"), { capacity: 2, archiveMaxFiles: 2 });
    expect((await readProactiveHistory(file)).map((e) => e.itemId)).toEqual(["c"]);
    const archive1 = JSON.parse(readFileSync(`${file}.1`, "utf8")) as { entries: Array<{ itemId: string }> };
    expect(archive1.entries.map((e) => e.itemId).sort()).toEqual(["a", "b"]);

    // Fill again + rotate again → .1 (previously [a,b]) shifts to
    // .2, the live file's pre-rotate state ([c,d]) becomes .1, and
    // the fresh live carries only "e".
    await appendProactiveHistory(file, makeEntry("d"), { capacity: 2, archiveMaxFiles: 2 });
    // After "d": file = [c, d], .1 still [a, b].
    await appendProactiveHistory(file, makeEntry("e"), { capacity: 2, archiveMaxFiles: 2 });
    // After "e": rotation fires (file was at-capacity), so
    // .1 ([a,b]) shifts to .2; file's prior [c,d] becomes .1;
    // fresh file = [e].
    expect((await readProactiveHistory(file)).map((e) => e.itemId)).toEqual(["e"]);
    const archiveAfter1 = JSON.parse(readFileSync(`${file}.1`, "utf8")) as { entries: Array<{ itemId: string }> };
    expect(archiveAfter1.entries.map((e) => e.itemId)).toEqual(["c", "d"]);
    const archiveAfter2 = JSON.parse(readFileSync(`${file}.2`, "utf8")) as { entries: Array<{ itemId: string }> };
    expect(archiveAfter2.entries.map((e) => e.itemId)).toEqual(["a", "b"]);

    // rotateProactiveHistoryFiles can be called directly + cleans
    // beyond-budget archives.
    void rotateProactiveHistoryFiles;
  });

  it("scrubs credential shapes from title / text / error before persistence (goal 139)", async () => {
    const { appendProactiveHistory, readProactiveHistory } = await import("../src/index.js");
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");

    const dir = mkdtempSync(join(tmpdir(), "muse-proactive-redact-"));
    const file = join(dir, "proactive-history.json");

    // Delivered path: title + text carry credentials.
    await appendProactiveHistory(file, {
      destination: "@me",
      firedAtIso: "2026-05-14T00:00:00Z",
      itemId: "t1",
      kind: "task",
      providerId: "log",
      startIso: "2026-05-14T01:00:00Z",
      status: "delivered",
      text: "📋 rotate sk-proj-abcdefghijklmnopqrstuvwxyz due in 10 min",
      title: "rotate ghp_abcdefghijklmnopqrstuvwxyzABCDEF"
    });

    // Failed path: error field also carries credential.
    await appendProactiveHistory(file, {
      destination: "@me",
      error: "send failed with sk-ant-api03-abcdefghijklmnop",
      firedAtIso: "2026-05-14T00:01:00Z",
      itemId: "t2",
      kind: "task",
      providerId: "log",
      startIso: "2026-05-14T01:00:00Z",
      status: "failed",
      text: "x",
      title: "noisy task"
    });

    const entries = await readProactiveHistory(file);
    expect(entries).toHaveLength(2);

    const delivered = entries.find((e) => e.itemId === "t1");
    expect(delivered).toBeDefined();
    expect(delivered!.title).toContain("[redacted-github-pat]");
    expect(delivered!.title).not.toContain("ghp_abcdefghijklmnopqrstuvwxyzABCDEF");
    expect(delivered!.text).toContain("[redacted-openai-key]");
    expect(delivered!.text).not.toContain("sk-proj-abcdefghijklmnopqrstuvwxyz");
    // Surrounding prose survives.
    expect(delivered!.text).toContain("rotate ");
    expect(delivered!.text).toContain("due in 10 min");

    const failed = entries.find((e) => e.itemId === "t2");
    expect(failed).toBeDefined();
    expect(failed!.error).toContain("[redacted-anthropic-key]");
    expect(failed!.error).not.toContain("sk-ant-api03-abcdefghijklmnop");
  });

  it("preserves the pre-079 trim-without-rotation path when archiveMaxFiles is 0 / unset", async () => {
    const { appendProactiveHistory, readProactiveHistory } = await import("../src/index.js");
    const { mkdtempSync, existsSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");

    const dir = mkdtempSync(join(tmpdir(), "muse-proactive-rotate-off-"));
    const file = join(dir, "proactive-history.json");

    for (const id of ["a", "b", "c"]) {
      await appendProactiveHistory(file, makeEntry(id), { capacity: 2 });
    }
    // Capacity=2, no archive → newest two survive, "a" dropped.
    expect((await readProactiveHistory(file)).map((e) => e.itemId).sort()).toEqual(["b", "c"]);
    // No archive files were created.
    expect(existsSync(`${file}.1`)).toBe(false);
  });
});

describe("Apple osascript timeout watchdog (notes + reminders)", () => {
  async function fakeOsascript(body: string): Promise<string> {
    const { mkdtempSync, writeFileSync, chmodSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "muse-apple-osascript-"));
    const script = join(dir, "fake-osascript");
    writeFileSync(script, `#!${process.execPath}\n${body}\n`);
    chmodSync(script, 0o755);
    return script;
  }

  it("AppleNotesProvider SIGKILLs a wedged osascript and rejects OSASCRIPT_TIMEOUT", async () => {
    const hung = await fakeOsascript("setInterval(() => {}, 1000);");
    const apple = new AppleNotesProvider({ osascriptPath: hung, timeoutMs: 150 });
    const start = Date.now();
    await expect(apple.list()).rejects.toMatchObject({ code: "OSASCRIPT_TIMEOUT", providerId: "apple" });
    expect(Date.now() - start).toBeLessThan(5_000);
  });

  it("AppleRemindersProvider SIGKILLs a wedged osascript and rejects OSASCRIPT_TIMEOUT", async () => {
    const hung = await fakeOsascript("setInterval(() => {}, 1000);");
    const apple = new AppleRemindersProvider({ osascriptPath: hung, timeoutMs: 150 });
    const start = Date.now();
    await expect(apple.list()).rejects.toMatchObject({ code: "OSASCRIPT_TIMEOUT", providerId: "apple-reminders" });
    expect(Date.now() - start).toBeLessThan(5_000);
  });

  it("a fast-exiting osascript still resolves (watchdog cleared, no double-settle)", async () => {
    const ok = await fakeOsascript("process.exit(0);");
    await expect(new AppleNotesProvider({ osascriptPath: ok, timeoutMs: 10_000 }).list()).resolves.toEqual([]);
    await expect(new AppleRemindersProvider({ osascriptPath: ok, timeoutMs: 10_000 }).list()).resolves.toEqual([]);
  });
});
