import type { MuseDatabase } from "@muse/db";
import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler
} from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  compareTasksByDueDate,
  createDefaultLoopbackMcpServers,
  createLoopbackMcpConnection,
  createLoopbackMcpMuseTools,
  createCryptoMcpServer,
  createSearchMcpServer,
  createDiffMcpServer,
  createFetchMcpServer,
  createFilesystemMcpServer,
  createFollowupsMcpServer,
  createJsonMcpServer,
  createMathMcpServer,
  createMessagingMcpServer,
  createNotesMcpServer,
  createRemindersMcpServer,
  createNotesRegistryMcpServer,
  createTasksMcpServer,
  createRegexMcpServer,
  AppleNotesProvider,
  AppleRemindersProvider,
  LocalDirNotesProvider,
  LocalFileTasksProvider,
  NotesProviderError,
  NotesProviderRegistry,
  NotesValidationError,
  NotionNotesProvider,
  NotionTasksProvider,
  TasksProviderError,
  TasksProviderRegistry,
  TasksValidationError,
  createContextReferenceMcpServer,
  createTasksRegistryMcpServer,
  createUrlMcpServer,
  createMcpSecurityPolicyInsert,
  createMcpServerInsert,
  createMcpServerUpdate,
  createTextUtilsMcpServer,
  createTimeMcpServer,
  DefaultMcpTransportConnector,
  InMemoryMcpSecurityPolicyStore,
  InMemoryMcpServerStore,
  isPrivateOrReservedHost,
  isPublicHttpUrl,
  KyselyMcpSecurityPolicyStore,
  KyselyMcpServerStore,
  mapMcpSecurityPolicyRow,
  mapMcpServerRow,
  McpManager,
  McpSecurityPolicyProvider,
  normalizeMcpSecurityPolicy,
  validateMcpServer,
  validateStdioArgs,
  validateStdioCommand,
  type McpConnection
} from "../src/index.js";

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
          command: "node"
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
          command: "node"
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
          command: "node"
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

  it("registers as 5 Muse tools (list/read/search/save/append) with correct risk levels", () => {
    const tools = createLoopbackMcpMuseTools(createNotesMcpServer({ notesDir: tmpRoot }));
    expect(tools.map((t) => t.definition.name).sort()).toEqual([
      "muse.notes.append",
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

  it("breaks dueAt ties by newest-created first", () => {
    const tasks = [
      mk("same-due-old", "2026-05-14T00:00:00Z", "2026-05-12T00:00:00Z"),
      mk("same-due-new", "2026-05-14T00:00:00Z", "2026-05-13T00:00:00Z")
    ];
    const sorted = [...tasks].sort(compareTasksByDueDate).map((t) => t.id);
    expect(sorted).toEqual(["same-due-new", "same-due-old"]);
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
    it("parses 'in N <unit>' offsets", async () => {
      const { resolveRelativeTimePhrase } = await import("../src/loopback-relative-time.js");
      const fixed = new Date("2026-05-10T12:00:00Z");
      const now = () => fixed;
      expect(resolveRelativeTimePhrase("in 30 minutes", now)?.toISOString())
        .toBe("2026-05-10T12:30:00.000Z");
      expect(resolveRelativeTimePhrase("in 3 hours", now)?.toISOString())
        .toBe("2026-05-10T15:00:00.000Z");
      expect(resolveRelativeTimePhrase("in 2 days", now)?.toISOString())
        .toBe("2026-05-12T12:00:00.000Z");
      expect(resolveRelativeTimePhrase("in 1 week", now)?.toISOString())
        .toBe("2026-05-17T12:00:00.000Z");
    });

    it("supports time-of-day suffixes (am/pm/HH:MM/noon/midnight)", async () => {
      const { resolveRelativeTimePhrase } = await import("../src/loopback-relative-time.js");
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

    it("returns undefined for unsupported phrases (caller decides fallback)", async () => {
      const { resolveRelativeTimePhrase } = await import("../src/loopback-relative-time.js");
      const now = () => new Date("2026-05-10T12:00:00Z");
      expect(resolveRelativeTimePhrase("sometime", now)).toBeUndefined();
      expect(resolveRelativeTimePhrase("yesterday", now)).toBeUndefined();
      expect(resolveRelativeTimePhrase("", now)).toBeUndefined();
      expect(resolveRelativeTimePhrase("tomorrow at 25:00", now)).toBeUndefined();
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

    const sent = await connection.callTool!("send", {
      destination: "@me",
      providerId: "telegram",
      text: "hi"
    });
    expect(sent).toMatchObject({ destination: "@me", messageId: "42", providerId: "telegram" });
    expect(seenUrl).toBe("https://tg.test/botFAKE-TOKEN/sendMessage");
    expect(JSON.parse(seenBody)).toMatchObject({ chat_id: "@me", text: "hi" });
  });

  it("returns a structured error when the provider isn't registered", async () => {
    const { MessagingProviderRegistry } = await import("@muse/messaging");
    const server = createMessagingMcpServer({ registry: new MessagingProviderRegistry() });
    const connection = createLoopbackMcpConnection(server);

    const result = await connection.callTool!("send", {
      destination: "x",
      providerId: "telegram",
      text: "hi"
    });
    expect(result).toMatchObject({
      error: expect.stringContaining("not registered"),
      providerErrorCode: "PROVIDER_NOT_FOUND"
    });
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
    await expect(connection.callTool!("send", { destination: "x", providerId: "", text: "hi" }))
      .resolves.toMatchObject({ error: expect.stringContaining("providerId is required") });
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

    const due = await connection.callTool!("due", { status: "due" });
    expect(due).toMatchObject({ status: "due", total: 1 });
    expect((due.reminders as Array<{ id: string }>)[0]?.id).toBe("rem_1");

    const all = await connection.callTool!("due", { status: "all" });
    expect(all).toMatchObject({ status: "all", total: 2 });

    const removed = await connection.callTool!("clear", { id: "rem_1" });
    expect(removed).toMatchObject({ id: "rem_1", removed: true });

    const after = await connection.callTool!("due", { status: "all" });
    expect(after).toMatchObject({ total: 1 });
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

  it("add accepts an optional via override and serializes it back on response", async () => {
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

    const ok = await connection.callTool!("add", {
      dueAt: "2026-05-11T09:00:00Z",
      text: "Deploy alert",
      via: { destination: "C123", providerId: "slack" }
    });
    expect(ok).toMatchObject({
      reminder: {
        id: "rem_via_1",
        text: "Deploy alert",
        via: { destination: "C123", providerId: "slack" }
      }
    });

    // Validation: missing destination → clean error before the file is touched.
    const bad = await connection.callTool!("add", {
      dueAt: "2026-05-11T09:00:00Z",
      text: "x",
      via: { providerId: "slack" }
    });
    expect(bad).toMatchObject({ error: expect.stringContaining("via.providerId and via.destination") });
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
    const due = await connection.callTool!("due", { status: "due" });
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

    let calls = 0;
    const fakeRegistry = {
      send: async () => {
        calls += 1;
        if (calls === 1) {
          throw new Error("upstream 503");
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
    expect(summary.errors[0]).toContain("upstream 503");
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
    let calls = 0;
    const fakeRegistry = {
      send: async (_pid: string, message: { destination: string; text: string }) => {
        calls += 1;
        if (message.text === "FAIL") {
          throw new Error("upstream 503");
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
      error: "upstream 503",
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

    let sendCalls = 0;
    const fakeRegistry = {
      send: async () => {
        sendCalls += 1;
        if (sendCalls === 1) {
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
    expect(summary.errors[0]).toContain("upstream 503");

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
    expect(missing).toMatchObject({ error: expect.stringContaining("not found") });

    const noId = await connection.callTool!("cancel", {});
    expect(noId).toMatchObject({ error: expect.stringContaining("id is required") });
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

describe("personal-episodes-store", () => {
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
