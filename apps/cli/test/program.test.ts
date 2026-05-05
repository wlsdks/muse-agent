import { describe, expect, it } from "vitest";
import { createProgram, defaultConfigPath } from "../src/program.js";

function captureOutput() {
  const output: string[] = [];
  return {
    io: {
      stderr: (message: string) => output.push(message),
      stdout: (message: string) => output.push(message)
    },
    output
  };
}

describe("cli program", () => {
  it("prints the config path", async () => {
    const { io, output } = captureOutput();
    const program = createProgram(io);

    await program.parseAsync(["node", "muse", "config-path"], { from: "node" });

    expect(output.join("")).toContain(defaultConfigPath());
  });

  it("prints the stack as JSON", async () => {
    const { io, output } = captureOutput();
    const program = createProgram(io);

    await program.parseAsync(["node", "muse", "spec", "--json"], { from: "node" });

    expect(JSON.parse(output.join(""))).toMatchObject({
      agentCore: "model-agnostic",
      runner: "rust",
      server: "fastify"
    });
  });

  it("posts chat requests to the configured API", async () => {
    const { io, output } = captureOutput();
    const requests: Array<{ readonly body?: string; readonly headers?: HeadersInit; readonly url: string }> = [];
    const program = createProgram({
      ...io,
      fetch: async (url, init) => {
        requests.push({
          body: String(init?.body),
          headers: init?.headers,
          url: String(url)
        });
        return new Response(JSON.stringify({ response: "CLI answer" }));
      }
    });

    await program.parseAsync([
      "node",
      "muse",
      "--api-url",
      "http://api.test",
      "--token",
      "token-1",
      "chat",
      "hello",
      "world"
    ], { from: "node" });

    expect(output.join("")).toBe("CLI answer\n");
    expect(requests[0]).toMatchObject({
      url: "http://api.test/api/chat"
    });
    expect(JSON.parse(requests[0]?.body ?? "{}")).toEqual({ message: "hello world" });
    expect(requests[0]?.headers).toMatchObject({ authorization: "Bearer token-1" });
  });

  it("supports MCP and scheduler operations through API commands", async () => {
    const { io, output } = captureOutput();
    const requests: Array<{ readonly body?: string; readonly method?: string; readonly url: string }> = [];
    const program = createProgram({
      ...io,
      fetch: async (url, init) => {
        requests.push({
          body: init?.body ? String(init.body) : undefined,
          method: init?.method,
          url: String(url)
        });
        return new Response(JSON.stringify({ ok: true }));
      }
    });

    await program.parseAsync([
      "node",
      "muse",
      "mcp",
      "add",
      "local",
      "--transport",
      "stdio",
      "--config",
      "{\"command\":\"node\"}"
    ], { from: "node" });
    await program.parseAsync(["node", "muse", "scheduler", "trigger", "job-1"], { from: "node" });

    expect(JSON.parse(requests[0]?.body ?? "{}")).toMatchObject({
      config: { command: "node" },
      name: "local",
      transportType: "stdio"
    });
    expect(requests[1]).toMatchObject({
      method: "POST",
      url: "http://127.0.0.1:3000/api/scheduler/jobs/job-1/trigger"
    });
    expect(output.join("")).toContain("\"ok\": true");
  });
});
