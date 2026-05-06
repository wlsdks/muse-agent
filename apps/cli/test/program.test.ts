import { describe, expect, it } from "vitest";
import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
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

  it("posts chat requests to the configured API and writes workspace run state", async () => {
    const { io, output } = captureOutput();
    const workspaceDir = await mkdtemp(path.join(tmpdir(), "muse-cli-"));
    const requests: Array<{ readonly body?: string; readonly headers?: HeadersInit; readonly url: string }> = [];
    const program = createProgram({
      ...io,
      workspaceDir,
      fetch: async (url, init) => {
        requests.push({
          body: String(init?.body),
          headers: init?.headers,
          url: String(url)
        });
        return new Response(JSON.stringify({ response: "CLI answer", runId: "run-1" }));
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
    await expect(readFile(path.join(workspaceDir, ".muse/runs/run-1.jsonl"), "utf8"))
      .resolves
      .toContain("\"type\":\"chat.completed\"");
  });

  it("persists CLI config and uses it as chat defaults", async () => {
    const { io, output } = captureOutput();
    const configDir = await mkdtemp(path.join(tmpdir(), "muse-cli-config-defaults-"));
    const requests: Array<{ readonly body?: string; readonly url: string }> = [];
    const program = createProgram({
      ...io,
      configDir,
      fetch: async (url, init) => {
        requests.push({
          body: String(init?.body),
          url: String(url)
        });
        return new Response(JSON.stringify({ response: "configured answer", runId: "run-configured" }));
      }
    });

    await program.parseAsync(["node", "muse", "config", "set", "apiUrl", "http://api.config"], { from: "node" });
    await program.parseAsync(["node", "muse", "config", "set", "defaultModel", "openai:gpt-test"], { from: "node" });

    output.length = 0;
    await program.parseAsync(["node", "muse", "config", "show", "--json"], { from: "node" });

    expect(JSON.parse(output.join(""))).toEqual({
      apiUrl: "http://api.config",
      defaultModel: "openai:gpt-test"
    });

    output.length = 0;
    await program.parseAsync(["node", "muse", "chat", "--no-log", "hello"], { from: "node" });

    expect(output.join("")).toBe("configured answer\n");
    expect(requests[0]).toMatchObject({ url: "http://api.config/api/chat" });
    expect(JSON.parse(requests[0]?.body ?? "{}")).toEqual({
      message: "hello",
      model: "openai:gpt-test"
    });
    await expect(readFile(path.join(configDir, "config.json"), "utf8"))
      .resolves
      .toContain("\"apiUrl\": \"http://api.config\"");
  });

  it("streams remote chat over SSE and writes workspace run state", async () => {
    const { io, output } = captureOutput();
    const workspaceDir = await mkdtemp(path.join(tmpdir(), "muse-cli-stream-"));
    const requests: Array<{ readonly body?: string; readonly headers?: HeadersInit; readonly url: string }> = [];
    const program = createProgram({
      ...io,
      workspaceDir,
      fetch: async (url, init) => {
        requests.push({
          body: String(init?.body),
          headers: init?.headers,
          url: String(url)
        });
        return new Response([
          "event: message\ndata: Hello \n\n",
          "event: tool_start\ndata: read_file\n\n",
          "event: tool_end\ndata: read_file\n\n",
          "event: message\ndata: world\n\n",
          "event: done\ndata:\n\n"
        ].join(""), {
          headers: { "content-type": "text/event-stream" }
        });
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
      "--stream",
      "hello"
    ], { from: "node" });

    expect(output.join("")).toBe("Hello world\n");
    expect(requests[0]).toMatchObject({
      url: "http://api.test/api/chat/stream"
    });
    expect(JSON.parse(requests[0]?.body ?? "{}")).toEqual({ message: "hello" });
    expect(requests[0]?.headers).toMatchObject({ authorization: "Bearer token-1" });

    const runFiles = await readdir(path.join(workspaceDir, ".muse/runs"));
    expect(runFiles).toHaveLength(1);
    await expect(readFile(path.join(workspaceDir, ".muse/runs", runFiles[0] ?? ""), "utf8"))
      .resolves
      .toContain("\"source\":\"cli.remote.stream\"");
  });

  it("stores API tokens in the encrypted credential store and reuses them", async () => {
    const { io, output } = captureOutput();
    const configDir = await mkdtemp(path.join(tmpdir(), "muse-cli-config-"));
    const requests: Array<{ readonly headers?: HeadersInit; readonly url: string }> = [];
    const program = createProgram({
      ...io,
      configDir,
      credentialKey: "test-credential-key",
      fetch: async (url, init) => {
        requests.push({
          headers: init?.headers,
          url: String(url)
        });
        return new Response(JSON.stringify({ response: "stored token answer", runId: "run-credential" }));
      }
    });

    await program.parseAsync([
      "node",
      "muse",
      "--api-url",
      "http://api.test",
      "auth",
      "login",
      "stored-token"
    ], { from: "node" });

    const credentialFile = await readFile(path.join(configDir, "credentials.json"), "utf8");
    expect(credentialFile).not.toContain("stored-token");

    output.length = 0;
    await program.parseAsync([
      "node",
      "muse",
      "--api-url",
      "http://api.test",
      "chat",
      "--no-log",
      "hello"
    ], { from: "node" });

    expect(output.join("")).toBe("stored token answer\n");
    expect(requests[0]).toMatchObject({
      url: "http://api.test/api/chat"
    });
    expect(requests[0]?.headers).toMatchObject({ authorization: "Bearer stored-token" });
  });

  it("prompts for chat text when no message argument is provided", async () => {
    const { io, output } = captureOutput();
    const requests: Array<{ readonly body?: string; readonly url: string }> = [];
    const program = createProgram({
      ...io,
      fetch: async (url, init) => {
        requests.push({
          body: String(init?.body),
          url: String(url)
        });
        return new Response(JSON.stringify({ response: "interactive answer", runId: "run-interactive" }));
      },
      prompts: {
        password: async () => "unused",
        text: async () => "interactive hello"
      }
    });

    await program.parseAsync(["node", "muse", "chat", "--no-log"], { from: "node" });

    expect(output.join("")).toBe("interactive answer\n");
    expect(requests[0]).toMatchObject({ url: "http://127.0.0.1:3000/api/chat" });
    expect(JSON.parse(requests[0]?.body ?? "{}")).toEqual({ message: "interactive hello" });
  });

  it("prompts for auth login token when no token argument is provided", async () => {
    const { io, output } = captureOutput();
    const configDir = await mkdtemp(path.join(tmpdir(), "muse-cli-auth-interactive-"));
    const program = createProgram({
      ...io,
      configDir,
      credentialKey: "test-credential-key",
      prompts: {
        password: async () => "interactive-token",
        text: async () => "unused"
      }
    });

    await program.parseAsync(["node", "muse", "--api-url", "http://api.test", "auth", "login"], { from: "node" });
    await program.parseAsync(["node", "muse", "--api-url", "http://api.test", "auth", "status", "--json"], {
      from: "node"
    });

    expect(output.join("")).toContain("Stored Muse API token for http://api.test");
    expect(JSON.parse(output.at(-1) ?? "{}")).toMatchObject({
      apiUrl: "http://api.test",
      hasToken: true
    });
    await expect(readFile(path.join(configDir, "credentials.json"), "utf8"))
      .resolves
      .not
      .toContain("interactive-token");
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

  it("can run chat through the local shared agent runtime", async () => {
    const { io, output } = captureOutput();
    const workspaceDir = await mkdtemp(path.join(tmpdir(), "muse-cli-local-"));
    const program = createProgram({
      ...io,
      createRuntimeAssembly: () => ({
        agentRuntime: {
          run: async (input) => ({
            response: {
              id: "response-1",
              model: input.model,
              output: `local:${input.messages[0]?.content ?? ""}`
            },
            runId: "local-run-1"
          }),
          stream: async function* () {}
        },
        defaultModel: "test-model"
      }),
      workspaceDir
    });

    await program.parseAsync(["node", "muse", "chat", "--local", "hello"], { from: "node" });

    expect(output.join("")).toBe("local:hello\n");
    await expect(readFile(path.join(workspaceDir, ".muse/runs/local-run-1.jsonl"), "utf8"))
      .resolves
      .toContain("\"source\":\"cli.local\"");
  });

  it("opens the Ink status TUI with the active endpoint and config paths", async () => {
    const { io } = captureOutput();
    const rendered: unknown[] = [];
    const configDir = await mkdtemp(path.join(tmpdir(), "muse-cli-tui-config-"));
    const program = createProgram({
      ...io,
      configDir,
      credentialKey: "test-credential-key",
      renderTui: async (model) => {
        rendered.push(model);
      }
    });

    await program.parseAsync(["node", "muse", "--api-url", "http://api.test", "auth", "login", "stored-token"], {
      from: "node"
    });
    await program.parseAsync(["node", "muse", "config", "set", "defaultModel", "openai:gpt-test"], {
      from: "node"
    });

    await program.parseAsync([
      "node",
      "muse",
      "--api-url",
      "http://api.test",
      "tui"
    ], { from: "node" });

    expect(rendered).toEqual([
      {
        apiUrl: "http://api.test",
        auth: { hasToken: true },
        chat: { defaultModel: "openai:gpt-test" },
        configPath: path.join(configDir, "config.json"),
        credentialPath: path.join(configDir, "credentials.json"),
        mode: "remote",
        workspaceRunsPath: `${process.cwd()}/.muse/runs`
      }
    ]);
  });
});
