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
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildMcpServeTools, type McpServeDependencies } from "./mcp-serve-tools.js";

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
});
