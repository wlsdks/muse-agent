import type { MuseDatabase } from "@muse/db";
import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler
} from "kysely";
import { describe, expect, it, vi } from "vitest";

import {
  createDefaultLoopbackMcpServers,
  createLoopbackMcpConnection,
  createLoopbackMcpMuseTools,
  createCryptoMcpServer,
  createDiffMcpServer,
  createFetchMcpServer,
  createJsonMcpServer,
  createMathMcpServer,
  createRegexMcpServer,
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
  it("createDefaultLoopbackMcpServers ships eight reference servers (time/text/math/json/url/crypto/diff/regex) by default", () => {
    const servers = createDefaultLoopbackMcpServers({ now: () => new Date("2026-05-15T00:00:00.000Z") });
    expect(servers.map((server) => server.name).sort()).toEqual([
      "muse.crypto",
      "muse.diff",
      "muse.json",
      "muse.math",
      "muse.regex",
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
