import type { McpServer } from "@muse/mcp";
import { describe, expect, it } from "vitest";

import { parseMcpServerInput, parseToolCallBody, parseTransportType } from "./mcp-routes-parsers.js";

// Direct coverage for the MCP route input parsers (untested). parseMcpServerInput
// is the registration input gate (validates name + transport + config before a
// server is ever connected); parseTransportType allow-lists the four transports;
// parseToolCallBody requires args/arguments to be a JSON object.

describe("parseTransportType", () => {
  it("allow-lists stdio/sse/streamable/http (case + whitespace insensitive), else undefined", () => {
    expect(parseTransportType("stdio")).toBe("stdio");
    expect(parseTransportType("SSE")).toBe("sse");
    expect(parseTransportType(" http ")).toBe("http");
    expect(parseTransportType("streamable")).toBe("streamable");
    expect(parseTransportType("ftp")).toBeUndefined();
    expect(parseTransportType("")).toBeUndefined();
    expect(parseTransportType(5)).toBeUndefined();
  });
});

describe("parseMcpServerInput", () => {
  it("rejects a non-object, a missing name, an invalid transport, and a non-object config", () => {
    expect(parseMcpServerInput(5)).toMatchObject({ error: { code: "INVALID_MCP_SERVER" }, ok: false });
    expect(parseMcpServerInput({ transportType: "stdio" })).toMatchObject({ error: { message: "Body must include a non-empty name" }, ok: false });
    expect(parseMcpServerInput({ name: "x", transportType: "ftp" })).toMatchObject({ error: { message: "transportType must be stdio, sse, streamable, or http" }, ok: false });
    expect(parseMcpServerInput({ config: "notobj", name: "x", transportType: "stdio" })).toMatchObject({ error: { message: "config must be a JSON object" }, ok: false });
  });

  it("accepts a valid spec with defaults (autoConnect true, config {})", () => {
    const ok = parseMcpServerInput({ name: "notes", transportType: "STDIO" });
    expect(ok.ok && ok.value).toEqual({ autoConnect: true, config: {}, name: "notes", transportType: "stdio" });
  });

  it("falls back to the existing server's fields when the body omits them", () => {
    const existing = { autoConnect: false, config: { a: 1 }, name: "keep", transportType: "sse" } as unknown as McpServer;
    const ok = parseMcpServerInput({}, existing);
    expect(ok.ok && ok.value).toMatchObject({ autoConnect: false, config: { a: 1 }, name: "keep", transportType: "sse" });
  });
});

describe("parseToolCallBody", () => {
  it("accepts args or the arguments alias as a JSON object", () => {
    expect(parseToolCallBody({ args: { q: "x" } })).toEqual({ ok: true, value: { q: "x" } });
    expect(parseToolCallBody({ arguments: { q: "y" } })).toEqual({ ok: true, value: { q: "y" } });
  });

  it("rejects a non-object body and non-object args", () => {
    expect(parseToolCallBody(5)).toMatchObject({ error: { code: "INVALID_MCP_TOOL_CALL" }, ok: false });
    expect(parseToolCallBody({ args: "str" })).toMatchObject({ error: { message: "Body must include args or arguments as a JSON object" }, ok: false });
  });
});
