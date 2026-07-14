import { PassThrough } from "node:stream";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { describe, expect, it } from "vitest";
import { setTimeout as sleep } from "node:timers/promises";


import type { MuseTool } from "@muse/tools";

import { createMuseToolsMcpServer } from "./serve.js";

function echoTool(): MuseTool {
  return {
    definition: {
      description: "Echo the given text back. Use when testing; do not use otherwise.",
      inputSchema: {
        additionalProperties: false,
        properties: { text: { description: "Text to echo, e.g. 'hi'.", type: "string" } },
        required: ["text"],
        type: "object"
      },
      name: "test_echo",
      risk: "read"
    },
    execute: (args) => `echo: ${String((args as { text?: unknown }).text ?? "")}`
  };
}

function throwingTool(): MuseTool {
  return {
    definition: {
      description: "Always throws. Use when testing failure handling; do not use otherwise.",
      inputSchema: { additionalProperties: false, properties: {}, required: [], type: "object" },
      name: "test_throw",
      risk: "read"
    },
    execute: () => {
      throw new Error("boom");
    }
  };
}

describe("createMuseToolsMcpServer", () => {
  it("advertises the given tools' schemas over tools/list", async () => {
    const server = createMuseToolsMcpServer({ serverName: "muse-test", tools: [echoTool()] });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "1.0.0" });
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

    const { tools } = await client.listTools();
    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({
      description: "Echo the given text back. Use when testing; do not use otherwise.",
      inputSchema: { required: ["text"], type: "object" },
      name: "test_echo"
    });

    await client.close();
    await server.close();
  });

  it("routes tools/call to the matching tool and returns its output as text content", async () => {
    const server = createMuseToolsMcpServer({ serverName: "muse-test", tools: [echoTool()] });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "1.0.0" });
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

    const result = await client.callTool({ arguments: { text: "hello" }, name: "test_echo" });
    expect(result.isError).not.toBe(true);
    expect(result.content).toEqual([{ text: "echo: hello", type: "text" }]);

    await client.close();
    await server.close();
  });

  it("returns a structured error (not a crash) for an unknown tool name", async () => {
    const server = createMuseToolsMcpServer({ serverName: "muse-test", tools: [echoTool()] });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "1.0.0" });
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

    const result = await client.callTool({ arguments: {}, name: "does_not_exist" });
    expect(result.isError).toBe(true);
    expect(String((result.content as readonly { readonly text?: string }[])[0]?.text)).toContain("Unknown tool");

    await client.close();
    await server.close();
  });

  it("returns a structured error when a required argument is missing, without calling execute", async () => {
    let executed = false;
    const tool: MuseTool = {
      ...echoTool(),
      execute: (args) => {
        executed = true;
        return `echo: ${String((args as { text?: unknown }).text ?? "")}`;
      }
    };
    const server = createMuseToolsMcpServer({ serverName: "muse-test", tools: [tool] });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "1.0.0" });
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

    const result = await client.callTool({ arguments: {}, name: "test_echo" });
    expect(result.isError).toBe(true);
    expect(String((result.content as readonly { readonly text?: string }[])[0]?.text)).toContain("missing required argument");
    expect(executed).toBe(false);

    await client.close();
    await server.close();
  });

  it("returns a structured error (never crashes the server) when a tool throws", async () => {
    const server = createMuseToolsMcpServer({ serverName: "muse-test", tools: [throwingTool(), echoTool()] });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "1.0.0" });
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

    const failed = await client.callTool({ arguments: {}, name: "test_throw" });
    expect(failed.isError).toBe(true);
    expect(String((failed.content as readonly { readonly text?: string }[])[0]?.text)).toContain("boom");

    // The server must still be alive and answer a subsequent call.
    const ok = await client.callTool({ arguments: { text: "still alive" }, name: "test_echo" });
    expect(ok.isError).not.toBe(true);
    expect(ok.content).toEqual([{ text: "echo: still alive", type: "text" }]);

    await client.close();
    await server.close();
  });

  it("completes the real stdio wire framing: unknown method -> JSON-RPC error, malformed JSON -> no crash", async () => {
    const server = createMuseToolsMcpServer({ serverName: "muse-test", tools: [echoTool()] });
    const clientToServer = new PassThrough();
    const serverToClient = new PassThrough();
    const transport = new StdioServerTransport(clientToServer, serverToClient);
    await server.connect(transport);

    const responses: unknown[] = [];
    let buffered = "";
    serverToClient.on("data", (chunk: Buffer) => {
      buffered += chunk.toString("utf8");
      let index = buffered.indexOf("\n");
      while (index !== -1) {
        const line = buffered.slice(0, index);
        buffered = buffered.slice(index + 1);
        if (line.trim().length > 0) {
          responses.push(JSON.parse(line));
        }
        index = buffered.indexOf("\n");
      }
    });

    // Malformed JSON must not crash the transport/server — the process
    // simply cannot reply (no parseable id), so no response is queued for it.
    clientToServer.write("{not json at all\n");
    await sleep(20);
    expect(responses).toHaveLength(0);

    // An unregistered top-level method gets a real JSON-RPC MethodNotFound error.
    clientToServer.write(`${JSON.stringify({ id: 1, jsonrpc: "2.0", method: "totally/unknown", params: {} })}\n`);
    await sleep(20);
    expect(responses).toHaveLength(1);
    expect(responses[0]).toMatchObject({ error: { code: -32601 }, id: 1 });

    // The server is still alive for a well-formed request after both failures.
    clientToServer.write(`${JSON.stringify({ id: 2, jsonrpc: "2.0", method: "tools/list", params: {} })}\n`);
    await sleep(20);
    expect(responses).toHaveLength(2);
    expect(responses[1]).toMatchObject({ id: 2, result: { tools: [{ name: "test_echo" }] } });

    await server.close();
  });
});
