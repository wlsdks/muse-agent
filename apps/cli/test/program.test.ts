import { describe, expect, it } from "vitest";
import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createProgram, defaultConfigPath } from "../src/program.js";
import { appendChatTurn } from "../src/tui.js";

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

  it("opens the Ink chat TUI with the active endpoint and config paths", async () => {
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
      expect.objectContaining({
        apiUrl: "http://api.test",
        auth: { hasToken: true },
        chat: expect.objectContaining({ defaultModel: "openai:gpt-test", submit: expect.any(Function) }),
        configPath: path.join(configDir, "config.json"),
        credentialPath: path.join(configDir, "credentials.json"),
        mode: "remote",
        workspaceRunsPath: `${process.cwd()}/.muse/runs`
      })
    ]);
  });

  it("runs local TUI chat through the shared runtime and keeps previous turns", async () => {
    const { io } = captureOutput();
    const rendered: unknown[] = [];
    const workspaceDir = await mkdtemp(path.join(tmpdir(), "muse-cli-tui-local-"));
    const program = createProgram({
      ...io,
      createRuntimeAssembly: () => ({
        agentRuntime: {
          run: async (input) => ({
            response: {
              id: "response-1",
              model: input.model,
              output: `local-tui:${input.messages[0]?.content ?? ""}`
            },
            runId: `local-tui-${input.messages[0]?.content ?? "run"}`
          }),
          stream: async function* () {}
        },
        defaultModel: "diagnostic/tui"
      }),
      renderTui: async (model) => {
        rendered.push(model);
        const first = await model.chat?.submit?.("first turn");
        const second = await model.chat?.submit?.("second turn");
        const turns = appendChatTurn(
          appendChatTurn([], { assistant: first ?? "", user: "first turn" }),
          { assistant: second ?? "", user: "second turn" }
        );

        expect(turns).toEqual([
          { assistant: "local-tui:first turn", user: "first turn" },
          { assistant: "local-tui:second turn", user: "second turn" }
        ]);
      },
      workspaceDir
    });

    await program.parseAsync(["node", "muse", "tui", "--local"], { from: "node" });

    expect(rendered).toEqual([
      expect.objectContaining({
        mode: "local",
        chat: expect.objectContaining({
          submit: expect.any(Function)
        })
      })
    ]);
    await expect(readFile(path.join(workspaceDir, ".muse/runs/local-tui-first turn.jsonl"), "utf8"))
      .resolves
      .toContain("\"source\":\"cli.local\"");
    await expect(readFile(path.join(workspaceDir, ".muse/runs/local-tui-second turn.jsonl"), "utf8"))
      .resolves
      .toContain("\"message\":\"second turn\"");
  });

  it("runs remote TUI chat through the API chat route", async () => {
    const { io } = captureOutput();
    const rendered: unknown[] = [];
    const workspaceDir = await mkdtemp(path.join(tmpdir(), "muse-cli-tui-remote-"));
    const requests: Array<{ readonly body?: string; readonly url: string }> = [];
    const program = createProgram({
      ...io,
      fetch: async (url, init) => {
        requests.push({
          body: String(init?.body),
          url: String(url)
        });
        return new Response(JSON.stringify({ content: "remote tui answer", runId: "remote-tui-run" }));
      },
      renderTui: async (model) => {
        rendered.push(model);
        await expect(model.chat?.submit?.("remote turn")).resolves.toBe("remote tui answer");
      },
      workspaceDir
    });

    await program.parseAsync(["node", "muse", "--api-url", "http://api.test", "tui"], { from: "node" });

    expect(requests[0]).toMatchObject({ url: "http://api.test/api/chat" });
    expect(JSON.parse(requests[0]?.body ?? "{}")).toEqual({ message: "remote turn" });
    expect(rendered).toEqual([expect.objectContaining({ mode: "remote" })]);
    await expect(readFile(path.join(workspaceDir, ".muse/runs/remote-tui-run.jsonl"), "utf8"))
      .resolves
      .toContain("\"source\":\"cli.remote\"");
  });

  it("orchestrate run posts the multi-agent request body with mode + workerIds", async () => {
    const { io, output } = captureOutput();
    const requests: Array<{ readonly body?: string; readonly method?: string; readonly url: string }> = [];
    const program = createProgram({
      ...io,
      fetch: async (url, init) => {
        requests.push({
          body: init?.body !== undefined && init?.body !== null ? String(init.body) : undefined,
          method: init?.method,
          url: String(url)
        });
        return new Response(JSON.stringify({
          mode: "race",
          response: { output: "winner" },
          results: [{ status: "completed", workerId: "fast" }],
          runId: "orch-1"
        }));
      }
    });

    await program.parseAsync([
      "node",
      "muse",
      "--api-url",
      "http://api.test",
      "orchestrate",
      "run",
      "--mode",
      "race",
      "--workers",
      "fast,slow",
      "--max-workers",
      "2",
      "compare",
      "rollout",
      "options"
    ], { from: "node" });

    expect(requests[0]).toMatchObject({ url: "http://api.test/api/multi-agent/orchestrate", method: "POST" });
    expect(JSON.parse(requests[0]?.body ?? "{}")).toEqual({
      message: "compare rollout options",
      mode: "race",
      workerIds: ["fast", "slow"],
      maxWorkers: 2
    });
    expect(output.join("")).toContain("orch-1");
  });

  it("orchestrate run rejects unknown mode and empty message", async () => {
    const { io } = captureOutput();
    const program = createProgram({ ...io, fetch: async () => new Response("{}") });
    await expect(program.parseAsync(
      ["node", "muse", "--api-url", "http://api.test", "orchestrate", "run", "--mode", "bogus", "hi"],
      { from: "node" }
    )).rejects.toThrow(/--mode must be 'sequential', 'parallel', or 'race'/u);
    await expect(program.parseAsync(
      ["node", "muse", "--api-url", "http://api.test", "orchestrate", "run", "  "],
      { from: "node" }
    )).rejects.toThrow(/orchestrate run requires a non-empty message/u);
  });

  it("orchestrate list / get / stats hit the orchestration history endpoints", async () => {
    const { io } = captureOutput();
    const requests: Array<{ readonly url: string }> = [];
    const program = createProgram({
      ...io,
      fetch: async (url) => {
        requests.push({ url: String(url) });
        return new Response("[]");
      }
    });

    await program.parseAsync(
      ["node", "muse", "--api-url", "http://api.test", "orchestrate", "list", "--limit", "5"],
      { from: "node" }
    );
    await program.parseAsync(
      ["node", "muse", "--api-url", "http://api.test", "orchestrate", "get", "orch-42"],
      { from: "node" }
    );
    await program.parseAsync(
      ["node", "muse", "--api-url", "http://api.test", "orchestrate", "stats"],
      { from: "node" }
    );

    expect(requests[0]?.url).toBe("http://api.test/api/multi-agent/orchestrations?limit=5");
    expect(requests[1]?.url).toBe("http://api.test/api/multi-agent/orchestrations/orch-42");
    expect(requests[2]?.url).toBe("http://api.test/api/multi-agent/orchestrations/stats");
  });

  it("runtime / loopback / snapshot hit the Muse endpoints and print JSON", async () => {
    const { io, output } = captureOutput();
    const requests: Array<{ readonly method?: string; readonly url: string }> = [];
    const program = createProgram({
      ...io,
      fetch: async (url, init) => {
        requests.push({ method: init?.method, url: String(url) });
        if (String(url).endsWith("/api/muse/runtime")) {
          return new Response(JSON.stringify({
            agentCore: { modelAgnostic: true, runner: "rust" },
            service: "muse-api",
            tools: { byRisk: { execute: 0, read: 6, write: 0 }, total: 6 }
          }));
        }
        if (String(url).endsWith("/api/muse/loopback")) {
          return new Response(JSON.stringify({ servers: [{ name: "muse.time", optIn: false, toolCount: 2 }], total: 1 }));
        }
        if (String(url).endsWith("/api/admin/muse/snapshot")) {
          return new Response(JSON.stringify({
            generatedAt: "2026-05-07T00:00:00.000Z",
            latency: { count: 1, avgMs: 5, p95Ms: 5 },
            slo: { errorRate: 0, latencySamples: 1, resultSamples: 1, violations: [] }
          }));
        }
        return new Response("{}");
      }
    });

    await program.parseAsync(["node", "muse", "--api-url", "http://api.test", "runtime"], { from: "node" });
    await program.parseAsync(["node", "muse", "--api-url", "http://api.test", "loopback"], { from: "node" });
    await program.parseAsync(["node", "muse", "--api-url", "http://api.test", "snapshot"], { from: "node" });

    expect(requests[0]).toMatchObject({ url: "http://api.test/api/muse/runtime", method: "GET" });
    expect(requests[1]).toMatchObject({ url: "http://api.test/api/muse/loopback", method: "GET" });
    expect(requests[2]).toMatchObject({ url: "http://api.test/api/admin/muse/snapshot", method: "GET" });
    const combined = output.join("");
    expect(combined).toContain("muse-api");
    expect(combined).toContain("muse.time");
    expect(combined).toContain("latencySamples");
  });

  it("voice providers GETs /api/voice/providers and prints the registered STT/TTS list", async () => {
    const { io, output } = captureOutput();
    const requests: Array<{ readonly method?: string; readonly url: string }> = [];
    const program = createProgram({
      ...io,
      fetch: async (url, init) => {
        requests.push({ method: init?.method, url: String(url) });
        return new Response(JSON.stringify({
          stt: [{ description: "Cloud STT", displayName: "OpenAI Whisper", id: "openai-whisper", local: false }],
          tts: [{ description: "Cloud TTS", displayName: "OpenAI TTS", id: "openai-tts", local: false }]
        }));
      }
    });

    await program.parseAsync(
      ["node", "muse", "--api-url", "http://api.test", "voice", "providers"],
      { from: "node" }
    );

    expect(requests[0]).toMatchObject({ url: "http://api.test/api/voice/providers", method: "GET" });
    const combined = output.join("");
    expect(combined).toContain("openai-whisper");
    expect(combined).toContain("openai-tts");
  });

  it("today calls /api/today once and renders the briefing", async () => {
    const { io, output } = captureOutput();
    const requests: Array<{ readonly url: string }> = [];
    const program = createProgram({
      ...io,
      fetch: async (url) => {
        requests.push({ url: String(url) });
        return new Response(JSON.stringify({
          events: [{ endsAtIso: "2026-05-10T11:00:00Z", id: "evt-1", startsAtIso: "2026-05-10T10:00:00Z", title: "Standup" }],
          generatedAt: "2026-05-10T08:00:00Z",
          lookaheadHours: 12,
          notes: ["diary.md", "shopping.md"],
          tasks: [{ id: "task_123abc", title: "Write iter summary" }]
        }));
      }
    });

    await program.parseAsync(
      ["node", "muse", "--api-url", "http://api.test", "today", "--lookahead-hours", "12"],
      { from: "node" }
    );

    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe("http://api.test/api/today?lookaheadHours=12");

    const combined = output.join("");
    expect(combined).toContain("Today (2026-05-10");
    expect(combined).toContain("next 12h");
    expect(combined).toContain("Write iter summary");
    expect(combined).toContain("Standup");
    expect(combined).toContain("diary.md");
    expect(combined).toContain("shopping.md");
  });

  it("today --json passes the server briefing through unmodified", async () => {
    const { io, output } = captureOutput();
    const briefing = {
      events: [],
      generatedAt: "2026-05-10T08:00:00Z",
      lookaheadHours: 24,
      notes: [],
      tasks: []
    };
    const program = createProgram({
      ...io,
      fetch: async () => new Response(JSON.stringify(briefing))
    });

    await program.parseAsync(
      ["node", "muse", "--api-url", "http://api.test", "today", "--json"],
      { from: "node" }
    );

    expect(JSON.parse(output.join("").trim())).toEqual(briefing);
  });

  it("today renders 'not configured' sections when the server omits them", async () => {
    const { io, output } = captureOutput();
    const program = createProgram({
      ...io,
      fetch: async () => new Response(JSON.stringify({
        generatedAt: "2026-05-10T08:00:00Z",
        lookaheadHours: 24
        // tasks / events / notes all undefined — server says nothing's configured
      }))
    });

    await program.parseAsync(
      ["node", "muse", "--api-url", "http://api.test", "today"],
      { from: "node" }
    );

    const combined = output.join("");
    expect(combined).toContain("Tasks: (not configured)");
    expect(combined).toContain("Upcoming: (calendar not configured)");
    expect(combined).toContain("Recent notes: (notes dir not configured)");
  });

  it("notes list / read / search / save / append hit the /api/notes routes", async () => {
    const { io, output } = captureOutput();
    const requests: Array<{ readonly body?: string; readonly method?: string; readonly url: string }> = [];
    const program = createProgram({
      ...io,
      fetch: async (url, init) => {
        requests.push({ body: typeof init?.body === "string" ? init.body : undefined, method: init?.method, url: String(url) });
        const path = String(url);
        if (path.includes("/api/notes/list")) {
          return new Response(JSON.stringify({
            dir: "",
            entries: [{ isDirectory: false, name: "diary.md", sizeBytes: 42 }],
            truncated: false
          }));
        }
        if (path.includes("/api/notes/read")) {
          return new Response(JSON.stringify({ content: "alpha\nbeta\n", path: "diary.md", sizeBytes: 12 }));
        }
        if (path.includes("/api/notes/search")) {
          return new Response(JSON.stringify({ matches: [{ line: 2, path: "diary.md", snippet: "beta keyword" }] }));
        }
        if (path.endsWith("/api/notes/save")) {
          return new Response(JSON.stringify({ created: true, path: "new.md", sizeBytes: 5 }));
        }
        if (path.endsWith("/api/notes/append")) {
          return new Response(JSON.stringify({ path: "diary.md", sizeBytes: 18 }));
        }
        return new Response("{}");
      }
    });

    await program.parseAsync(
      ["node", "muse", "--api-url", "http://api.test", "notes", "list", "--subdir", "daily"],
      { from: "node" }
    );
    await program.parseAsync(
      ["node", "muse", "--api-url", "http://api.test", "notes", "read", "diary.md"],
      { from: "node" }
    );
    await program.parseAsync(
      ["node", "muse", "--api-url", "http://api.test", "notes", "search", "beta", "keyword", "--limit", "5"],
      { from: "node" }
    );
    await program.parseAsync(
      ["node", "muse", "--api-url", "http://api.test", "notes", "save", "new.md", "hello", "world", "--overwrite"],
      { from: "node" }
    );
    await program.parseAsync(
      ["node", "muse", "--api-url", "http://api.test", "notes", "append", "diary.md", "more", "text"],
      { from: "node" }
    );

    expect(requests[0]?.url).toContain("/api/notes/list?subdir=daily");
    expect(requests[0]?.method).toBe("GET");
    expect(requests[1]?.url).toContain("/api/notes/read?path=diary.md");
    expect(requests[1]?.method).toBe("GET");
    expect(requests[2]?.url).toContain("/api/notes/search?");
    expect(requests[2]?.url).toContain("query=beta+keyword");
    expect(requests[2]?.url).toContain("limit=5");
    expect(requests[3]?.method).toBe("POST");
    expect(requests[3]?.url).toBe("http://api.test/api/notes/save");
    expect(JSON.parse(requests[3]!.body!)).toMatchObject({ content: "hello world", overwrite: true, path: "new.md" });
    expect(requests[4]?.method).toBe("POST");
    expect(requests[4]?.url).toBe("http://api.test/api/notes/append");
    expect(JSON.parse(requests[4]!.body!)).toMatchObject({ content: "more text", path: "diary.md" });

    const combined = output.join("");
    expect(combined).toContain("diary.md");
    expect(combined).toContain("alpha");
  });

  it("notes providers hits /api/notes/providers and surfaces the configured backends", async () => {
    const { io, output } = captureOutput();
    const requests: Array<{ readonly url: string }> = [];
    const program = createProgram({
      ...io,
      fetch: async (url) => {
        requests.push({ url: String(url) });
        return new Response(JSON.stringify({
          providers: [
            { description: "Local FS", displayName: "Local directory", id: "local", local: true },
            { description: "Notion API", displayName: "Notion", id: "notion", local: false }
          ]
        }));
      }
    });

    await program.parseAsync(
      ["node", "muse", "--api-url", "http://api.test", "notes", "providers"],
      { from: "node" }
    );

    expect(requests[0]?.url).toBe("http://api.test/api/notes/providers");
    const combined = output.join("");
    expect(combined).toContain("local");
    expect(combined).toContain("notion");
  });

  it("tasks providers hits /api/tasks/providers and surfaces the configured backends", async () => {
    const { io, output } = captureOutput();
    const requests: Array<{ readonly url: string }> = [];
    const program = createProgram({
      ...io,
      fetch: async (url) => {
        requests.push({ url: String(url) });
        return new Response(JSON.stringify({
          providers: [
            { description: "Local FS", displayName: "Local file", id: "local", local: true },
            { description: "macOS Reminders.app", displayName: "Apple Reminders", id: "apple-reminders", local: true }
          ]
        }));
      }
    });

    await program.parseAsync(
      ["node", "muse", "--api-url", "http://api.test", "tasks", "providers"],
      { from: "node" }
    );

    expect(requests[0]?.url).toBe("http://api.test/api/tasks/providers");
    const combined = output.join("");
    expect(combined).toContain("local");
    expect(combined).toContain("apple-reminders");
  });

  it("tasks list / add / complete / delete hit the /api/tasks routes", async () => {
    const { io, output } = captureOutput();
    const requests: Array<{ readonly body?: string; readonly method?: string; readonly url: string }> = [];
    const program = createProgram({
      ...io,
      fetch: async (url, init) => {
        requests.push({ body: typeof init?.body === "string" ? init.body : undefined, method: init?.method, url: String(url) });
        const path = String(url);
        if (path.includes("/api/tasks") && init?.method === "DELETE") {
          return new Response(null, { status: 204 });
        }
        if (path.endsWith("/api/tasks/t-1/complete")) {
          return new Response(JSON.stringify({ id: "t-1", status: "done" }));
        }
        if (path.endsWith("/api/tasks") && init?.method === "POST") {
          return new Response(JSON.stringify({ id: "t-1", status: "open", title: "buy milk" }), { status: 201 });
        }
        if (path.includes("/api/tasks?status=")) {
          return new Response(JSON.stringify({
            status: "open",
            tasks: [{ id: "t-1", status: "open", title: "buy milk" }],
            total: 1
          }));
        }
        return new Response("{}");
      }
    });

    await program.parseAsync(
      ["node", "muse", "--api-url", "http://api.test", "tasks", "list", "--status", "open"],
      { from: "node" }
    );
    await program.parseAsync(
      ["node", "muse", "--api-url", "http://api.test", "tasks", "add", "buy", "milk", "--tags", "shopping,today"],
      { from: "node" }
    );
    await program.parseAsync(
      ["node", "muse", "--api-url", "http://api.test", "tasks", "complete", "t-1"],
      { from: "node" }
    );
    await program.parseAsync(
      ["node", "muse", "--api-url", "http://api.test", "tasks", "delete", "t-1"],
      { from: "node" }
    );

    expect(requests[0]?.url).toContain("/api/tasks?status=open");
    expect(requests[0]?.method).toBe("GET");
    expect(requests[1]?.method).toBe("POST");
    expect(requests[1]?.url).toBe("http://api.test/api/tasks");
    expect(JSON.parse(requests[1]!.body!)).toMatchObject({ title: "buy milk", tags: ["shopping", "today"] });
    expect(requests[2]?.url).toBe("http://api.test/api/tasks/t-1/complete");
    expect(requests[2]?.method).toBe("POST");
    expect(requests[3]?.url).toBe("http://api.test/api/tasks/t-1");
    expect(requests[3]?.method).toBe("DELETE");

    const combined = output.join("");
    expect(combined).toContain("buy milk");
    expect(combined).toContain("Deleted task t-1");
  });

  it("calendar providers / events hit the /api/calendar routes with the right query params", async () => {
    const { io, output } = captureOutput();
    const requests: Array<{ readonly method?: string; readonly url: string }> = [];
    const program = createProgram({
      ...io,
      fetch: async (url, init) => {
        requests.push({ method: init?.method, url: String(url) });
        const path = String(url);
        if (path.endsWith("/api/calendar/providers")) {
          return new Response(JSON.stringify({
            enabled: ["local"],
            providers: [{ description: "Local file", displayName: "Local", id: "local", local: true }]
          }));
        }
        if (path.includes("/api/calendar/events")) {
          return new Response(JSON.stringify({
            events: [{
              endsAtIso: "2026-05-10T11:00:00Z",
              id: "evt-1",
              providerId: "local",
              startsAtIso: "2026-05-10T10:00:00Z",
              title: "Standup"
            }],
            total: 1
          }));
        }
        return new Response("{}");
      }
    });

    await program.parseAsync(
      ["node", "muse", "--api-url", "http://api.test", "calendar", "providers"],
      { from: "node" }
    );
    await program.parseAsync(
      [
        "node", "muse", "--api-url", "http://api.test",
        "calendar", "events",
        "--from", "2026-05-10T00:00:00Z",
        "--to", "2026-05-11T00:00:00Z",
        "--provider", "local"
      ],
      { from: "node" }
    );

    expect(requests[0]).toMatchObject({ url: "http://api.test/api/calendar/providers", method: "GET" });
    expect(requests[1]?.method).toBe("GET");
    expect(requests[1]?.url).toContain("fromIso=2026-05-10T00%3A00%3A00Z");
    expect(requests[1]?.url).toContain("toIso=2026-05-11T00%3A00%3A00Z");
    expect(requests[1]?.url).toContain("providerId=local");

    const combined = output.join("");
    expect(combined).toContain("local");
    expect(combined).toContain("Standup");
  });

  it("memory show / set / clear hit the user-memory routes", async () => {
    const { io, output } = captureOutput();
    const requests: Array<{ readonly body?: string; readonly method?: string; readonly url: string }> = [];
    const program = createProgram({
      ...io,
      fetch: async (url, init) => {
        requests.push({ body: typeof init?.body === "string" ? init.body : undefined, method: init?.method, url: String(url) });
        const path = String(url);
        if (path.endsWith("/api/user-memory/me")) {
          if (init?.method === "DELETE") {
            return new Response(null, { status: 204 });
          }
          return new Response(JSON.stringify({
            facts: { name: "Stark" },
            preferences: { tone: "concise" },
            recentTopics: ["voice", "notes"],
            updatedAt: "2026-05-10T00:00:00Z"
          }));
        }
        if (path.endsWith("/api/user-memory/me/preferences")) {
          return new Response(JSON.stringify({ updated: true }));
        }
        return new Response("{}");
      }
    });

    await program.parseAsync(
      ["node", "muse", "--api-url", "http://api.test", "memory", "show"],
      { from: "node" }
    );
    await program.parseAsync(
      ["node", "muse", "--api-url", "http://api.test", "memory", "set", "preference", "tone", "concise"],
      { from: "node" }
    );
    await program.parseAsync(
      ["node", "muse", "--api-url", "http://api.test", "memory", "clear"],
      { from: "node" }
    );

    expect(requests[0]).toMatchObject({ url: "http://api.test/api/user-memory/me", method: "GET" });
    expect(requests[1]).toMatchObject({ url: "http://api.test/api/user-memory/me/preferences", method: "PUT" });
    expect(JSON.parse(requests[1]!.body!)).toMatchObject({ key: "tone", value: "concise" });
    expect(requests[2]).toMatchObject({ url: "http://api.test/api/user-memory/me", method: "DELETE" });
    const combined = output.join("");
    expect(combined).toContain("Stark");
    expect(combined).toContain("Cleared user memory for me");
  });

  it("voice tts POSTs the text and writes the binary audio response to --out", async () => {
    const { mkdtempSync, readFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const tmp = mkdtempSync(join(tmpdir(), "muse-cli-voice-"));
    const outPath = join(tmp, "speech.mp3");

    const { io, output } = captureOutput();
    const audioBytes = new Uint8Array([10, 20, 30, 40, 50]);
    const requests: Array<{ readonly method?: string; readonly url: string; readonly body?: string }> = [];
    const program = createProgram({
      ...io,
      fetch: async (url, init) => {
        requests.push({ body: typeof init?.body === "string" ? init.body : undefined, method: init?.method, url: String(url) });
        return new Response(audioBytes, {
          headers: {
            "content-type": "audio/mpeg",
            "x-voice-format": "mp3",
            "x-voice-provider": "openai-tts"
          },
          status: 200
        });
      }
    });

    await program.parseAsync(
      ["node", "muse", "--api-url", "http://api.test", "voice", "tts", "hello", "world", "--out", outPath, "--voice", "nova"],
      { from: "node" }
    );

    expect(requests[0]).toMatchObject({ url: "http://api.test/api/voice/tts", method: "POST" });
    const sent = JSON.parse(requests[0]!.body!);
    expect(sent).toMatchObject({ text: "hello world", voice: "nova", format: "mp3" });

    const written = readFileSync(outPath);
    expect(Array.from(written)).toEqual([10, 20, 30, 40, 50]);

    const combined = output.join("");
    expect(combined).toContain("Wrote 5 bytes");
    expect(combined).toContain("openai-tts");
  });

  it("specs list / get / resolve hit the public agent-spec endpoints", async () => {
    const { io, output } = captureOutput();
    const requests: Array<{ readonly body?: string; readonly method?: string; readonly url: string }> = [];
    const program = createProgram({
      ...io,
      fetch: async (url, init) => {
        requests.push({
          body: init?.body !== undefined && init?.body !== null ? String(init.body) : undefined,
          method: init?.method,
          url: String(url)
        });
        if (String(url).endsWith("/agent-specs")) {
          return new Response(JSON.stringify([{ enabled: true, id: "agent_spec_1", name: "demo" }]));
        }
        if (String(url).endsWith("/agent-specs/demo")) {
          return new Response(JSON.stringify({ enabled: true, id: "agent_spec_1", name: "demo" }));
        }
        if (String(url).endsWith("/agent-specs/resolve")) {
          return new Response(JSON.stringify({ resolution: { matchedKeywords: ["demo"], name: "demo" } }));
        }
        return new Response("[]");
      }
    });

    await program.parseAsync(["node", "muse", "--api-url", "http://api.test", "specs", "list"], { from: "node" });
    await program.parseAsync(["node", "muse", "--api-url", "http://api.test", "specs", "get", "demo"], { from: "node" });
    await program.parseAsync([
      "node",
      "muse",
      "--api-url",
      "http://api.test",
      "specs",
      "resolve",
      "demo",
      "this"
    ], { from: "node" });

    expect(requests[0]).toMatchObject({ url: "http://api.test/agent-specs", method: "GET" });
    expect(requests[1]).toMatchObject({ url: "http://api.test/agent-specs/demo", method: "GET" });
    expect(requests[2]).toMatchObject({ url: "http://api.test/agent-specs/resolve", method: "POST" });
    expect(JSON.parse(requests[2]?.body ?? "{}")).toEqual({ text: "demo this" });
    expect(output.join("")).toContain("matchedKeywords");
  });

  it("specs resolve rejects an empty prompt", async () => {
    const { io } = captureOutput();
    const program = createProgram({
      ...io,
      fetch: async () => new Response("{}")
    });
    await expect(program.parseAsync(
      ["node", "muse", "--api-url", "http://api.test", "specs", "resolve", "  "],
      { from: "node" }
    )).rejects.toThrow(/specs resolve requires a non-empty prompt/u);
  });

  it("threads --mode plan_execute into the /api/chat request body as metadata.agentMode", async () => {
    const { io } = captureOutput();
    const requests: Array<{ readonly body?: string; readonly url: string }> = [];
    const program = createProgram({
      ...io,
      fetch: async (url, init) => {
        requests.push({ body: String(init?.body), url: String(url) });
        return new Response(JSON.stringify({ response: "plan answer", runId: "plan-r1" }));
      }
    });

    await program.parseAsync([
      "node",
      "muse",
      "--api-url",
      "http://api.test",
      "chat",
      "--mode",
      "plan_execute",
      "--no-log",
      "Plan something"
    ], { from: "node" });

    expect(requests).toHaveLength(1);
    expect(JSON.parse(requests[0]?.body ?? "{}")).toMatchObject({
      message: "Plan something",
      metadata: { agentMode: "plan_execute" }
    });
  });

  it("rejects an unknown --mode value with a clear error", async () => {
    const { io } = captureOutput();
    const program = createProgram({
      ...io,
      fetch: async () => new Response("{}")
    });
    await expect(program.parseAsync([
      "node",
      "muse",
      "--api-url",
      "http://api.test",
      "chat",
      "--mode",
      "fancy",
      "--no-log",
      "x"
    ], { from: "node" })).rejects.toThrow(/--mode must be 'react' or 'plan_execute'/u);
  });

  it("threads --mode plan_execute into /api/chat/stream metadata.agentMode", async () => {
    const { io } = captureOutput();
    const requests: Array<{ readonly body?: string; readonly url: string }> = [];
    const program = createProgram({
      ...io,
      fetch: async (url, init) => {
        requests.push({ body: String(init?.body), url: String(url) });
        const sse = "event: message\ndata: streamed plan answer\n\nevent: done\ndata: {}\n\n";
        return new Response(sse, { headers: { "content-type": "text/event-stream" } });
      }
    });

    await program.parseAsync([
      "node",
      "muse",
      "--api-url",
      "http://api.test",
      "chat",
      "--stream",
      "--mode",
      "plan_execute",
      "--no-log",
      "stream this plan"
    ], { from: "node" });

    expect(requests[0]?.url).toBe("http://api.test/api/chat/stream");
    expect(JSON.parse(requests[0]?.body ?? "{}")).toMatchObject({
      message: "stream this plan",
      metadata: { agentMode: "plan_execute" }
    });
  });

  it("omits metadata.agentMode when --mode is not provided", async () => {
    const { io } = captureOutput();
    const requests: Array<{ readonly body?: string }> = [];
    const program = createProgram({
      ...io,
      fetch: async (_url, init) => {
        requests.push({ body: String(init?.body) });
        return new Response(JSON.stringify({ response: "default answer", runId: "default-r1" }));
      }
    });

    await program.parseAsync([
      "node",
      "muse",
      "--api-url",
      "http://api.test",
      "chat",
      "--no-log",
      "no mode"
    ], { from: "node" });

    expect(JSON.parse(requests[0]?.body ?? "{}")).toEqual({ message: "no mode" });
  });

  it("mcp config-path prints the path resolved from MUSE_MCP_CONFIG", async () => {
    const previous = process.env.MUSE_MCP_CONFIG;
    process.env.MUSE_MCP_CONFIG = "/tmp/test/mcp.json";
    try {
      const { io, output } = captureOutput();
      const program = createProgram(io);
      await program.parseAsync(["node", "muse", "mcp", "config-path"], { from: "node" });
      expect(output.join("")).toContain("/tmp/test/mcp.json");
    } finally {
      if (previous === undefined) {
        delete process.env.MUSE_MCP_CONFIG;
      } else {
        process.env.MUSE_MCP_CONFIG = previous;
      }
    }
  });

  it("mcp config-show reports a missing-file message when MUSE_MCP_CONFIG points at nothing", async () => {
    const tmp = await mkdtemp(path.join(tmpdir(), "muse-mcp-config-cli-"));
    const target = path.join(tmp, "missing.json");
    const previous = process.env.MUSE_MCP_CONFIG;
    process.env.MUSE_MCP_CONFIG = target;
    try {
      const { io, output } = captureOutput();
      const program = createProgram(io);
      await program.parseAsync(["node", "muse", "mcp", "config-show"], { from: "node" });
      const out = output.join("");
      expect(out).toContain(`config: ${target}`);
      expect(out).toContain("(no entries");
    } finally {
      if (previous === undefined) {
        delete process.env.MUSE_MCP_CONFIG;
      } else {
        process.env.MUSE_MCP_CONFIG = previous;
      }
    }
  });

  it("mcp config-show prints one row per parsed entry", async () => {
    const { writeFile } = await import("node:fs/promises");
    const tmp = await mkdtemp(path.join(tmpdir(), "muse-mcp-config-cli-"));
    const target = path.join(tmp, "mcp.json");
    await writeFile(target, JSON.stringify({
      mcpServers: {
        filesystem: { args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"], command: "npx" },
        github: { url: "https://api.githubcopilot.com/mcp/" }
      }
    }), "utf8");

    const previous = process.env.MUSE_MCP_CONFIG;
    process.env.MUSE_MCP_CONFIG = target;
    try {
      const { io, output } = captureOutput();
      const program = createProgram(io);
      await program.parseAsync(["node", "muse", "mcp", "config-show"], { from: "node" });
      const out = output.join("");
      expect(out).toContain("filesystem\tstdio\tcommand=npx");
      expect(out).toContain("github\tstreamable\turl=https://api.githubcopilot.com/mcp/");
    } finally {
      if (previous === undefined) {
        delete process.env.MUSE_MCP_CONFIG;
      } else {
        process.env.MUSE_MCP_CONFIG = previous;
      }
    }
  });

  it("mcp config-show --json emits structured output", async () => {
    const { writeFile } = await import("node:fs/promises");
    const tmp = await mkdtemp(path.join(tmpdir(), "muse-mcp-config-cli-"));
    const target = path.join(tmp, "mcp.json");
    await writeFile(target, JSON.stringify({
      mcpServers: { fs: { command: "node", args: ["server.js"] } }
    }), "utf8");

    const previous = process.env.MUSE_MCP_CONFIG;
    process.env.MUSE_MCP_CONFIG = target;
    try {
      const { io, output } = captureOutput();
      const program = createProgram(io);
      await program.parseAsync(["node", "muse", "mcp", "config-show", "--json"], { from: "node" });
      const parsed = JSON.parse(output.join("")) as { entries: Array<{ name: string }>; path: string };
      expect(parsed.path).toBe(target);
      expect(parsed.entries.map((entry) => entry.name)).toEqual(["fs"]);
    } finally {
      if (previous === undefined) {
        delete process.env.MUSE_MCP_CONFIG;
      } else {
        process.env.MUSE_MCP_CONFIG = previous;
      }
    }
  });

  it("mcp config-doctor reports OK rows for valid entries and exits 0", async () => {
    const { writeFile } = await import("node:fs/promises");
    const tmp = await mkdtemp(path.join(tmpdir(), "muse-mcp-doctor-cli-"));
    const target = path.join(tmp, "mcp.json");
    await writeFile(target, JSON.stringify({
      mcpServers: {
        fs: { command: "node", args: ["server.js"] },
        gh: { url: "https://api.github.com/mcp/" }
      }
    }), "utf8");

    const previous = process.env.MUSE_MCP_CONFIG;
    process.env.MUSE_MCP_CONFIG = target;
    try {
      const { io, output } = captureOutput();
      const program = createProgram(io);
      await program.parseAsync(["node", "muse", "mcp", "config-doctor"], { from: "node" });
      const out = output.join("");
      expect(out).toContain(`config: ${target}`);
      expect(out).toContain("fs\tOK\tstdio");
      expect(out).toContain("gh\tOK\tstreamable");
    } finally {
      if (previous === undefined) {
        delete process.env.MUSE_MCP_CONFIG;
      } else {
        process.env.MUSE_MCP_CONFIG = previous;
      }
    }
  });

  it("mcp config-doctor reports per-entry errors without bailing on the first", async () => {
    const { writeFile } = await import("node:fs/promises");
    const tmp = await mkdtemp(path.join(tmpdir(), "muse-mcp-doctor-cli-"));
    const target = path.join(tmp, "mcp.json");
    await writeFile(target, JSON.stringify({
      mcpServers: {
        good: { command: "node" },
        broken: { description: "no transport given" },
        also_good: { url: "https://example.com/mcp" }
      }
    }), "utf8");

    const previous = process.env.MUSE_MCP_CONFIG;
    process.env.MUSE_MCP_CONFIG = target;
    try {
      const { io, output } = captureOutput();
      const program = createProgram(io);
      let exitError: unknown;
      try {
        await program.parseAsync(["node", "muse", "mcp", "config-doctor"], { from: "node" });
      } catch (err) {
        exitError = err;
      }
      const out = output.join("");
      expect(out).toContain("good\tOK\tstdio");
      expect(out).toContain("broken\tERROR");
      expect(out).toContain("also_good\tOK\tstreamable");
      expect(exitError).toBeDefined();
    } finally {
      if (previous === undefined) {
        delete process.env.MUSE_MCP_CONFIG;
      } else {
        process.env.MUSE_MCP_CONFIG = previous;
      }
    }
  });
});
