/**
 * End-to-end (in-process) proof that `muse mcp serve`'s assembled server —
 * the SAME `createMuseToolsMcpServer` + `buildMcpServeTools` wiring
 * `runMcpServeCommand` uses in production — completes a real MCP handshake
 * and answers `tools/list` / `tools/call` for `knowledge_search` and
 * `user_model_read` against a seeded temp notes dir + a seeded user-memory
 * fact. Drives the server through the SAME `Client` class
 * `packages/mcp/src/transport.ts` uses on Muse's own client side, so this is
 * a real interop proof, not a mock of the protocol. Deterministic — no
 * Ollama required (only `muse_recall` needs a live model; that's covered by
 * `apps/cli/scripts/verify-mcp-serve-grounding.mjs`).
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMuseToolsMcpServer } from "@muse/mcp";
import { InMemoryUserMemoryStore } from "@muse/memory";
import { LocalDirNotesProvider } from "@muse/domain-tools";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildMcpServeTools, resolveMcpServeDependencies, type McpServeDependencies } from "./mcp-serve-tools.js";
import { runMcpServeCommand } from "./commands-mcp-serve.js";

describe("muse mcp serve (in-process e2e)", () => {
  let notesDir: string;
  let deps: McpServeDependencies;

  beforeEach(() => {
    notesDir = mkdtempSync(join(tmpdir(), "muse-mcp-serve-e2e-"));
    writeFileSync(join(notesDir, "decisions.md"), "We decided to use nomic-embed-text-v2-moe as the embedder model.\n");
    const userMemoryStore = new InMemoryUserMemoryStore();
    userMemoryStore.upsertFact("test-user", "home_city", "Seoul");
    deps = {
      answerModel: undefined,
      answerTemperature: 0.6,
      baseUrlResolver: () => "http://127.0.0.1:11434",
      embedFn: async () => {
        throw new Error("no local Ollama in this test");
      },
      embedModel: "nomic-embed-text-v2-moe",
      listCalendarEvents: async () => [],
      listTasks: async () => [],
      modelProvider: undefined,
      newId: () => "test-fixed-id",
      notesDir,
      notesIndexFile: join(notesDir, "..", "notes-index.json"),
      notesProvider: new LocalDirNotesProvider({ notesDir }),
      now: () => new Date(),
      stagePendingApproval: async () => {
        throw new Error("stagePendingApproval not exercised by this e2e test");
      },
      userId: "test-user",
      userMemoryStore
    };
  });

  afterEach(() => {
    rmSync(notesDir, { recursive: true, force: true });
  });

  it("completes initialize -> tools/list -> tools/call for knowledge_search and user_model_read", async () => {
    const server = createMuseToolsMcpServer({ serverName: "muse", tools: buildMcpServeTools(deps) });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "1.0.0" });

    // client.connect() runs the full initialize / initialized handshake.
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual(["calendar_read", "knowledge_search", "muse_recall", "propose_action", "tasks_read", "user_model_read"]);

    const searchResult = await client.callTool({ arguments: { query: "embedder model" }, name: "knowledge_search" });
    expect(searchResult.isError).not.toBe(true);
    const searchText = String((searchResult.content as readonly { readonly text?: string }[])[0]?.text ?? "");
    expect(searchText).toContain("notes/decisions.md");
    expect(searchText).toContain("nomic-embed-text-v2-moe");

    const memoryResult = await client.callTool({ arguments: { kind: "facts" }, name: "user_model_read" });
    expect(memoryResult.isError).not.toBe(true);
    const memoryPayload = JSON.parse(String((memoryResult.content as readonly { readonly text?: string }[])[0]?.text ?? "{}"));
    expect(memoryPayload.facts).toEqual([{ asserted: true, confidence: 1, key: "home_city", value: "Seoul" }]);

    await client.close();
    await server.close();
  });

  it("keeps the loopback MCP serve transport in-process with no public-web fetch", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      throw new Error("muse mcp serve must not use fetch for its in-process loopback transport");
    });
    const server = createMuseToolsMcpServer({ serverName: "muse", tools: buildMcpServeTools(deps) });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "local-client", version: "1.0.0" });

    try {
      await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
      await expect(client.listTools()).resolves.toMatchObject({ tools: expect.any(Array) });
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
      await client.close();
      await server.close();
    }
  });

  it("passes the injected local-only environment through runMcpServeCommand into the real guarded dependency resolver", async () => {
    const modelFile = join(notesDir, "models.json");
    writeFileSync(modelFile, JSON.stringify({ providers: { ollama: { token: "http://198.51.100.8:11434" } } }), "utf8");
    const injectedEnv = {
      HOME: notesDir,
      MUSE_LOCAL_ONLY: "true",
      MUSE_MODEL: "diagnostic/smoke",
      MUSE_MODEL_KEYS_FILE: modelFile,
      MUSE_MODEL_PROVIDER_ID: "diagnostic",
      MUSE_NOTES_DIR: notesDir,
      MUSE_NOTES_INDEX_FILE: join(notesDir, "notes-index.json"),
      MUSE_USER_MEMORY_FILE: join(notesDir, "user-memory.json"),
      OLLAMA_BASE_URL: "http://198.51.100.8:11434"
    };
    const previousLocalOnly = process.env.MUSE_LOCAL_ONLY;
    const originalFetch = globalThis.fetch;
    const stderr: string[] = [];
    let receivedEnv: unknown;
    let resolvedDeps: McpServeDependencies | undefined;
    let capturedServer: unknown;
    let stdioCalls = 0;
    process.env.MUSE_LOCAL_ONLY = "false";
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      throw new Error("the command-entry local-only guard must reject before fetch");
    });

    try {
      await runMcpServeCommand({ stderr: (message) => stderr.push(message), stdout: () => {} }, {
        env: injectedEnv,
        resolveDependencies: (env = process.env) => {
          receivedEnv = env;
          resolvedDeps = resolveMcpServeDependencies(env);
          return resolvedDeps;
        },
        runStdioMcpServer: async (server, onListening) => {
          capturedServer = server;
          stdioCalls += 1;
          onListening?.();
        }
      });

      expect(receivedEnv).toBe(injectedEnv);
      expect(receivedEnv).not.toBe(process.env);
      expect(stdioCalls).toBe(1);
      expect(capturedServer).toBeDefined();
      expect(stderr.join("")).toContain("listening on stdio (6 tools)");
      expect(resolvedDeps?.modelProvider?.id).toBe("diagnostic");
      expect(() => resolvedDeps?.baseUrlResolver()).toThrow(/local.only|loopback|cloud provider/iu);
      await expect(resolvedDeps?.embedFn("private command-entry text", "nomic-embed-text-v2-moe"))
        .rejects.toThrow(/local.only|loopback|cloud provider/iu);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
      globalThis.fetch = originalFetch;
      if (previousLocalOnly === undefined) delete process.env.MUSE_LOCAL_ONLY;
      else process.env.MUSE_LOCAL_ONLY = previousLocalOnly;
    }
  });
});
