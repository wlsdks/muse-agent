import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { Command } from "commander";
import { createProgram, defaultConfigPath, uniqueCommandPrefix } from "../src/program.js";
import { registerListenCommand, type ListenShells } from "../src/commands-listen.js";
import { formatNoticeStamp } from "../src/commands-agent-notices.js";
import { formatLocalDateTime } from "../src/human-formatters.js";
import { appendChatTurn } from "../src/tui.js";

function captureOutput() {
  const output: string[] = [];
  return {
    io: {
      // Tests never have a piped stdin; this stub keeps the chat
      // action from blocking on `for await (const chunk of process.stdin)`
      // when vitest runs in a non-TTY harness.
      readPipedStdin: async () => "",
      stderr: (message: string) => output.push(message),
      stdout: (message: string) => output.push(message)
    },
    output
  };
}

describe("cli program", () => {
  // Isolate the active persona from the developer's real
  // ~/.muse/persona.json — otherwise a non-default persona leaks a
  // systemPrompt into the exact-body chat assertions below.
  let personaEnvBackup: string | undefined;
  // Likewise isolate HOME so the developer's real ~/.config/muse/config.json
  // (e.g. a `defaultModel`) doesn't leak a `model` field into the request-body
  // assertions below. Tests that need a real config set `configDir` explicitly.
  let homeEnvBackup: string | undefined;
  beforeEach(async () => {
    personaEnvBackup = process.env.MUSE_PERSONA_FILE;
    process.env.MUSE_PERSONA_FILE = path.join(tmpdir(), `muse-test-no-persona-${process.pid.toString()}.json`);
    homeEnvBackup = process.env.HOME;
    process.env.HOME = await mkdtemp(path.join(tmpdir(), "muse-test-home-"));
  });
  afterEach(() => {
    if (personaEnvBackup === undefined) delete process.env.MUSE_PERSONA_FILE;
    else process.env.MUSE_PERSONA_FILE = personaEnvBackup;
    if (homeEnvBackup === undefined) delete process.env.HOME;
    else process.env.HOME = homeEnvBackup;
  });

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

  it("streams remote chat strips ANSI / control bytes from SSE message data before stdout", async () => {
    const { io, output } = captureOutput();
    const workspaceDir = await mkdtemp(path.join(tmpdir(), "muse-cli-stream-safe-"));
    const program = createProgram({
      ...io,
      workspaceDir,
      fetch: async () => new Response([
        // Hostile delta: ESC[2J clears screen, BEL is annoying, NUL terminates strings on some terminals.
        "event: message\ndata: Hello \x1b[2J\x07\x00World\n\n",
        "event: done\ndata:\n\n"
      ].join(""), {
        headers: { "content-type": "text/event-stream" }
      })
    });

    await program.parseAsync([
      "node",
      "muse",
      "--api-url",
      "http://api.test",
      "chat",
      "--stream",
      "hi"
    ], { from: "node" });

    const text = output.join("");
    expect(text).not.toMatch(/\x1b/u);
    expect(text).not.toMatch(/\x07/u);
    expect(text).not.toMatch(/\x00/u);
    expect(text).toContain("Hello [2JWorld"); // ESC stripped, the literal "[2J" survives as plain text
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

    // The @clack prompt fallback is only valid on a real interactive TTY — the
    // non-arg path now refuses (with a clear error) under non-TTY/EOF stdin to
    // avoid the half-rendered, cursor-hiding prompt. Simulate the TTY here.
    const prevIn = process.stdin.isTTY;
    const prevOut = process.stdout.isTTY;
    (process.stdin as { isTTY?: boolean }).isTTY = true;
    (process.stdout as { isTTY?: boolean }).isTTY = true;
    try {
      await program.parseAsync(["node", "muse", "chat", "--no-log"], { from: "node" });
    } finally {
      (process.stdin as { isTTY?: boolean }).isTTY = prevIn;
      (process.stdout as { isTTY?: boolean }).isTTY = prevOut;
    }

    expect(output.join("")).toBe("interactive answer\n");
    expect(requests[0]).toMatchObject({ url: "http://127.0.0.1:3030/api/chat" });
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
      url: "http://127.0.0.1:3030/api/scheduler/jobs/job-1/trigger"
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
              // runLocalChat injects a "Current local context: ..."
              // system message at index 0 so the model knows `now`.
              // The user-typed message is the last entry.
              output: `local:${input.messages.at(-1)?.content ?? ""}`
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

  it("prepends the active persona preamble to the local chat system message (goal 158)", async () => {
    const { io, output } = captureOutput();
    const workspaceDir = await mkdtemp(path.join(tmpdir(), "muse-cli-persona-chat-"));
    const personaFile = path.join(workspaceDir, "persona.json");
    await writeFile(personaFile, JSON.stringify({ version: 1, activeId: "jarvis", custom: {} }), "utf8");
    const prevPersonaEnv = process.env.MUSE_PERSONA_FILE;
    process.env.MUSE_PERSONA_FILE = personaFile;
    let capturedSystem = "";
    try {
      const program = createProgram({
        ...io,
        createRuntimeAssembly: () => ({
          agentRuntime: {
            run: async (input) => {
              capturedSystem = input.messages.find((m) => m.role === "system")?.content ?? "";
              return {
                response: { id: "r", model: input.model, output: "ok" },
                runId: "persona-run-1"
              };
            },
            stream: async function* () {}
          },
          defaultModel: "test-model"
        }),
        workspaceDir
      });
      await program.parseAsync(["node", "muse", "chat", "--local", "--no-log", "hi"], { from: "node" });
    } finally {
      if (prevPersonaEnv === undefined) delete process.env.MUSE_PERSONA_FILE;
      else process.env.MUSE_PERSONA_FILE = prevPersonaEnv;
    }
    expect(output.join("")).toBe("ok\n");
    expect(capturedSystem).toContain("Speak as JARVIS");
    expect(capturedSystem).toContain("Current local context:");
  });

  it("falls back to now-context-only when the active persona is default (goal 158)", async () => {
    const { io } = captureOutput();
    const workspaceDir = await mkdtemp(path.join(tmpdir(), "muse-cli-persona-default-"));
    const personaFile = path.join(workspaceDir, "persona.json");
    await writeFile(personaFile, JSON.stringify({ version: 1, activeId: "default", custom: {} }), "utf8");
    const prevPersonaEnv = process.env.MUSE_PERSONA_FILE;
    process.env.MUSE_PERSONA_FILE = personaFile;
    let capturedSystem = "";
    try {
      const program = createProgram({
        ...io,
        createRuntimeAssembly: () => ({
          agentRuntime: {
            run: async (input) => {
              capturedSystem = input.messages.find((m) => m.role === "system")?.content ?? "";
              return { response: { id: "r", model: input.model, output: "ok" }, runId: "d-run-1" };
            },
            stream: async function* () {}
          },
          defaultModel: "test-model"
        }),
        workspaceDir
      });
      await program.parseAsync(["node", "muse", "chat", "--local", "--no-log", "hi"], { from: "node" });
    } finally {
      if (prevPersonaEnv === undefined) delete process.env.MUSE_PERSONA_FILE;
      else process.env.MUSE_PERSONA_FILE = prevPersonaEnv;
    }
    expect(capturedSystem).not.toContain("Speak as JARVIS");
    expect(capturedSystem).toContain("Current local context:");
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
              // System date prefix at index 0; user turn at the end.
              output: `local-tui:${input.messages.at(-1)?.content ?? ""}`
            },
            runId: `local-tui-${input.messages.at(-1)?.content ?? "run"}`
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

  it("orchestrate run accepts mixed-case --mode and normalizes it in the POST body so the server sees lowercase", async () => {
    const { io } = captureOutput();
    const requests: Array<{ readonly body: string }> = [];
    const program = createProgram({
      ...io,
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        requests.push({ body: typeof init?.body === "string" ? init.body : "" });
        return new Response(JSON.stringify({ ok: true }));
      }
    });
    // `PARALLEL` was previously rejected as a typo (case-sensitive
    // includes-check); now it normalizes to `parallel` and rides
    // into the request body lowercase. Matches the --status /
    // --kind / --result sibling convention.
    await program.parseAsync(
      ["node", "muse", "--api-url", "http://api.test", "orchestrate", "run", "--mode", "PARALLEL", "hi"],
      { from: "node" }
    );
    expect(requests).toHaveLength(1);
    const body = JSON.parse(requests[0]!.body) as { mode: string };
    expect(
      body.mode,
      "mode must be lowercase-normalized in the body so the server doesn't see mixed casing"
    ).toBe("parallel");

    // Whitespace-padded mixed case also works.
    requests.length = 0;
    await program.parseAsync(
      ["node", "muse", "--api-url", "http://api.test", "orchestrate", "run", "--mode", "  Race  ", "hi"],
      { from: "node" }
    );
    const body2 = JSON.parse(requests[0]!.body) as { mode: string };
    expect(body2.mode).toBe("race");
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

  it("context hits /api/active-context and renders the snapshot inline", async () => {
    const { io, output } = captureOutput();
    const requests: Array<{ readonly method?: string; readonly url: string }> = [];
    const program = createProgram({
      ...io,
      fetch: async (url, init) => {
        requests.push({ method: init?.method, url: String(url) });
        return new Response(JSON.stringify({
          activeTask: { dueIso: "2026-05-11T08:00:00.000Z", id: "task-7", title: "Plan iteration loop" },
          currentFocus: "muse decomp",
          isWorkingHours: true,
          localHour: 14,
          nowIso: "2026-05-11T05:00:00.000Z",
          timezone: "Asia/Seoul",
          todaysEvents: [{ allDay: false, location: "Zoom", startIso: "2026-05-11T07:00:00.000Z", title: "Standup" }],
          weekday: "Monday",
          workingHours: { end: 18, start: 9 }
        }));
      }
    });

    await program.parseAsync(["node", "muse", "--api-url", "http://api.test", "context"], { from: "node" });
    expect(requests[0]).toMatchObject({ url: "http://api.test/api/active-context", method: "GET" });
    const combined = output.join("");
    expect(combined).toContain("now=2026-05-11T05:00:00.000Z (Monday, Asia/Seoul)");
    expect(combined).toContain("working_hours=9-18 (in_window=yes)");
    expect(combined).toContain("current_focus: muse decomp");
    expect(combined).toContain("active_task: Plan iteration loop · id=task-7 · due=2026-05-11T08:00:00.000Z");
    expect(combined).toContain("today_events:");
    expect(combined).toContain("Standup @ Zoom");
  });

  it("context --json prints the raw snapshot and forwards user/session params", async () => {
    const { io, output } = captureOutput();
    const requests: Array<{ readonly method?: string; readonly url: string }> = [];
    const program = createProgram({
      ...io,
      fetch: async (url, init) => {
        requests.push({ method: init?.method, url: String(url) });
        return new Response(JSON.stringify({
          localHour: 9,
          nowIso: "2026-05-11T00:00:00.000Z",
          timezone: "UTC",
          weekday: "Monday"
        }));
      }
    });

    await program.parseAsync(
      ["node", "muse", "--api-url", "http://api.test", "context", "--json", "--user", "alice", "--session", "s-42"],
      { from: "node" }
    );
    expect(requests[0]?.url).toContain("/api/active-context?");
    expect(requests[0]?.url).toContain("userId=alice");
    expect(requests[0]?.url).toContain("sessionId=s-42");
    const combined = output.join("");
    expect(combined).toContain('"timezone": "UTC"');
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
          tasks: [{ dueAt: "2026-05-10T14:00:00Z", id: "task_123abc", title: "Write iter summary" }]
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

  it("calendar events rejects an unparseable --from in API mode before any request (goal 261)", async () => {
    const { io } = captureOutput();
    const requests: string[] = [];
    const program = createProgram({
      ...io,
      fetch: async (url) => {
        requests.push(String(url));
        return new Response("{}");
      }
    });
    await expect(
      program.parseAsync(
        ["node", "muse", "--api-url", "http://api.test", "calendar", "events", "--from", "not-a-date"],
        { from: "node" }
      )
    ).rejects.toThrow(/--from \/ --to must be ISO 8601 timestamps/u);
    // The bad input must be caught before any /api/calendar/events
    // request — same actionable error the --local path already gave.
    expect(requests.some((u) => u.includes("/api/calendar/events"))).toBe(false);
  });

  it("memory show / set / clear hit the user-memory routes", async () => {
    // Test pins the API user-id to "me" — the historical default
    // when memory commands were single-tenant. The CLI now resolves
    // MUSE_USER_ID → $USER → "default", so pin via env to keep the
    // request URL deterministic.
    const prevUser = process.env.MUSE_USER_ID;
    process.env.MUSE_USER_ID = "me";
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
    expect(combined).toContain("Cleared user memory");
    if (prevUser === undefined) {
      delete process.env.MUSE_USER_ID;
    } else {
      process.env.MUSE_USER_ID = prevUser;
    }
  });

  it("muse memory honours --persona and MUSE_PERSONA so multi-persona slots are addressable (goal 103)", async () => {
    const { resolveMemoryUserId } = await import("../src/commands-memory.js");

    // Helper unit-level: --persona wins; env fills the gap; whitespace
    // is normalised the same as goal 097.
    expect(resolveMemoryUserId("stark", "work")).toBe("stark@work");
    expect(resolveMemoryUserId("stark", undefined)).toBe("stark");
    const prevPersona = process.env.MUSE_PERSONA;
    process.env.MUSE_PERSONA = "home";
    try {
      expect(resolveMemoryUserId("stark", undefined)).toBe("stark@home");
      expect(resolveMemoryUserId("stark", "work")).toBe("stark@work");
    } finally {
      if (prevPersona === undefined) delete process.env.MUSE_PERSONA;
      else process.env.MUSE_PERSONA = prevPersona;
    }

    // End-to-end: the API URL the CLI hits carries the user@slot
    // composite, so a `MUSE_PERSONA=work muse memory show` reaches
    // the work record (and not the bare `stark` one).
    const prevUser = process.env.MUSE_USER_ID;
    process.env.MUSE_USER_ID = "stark";
    process.env.MUSE_PERSONA = "work";
    try {
      const { io, output } = captureOutput();
      const requests: Array<{ readonly method?: string; readonly url: string }> = [];
      const program = createProgram({
        ...io,
        fetch: async (url, init) => {
          requests.push({ method: init?.method, url: String(url) });
          return new Response(JSON.stringify({ facts: { name: "Stark (work)" }, preferences: {}, recentTopics: [] }));
        }
      });
      await program.parseAsync(
        ["node", "muse", "--api-url", "http://api.test", "memory", "show"],
        { from: "node" }
      );
      expect(requests[0]?.url).toBe("http://api.test/api/user-memory/stark@work");
      expect(output.join("")).toContain("Stark (work)");

      // Explicit --persona still wins over MUSE_PERSONA env.
      const { io: io2, output: out2 } = captureOutput();
      const requests2: Array<{ readonly url: string }> = [];
      const program2 = createProgram({
        ...io2,
        fetch: async (url) => {
          requests2.push({ url: String(url) });
          return new Response(JSON.stringify({ facts: { name: "Stark (home)" }, preferences: {}, recentTopics: [] }));
        }
      });
      await program2.parseAsync(
        ["node", "muse", "--api-url", "http://api.test", "memory", "show", "--persona", "home"],
        { from: "node" }
      );
      expect(requests2[0]?.url).toBe("http://api.test/api/user-memory/stark@home");
      expect(out2.join("")).toContain("Stark (home)");
    } finally {
      if (prevUser === undefined) delete process.env.MUSE_USER_ID;
      else process.env.MUSE_USER_ID = prevUser;
      if (prevPersona === undefined) delete process.env.MUSE_PERSONA;
      else process.env.MUSE_PERSONA = prevPersona;
    }
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
      const parsed = JSON.parse(output.join("")) as { entries: Array<{ name: string }>; path: string; total: number };
      expect(parsed.path).toBe(target);
      expect(parsed.entries.map((entry) => entry.name)).toEqual(["fs"]);
      expect(parsed.total, "mcp config-show --json must carry `total` (convention parity with goals 552/553/565)").toBe(1);
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

  it("mcp config-add appends a stdio entry to ~/.muse/mcp.json", async () => {
    const { readFile } = await import("node:fs/promises");
    const tmp = await mkdtemp(path.join(tmpdir(), "muse-mcp-add-cli-"));
    const target = path.join(tmp, "mcp.json");

    const previous = process.env.MUSE_MCP_CONFIG;
    process.env.MUSE_MCP_CONFIG = target;
    try {
      const { io, output } = captureOutput();
      const program = createProgram(io);
      await program.parseAsync([
        "node", "muse", "mcp", "config-add", "fs",
        "--command", "npx",
        "--arg", "-y", "--arg", "@modelcontextprotocol/server-filesystem", "--arg", "/tmp",
        "--env", "FOO=bar"
      ], { from: "node" });

      expect(output.join("")).toContain(`added fs (stdio) → ${target}`);
      const written = JSON.parse(await readFile(target, "utf8")) as {
        mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }>;
      };
      expect(written.mcpServers.fs).toMatchObject({
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
        env: { FOO: "bar" }
      });
    } finally {
      if (previous === undefined) {
        delete process.env.MUSE_MCP_CONFIG;
      } else {
        process.env.MUSE_MCP_CONFIG = previous;
      }
    }
  });

  it("mcp config-add appends a streamable URL entry with headers", async () => {
    const { readFile } = await import("node:fs/promises");
    const tmp = await mkdtemp(path.join(tmpdir(), "muse-mcp-add-cli-"));
    const target = path.join(tmp, "mcp.json");

    const previous = process.env.MUSE_MCP_CONFIG;
    process.env.MUSE_MCP_CONFIG = target;
    try {
      const { io, output } = captureOutput();
      const program = createProgram(io);
      await program.parseAsync([
        "node", "muse", "mcp", "config-add", "gh",
        "--url", "https://api.githubcopilot.com/mcp/",
        "--header", "Authorization=Bearer xyz",
        "--header", "X-Trace=abc"
      ], { from: "node" });

      expect(output.join("")).toContain("added gh (streamable)");
      const written = JSON.parse(await readFile(target, "utf8")) as {
        mcpServers: Record<string, { url: string; transport: string; headers: Record<string, string> }>;
      };
      expect(written.mcpServers.gh).toMatchObject({
        url: "https://api.githubcopilot.com/mcp/",
        transport: "streamable",
        headers: { Authorization: "Bearer xyz", "X-Trace": "abc" }
      });
    } finally {
      if (previous === undefined) {
        delete process.env.MUSE_MCP_CONFIG;
      } else {
        process.env.MUSE_MCP_CONFIG = previous;
      }
    }
  });

  it("mcp config-add --dry-run prints merged JSON without writing", async () => {
    const { writeFile, readFile } = await import("node:fs/promises");
    const tmp = await mkdtemp(path.join(tmpdir(), "muse-mcp-add-cli-"));
    const target = path.join(tmp, "mcp.json");
    await writeFile(target, JSON.stringify({ mcpServers: { existing: { command: "node" } } }), "utf8");

    const previous = process.env.MUSE_MCP_CONFIG;
    process.env.MUSE_MCP_CONFIG = target;
    try {
      const { io, output } = captureOutput();
      const program = createProgram(io);
      await program.parseAsync([
        "node", "muse", "mcp", "config-add", "fresh",
        "--command", "node", "--dry-run"
      ], { from: "node" });

      const out = output.join("");
      expect(out).toContain("\"existing\"");
      expect(out).toContain("\"fresh\"");
      // File should still hold only `existing` because of --dry-run.
      const persisted = JSON.parse(await readFile(target, "utf8")) as {
        mcpServers: Record<string, unknown>;
      };
      expect(Object.keys(persisted.mcpServers)).toEqual(["existing"]);
    } finally {
      if (previous === undefined) {
        delete process.env.MUSE_MCP_CONFIG;
      } else {
        process.env.MUSE_MCP_CONFIG = previous;
      }
    }
  });

  it("mcp config-add rejects duplicate names with a non-zero exit", async () => {
    const { writeFile } = await import("node:fs/promises");
    const tmp = await mkdtemp(path.join(tmpdir(), "muse-mcp-add-cli-"));
    const target = path.join(tmp, "mcp.json");
    await writeFile(target, JSON.stringify({ mcpServers: { taken: { command: "node" } } }), "utf8");

    const previous = process.env.MUSE_MCP_CONFIG;
    process.env.MUSE_MCP_CONFIG = target;
    try {
      const { io, output } = captureOutput();
      const program = createProgram(io);
      let exitError: unknown;
      try {
        await program.parseAsync([
          "node", "muse", "mcp", "config-add", "taken", "--command", "echo"
        ], { from: "node" });
      } catch (err) {
        exitError = err;
      }
      expect(output.join("")).toContain("already exists");
      expect(exitError).toBeDefined();
    } finally {
      if (previous === undefined) {
        delete process.env.MUSE_MCP_CONFIG;
      } else {
        process.env.MUSE_MCP_CONFIG = previous;
      }
    }
  });

  it("mcp config-add rejects entries with neither --command nor --url", async () => {
    const tmp = await mkdtemp(path.join(tmpdir(), "muse-mcp-add-cli-"));
    const target = path.join(tmp, "mcp.json");

    const previous = process.env.MUSE_MCP_CONFIG;
    process.env.MUSE_MCP_CONFIG = target;
    try {
      const { io, output } = captureOutput();
      const program = createProgram(io);
      let exitError: unknown;
      try {
        await program.parseAsync([
          "node", "muse", "mcp", "config-add", "incomplete"
        ], { from: "node" });
      } catch (err) {
        exitError = err;
      }
      expect(output.join("")).toMatch(/--command.*--url/);
      expect(exitError).toBeDefined();
    } finally {
      if (previous === undefined) {
        delete process.env.MUSE_MCP_CONFIG;
      } else {
        process.env.MUSE_MCP_CONFIG = previous;
      }
    }
  });

  it("mcp config-add suggests the closest valid value on a --transport typo", async () => {
    const tmp = await mkdtemp(path.join(tmpdir(), "muse-mcp-add-typo-"));
    const target = path.join(tmp, "mcp.json");

    const previous = process.env.MUSE_MCP_CONFIG;
    process.env.MUSE_MCP_CONFIG = target;
    try {
      // `streamble` is one edit from `streamable`. Pre-fix the error
      // listed the valid values but offered no actionable suggestion,
      // asymmetric with --time / --status / --kind / --mode which
      // already carry the closest-command convention.
      const { io: io1, output: out1 } = captureOutput();
      const program1 = createProgram(io1);
      let exitError1: unknown;
      try {
        await program1.parseAsync(
          ["node", "muse", "mcp", "config-add", "x", "--transport", "streamble", "--url", "https://e.test/mcp"],
          { from: "node" }
        );
      } catch (err) {
        exitError1 = err;
      }
      const text1 = out1.join("");
      expect(text1).toContain("--transport must be 'stdio', 'streamable', or 'sse'");
      expect(text1, "typo on streamable must surface the actionable suggestion").toContain("did you mean 'streamable'?");
      expect(exitError1).toBeDefined();

      // `sde` is one edit from `sse`; the suggestion should still fire.
      const { io: io2, output: out2 } = captureOutput();
      const program2 = createProgram(io2);
      try {
        await program2.parseAsync(
          ["node", "muse", "mcp", "config-add", "y", "--transport", "sde", "--url", "https://e.test/mcp"],
          { from: "node" }
        );
      } catch { /* expected */ }
      expect(out2.join("")).toContain("did you mean 'sse'?");

      // Unrelated input gets the listing only, NO false-positive suggestion.
      const { io: io3, output: out3 } = captureOutput();
      const program3 = createProgram(io3);
      try {
        await program3.parseAsync(
          ["node", "muse", "mcp", "config-add", "z", "--transport", "totally-unrelated", "--url", "https://e.test/mcp"],
          { from: "node" }
        );
      } catch { /* expected */ }
      const text3 = out3.join("");
      expect(text3).toContain("--transport must be 'stdio', 'streamable', or 'sse'");
      expect(text3, "unrelated input must NOT pull in a misleading suggestion").not.toContain("did you mean");
    } finally {
      if (previous === undefined) {
        delete process.env.MUSE_MCP_CONFIG;
      } else {
        process.env.MUSE_MCP_CONFIG = previous;
      }
    }
  });

  it("muse listen exits with a clear hint when sox is not installed", async () => {
    const { io, output } = captureOutput();
    const program = new Command();
    program.exitOverride();
    program.configureOutput({ writeOut: io.stdout, writeErr: io.stderr });
    registerListenCommand(program, io, {
      apiRequest: async () => ({}),
      buildVoiceProviders: () => ({
        stt: { describe: () => ({ description: "", displayName: "", id: "stub", local: false, supportedFormats: [] }), id: "stub", transcribe: async () => ({ text: "" }) },
        tts: { describe: () => ({ availableVoices: [], description: "", displayName: "", id: "stub", local: false, supportedFormats: ["mp3"] }), id: "stub", synthesize: async () => ({ audio: new Uint8Array(0), format: "mp3", mimeType: "audio/mp3" }) }
      }),
      shells: {
        playAudio: async () => undefined,
        spawnRec: () => { throw new Error("should not be called"); },
        waitForEnter: async () => undefined,
        which: () => undefined
      }
    });
    let exitError: unknown;
    try {
      await program.parseAsync(["node", "muse", "listen"], { from: "node" });
    } catch (err) {
      exitError = err;
    }
    expect(output.join("")).toContain("sox is not installed");
    expect(exitError).toBeDefined();
  });

  it("muse listen exits with a clear hint when voice providers are not configured", async () => {
    const { io, output } = captureOutput();
    const program = new Command();
    program.exitOverride();
    program.configureOutput({ writeOut: io.stdout, writeErr: io.stderr });
    registerListenCommand(program, io, {
      apiRequest: async () => ({}),
      buildVoiceProviders: () => ({}),
      shells: {
        playAudio: async () => undefined,
        spawnRec: () => { throw new Error("should not be called"); },
        waitForEnter: async () => undefined,
        which: () => "/usr/bin/sox"
      }
    });
    let exitError: unknown;
    try {
      await program.parseAsync(["node", "muse", "listen"], { from: "node" });
    } catch (err) {
      exitError = err;
    }
    expect(output.join("")).toContain("voice providers are not configured");
    expect(exitError).toBeDefined();
  });

  it("muse listen completes the capture → STT → chat → TTS → play round-trip with mocked shells", async () => {
    const { io, output } = captureOutput();
    const program = new Command();
    program.configureOutput({ writeOut: io.stdout, writeErr: io.stderr });

    const apiCalls: Array<{ path: string; body?: Record<string, unknown> }> = [];
    const playedFiles: string[] = [];
    const sttCalls: Array<{ language?: string; bytes: number }> = [];
    const ttsCalls: Array<{ text: string; voice?: string; format?: string }> = [];

    const fakeRec: ListenShells["spawnRec"] = () => {
      const stdout = new Readable();
      stdout._read = (): void => {};
      stdout.push(Buffer.from("RIFFfakefake-WAV-bytes"));
      stdout.push(null);
      const child = new EventEmitter() as EventEmitter & { stdout: Readable; kill: (signal: string) => void };
      child.stdout = stdout;
      child.kill = (): void => {
        process.nextTick(() => child.emit("close", 0));
      };
      return child as ReturnType<ListenShells["spawnRec"]>;
    };

    let enterCount = 0;
    const waitForEnter: ListenShells["waitForEnter"] = async () => {
      enterCount += 1;
    };

    registerListenCommand(program, io, {
      apiRequest: async (_io, _command, path, body) => {
        apiCalls.push({ body, path });
        return { content: "안녕하세요! 도움이 필요하시면 말씀해주세요." };
      },
      buildVoiceProviders: () => ({
        stt: {
          describe: () => ({ description: "", displayName: "Whisper Stub", id: "stub-stt", local: false, supportedFormats: ["audio/wav"] }),
          id: "stub-stt",
          transcribe: async (request) => {
            sttCalls.push({ bytes: request.audio.byteLength, language: request.language });
            return { text: "오늘 날씨 어때?" };
          }
        },
        tts: {
          describe: () => ({ availableVoices: ["alloy"], description: "", displayName: "TTS Stub", id: "stub-tts", local: false, supportedFormats: ["mp3"] }),
          id: "stub-tts",
          synthesize: async (request) => {
            ttsCalls.push({ format: request.format, text: request.text, voice: request.voice });
            return { audio: new Uint8Array([0x49, 0x44, 0x33]), format: "mp3", mimeType: "audio/mp3" };
          }
        }
      }),
      shells: {
        playAudio: async (filePath) => {
          playedFiles.push(filePath);
        },
        spawnRec: fakeRec,
        waitForEnter,
        which: () => "/usr/local/bin/sox"
      }
    });

    await program.parseAsync(["node", "muse", "listen", "--lang", "ko", "--voice", "alloy"], { from: "node" });

    expect(enterCount).toBe(2);
    expect(sttCalls).toHaveLength(1);
    expect(sttCalls[0]?.language).toBe("ko");
    expect(sttCalls[0]?.bytes).toBeGreaterThan(0);
    expect(apiCalls).toEqual([{ body: { message: "오늘 날씨 어때?" }, path: "/api/chat" }]);
    expect(ttsCalls).toHaveLength(1);
    expect(ttsCalls[0]?.text).toContain("안녕하세요");
    expect(ttsCalls[0]?.voice).toBe("alloy");
    expect(playedFiles).toHaveLength(1);
    // synthesizeAndPlay writes the synth output into a mkdtemp dir it
    // cleans up afterward; the basename is its internal detail, the
    // .mp3 extension reflects the requested format.
    expect(playedFiles[0]?.endsWith(".mp3")).toBe(true);
    const out = output.join("");
    expect(out).toContain("You: 오늘 날씨 어때?");
    expect(out).toContain("Muse: 안녕하세요");
  });

  it("tasks --local round-trips add → list → complete → delete on disk without touching the API", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "muse-cli-local-tasks-"));
    const tasksFile = path.join(root, "tasks.json");
    const previous = process.env.MUSE_TASKS_FILE;
    process.env.MUSE_TASKS_FILE = tasksFile;
    try {
      const { io: io1, output: output1 } = captureOutput();
      const program1 = createProgram({
        ...io1,
        fetch: async () => { throw new Error("fetch must not be called in --local mode"); }
      });
      await program1.parseAsync(
        ["node", "muse", "tasks", "add", "Local round-trip", "--due", "2026-12-31T23:59:00Z", "--local", "--json"],
        { from: "node" }
      );
      const created = JSON.parse(output1.join("")) as { id: string; dueAt: string; title: string };
      expect(created.title).toBe("Local round-trip");
      expect(created.dueAt).toBe("2026-12-31T23:59:00.000Z");

      const { io: io2, output: output2 } = captureOutput();
      const program2 = createProgram({ ...io2, fetch: async () => { throw new Error("fetch in --local"); } });
      await program2.parseAsync(["node", "muse", "tasks", "list", "--local", "--json"], { from: "node" });
      const listed = JSON.parse(output2.join("")) as { tasks: Array<{ id: string; title: string }>; total: number };
      expect(listed.total).toBe(1);
      expect(listed.tasks[0]?.id).toBe(created.id);

      const { io: io3 } = captureOutput();
      const program3 = createProgram({ ...io3, fetch: async () => { throw new Error("fetch in --local"); } });
      await program3.parseAsync(["node", "muse", "tasks", "complete", created.id, "--local"], { from: "node" });

      const { io: io4 } = captureOutput();
      const program4 = createProgram({ ...io4, fetch: async () => { throw new Error("fetch in --local"); } });
      await program4.parseAsync(["node", "muse", "tasks", "delete", created.id, "--local"], { from: "node" });

      const { io: io5, output: output5 } = captureOutput();
      const program5 = createProgram({ ...io5, fetch: async () => { throw new Error("fetch in --local"); } });
      await program5.parseAsync(["node", "muse", "tasks", "list", "--status", "all", "--local", "--json"], { from: "node" });
      const after = JSON.parse(output5.join("")) as { total: number };
      expect(after.total).toBe(0);
    } finally {
      if (previous === undefined) {
        delete process.env.MUSE_TASKS_FILE;
      } else {
        process.env.MUSE_TASKS_FILE = previous;
      }
    }
  });

  it("notes --local round-trips save → list → read → search without touching the API", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "muse-cli-local-notes-"));
    const previous = process.env.MUSE_NOTES_DIR;
    process.env.MUSE_NOTES_DIR = root;
    try {
      const { io: io1 } = captureOutput();
      const program1 = createProgram({
        ...io1,
        fetch: async () => { throw new Error("fetch must not be called in --local mode"); }
      });
      await program1.parseAsync(
        ["node", "muse", "notes", "save", "daily/2026-05-10.md", "Hello", "from", "local", "mode", "--local"],
        { from: "node" }
      );

      const { io: io2, output: output2 } = captureOutput();
      const program2 = createProgram({ ...io2, fetch: async () => { throw new Error("fetch in --local"); } });
      await program2.parseAsync(["node", "muse", "notes", "read", "daily/2026-05-10.md", "--local", "--json"], { from: "node" });
      const read = JSON.parse(output2.join("")) as { content: string; path: string };
      expect(read.content).toBe("Hello from local mode");
      expect(read.path).toBe("daily/2026-05-10.md");

      const { io: io3, output: output3 } = captureOutput();
      const program3 = createProgram({ ...io3, fetch: async () => { throw new Error("fetch in --local"); } });
      await program3.parseAsync(["node", "muse", "notes", "search", "local", "mode", "--local", "--json"], { from: "node" });
      const found = JSON.parse(output3.join("")) as { matches: Array<{ path: string; line: number }> };
      expect(found.matches.length).toBeGreaterThan(0);
      expect(found.matches[0]?.path).toBe("daily/2026-05-10.md");
    } finally {
      if (previous === undefined) {
        delete process.env.MUSE_NOTES_DIR;
      } else {
        process.env.MUSE_NOTES_DIR = previous;
      }
    }
  });

  it("muse open <prefix> dispatches to the right store + handles ambiguous + miss", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "muse-cli-open-"));
    const fsp = await import("node:fs/promises");
    const remindersFile = path.join(root, "reminders.json");
    const followupsFile = path.join(root, "followups.json");
    const episodesFile = path.join(root, "episodes.json");

    await fsp.writeFile(remindersFile, JSON.stringify({
      reminders: [{ id: "rem_call_vet", text: "Call vet", dueAt: "2026-05-14T18:00:00Z", status: "pending", createdAt: "2026-05-12T00:00:00Z" }]
    }), "utf8");
    await fsp.writeFile(followupsFile, JSON.stringify({
      followups: [{ id: "fu_send_memo", userId: "stark", scheduledFor: "2026-05-15T09:00:00Z", status: "scheduled", summary: "Send Q3 memo", createdAt: "2026-05-12T00:00:00Z" }]
    }), "utf8");
    await fsp.writeFile(episodesFile, JSON.stringify({
      episodes: [
        { id: "ep_a", userId: "stark", startedAt: "2026-05-12T21:30:00Z", endedAt: "2026-05-12T22:00:00Z", summary: "Reviewed budget" },
        { id: "ep_b", userId: "stark", startedAt: "2026-05-13T21:30:00Z", endedAt: "2026-05-13T22:00:00Z", summary: "Other session" }
      ]
    }), "utf8");

    const prev = {
      reminders: process.env.MUSE_REMINDERS_FILE,
      followups: process.env.MUSE_FOLLOWUPS_FILE,
      episodes: process.env.MUSE_EPISODES_FILE
    };
    process.env.MUSE_REMINDERS_FILE = remindersFile;
    process.env.MUSE_FOLLOWUPS_FILE = followupsFile;
    process.env.MUSE_EPISODES_FILE = episodesFile;
    try {
      // Unique hit: dispatches to followup.
      const { io: io1, output: out1 } = captureOutput();
      const program1 = createProgram({ ...io1, fetch: async () => { throw new Error("no fetch"); } });
      await program1.parseAsync(["node", "muse", "open", "fu_send", "--json"], { from: "node" });
      const r1 = JSON.parse(out1.join("")) as { kind: string; record: { id: string; summary: string } };
      expect(r1.kind).toBe("followup");
      expect(r1.record.summary).toBe("Send Q3 memo");

      // Ambiguous: 'ep_' matches both episodes.
      const { io: io2, output: out2 } = captureOutput();
      const program2 = createProgram({ ...io2, fetch: async () => { throw new Error("no fetch"); } });
      await program2.parseAsync(["node", "muse", "open", "ep_", "--json"], { from: "node" });
      const r2 = JSON.parse(out2.join("")) as { ambiguous: boolean; hits: Array<{ kind: string; id: string }> };
      expect(r2.ambiguous).toBe(true);
      expect(r2.hits.map((h) => h.id).sort()).toEqual(["ep_a", "ep_b"]);

      // Miss: nothing matches.
      const { io: io3, output: out3 } = captureOutput();
      const program3 = createProgram({ ...io3, fetch: async () => { throw new Error("no fetch"); } });
      await program3.parseAsync(["node", "muse", "open", "nonexistent_xyz", "--json"], { from: "node" });
      const r3 = JSON.parse(out3.join("")) as { matches: number };
      expect(r3.matches).toBe(0);

      // Formatted miss output.
      const { io: io4, output: out4 } = captureOutput();
      const program4 = createProgram({ ...io4, fetch: async () => { throw new Error("no fetch"); } });
      await program4.parseAsync(["node", "muse", "open", "nonexistent_xyz"], { from: "node" });
      expect(out4.join("")).toContain("no records found with id prefix");

      // Goal 056 — `--raw` emits only the raw record JSON (no
      // `{ kind, record }` envelope, no formatted header).
      const { io: ioRaw, output: outRaw } = captureOutput();
      const programRaw = createProgram({ ...ioRaw, fetch: async () => { throw new Error("no fetch"); } });
      await programRaw.parseAsync(["node", "muse", "open", "fu_send", "--raw"], { from: "node" });
      const parsedRaw = JSON.parse(outRaw.join("")) as Record<string, unknown>;
      expect(parsedRaw["id"]).toBe("fu_send_memo");
      expect(parsedRaw["summary"]).toBe("Send Q3 memo");
      // No envelope keys.
      expect(parsedRaw["kind"]).toBeUndefined();
      expect(parsedRaw["record"]).toBeUndefined();
    } finally {
      const restore = (k: keyof typeof prev, envKey: string): void => {
        if (prev[k] === undefined) delete process.env[envKey];
        else process.env[envKey] = prev[k];
      };
      restore("reminders", "MUSE_REMINDERS_FILE");
      restore("followups", "MUSE_FOLLOWUPS_FILE");
      restore("episodes", "MUSE_EPISODES_FILE");
    }
  });

  it("muse history merges reminder + proactive + followup + pattern + episode firings, newest first", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "muse-cli-history-"));
    const fsp = await import("node:fs/promises");

    const reminderHistoryFile = path.join(root, "reminder-history.json");
    const proactiveHistoryFile = path.join(root, "proactive-history.json");
    const followupsFile = path.join(root, "followups.json");
    const patternsFiredFile = path.join(root, "patterns-fired.json");
    const episodesFile = path.join(root, "episodes.json");

    // Times: 5 distinct moments, scattered across two days.
    const t1 = "2026-05-12T08:00:00.000Z"; // pattern
    const t2 = "2026-05-12T09:30:00.000Z"; // reminder
    const t3 = "2026-05-12T10:15:00.000Z"; // followup
    const t4 = "2026-05-12T22:00:00.000Z"; // episode (newest of the 12th)
    const t5 = "2026-05-13T07:45:00.000Z"; // proactive (newest of all)
    // One pre-since entry that --since should drop:
    const t0 = "2026-05-10T00:00:00.000Z";

    await fsp.writeFile(reminderHistoryFile, JSON.stringify({
      entries: [
        { reminderId: "rem_old", text: "old reminder", providerId: "telegram", destination: "@me", firedAtIso: t0, status: "delivered" },
        { reminderId: "rem_a", text: "Pick up dry cleaning", providerId: "telegram", destination: "@me", firedAtIso: t2, status: "delivered" }
      ],
      version: 1
    }), "utf8");
    await fsp.writeFile(proactiveHistoryFile, JSON.stringify({
      entries: [
        { kind: "calendar", itemId: "evt_a", startIso: t5, title: "Standup", providerId: "telegram", destination: "@me", text: "Standup in 5 min", firedAtIso: t5, status: "delivered" }
      ],
      version: 1
    }), "utf8");
    await fsp.writeFile(followupsFile, JSON.stringify({
      followups: [
        { id: "fu_a", userId: "stark", scheduledFor: t3, status: "fired", summary: "Send Q3 memo", firedAt: t3, createdAt: t1 },
        { id: "fu_scheduled", userId: "stark", scheduledFor: "2030-01-01T00:00:00Z", status: "scheduled", summary: "Later", createdAt: t1 }
      ]
    }), "utf8");
    await fsp.writeFile(patternsFiredFile, JSON.stringify({
      fired: [
        { patternId: "pat_morning_walk", firedAtMs: Date.parse(t1), suggestion: "morning walk routine" }
      ]
    }), "utf8");
    await fsp.writeFile(episodesFile, JSON.stringify({
      episodes: [
        { id: "ep_a", userId: "stark", startedAt: "2026-05-12T21:30:00Z", endedAt: t4, summary: "Reviewed Q3 budget memo" }
      ]
    }), "utf8");

    const prev = {
      reminderHistory: process.env.MUSE_REMINDER_HISTORY_FILE,
      proactiveHistory: process.env.MUSE_PROACTIVE_HISTORY_FILE,
      followups: process.env.MUSE_FOLLOWUPS_FILE,
      patternsFired: process.env.MUSE_PATTERNS_FIRED_FILE,
      episodes: process.env.MUSE_EPISODES_FILE
    };
    process.env.MUSE_REMINDER_HISTORY_FILE = reminderHistoryFile;
    process.env.MUSE_PROACTIVE_HISTORY_FILE = proactiveHistoryFile;
    process.env.MUSE_FOLLOWUPS_FILE = followupsFile;
    process.env.MUSE_PATTERNS_FIRED_FILE = patternsFiredFile;
    process.env.MUSE_EPISODES_FILE = episodesFile;
    try {
      // No filters — all five sources show up; scheduled followup is
      // excluded (only fired ones), and t0 reminder is included since
      // no --since gate.
      const { io: io1, output: out1 } = captureOutput();
      const program1 = createProgram({ ...io1, fetch: async () => { throw new Error("no fetch"); } });
      await program1.parseAsync(["node", "muse", "history", "--json"], { from: "node" });
      const r1 = JSON.parse(out1.join("")) as { entries: Array<{ kind: string; whenIso: string; id?: string }>; total: number };
      // Newest first: proactive(t5) → episode(t4) → followup(t3) → reminder(t2) → pattern(t1) → reminder-old(t0).
      expect(r1.entries.map((e) => `${e.kind}:${e.id ?? ""}`)).toEqual([
        "proactive:evt_a",
        "episode:ep_a",
        "followup:fu_a",
        "reminder:rem_a",
        "pattern:pat_morning_walk",
        "reminder:rem_old"
      ]);

      // --kind filter narrows to one source.
      const { io: io2, output: out2 } = captureOutput();
      const program2 = createProgram({ ...io2, fetch: async () => { throw new Error("no fetch"); } });
      await program2.parseAsync(["node", "muse", "history", "--kind", "followup", "--json"], { from: "node" });
      const r2 = JSON.parse(out2.join("")) as { entries: Array<{ kind: string; id?: string }> };
      expect(r2.entries.map((e) => e.id)).toEqual(["fu_a"]);

      // --since gates out the t0 reminder.
      const { io: io3, output: out3 } = captureOutput();
      const program3 = createProgram({ ...io3, fetch: async () => { throw new Error("no fetch"); } });
      await program3.parseAsync(["node", "muse", "history", "--since", "2026-05-12T00:00:00Z", "--json"], { from: "node" });
      const r3 = JSON.parse(out3.join("")) as { entries: Array<{ id?: string }> };
      expect(r3.entries.map((e) => e.id)).not.toContain("rem_old");
      expect(r3.entries).toHaveLength(5);

      // Formatted output renders the header + each entry.
      const { io: io4, output: out4 } = captureOutput();
      const program4 = createProgram({ ...io4, fetch: async () => { throw new Error("no fetch"); } });
      await program4.parseAsync(["node", "muse", "history", "--limit", "5"], { from: "node" });
      const text = out4.join("");
      expect(text).toContain("Activity (5 entries, newest first):");
      expect(text).toContain("Standup in 5 min");
      expect(text).toContain("Send Q3 memo");

      // --kind validates input.
      const { io: io5 } = captureOutput();
      const program5 = createProgram({ ...io5, fetch: async () => { throw new Error("no fetch"); } });
      program5.exitOverride();
      await expect(program5.parseAsync(["node", "muse", "history", "--kind", "bogus", "--json"], { from: "node" }))
        .rejects.toThrow(/--kind must be one of/u);

      // Goal 124 — typo on --kind suggests the closest valid kind.
      const { io: io6 } = captureOutput();
      const program6 = createProgram({ ...io6, fetch: async () => { throw new Error("no fetch"); } });
      program6.exitOverride();
      await expect(program6.parseAsync(["node", "muse", "history", "--kind", "followups", "--json"], { from: "node" }))
        .rejects.toThrow(/did you mean 'followup'\?/u);
      // Unrelated input — error fires, no false-positive suggestion.
      const { io: io7 } = captureOutput();
      const program7 = createProgram({ ...io7, fetch: async () => { throw new Error("no fetch"); } });
      program7.exitOverride();
      await expect(program7.parseAsync(["node", "muse", "history", "--kind", "zzz", "--json"], { from: "node" }))
        .rejects.toThrow(/must be one of/u);
      const { io: io8 } = captureOutput();
      const program8 = createProgram({ ...io8, fetch: async () => { throw new Error("no fetch"); } });
      program8.exitOverride();
      await expect(program8.parseAsync(["node", "muse", "history", "--kind", "zzz", "--json"], { from: "node" }))
        .rejects.not.toThrow(/did you mean/u);
    } finally {
      const restore = (k: keyof typeof prev, envKey: string): void => {
        if (prev[k] === undefined) delete process.env[envKey];
        else process.env[envKey] = prev[k];
      };
      restore("reminderHistory", "MUSE_REMINDER_HISTORY_FILE");
      restore("proactiveHistory", "MUSE_PROACTIVE_HISTORY_FILE");
      restore("followups", "MUSE_FOLLOWUPS_FILE");
      restore("patternsFired", "MUSE_PATTERNS_FIRED_FILE");
      restore("episodes", "MUSE_EPISODES_FILE");
    }
  });

  it("today --local surfaces scheduled followups due within the horizon", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "muse-cli-today-followups-"));
    const fsp = await import("node:fs/promises");
    const followupsFile = path.join(root, "followups.json");
    const past = new Date(Date.now() - 60 * 60_000).toISOString();
    const soon = new Date(Date.now() + 30 * 60_000).toISOString();
    const farFuture = new Date(Date.now() + 7 * 24 * 60 * 60_000).toISOString();
    await fsp.writeFile(followupsFile, JSON.stringify({
      followups: [
        { id: "fu_overdue", userId: "stark", scheduledFor: past, status: "scheduled", summary: "Send Q3 memo", createdAt: "2026-05-10T00:00:00Z" },
        { id: "fu_soon", userId: "stark", scheduledFor: soon, status: "scheduled", summary: "Call vet", createdAt: "2026-05-12T00:00:00Z" },
        { id: "fu_far", userId: "stark", scheduledFor: farFuture, status: "scheduled", summary: "Pay quarterly tax", createdAt: "2026-05-12T01:00:00Z" }
      ]
    }), "utf8");
    const prev = process.env.MUSE_FOLLOWUPS_FILE;
    process.env.MUSE_FOLLOWUPS_FILE = followupsFile;
    try {
      // JSON path: followups field has the in-horizon scheduled rows.
      const { io: io1, output: out1 } = captureOutput();
      const program1 = createProgram({ ...io1, fetch: async () => { throw new Error("local"); } });
      await program1.parseAsync(["node", "muse", "today", "--local", "--json"], { from: "node" });
      const briefing = JSON.parse(out1.join("")) as { followups: Array<{ id: string; summary: string; scheduledFor: string }> };
      expect(briefing.followups.map((row) => row.id)).toEqual(["fu_overdue", "fu_soon"]);

      // Formatted path: "Followups (2):" banner + the overdue marker on the past entry.
      const { io: io2, output: out2 } = captureOutput();
      const program2 = createProgram({ ...io2, fetch: async () => { throw new Error("local"); } });
      await program2.parseAsync(["node", "muse", "today", "--local"], { from: "node" });
      const text = out2.join("");
      expect(text).toContain("Followups (2):");
      expect(text).toContain("Send Q3 memo (overdue)");
      expect(text).toContain("Call vet");
    } finally {
      if (prev === undefined) delete process.env.MUSE_FOLLOWUPS_FILE;
      else process.env.MUSE_FOLLOWUPS_FILE = prev;
    }
  });

  it("today --local lists open tasks due-soonest first, not newest-created (goal 255)", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "muse-cli-today-taskorder-"));
    const fsp = await import("node:fs/promises");
    const tasksFile = path.join(root, "tasks.json");
    const soon = new Date(Date.now() + 2 * 60 * 60_000).toISOString();
    const far = new Date(Date.now() + 30 * 24 * 60 * 60_000).toISOString();
    await fsp.writeFile(tasksFile, JSON.stringify({
      tasks: [
        // Imminent deadline, but created long ago — the case the
        // createdAt-desc sort buried under recent captures.
        { id: "t_soon", title: "Ship release", status: "open", dueAt: soon, createdAt: "2026-04-01T00:00:00Z" },
        { id: "t_far", title: "Quarterly review", status: "open", dueAt: far, createdAt: "2026-05-15T00:00:00Z" },
        { id: "t_new_undated", title: "Quick capture", status: "open", createdAt: "2026-05-16T09:00:00Z" },
        { id: "t_old_undated", title: "Stale idea", status: "open", createdAt: "2026-03-01T00:00:00Z" },
        { id: "t_done", title: "Already done", status: "done", createdAt: "2026-05-16T10:00:00Z" }
      ]
    }), "utf8");
    const saved = {
      tasks: process.env.MUSE_TASKS_FILE,
      reminders: process.env.MUSE_REMINDERS_FILE,
      followups: process.env.MUSE_FOLLOWUPS_FILE,
      calendar: process.env.MUSE_CALENDAR_FILE,
      notes: process.env.MUSE_NOTES_DIR
    };
    process.env.MUSE_TASKS_FILE = tasksFile;
    process.env.MUSE_REMINDERS_FILE = path.join(root, "no-reminders.json");
    process.env.MUSE_FOLLOWUPS_FILE = path.join(root, "no-followups.json");
    process.env.MUSE_CALENDAR_FILE = path.join(root, "no-calendar.json");
    process.env.MUSE_NOTES_DIR = path.join(root, "no-notes");
    try {
      const { io, output } = captureOutput();
      const program = createProgram({ ...io, fetch: async () => { throw new Error("local"); } });
      await program.parseAsync(["node", "muse", "today", "--local", "--json"], { from: "node" });
      const briefing = JSON.parse(output.join("")) as { tasks: Array<{ id: string; title: string }> };
      // Dated soonest→latest first, then undated newest→oldest;
      // done task excluded. Pre-fix this was t_new_undated first.
      expect(briefing.tasks.map((t) => t.id))
        .toEqual(["t_soon", "t_far", "t_new_undated", "t_old_undated"]);
    } finally {
      for (const [k, v] of [
        ["MUSE_TASKS_FILE", saved.tasks], ["MUSE_REMINDERS_FILE", saved.reminders],
        ["MUSE_FOLLOWUPS_FILE", saved.followups], ["MUSE_CALENDAR_FILE", saved.calendar],
        ["MUSE_NOTES_DIR", saved.notes]
      ] as const) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
      }
    }
  });

  it("today --local on a fresh install surfaces empty-state onboarding hints", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "muse-cli-today-empty-"));
    const prevTasks = process.env.MUSE_TASKS_FILE;
    const prevNotes = process.env.MUSE_NOTES_DIR;
    const prevReminders = process.env.MUSE_REMINDERS_FILE;
    const prevFollowups = process.env.MUSE_FOLLOWUPS_FILE;
    process.env.MUSE_TASKS_FILE = path.join(root, "tasks.json");
    process.env.MUSE_NOTES_DIR = path.join(root, "notes");
    process.env.MUSE_REMINDERS_FILE = path.join(root, "reminders.json");
    process.env.MUSE_FOLLOWUPS_FILE = path.join(root, "followups.json");
    try {
      const { io, output } = captureOutput();
      const program = createProgram({ ...io, fetch: async () => { throw new Error("fetch in --local"); } });
      await program.parseAsync(["node", "muse", "today", "--local"], { from: "node" });
      const text = output.join("");
      expect(text).toContain("Looks like a fresh start.");
      expect(text).toContain("muse tasks add");
      expect(text).toContain("muse remind add");
      expect(text).toContain("muse notes save");
      expect(text).toContain("muse remember");
    } finally {
      if (prevTasks === undefined) delete process.env.MUSE_TASKS_FILE; else process.env.MUSE_TASKS_FILE = prevTasks;
      if (prevNotes === undefined) delete process.env.MUSE_NOTES_DIR; else process.env.MUSE_NOTES_DIR = prevNotes;
      if (prevReminders === undefined) delete process.env.MUSE_REMINDERS_FILE; else process.env.MUSE_REMINDERS_FILE = prevReminders;
      if (prevFollowups === undefined) delete process.env.MUSE_FOLLOWUPS_FILE; else process.env.MUSE_FOLLOWUPS_FILE = prevFollowups;
    }
  });

  it("today --local hides empty-state hints once any section has content", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "muse-cli-today-empty-suppress-"));
    const tasksFile = path.join(root, "tasks.json");
    const prev = process.env.MUSE_TASKS_FILE;
    process.env.MUSE_TASKS_FILE = tasksFile;
    try {
      // Seed one task — empty-state hints should NOT appear.
      const seedIo = captureOutput();
      const seed = createProgram({ ...seedIo.io, fetch: async () => { throw new Error("local"); } });
      await seed.parseAsync(["node", "muse", "tasks", "add", "Send memo", "--due", "in 2 hours", "--local"], { from: "node" });

      const { io, output } = captureOutput();
      const program = createProgram({ ...io, fetch: async () => { throw new Error("local"); } });
      await program.parseAsync(["node", "muse", "today", "--local"], { from: "node" });
      const text = output.join("");
      expect(text).toContain("Send memo");
      expect(text).not.toContain("Looks like a fresh start");
    } finally {
      if (prev === undefined) delete process.env.MUSE_TASKS_FILE; else process.env.MUSE_TASKS_FILE = prev;
    }
  });

  it("today --local composes tasks + recent notes without touching the API", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "muse-cli-local-today-"));
    const tasksFile = path.join(root, "tasks.json");
    const notesDir = path.join(root, "notes");
    const prevTasks = process.env.MUSE_TASKS_FILE;
    const prevNotes = process.env.MUSE_NOTES_DIR;
    process.env.MUSE_TASKS_FILE = tasksFile;
    process.env.MUSE_NOTES_DIR = notesDir;
    try {
      const { io: io1 } = captureOutput();
      const seed = createProgram({ ...io1, fetch: async () => { throw new Error("fetch in --local"); } });
      await seed.parseAsync(["node", "muse", "tasks", "add", "Pick", "up", "milk", "--due", "in 2 hours", "--local"], { from: "node" });
      await seed.parseAsync(
        ["node", "muse", "notes", "save", "weekly/plan.md", "milestones", "for", "next", "week", "--local"],
        { from: "node" }
      );

      const { io: io2, output: output2 } = captureOutput();
      const program = createProgram({ ...io2, fetch: async () => { throw new Error("fetch in --local"); } });
      await program.parseAsync(["node", "muse", "today", "--local"], { from: "node" });
      const text = output2.join("");
      expect(text).toContain("Today");
      expect(text).toContain(", local)");
      expect(text).toContain("Pick up milk");
      expect(text).toContain("weekly/plan.md");
    } finally {
      if (prevTasks === undefined) { delete process.env.MUSE_TASKS_FILE; } else { process.env.MUSE_TASKS_FILE = prevTasks; }
      if (prevNotes === undefined) { delete process.env.MUSE_NOTES_DIR; } else { process.env.MUSE_NOTES_DIR = prevNotes; }
    }
  });

  it("tasks list defaults to a human-readable list and --json opts back into raw", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "muse-cli-tasks-human-"));
    const prev = process.env.MUSE_TASKS_FILE;
    process.env.MUSE_TASKS_FILE = path.join(root, "tasks.json");
    try {
      const seedIo = captureOutput();
      const seed = createProgram({ ...seedIo.io, fetch: async () => { throw new Error("local"); } });
      await seed.parseAsync(
        ["node", "muse", "tasks", "add", "Buy milk", "--tags", "shopping,today", "--due", "2026-12-31T23:59:00Z", "--local"],
        { from: "node" }
      );
      const addedText = seedIo.output.join("");
      expect(addedText).toMatch(/^Added \[task_/u);
      expect(addedText).toContain("Buy milk");
      expect(addedText).toContain(`due ${formatLocalDateTime("2026-12-31T23:59:00Z")}`);

      const { io, output } = captureOutput();
      const program = createProgram({ ...io, fetch: async () => { throw new Error("local"); } });
      await program.parseAsync(["node", "muse", "tasks", "list", "--local"], { from: "node" });
      const listed = output.join("");
      expect(listed).toMatch(/^Tasks \(1 open\):/u);
      expect(listed).toContain("Buy milk");
      expect(listed).toContain("#shopping #today");

      const { io: io2, output: output2 } = captureOutput();
      const program2 = createProgram({ ...io2, fetch: async () => { throw new Error("local"); } });
      await program2.parseAsync(["node", "muse", "tasks", "list", "--local", "--json"], { from: "node" });
      const parsed = JSON.parse(output2.join("")) as { tasks: unknown[]; total: number };
      expect(parsed.total).toBe(1);
      expect(Array.isArray(parsed.tasks)).toBe(true);
    } finally {
      if (prev === undefined) { delete process.env.MUSE_TASKS_FILE; } else { process.env.MUSE_TASKS_FILE = prev; }
    }
  });

  it("tasks edit --local patches title/tags/due and supports clear-out via --due none", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "muse-cli-tasks-edit-"));
    const prev = process.env.MUSE_TASKS_FILE;
    process.env.MUSE_TASKS_FILE = path.join(root, "tasks.json");
    try {
      const seedIo = captureOutput();
      const seed = createProgram({ ...seedIo.io, fetch: async () => { throw new Error("local"); } });
      await seed.parseAsync(
        ["node", "muse", "tasks", "add", "First draft", "--due", "2026-12-31T23:59:00Z", "--local", "--json"],
        { from: "node" }
      );
      const added = JSON.parse(seedIo.output.join("")) as { id: string };

      const { io: io2, output: out2 } = captureOutput();
      const program = createProgram({ ...io2, fetch: async () => { throw new Error("local"); } });
      await program.parseAsync(
        ["node", "muse", "tasks", "edit", added.id, "--title", "Final draft", "--tags", "work,muse", "--local"],
        { from: "node" }
      );
      expect(out2.join("")).toContain("Updated");
      expect(out2.join("")).toContain("Final draft");

      const { io: io3, output: out3 } = captureOutput();
      const program3 = createProgram({ ...io3, fetch: async () => { throw new Error("local"); } });
      await program3.parseAsync(
        ["node", "muse", "tasks", "list", "--local", "--json"],
        { from: "node" }
      );
      const listed = JSON.parse(out3.join("")) as { tasks: { id: string; title: string; tags?: string[]; dueAt?: string }[] };
      expect(listed.tasks[0]?.title).toBe("Final draft");
      expect(listed.tasks[0]?.tags).toEqual(["work", "muse"]);

      const { io: io4 } = captureOutput();
      const program4 = createProgram({ ...io4, fetch: async () => { throw new Error("local"); } });
      await program4.parseAsync(
        ["node", "muse", "tasks", "edit", added.id, "--due", "none", "--local"],
        { from: "node" }
      );

      const { io: io5, output: out5 } = captureOutput();
      const program5 = createProgram({ ...io5, fetch: async () => { throw new Error("local"); } });
      await program5.parseAsync(["node", "muse", "tasks", "list", "--local", "--json"], { from: "node" });
      const cleared = JSON.parse(out5.join("")) as { tasks: { dueAt?: string }[] };
      expect(cleared.tasks[0]?.dueAt).toBeUndefined();
    } finally {
      if (prev === undefined) { delete process.env.MUSE_TASKS_FILE; } else { process.env.MUSE_TASKS_FILE = prev; }
    }
  });

  it("agent-notices tail consumes the SSE stream and renders notice events", async () => {
    const { io, output } = captureOutput();
    const requests: Array<{ readonly url: string }> = [];
    const sseBody = [
      `event: open\ndata: ${JSON.stringify({ userId: "stark" })}\n\n`,
      `event: notice\ndata: ${JSON.stringify({
        generatedAt: "2026-05-13T14:55:00Z",
        kind: "calendar",
        sourceId: "evt-1",
        text: "Standup in 5 — want the agenda?"
      })}\n\n`
    ].join("");
    const program = createProgram({
      ...io,
      fetch: async (url) => {
        requests.push({ url: String(url) });
        return new Response(sseBody, {
          headers: { "content-type": "text/event-stream" }
        });
      }
    });

    const prevUser = process.env.MUSE_USER_ID;
    process.env.MUSE_USER_ID = "stark";
    try {
      await program.parseAsync(
        ["node", "muse", "--api-url", "http://api.test", "agent-notices", "tail"],
        { from: "node" }
      );
      expect(requests).toHaveLength(1);
      expect(requests[0]?.url).toBe("http://api.test/api/agent-notices/stream?userId=stark");
      const combined = output.join("");
      expect(combined).toContain("(listening for agent-notices on user 'stark'");
      // Stamp renders in the local zone (helper-derived so the assertion
      // is tz-agnostic — the producer's "14:55Z" is shown as local time).
      expect(combined).toContain(`[${formatNoticeStamp("2026-05-13T14:55:00Z")}]`);
      expect(combined).toContain("[calendar]");
      expect(combined).toContain("Standup in 5 — want the agenda?");
    } finally {
      if (prevUser === undefined) { delete process.env.MUSE_USER_ID; } else { process.env.MUSE_USER_ID = prevUser; }
    }
  });

  it("agent-notices tail --json emits the raw payload line-by-line", async () => {
    const { io, output } = captureOutput();
    const sseBody = `event: open\ndata: {}\n\nevent: notice\ndata: {"kind":"task","text":"file taxes","generatedAt":"2026-05-13T22:00:00Z"}\n\n`;
    const program = createProgram({
      ...io,
      fetch: async () => new Response(sseBody, { headers: { "content-type": "text/event-stream" } })
    });
    const prevUser = process.env.MUSE_USER_ID;
    process.env.MUSE_USER_ID = "stark";
    try {
      await program.parseAsync(
        ["node", "muse", "--api-url", "http://api.test", "agent-notices", "tail", "--json"],
        { from: "node" }
      );
      const combined = output.join("");
      expect(combined).not.toContain("(listening for agent-notices");
      expect(combined).toContain(`{"kind":"task","text":"file taxes"`);
    } finally {
      if (prevUser === undefined) { delete process.env.MUSE_USER_ID; } else { process.env.MUSE_USER_ID = prevUser; }
    }
  });

  it("notes read prints the file content directly by default and --json restores the envelope", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "muse-cli-notes-human-"));
    const prev = process.env.MUSE_NOTES_DIR;
    process.env.MUSE_NOTES_DIR = root;
    try {
      const { io: ioSave } = captureOutput();
      const seed = createProgram({ ...ioSave, fetch: async () => { throw new Error("local"); } });
      await seed.parseAsync(
        ["node", "muse", "notes", "save", "hello.md", "first line", "--local"],
        { from: "node" }
      );

      const { io: ioRead, output: outRead } = captureOutput();
      const program = createProgram({ ...ioRead, fetch: async () => { throw new Error("local"); } });
      await program.parseAsync(["node", "muse", "notes", "read", "hello.md", "--local"], { from: "node" });
      const printed = outRead.join("");
      expect(printed.trimEnd()).toBe("first line");

      const { io: ioJson, output: outJson } = captureOutput();
      const program2 = createProgram({ ...ioJson, fetch: async () => { throw new Error("local"); } });
      await program2.parseAsync(["node", "muse", "notes", "read", "hello.md", "--local", "--json"], { from: "node" });
      const envelope = JSON.parse(outJson.join("")) as { content: string; path: string };
      expect(envelope.path).toBe("hello.md");
      expect(envelope.content).toBe("first line");
    } finally {
      if (prev === undefined) { delete process.env.MUSE_NOTES_DIR; } else { process.env.MUSE_NOTES_DIR = prev; }
    }
  });

  it("calendar events --local reads the local calendar file directly without the API", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "muse-cli-cal-local-"));
    const calendarFile = path.join(root, "calendar.json");
    await (await import("node:fs/promises")).writeFile(calendarFile, JSON.stringify({
      events: [
        {
          id: "evt-1",
          title: "Standup",
          startsAt: "2026-05-10T09:00:00.000Z",
          endsAt: "2026-05-10T09:30:00.000Z",
          allDay: false
        }
      ]
    }), "utf8");
    const prev = process.env.MUSE_CALENDAR_FILE;
    process.env.MUSE_CALENDAR_FILE = calendarFile;
    try {
      const { io, output } = captureOutput();
      const program = createProgram({ ...io, fetch: async () => { throw new Error("fetch must not be called in --local"); } });
      await program.parseAsync(
        ["node", "muse", "calendar", "events", "--local", "--from", "2026-05-09T00:00:00Z", "--to", "2026-05-12T00:00:00Z", "--json"],
        { from: "node" }
      );
      const result = JSON.parse(output.join("")) as { events: Array<{ id: string; title: string; startsAtIso: string }>; total: number };
      expect(result.total).toBe(1);
      expect(result.events[0]?.title).toBe("Standup");
      expect(result.events[0]?.startsAtIso).toBe("2026-05-10T09:00:00.000Z");
    } finally {
      if (prev === undefined) { delete process.env.MUSE_CALENDAR_FILE; } else { process.env.MUSE_CALENDAR_FILE = prev; }
    }
  });

  it("today --brief --speak pipes the prose through the injected TTS provider and player", async () => {
    const ttsCalls: Array<{ text: string; voice?: string; format?: string }> = [];
    const playedFiles: string[] = [];
    const { io, output } = captureOutput();
    const fakeTts = {
      describe: () => ({ id: "fake", local: false }),
      synthesize: async (request: { text: string; voice?: string; format?: string }) => {
        ttsCalls.push({ format: request.format, text: request.text, voice: request.voice });
        return { audio: new Uint8Array([1, 2, 3]), format: request.format ?? "mp3" };
      }
    };
    const program = createProgram({
      ...io,
      fetch: async (url) => {
        const path = String(url);
        if (path.endsWith("/api/today")) {
          return new Response(JSON.stringify({
            generatedAt: "2026-05-10T08:00:00Z",
            lookaheadHours: 24,
            tasks: [{ id: "t-1", title: "Stand-up at 10" }],
            events: [],
            notes: []
          }));
        }
        if (path.endsWith("/api/chat")) {
          return new Response(JSON.stringify({ content: "Stand-up is at 10. Nothing else on the calendar." }));
        }
        return new Response("{}");
      },
      todayShells: {
        speaker: { playAudio: async (filePath: string) => { playedFiles.push(filePath); } },
        tts: fakeTts as unknown as Parameters<NonNullable<typeof program.parseAsync>>[0] extends infer _ ? never : never
      } as unknown as Record<string, unknown>
    } as unknown as Parameters<typeof createProgram>[0]);
    await program.parseAsync(
      ["node", "muse", "--api-url", "http://api.test", "today", "--brief", "--speak", "--audio-voice", "alloy"],
      { from: "node" }
    );
    expect(output.join("")).toContain("Stand-up is at 10");
    expect(ttsCalls).toHaveLength(1);
    expect(ttsCalls[0]?.text).toContain("Stand-up is at 10");
    expect(ttsCalls[0]?.voice).toBe("alloy");
    expect(playedFiles).toHaveLength(1);
    expect(playedFiles[0]?.endsWith(".mp3")).toBe(true);
  });

  it("today --brief sends the structured briefing to /api/chat and prints the prose response", async () => {
    const seenBodies: string[] = [];
    const { io, output } = captureOutput();
    const program = createProgram({
      ...io,
      fetch: async (url, init) => {
        const path = String(url);
        if (path.endsWith("/api/today")) {
          return new Response(JSON.stringify({
            generatedAt: "2026-05-10T08:00:00Z",
            lookaheadHours: 24,
            tasks: [{ id: "t-1", title: "Buy milk" }],
            events: [],
            notes: []
          }));
        }
        if (path.endsWith("/api/chat")) {
          if (typeof init?.body === "string") {
            seenBodies.push(init.body);
          }
          return new Response(JSON.stringify({
            content: "You have 1 open task: Buy milk. No events on the calendar today.",
            success: true
          }));
        }
        return new Response("{}");
      }
    });
    await program.parseAsync(
      ["node", "muse", "--api-url", "http://api.test", "today", "--brief"],
      { from: "node" }
    );
    expect(seenBodies).toHaveLength(1);
    const sent = JSON.parse(seenBodies[0]!) as { message: string };
    expect(sent.message).toContain("morning brief");
    expect(sent.message).toContain('"Buy milk"');
    expect(output.join("")).toContain("You have 1 open task: Buy milk.");
  });

  it("today --brief applies the active persona as systemPrompt (goal 170)", async () => {
    const workspaceDir = await mkdtemp(path.join(tmpdir(), "muse-cli-today-persona-"));
    const personaFile = path.join(workspaceDir, "persona.json");
    await writeFile(personaFile, JSON.stringify({ version: 1, activeId: "jarvis", custom: {} }), "utf8");
    const prevPersonaEnv = process.env.MUSE_PERSONA_FILE;
    process.env.MUSE_PERSONA_FILE = personaFile;
    const seenBodies: string[] = [];
    try {
      const { io } = captureOutput();
      const program = createProgram({
        ...io,
        fetch: async (url, init) => {
          const path2 = String(url);
          if (path2.endsWith("/api/today")) {
            return new Response(JSON.stringify({
              generatedAt: "2026-05-10T08:00:00Z", lookaheadHours: 24,
              tasks: [{ id: "t-1", title: "Buy milk" }], events: [], notes: []
            }));
          }
          if (path2.endsWith("/api/chat")) {
            if (typeof init?.body === "string") seenBodies.push(init.body);
            return new Response(JSON.stringify({ content: "Brief, sir.", success: true }));
          }
          return new Response("{}");
        }
      });
      await program.parseAsync(
        ["node", "muse", "--api-url", "http://api.test", "today", "--brief"],
        { from: "node" }
      );
    } finally {
      if (prevPersonaEnv === undefined) delete process.env.MUSE_PERSONA_FILE;
      else process.env.MUSE_PERSONA_FILE = prevPersonaEnv;
    }
    expect(seenBodies).toHaveLength(1);
    const sent = JSON.parse(seenBodies[0]!) as { systemPrompt?: string };
    expect(sent.systemPrompt).toContain("Speak as JARVIS");
  });

  it("today --brief --save-to-notes scrubs credential shapes before notes write (goal 112)", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "muse-today-redact-"));
    const fsp = await import("node:fs/promises");
    const prevNotes = process.env.MUSE_NOTES_DIR;
    process.env.MUSE_NOTES_DIR = root;
    try {
      const { io } = captureOutput();
      const program = createProgram({
        ...io,
        fetch: async (url) => {
          const p = String(url);
          if (p.endsWith("/api/today")) {
            return new Response(JSON.stringify({
              generatedAt: "2026-05-10T08:00:00Z",
              lookaheadHours: 24,
              tasks: [{ id: "t-1", title: "Buy milk" }],
              events: [],
              notes: []
            }));
          }
          if (p.endsWith("/api/chat")) {
            // The LLM brief hallucinates a credential shape into the
            // prose body — exactly the case the redaction has to catch.
            return new Response(JSON.stringify({
              content: "Reminder: rotate sk-proj-abcdefghijklmnopqrstuvwxyz today. Old ghp_abcdefghijklmnopqrstuvwxyzABCDEF too.",
              success: true
            }));
          }
          return new Response("{}");
        }
      });

      await program.parseAsync(
        ["node", "muse", "--api-url", "http://api.test", "today", "--brief", "--save-to-notes", "journal/today.md"],
        { from: "node" }
      );

      const saved = await fsp.readFile(path.join(root, "journal", "today.md"), "utf8");
      // Verbatim secrets MUST NOT survive to the saved note (the file
      // is long-lived and may sync to a third-party note store).
      expect(saved).not.toContain("sk-proj-abcdefghijklmnopqrstuvwxyz");
      expect(saved).not.toContain("ghp_abcdefghijklmnopqrstuvwxyzABCDEF");
      // Redaction markers DO survive so the context (the user mentioned
      // a key) is preserved.
      expect(saved).toContain("[redacted-openai-key]");
      expect(saved).toContain("[redacted-github-pat]");
      // Non-credential prose passes through untouched.
      expect(saved).toContain("Reminder: rotate");
      expect(saved).toContain("today");
      // The note still has the standard heading the goal-054 save
      // path writes.
      expect(saved).toContain("# Today brief —");
    } finally {
      if (prevNotes === undefined) delete process.env.MUSE_NOTES_DIR;
      else process.env.MUSE_NOTES_DIR = prevNotes;
    }
  });

  it("today --save-to-notes requires --brief (goal 054)", async () => {
    const { io, output } = captureOutput();
    const program = createProgram({ ...io, fetch: async () => { throw new Error("not reached"); } });
    let threw: Error | undefined;
    try {
      await program.parseAsync(
        ["node", "muse", "--api-url", "http://api.test", "today", "--save-to-notes", "journal/today.md"],
        { from: "node" }
      );
    } catch (cause) {
      threw = cause as Error;
    }
    expect(threw?.message).toMatch(/--save-to-notes requires --brief/);
    expect(output.join("")).not.toContain("brief saved");
  });

  it("messaging providers/send round-trip: --local routes through the in-process registry without the API", async () => {
    const prevTg = process.env.MUSE_TELEGRAM_BOT_TOKEN;
    process.env.MUSE_TELEGRAM_BOT_TOKEN = "fake-token";
    try {
      const seenUrls: string[] = [];
      // Patch global fetch for this test only — buildMessagingRegistry's
      // TelegramProvider uses the global. Restore in finally.
      const originalFetch = globalThis.fetch;
      globalThis.fetch = (async (url: string | URL | Request) => {
        seenUrls.push(String(url));
        return new Response(JSON.stringify({ ok: true, result: { message_id: 11 } }), { status: 200 });
      }) as typeof fetch;
      try {
        const { io: io1, output: output1 } = captureOutput();
        const program1 = createProgram({ ...io1, fetch: async () => { throw new Error("api fetch must not be called"); } });
        await program1.parseAsync(["node", "muse", "messaging", "providers", "--local"], { from: "node" });
        expect(output1.join("")).toContain("Telegram");

        const { io: io2, output: output2 } = captureOutput();
        const program2 = createProgram({ ...io2, fetch: async () => { throw new Error("api fetch must not be called"); } });
        await program2.parseAsync(
          ["node", "muse", "messaging", "send", "telegram", "@me", "hello", "world", "--local"],
          { from: "node" }
        );
        const text = output2.join("");
        expect(text).toContain("Sent telegram → @me");
        expect(text).toContain("id 11");
        expect(seenUrls).toHaveLength(1);
        expect(seenUrls[0]).toContain("/botfake-token/sendMessage");
      } finally {
        globalThis.fetch = originalFetch;
      }
    } finally {
      if (prevTg === undefined) { delete process.env.MUSE_TELEGRAM_BOT_TOKEN; } else { process.env.MUSE_TELEGRAM_BOT_TOKEN = prevTg; }
    }
  });

  it("setup (default) prints a status summary covering model, mcp, calendar, notes, tasks, voice", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "muse-cli-setup-status-"));
    const tasksFile = path.join(root, "tasks.json");
    const notesDir = path.join(root, "notes");
    const calendarFile = path.join(root, "calendar.json");
    const mcpFile = path.join(root, "mcp.json");
    const fsp = await import("node:fs/promises");
    await fsp.writeFile(tasksFile, JSON.stringify({ tasks: [{ id: "t1", title: "x", status: "open", createdAt: "2026-01-01T00:00:00Z" }] }), "utf8");
    await fsp.mkdir(notesDir, { recursive: true });
    await fsp.writeFile(path.join(notesDir, "hello.md"), "hi", "utf8");
    const prev = {
      tasks: process.env.MUSE_TASKS_FILE,
      notes: process.env.MUSE_NOTES_DIR,
      cal: process.env.MUSE_CALENDAR_FILE,
      mcp: process.env.MUSE_MCP_CONFIG,
      model: process.env.MUSE_MODEL
    };
    process.env.MUSE_TASKS_FILE = tasksFile;
    process.env.MUSE_NOTES_DIR = notesDir;
    process.env.MUSE_CALENDAR_FILE = calendarFile;
    process.env.MUSE_MCP_CONFIG = mcpFile;
    process.env.MUSE_MODEL = "gemini/gemini-2.0-flash";
    try {
      const { io, output } = captureOutput();
      const program = createProgram({ ...io, fetch: async () => { throw new Error("fetch must not be called"); } });
      await program.parseAsync(["node", "muse", "setup"], { from: "node" });
      const text = output.join("");
      expect(text).toContain("Muse setup status:");
      expect(text).toContain("model — MUSE_MODEL=gemini/gemini-2.0-flash");
      expect(text).toContain("tasks — 1 entry/entries");
      expect(text).toContain("notes — 1 file(s)");
      expect(text).toContain("muse setup calendar");
    } finally {
      const restore = (key: keyof typeof prev, envKey: string) => {
        if (prev[key] === undefined) { delete process.env[envKey]; } else { process.env[envKey] = prev[key]!; }
      };
      restore("tasks", "MUSE_TASKS_FILE");
      restore("notes", "MUSE_NOTES_DIR");
      restore("cal", "MUSE_CALENDAR_FILE");
      restore("mcp", "MUSE_MCP_CONFIG");
      restore("model", "MUSE_MODEL");
    }
  });

  it("muse setup --json emits a structured snapshot mirroring the text report", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "muse-cli-setup-json-"));
    const tasksFile = path.join(root, "tasks.json");
    const notesDir = path.join(root, "notes");
    const calendarFile = path.join(root, "calendar.json");
    const mcpFile = path.join(root, "mcp.json");
    const modelKeysFile = path.join(root, "models.json");
    const fsp = await import("node:fs/promises");
    await fsp.writeFile(tasksFile, JSON.stringify({
      tasks: [{ id: "t1", title: "x", status: "open", createdAt: "2026-01-01T00:00:00Z" }]
    }), "utf8");
    await fsp.mkdir(notesDir, { recursive: true });
    await fsp.writeFile(path.join(notesDir, "hello.md"), "hi", "utf8");
    await fsp.writeFile(modelKeysFile, JSON.stringify({
      providers: { openai: { suggestedModel: "openai/gpt-4o-mini", token: "sk-from-file" } },
      version: 1
    }), "utf8");
    const prev = {
      tasks: process.env.MUSE_TASKS_FILE,
      notes: process.env.MUSE_NOTES_DIR,
      cal: process.env.MUSE_CALENDAR_FILE,
      mcp: process.env.MUSE_MCP_CONFIG,
      model: process.env.MUSE_MODEL,
      keys: process.env.MUSE_MODEL_KEYS_FILE,
      openai: process.env.OPENAI_API_KEY,
      gemini: process.env.GEMINI_API_KEY
    };
    process.env.MUSE_TASKS_FILE = tasksFile;
    process.env.MUSE_NOTES_DIR = notesDir;
    process.env.MUSE_CALENDAR_FILE = calendarFile;
    process.env.MUSE_MCP_CONFIG = mcpFile;
    process.env.MUSE_MODEL_KEYS_FILE = modelKeysFile;
    delete process.env.MUSE_MODEL;
    delete process.env.OPENAI_API_KEY;
    delete process.env.GEMINI_API_KEY;
    try {
      const { io, output } = captureOutput();
      const program = createProgram({ ...io, fetch: async () => { throw new Error("fetch must not be called"); } });
      await program.parseAsync(["node", "muse", "setup", "--json"], { from: "node" });
      const snapshot = JSON.parse(output.join("")) as {
        readonly model: { readonly status: string; readonly muse_model?: string; readonly providerKeys: readonly string[] };
        readonly tasks: { readonly status: string; readonly entryCount?: number };
        readonly notes: { readonly status: string; readonly fileCount?: number };
        readonly voice: { readonly status: string; readonly source: string; readonly sttBackend: string; readonly ttsBackend: string };
        readonly userMemory: { readonly status: string; readonly autoExtract: boolean };
        readonly proactive: { readonly status: string; readonly enabled: boolean; readonly leadMinutes: number };
      };
      // Model derived from file: openai token + MUSE_MODEL auto-set.
      expect(snapshot.model.status).toBe("ok");
      expect(snapshot.model.muse_model).toBe("openai/gpt-4o-mini");
      // Provider hits come back annotated with their source — "openai (file)"
      // when the wizard saved them, "openai (env)" if the user exported the
      // raw env var. Either way the provider id must appear.
      expect(snapshot.model.providerKeys.some((entry) => entry.startsWith("openai"))).toBe(true);
      // Seeded fixtures: one task + one note.
      expect(snapshot.tasks).toMatchObject({ status: "ok", entryCount: 1 });
      expect(snapshot.notes).toMatchObject({ status: "ok", fileCount: 1 });
      // Voice resolves via merged env (OPENAI_API_KEY from file). The
      // STT/TTS backend defaults to openai-* when no local override is set.
      expect(snapshot.voice).toMatchObject({
        source: "openai_api_key",
        status: "ok",
        sttBackend: "openai-whisper",
        ttsBackend: "openai-tts"
      });
      // User-memory auto-extract is default-on.
      expect(snapshot.userMemory).toMatchObject({ autoExtract: true, status: "ok" });
      // Proactive surfacing is off without the required env vars.
      expect(snapshot.proactive).toMatchObject({ enabled: false, leadMinutes: 10, status: "info" });
      // Reminder firing daemon section mirrors proactive.
      const reminder = (snapshot as unknown as { reminder: { enabled: boolean; status: string; tickMs: number; agentTurn: boolean } }).reminder;
      expect(reminder).toMatchObject({ enabled: false, status: "info", tickMs: 60_000, agentTurn: false });
    } finally {
      const restore = (key: keyof typeof prev, envKey: string) => {
        if (prev[key] === undefined) { delete process.env[envKey]; } else { process.env[envKey] = prev[key]!; }
      };
      restore("tasks", "MUSE_TASKS_FILE");
      restore("notes", "MUSE_NOTES_DIR");
      restore("cal", "MUSE_CALENDAR_FILE");
      restore("mcp", "MUSE_MCP_CONFIG");
      restore("model", "MUSE_MODEL");
      restore("keys", "MUSE_MODEL_KEYS_FILE");
      restore("openai", "OPENAI_API_KEY");
      restore("gemini", "GEMINI_API_KEY");
    }
  });

  it("muse setup status surfaces nextStep guidance under [todo]/[info] sections (Loop #69)", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "muse-cli-setup-nextstep-"));
    const prev = {
      tasks: process.env.MUSE_TASKS_FILE,
      notes: process.env.MUSE_NOTES_DIR,
      cal: process.env.MUSE_CALENDAR_FILE,
      mcp: process.env.MUSE_MCP_CONFIG,
      keys: process.env.MUSE_MODEL_KEYS_FILE,
      messaging: process.env.MUSE_MESSAGING_CREDENTIALS_FILE,
      model: process.env.MUSE_MODEL,
      openai: process.env.OPENAI_API_KEY,
      anthropic: process.env.ANTHROPIC_API_KEY,
      gemini: process.env.GEMINI_API_KEY,
      openrouter: process.env.OPENROUTER_API_KEY,
      ollama: process.env.OLLAMA_BASE_URL,
      voice: process.env.MUSE_VOICE_OPENAI_API_KEY,
      telegram: process.env.MUSE_TELEGRAM_BOT_TOKEN,
      discord: process.env.MUSE_DISCORD_BOT_TOKEN,
      slack: process.env.MUSE_SLACK_BOT_TOKEN,
      line: process.env.MUSE_LINE_CHANNEL_ACCESS_TOKEN
    };
    // Scrub everything so the snapshot deterministically reports
    // todo/info statuses on every section.
    process.env.MUSE_TASKS_FILE = path.join(root, "tasks.json");
    process.env.MUSE_NOTES_DIR = path.join(root, "notes");
    process.env.MUSE_CALENDAR_FILE = path.join(root, "cal.json");
    process.env.MUSE_MCP_CONFIG = path.join(root, "mcp.json");
    process.env.MUSE_MODEL_KEYS_FILE = path.join(root, "models.json");
    process.env.MUSE_MESSAGING_CREDENTIALS_FILE = path.join(root, "msg.json");
    delete process.env.MUSE_MODEL;
    delete process.env.OPENAI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.GEMINI_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.OLLAMA_BASE_URL;
    delete process.env.MUSE_VOICE_OPENAI_API_KEY;
    delete process.env.MUSE_TELEGRAM_BOT_TOKEN;
    delete process.env.MUSE_DISCORD_BOT_TOKEN;
    delete process.env.MUSE_SLACK_BOT_TOKEN;
    delete process.env.MUSE_LINE_CHANNEL_ACCESS_TOKEN;
    try {
      const { io, output } = captureOutput();
      const program = createProgram({ ...io, fetch: async () => { throw new Error("fetch must not be called"); } });
      await program.parseAsync(["node", "muse", "setup"], { from: "node" });
      const text = output.join("");
      // Each non-ok section should be followed by a `→ nextStep` line.
      expect(text).toMatch(/\[todo\] model/u);
      expect(text).toMatch(/→ Run `muse setup model`/u);
      expect(text).toMatch(/→ Run `muse setup messaging`/u);
      expect(text).toMatch(/→ Run `muse setup model` and pick OpenAI/u);
    } finally {
      const restore = (key: keyof typeof prev, envKey: string) => {
        if (prev[key] === undefined) { delete process.env[envKey]; } else { process.env[envKey] = prev[key]!; }
      };
      restore("tasks", "MUSE_TASKS_FILE");
      restore("notes", "MUSE_NOTES_DIR");
      restore("cal", "MUSE_CALENDAR_FILE");
      restore("mcp", "MUSE_MCP_CONFIG");
      restore("keys", "MUSE_MODEL_KEYS_FILE");
      restore("messaging", "MUSE_MESSAGING_CREDENTIALS_FILE");
      restore("model", "MUSE_MODEL");
      restore("openai", "OPENAI_API_KEY");
      restore("anthropic", "ANTHROPIC_API_KEY");
      restore("gemini", "GEMINI_API_KEY");
      restore("openrouter", "OPENROUTER_API_KEY");
      restore("ollama", "OLLAMA_BASE_URL");
      restore("voice", "MUSE_VOICE_OPENAI_API_KEY");
      restore("telegram", "MUSE_TELEGRAM_BOT_TOKEN");
      restore("discord", "MUSE_DISCORD_BOT_TOKEN");
      restore("slack", "MUSE_SLACK_BOT_TOKEN");
      restore("line", "MUSE_LINE_CHANNEL_ACCESS_TOKEN");
    }
  });

  it("muse setup status reflects ~/.muse/models.json autoload (Loop #56 — no shell-rc export required)", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "muse-cli-setup-autoload-"));
    const modelKeysFile = path.join(root, "models.json");
    const fsp = await import("node:fs/promises");
    await fsp.writeFile(modelKeysFile, JSON.stringify({
      providers: {
        openai: { suggestedModel: "openai/gpt-4o-mini", token: "sk-from-file" }
      },
      version: 1
    }), "utf8");
    const prev = {
      keys: process.env.MUSE_MODEL_KEYS_FILE,
      openai: process.env.OPENAI_API_KEY,
      anthropic: process.env.ANTHROPIC_API_KEY,
      gemini: process.env.GEMINI_API_KEY,
      openrouter: process.env.OPENROUTER_API_KEY,
      ollama: process.env.OLLAMA_BASE_URL,
      model: process.env.MUSE_MODEL
    };
    process.env.MUSE_MODEL_KEYS_FILE = modelKeysFile;
    // Clear ambient developer env so only the file-sourced key counts.
    delete process.env.OPENAI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.GEMINI_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.OLLAMA_BASE_URL;
    delete process.env.MUSE_MODEL;
    try {
      const { io, output } = captureOutput();
      const program = createProgram({ ...io, fetch: async () => { throw new Error("fetch must not be called"); } });
      await program.parseAsync(["node", "muse", "setup"], { from: "node" });
      const text = output.join("");
      // Model should resolve from file → MUSE_MODEL auto-derived,
      // openai key counted, voice marked [ok] (since OPENAI_API_KEY
      // is now visible via merged env).
      expect(text).toContain("MUSE_MODEL=openai/gpt-4o-mini");
      expect(text).toContain("1 provider key(s): openai");
      expect(text).toContain("[ok]   voice — stt=openai-whisper, tts=openai-tts");
      // Stale "or export ..." advice must be gone.
      expect(text).not.toContain("export OPENAI_API_KEY");
    } finally {
      const restore = (key: keyof typeof prev, envKey: string) => {
        if (prev[key] === undefined) { delete process.env[envKey]; } else { process.env[envKey] = prev[key]!; }
      };
      restore("keys", "MUSE_MODEL_KEYS_FILE");
      restore("openai", "OPENAI_API_KEY");
      restore("anthropic", "ANTHROPIC_API_KEY");
      restore("gemini", "GEMINI_API_KEY");
      restore("openrouter", "OPENROUTER_API_KEY");
      restore("ollama", "OLLAMA_BASE_URL");
      restore("model", "MUSE_MODEL");
    }
  });

  it("muse remind --local round-trips add → list → clear and surfaces overdue items in today", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "muse-cli-remind-"));
    const remindersFile = path.join(root, "reminders.json");
    const tasksFile = path.join(root, "tasks.json");
    const notesDir = path.join(root, "notes");
    const prev = {
      reminders: process.env.MUSE_REMINDERS_FILE,
      tasks: process.env.MUSE_TASKS_FILE,
      notes: process.env.MUSE_NOTES_DIR
    };
    process.env.MUSE_REMINDERS_FILE = remindersFile;
    process.env.MUSE_TASKS_FILE = tasksFile;
    process.env.MUSE_NOTES_DIR = notesDir;
    try {
      // Add an overdue reminder via --local; ISO timestamp in 1970 is
      // guaranteed in the past so it must show as (overdue) in today.
      const { io: io1, output: output1 } = captureOutput();
      const program1 = createProgram({ ...io1, fetch: async () => { throw new Error("fetch in --local"); } });
      await program1.parseAsync(
        ["node", "muse", "remind", "1970-01-01T00:00:00Z", "ping", "old", "thing", "--local", "--json"],
        { from: "node" }
      );
      const created = JSON.parse(output1.join("")) as { id: string; dueAt: string; text: string };
      expect(created.text).toBe("ping old thing");
      expect(created.dueAt.startsWith("1970-")).toBe(true);

      const { io: io2, output: output2 } = captureOutput();
      const program2 = createProgram({ ...io2, fetch: async () => { throw new Error("fetch in --local"); } });
      await program2.parseAsync(["node", "muse", "remind", "list", "--local", "--json"], { from: "node" });
      const listed = JSON.parse(output2.join("")) as { reminders: Array<{ id: string; text: string }>; total: number };
      expect(listed.total).toBe(1);
      expect(listed.reminders[0]?.id).toBe(created.id);

      const { io: io3, output: output3 } = captureOutput();
      const program3 = createProgram({ ...io3, fetch: async () => { throw new Error("fetch in --local"); } });
      await program3.parseAsync(["node", "muse", "today", "--local"], { from: "node" });
      const text = output3.join("");
      expect(text).toContain("Reminders (1):");
      expect(text).toContain("ping old thing");
      expect(text).toContain("(overdue)");

      const { io: io4 } = captureOutput();
      const program4 = createProgram({ ...io4, fetch: async () => { throw new Error("fetch in --local"); } });
      await program4.parseAsync(["node", "muse", "remind", "clear", created.id, "--local"], { from: "node" });

      const { io: io5, output: output5 } = captureOutput();
      const program5 = createProgram({ ...io5, fetch: async () => { throw new Error("fetch in --local"); } });
      await program5.parseAsync(["node", "muse", "remind", "list", "--status", "all", "--local", "--json"], { from: "node" });
      const after = JSON.parse(output5.join("")) as { total: number };
      expect(after.total).toBe(0);
    } finally {
      const restore = (key: keyof typeof prev, envKey: string): void => {
        if (prev[key] === undefined) { delete process.env[envKey]; } else { process.env[envKey] = prev[key]!; }
      };
      restore("reminders", "MUSE_REMINDERS_FILE");
      restore("tasks", "MUSE_TASKS_FILE");
      restore("notes", "MUSE_NOTES_DIR");
    }
  });

  it("muse remind run --watch rejects --dry-run and --watch alone (requires --via + --destination)", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "muse-cli-remind-watch-"));
    const remindersFile = path.join(root, "reminders.json");
    const prev = process.env.MUSE_REMINDERS_FILE;
    process.env.MUSE_REMINDERS_FILE = remindersFile;
    try {
      // --watch + --dry-run is incoherent (watching needs real delivery
      // so reminders advance; dry-run never delivers).
      const { io: io1 } = captureOutput();
      const program1 = createProgram({ ...io1, fetch: async () => { throw new Error("fetch must not be called"); } });
      program1.exitOverride();
      await expect(
        program1.parseAsync(
          ["node", "muse", "remind", "run", "--watch", "--dry-run"],
          { from: "node" }
        )
      ).rejects.toThrow(/mutually exclusive/u);

      // --watch without --via / --destination fails fast.
      const { io: io2 } = captureOutput();
      const program2 = createProgram({ ...io2, fetch: async () => { throw new Error("fetch must not be called"); } });
      program2.exitOverride();
      await expect(
        program2.parseAsync(
          ["node", "muse", "remind", "run", "--watch"],
          { from: "node" }
        )
      ).rejects.toThrow(/--watch requires/u);
    } finally {
      if (prev === undefined) { delete process.env.MUSE_REMINDERS_FILE; } else { process.env.MUSE_REMINDERS_FILE = prev; }
    }
  });

  it("muse remind history --local renders newest-first with status icons and route", async () => {
    const { appendReminderHistory } = await import("@muse/mcp");
    const root = await mkdtemp(path.join(tmpdir(), "muse-cli-remind-hist-"));
    const historyFile = path.join(root, "history.json");
    const prev = process.env.MUSE_REMINDER_HISTORY_FILE;
    process.env.MUSE_REMINDER_HISTORY_FILE = historyFile;
    try {
      await appendReminderHistory(historyFile, {
        destination: "@me",
        firedAtIso: "2026-05-11T08:00:00.000Z",
        providerId: "telegram",
        reminderId: "rem_ok",
        status: "delivered",
        text: "morning brief"
      });
      await appendReminderHistory(historyFile, {
        destination: "C123",
        error: "channel_not_found",
        firedAtIso: "2026-05-11T09:30:00.000Z",
        providerId: "slack",
        reminderId: "rem_bad",
        status: "failed",
        text: "deploy alert"
      });

      const { io, output } = captureOutput();
      const program = createProgram({ ...io, fetch: async () => { throw new Error("fetch in --local"); } });
      await program.parseAsync(
        ["node", "muse", "remind", "history", "--local", "--json"],
        { from: "node" }
      );
      const json = JSON.parse(output.join("")) as { entries: Array<{ reminderId: string; status: string }>; total: number };
      expect(json.total).toBe(2);
      expect(json.entries.map((e) => e.reminderId)).toEqual(["rem_bad", "rem_ok"]);

      const { io: io2, output: output2 } = captureOutput();
      const program2 = createProgram({ ...io2, fetch: async () => { throw new Error("fetch in --local"); } });
      await program2.parseAsync(
        ["node", "muse", "remind", "history", "--local"],
        { from: "node" }
      );
      const text = output2.join("");
      expect(text).toContain("✓");
      expect(text).toContain("✗");
      expect(text).toContain("telegram→@me");
      expect(text).toContain("slack→C123");
      expect(text).toContain("channel_not_found");
    } finally {
      if (prev === undefined) {
        delete process.env.MUSE_REMINDER_HISTORY_FILE;
      } else {
        process.env.MUSE_REMINDER_HISTORY_FILE = prev;
      }
    }
  });

  it("muse remind run delivers only due reminders via the messaging provider then fires them", async () => {
    const fsp = await import("node:fs/promises");
    const root = await mkdtemp(path.join(tmpdir(), "muse-cli-remind-run-"));
    const remindersFile = path.join(root, "reminders.json");
    // Two reminders: one in the past (due), one in 2027 (future).
    await fsp.writeFile(remindersFile, JSON.stringify({
      reminders: [
        {
          createdAt: "2026-01-01T00:00:00Z",
          dueAt: "1970-01-01T00:00:00Z",
          id: "rem_due",
          status: "pending",
          text: "Buy milk"
        },
        {
          createdAt: "2026-05-11T00:00:00Z",
          dueAt: "2027-01-01T00:00:00Z",
          id: "rem_future",
          status: "pending",
          text: "Future thing"
        }
      ]
    }), "utf8");

    const prevFile = process.env.MUSE_REMINDERS_FILE;
    const prevTg = process.env.MUSE_TELEGRAM_BOT_TOKEN;
    process.env.MUSE_REMINDERS_FILE = remindersFile;
    process.env.MUSE_TELEGRAM_BOT_TOKEN = "fake-token";
    const originalFetch = globalThis.fetch;
    const sentBodies: string[] = [];
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      if (typeof init?.body === "string") {
        sentBodies.push(init.body);
      }
      return new Response(JSON.stringify({ ok: true, result: { message_id: 99 } }), { status: 200 });
    }) as typeof fetch;
    try {
      // Dry run: previews due, never calls fetch.
      const { io: ioDry, output: outDry } = captureOutput();
      const dry = createProgram({ ...ioDry, fetch: async () => { throw new Error("api fetch must not be called"); } });
      await dry.parseAsync(["node", "muse", "remind", "run", "--dry-run"], { from: "node" });
      const dryText = outDry.join("");
      expect(dryText).toContain("Would fire 1 reminder(s):");
      expect(dryText).toContain("Buy milk");
      expect(sentBodies).toHaveLength(0);

      // Live run: delivers, fires, persists.
      const { io: ioRun, output: outRun } = captureOutput();
      const run = createProgram({ ...ioRun, fetch: async () => { throw new Error("api fetch must not be called"); } });
      await run.parseAsync(
        ["node", "muse", "remind", "run", "--via", "telegram", "--destination", "@me", "--json"],
        { from: "node" }
      );
      const runResult = JSON.parse(outRun.join("")) as { delivered: number; due: number; errors: string[] };
      expect(runResult).toMatchObject({ delivered: 1, due: 1, errors: [] });
      expect(sentBodies).toHaveLength(1);
      expect(JSON.parse(sentBodies[0]!)).toMatchObject({ chat_id: "@me", text: "Buy milk" });

      const after = JSON.parse(await fsp.readFile(remindersFile, "utf8")) as {
        reminders: Array<{ id: string; status: string; firedAt?: string }>;
      };
      const dueRow = after.reminders.find((r) => r.id === "rem_due");
      const futureRow = after.reminders.find((r) => r.id === "rem_future");
      expect(dueRow?.status).toBe("fired");
      expect(typeof dueRow?.firedAt).toBe("string");
      expect(futureRow?.status).toBe("pending");
    } finally {
      globalThis.fetch = originalFetch;
      if (prevFile === undefined) { delete process.env.MUSE_REMINDERS_FILE; } else { process.env.MUSE_REMINDERS_FILE = prevFile; }
      if (prevTg === undefined) { delete process.env.MUSE_TELEGRAM_BOT_TOKEN; } else { process.env.MUSE_TELEGRAM_BOT_TOKEN = prevTg; }
    }
  });

  it("muse telemetry summary calls /admin/telemetry/summary and pretty-prints the result", async () => {
    const { io, output } = captureOutput();
    const requests: { readonly url: string }[] = [];
    const program = createProgram({
      ...io,
      fetch: async (url) => {
        requests.push({ url: String(url) });
        return new Response(JSON.stringify({
          enabled: true,
          summary: {
            budgetAverages: { total: 12_500 },
            counterAverages: { inboxContextMessageCount: 3.5 },
            flagCounts: { activeContextApplied: 12, inboxContextApplied: 7 },
            latency: { averageMs: 1_200, count: 12, maxMs: 2_400, p95Ms: 2_100 },
            tokenTotals: { cachedInput: 0, input: 30_000, output: 4_500 },
            totalRuns: 12,
            windowEndMs: Date.parse("2026-05-11T12:00:00.000Z"),
            windowStartMs: Date.parse("2026-05-04T12:00:00.000Z")
          }
        }));
      }
    });
    await program.parseAsync([
      "node", "muse",
      "--api-url", "http://api.test",
      "telemetry", "summary"
    ], { from: "node" });
    expect(requests[0]?.url).toBe("http://api.test/admin/telemetry/summary");
    const text = output.join("");
    expect(text).toContain("Total runs: 12");
    expect(text).toContain("Latency (n=12)");
    expect(text).toContain("average: 1200 ms");
    expect(text).toContain("p95:     2100 ms");
    expect(text).toContain("activeContextApplied: 12");
    expect(text).toContain("inboxContextMessageCount: 3.50");
  });

  it("muse telemetry recent hits /admin/telemetry/recent with limit + sinceMs", async () => {
    const { io, output } = captureOutput();
    const requests: { readonly url: string }[] = [];
    const program = createProgram({
      ...io,
      fetch: async (url) => {
        requests.push({ url: String(url) });
        return new Response(JSON.stringify({
          enabled: true,
          events: [
            {
              inputTokens: 1_000,
              latencyMs: 320,
              model: "gemini-2.0-flash",
              outputTokens: 200,
              providerId: "google",
              recordedAtMs: Date.parse("2026-05-11T11:00:00.000Z"),
              runId: "r-1"
            }
          ]
        }));
      }
    });
    await program.parseAsync([
      "node", "muse",
      "--api-url", "http://api.test",
      "telemetry", "recent", "--limit", "5", "--since-ms", "1700000000000"
    ], { from: "node" });
    expect(requests[0]?.url).toBe(
      "http://api.test/admin/telemetry/recent?limit=5&sinceMs=1700000000000"
    );
    const text = output.join("");
    expect(text).toContain("google/gemini-2.0-flash");
    expect(text).toContain("latency=320ms");
    expect(text).toContain("run=r-1");
  });

  it("muse telemetry summary reports `disabled` cleanly when aggregator is off", async () => {
    const { io, output } = captureOutput();
    const program = createProgram({
      ...io,
      fetch: async () => new Response(JSON.stringify({ enabled: false }))
    });
    await program.parseAsync([
      "node", "muse",
      "--api-url", "http://api.test",
      "telemetry", "summary"
    ], { from: "node" });
    expect(output.join("")).toContain("disabled");
  });

  it("muse proactive test exits 1 with a helpful message when MUSE_PROACTIVE_PROVIDER is missing", async () => {
    const prev = {
      provider: process.env.MUSE_PROACTIVE_PROVIDER,
      destination: process.env.MUSE_PROACTIVE_DESTINATION
    };
    delete process.env.MUSE_PROACTIVE_PROVIDER;
    delete process.env.MUSE_PROACTIVE_DESTINATION;
    try {
      const { io, output } = captureOutput();
      const program = createProgram({
        ...io,
        exitOverride: true
      });
      await expect(
        program.parseAsync(["node", "muse", "proactive", "test"], { from: "node" })
      ).rejects.toBeTruthy();
      const text = output.join("");
      expect(text).toContain("MUSE_PROACTIVE_PROVIDER");
      expect(text).toContain("MUSE_PROACTIVE_DESTINATION");
    } finally {
      if (prev.provider !== undefined) process.env.MUSE_PROACTIVE_PROVIDER = prev.provider;
      if (prev.destination !== undefined) process.env.MUSE_PROACTIVE_DESTINATION = prev.destination;
    }
  });

  it("muse proactive test exits 1 when the configured provider is not registered", async () => {
    const prev = {
      provider: process.env.MUSE_PROACTIVE_PROVIDER,
      destination: process.env.MUSE_PROACTIVE_DESTINATION,
      telegram: process.env.MUSE_TELEGRAM_BOT_TOKEN
    };
    process.env.MUSE_PROACTIVE_PROVIDER = "telegram";
    process.env.MUSE_PROACTIVE_DESTINATION = "@me";
    delete process.env.MUSE_TELEGRAM_BOT_TOKEN;
    try {
      const { io, output } = captureOutput();
      const program = createProgram({ ...io, exitOverride: true });
      await expect(
        program.parseAsync(["node", "muse", "proactive", "test"], { from: "node" })
      ).rejects.toBeTruthy();
      expect(output.join("")).toContain("not registered");
    } finally {
      if (prev.provider !== undefined) process.env.MUSE_PROACTIVE_PROVIDER = prev.provider;
      else delete process.env.MUSE_PROACTIVE_PROVIDER;
      if (prev.destination !== undefined) process.env.MUSE_PROACTIVE_DESTINATION = prev.destination;
      else delete process.env.MUSE_PROACTIVE_DESTINATION;
      if (prev.telegram !== undefined) process.env.MUSE_TELEGRAM_BOT_TOKEN = prev.telegram;
    }
  });

  it("muse proactive scan reports empty calendar + empty tasks without error", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "muse-cli-proactive-scan-"));
    const tasksFile = path.join(root, "tasks.json");
    const prev = {
      tasks: process.env.MUSE_TASKS_FILE,
      calProviders: process.env.MUSE_CALENDAR_PROVIDERS,
      calFile: process.env.MUSE_CALENDAR_FILE
    };
    process.env.MUSE_TASKS_FILE = tasksFile;
    // Force calendar registry empty by disabling all providers.
    process.env.MUSE_CALENDAR_PROVIDERS = "";
    process.env.MUSE_CALENDAR_FILE = path.join(root, "calendar.json");
    try {
      const { io, output } = captureOutput();
      const program = createProgram(io);
      await program.parseAsync(["node", "muse", "proactive", "scan"], { from: "node" });
      const text = output.join("");
      expect(text).toContain("Window:");
      expect(text).toContain("no due-soon tasks");
    } finally {
      if (prev.tasks !== undefined) process.env.MUSE_TASKS_FILE = prev.tasks;
      else delete process.env.MUSE_TASKS_FILE;
      if (prev.calProviders !== undefined) process.env.MUSE_CALENDAR_PROVIDERS = prev.calProviders;
      else delete process.env.MUSE_CALENDAR_PROVIDERS;
      if (prev.calFile !== undefined) process.env.MUSE_CALENDAR_FILE = prev.calFile;
      else delete process.env.MUSE_CALENDAR_FILE;
    }
  });

  it("muse followup list --json filters by status and sorts by scheduledFor asc", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "muse-cli-followup-list-"));
    const followupsFile = path.join(root, "followups.json");
    const fsp = await import("node:fs/promises");
    const prev = process.env.MUSE_FOLLOWUPS_FILE;
    process.env.MUSE_FOLLOWUPS_FILE = followupsFile;
    try {
      await fsp.writeFile(followupsFile, JSON.stringify({
        followups: [
          { createdAt: "2026-05-10T00:00:00Z", id: "fu_b_later", scheduledFor: "2026-05-12T10:00:00Z", status: "scheduled", summary: "Later promise", userId: "stark" },
          { createdAt: "2026-05-10T00:00:00Z", id: "fu_a_sooner", scheduledFor: "2026-05-11T09:00:00Z", status: "scheduled", summary: "Sooner promise", userId: "stark" },
          { createdAt: "2026-05-10T00:00:00Z", firedAt: "2026-05-10T13:00:00Z", id: "fu_done", scheduledFor: "2026-05-10T12:00:00Z", status: "fired", summary: "Old fired", userId: "stark" },
          { cancelReason: "user-cancelled", createdAt: "2026-05-10T00:00:00Z", id: "fu_dropped", scheduledFor: "2026-05-10T08:00:00Z", status: "cancelled", summary: "Dropped one", userId: "stark" }
        ]
      }), "utf8");

      // Default --status=scheduled returns the two scheduled, sorted by scheduledFor.
      const { io: io1, output: out1 } = captureOutput();
      const program1 = createProgram({ ...io1, fetch: async () => { throw new Error("no fetch"); } });
      await program1.parseAsync(["node", "muse", "followup", "list", "--json"], { from: "node" });
      const listed1 = JSON.parse(out1.join("")) as { followups: Array<{ id: string }>; status: string; total: number };
      expect(listed1.status).toBe("scheduled");
      expect(listed1.total).toBe(2);
      expect(listed1.followups.map((f) => f.id)).toEqual(["fu_a_sooner", "fu_b_later"]);

      // --status all returns all four.
      const { io: io2, output: out2 } = captureOutput();
      const program2 = createProgram({ ...io2, fetch: async () => { throw new Error("no fetch"); } });
      await program2.parseAsync(["node", "muse", "followup", "list", "--status", "all", "--json"], { from: "node" });
      const listed2 = JSON.parse(out2.join("")) as { total: number };
      expect(listed2.total).toBe(4);

      // --status fired returns just the fired one.
      const { io: io3, output: out3 } = captureOutput();
      const program3 = createProgram({ ...io3, fetch: async () => { throw new Error("no fetch"); } });
      await program3.parseAsync(["node", "muse", "followup", "list", "--status", "fired", "--json"], { from: "node" });
      const listed3 = JSON.parse(out3.join("")) as { followups: Array<{ id: string }>; total: number };
      expect(listed3.total).toBe(1);
      expect(listed3.followups[0]?.id).toBe("fu_done");

      const tieDir = await mkdtemp(path.join(tmpdir(), "muse-cli-followup-list-tie-"));
      const tieFile = path.join(tieDir, "followups.json");
      const sameWhen = "2026-05-11T09:00:00Z";
      await fsp.writeFile(tieFile, JSON.stringify({
        followups: [
          { createdAt: "2026-05-10T00:00:00Z", id: "fu_b", scheduledFor: sameWhen, status: "scheduled", summary: "B", userId: "stark" },
          { createdAt: "2026-05-10T00:00:00Z", id: "fu_a", scheduledFor: sameWhen, status: "scheduled", summary: "A", userId: "stark" },
          { createdAt: "2026-05-10T00:00:00Z", id: "fu_c", scheduledFor: sameWhen, status: "scheduled", summary: "C", userId: "stark" }
        ]
      }), "utf8");
      process.env.MUSE_FOLLOWUPS_FILE = tieFile;
      const { io: ioTie, output: outTie } = captureOutput();
      const programTie = createProgram({ ...ioTie, fetch: async () => { throw new Error("no fetch"); } });
      await programTie.parseAsync(["node", "muse", "followup", "list", "--json"], { from: "node" });
      const listedTie = JSON.parse(outTie.join("")) as { followups: Array<{ id: string }> };
      expect(listedTie.followups.map((f) => f.id), "ties on scheduledFor resolve by id asc — independent of file-array insertion order").toEqual(["fu_a", "fu_b", "fu_c"]);
    } finally {
      if (prev !== undefined) process.env.MUSE_FOLLOWUPS_FILE = prev;
      else delete process.env.MUSE_FOLLOWUPS_FILE;
    }
  });

  it("muse followup show resolves a unique id prefix; rejects ambiguous prefixes", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "muse-cli-followup-show-"));
    const followupsFile = path.join(root, "followups.json");
    const fsp = await import("node:fs/promises");
    const prev = process.env.MUSE_FOLLOWUPS_FILE;
    process.env.MUSE_FOLLOWUPS_FILE = followupsFile;
    try {
      await fsp.writeFile(followupsFile, JSON.stringify({
        followups: [
          { createdAt: "2026-05-10T00:00:00Z", id: "fu_alpha", originRunId: "run_42", scheduledFor: "2026-05-11T09:00:00Z", status: "scheduled", summary: "Alpha promise", userId: "stark" },
          { createdAt: "2026-05-10T00:00:00Z", id: "fu_ambig_one", scheduledFor: "2026-05-11T10:00:00Z", status: "scheduled", summary: "Ambig 1", userId: "stark" },
          { createdAt: "2026-05-10T00:00:00Z", id: "fu_ambig_two", scheduledFor: "2026-05-11T11:00:00Z", status: "scheduled", summary: "Ambig 2", userId: "stark" }
        ]
      }), "utf8");

      // Unique prefix resolves and --json round-trips the full record.
      const { io: io1, output: out1 } = captureOutput();
      const program1 = createProgram({ ...io1, fetch: async () => { throw new Error("no fetch"); } });
      await program1.parseAsync(["node", "muse", "followup", "show", "fu_alpha", "--json"], { from: "node" });
      const shown = JSON.parse(out1.join("")) as { id: string; summary: string; originRunId: string };
      expect(shown.id).toBe("fu_alpha");
      expect(shown.summary).toBe("Alpha promise");
      expect(shown.originRunId).toBe("run_42");

      // Ambiguous prefix throws with a helpful message.
      const { io: io2 } = captureOutput();
      const program2 = createProgram({ ...io2, fetch: async () => { throw new Error("no fetch"); } });
      program2.exitOverride();
      await expect(program2.parseAsync(["node", "muse", "followup", "show", "fu_ambig", "--json"], { from: "node" }))
        .rejects.toThrow(/Ambiguous followup id/u);
    } finally {
      if (prev !== undefined) process.env.MUSE_FOLLOWUPS_FILE = prev;
      else delete process.env.MUSE_FOLLOWUPS_FILE;
    }
  });

  it("muse followup snooze parses relative <when> and updates scheduledFor on a scheduled entry", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "muse-cli-followup-snooze-"));
    const followupsFile = path.join(root, "followups.json");
    const fsp = await import("node:fs/promises");
    const prev = process.env.MUSE_FOLLOWUPS_FILE;
    process.env.MUSE_FOLLOWUPS_FILE = followupsFile;
    try {
      await fsp.writeFile(followupsFile, JSON.stringify({
        followups: [
          { createdAt: "2026-05-10T00:00:00Z", id: "fu_push", scheduledFor: "2026-05-11T09:00:00Z", status: "scheduled", summary: "Push out", userId: "stark" },
          { createdAt: "2026-05-10T00:00:00Z", firedAt: "2026-05-10T13:00:00Z", id: "fu_done", scheduledFor: "2026-05-10T12:00:00Z", status: "fired", summary: "Already fired", userId: "stark" }
        ]
      }), "utf8");

      // Happy path: relative phrase resolves and the patched record shows new scheduledFor.
      const { io: io1, output: out1 } = captureOutput();
      const program1 = createProgram({ ...io1, fetch: async () => { throw new Error("no fetch"); } });
      await program1.parseAsync(["node", "muse", "followup", "snooze", "fu_push", "in", "2", "hours", "--json"], { from: "node" });
      const patched = JSON.parse(out1.join("")) as { id: string; scheduledFor: string; status: string };
      expect(patched.id).toBe("fu_push");
      expect(patched.status).toBe("scheduled");
      // We can't pin the wall-clock exactly, but it must differ from the original.
      expect(patched.scheduledFor).not.toBe("2026-05-11T09:00:00Z");
      expect(Date.parse(patched.scheduledFor)).toBeGreaterThan(Date.now() - 60_000);

      // Already-fired entry rejects with a guiding message.
      const { io: io2 } = captureOutput();
      const program2 = createProgram({ ...io2, fetch: async () => { throw new Error("no fetch"); } });
      program2.exitOverride();
      await expect(program2.parseAsync(["node", "muse", "followup", "snooze", "fu_done", "in", "1", "hour"], { from: "node" }))
        .rejects.toThrow(/only scheduled followups can be snoozed/u);
    } finally {
      if (prev !== undefined) process.env.MUSE_FOLLOWUPS_FILE = prev;
      else delete process.env.MUSE_FOLLOWUPS_FILE;
    }
  });

  it("appendSessionBoundary writes a [SESSION_BOUNDARY] line that readLastChatHistory ignores", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "muse-cli-boundary-"));
    const fsp = await import("node:fs/promises");
    const prev = process.env.HOME;
    process.env.HOME = root;
    try {
      const {
        appendLastChatTurn,
        appendSessionBoundary,
        readLastChatHistory,
        readSessionBoundaries,
        SESSION_BOUNDARY_CONTENT
      } = await import("../src/chat-history.js");

      await appendSessionBoundary({ tsIso: "2026-05-13T08:00:00.000Z", userId: "stark" });
      await appendLastChatTurn({ message: "hi", response: "hello" });
      await appendSessionBoundary({ tsIso: "2026-05-13T09:00:00.000Z", userId: "stark" });
      await appendLastChatTurn({ message: "again", response: "yes" });

      // Seed history must NOT include the boundary lines — only
      // user/assistant turns flow through readLastChatHistory.
      const seed = await readLastChatHistory();
      expect(seed.every((line) => line.role === "user" || line.role === "assistant")).toBe(true);
      expect(seed.find((line) => line.content === SESSION_BOUNDARY_CONTENT)).toBeUndefined();
      expect(seed.map((l) => l.content)).toEqual(["hi", "hello", "again", "yes"]);

      // The boundary reader picks up both markers in order.
      const boundaries = await readSessionBoundaries();
      expect(boundaries.map((b) => b.tsIso)).toEqual([
        "2026-05-13T08:00:00.000Z",
        "2026-05-13T09:00:00.000Z"
      ]);
      expect(boundaries.every((b) => b.userId === "stark")).toBe(true);

      // Raw file contains the literal sentinel content (the future
      // extractor scans this directly).
      const raw = await fsp.readFile(path.join(root, ".muse", "last-chat.jsonl"), "utf8");
      expect(raw).toContain(SESSION_BOUNDARY_CONTENT);
    } finally {
      if (prev !== undefined) process.env.HOME = prev;
      else delete process.env.HOME;
    }
  });

  it("muse notes semantic auto-reindex preserves the index's embed model (goal 257)", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "muse-cli-notes-model-"));
    const fsp = await import("node:fs/promises");
    const { NOTES_INDEX_SCHEMA_VERSION } = await import("../src/commands-notes-rag.js");
    const prevHome = process.env.HOME;
    const prevNotes = process.env.MUSE_NOTES_DIR;
    const notesDir = path.join(root, "notes");
    const indexPath = path.join(root, ".muse", "notes-index.json");
    await fsp.mkdir(notesDir, { recursive: true });
    await fsp.mkdir(path.join(root, ".muse"), { recursive: true });
    await fsp.writeFile(path.join(notesDir, "a.md"), "the quarterly budget review notes", "utf8");
    // Index built with a custom model, stale (old builtAt, the note
    // above is freshly written so its mtime is newer).
    await fsp.writeFile(indexPath, JSON.stringify({
      builtAtIso: "2020-01-01T00:00:00.000Z",
      files: [],
      model: "custom-embed-xl",
      version: NOTES_INDEX_SCHEMA_VERSION
    }), "utf8");
    process.env.HOME = root;
    process.env.MUSE_NOTES_DIR = notesDir;
    try {
      const { io, output } = captureOutput();
      const program = createProgram({ ...io, fetch: async () => { throw new Error("no api"); } });
      const prevExit = process.exitCode;
      process.exitCode = 0;
      // No --model → defaults to nomic-embed-text. Pre-fix this
      // silently re-embedded the whole index with the default;
      // post-fix the stale refresh keeps the index's own model and
      // the explicit mismatch guard fires (consistent, non-destructive).
      await program.parseAsync(["node", "muse", "notes", "semantic", "budget"], { from: "node" });
      process.exitCode = prevExit;

      const text = output.join("");
      expect(text).toContain("Index built with model 'custom-embed-xl'");
      expect(text).toMatch(/--model custom-embed-xl/u);

      // The on-disk index must NOT have been silently downgraded to
      // the default embed model by the stale auto-reindex.
      const onDisk = JSON.parse(await fsp.readFile(indexPath, "utf8")) as { model: string };
      expect(onDisk.model).toBe("custom-embed-xl");
    } finally {
      if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
      if (prevNotes === undefined) delete process.env.MUSE_NOTES_DIR; else process.env.MUSE_NOTES_DIR = prevNotes;
    }
  });

  it("muse ask auto-reindex preserves the index's embed model (goal 258)", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "muse-cli-ask-model-"));
    const fsp = await import("node:fs/promises");
    const { NOTES_INDEX_SCHEMA_VERSION } = await import("../src/commands-notes-rag.js");
    const prevHome = process.env.HOME;
    const prevNotes = process.env.MUSE_NOTES_DIR;
    const notesDir = path.join(root, "notes");
    const indexPath = path.join(root, ".muse", "notes-index.json");
    await fsp.mkdir(notesDir, { recursive: true });
    await fsp.mkdir(path.join(root, ".muse"), { recursive: true });
    await fsp.writeFile(path.join(notesDir, "a.md"), "the quarterly budget review notes", "utf8");
    await fsp.writeFile(indexPath, JSON.stringify({
      builtAtIso: "2020-01-01T00:00:00.000Z",
      files: [],
      model: "custom-embed-xl",
      version: NOTES_INDEX_SCHEMA_VERSION
    }), "utf8");
    process.env.HOME = root;
    process.env.MUSE_NOTES_DIR = notesDir;
    try {
      const { io, output } = captureOutput();
      const program = createProgram({ ...io, fetch: async () => { throw new Error("no api"); } });
      const prevExit = process.exitCode;
      process.exitCode = 0;
      // No --embed-model → defaults to nomic-embed-text. The stale
      // auto-reindex must keep the index's own model, not silently
      // rebuild it with the default; the explicit guard then fires.
      await program.parseAsync(
        ["node", "muse", "ask", "budget", "--no-tasks", "--no-calendar", "--no-reminders"],
        { from: "node" }
      );
      process.exitCode = prevExit;

      const text = output.join("");
      expect(text).toContain("Index was built with embed model 'custom-embed-xl'");
      expect(text).toMatch(/--embed-model custom-embed-xl/u);

      const onDisk = JSON.parse(await fsp.readFile(indexPath, "utf8")) as { model: string };
      expect(onDisk.model).toBe("custom-embed-xl");
    } finally {
      if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
      if (prevNotes === undefined) delete process.env.MUSE_NOTES_DIR; else process.env.MUSE_NOTES_DIR = prevNotes;
    }
  });

  it("muse ask --tiered routes the question to the fast vs heavy model and surfaces the chosen tier", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "muse-cli-ask-tiered-"));
    const fsp = await import("node:fs/promises");
    const { NOTES_INDEX_SCHEMA_VERSION } = await import("../src/commands-notes-rag.js");
    const notesDir = path.join(root, "notes");
    const indexPath = path.join(root, ".muse", "notes-index.json");
    await fsp.mkdir(notesDir, { recursive: true });
    await fsp.mkdir(path.join(root, ".muse"), { recursive: true });
    // Index model matches the default embed model so the guard passes;
    // empty files means no chunks (embedding the query then fails over
    // the throwing fetch and degrades to "no notes context").
    await fsp.writeFile(indexPath, JSON.stringify({
      builtAtIso: "2026-05-22T00:00:00.000Z",
      files: [],
      model: "nomic-embed-text",
      version: NOTES_INDEX_SCHEMA_VERSION
    }), "utf8");

    const saved = {
      HOME: process.env.HOME,
      MUSE_NOTES_DIR: process.env.MUSE_NOTES_DIR,
      MUSE_MODEL: process.env.MUSE_MODEL,
      MUSE_FAST_MODEL: process.env.MUSE_FAST_MODEL,
      MUSE_HEAVY_MODEL: process.env.MUSE_HEAVY_MODEL,
      OLLAMA_BASE_URL: process.env.OLLAMA_BASE_URL
    };
    process.env.HOME = root;
    process.env.MUSE_NOTES_DIR = notesDir;
    process.env.MUSE_MODEL = "ollama/qwen3:8b";
    process.env.MUSE_FAST_MODEL = "ollama/qwen3:8b";
    process.env.MUSE_HEAVY_MODEL = "ollama/qwen3.6:35b-a3b";
    // Point the model provider at an unreachable Ollama so the chat call
    // fails fast (ECONNREFUSED) AFTER the tier note is printed — the test
    // asserts the routing decision, not a real model round-trip.
    process.env.OLLAMA_BASE_URL = "http://127.0.0.1:1";
    const prevExit = process.exitCode;
    try {
      const reasoning = captureOutput();
      const program1 = createProgram({ ...reasoning.io, fetch: async () => { throw new Error("no api"); } });
      process.exitCode = 0;
      await program1.parseAsync(
        ["node", "muse", "ask", "analyze", "the", "trade-offs", "between", "two", "designs",
          "--tiered", "--no-tasks", "--no-calendar", "--no-reminders"],
        { from: "node" }
      );
      expect(reasoning.output.join("")).toContain("(tier: heavy → ollama/qwen3.6:35b-a3b)");

      const lookup = captureOutput();
      const program2 = createProgram({ ...lookup.io, fetch: async () => { throw new Error("no api"); } });
      process.exitCode = 0;
      await program2.parseAsync(
        ["node", "muse", "ask", "what", "is", "the", "capital", "of", "France",
          "--tiered", "--no-tasks", "--no-calendar", "--no-reminders"],
        { from: "node" }
      );
      expect(lookup.output.join("")).toContain("(tier: fast → ollama/qwen3:8b)");
    } finally {
      process.exitCode = prevExit;
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  }, 20_000);

  it("appendLastChatTurn redacts credential shapes before persisting to disk (goal 108)", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "muse-chat-redact-"));
    const fsp = await import("node:fs/promises");
    const prev = process.env.HOME;
    process.env.HOME = root;
    try {
      const { appendLastChatTurn, readLastChatHistory } = await import("../src/chat-history.js");
      // A turn whose user side carries an OpenAI sk- token AND whose
      // assistant side echoes a GitHub PAT. Both must land on disk
      // with `[redacted-…]` markers — not the verbatim secret.
      await appendLastChatTurn({
        message: "rotate sk-proj-abcdefghijklmnopqrstuvwxyz tomorrow",
        response: "noted. The old ghp_abcdefghijklmnopqrstuvwxyzABCDEF will rotate Friday."
      });

      const rawPath = path.join(root, ".muse", "last-chat.jsonl");
      const raw = await fsp.readFile(rawPath, "utf8");
      // Verbatim secrets MUST NOT survive to disk.
      expect(raw).not.toContain("sk-proj-abcdefghijklmnopqrstuvwxyz");
      expect(raw).not.toContain("ghp_abcdefghijklmnopqrstuvwxyzABCDEF");
      // Redaction markers DO survive — provides context to the next
      // turn ("the user mentioned a key here") without the secret.
      expect(raw).toContain("[redacted-openai-key]");
      expect(raw).toContain("[redacted-github-pat]");
      // Non-credential context survives unchanged.
      expect(raw).toContain("rotate ");
      expect(raw).toContain("rotate Friday");

      // readLastChatHistory returns the redacted form (it's what the
      // next --continue invocation will hand back to the model).
      const seed = await readLastChatHistory();
      expect(seed[0]?.content).toContain("[redacted-openai-key]");
      expect(seed[1]?.content).toContain("[redacted-github-pat]");
    } finally {
      if (prev !== undefined) process.env.HOME = prev;
      else delete process.env.HOME;
    }
  });

  it("captureEndOfSessionEpisode is gated by MUSE_EPISODIC_MEMORY_ENABLED and writes a real episode on the happy path", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "muse-eos-"));
    const fsp = await import("node:fs/promises");
    const prevHome = process.env.HOME;
    const prevEnabled = process.env.MUSE_EPISODIC_MEMORY_ENABLED;
    process.env.HOME = root;
    try {
      // Seed last-chat.jsonl: boundary line + two turns.
      const { appendLastChatTurn, appendSessionBoundary } = await import("../src/chat-history.js");
      await appendSessionBoundary({ tsIso: "2026-05-13T08:00:00.000Z", userId: "stark" });
      await appendLastChatTurn({ message: "Help me plan the Q3 memo", response: "Notion seems good" });

      const { captureEndOfSessionEpisode } = await import("../src/chat-end-session.js");

      const stubProvider = {
        id: "stub",
        listModels: async () => [],
        generate: async () => ({
          id: "stub-resp",
          model: "stub",
          output: "Discussed Q3 budget memo. User decided to draft in Notion.\ntopics: Q3 budget memo, Notion"
        }),
        // The summariser only calls .generate but the structural type
        // includes stream; stub a no-op so the shape is complete.
        stream: async function* () { /* not used */ }
      } as unknown as Parameters<typeof captureEndOfSessionEpisode>[0]["modelProvider"];

      // Disabled path — gate stays closed even with valid setup.
      delete process.env.MUSE_EPISODIC_MEMORY_ENABLED;
      const skipped = await captureEndOfSessionEpisode({
        model: "stub",
        modelProvider: stubProvider,
        userId: "stark"
      });
      expect(skipped).toMatchObject({ status: "skipped", reason: expect.stringContaining("MUSE_EPISODIC_MEMORY_ENABLED") });

      // Enabled path — captures the episode.
      process.env.MUSE_EPISODIC_MEMORY_ENABLED = "true";
      const captured = await captureEndOfSessionEpisode({
        model: "stub",
        modelProvider: stubProvider,
        now: () => new Date("2026-05-13T08:15:00.000Z"),
        userId: "stark"
      });
      expect(captured.status).toBe("captured");
      if (captured.status !== "captured") return;
      expect(captured.episode).toMatchObject({
        endedAt: "2026-05-13T08:15:00.000Z",
        startedAt: "2026-05-13T08:00:00.000Z",
        summary: "Discussed Q3 budget memo. User decided to draft in Notion.",
        topics: ["Q3 budget memo", "Notion"],
        userId: "stark"
      });
      expect(captured.episode.id).toMatch(/^ep_/u);

      // The episode actually landed in `~/.muse/episodes.json` under
      // the same userId.
      const onDisk = JSON.parse(await fsp.readFile(path.join(root, ".muse", "episodes.json"), "utf8")) as {
        episodes: Array<{ id: string; summary: string; userId: string }>;
      };
      expect(onDisk.episodes).toHaveLength(1);
      expect(onDisk.episodes[0]).toMatchObject({ id: captured.episode.id, userId: "stark" });
    } finally {
      if (prevHome !== undefined) process.env.HOME = prevHome;
      else delete process.env.HOME;
      if (prevEnabled !== undefined) process.env.MUSE_EPISODIC_MEMORY_ENABLED = prevEnabled;
      else delete process.env.MUSE_EPISODIC_MEMORY_ENABLED;
    }
  });

  it("captureEndOfSessionEpisode gate accepts every standard truthy spelling (1 / yes / on / TRUE), not just the literal 'true' string", async () => {
    // Pre-fix `(env.MUSE_EPISODIC_MEMORY_ENABLED ?? "").trim().toLowerCase()
    // !== "true"` only matched the exact string "true". An operator
    // writing the natural `MUSE_EPISODIC_MEMORY_ENABLED=1` or `=yes`
    // in their shell rc — both of which `parseBoolean` from
    // @muse/autoconfigure already accepts — silently got episodic
    // memory disabled with no diagnostic. The gate now routes through
    // parseBoolean so the env var matches the established boolean-
    // spelling convention used by every other MUSE_*_ENABLED flag.
    const root = await mkdtemp(path.join(tmpdir(), "muse-eos-spelling-"));
    const prevHome = process.env.HOME;
    const prevEnabled = process.env.MUSE_EPISODIC_MEMORY_ENABLED;
    process.env.HOME = root;
    try {
      const { appendLastChatTurn, appendSessionBoundary } = await import("../src/chat-history.js");
      await appendSessionBoundary({ tsIso: "2026-05-13T08:00:00.000Z", userId: "stark" });
      await appendLastChatTurn({ message: "Plan Q3 memo", response: "Notion good" });

      const { captureEndOfSessionEpisode } = await import("../src/chat-end-session.js");
      const stubProvider = {
        id: "stub",
        listModels: async () => [],
        generate: async () => ({
          id: "stub-resp",
          model: "stub",
          output: "Discussed Q3 memo.\ntopics: Q3"
        }),
        stream: async function* () { /* not used */ }
      } as unknown as Parameters<typeof captureEndOfSessionEpisode>[0]["modelProvider"];

      for (const truthy of ["1", "yes", "on", "TRUE", "True"]) {
        process.env.MUSE_EPISODIC_MEMORY_ENABLED = truthy;
        const captured = await captureEndOfSessionEpisode({
          model: "stub",
          modelProvider: stubProvider,
          now: () => new Date("2026-05-13T08:15:00.000Z"),
          userId: "stark"
        });
        expect(
          captured.status,
          `expected the captureEndOfSessionEpisode gate to accept MUSE_EPISODIC_MEMORY_ENABLED=${JSON.stringify(truthy)}, got ${JSON.stringify(captured)}`
        ).toBe("captured");
      }

      // Unknown spellings still produce a `skipped` (fail-safe), and
      // the skip reason still names the env var so existing telemetry
      // greps keep working.
      for (const not of ["maybe", "perhaps", ""]) {
        process.env.MUSE_EPISODIC_MEMORY_ENABLED = not;
        const skipped = await captureEndOfSessionEpisode({
          model: "stub",
          modelProvider: stubProvider,
          userId: "stark"
        });
        expect(skipped).toMatchObject({
          reason: expect.stringContaining("MUSE_EPISODIC_MEMORY_ENABLED"),
          status: "skipped"
        });
      }
    } finally {
      if (prevHome !== undefined) process.env.HOME = prevHome;
      else delete process.env.HOME;
      if (prevEnabled !== undefined) process.env.MUSE_EPISODIC_MEMORY_ENABLED = prevEnabled;
      else delete process.env.MUSE_EPISODIC_MEMORY_ENABLED;
    }
  });

  it("captureEndOfSessionEpisode scrubs LLM-generated summary + topics before write (goal 109)", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "muse-eos-redact-"));
    const fsp = await import("node:fs/promises");
    const prevHome = process.env.HOME;
    const prevEnabled = process.env.MUSE_EPISODIC_MEMORY_ENABLED;
    process.env.HOME = root;
    process.env.MUSE_EPISODIC_MEMORY_ENABLED = "true";
    try {
      const { appendLastChatTurn, appendSessionBoundary } = await import("../src/chat-history.js");
      await appendSessionBoundary({ tsIso: "2026-05-13T08:00:00.000Z", userId: "stark" });
      await appendLastChatTurn({ message: "Plan rotation", response: "ok" });

      const { captureEndOfSessionEpisode } = await import("../src/chat-end-session.js");

      // Stub provider hallucinates a credential into BOTH the summary
      // body AND a topic. Even though goal 108 made the input turns
      // clean, the LLM is free to invent a sk-/ghp- shape; goal 109's
      // post-summary scrub catches that.
      const stubProvider = {
        id: "stub",
        listModels: async () => [],
        generate: async () => ({
          id: "stub-resp",
          model: "stub",
          output: [
            "Discussed key rotation. Old key was sk-proj-abcdefghijklmnopqrstuvwxyz.",
            "topics: rotation, ghp_abcdefghijklmnopqrstuvwxyzABCDEF, security"
          ].join("\n")
        }),
        stream: async function* () { /* unused */ }
      } as unknown as Parameters<typeof captureEndOfSessionEpisode>[0]["modelProvider"];

      const captured = await captureEndOfSessionEpisode({
        model: "stub",
        modelProvider: stubProvider,
        now: () => new Date("2026-05-13T08:15:00.000Z"),
        userId: "stark"
      });
      expect(captured.status).toBe("captured");
      if (captured.status !== "captured") return;

      // In-memory episode object: secrets replaced with markers.
      expect(captured.episode.summary).not.toContain("sk-proj-abcdefghijklmnopqrstuvwxyz");
      expect(captured.episode.summary).toContain("[redacted-openai-key]");
      expect(captured.episode.summary).toContain("Discussed key rotation");
      expect(captured.episode.topics ?? []).toContain("[redacted-github-pat]");
      expect((captured.episode.topics ?? []).join(" ")).not.toContain("ghp_abcdefghijklmnopqrstuvwxyzABCDEF");
      // Other topics survive unchanged.
      expect(captured.episode.topics).toContain("rotation");
      expect(captured.episode.topics).toContain("security");

      // On-disk persistence carries the same scrubbed form.
      const onDisk = JSON.parse(await fsp.readFile(path.join(root, ".muse", "episodes.json"), "utf8")) as {
        episodes: Array<{ summary: string; topics?: string[] }>;
      };
      const persisted = onDisk.episodes[0]!;
      expect(persisted.summary).not.toContain("sk-proj-abcdefghijklmnopqrstuvwxyz");
      expect(persisted.summary).toContain("[redacted-openai-key]");
      expect((persisted.topics ?? []).join("|")).not.toContain("ghp_abcdefghijklmnopqrstuvwxyzABCDEF");
    } finally {
      if (prevHome !== undefined) process.env.HOME = prevHome;
      else delete process.env.HOME;
      if (prevEnabled !== undefined) process.env.MUSE_EPISODIC_MEMORY_ENABLED = prevEnabled;
      else delete process.env.MUSE_EPISODIC_MEMORY_ENABLED;
    }
  });

  it("captureEndOfSessionEpisode fails soft and writes nothing when the summariser errors", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "muse-eos-soft-"));
    const fsp = await import("node:fs/promises");
    const prevHome = process.env.HOME;
    const prevEnabled = process.env.MUSE_EPISODIC_MEMORY_ENABLED;
    process.env.HOME = root;
    process.env.MUSE_EPISODIC_MEMORY_ENABLED = "true";
    try {
      const { appendLastChatTurn, appendSessionBoundary } = await import("../src/chat-history.js");
      await appendSessionBoundary({ tsIso: "2026-05-13T08:00:00.000Z", userId: "stark" });
      await appendLastChatTurn({ message: "Hi", response: "Hello" });

      const { captureEndOfSessionEpisode } = await import("../src/chat-end-session.js");
      const errorProvider = {
        id: "err",
        listModels: async () => [],
        generate: async () => { throw new Error("model down"); },
        stream: async function* () { /* not used */ }
      } as unknown as Parameters<typeof captureEndOfSessionEpisode>[0]["modelProvider"];

      const result = await captureEndOfSessionEpisode({
        model: "stub",
        modelProvider: errorProvider,
        userId: "stark"
      });
      expect(result).toMatchObject({
        status: "skipped",
        reason: expect.stringContaining("summariser returned undefined")
      });

      // No episodes.json should have been written.
      await expect(fsp.readFile(path.join(root, ".muse", "episodes.json"), "utf8")).rejects.toThrow();
    } finally {
      if (prevHome !== undefined) process.env.HOME = prevHome;
      else delete process.env.HOME;
      if (prevEnabled !== undefined) process.env.MUSE_EPISODIC_MEMORY_ENABLED = prevEnabled;
      else delete process.env.MUSE_EPISODIC_MEMORY_ENABLED;
    }
  });

  it("captureEndOfSessionEpisode skips when current session has no turns or no boundary", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "muse-eos-empty-"));
    const prevHome = process.env.HOME;
    const prevEnabled = process.env.MUSE_EPISODIC_MEMORY_ENABLED;
    process.env.HOME = root;
    process.env.MUSE_EPISODIC_MEMORY_ENABLED = "true";
    try {
      const { captureEndOfSessionEpisode } = await import("../src/chat-end-session.js");
      const provider = {
        id: "p",
        listModels: async () => [],
        generate: async () => ({ id: "x", model: "p", output: "Summary.\ntopics: x" }),
        stream: async function* () { /* not used */ }
      } as unknown as Parameters<typeof captureEndOfSessionEpisode>[0]["modelProvider"];

      // No file at all → no boundary, no turns.
      const result1 = await captureEndOfSessionEpisode({ model: "p", modelProvider: provider, userId: "stark" });
      expect(result1).toMatchObject({ status: "skipped", reason: expect.stringContaining("no current-session range") });

      // Boundary but no chat turns yet.
      const { appendSessionBoundary } = await import("../src/chat-history.js");
      await appendSessionBoundary({ tsIso: "2026-05-13T08:00:00.000Z", userId: "stark" });
      const result2 = await captureEndOfSessionEpisode({ model: "p", modelProvider: provider, userId: "stark" });
      expect(result2.status).toBe("skipped");
    } finally {
      if (prevHome !== undefined) process.env.HOME = prevHome;
      else delete process.env.HOME;
      if (prevEnabled !== undefined) process.env.MUSE_EPISODIC_MEMORY_ENABLED = prevEnabled;
      else delete process.env.MUSE_EPISODIC_MEMORY_ENABLED;
    }
  });

  it("muse episode list --json sorts newest-first, honours --user and --limit", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "muse-cli-episode-list-"));
    const episodesFile = path.join(root, "episodes.json");
    const fsp = await import("node:fs/promises");
    const prev = process.env.MUSE_EPISODES_FILE;
    process.env.MUSE_EPISODES_FILE = episodesFile;
    try {
      await fsp.writeFile(episodesFile, JSON.stringify({
        episodes: [
          { id: "ep_one", userId: "stark", startedAt: "2026-05-11T22:00:00Z", endedAt: "2026-05-11T22:18:00Z", summary: "S1", topics: ["a"] },
          { id: "ep_two", userId: "stark", startedAt: "2026-05-12T22:00:00Z", endedAt: "2026-05-12T22:18:00Z", summary: "S2" },
          { id: "ep_three", userId: "rhodey", startedAt: "2026-05-12T18:00:00Z", endedAt: "2026-05-12T18:30:00Z", summary: "S3" },
          { id: "ep_four", userId: "stark", startedAt: "2026-05-13T22:00:00Z", endedAt: "2026-05-13T22:18:00Z", summary: "S4" }
        ]
      }), "utf8");

      // Default — every entry, newest first.
      const { io: io1, output: out1 } = captureOutput();
      const program1 = createProgram({ ...io1, fetch: async () => { throw new Error("no fetch"); } });
      await program1.parseAsync(["node", "muse", "episode", "list", "--json"], { from: "node" });
      const listed1 = JSON.parse(out1.join("")) as { episodes: Array<{ id: string }>; total: number };
      expect(listed1.total).toBe(4);
      expect(listed1.episodes.map((e) => e.id)).toEqual(["ep_four", "ep_two", "ep_three", "ep_one"]);

      // --user filters
      const { io: io2, output: out2 } = captureOutput();
      const program2 = createProgram({ ...io2, fetch: async () => { throw new Error("no fetch"); } });
      await program2.parseAsync(["node", "muse", "episode", "list", "--user", "stark", "--json"], { from: "node" });
      const listed2 = JSON.parse(out2.join("")) as { episodes: Array<{ id: string; userId: string }>; total: number; userId: string };
      expect(listed2.userId).toBe("stark");
      expect(listed2.total).toBe(3);
      expect(listed2.episodes.every((e) => e.userId === "stark")).toBe(true);

      // --limit caps the slice
      const { io: io3, output: out3 } = captureOutput();
      const program3 = createProgram({ ...io3, fetch: async () => { throw new Error("no fetch"); } });
      await program3.parseAsync(["node", "muse", "episode", "list", "--limit", "2", "--json"], { from: "node" });
      const listed3 = JSON.parse(out3.join("")) as { total: number; episodes: Array<{ id: string }> };
      expect(listed3.total).toBe(2);
      expect(listed3.episodes.map((e) => e.id)).toEqual(["ep_four", "ep_two"]);
    } finally {
      if (prev !== undefined) process.env.MUSE_EPISODES_FILE = prev;
      else delete process.env.MUSE_EPISODES_FILE;
    }
  });

  it("muse episode show resolves an unambiguous prefix; rejects ambiguous prefixes", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "muse-cli-episode-show-"));
    const episodesFile = path.join(root, "episodes.json");
    const fsp = await import("node:fs/promises");
    const prev = process.env.MUSE_EPISODES_FILE;
    process.env.MUSE_EPISODES_FILE = episodesFile;
    try {
      await fsp.writeFile(episodesFile, JSON.stringify({
        episodes: [
          { id: "ep_alpha", userId: "stark", startedAt: "2026-05-12T22:00:00Z", endedAt: "2026-05-12T22:18:00Z", summary: "A", topics: ["alpha"] },
          { id: "ep_ambig_one", userId: "stark", startedAt: "2026-05-11T22:00:00Z", endedAt: "2026-05-11T22:18:00Z", summary: "B" },
          { id: "ep_ambig_two", userId: "stark", startedAt: "2026-05-10T22:00:00Z", endedAt: "2026-05-10T22:18:00Z", summary: "C" }
        ]
      }), "utf8");

      const { io: io1, output: out1 } = captureOutput();
      const program1 = createProgram({ ...io1, fetch: async () => { throw new Error("no fetch"); } });
      await program1.parseAsync(["node", "muse", "episode", "show", "ep_alpha", "--json"], { from: "node" });
      const shown = JSON.parse(out1.join("")) as { id: string; summary: string; topics?: string[] };
      expect(shown.id).toBe("ep_alpha");
      expect(shown.summary).toBe("A");
      expect(shown.topics).toEqual(["alpha"]);

      const { io: io2 } = captureOutput();
      const program2 = createProgram({ ...io2, fetch: async () => { throw new Error("no fetch"); } });
      program2.exitOverride();
      await expect(program2.parseAsync(["node", "muse", "episode", "show", "ep_ambig"], { from: "node" }))
        .rejects.toThrow(/Ambiguous episode id/u);
    } finally {
      if (prev !== undefined) process.env.MUSE_EPISODES_FILE = prev;
      else delete process.env.MUSE_EPISODES_FILE;
    }
  });

  it("muse search --json routes through SearXNG when MUSE_SEARXNG_URL is set; falls through to DDG when SearXNG fails", async () => {
    const originalFetch = globalThis.fetch;
    const prev = process.env.MUSE_SEARXNG_URL;
    try {
      // Path 1 — SearXNG primary.
      process.env.MUSE_SEARXNG_URL = "http://searx.test.local";
      globalThis.fetch = (async (input: RequestInfo | URL): Promise<Response> => {
        const url = String(input);
        if (url.startsWith("http://searx.test.local")) {
          return new Response(JSON.stringify({
            results: [
              { title: "Searx First", url: "https://example.com/a", content: "first body" },
              { title: "Searx Second", url: "https://example.com/b", content: "second body" }
            ]
          }), { status: 200 });
        }
        throw new Error("DDG should not be called when SearXNG returns hits");
      }) as typeof globalThis.fetch;

      const { io: io1, output: out1 } = captureOutput();
      const program1 = createProgram({ ...io1, fetch: async () => { throw new Error("api fetch off"); } });
      await program1.parseAsync(["node", "muse", "search", "muse", "personal", "agent", "--json"], { from: "node" });
      const r1 = JSON.parse(out1.join("")) as { backend: string; total: number; results: Array<{ url: string }> };
      expect(r1.backend).toBe("searxng");
      expect(r1.total).toBe(2);
      expect(r1.results.map((r) => r.url)).toEqual(["https://example.com/a", "https://example.com/b"]);

      // Path 2 — SearXNG returns zero hits → DDG fallback runs.
      globalThis.fetch = (async (input: RequestInfo | URL): Promise<Response> => {
        const url = String(input);
        if (url.startsWith("http://searx.test.local")) {
          return new Response(JSON.stringify({ results: [] }), { status: 200 });
        }
        // DDG HTML response with one parseable row.
        return new Response(
          `<a rel="nofollow" class="result__a" href="https://ddg.example/x">DDG hit</a>` +
          `<a class="result__snippet" href="x">snippet text</a>`,
          { status: 200 }
        );
      }) as typeof globalThis.fetch;

      const { io: io2, output: out2 } = captureOutput();
      const program2 = createProgram({ ...io2, fetch: async () => { throw new Error("api fetch off"); } });
      await program2.parseAsync(["node", "muse", "search", "anything", "--json"], { from: "node" });
      const r2 = JSON.parse(out2.join("")) as { backend: string; total: number; results: Array<{ url: string }> };
      expect(r2.backend).toBe("duckduckgo");
      expect(r2.total).toBe(1);
      expect(r2.results[0]!.url).toBe("https://ddg.example/x");
    } finally {
      globalThis.fetch = originalFetch;
      if (prev !== undefined) process.env.MUSE_SEARXNG_URL = prev;
      else delete process.env.MUSE_SEARXNG_URL;
    }
  });

  it("muse search formatted output (no --json) renders backend banner + numbered result block", async () => {
    const originalFetch = globalThis.fetch;
    const prev = process.env.MUSE_SEARXNG_URL;
    try {
      delete process.env.MUSE_SEARXNG_URL;
      globalThis.fetch = (async (): Promise<Response> => {
        return new Response(
          `<a rel="nofollow" class="result__a" href="https://example.com/one">First Result</a>` +
          `<a class="result__snippet" href="x">first snippet body</a>` +
          `<a rel="nofollow" class="result__a" href="https://example.com/two">Second Result</a>` +
          `<a class="result__snippet" href="y">second snippet body</a>`,
          { status: 200 }
        );
      }) as typeof globalThis.fetch;

      const { io, output } = captureOutput();
      const program = createProgram({ ...io, fetch: async () => { throw new Error("api fetch off"); } });
      await program.parseAsync(["node", "muse", "search", "test query"], { from: "node" });
      const text = output.join("");
      // Goal 065 — banner now includes backend latency.
      expect(text).toMatch(/\(2 result\(s\) via duckduckgo — \d+ ms\)/);
      expect(text).toContain("[1] First Result");
      expect(text).toContain("https://example.com/one");
      expect(text).toContain("first snippet body");
      expect(text).toContain("[2] Second Result");
    } finally {
      globalThis.fetch = originalFetch;
      if (prev !== undefined) process.env.MUSE_SEARXNG_URL = prev;
      else delete process.env.MUSE_SEARXNG_URL;
    }
  });

  it("HISTORY_KIND_ICONS surfaces one ASCII glyph per kind for quick scanning (goal 063)", async () => {
    const { HISTORY_KIND_ICONS } = await import("../src/commands-history.js");
    // Every documented kind has a glyph.
    expect(HISTORY_KIND_ICONS["reminder"]).toBe("(R)");
    expect(HISTORY_KIND_ICONS["proactive"]).toBe("(P)");
    expect(HISTORY_KIND_ICONS["followup"]).toBe("(F)");
    expect(HISTORY_KIND_ICONS["pattern"]).toBe("(*)");
    expect(HISTORY_KIND_ICONS["episode"]).toBe("(E)");
    // Glyphs stay ASCII-only (no emoji per CLAUDE.md) so they
    // render in every terminal + CI without falling back.
    for (const v of Object.values(HISTORY_KIND_ICONS)) {
      expect(/^[\x20-\x7E]+$/u.test(v)).toBe(true);
    }
  });

  it("formatRelativeTime renders past + future deltas and falls back to ISO past 7 days (goal 062)", async () => {
    const { formatRelativeTime } = await import("../src/human-formatters.js");
    const now = new Date("2026-05-14T12:00:00Z");
    // Same moment → "just now" / "in a moment" (depending on sign).
    const sameMoment = formatRelativeTime("2026-05-14T12:00:00Z", now);
    expect(sameMoment === "just now" || sameMoment === "in a moment").toBe(true);
    // Minutes.
    expect(formatRelativeTime("2026-05-14T11:45:00Z", now)).toBe("15m ago");
    expect(formatRelativeTime("2026-05-14T12:30:00Z", now)).toBe("in 30m");
    // Hours.
    expect(formatRelativeTime("2026-05-14T08:00:00Z", now)).toBe("4h ago");
    // Days.
    expect(formatRelativeTime("2026-05-12T12:00:00Z", now)).toBe("2d ago");
    // Past 7 days → falls back to absolute formatter (presence of '-' is enough,
    // we don't care about the exact local-zone string).
    const distant = formatRelativeTime("2024-01-01T00:00:00Z", now);
    expect(distant).toContain("2024");
    // Invalid input returns the original string.
    expect(formatRelativeTime("not-a-date", now)).toBe("not-a-date");
    // Non-boundary seconds tier still reads in seconds.
    expect(formatRelativeTime("2026-05-14T11:59:15Z", now)).toBe("45s ago");
    // Upper-boundary rounding must PROMOTE, never emit an
    // out-of-range unit count ("60s"/"60m"/"24h").
    expect(formatRelativeTime("2026-05-14T11:59:00.400Z", now)).toBe("1m ago");   // 59.6s
    expect(formatRelativeTime("2026-05-14T11:00:18Z", now)).toBe("1h ago");       // 59.7m
    expect(formatRelativeTime("2026-05-13T12:18:00Z", now)).toBe("1d ago");       // 23.7h
    expect(formatRelativeTime("2026-05-14T12:00:59.600Z", now)).toBe("in 1m");    // +59.6s
  });

  it("muse status --json carries schemaVersion (goal 064)", async () => {
    const { MUSE_STATUS_SCHEMA_VERSION } = await import("../src/commands-status.js");
    expect(MUSE_STATUS_SCHEMA_VERSION).toBe(1);
    const { io, output } = captureOutput();
    const program = createProgram({ ...io, fetch: async () => { throw new Error("no fetch"); } });
    await program.parseAsync(["node", "muse", "status", "--user", "schema-probe", "--json"], { from: "node" });
    const parsed = JSON.parse(output.join("")) as { schemaVersion?: number };
    expect(parsed.schemaVersion).toBe(MUSE_STATUS_SCHEMA_VERSION);
  });

  it("resolveLockUntilMs honours --hours + --minutes and defaults to 1h on zero (goal 052)", async () => {
    const { resolveLockUntilMs } = await import("../src/commands-session.js");
    const now = 1_000_000_000_000; // arbitrary fixed epoch
    // Default → +1h.
    expect(resolveLockUntilMs(undefined, undefined, now) - now).toBe(60 * 60_000);
    // --hours 2 → +2h.
    expect(resolveLockUntilMs("2", undefined, now) - now).toBe(2 * 60 * 60_000);
    // --minutes 30 → +30m.
    expect(resolveLockUntilMs(undefined, "30", now) - now).toBe(30 * 60_000);
    // Both combine.
    expect(resolveLockUntilMs("1", "30", now) - now).toBe(90 * 60_000);
    // Decimal hours.
    expect(resolveLockUntilMs("0.5", undefined, now) - now).toBe(30 * 60_000);
    // Negatives reject.
    expect(() => resolveLockUntilMs("-1", undefined, now)).toThrow();
    expect(() => resolveLockUntilMs(undefined, "-5", now)).toThrow();
    // Non-numeric rejects.
    expect(() => resolveLockUntilMs("abc", undefined, now)).toThrow();
    // Goal 155 — unit-slip rejects strictly (pre-iter Number.parseFloat
    // silently parsed "4h" → 4; now Number() returns NaN → throws).
    expect(() => resolveLockUntilMs("4h", undefined, now)).toThrow("--hours must be numeric");
    expect(() => resolveLockUntilMs(undefined, "30m", now)).toThrow("--minutes must be numeric");
    // Whitespace + empty string still treated as "not supplied" (no throw).
    expect(resolveLockUntilMs("  ", undefined, now) - now).toBe(60 * 60_000);
  });

  it("formatRemainingDuration renders 'Xh Ym' / 'X min' / '<1 min' (goal 141)", async () => {
    const { formatRemainingDuration } = await import("../src/commands-session.js");
    // Sub-1 minute clamps so a near-expired lock doesn't show "0 min".
    expect(formatRemainingDuration(0)).toBe("<1 min");
    expect(formatRemainingDuration(0.5)).toBe("<1 min");
    expect(formatRemainingDuration(-3)).toBe("<1 min");
    expect(formatRemainingDuration(Number.NaN)).toBe("<1 min");
    // Plain minutes.
    expect(formatRemainingDuration(5)).toBe("5 min");
    expect(formatRemainingDuration(59)).toBe("59 min");
    // Whole hours.
    expect(formatRemainingDuration(60)).toBe("1h");
    expect(formatRemainingDuration(120)).toBe("2h");
    // Mixed.
    expect(formatRemainingDuration(75)).toBe("1h 15m");
    expect(formatRemainingDuration(150)).toBe("2h 30m");
    expect(formatRemainingDuration(539)).toBe("8h 59m");
    // Rounding lands on the nearest minute.
    expect(formatRemainingDuration(59.6)).toBe("1h");
    expect(formatRemainingDuration(89.4)).toBe("1h 29m");
  });

  it("muse session lock / unlock / status round-trip writes + reads the marker (goal 052)", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "muse-cli-session-"));
    const lockFile = path.join(root, "session-lock.json");
    const prev = process.env.MUSE_SESSION_LOCK_FILE;
    process.env.MUSE_SESSION_LOCK_FILE = lockFile;
    try {
      // status when no file exists → unlocked.
      const { io: io0, output: out0 } = captureOutput();
      const p0 = createProgram({ ...io0, fetch: async () => { throw new Error("no fetch"); } });
      await p0.parseAsync(["node", "muse", "session", "status", "--json"], { from: "node" });
      const r0 = JSON.parse(out0.join("")) as { active: boolean; expired: boolean };
      expect(r0.active).toBe(false);
      expect(r0.expired).toBe(false);

      // lock --hours 2 --reason "deep work" → marker on disk.
      const { io: io1, output: out1 } = captureOutput();
      const p1 = createProgram({ ...io1, fetch: async () => { throw new Error("no fetch"); } });
      await p1.parseAsync(["node", "muse", "session", "lock", "--hours", "2", "--reason", "deep work", "--json"], { from: "node" });
      const written = JSON.parse(out1.join("")) as { until: string; setAt: string; reason: string };
      expect(written.reason).toBe("deep work");
      expect(new Date(written.until).getTime()).toBeGreaterThan(Date.now() + 60 * 60_000);

      // status reads the marker as active.
      const { io: io2, output: out2 } = captureOutput();
      const p2 = createProgram({ ...io2, fetch: async () => { throw new Error("no fetch"); } });
      await p2.parseAsync(["node", "muse", "session", "status", "--json"], { from: "node" });
      const r2 = JSON.parse(out2.join("")) as { active: boolean; minutesRemaining: number };
      expect(r2.active).toBe(true);
      expect(r2.minutesRemaining).toBeGreaterThan(60);

      // unlock removes it.
      const { io: io3, output: out3 } = captureOutput();
      const p3 = createProgram({ ...io3, fetch: async () => { throw new Error("no fetch"); } });
      await p3.parseAsync(["node", "muse", "session", "unlock", "--json"], { from: "node" });
      const r3 = JSON.parse(out3.join("")) as { cleared: boolean };
      expect(r3.cleared).toBe(true);

      // status again → unlocked.
      const { io: io4, output: out4 } = captureOutput();
      const p4 = createProgram({ ...io4, fetch: async () => { throw new Error("no fetch"); } });
      await p4.parseAsync(["node", "muse", "session", "status", "--json"], { from: "node" });
      const r4 = JSON.parse(out4.join("")) as { active: boolean };
      expect(r4.active).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.MUSE_SESSION_LOCK_FILE;
      else process.env.MUSE_SESSION_LOCK_FILE = prev;
    }
  });

  it("groupToolsByDomain buckets entries by prefix and lands dot-less names in (unscoped) (goal 053)", async () => {
    const { groupToolsByDomain } = await import("../src/commands-trust.js");
    const grouped = groupToolsByDomain([
      "notion.notes.search",
      "notion.tasks.add",
      "notion.notes.read",
      "gcal.events.list",
      "rawtoolname"
    ]);
    expect(Object.keys(grouped).sort()).toEqual(["(unscoped)", "gcal", "notion"]);
    expect(grouped["notion"]).toEqual(["notion.notes.search", "notion.tasks.add", "notion.notes.read"]);
    expect(grouped["gcal"]).toEqual(["gcal.events.list"]);
    expect(grouped["(unscoped)"]).toEqual(["rawtoolname"]);
    // Empty input → empty record (no implicit (unscoped) bucket).
    expect(groupToolsByDomain([])).toEqual({});
  });

  it("muse with no subcommand prints help instead of erroring (goal 060)", async () => {
    const { io, output } = captureOutput();
    const program = createProgram({ ...io, fetch: async () => { throw new Error("no fetch"); } });
    await program.parseAsync(["node", "muse"], { from: "node" });
    const text = output.join("");
    // commander's outputHelp produces a Usage banner + Commands section.
    expect(text).toContain("Usage:");
    expect(text).toContain("muse");
    // A handful of real subcommands the user could discover.
    expect(text).toContain("status");
    expect(text).toContain("history");
    // Goal 099 — the fallback `[unknown_subcommand]` argument must
    // not leak into the usage banner; "muse [options] [command]"
    // stays canonical.
    expect(text).not.toContain("[unknown_subcommand]");
  });

  it("muse <typo> prints 'Did you mean ...' and exits non-zero (goal 099)", async () => {
    const prevExitCode = process.exitCode;
    process.exitCode = 0;
    try {
      const { io, output } = captureOutput();
      const program = createProgram({ ...io, fetch: async () => { throw new Error("no fetch"); } });
      await program.parseAsync(["node", "muse", "statu"], { from: "node" });
      const text = output.join("");
      expect(text).toContain("unknown command 'statu'");
      expect(text).toContain("Did you mean 'muse status'?");
      expect(text).toContain("muse --help");
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = prevExitCode;
    }
  });

  it("muse <unrelated-arg> errors without a misleading suggestion (goal 099)", async () => {
    const prevExitCode = process.exitCode;
    process.exitCode = 0;
    try {
      const { io, output } = captureOutput();
      const program = createProgram({ ...io, fetch: async () => { throw new Error("no fetch"); } });
      await program.parseAsync(["node", "muse", "totally-unrelated-input"], { from: "node" });
      const text = output.join("");
      expect(text).toContain("unknown command 'totally-unrelated-input'");
      expect(text).not.toContain("Did you mean");
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = prevExitCode;
    }
  });

  it("muse <unique-prefix> suggests the command Levenshtein would miss (e.g. 'cal' → 'calendar')", async () => {
    const prevExitCode = process.exitCode;
    process.exitCode = 0;
    try {
      const { io, output } = captureOutput();
      const program = createProgram({ ...io, fetch: async () => { throw new Error("no fetch"); } });
      await program.parseAsync(["node", "muse", "cal"], { from: "node" });
      const text = output.join("");
      expect(text).toContain("unknown command 'cal'");
      expect(text).toContain("Did you mean 'muse calendar'?");
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = prevExitCode;
    }
  });

  it("muse <ambiguous-prefix> stays silent rather than guessing (e.g. 're')", async () => {
    const prevExitCode = process.exitCode;
    process.exitCode = 0;
    try {
      const { io, output } = captureOutput();
      const program = createProgram({ ...io, fetch: async () => { throw new Error("no fetch"); } });
      await program.parseAsync(["node", "muse", "re"], { from: "node" });
      const text = output.join("");
      expect(text).toContain("unknown command 're'");
      expect(text).not.toContain("Did you mean");
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = prevExitCode;
    }
  });

  it("compileHistoryGrep treats input as regex first, falls back to substring on metacharacter errors (goal 050)", async () => {
    const { compileHistoryGrep } = await import("../src/commands-history.js");
    // Plain substring matches the literal anywhere.
    const plain = compileHistoryGrep("budget", false);
    expect(plain.test("Q3 budget memo")).toBe(true);
    expect(plain.test("BUDGET review")).toBe(true);
    expect(plain.test("calendar")).toBe(false);

    // Regex metacharacters honoured when valid.
    const meta = compileHistoryGrep("^bug-\\d+", false);
    expect(meta.test("bug-12 still open")).toBe(true);
    expect(meta.test("Q3 bug-12")).toBe(false); // anchored

    // --case-sensitive flips the flag.
    const strict = compileHistoryGrep("Budget", true);
    expect(strict.test("Q3 Budget memo")).toBe(true);
    expect(strict.test("Q3 budget memo")).toBe(false);

    // Invalid regex falls back to literal substring.
    const broken = compileHistoryGrep("(unclosed", false);
    expect(broken.test("contains (unclosed paren")).toBe(true);
  });

  it("listMuseImportEntries + findImportCollisions round-trip an exported bundle correctly (goal 049)", async () => {
    const { buildMuseExport } = await import("../src/commands-export.js");
    const { listMuseImportEntries, findImportCollisions } = await import("../src/commands-import.js");
    const root = await mkdtemp(path.join(tmpdir(), "muse-cli-import-"));
    const fsp = await import("node:fs/promises");
    const museDir = path.join(root, "src", ".muse");
    const notesDir = path.join(museDir, "notes");
    await fsp.mkdir(museDir, { recursive: true });
    await fsp.mkdir(notesDir, { recursive: true });
    await fsp.writeFile(path.join(museDir, "tasks.json"), JSON.stringify({ tasks: [] }));
    await fsp.writeFile(path.join(museDir, "reminders.json"), JSON.stringify({ reminders: [] }));
    await fsp.writeFile(path.join(notesDir, "a.md"), "hi");
    const bundle = path.join(root, "bundle.tar.gz");
    await buildMuseExport({ museDir, notesDir, outputPath: bundle });

    // listMuseImportEntries filters to .muse/* file entries only.
    const entries = await listMuseImportEntries(bundle);
    expect(entries.length).toBeGreaterThan(0);
    for (const e of entries) {
      expect(e.startsWith(".muse/")).toBe(true);
      expect(e.endsWith("/")).toBe(false);
    }
    // Contains the two stores + the note file + the README.
    expect(entries).toContain(".muse/tasks.json");
    expect(entries).toContain(".muse/reminders.json");
    expect(entries.some((e) => e === ".muse/notes/a.md")).toBe(true);

    // findImportCollisions against a clean home directory: zero.
    const cleanHome = path.join(root, "clean-home");
    await fsp.mkdir(cleanHome, { recursive: true });
    expect(await findImportCollisions(cleanHome, entries)).toEqual([]);

    // findImportCollisions against a home that already has one
    // matching file flags it as a collision (prefix stripped).
    const conflictHome = path.join(root, "conflict-home");
    await fsp.mkdir(path.join(conflictHome, ".muse"), { recursive: true });
    await fsp.writeFile(path.join(conflictHome, ".muse", "tasks.json"), "{}");
    const collisions = await findImportCollisions(conflictHome, entries);
    expect(collisions).toContain("tasks.json");
    expect(collisions).not.toContain("reminders.json");
  });

  it("isSafeMuseEntry rejects path-traversal + non-.muse entries a hostile bundle could carry (goal 238)", async () => {
    const { isSafeMuseEntry } = await import("../src/commands-import.js");
    // Legit export entries pass.
    expect(isSafeMuseEntry(".muse/tasks.json")).toBe(true);
    expect(isSafeMuseEntry(".muse/notes/2026/a.md")).toBe(true);
    // `..` only as a substring inside a segment is not a traversal.
    expect(isSafeMuseEntry(".muse/weird..name/x.json")).toBe(true);
    // Path traversal: starts with `.muse/` yet escapes the target.
    expect(isSafeMuseEntry(".muse/../../.ssh/authorized_keys")).toBe(false);
    expect(isSafeMuseEntry(".muse/notes/../../../etc/cron.d/x")).toBe(false);
    expect(isSafeMuseEntry(".muse/..")).toBe(false);
    // `..`-free but outside `.muse/` — lands straight in $HOME.
    expect(isSafeMuseEntry(".bashrc")).toBe(false);
    expect(isSafeMuseEntry(".ssh/authorized_keys")).toBe(false);
    expect(isSafeMuseEntry("/etc/passwd")).toBe(false);
    // Directory entries are not restored (files only); empty rejects.
    expect(isSafeMuseEntry(".muse/notes/")).toBe(false);
    expect(isSafeMuseEntry("")).toBe(false);
    // Backslash-laden traversal: on Windows the path module treats `\`
    // as a separator and would resolve `.muse/foo\..\..\etc` to outside
    // the target dir. The split-by-`/` check alone misses this; reject
    // any entry containing a backslash defensively.
    expect(isSafeMuseEntry(".muse/foo\\..\\..\\etc/passwd")).toBe(false);
    expect(isSafeMuseEntry(".muse\\notes\\file.json")).toBe(false);
    expect(isSafeMuseEntry(".muse/has\\backslash.json")).toBe(false);
  });

  it("extractMuseBundle restores only the vetted members — a malicious bundle can't escape ~/.muse (goal 238)", async () => {
    const { extractMuseBundle, listMuseImportEntries } = await import("../src/commands-import.js");
    const { promisify } = await import("node:util");
    const { execFile } = await import("node:child_process");
    const run = promisify(execFile);
    const fsp = await import("node:fs/promises");
    const root = await mkdtemp(path.join(tmpdir(), "muse-cli-import-evil-"));
    const stage = path.join(root, "stage");
    await fsp.mkdir(path.join(stage, ".muse"), { recursive: true });
    await fsp.writeFile(path.join(stage, ".muse", "keep.json"), '{"ok":true}');
    // A `..`-free escape: a top-level file lands directly in the
    // extraction target under a blanket `tar -xzf -C home`.
    await fsp.writeFile(path.join(stage, "pwned.txt"), "owned");
    const bundle = path.join(root, "evil.tar.gz");
    await run("tar", ["-czf", bundle, "-C", stage, ".muse/keep.json", "pwned.txt"]);

    // The crafted bundle does carry the escape entry, but the vetted
    // list filters it out — extraction must honour only that list.
    const entries = await listMuseImportEntries(bundle);
    expect(entries).toEqual([".muse/keep.json"]);

    const home = path.join(root, "home");
    await fsp.mkdir(home, { recursive: true });
    await extractMuseBundle(bundle, home, entries);

    expect(await fsp.readFile(path.join(home, ".muse", "keep.json"), "utf8")).toBe('{"ok":true}');
    await expect(fsp.stat(path.join(home, "pwned.txt"))).rejects.toThrow();
  });

  it("rotateJwtState promotes a new current + grace-windows the previous secret (goal 082)", async () => {
    const { rotateJwtState, pruneExpiredPreviousSecrets } = await import("../src/jwt-rotation-store.js");
    const now = new Date("2026-05-14T12:00:00Z");

    // Fresh rotation with no prior state + no fallback → bootstrap.
    const bootstrap = rotateJwtState({
      state: undefined,
      now,
      graceMs: 24 * 60 * 60 * 1000,
      secretFactory: () => "a".repeat(64)
    });
    expect(bootstrap.current).toBe("a".repeat(64));
    expect(bootstrap.previous).toEqual([]);

    // Rotation with prior state pushes the old current onto previous.
    const rotated = rotateJwtState({
      state: bootstrap,
      now,
      graceMs: 1 * 60 * 60 * 1000,
      secretFactory: () => "b".repeat(64)
    });
    expect(rotated.current).toBe("b".repeat(64));
    expect(rotated.previous.length).toBe(1);
    expect(rotated.previous[0]?.secret).toBe("a".repeat(64));
    expect(new Date(rotated.previous[0]?.validUntil ?? "").getTime() - now.getTime()).toBe(60 * 60_000);

    // Prune drops entries whose validUntil has passed.
    const past = new Date(now.getTime() + 2 * 60 * 60_000); // 2h later
    const pruned = pruneExpiredPreviousSecrets(rotated, past);
    expect(pruned.previous.length).toBe(0);

    // Future-rotated entries stay.
    const futurePruned = pruneExpiredPreviousSecrets(rotated, now);
    expect(futurePruned.previous.length).toBe(1);
  });

  it("muse auth rotate-jwt writes the state file + grace-windows old env-only secret (goal 082)", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "muse-cli-rotate-jwt-"));
    const file = path.join(root, "auth-secrets.json");
    const prev = {
      secrets: process.env.MUSE_AUTH_SECRETS_FILE,
      jwt: process.env.MUSE_AUTH_JWT_SECRET
    };
    process.env.MUSE_AUTH_SECRETS_FILE = file;
    process.env.MUSE_AUTH_JWT_SECRET = "Z".repeat(64);
    try {
      const { io, output } = captureOutput();
      const program = createProgram({ ...io, fetch: async () => { throw new Error("no fetch"); } });
      await program.parseAsync(
        ["node", "muse", "auth", "rotate-jwt", "--grace-hours", "2", "--json"],
        { from: "node" }
      );
      const parsed = JSON.parse(output.join("")) as {
        current: string;
        previous: Array<{ secret: string; validUntil: string }>;
      };
      expect(parsed.current).not.toBe("Z".repeat(64)); // fresh secret
      expect(parsed.current.length).toBeGreaterThanOrEqual(32);
      expect(parsed.previous.length).toBe(1);
      expect(parsed.previous[0]?.secret).toBe("Z".repeat(64)); // env was grace-windowed
      const validUntilMs = new Date(parsed.previous[0]?.validUntil ?? "").getTime();
      const nowMs = Date.now();
      const graceMs = 2 * 60 * 60_000;
      expect(validUntilMs).toBeGreaterThan(nowMs);
      expect(validUntilMs).toBeLessThanOrEqual(nowMs + graceMs + 5_000);

      // Second rotation pushes the just-rotated value down.
      const { io: io2, output: out2 } = captureOutput();
      const program2 = createProgram({ ...io2, fetch: async () => { throw new Error("no fetch"); } });
      await program2.parseAsync(
        ["node", "muse", "auth", "rotate-jwt", "--grace-hours", "2", "--json"],
        { from: "node" }
      );
      const second = JSON.parse(out2.join("")) as { current: string; previous: Array<{ secret: string }> };
      expect(second.current).not.toBe(parsed.current);
      // The previous from round 1 is now at the head of `previous`.
      expect(second.previous[0]?.secret).toBe(parsed.current);
    } finally {
      if (prev.secrets === undefined) delete process.env.MUSE_AUTH_SECRETS_FILE;
      else process.env.MUSE_AUTH_SECRETS_FILE = prev.secrets;
      if (prev.jwt === undefined) delete process.env.MUSE_AUTH_JWT_SECRET;
      else process.env.MUSE_AUTH_JWT_SECRET = prev.jwt;
    }
  });

  it("wireReplGracefulExit fires its onSignal for SIGTERM (goal 072)", async () => {
    const { wireReplGracefulExit } = await import("../src/chat-repl.js");
    const sawSignals: NodeJS.Signals[] = [];
    const teardown = wireReplGracefulExit({
      onSignal: (sig) => { sawSignals.push(sig); }
    });
    process.emit("SIGTERM");
    expect(sawSignals).toEqual(["SIGTERM"]);
    teardown();
    // After teardown a follow-up SIGTERM doesn't re-fire (the
    // SIGINT once-handler was removed by teardown so this also
    // doesn't pollute later SIGINT-emitting tests).
    process.emit("SIGTERM");
    expect(sawSignals).toEqual(["SIGTERM"]);
  });

  it("buildIterm2InlineImageSequence + detectInlineImageSupport gate inline rendering correctly (goal 096)", async () => {
    const { buildIterm2InlineImageSequence, detectInlineImageSupport } = await import("../src/commands-show.js");

    // PNG header bytes — content is opaque to the helper, but a real image makes the test honest.
    const imageBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const sequence = buildIterm2InlineImageSequence({ imageBytes, name: "muse.png" });

    expect(sequence.startsWith("\x1b]1337;File=inline=1;name=")).toBe(true);
    expect(sequence.endsWith("\x07")).toBe(true);

    // Round-trip: split on `:`, base64-decode each side, expect original inputs back.
    const headerMatch = sequence.match(/^\x1b\]1337;File=inline=1;name=([^:]+):([^\x07]+)\x07$/);
    expect(headerMatch).not.toBeNull();
    expect(Buffer.from(headerMatch![1]!, "base64").toString("utf8")).toBe("muse.png");
    expect(Buffer.from(headerMatch![2]!, "base64").equals(imageBytes)).toBe(true);

    // Capability gate: only terminals honouring iTerm2 OSC-1337 → true.
    expect(detectInlineImageSupport({ TERM_PROGRAM: "iTerm.app" } as NodeJS.ProcessEnv)).toBe(true);
    expect(detectInlineImageSupport({ TERM_PROGRAM: "WezTerm" } as NodeJS.ProcessEnv)).toBe(true);
    expect(detectInlineImageSupport({ TERM_PROGRAM: "tabby" } as NodeJS.ProcessEnv)).toBe(true);
    // Kitty uses its own incompatible graphics protocol — must NOT
    // claim inline support (else its working viewer fallback is
    // suppressed and `muse show` is a silent no-op there).
    expect(detectInlineImageSupport({ TERM: "xterm-kitty" } as NodeJS.ProcessEnv)).toBe(false);
    // Goal 142 — Ghostty + VS Code integrated terminal both
    // implement the iTerm2 inline-image protocol natively.
    expect(detectInlineImageSupport({ TERM_PROGRAM: "ghostty" } as NodeJS.ProcessEnv)).toBe(true);
    expect(detectInlineImageSupport({ TERM_PROGRAM: "vscode" } as NodeJS.ProcessEnv)).toBe(true);
    expect(detectInlineImageSupport({ TERM_PROGRAM: "Apple_Terminal" } as NodeJS.ProcessEnv)).toBe(false);
    expect(detectInlineImageSupport({} as NodeJS.ProcessEnv)).toBe(false);
  });

  it("wrapForTmux wraps the OSC-1337 sequence in the tmux passthrough so it isn't swallowed inside tmux", async () => {
    const { buildIterm2InlineImageSequence, wrapForTmux } = await import("../src/commands-show.js");
    const seq = buildIterm2InlineImageSequence({ imageBytes: Buffer.from([0x89, 0x50]), name: "x.png" });

    // Outside tmux: byte-for-byte unchanged.
    expect(wrapForTmux(seq, false)).toBe(seq);

    // Inside tmux: ESC P tmux ; <doubled-ESC payload> ESC \
    const wrapped = wrapForTmux(seq, true);
    expect(wrapped.startsWith("\x1bPtmux;")).toBe(true);
    expect(wrapped.endsWith("\x1b\\")).toBe(true);
    // Every inner ESC must be doubled so tmux forwards it verbatim.
    expect(wrapped.includes("\x1b\x1b]1337")).toBe(true);
    // Unwrapping (strip envelope, halve the ESCs) recovers the original.
    const inner = wrapped.slice("\x1bPtmux;".length, -2).replace(/\x1b\x1b/gu, "\x1b");
    expect(inner).toBe(seq);
  });

  it("muse show rejects a 0-byte file with a clear error instead of emitting an empty inline sequence", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "muse-show-empty-"));
    const fsp = await import("node:fs/promises");
    const emptyPath = path.join(root, "empty.png");
    await fsp.writeFile(emptyPath, Buffer.alloc(0));

    const prevExit = process.exitCode;
    const prevTerm = process.env.TERM_PROGRAM;
    // iTerm so the inline path would otherwise emit the OSC-1337 bytes.
    process.env.TERM_PROGRAM = "iTerm.app";
    try {
      const { io, output } = captureOutput();
      const program = createProgram(io);
      process.exitCode = 0;
      await program.parseAsync(["node", "muse", "show", emptyPath], { from: "node" });
      const text = output.join("");
      expect(text).toContain("is empty (0 bytes)");
      // No inline-image escape sequence must have been emitted.
      expect(text).not.toContain("\x1b]1337;File=inline=1");
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = prevExit;
      if (prevTerm === undefined) delete process.env.TERM_PROGRAM;
      else process.env.TERM_PROGRAM = prevTerm;
    }
  });

  it("muse show rejects a non-image local file instead of emitting a broken inline sequence", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "muse-show-txt-"));
    const fsp = await import("node:fs/promises");
    const txtPath = path.join(root, "notes.png"); // .png extension but text bytes
    await fsp.writeFile(txtPath, "just some notes, definitely not an image\n");

    const prevExit = process.exitCode;
    const prevTerm = process.env.TERM_PROGRAM;
    process.env.TERM_PROGRAM = "iTerm.app"; // inline path would otherwise emit OSC-1337
    try {
      const { io, output } = captureOutput();
      const program = createProgram(io);
      process.exitCode = 0;
      await program.parseAsync(["node", "muse", "show", txtPath], { from: "node" });
      const text = output.join("");
      expect(text).toContain("doesn't look like an image");
      expect(text).not.toContain("\x1b]1337;File=inline=1");
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = prevExit;
      if (prevTerm === undefined) delete process.env.TERM_PROGRAM;
      else process.env.TERM_PROGRAM = prevTerm;
    }
  });

  it("suggestPatternHints surfaces patterns whose median hour matches now (goal 095)", async () => {
    const { suggestPatternHints } = await import("../src/commands-status.js");
    const now = new Date("2026-05-15T09:00:00Z"); // 09 UTC

    // 5 firings of "morning_tasks" at 09 UTC, 5 of "evening_tasks" at 22 UTC.
    const fired = [
      ...Array.from({ length: 5 }, (_, i) => ({
        patternId: "morning_tasks",
        firedAtIso: `2026-05-${(10 + i).toString().padStart(2, "0")}T09:0${i.toString()}:00Z`
      })),
      ...Array.from({ length: 5 }, (_, i) => ({
        patternId: "evening_tasks",
        firedAtIso: `2026-05-${(10 + i).toString().padStart(2, "0")}T22:0${i.toString()}:00Z`
      }))
    ];

    const hints = suggestPatternHints(fired, now);
    expect(hints.length).toBe(1);
    expect(hints[0]?.patternId).toBe("morning_tasks");
    expect(hints[0]?.medianHourUtc).toBe(9);
    expect(hints[0]?.firings).toBe(5);

    // Different "now" picks the other pattern.
    const evening = suggestPatternHints(fired, new Date("2026-05-15T22:00:00Z"));
    expect(evening[0]?.patternId).toBe("evening_tasks");

    // < 3 firings → ignored.
    expect(suggestPatternHints([
      { patternId: "rare", firedAtIso: "2026-05-15T09:00:00Z" },
      { patternId: "rare", firedAtIso: "2026-05-14T09:00:00Z" }
    ], now)).toEqual([]);

    // maxHints clamps when multiple patterns qualify.
    const many = Array.from({ length: 5 }, (_, i) => ({ patternId: "x", firedAtIso: `2026-05-10T09:0${i.toString()}:00Z` }));
    const both = [
      ...many,
      ...Array.from({ length: 5 }, (_, i) => ({ patternId: "y", firedAtIso: `2026-05-10T09:0${i.toString()}:00Z` }))
    ];
    expect(suggestPatternHints(both, now, { maxHints: 1 })).toHaveLength(1);

    const reordered = [
      ...Array.from({ length: 5 }, (_, i) => ({ patternId: "y", firedAtIso: `2026-05-10T09:0${i.toString()}:00Z` })),
      ...Array.from({ length: 5 }, (_, i) => ({ patternId: "x", firedAtIso: `2026-05-10T09:0${i.toString()}:00Z` }))
    ];
    const tiedReordered = suggestPatternHints(reordered, now);
    expect(tiedReordered.map((h) => h.patternId), "ties on firings resolve by patternId asc — independent of input insertion order").toEqual(["x", "y"]);

    // Malformed entries skipped silently.
    expect(suggestPatternHints([
      { patternId: 123 },
      { firedAtIso: "no-pattern" },
      null,
      "garbage"
    ] as unknown as readonly unknown[], now)).toEqual([]);
  });

  it("suggestPatternHints centres a midnight-straddling habit circularly (goal 254)", async () => {
    const { suggestPatternHints } = await import("../src/commands-status.js");
    // Six firings clustered around midnight: 23, 00, 01 UTC.
    const fired = ["23", "00", "01", "23", "00", "01"].map((hh, i) => ({
      patternId: "night_journal",
      firedAtIso: `2026-05-${(10 + i).toString().padStart(2, "0")}T${hh}:0${i.toString()}:00Z`
    }));

    // Plain numeric median of [23,0,1,23,0,1] is ~1; circular
    // centre is 00. At 23:50 the user is inside the habit window,
    // so the hint must surface (delta to 00 = 1, not 22).
    const lateNight = suggestPatternHints(fired, new Date("2026-05-16T23:50:00Z"));
    expect(lateNight.map((h) => h.patternId)).toContain("night_journal");
    const hint = lateNight.find((h) => h.patternId === "night_journal");
    expect([23, 0, 1]).toContain(hint?.medianHourUtc);

    // Mid-afternoon is well outside the circular window → no hint.
    expect(suggestPatternHints(fired, new Date("2026-05-16T15:00:00Z"))).toEqual([]);
  });

  it("persona store: read missing → default, switch active, custom preamble overrides built-in (goal 094)", async () => {
    const {
      BUILTIN_PERSONAS,
      isBuiltinPersonaId,
      personaIdIsKnown,
      readPersonaStore,
      writePersonaStore,
      resolveActivePersonaPreamble
    } = await import("../src/persona-store.js");
    const root = await mkdtemp(path.join(tmpdir(), "muse-persona-"));
    const file = path.join(root, "persona.json");

    // Built-in id detection.
    expect(isBuiltinPersonaId("jarvis")).toBe(true);
    expect(isBuiltinPersonaId("nonexistent")).toBe(false);
    // JARVIS preamble contains the "sir" address hint.
    const jarvis = BUILTIN_PERSONAS.find((p) => p.id === "jarvis");
    expect(jarvis?.preamble.toLowerCase()).toContain("sir");

    // Missing file → default.
    const empty = await readPersonaStore(file);
    expect(empty.activeId).toBe("default");
    expect(empty.custom).toEqual({});
    expect(resolveActivePersonaPreamble(empty)).toBe("");

    // Write + read round-trip.
    await writePersonaStore(file, {
      activeId: "jarvis",
      custom: { "tony": { preamble: "Speak like Tony Stark, sardonic and confident." } }
    });
    const round = await readPersonaStore(file);
    expect(round.activeId).toBe("jarvis");
    expect(round.custom["tony"]?.preamble).toContain("Tony Stark");

    // Active = jarvis → built-in preamble surfaces.
    expect(resolveActivePersonaPreamble(round).toLowerCase()).toContain("sir");

    // Custom preamble overrides built-in id (a user-defined
    // `jarvis` under `custom` wins over the built-in).
    const override = await readPersonaStore(file);
    const withOverride = {
      ...override,
      custom: { ...override.custom, jarvis: { preamble: "OVERRIDDEN" } }
    };
    expect(resolveActivePersonaPreamble(withOverride)).toBe("OVERRIDDEN");

    // personaIdIsKnown: built-in (incl. the empty `default`) + own
    // custom are known; a dangling/typo'd id is not.
    expect(personaIdIsKnown(round, "default")).toBe(true);
    expect(personaIdIsKnown(round, "jarvis")).toBe(true);
    expect(personaIdIsKnown(round, "tony")).toBe(true);
    expect(personaIdIsKnown(round, "tony-DELETED")).toBe(false);
    expect(personaIdIsKnown(round, "__proto__")).toBe(false);
  });

  it("muse persona show --id <id> previews any registered persona without switching active", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "muse-persona-show-preview-"));
    const file = path.join(root, "persona.json");
    const { writePersonaStore } = await import("../src/persona-store.js");
    await writePersonaStore(file, {
      activeId: "default",
      custom: { "tony": { preamble: "Sardonic, confident — Tony Stark voice." } }
    });
    const prev = process.env.MUSE_PERSONA_FILE;
    process.env.MUSE_PERSONA_FILE = file;
    const prevExitCode = process.exitCode;
    process.exitCode = 0;
    try {
      // Preview a built-in — active stays `default` in the store.
      const { io: ioBuiltin, output: outBuiltin } = captureOutput();
      const programBuiltin = createProgram({ ...ioBuiltin, fetch: async () => { throw new Error("no fetch"); } });
      await programBuiltin.parseAsync(["node", "muse", "persona", "show", "--id", "jarvis"], { from: "node" });
      const builtinText = outBuiltin.join("");
      expect(builtinText, "preview banner must distinguish from the active label").toContain("preview: jarvis (active is default)");
      expect(builtinText.toLowerCase()).toContain("sir");
      expect(process.exitCode).toBe(0);

      // Active in the store is still "default" — preview is non-destructive.
      const { readPersonaStore } = await import("../src/persona-store.js");
      const afterPreview = await readPersonaStore(file);
      expect(afterPreview.activeId, "preview must NOT mutate activeId").toBe("default");

      // Preview a custom — same shape.
      const { io: ioCustom, output: outCustom } = captureOutput();
      const programCustom = createProgram({ ...ioCustom, fetch: async () => { throw new Error("no fetch"); } });
      await programCustom.parseAsync(["node", "muse", "persona", "show", "--id", "tony"], { from: "node" });
      expect(outCustom.join("")).toContain("Sardonic, confident — Tony Stark voice.");

      // --json envelope carries previewingId when --id is set.
      const { io: ioJson, output: outJson } = captureOutput();
      const programJson = createProgram({ ...ioJson, fetch: async () => { throw new Error("no fetch"); } });
      await programJson.parseAsync(["node", "muse", "persona", "show", "--id", "jarvis", "--json"], { from: "node" });
      const json = JSON.parse(outJson.join("")) as { activeId: string; previewingId?: string; preamble: string };
      expect(json.activeId).toBe("default");
      expect(json.previewingId).toBe("jarvis");
      expect(json.preamble.toLowerCase()).toContain("sir");

      // Typo on --id surfaces the closest-command suggestion.
      const { io: ioTypo, output: outTypo } = captureOutput();
      const programTypo = createProgram({ ...ioTypo, fetch: async () => { throw new Error("no fetch"); } });
      process.exitCode = 0;
      await programTypo.parseAsync(["node", "muse", "persona", "show", "--id", "jarvss"], { from: "node" });
      expect(outTypo.join("")).toContain("no persona with id 'jarvss'");
      expect(outTypo.join("")).toContain("did you mean 'jarvis'?");
      expect(process.exitCode).toBe(1);

      // Without --id the existing active-show behavior is unchanged.
      process.exitCode = 0;
      const { io: ioActive, output: outActive } = captureOutput();
      const programActive = createProgram({ ...ioActive, fetch: async () => { throw new Error("no fetch"); } });
      await programActive.parseAsync(["node", "muse", "persona", "show"], { from: "node" });
      expect(outActive.join("")).toContain("active: default");
      expect(outActive.join(""), "no --id ⇒ no preview banner").not.toContain("preview:");
    } finally {
      process.exitCode = prevExitCode;
      if (prev === undefined) delete process.env.MUSE_PERSONA_FILE;
      else process.env.MUSE_PERSONA_FILE = prev;
    }
  });

  it("muse persona show / list flag a dangling active id instead of mislabeling it (goal 242)", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "muse-persona-dangling-"));
    const file = path.join(root, "persona.json");
    // activeId points at a custom that no longer exists (hand-edited
    // file / typo) — resolves to "" at runtime, silently, today.
    await writeFile(file, JSON.stringify({ activeId: "ghost", custom: {} }), "utf8");
    const prevEnv = process.env.MUSE_PERSONA_FILE;
    process.env.MUSE_PERSONA_FILE = file;
    try {
      const showCap = captureOutput();
      const showProg = createProgram({ ...showCap.io, fetch: async () => { throw new Error("no fetch"); } });
      await showProg.parseAsync(["node", "muse", "persona", "show"], { from: "node" });
      const showText = showCap.output.join("");
      expect(showText).toContain("active: ghost");
      expect(showText).toContain("'ghost' is unknown");
      expect(showText).not.toContain("the default persona delegates");

      const listCap = captureOutput();
      const listProg = createProgram({ ...listCap.io, fetch: async () => { throw new Error("no fetch"); } });
      await listProg.parseAsync(["node", "muse", "persona", "list"], { from: "node" });
      const listText = listCap.output.join("");
      expect(listText).toContain("active: ghost");
      expect(listText).toContain("active persona 'ghost' is unknown");

      // A valid active id emits no dangling note.
      await writeFile(file, JSON.stringify({ activeId: "jarvis", custom: {} }), "utf8");
      const okCap = captureOutput();
      const okProg = createProgram({ ...okCap.io, fetch: async () => { throw new Error("no fetch"); } });
      await okProg.parseAsync(["node", "muse", "persona", "list"], { from: "node" });
      expect(okCap.output.join("")).not.toContain("is unknown");
    } finally {
      if (prevEnv === undefined) delete process.env.MUSE_PERSONA_FILE;
      else process.env.MUSE_PERSONA_FILE = prevEnv;
    }
  });

  it("muse job run --no-background is a recognized option (advertised inline mode works)", async () => {
    const { io, output } = captureOutput();
    const program = createProgram({ ...io, fetch: async () => { throw new Error("no fetch"); } });
    program.exitOverride();
    const prevExit = process.exitCode;
    process.exitCode = 0;
    try {
      // Recognized → empty prompt reaches the usage guard, NOT a
      // Commander "unknown option" parse error (the old
      // `.option("--background", …, true)` never created --no-background).
      await expect(
        program.parseAsync(["node", "muse", "job", "run", "--no-background", ""], { from: "node" })
      ).resolves.toBeDefined();
      const text = output.join("");
      expect(text).toContain("usage: muse job run");
      expect(text).not.toContain("unknown option");
      expect(process.exitCode).toBe(1);

      // Control: a genuinely unknown negated flag still rejects, so
      // the acceptance above is meaningful. (exitOverride throws a
      // generic error; the "unknown option" text goes to output.)
      const { io: io2, output: out2 } = captureOutput();
      const program2 = createProgram({ ...io2, fetch: async () => { throw new Error("no fetch"); } });
      program2.exitOverride();
      await expect(
        program2.parseAsync(["node", "muse", "job", "run", "--no-bogus", ""], { from: "node" })
      ).rejects.toThrow();
      expect(out2.join("")).toMatch(/unknown option/u);
    } finally {
      process.exitCode = prevExit;
    }
  });

  it("persona ids that collide with Object.prototype members don't crash or false-exist", async () => {
    const { readPersonaStore, resolveActivePersonaPreamble } = await import("../src/persona-store.js");

    // resolveActivePersonaPreamble must not read an inherited
    // member off `custom` (the old `store.custom[id]` returned
    // Object.prototype.toString → `.preamble.length` threw).
    for (const id of ["toString", "constructor", "hasOwnProperty", "__proto__"]) {
      expect(resolveActivePersonaPreamble({ activeId: id, custom: {} })).toBe("");
    }
    // A genuine built-in id still resolves.
    expect(resolveActivePersonaPreamble({ activeId: "jarvis", custom: {} }).toLowerCase())
      .toContain("sir");

    // A hand-edited file with a `__proto__` custom key is
    // contained: null-prototype store, no global pollution, and
    // a sibling persona still resolves.
    const root = await mkdtemp(path.join(tmpdir(), "muse-persona-proto-"));
    const file = path.join(root, "persona.json");
    const fsp = await import("node:fs/promises");
    await fsp.writeFile(
      file,
      `{"activeId":"ok","custom":{"__proto__":{"preamble":"PWNED"},"ok":{"preamble":"fine"}}}`,
      "utf8"
    );
    const store = await readPersonaStore(file);
    expect(Object.getPrototypeOf(store.custom)).toBeNull();
    expect(({} as Record<string, unknown>).preamble).toBeUndefined();
    expect(resolveActivePersonaPreamble(store)).toBe("fine");
    expect(resolveActivePersonaPreamble({ ...store, activeId: "absent" })).toBe("");

    // An empty-string custom preamble is treated as "not set": it falls
    // through to the built-in for a built-in id (so a blank override
    // can't silently strip JARVIS's voice), and to "" for a custom-only
    // id. The `.length > 0` guard, otherwise untested.
    expect(resolveActivePersonaPreamble({ activeId: "jarvis", custom: { jarvis: { preamble: "" } } }).toLowerCase())
      .toContain("sir");
    expect(resolveActivePersonaPreamble({ activeId: "blank", custom: { blank: { preamble: "" } } })).toBe("");

    // CLI: `muse persona use toString` must be rejected, not
    // silently persisted as a broken activeId.
    const prev = process.env.MUSE_PERSONA_FILE;
    process.env.MUSE_PERSONA_FILE = path.join(root, "use.json");
    const prevExit = process.exitCode;
    process.exitCode = 0;
    try {
      const { io, output } = captureOutput();
      const program = createProgram({ ...io, fetch: async () => { throw new Error("no fetch"); } });
      await program.parseAsync(["node", "muse", "persona", "use", "toString"], { from: "node" });
      expect(output.join("")).toContain("no persona with id 'toString'");
      expect(process.exitCode).toBe(1);
    } finally {
      if (prev === undefined) delete process.env.MUSE_PERSONA_FILE;
      else process.env.MUSE_PERSONA_FILE = prev;
      process.exitCode = prevExit;
    }
  });

  it("muse persona use <typo-id> suggests the closest valid id and exits 1 (goal 100)", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "muse-cli-persona-use-typo-"));
    const fsp = await import("node:fs/promises");
    const personaFile = path.join(root, "persona.json");
    // Seed a custom id so the candidate list spans built-in + custom.
    await fsp.writeFile(personaFile, JSON.stringify({
      activeId: "default",
      custom: { "tony": { preamble: "Sardonic, confident." } }
    }), "utf8");

    const prev = process.env.MUSE_PERSONA_FILE;
    process.env.MUSE_PERSONA_FILE = personaFile;
    const prevExitCode = process.exitCode;
    process.exitCode = 0;
    try {
      // Built-in typo → 'jarvis' suggestion.
      const { io: io1, output: out1 } = captureOutput();
      const program1 = createProgram({ ...io1, fetch: async () => { throw new Error("no fetch"); } });
      await program1.parseAsync(["node", "muse", "persona", "use", "jarvss"], { from: "node" });
      const text1 = out1.join("");
      expect(text1).toContain("no persona with id 'jarvss'");
      expect(text1).toContain("did you mean 'jarvis'?");
      expect(process.exitCode).toBe(1);

      // Custom typo → custom id suggestion (one-edit from 'tony').
      process.exitCode = 0;
      const { io: io2, output: out2 } = captureOutput();
      const program2 = createProgram({ ...io2, fetch: async () => { throw new Error("no fetch"); } });
      await program2.parseAsync(["node", "muse", "persona", "use", "tonu"], { from: "node" });
      const text2 = out2.join("");
      expect(text2).toContain("did you mean 'tony'?");
      expect(process.exitCode).toBe(1);

      // Unrelated id → no false-positive suggestion.
      process.exitCode = 0;
      const { io: io3, output: out3 } = captureOutput();
      const program3 = createProgram({ ...io3, fetch: async () => { throw new Error("no fetch"); } });
      await program3.parseAsync(["node", "muse", "persona", "use", "xyz-totally-elsewhere"], { from: "node" });
      const text3 = out3.join("");
      expect(text3).toContain("no persona with id 'xyz-totally-elsewhere'");
      expect(text3).not.toContain("did you mean");
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = prevExitCode;
      if (prev === undefined) delete process.env.MUSE_PERSONA_FILE;
      else process.env.MUSE_PERSONA_FILE = prev;
    }
  });

  it("muse persona use rejects an empty id with a clear error (matches the persona add/remove empty-id guard, not the misleading 'no persona with id' lookup error)", async () => {
    // Pre-fix `muse persona use ""` (from a `$VAR`-empty shell
    // expansion) hit the lookup path and produced the auto-generated
    // `no persona with id ''` error — a confusing "your id is the
    // empty string, here are the suggestions" frame. The sibling
    // commands `add` and `remove` reject empty-id up front with a
    // clear "<id> must not be empty" message; this aligns `use`.
    const root = await mkdtemp(path.join(tmpdir(), "muse-cli-persona-use-empty-"));
    const fsp = await import("node:fs/promises");
    const personaFile = path.join(root, "persona.json");
    await fsp.writeFile(personaFile, JSON.stringify({
      activeId: "default",
      custom: {}
    }), "utf8");

    const prev = process.env.MUSE_PERSONA_FILE;
    process.env.MUSE_PERSONA_FILE = personaFile;
    const prevExitCode = process.exitCode;
    process.exitCode = 0;
    try {
      // Empty string: the most common shell-expansion case.
      const { io: io1, output: out1 } = captureOutput();
      const program1 = createProgram({ ...io1, fetch: async () => { throw new Error("no fetch"); } });
      await program1.parseAsync(["node", "muse", "persona", "use", ""], { from: "node" });
      const text1 = out1.join("");
      expect(text1).toContain("must not be empty");
      expect(text1, "must NOT fall through to the lookup error path").not.toContain("no persona with id");
      expect(process.exitCode).toBe(1);

      // Whitespace-only: same guard via the existing .trim() above.
      process.exitCode = 0;
      const { io: io2, output: out2 } = captureOutput();
      const program2 = createProgram({ ...io2, fetch: async () => { throw new Error("no fetch"); } });
      await program2.parseAsync(["node", "muse", "persona", "use", "   "], { from: "node" });
      const text2 = out2.join("");
      expect(text2).toContain("must not be empty");
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = prevExitCode;
      if (prev === undefined) delete process.env.MUSE_PERSONA_FILE;
      else process.env.MUSE_PERSONA_FILE = prev;
    }
  });

  it("muse persona use --json emits { activeId, previousActiveId } envelope for scripting", async () => {
    const { readPersonaStore, writePersonaStore } = await import("../src/persona-store.js");
    const root = await mkdtemp(path.join(tmpdir(), "muse-cli-persona-use-json-"));
    const personaFile = path.join(root, "persona.json");
    await writePersonaStore(personaFile, { activeId: "default", custom: {} });
    const prev = process.env.MUSE_PERSONA_FILE;
    process.env.MUSE_PERSONA_FILE = personaFile;
    const prevExitCode = process.exitCode;
    process.exitCode = 0;
    try {
      const { io, output } = captureOutput();
      const program = createProgram({ ...io, fetch: async () => { throw new Error("no fetch"); } });
      await program.parseAsync(["node", "muse", "persona", "use", "jarvis", "--json"], { from: "node" });
      const text = output.join("");
      // The envelope is the only thing on stdout; the legacy "active persona → ..." arrow must NOT also emit.
      expect(text, "--json mode must NOT emit the human-readable arrow line").not.toContain("→");
      const parsed = JSON.parse(text) as { activeId: string; previousActiveId: string };
      expect(parsed.activeId, "envelope must echo the new active id").toBe("jarvis");
      expect(parsed.previousActiveId, "envelope must echo the prior active id so scripts can audit the transition").toBe("default");
      expect((await readPersonaStore(personaFile)).activeId).toBe("jarvis");
      expect(process.exitCode).toBe(0);

      // Sibling: no --json keeps the legacy arrow output.
      const { io: io2, output: out2 } = captureOutput();
      const program2 = createProgram({ ...io2, fetch: async () => { throw new Error("no fetch"); } });
      await program2.parseAsync(["node", "muse", "persona", "use", "default"], { from: "node" });
      expect(out2.join("")).toContain("active persona → default");
    } finally {
      process.exitCode = prevExitCode;
      if (prev === undefined) delete process.env.MUSE_PERSONA_FILE;
      else process.env.MUSE_PERSONA_FILE = prev;
    }
  });

  it("muse persona add --json + remove --json emit { action, id } / { id, resetActive, activeId } envelopes", async () => {
    const { writePersonaStore } = await import("../src/persona-store.js");
    const root = await mkdtemp(path.join(tmpdir(), "muse-cli-persona-write-json-"));
    const personaFile = path.join(root, "persona.json");
    await writePersonaStore(personaFile, { activeId: "default", custom: {} });
    const prev = process.env.MUSE_PERSONA_FILE;
    process.env.MUSE_PERSONA_FILE = personaFile;
    const prevExitCode = process.exitCode;
    process.exitCode = 0;
    try {
      // First add — action: "added".
      const { io: io1, output: out1 } = captureOutput();
      const program1 = createProgram({ ...io1, fetch: async () => { throw new Error("no fetch"); } });
      await program1.parseAsync(["node", "muse", "persona", "add", "tony", "Sardonic.", "--json"], { from: "node" });
      const r1 = JSON.parse(out1.join("")) as { action: string; id: string };
      expect(r1.action, "first add must report action: 'added'").toBe("added");
      expect(r1.id).toBe("tony");
      expect(out1.join(""), "json mode must NOT emit the human-readable 'Added custom persona' line").not.toContain("Added custom persona");

      // Second add for the same id — action: "updated".
      const { io: io2, output: out2 } = captureOutput();
      const program2 = createProgram({ ...io2, fetch: async () => { throw new Error("no fetch"); } });
      await program2.parseAsync(["node", "muse", "persona", "add", "tony", "Even more sardonic.", "--json"], { from: "node" });
      const r2 = JSON.parse(out2.join("")) as { action: string };
      expect(r2.action, "second add for the same id must report action: 'updated' so scripts can audit overwrites").toBe("updated");

      // remove --json on inactive custom — resetActive: false.
      const { io: io3, output: out3 } = captureOutput();
      const program3 = createProgram({ ...io3, fetch: async () => { throw new Error("no fetch"); } });
      await program3.parseAsync(["node", "muse", "persona", "remove", "tony", "--json"], { from: "node" });
      const r3 = JSON.parse(out3.join("")) as { id: string; resetActive: boolean; activeId: string };
      expect(r3).toEqual({ id: "tony", resetActive: false, activeId: "default" });

      // remove --json on ACTIVE custom — resetActive: true.
      await writePersonaStore(personaFile, {
        activeId: "alfred",
        custom: { "alfred": { preamble: "Formal." } }
      });
      const { io: io4, output: out4 } = captureOutput();
      const program4 = createProgram({ ...io4, fetch: async () => { throw new Error("no fetch"); } });
      await program4.parseAsync(["node", "muse", "persona", "remove", "alfred", "--json"], { from: "node" });
      const r4 = JSON.parse(out4.join("")) as { id: string; resetActive: boolean; activeId: string };
      expect(r4.resetActive, "removing the active persona must surface resetActive: true").toBe(true);
      expect(r4.activeId, "envelope must echo the post-remove active id so scripts know the new state").toBe("default");
    } finally {
      process.exitCode = prevExitCode;
      if (prev === undefined) delete process.env.MUSE_PERSONA_FILE;
      else process.env.MUSE_PERSONA_FILE = prev;
    }
  });

  it("muse persona add <id> <preamble> registers a custom persona reachable by `use` / `show`", async () => {
    const { readPersonaStore } = await import("../src/persona-store.js");
    const root = await mkdtemp(path.join(tmpdir(), "muse-cli-persona-add-"));
    const personaFile = path.join(root, "persona.json");
    const prev = process.env.MUSE_PERSONA_FILE;
    process.env.MUSE_PERSONA_FILE = personaFile;
    const prevExitCode = process.exitCode;
    process.exitCode = 0;
    try {
      const { io: ioAdd, output: outAdd } = captureOutput();
      const programAdd = createProgram({ ...ioAdd, fetch: async () => { throw new Error("no fetch"); } });
      await programAdd.parseAsync(
        ["node", "muse", "persona", "add", "tony", "Sardonic,", "confident,", "Tony", "Stark."],
        { from: "node" }
      );
      expect(outAdd.join("")).toContain("Added custom persona tony");
      expect(process.exitCode).toBe(0);

      const persisted = await readPersonaStore(personaFile);
      expect(persisted.custom["tony"]?.preamble).toBe("Sardonic, confident, Tony Stark.");

      const { io: ioReplace, output: outReplace } = captureOutput();
      const programReplace = createProgram({ ...ioReplace, fetch: async () => { throw new Error("no fetch"); } });
      await programReplace.parseAsync(
        ["node", "muse", "persona", "add", "tony", "Even", "more", "sardonic."],
        { from: "node" }
      );
      expect(outReplace.join(""), "second add for the same id is an explicit update, not a duplicate").toContain("Updated custom persona tony");
      expect((await readPersonaStore(personaFile)).custom["tony"]?.preamble).toBe("Even more sardonic.");

      const { io: ioCollide, output: outCollide } = captureOutput();
      const programCollide = createProgram({ ...ioCollide, fetch: async () => { throw new Error("no fetch"); } });
      process.exitCode = 0;
      await programCollide.parseAsync(["node", "muse", "persona", "add", "jarvis", "Override", "JARVIS."], { from: "node" });
      const collideText = outCollide.join("");
      expect(collideText).toContain("'jarvis' is a built-in id");
      expect(collideText).toContain("'jarvis-mine'");
      expect(process.exitCode, "built-in collision must reject — overriding via `add` would shadow the built-in invisibly").toBe(1);
      expect((await readPersonaStore(personaFile)).custom["jarvis"], "the built-in collision must not silently land in the store").toBeUndefined();

      const { io: ioEmpty, output: outEmpty } = captureOutput();
      const programEmpty = createProgram({ ...ioEmpty, fetch: async () => { throw new Error("no fetch"); } });
      process.exitCode = 0;
      await programEmpty.parseAsync(["node", "muse", "persona", "add", "blanky", "   "], { from: "node" });
      expect(outEmpty.join("")).toContain("<preamble> must not be empty");
      expect(outEmpty.join(""), "the error message must hint about the stdin escape valve so long preambles aren't forced through positional-arg shell-escaping").toContain("pipe via stdin");
      expect(process.exitCode).toBe(1);
      expect((await readPersonaStore(personaFile)).custom["blanky"]).toBeUndefined();

      // Stdin path — long preambles with newlines/quotes piped from a file.
      const longPreamble = "Speak like JARVIS: dry, anticipatory, formal.\nKeep replies under 3 sentences.\nAddress as 'sir'.";
      const ioStdin = {
        ...captureOutput().io,
        readPipedStdin: async () => longPreamble
      };
      const outStdin: string[] = [];
      ioStdin.stdout = (m: string) => outStdin.push(m);
      ioStdin.stderr = (m: string) => outStdin.push(m);
      const programStdin = createProgram({ ...ioStdin, fetch: async () => { throw new Error("no fetch"); } });
      process.exitCode = 0;
      await programStdin.parseAsync(["node", "muse", "persona", "add", "long-jarvis"], { from: "node" });
      expect(outStdin.join("")).toContain("Added custom persona long-jarvis");
      expect(process.exitCode).toBe(0);
      expect(
        (await readPersonaStore(personaFile)).custom["long-jarvis"]?.preamble,
        "stdin-piped preamble must round-trip verbatim including embedded newlines"
      ).toBe(longPreamble);
    } finally {
      process.exitCode = prevExitCode;
      if (prev === undefined) delete process.env.MUSE_PERSONA_FILE;
      else process.env.MUSE_PERSONA_FILE = prev;
    }
  });

  it("muse persona remove <id> deletes the custom + resets activeId to default if it was active", async () => {
    const { readPersonaStore, writePersonaStore } = await import("../src/persona-store.js");
    const root = await mkdtemp(path.join(tmpdir(), "muse-cli-persona-remove-"));
    const personaFile = path.join(root, "persona.json");
    const prev = process.env.MUSE_PERSONA_FILE;
    process.env.MUSE_PERSONA_FILE = personaFile;
    const prevExitCode = process.exitCode;
    process.exitCode = 0;
    try {
      await writePersonaStore(personaFile, {
        activeId: "tony",
        custom: {
          "alfred": { preamble: "Formal, gentle." },
          "tony": { preamble: "Sardonic, confident." }
        }
      });

      const { io: ioRemove, output: outRemove } = captureOutput();
      const programRemove = createProgram({ ...ioRemove, fetch: async () => { throw new Error("no fetch"); } });
      await programRemove.parseAsync(["node", "muse", "persona", "remove", "tony"], { from: "node" });
      const removeText = outRemove.join("");
      expect(removeText).toContain("Removed custom persona tony");
      expect(removeText, "removing the active custom must reset activeId so `muse persona show` doesn't keep pointing at a deleted id").toContain("(active persona reset to default)");
      expect(process.exitCode).toBe(0);

      const after = await readPersonaStore(personaFile);
      expect(after.custom["tony"], "the removed custom must be gone from the store").toBeUndefined();
      expect(after.custom["alfred"]?.preamble, "siblings must survive").toBe("Formal, gentle.");
      expect(after.activeId).toBe("default");

      const { io: ioInactive, output: outInactive } = captureOutput();
      const programInactive = createProgram({ ...ioInactive, fetch: async () => { throw new Error("no fetch"); } });
      process.exitCode = 0;
      await programInactive.parseAsync(["node", "muse", "persona", "remove", "alfred"], { from: "node" });
      const inactiveText = outInactive.join("");
      expect(inactiveText).toContain("Removed custom persona alfred");
      expect(inactiveText, "removing an INACTIVE custom must NOT report the active-reset message").not.toContain("active persona reset");
      expect((await readPersonaStore(personaFile)).activeId, "inactive removal must leave activeId untouched").toBe("default");

      const { io: ioBuiltin, output: outBuiltin } = captureOutput();
      const programBuiltin = createProgram({ ...ioBuiltin, fetch: async () => { throw new Error("no fetch"); } });
      process.exitCode = 0;
      await programBuiltin.parseAsync(["node", "muse", "persona", "remove", "jarvis"], { from: "node" });
      expect(outBuiltin.join("")).toContain("'jarvis' is a built-in");
      expect(process.exitCode, "removing a built-in must reject — the built-ins are baked into the binary").toBe(1);

      const { io: ioMissing, output: outMissing } = captureOutput();
      const programMissing = createProgram({ ...ioMissing, fetch: async () => { throw new Error("no fetch"); } });
      process.exitCode = 0;
      await writePersonaStore(personaFile, {
        activeId: "default",
        custom: { "tony": { preamble: "Sardonic." } }
      });
      await programMissing.parseAsync(["node", "muse", "persona", "remove", "tonu"], { from: "node" });
      const missingText = outMissing.join("");
      expect(missingText).toContain("no custom persona with id 'tonu'");
      expect(missingText, "did-you-mean hint must reach for the closest custom id").toContain("did you mean 'tony'?");
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = prevExitCode;
      if (prev === undefined) delete process.env.MUSE_PERSONA_FILE;
      else process.env.MUSE_PERSONA_FILE = prev;
    }
  });

  it("compareFeedEntriesNewestFirst is a consistent total order incl. undated (goal 181)", async () => {
    const { compareFeedEntriesNewestFirst } = await import("../src/feeds-store.js");
    const newer = { id: "n", publishedAt: "2026-05-15T12:00:00Z" };
    const older = { id: "o", publishedAt: "2026-05-10T12:00:00Z" };
    const undatedA = { id: "ua", publishedAt: "" };
    const undatedB = { id: "ub", publishedAt: "not a date" };

    // Newest-first among dated.
    expect(compareFeedEntriesNewestFirst(newer, older)).toBeLessThan(0);
    expect(compareFeedEntriesNewestFirst(older, newer)).toBeGreaterThan(0);

    // Dated sorts before undated, both directions consistent.
    expect(compareFeedEntriesNewestFirst(newer, undatedA)).toBeLessThan(0);
    expect(compareFeedEntriesNewestFirst(undatedA, newer)).toBeGreaterThan(0);

    // Two undated entries compare antisymmetrically (id desc tiebreaker):
    // ub > ua lex → compare(undatedA, undatedB) > 0; compare(undatedB, undatedA) < 0.
    expect(compareFeedEntriesNewestFirst(undatedA, undatedB)).toBeGreaterThan(0);
    expect(compareFeedEntriesNewestFirst(undatedB, undatedA)).toBeLessThan(0);

    // Array.sort produces a stable, deterministic order.
    const sorted = [undatedA, older, undatedB, newer].sort(compareFeedEntriesNewestFirst);
    expect(sorted.slice(0, 2)).toEqual([newer, older]);
    expect(sorted.slice(2)).toEqual(expect.arrayContaining([undatedA, undatedB]));
  });

  it("parseFeedBody handles RSS 2.0 + Atom + filterRecentFeedEntries cutoff (goal 092)", async () => {
    const { parseFeedBody, filterRecentFeedEntries } = await import("../src/feeds-store.js");

    // RSS 2.0.
    const rss = `<?xml version="1.0"?>
<rss version="2.0"><channel>
  <title>Test</title>
  <item>
    <title>First post</title>
    <link>https://example.test/a</link>
    <pubDate>Wed, 14 May 2026 12:00:00 GMT</pubDate>
    <description>first body</description>
    <guid>guid-1</guid>
  </item>
  <item>
    <title>Second post</title>
    <link>https://example.test/b</link>
    <pubDate>Tue, 13 May 2026 09:00:00 GMT</pubDate>
    <description>second body</description>
  </item>
</channel></rss>`;
    const rssEntries = parseFeedBody(rss);
    expect(rssEntries).toHaveLength(2);
    expect(rssEntries[0]?.title).toBe("First post");
    expect(rssEntries[0]?.id).toBe("guid-1");
    expect(rssEntries[1]?.id).toBe("https://example.test/b"); // falls back to link

    // Atom.
    const atom = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Atom Test</title>
  <entry>
    <id>tag:example,2026:1</id>
    <title>Atom entry</title>
    <link href="https://example.test/atom/1"/>
    <updated>2026-05-14T10:00:00Z</updated>
    <summary>summary text</summary>
  </entry>
</feed>`;
    const atomEntries = parseFeedBody(atom);
    expect(atomEntries).toHaveLength(1);
    expect(atomEntries[0]?.title).toBe("Atom entry");
    expect(atomEntries[0]?.link).toBe("https://example.test/atom/1");
    expect(atomEntries[0]?.id).toBe("tag:example,2026:1");

    // Garbage body → empty array, no throw.
    expect(parseFeedBody("not xml at all")).toEqual([]);

    // filterRecentFeedEntries cutoff.
    const cutoff = new Date("2026-05-14T00:00:00Z");
    const recent = filterRecentFeedEntries(rssEntries, cutoff);
    expect(recent.map((e) => e.title)).toEqual(["First post"]); // second is before cutoff

    // Missing publishedAt is kept (no false-negative filtering).
    const noDate: typeof rssEntries = [
      { id: "x", title: "T", link: "", publishedAt: "", summary: "" }
    ];
    expect(filterRecentFeedEntries(noDate, cutoff)).toHaveLength(1);
  });

  it("parseFeedBody strips terminal-injection bytes + collapses whitespace in feed text (goal 240)", async () => {
    const { parseFeedBody } = await import("../src/feeds-store.js");
    const ESC = String.fromCharCode(27);
    const BEL = String.fromCharCode(7);
    const DEL = String.fromCharCode(127);
    const C1 = String.fromCharCode(0x9b);
    // A publisher-controlled <title>/<description> carrying an ANSI
    // clear-screen + OSC title-spoof + C1/DEL bytes + a newline splice
    // — exactly what would hijack the terminal on `muse feeds today`.
    const rss = `<?xml version="1.0"?>
<rss version="2.0"><channel>
  <title>Feed</title>
  <item>
    <title>Hot${ESC}[2J${C1}news\n\n   from${DEL} space</title>
    <link>https://example.test/${ESC}[31mx</link>
    <pubDate>Wed, 14 May 2026 12:00:00 GMT</pubDate>
    <description>line one${BEL}\n\nline   two</description>
    <guid>g-${ESC}1</guid>
  </item>
</channel></rss>`;
    const entries = parseFeedBody(rss);
    expect(entries).toHaveLength(1);
    const e = entries[0]!;
    for (const field of [e.title, e.link, e.summary, e.id, e.publishedAt]) {
      for (const bad of [ESC, BEL, DEL, C1]) {
        expect(field.includes(bad)).toBe(false);
      }
    }
    // Visible text preserved; ESC/C1/DEL gone; internal whitespace
    // collapsed (proves our normaliser ran — the XML parser only
    // end-trims, it does not collapse internal runs).
    expect(e.title).toBe("Hot[2Jnews from space");
    expect(e.summary).toBe("line one line two");
    expect(e.link).toBe("https://example.test/[31mx");
    expect(e.id).toBe("g-1");
  });

  it("mergeFeedEntries dedupes + retains rolled-off entries + caps growth (goal 115)", async () => {
    const { mergeFeedEntries, DEFAULT_FEED_ENTRIES_CAP } = await import("../src/feeds-store.js");

    const previous = [
      { id: "a", title: "Old A", link: "/a", publishedAt: "2026-05-10T12:00:00Z", summary: "old a" },
      { id: "b", title: "Old B", link: "/b", publishedAt: "2026-05-12T12:00:00Z", summary: "old b" }
    ];
    // Incoming: republishes "b" with new title, adds "c", drops "a"
    // (the typical "rolled off the publisher's window" case).
    const incoming = [
      { id: "b", title: "New B", link: "/b", publishedAt: "2026-05-12T12:30:00Z", summary: "new b" },
      { id: "c", title: "New C", link: "/c", publishedAt: "2026-05-13T08:00:00Z", summary: "new c" }
    ];
    const merged = mergeFeedEntries(previous, incoming);
    // All three IDs survive (a kept locally, b updated, c added).
    expect(merged.map((e) => e.id).sort()).toEqual(["a", "b", "c"]);
    // Newest-first sort: c (May 13) > b (May 12 30m) > a (May 10).
    expect(merged.map((e) => e.id)).toEqual(["c", "b", "a"]);
    // Incoming wins on republish — title is "New B", not "Old B".
    expect(merged.find((e) => e.id === "b")?.title).toBe("New B");

    // Entries without publishedAt sort to the tail.
    const withMissing = mergeFeedEntries(
      [{ id: "z", title: "Z", link: "/z", publishedAt: "", summary: "" }],
      incoming
    );
    expect(withMissing[withMissing.length - 1]?.id).toBe("z");

    // Cap clips the merged list — default is ~200, custom takes priority.
    expect(mergeFeedEntries(previous, incoming, 2)).toHaveLength(2);
    // Invalid caps (0, negative, NaN) fall back to the default.
    expect(mergeFeedEntries(previous, incoming, 0).length).toBeLessThanOrEqual(DEFAULT_FEED_ENTRIES_CAP);
    expect(mergeFeedEntries(previous, incoming, -1).length).toBeLessThanOrEqual(DEFAULT_FEED_ENTRIES_CAP);
    expect(mergeFeedEntries(previous, incoming, Number.NaN).length).toBeLessThanOrEqual(DEFAULT_FEED_ENTRIES_CAP);

    // Empty inputs are safe.
    expect(mergeFeedEntries([], [])).toEqual([]);
    expect(mergeFeedEntries([], incoming).map((e) => e.id)).toEqual(["c", "b"]);
  });

  it("rankRecallCandidates merges + sorts notes + episodes by cosine (goal 091)", async () => {
    const { rankRecallCandidates } = await import("../src/commands-recall.js");
    const queryVec = [1, 0, 0, 0];
    const noteChunks = [
      { path: "q3.md", text: "Q3 budget memo body", embedding: [1, 0, 0, 0] },
      { path: "weather.md", text: "rain forecast", embedding: [0, 1, 0, 0] }
    ];
    const episodeEntries = [
      { id: "ep_a", summary: "discussed Q3 spending", embedding: [0.8, 0.2, 0, 0] },
      { id: "ep_b", summary: "weekend plans", embedding: [0, 0, 1, 0] }
    ];

    // Default: merged + ranked across both sources; zero-score
    // candidates dropped.
    const all = rankRecallCandidates({ queryVec, noteChunks, episodeEntries, limit: 5, source: "all" });
    expect(all.length).toBe(2);
    expect(all[0]?.source).toBe("notes");
    expect(all[0]?.ref).toBe("q3.md");
    expect(all[1]?.source).toBe("episodes");

    // --source notes drops episodes.
    const notesOnly = rankRecallCandidates({ queryVec, noteChunks, episodeEntries, limit: 5, source: "notes" });
    expect(notesOnly.every((h) => h.source === "notes")).toBe(true);

    // --source episodes drops notes.
    const epsOnly = rankRecallCandidates({ queryVec, noteChunks, episodeEntries, limit: 5, source: "episodes" });
    expect(epsOnly.every((h) => h.source === "episodes")).toBe(true);

    // Limit clamps the result count.
    const oneHit = rankRecallCandidates({ queryVec, noteChunks, episodeEntries, limit: 1, source: "all" });
    expect(oneHit.length).toBe(1);
    expect(oneHit[0]?.ref).toBe("q3.md");
  });

  it("muse recall warns when the index model mismatches --embed-model (goal 114)", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "muse-recall-mismatch-"));
    const fsp = await import("node:fs/promises");
    const notesIndexPath = path.join(root, "notes-index.json");
    const epsIndexPath = path.join(root, "episodes-index.json");
    // The note must exist on disk — recall drops index entries for
    // notes deleted/moved since the last reindex (goal 864).
    const notePath = path.join(root, "q3.md");
    await fsp.writeFile(notePath, "Q3 budget memo body", "utf8");

    // Seed both indices with model 'nomic-embed-text'. The query
    // below will pass --embed-model 'mxbai-embed-large' to force a
    // mismatch, so the warnings should mention both indices and
    // suggest the right reindex / fallback flag.
    await fsp.writeFile(notesIndexPath, JSON.stringify({
      version: 1,
      model: "nomic-embed-text",
      builtAtIso: "2026-05-13T00:00:00Z",
      files: [{
        path: notePath,
        mtimeMs: 1,
        chunks: [{ chunkIndex: 0, text: "Q3 budget memo body", embedding: [1, 0, 0, 0] }]
      }]
    }), "utf8");
    await fsp.writeFile(epsIndexPath, JSON.stringify({
      version: 1,
      model: "nomic-embed-text",
      builtAtIso: "2026-05-13T00:00:00Z",
      entries: [{
        id: "ep_a",
        summary: "Q3 review",
        embedding: [1, 0, 0, 0]
      }]
    }), "utf8");

    const prevNotes = process.env.MUSE_NOTES_INDEX_FILE;
    const prevEps = process.env.MUSE_EPISODES_INDEX_FILE;
    const prevQueryEmbedding = process.env.MUSE_RECALL_TEST_QUERY_EMBEDDING;
    process.env.MUSE_NOTES_INDEX_FILE = notesIndexPath;
    process.env.MUSE_EPISODES_INDEX_FILE = epsIndexPath;
    // Test-only escape hatch the recall command already supports —
    // skip the real Ollama call.
    process.env.MUSE_RECALL_TEST_QUERY_EMBEDDING = "1,0,0,0";
    try {
      const { io, output } = captureOutput();
      const program = createProgram({ ...io, fetch: async () => { throw new Error("no fetch"); } });
      await program.parseAsync(
        ["node", "muse", "recall", "Q3", "--embed-model", "mxbai-embed-large"],
        { from: "node" }
      );
      const text = output.join("");
      // Notes warning carries the offending index model + suggests
      // both fix paths.
      expect(text).toMatch(/notes-index\.json was built with 'nomic-embed-text' but querying with 'mxbai-embed-large'/u);
      expect(text).toMatch(/muse notes reindex --model mxbai-embed-large/u);
      expect(text).toMatch(/--embed-model nomic-embed-text/u);
      // Episodes warning mirrors the notes one.
      expect(text).toMatch(/episodes-index\.json was built with 'nomic-embed-text'/u);
      expect(text).toMatch(/muse episode reindex --model mxbai-embed-large/u);
      // Hit list still renders — the warning doesn't gate retrieval.
      expect(text).toContain("Recall hits for");
    } finally {
      if (prevNotes === undefined) delete process.env.MUSE_NOTES_INDEX_FILE;
      else process.env.MUSE_NOTES_INDEX_FILE = prevNotes;
      if (prevEps === undefined) delete process.env.MUSE_EPISODES_INDEX_FILE;
      else process.env.MUSE_EPISODES_INDEX_FILE = prevEps;
      if (prevQueryEmbedding === undefined) delete process.env.MUSE_RECALL_TEST_QUERY_EMBEDDING;
      else process.env.MUSE_RECALL_TEST_QUERY_EMBEDDING = prevQueryEmbedding;
    }
  });

  it("muse recall stays silent when the index model matches the query model (goal 114)", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "muse-recall-match-"));
    const fsp = await import("node:fs/promises");
    const notesIndexPath = path.join(root, "notes-index.json");
    await fsp.writeFile(notesIndexPath, JSON.stringify({
      version: 1, model: "nomic-embed-text", builtAtIso: "2026-05-13T00:00:00Z",
      files: [{
        path: "q3.md", mtimeMs: 1,
        chunks: [{ chunkIndex: 0, text: "Q3 body", embedding: [1, 0, 0, 0] }]
      }]
    }), "utf8");

    const prevNotes = process.env.MUSE_NOTES_INDEX_FILE;
    const prevQueryEmbedding = process.env.MUSE_RECALL_TEST_QUERY_EMBEDDING;
    process.env.MUSE_NOTES_INDEX_FILE = notesIndexPath;
    process.env.MUSE_RECALL_TEST_QUERY_EMBEDDING = "1,0,0,0";
    try {
      const { io, output } = captureOutput();
      const program = createProgram({ ...io, fetch: async () => { throw new Error("no fetch"); } });
      await program.parseAsync(
        ["node", "muse", "recall", "Q3", "--source", "notes"],
        { from: "node" }
      );
      const text = output.join("");
      // Default embed-model is `nomic-embed-text` (matches the index)
      // → no mismatch warning.
      expect(text).not.toContain("but querying with");
    } finally {
      if (prevNotes === undefined) delete process.env.MUSE_NOTES_INDEX_FILE;
      else process.env.MUSE_NOTES_INDEX_FILE = prevNotes;
      if (prevQueryEmbedding === undefined) delete process.env.MUSE_RECALL_TEST_QUERY_EMBEDDING;
      else process.env.MUSE_RECALL_TEST_QUERY_EMBEDDING = prevQueryEmbedding;
    }
  });

  it("buildEpisodeIndex reuses unchanged entries + re-embeds changed summaries (goal 090)", async () => {
    const { buildEpisodeIndex } = await import("../src/episode-index.js");
    const calls: string[] = [];
    const fakeEmbed = async (text: string): Promise<number[]> => {
      calls.push(text);
      return [text.length, 0, 0, 0];
    };
    type EpInput = Parameters<typeof buildEpisodeIndex>[0]["episodes"];

    // Initial build: 2 episodes, both must embed.
    const first = await buildEpisodeIndex({
      episodes: [
        { id: "ep1", userId: "u", summary: "Q3 budget", startedAt: "t1", endedAt: "t2" },
        { id: "ep2", userId: "u", summary: "wedding", startedAt: "t3", endedAt: "t4" }
      ] as unknown as EpInput,
      embedFn: fakeEmbed,
      previous: undefined,
      model: "nomic-embed-text",
      nowIso: "2026-05-15T00:00:00Z"
    });
    expect(first.embedded).toBe(2);
    expect(first.skipped).toBe(0);
    expect(first.index.entries.map((e) => e.id)).toEqual(["ep1", "ep2"]);

    // Second build: same rows → both reuse (zero embed calls).
    calls.length = 0;
    const second = await buildEpisodeIndex({
      episodes: [
        { id: "ep1", userId: "u", summary: "Q3 budget", startedAt: "t1", endedAt: "t2" },
        { id: "ep2", userId: "u", summary: "wedding", startedAt: "t3", endedAt: "t4" }
      ] as unknown as EpInput,
      embedFn: fakeEmbed,
      previous: first.index,
      model: "nomic-embed-text",
      nowIso: "2026-05-15T01:00:00Z"
    });
    expect(second.embedded).toBe(0);
    expect(second.skipped).toBe(2);
    expect(calls).toEqual([]);

    // Third build: ep1 summary changed → re-embed only ep1.
    const third = await buildEpisodeIndex({
      episodes: [
        { id: "ep1", userId: "u", summary: "Q3 budget revised", startedAt: "t1", endedAt: "t2" },
        { id: "ep2", userId: "u", summary: "wedding", startedAt: "t3", endedAt: "t4" }
      ] as unknown as EpInput,
      embedFn: fakeEmbed,
      previous: second.index,
      model: "nomic-embed-text",
      nowIso: "2026-05-15T02:00:00Z"
    });
    expect(third.embedded).toBe(1);
    expect(third.skipped).toBe(1);
    expect(calls).toEqual(["Q3 budget revised"]);

    // Model change → full rebuild.
    calls.length = 0;
    const fourth = await buildEpisodeIndex({
      episodes: [
        { id: "ep1", userId: "u", summary: "Q3 budget revised", startedAt: "t1", endedAt: "t2" }
      ] as unknown as EpInput,
      embedFn: fakeEmbed,
      previous: third.index,
      model: "different-model",
      nowIso: "2026-05-15T03:00:00Z"
    });
    expect(fourth.embedded).toBe(1);
    expect(calls).toEqual(["Q3 budget revised"]);
  });

  it("parseOsascriptGlance normalises missing/empty fields (goal 089)", async () => {
    const { parseOsascriptGlance } = await import("../src/commands-glance.js");
    expect(parseOsascriptGlance("Terminal\nmuse — repl\nselected text here\n")).toEqual({
      app: "Terminal", window: "muse — repl", selected: "selected text here"
    });
    expect(parseOsascriptGlance("Safari\nmissing value\n\n")).toEqual({
      app: "Safari", window: "", selected: ""
    });
    expect(parseOsascriptGlance("  Code  \n  main.ts  \n  abc  \n")).toEqual({
      app: "Code", window: "main.ts", selected: "abc"
    });
    expect(parseOsascriptGlance("")).toEqual({ app: "", window: "", selected: "" });

    // A hostile window title / clipboard (any site's <title>, raw
    // clipboard) carrying ANSI/C0/C1/DEL is neutralised, not
    // printed raw to the terminal.
    const ESC = String.fromCharCode(27);
    const C1 = String.fromCharCode(0x9b);
    const DEL = String.fromCharCode(127);
    const snap = parseOsascriptGlance(
      `Safari${ESC}[2J\nEvil${C1}Page\ncopied${DEL} text  with   spaces`
    );
    for (const field of [snap.app, snap.window, snap.selected]) {
      for (const bad of [ESC, C1, DEL]) {
        expect(field.includes(bad)).toBe(false);
      }
    }
    expect(snap).toEqual({ app: "Safari[2J", window: "EvilPage", selected: "copied text with spaces" });
  });

  it("muse read parses a hand-rolled PDF + builds grounded ask prompt (goal 088)", async () => {
    const { parsePdfBuffer, buildReadAskSystemPrompt } = await import("../src/commands-read.js");
    // System prompt structurally pins the document boundaries.
    const prompt = buildReadAskSystemPrompt("hello world body text");
    expect(prompt).toContain("=== DOCUMENT START ===");
    expect(prompt).toContain("hello world body text");
    expect(prompt).toContain("=== DOCUMENT END ===");
    expect(prompt).toMatch(/USING ONLY the document/i);

    // Parse a hand-rolled minimal PDF carrying "hello jarvis".
    const pdfBytes = Buffer.from(
      "%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n" +
      "2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n" +
      "3 0 obj<</Type/Page/Parent 2 0 R/Resources<</Font<</F1 4 0 R>>>>/MediaBox[0 0 300 100]/Contents 5 0 R>>endobj\n" +
      "4 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\n" +
      "5 0 obj<</Length 44>>stream\nBT /F1 12 Tf 50 50 Td (hello jarvis) Tj ET\nendstream\nendobj\n" +
      "xref\n0 6\n0000000000 65535 f\n0000000009 00000 n\n0000000052 00000 n\n0000000101 00000 n\n0000000196 00000 n\n0000000257 00000 n\n" +
      "trailer<</Size 6/Root 1 0 R>>\nstartxref\n349\n%%EOF\n"
    );
    const parsed = await parsePdfBuffer(pdfBytes);
    expect(typeof parsed.text).toBe("string");
    expect(parsed.text.includes("hello jarvis")).toBe(true);
  });

  it("muse vision helpers: resolveVisionModel + loadImageAsBase64 + buildOllamaVisionBody (goal 087)", async () => {
    const { resolveVisionModel, loadImageAsBase64, buildOllamaVisionBody } = await import("../src/commands-vision.js");

    // resolveVisionModel: explicit > env > default
    expect(resolveVisionModel("custom:7b", {})).toBe("custom:7b");
    expect(resolveVisionModel(undefined, { MUSE_VISION_MODEL: "llava:7b" })).toBe("llava:7b");
    expect(resolveVisionModel(undefined, {})).toBe("llama3.2-vision:latest");
    expect(resolveVisionModel("   ", { MUSE_VISION_MODEL: "x" })).toBe("x");

    // loadImageAsBase64: data URL path passes through, http path fetches.
    const dataUrl = "data:image/png;base64,iVBORw0KGgo=";
    expect(await loadImageAsBase64(dataUrl)).toBe("iVBORw0KGgo=");

    // Note: use a fresh Uint8Array (not Buffer.from([]).buffer) so
    // we don't grab the shared pool that backs other tests' buffers.
    const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    const stubFetch: typeof globalThis.fetch = (async () => new Response(
      pngBytes,
      { status: 200 }
    )) as typeof globalThis.fetch;
    const fromHttp = await loadImageAsBase64("https://example.test/x.png", stubFetch);
    expect(fromHttp).toBe(Buffer.from(pngBytes).toString("base64"));

    // Local file path — must carry real image magic bytes (a PNG header
    // here); loadImageAsBase64 now rejects a non-image local file.
    const fsp = await import("node:fs/promises");
    const root = await mkdtemp(path.join(tmpdir(), "muse-vision-test-"));
    const file = path.join(root, "img.png");
    const localPng = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    await fsp.writeFile(file, localPng);
    expect(await loadImageAsBase64(file)).toBe(localPng.toString("base64"));

    // buildOllamaVisionBody shape.
    const body = buildOllamaVisionBody({ model: "m", prompt: "p", imageBase64: "QkFTRTY0" });
    expect(body).toEqual({ model: "m", prompt: "p", images: ["QkFTRTY0"], stream: false, think: false });

    // Malformed data URL throws.
    await expect(loadImageAsBase64("data:image/png;base64NOCOMMA")).rejects.toThrow(/comma/);

    // A non-base64 data URL (SVG / text) is rejected with an
    // actionable error instead of being passed through as garbage.
    await expect(loadImageAsBase64("data:image/svg+xml,%3Csvg%2F%3E"))
      .rejects.toThrow(/must be base64-encoded/u);
    await expect(loadImageAsBase64("data:,hello"))
      .rejects.toThrow(/must be base64-encoded/u);
    // A bare-mediatype-less base64 data URL still passes through.
    expect(await loadImageAsBase64("data:;base64,QUJD")).toBe("QUJD");

    // A `;base64`-DECLARED payload that isn't actually base64 (an SVG
    // body, a %-escaped string, empty) is rejected with a clear error
    // rather than passed through as garbage to the vision model.
    await expect(loadImageAsBase64("data:image/png;base64,<svg/>"))
      .rejects.toThrow(/not valid base64/u);
    await expect(loadImageAsBase64("data:image/png;base64,%3Csvg%3E"))
      .rejects.toThrow(/not valid base64/u);
    await expect(loadImageAsBase64("data:image/png;base64,"))
      .rejects.toThrow(/empty or not valid base64/u);
    // Whitespace-wrapped valid base64 is tolerated (data URLs may wrap).
    expect(await loadImageAsBase64("data:image/png;base64,QUJD\n  REVG")).toBe("QUJDREVG");
  });

  it("muse vision: formatOllamaVisionFailure surfaces actionable `ollama pull <base>` on 404 but stays generic for other statuses", async () => {
    const { formatOllamaVisionFailure } = await import("../src/commands-vision.js");

    const notInstalled = formatOllamaVisionFailure({
      body: '{"error":"model \'llama3.2-vision:latest\' not found, try pulling it first"}',
      model: "llama3.2-vision:latest",
      status: 404
    });
    expect(notInstalled, "404 must surface the actionable command, not just dump the body").toContain("Pull it with: ollama pull llama3.2-vision");
    expect(notInstalled).toContain("model 'llama3.2-vision:latest' is not installed");
    expect(notInstalled, "the raw body still rides along so an operator can debug").toContain("not found, try pulling it first");

    // Tag-less model id passes through as the pull target unchanged.
    const tagless = formatOllamaVisionFailure({ body: "", model: "llava", status: 404 });
    expect(tagless).toContain("Pull it with: ollama pull llava");

    // 5xx / non-404 keep the generic message; no pull hint (the
    // status doesn't imply "model missing").
    const serverError = formatOllamaVisionFailure({
      body: "internal error",
      model: "llama3.2-vision:latest",
      status: 500
    });
    expect(serverError).toContain("muse vision: Ollama 500 — internal error");
    expect(serverError, "non-404 must NOT pretend the model is missing").not.toContain("Pull it with");

    // 400 — bad request, e.g. image too large. Same generic shape.
    const badRequest = formatOllamaVisionFailure({ body: "image too big", model: "m", status: 400 });
    expect(badRequest).toContain("Ollama 400 — image too big");
    expect(badRequest).not.toContain("Pull it with");
  });

  it("planActivityLogCompaction filters by suffix + age + allow-list (goal 080)", async () => {
    const { planActivityLogCompaction, COMPACTABLE_STORE_BASENAMES } = await import("../src/commands-maintenance.js");
    const root = await mkdtemp(path.join(tmpdir(), "muse-cli-compact-"));
    const fsp = await import("node:fs/promises");
    const museDir = root;
    const archiveDir = path.join(root, "archive");
    const nowMs = Date.now();

    // Allow-listed sidecar from goal 079.
    expect(COMPACTABLE_STORE_BASENAMES).toContain("proactive-history.json");

    await fsp.writeFile(path.join(museDir, "proactive-history.json.1"), "{}");
    await fsp.writeFile(path.join(museDir, "proactive-history.json.2"), "{}");
    // Not on the allow-list — must be ignored even though the
    // naming pattern matches.
    await fsp.writeFile(path.join(museDir, "random-sidecar.json.1"), "{}");
    // Live file (no numeric suffix) — never compacted.
    await fsp.writeFile(path.join(museDir, "proactive-history.json"), "{}");

    // No --keep-days → both allow-listed archives are in scope.
    const fullPlan = await planActivityLogCompaction({ museDir, archiveDir, nowMs });
    expect(fullPlan.map((e) => path.basename(e.source)).sort()).toEqual([
      "proactive-history.json.1",
      "proactive-history.json.2"
    ]);
    expect(fullPlan.every((e) => e.destination.startsWith(archiveDir))).toBe(true);

    // keep-days=7 with file mtimes "now" → nothing matches.
    const recentOnly = await planActivityLogCompaction({ museDir, archiveDir, nowMs, keepDays: 7 });
    expect(recentOnly).toEqual([]);

    // Backdate one archive so keep-days=1 matches just that file.
    const oldMs = nowMs - 10 * 24 * 60 * 60 * 1000;
    await fsp.utimes(path.join(museDir, "proactive-history.json.1"), oldMs / 1000, oldMs / 1000);
    const oldOnly = await planActivityLogCompaction({ museDir, archiveDir, nowMs, keepDays: 1 });
    expect(oldOnly.map((e) => path.basename(e.source))).toEqual(["proactive-history.json.1"]);
  });

  it("planActivityPrune keeps lines within the window, drops older + undateable ones", async () => {
    const { planActivityPrune } = await import("../src/commands-maintenance.js");
    const nowMs = Date.parse("2026-05-24T12:00:00Z");
    const recent = `{"kind":"chat","userId":"stark","tsIso":"2026-05-24T09:00:00Z"}`;
    const old = `{"kind":"chat","userId":"stark","tsIso":"2026-01-01T09:00:00Z"}`;
    const undateable = `{"kind":"chat","userId":"stark"}`;
    const malformed = `not json at all`;
    const plan = planActivityPrune([recent, old, undateable, malformed, ""], nowMs, 30);
    // Only the in-window line survives; old + undateable + malformed dropped; blank ignored.
    expect(plan.keptLines).toEqual([recent]);
    expect(plan.kept).toBe(1);
    expect(plan.dropped).toBe(3);
  });

  it("muse maintenance prune-activity rewrites activity.jsonl to the retention window (and --dry-run doesn't)", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "muse-cli-prune-"));
    const fsp = await import("node:fs/promises");
    const file = path.join(root, "activity.jsonl");
    const recent = `{"kind":"chat","userId":"stark","tsIso":"${new Date().toISOString()}"}`;
    const old = `{"kind":"chat","userId":"stark","tsIso":"2020-01-01T00:00:00Z"}`;
    await fsp.writeFile(file, `${old}\n${recent}\n${old}\n`, "utf8");

    const prev = process.env.MUSE_ACTIVITY_FILE;
    process.env.MUSE_ACTIVITY_FILE = file;
    try {
      // --dry-run reports but leaves the file untouched.
      const dry = captureOutput();
      const p1 = createProgram({ ...dry.io, fetch: async () => { throw new Error("no fetch"); } });
      await p1.parseAsync(["node", "muse", "maintenance", "prune-activity", "--keep-days", "30", "--dry-run"], { from: "node" });
      expect(dry.output.join("")).toContain("would drop 2 of 3");
      expect((await fsp.readFile(file, "utf8")).split("\n").filter((l) => l.length > 0)).toHaveLength(3);

      // Real run rewrites to just the in-window line.
      const real = captureOutput();
      const p2 = createProgram({ ...real.io, fetch: async () => { throw new Error("no fetch"); } });
      await p2.parseAsync(["node", "muse", "maintenance", "prune-activity", "--keep-days", "30"], { from: "node" });
      expect(real.output.join("")).toContain("Pruned 2 line(s); kept 1");
      const after = (await fsp.readFile(file, "utf8")).split("\n").filter((l) => l.length > 0);
      expect(after).toEqual([recent]);
    } finally {
      if (prev === undefined) { delete process.env.MUSE_ACTIVITY_FILE; } else { process.env.MUSE_ACTIVITY_FILE = prev; }
    }
  });

  it("planNotificationLogPrune keeps in-window `[ISO] (dest) text` lines, drops older + un-bracketed ones", async () => {
    const { planNotificationLogPrune } = await import("../src/commands-maintenance.js");
    const nowMs = Date.parse("2026-05-24T12:00:00Z");
    const recent = `[2026-05-24T09:00:00.000Z] (@me) Standup in 5`;
    const old = `[2026-01-01T09:00:00.000Z] (@me) old notice`;
    const garbage = `not a bracketed log line`;
    const plan = planNotificationLogPrune([recent, old, garbage, ""], nowMs, 30);
    expect(plan.keptLines).toEqual([recent]);
    expect(plan.kept).toBe(1);
    expect(plan.dropped).toBe(2);
  });

  it("muse maintenance prune-log rewrites notifications.log to the retention window (and --dry-run doesn't)", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "muse-cli-prunelog-"));
    const fsp = await import("node:fs/promises");
    const file = path.join(root, "notifications.log");
    const recent = `[${new Date().toISOString()}] (@me) recent notice`;
    const old = `[2020-01-01T00:00:00.000Z] (@me) ancient notice`;
    await fsp.writeFile(file, `${old}\n${recent}\n${old}\n`, "utf8");

    const prev = process.env.MUSE_MESSAGING_LOG_FILE;
    process.env.MUSE_MESSAGING_LOG_FILE = file;
    try {
      const dry = captureOutput();
      const p1 = createProgram({ ...dry.io, fetch: async () => { throw new Error("no fetch"); } });
      await p1.parseAsync(["node", "muse", "maintenance", "prune-log", "--keep-days", "30", "--dry-run"], { from: "node" });
      expect(dry.output.join("")).toContain("would drop 2 of 3");
      expect((await fsp.readFile(file, "utf8")).split("\n").filter((l) => l.length > 0)).toHaveLength(3);

      const real = captureOutput();
      const p2 = createProgram({ ...real.io, fetch: async () => { throw new Error("no fetch"); } });
      await p2.parseAsync(["node", "muse", "maintenance", "prune-log", "--keep-days", "30"], { from: "node" });
      expect(real.output.join("")).toContain("Pruned 2 line(s); kept 1");
      expect((await fsp.readFile(file, "utf8")).split("\n").filter((l) => l.length > 0)).toEqual([recent]);
    } finally {
      if (prev === undefined) { delete process.env.MUSE_MESSAGING_LOG_FILE; } else { process.env.MUSE_MESSAGING_LOG_FILE = prev; }
    }
  });

  it("muse status surfaces today's token-cost rollup from the sidecar JSON (goal 078)", async () => {
    const { readTokenCostToday } = await import("../src/commands-status.js");
    const root = await mkdtemp(path.join(tmpdir(), "muse-cli-cost-"));
    const file = path.join(root, "token-cost-today.json");
    // Missing file → unavailable.
    const missing = await readTokenCostToday(file);
    expect(missing.available).toBe(false);

    // Present file → fields surface.
    const fsp = await import("node:fs/promises");
    await fsp.writeFile(file, JSON.stringify({
      totalUsd: 1.234,
      totalTokens: 5678,
      runs: 12,
      asOfIso: "2026-05-14T12:00:00Z"
    }));
    const present = await readTokenCostToday(file);
    expect(present).toEqual({
      available: true,
      totalUsd: 1.234,
      totalTokens: 5678,
      runs: 12,
      asOfIso: "2026-05-14T12:00:00Z"
    });

    // muse status renders the cost line when the sidecar is set.
    const prev = process.env.MUSE_TOKEN_COST_TODAY_FILE;
    process.env.MUSE_TOKEN_COST_TODAY_FILE = file;
    try {
      const { io, output } = captureOutput();
      const program = createProgram({ ...io, fetch: async () => { throw new Error("no fetch"); } });
      await program.parseAsync(["node", "muse", "status", "--user", "stark"], { from: "node" });
      const text = output.join("");
      expect(text).toContain("cost (today): $1.2340, 5678 tokens over 12 run(s)");
      expect(text).toContain("as of: 2026-05-14T12:00:00Z");
    } finally {
      if (prev === undefined) delete process.env.MUSE_TOKEN_COST_TODAY_FILE;
      else process.env.MUSE_TOKEN_COST_TODAY_FILE = prev;
    }
  });

  it("muse status surfaces RAG readiness from the notes index (goal 180)", async () => {
    const { readRagStatus } = await import("../src/commands-status.js");
    const root = await mkdtemp(path.join(tmpdir(), "muse-cli-rag-"));
    const file = path.join(root, "notes-index.json");
    const fsp = await import("node:fs/promises");

    // Missing file → not indexed.
    expect(await readRagStatus(file)).toEqual({ indexed: false });

    // Empty files array → not indexed (model recorded but no chunks).
    await fsp.writeFile(file, JSON.stringify({ version: 1, model: "nomic-embed-text", files: [] }));
    expect(await readRagStatus(file)).toEqual({ embedModel: "nomic-embed-text", files: 0, indexed: false });

    // Populated index → ready, with the embed model surfaced.
    await fsp.writeFile(file, JSON.stringify({
      version: 1, model: "nomic-embed-text",
      files: [{ path: "a.md", chunks: [] }, { path: "b.md", chunks: [] }]
    }));
    expect(await readRagStatus(file)).toEqual({ embedModel: "nomic-embed-text", files: 2, indexed: true });

    // muse status renders the rag line.
    const prev = process.env.MUSE_NOTES_INDEX_FILE;
    process.env.MUSE_NOTES_INDEX_FILE = file;
    try {
      const { io, output } = captureOutput();
      const program = createProgram({ ...io, fetch: async () => { throw new Error("no fetch"); } });
      await program.parseAsync(["node", "muse", "status", "--user", "stark"], { from: "node" });
      expect(output.join("")).toContain(
        "rag: indexed — 2 file(s), nomic-embed-text (run `muse doctor` to confirm the embed model is pulled)"
      );
    } finally {
      if (prev === undefined) delete process.env.MUSE_NOTES_INDEX_FILE;
      else process.env.MUSE_NOTES_INDEX_FILE = prev;
    }
  });

  it("formatMetricsSnapshot pretty-prints SLO / drift / token / budget sections (goal 077)", async () => {
    const { formatMetricsSnapshot } = await import("../src/commands-metrics.js");
    // Empty payload → friendly hint.
    expect(formatMetricsSnapshot(null)).toContain("empty snapshot");
    expect(formatMetricsSnapshot({})).toContain("empty snapshot");

    // Full payload: each known section renders + values pass through.
    const rendered = formatMetricsSnapshot({
      slo: { passRate: 0.98, errorBudget: "ok" },
      drift: { agentA: { runs: 12, percent: 3.2 } },
      tokenCost: { totalUsd: 1.42, runs: 47 },
      budget: { remainingUsd: 12.5 },
      unknownExtra: "stays under 'other'"
    });
    expect(rendered).toContain("Muse metrics:");
    expect(rendered).toContain("  slo:");
    expect(rendered).toContain("passRate: 0.98");
    expect(rendered).toContain("errorBudget: ok");
    expect(rendered).toContain("  drift:");
    expect(rendered).toContain("agentA:"); // nested record stringified
    expect(rendered).toContain("  token cost:");
    expect(rendered).toContain("totalUsd: 1.42");
    expect(rendered).toContain("  budget:");
    expect(rendered).toContain("remainingUsd: 12.5");
    expect(rendered).toContain("  other:");
    expect(rendered).toContain("unknownExtra: stays under 'other'");
  });

  it("muse trace tail helpers parse interval / limit / events (goal 076)", async () => {
    const {
      resolveTraceTailIntervalMs,
      resolveTraceTailLimit,
      extractTraceTailEvents
    } = await import("../src/commands-traces.js");
    expect(resolveTraceTailIntervalMs(undefined)).toBe(2_000);
    expect(resolveTraceTailIntervalMs("5")).toBe(5_000);
    expect(resolveTraceTailIntervalMs("0")).toBe(2_000);
    expect(resolveTraceTailIntervalMs("-1")).toBe(2_000);
    expect(resolveTraceTailIntervalMs("999")).toBe(60_000); // upper clamp
    expect(resolveTraceTailIntervalMs("0.5")).toBe(1_000); // lower clamp to 1s
    expect(resolveTraceTailIntervalMs("10x")).toBe(2_000);
    expect(resolveTraceTailIntervalMs("10min")).toBe(2_000);
    expect(resolveTraceTailIntervalMs("10 seconds")).toBe(2_000);

    expect(resolveTraceTailLimit(undefined)).toBe(20);
    expect(resolveTraceTailLimit("50")).toBe(50);
    expect(resolveTraceTailLimit("0")).toBe(20);
    expect(resolveTraceTailLimit("9999")).toBe(200);

    // Array → array.
    expect(extractTraceTailEvents([{ id: "a" }, { id: "b" }])).toHaveLength(2);
    // { events: [...] } envelope → unwrapped.
    expect(extractTraceTailEvents({ events: [{ id: "a" }] })).toHaveLength(1);
    // { spans: [...] } envelope also accepted (alternative shape).
    expect(extractTraceTailEvents({ spans: [{ spanId: "x" }] })).toHaveLength(1);
    // Garbage → empty.
    expect(extractTraceTailEvents(null)).toEqual([]);
    expect(extractTraceTailEvents("not json")).toEqual([]);
    expect(extractTraceTailEvents({})).toEqual([]);
  });

  it("muse mcp status renders 'reconnecting in Ns' for servers with a scheduled retry (goal 075)", async () => {
    const fixedNow = new Date("2026-05-14T12:00:00Z");
    const { io, output } = captureOutput();
    const program = createProgram({
      ...io,
      fetch: async (url) => {
        const path = String(url);
        if (path.endsWith("/api/mcp/servers")) {
          return new Response(JSON.stringify([
            { name: "alpha" }, { name: "beta" }
          ]));
        }
        if (path.endsWith("/api/mcp/servers/alpha/health")) {
          return new Response(JSON.stringify({
            status: "unhealthy",
            error: "stdio spawn failed",
            reconnectAttempts: 2,
            nextReconnectAt: new Date(fixedNow.getTime() + 8_000).toISOString()
          }));
        }
        if (path.endsWith("/api/mcp/servers/beta/health")) {
          return new Response(JSON.stringify({
            status: "healthy",
            reconnectAttempts: 0
          }));
        }
        return new Response("{}");
      }
    });
    await program.parseAsync(
      ["node", "muse", "--api-url", "http://api.test", "mcp", "status"],
      { from: "node" }
    );
    const text = output.join("");
    expect(text).toMatch(/alpha\tUNHEALTHY.*reconnecting in \d+s.*attempt 2.*stdio spawn failed/);
    expect(text).toContain("beta\tHEALTHY");
    expect(text).not.toContain("beta\tHEALTHY (reconnecting");
  });

  it("isNotesIndexValid gates the on-disk schema version (goal 074)", async () => {
    const { isNotesIndexValid, NOTES_INDEX_SCHEMA_VERSION, isNotesIndexStale } = await import("../src/commands-notes-rag.js");
    expect(NOTES_INDEX_SCHEMA_VERSION).toBe(1);

    // Valid shape.
    expect(isNotesIndexValid({ version: NOTES_INDEX_SCHEMA_VERSION })).toBe(true);
    // Missing / wrong version → invalid.
    expect(isNotesIndexValid(undefined)).toBe(false);
    expect(isNotesIndexValid({})).toBe(false);
    expect(isNotesIndexValid({ version: 0 })).toBe(false);
    expect(isNotesIndexValid({ version: 2 })).toBe(false);
    expect(isNotesIndexValid({ version: "1" })).toBe(false);

    // End-to-end: a v0 index on disk causes `isNotesIndexStale` to
    // return true so the next reindex rebuilds the file from scratch
    // (instead of inheriting any v0 entries).
    const root = await mkdtemp(path.join(tmpdir(), "muse-cli-notes-schema-"));
    const fsp = await import("node:fs/promises");
    const notesDir = path.join(root, "notes");
    const indexPath = path.join(root, "notes-index.json");
    await fsp.mkdir(notesDir, { recursive: true });
    await fsp.writeFile(path.join(notesDir, "alpha.md"), "# alpha\nhello\n");
    await fsp.writeFile(indexPath, JSON.stringify({
      version: 0,
      model: "stale-embed",
      builtAtIso: "2020-01-01T00:00:00.000Z",
      files: [{ path: path.join(notesDir, "ghost.md"), mtimeMs: 0, chunks: [] }]
    }));
    expect(await isNotesIndexStale(notesDir, indexPath)).toBe(true);
  });

  it("resolveDoctorWatchIntervalMs defaults to 5s and clamps to [1s, 3600s] (goal 068)", async () => {
    const { resolveDoctorWatchIntervalMs } = await import("../src/commands-doctor.js");
    expect(resolveDoctorWatchIntervalMs(undefined)).toBe(5_000);
    expect(resolveDoctorWatchIntervalMs("")).toBe(5_000);
    expect(resolveDoctorWatchIntervalMs("nope")).toBe(5_000);
    expect(resolveDoctorWatchIntervalMs("0")).toBe(5_000);
    expect(resolveDoctorWatchIntervalMs("-5")).toBe(5_000);
    expect(resolveDoctorWatchIntervalMs("2")).toBe(2_000);
    expect(resolveDoctorWatchIntervalMs("0.5")).toBe(1_000); // sub-1s clamps up
    expect(resolveDoctorWatchIntervalMs("99999")).toBe(3_600_000); // upper clamp
    expect(resolveDoctorWatchIntervalMs("10x")).toBe(5_000);
    expect(resolveDoctorWatchIntervalMs("10min")).toBe(5_000);
    expect(resolveDoctorWatchIntervalMs("10 seconds")).toBe(5_000);
  });

  it("withSigintAbort threads an AbortSignal + sets exit code 130 on Ctrl-C (goal 067)", async () => {
    const { withSigintAbort } = await import("../src/sigint-abort.js");
    // Happy path: no SIGINT → action runs to completion + no exit code touched.
    process.exitCode = undefined as unknown as number;
    const ok = await withSigintAbort(async (signal) => {
      expect(signal.aborted).toBe(false);
      return "done";
    });
    expect(ok).toBe("done");
    expect(process.exitCode).toBeUndefined();

    // SIGINT path: emit SIGINT mid-action; abort fires, exit code = 130.
    process.exitCode = undefined as unknown as number;
    let sawAbort = false;
    let noticeFired = false;
    await withSigintAbort(async (signal) => {
      // Schedule the SIGINT for next tick so the listener is wired.
      setImmediate(() => process.emit("SIGINT" as never));
      await new Promise<void>((resolve) => {
        signal.addEventListener("abort", () => { sawAbort = true; resolve(); }, { once: true });
      });
    }, { onSigint: () => { noticeFired = true; } });
    expect(sawAbort).toBe(true);
    expect(noticeFired).toBe(true);
    expect(process.exitCode).toBe(130);
    process.exitCode = 0;
  });

  it("muse completion bash + zsh emit valid scripts mentioning real subcommands (goal 066)", async () => {
    const { io, output } = captureOutput();
    const program = createProgram({ ...io, fetch: async () => { throw new Error("no fetch"); } });
    await program.parseAsync(["node", "muse", "completion", "bash"], { from: "node" });
    const bash = output.join("");
    expect(bash).toContain("_muse_completions()");
    expect(bash).toContain("complete -F _muse_completions muse");
    expect(bash).toContain("status");
    expect(bash).toContain("history");
    expect(bash).toContain("export");
    // The 'completion' verb is excluded from the verb list so
    // `muse completion <tab>` doesn't suggest itself.
    expect(bash).not.toMatch(/local subs="[^"]*\bcompletion\b/);

    const { io: io2, output: out2 } = captureOutput();
    const program2 = createProgram({ ...io2, fetch: async () => { throw new Error("no fetch"); } });
    await program2.parseAsync(["node", "muse", "completion", "zsh"], { from: "node" });
    const zsh = out2.join("");
    expect(zsh.startsWith("#compdef muse")).toBe(true);
    expect(zsh).toContain("_describe -t commands");
    expect(zsh).toContain("'status'");

    // Bad shell name → exits non-zero with a useful message.
    const { io: io3, output: out3 } = captureOutput();
    const program3 = createProgram({ ...io3, fetch: async () => { throw new Error("no fetch"); } });
    await program3.parseAsync(["node", "muse", "completion", "fish"], { from: "node" });
    expect(out3.join("")).toMatch(/only 'bash' and 'zsh' are supported/);
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;

    // One-edit typo for "zsh" suggests "zsh" (closest-command convention).
    const { io: io4, output: out4 } = captureOutput();
    const program4 = createProgram({ ...io4, fetch: async () => { throw new Error("no fetch"); } });
    await program4.parseAsync(["node", "muse", "completion", "zish"], { from: "node" });
    expect(out4.join(""), "typo on zsh must surface the actionable suggestion").toContain("did you mean 'zsh'?");
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;

    // One-edit typo for "bash" suggests "bash".
    const { io: io5, output: out5 } = captureOutput();
    const program5 = createProgram({ ...io5, fetch: async () => { throw new Error("no fetch"); } });
    await program5.parseAsync(["node", "muse", "completion", "bsh"], { from: "node" });
    expect(out5.join("")).toContain("did you mean 'bash'?");
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;

    // Unrelated input gets the listing only — NO false-positive suggestion.
    const { io: io6, output: out6 } = captureOutput();
    const program6 = createProgram({ ...io6, fetch: async () => { throw new Error("no fetch"); } });
    await program6.parseAsync(["node", "muse", "completion", "totally-unrelated"], { from: "node" });
    const text6 = out6.join("");
    expect(text6).toContain("only 'bash' and 'zsh' are supported");
    expect(text6, "unrelated input must NOT pull in a misleading suggestion").not.toContain("did you mean");
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
  });

  it("colorize respects NO_COLOR + isTty + force flags (goal 061)", async () => {
    const { colorize, colorAllowed } = await import("../src/tty-color.js");
    const prev = process.env.NO_COLOR;
    try {
      delete process.env.NO_COLOR;
      // Force on → ANSI sequence wraps the value.
      expect(colorize("over", "red", { force: true })).toBe("\x1b[31mover\x1b[0m");
      // No-TTY → plain string passes through.
      expect(colorize("over", "red", { isTty: false })).toBe("over");
      expect(colorAllowed({ isTty: false })).toBe(false);
      // NO_COLOR (https://no-color.org/) wins over both isTty and force.
      process.env.NO_COLOR = "1";
      expect(colorAllowed({ force: true })).toBe(false);
      expect(colorAllowed({ isTty: true })).toBe(false);
      expect(colorize("over", "red", { isTty: true })).toBe("over");
      expect(colorize("over", "red", { force: true })).toBe("over");
      // Unknown color name falls through untouched.
      delete process.env.NO_COLOR;
      expect(colorize("plain", "not-a-color" as never, { force: true })).toBe("plain");
    } finally {
      if (prev === undefined) delete process.env.NO_COLOR;
      else process.env.NO_COLOR = prev;
    }
  });

  it("muse search formatted output prints backend latency (goal 065)", async () => {
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = (async (): Promise<Response> => new Response(
        `<a rel="nofollow" class="result__a" href="https://e.test/p">hit</a>` +
        `<a class="result__snippet" href="x">snip</a>`,
        { status: 200 }
      )) as typeof globalThis.fetch;
      const { io, output } = captureOutput();
      const program = createProgram({ ...io, fetch: async () => { throw new Error("api fetch off"); } });
      await program.parseAsync(["node", "muse", "search", "anything"], { from: "node" });
      const text = output.join("");
      // Banner now ends with "— <N> ms)" before the results.
      expect(text).toMatch(/result\(s\) via duckduckgo — \d+ ms\)/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("parseIcsEvents extracts the minimum-viable VEVENT shape (goal 059)", async () => {
    const { parseIcsEvents } = await import("../src/ics-parser.js");
    const body = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "BEGIN:VEVENT",
      "UID:evt-1@muse",
      "SUMMARY:Coffee with Alice",
      "DTSTART:20260515T140000Z",
      "DTEND:20260515T150000Z",
      "LOCATION:Cafe Muse",
      "DESCRIPTION:Catch up\\nwith Alice",
      "END:VEVENT",
      "BEGIN:VEVENT",
      "UID:evt-2@muse",
      "SUMMARY:Holiday",
      "DTSTART;VALUE=DATE:20260516",
      "DTEND;VALUE=DATE:20260517",
      "END:VEVENT",
      "BEGIN:VEVENT",
      "SUMMARY:Malformed — no DTSTART",
      "END:VEVENT",
      "END:VCALENDAR"
    ].join("\r\n");

    const events = parseIcsEvents(body);
    expect(events.length).toBe(2);
    expect(events[0]?.title).toBe("Coffee with Alice");
    expect(events[0]?.allDay).toBe(false);
    expect(events[0]?.startsAt.toISOString()).toBe("2026-05-15T14:00:00.000Z");
    expect(events[0]?.endsAt.toISOString()).toBe("2026-05-15T15:00:00.000Z");
    expect(events[0]?.location).toBe("Cafe Muse");
    expect(events[0]?.notes).toBe("Catch up\nwith Alice");
    expect(events[0]?.uid).toBe("evt-1@muse");

    expect(events[1]?.allDay).toBe(true);
    expect(events[1]?.startsAt.toISOString()).toBe("2026-05-16T00:00:00.000Z");
  });

  it("computeMemoryDiff buckets added / changed / removed per slot (goal 051)", async () => {
    const { computeMemoryDiff } = await import("../src/commands-memory.js");
    const baseline = {
      facts: { name: "Stark", city: "Seoul" },
      preferences: { language: "ko" }
    };
    const current = {
      facts: { name: "Stark", city: "Tokyo", role: "engineer" },
      preferences: { language: "ko", style: "concise" }
    };
    const diff = computeMemoryDiff(baseline, current);
    expect(diff.facts.added).toEqual({ role: "engineer" });
    expect(diff.facts.changed).toEqual({ city: { from: "Seoul", to: "Tokyo" } });
    expect(diff.facts.removed).toEqual({});
    expect(diff.preferences.added).toEqual({ style: "concise" });
    expect(diff.preferences.changed).toEqual({});
    expect(diff.preferences.removed).toEqual({});
    expect(diff.totalChanges).toBe(3);

    // Empty baseline = every current entry counts as added.
    const fromZero = computeMemoryDiff({}, current);
    expect(Object.keys(fromZero.facts.added).length).toBe(3);
    expect(Object.keys(fromZero.preferences.added).length).toBe(2);
    expect(fromZero.totalChanges).toBe(5);

    // Removed bucket fires when a key drops out.
    const removal = computeMemoryDiff({ facts: { a: "1", b: "2" } }, { facts: { a: "1" } });
    expect(removal.facts.removed).toEqual({ b: "2" });
    expect(removal.totalChanges).toBe(1);
  });

  it("encryptExportBuffer + decryptExportBuffer round-trip with the right passphrase (goal 081)", async () => {
    const { encryptExportBuffer, decryptExportBuffer, isEncryptedExportBuffer } = await import("../src/export-crypto.js");
    const plain = Buffer.from("hello-muse-export-bytes\n");
    const cipher = encryptExportBuffer(plain, "correct horse battery staple");
    expect(isEncryptedExportBuffer(cipher)).toBe(true);
    expect(cipher.subarray(0, 4).toString("ascii")).toBe("MUSE");
    // The encrypted blob does not contain the plaintext.
    expect(cipher.includes(plain)).toBe(false);
    // Right passphrase decrypts to identical bytes.
    expect(decryptExportBuffer(cipher, "correct horse battery staple").equals(plain)).toBe(true);
    // Wrong passphrase throws a clear, non-byte-leaking message.
    expect(() => decryptExportBuffer(cipher, "WRONG")).toThrow(/wrong passphrase/i);
    // A buffer without the magic header is detected up front.
    expect(isEncryptedExportBuffer(Buffer.from("PK\x03\x04"))).toBe(false);
    expect(() => decryptExportBuffer(Buffer.from("PK\x03\x04"), "anything")).toThrow(/MUSE magic/);
  });

  it("buildMuseExport --encrypt round-trips through muse import --decrypt (goal 081)", async () => {
    const { buildMuseExport } = await import("../src/commands-export.js");
    const { listMuseImportEntries } = await import("../src/commands-import.js");
    const { decryptExportBuffer, isEncryptedExportBuffer } = await import("../src/export-crypto.js");
    const root = await mkdtemp(path.join(tmpdir(), "muse-cli-export-enc-"));
    const fsp = await import("node:fs/promises");
    const museDir = path.join(root, ".muse");
    const notesDir = path.join(museDir, "notes");
    await fsp.mkdir(museDir, { recursive: true });
    await fsp.mkdir(notesDir, { recursive: true });
    await fsp.writeFile(path.join(museDir, "tasks.json"), JSON.stringify({ tasks: [{ id: "t1" }] }));
    await fsp.writeFile(path.join(notesDir, "hi.md"), "hello");
    const outputPath = path.join(root, "bundle.tar.gz.enc");

    const summary = await buildMuseExport({
      museDir, notesDir, outputPath,
      passphrase: "my-laptop-backup-2026"
    });
    expect(summary.encrypted).toBe(true);
    expect(summary.outputPath).toBe(outputPath);

    // On-disk file is encrypted (magic header present, no
    // cleartext shadow next to it).
    const onDisk = await fsp.readFile(outputPath);
    expect(isEncryptedExportBuffer(onDisk)).toBe(true);
    await expect(fsp.stat(`${outputPath}.cleartext.tmp`)).rejects.toThrow();

    // Decrypting yields a real .tar.gz that listMuseImportEntries
    // can read.
    const decrypted = decryptExportBuffer(onDisk, "my-laptop-backup-2026");
    const clearPath = path.join(root, "decrypted.tar.gz");
    await fsp.writeFile(clearPath, decrypted);
    const entries = await listMuseImportEntries(clearPath);
    expect(entries).toContain(".muse/tasks.json");
    expect(entries.some((e) => e === ".muse/notes/hi.md")).toBe(true);
  });

  it("reserveCleartextTemp keeps the pre-encrypt secret tarball owner-only, even over a stale temp (goal 239)", async () => {
    const { reserveCleartextTemp } = await import("../src/commands-export.js");
    const fsp = await import("node:fs/promises");
    const root = await mkdtemp(path.join(tmpdir(), "muse-cli-export-perms-"));

    // Fresh create → 0o600.
    const fresh = path.join(root, "bundle.tar.gz.cleartext.tmp");
    await reserveCleartextTemp(fresh);
    expect((await fsp.stat(fresh)).mode & 0o777).toBe(0o600);

    // A stale world-readable temp from a hard-killed run is tightened
    // (writeFile's `mode` is ignored when the file already exists, so
    // the explicit chmod is what closes this).
    const stale = path.join(root, "stale.cleartext.tmp");
    await fsp.writeFile(stale, "leftover secrets", { mode: 0o666 });
    await reserveCleartextTemp(stale);
    expect((await fsp.stat(stale)).mode & 0o777).toBe(0o600);
    expect(await fsp.readFile(stale, "utf8")).toBe("");
  });

  it("buildMuseExport bundles every present ~/.muse/*.json + the notes tree, skipping missing siblings (goal 048)", async () => {
    const { buildMuseExport, buildExportReadme, DEFAULT_EXPORT_FILES } = await import("../src/commands-export.js");
    const root = await mkdtemp(path.join(tmpdir(), "muse-cli-export-"));
    const fsp = await import("node:fs/promises");
    const museDir = path.join(root, ".muse");
    const notesDir = path.join(museDir, "notes");
    await fsp.mkdir(museDir, { recursive: true });
    await fsp.mkdir(notesDir, { recursive: true });
    // Two present stores, one empty (must be skipped), the rest missing.
    await fsp.writeFile(path.join(museDir, "tasks.json"), JSON.stringify({ tasks: [{ id: "t1" }] }));
    await fsp.writeFile(path.join(museDir, "reminders.json"), JSON.stringify({ reminders: [] }));
    await fsp.writeFile(path.join(museDir, "user-memory.json"), ""); // empty → skipped
    await fsp.writeFile(path.join(notesDir, "hello.md"), "# hello\nworld\n");
    const outputPath = path.join(root, "bundle.tar.gz");

    const summary = await buildMuseExport({ museDir, notesDir, outputPath });
    expect(summary.outputPath).toBe(outputPath);
    expect(summary.notesIncluded).toBe(true);
    expect([...summary.files].sort()).toEqual(["reminders.json", "tasks.json"]);

    // Verify the tarball actually landed + is non-empty.
    const stats = await fsp.stat(outputPath);
    expect(stats.isFile()).toBe(true);
    expect(stats.size).toBeGreaterThan(0);

    // The post-export cleanup unlinked README.export.md.
    await expect(fsp.stat(path.join(museDir, "README.export.md"))).rejects.toThrow();

    // The README builder lists only the files actually included +
    // the restore command — fast structural check (no need to
    // round-trip the tar bytes).
    const readme = buildExportReadme(["tasks.json", "reminders.json"], notesDir, "2026-05-14T00:00:00.000Z");
    expect(readme).toContain("Created: 2026-05-14T00:00:00.000Z");
    expect(readme).toContain("`.muse/tasks.json`");
    expect(readme).toContain("`.muse/reminders.json`");
    expect(readme).toContain(notesDir);
    expect(readme).toContain("tar -xzf <this-bundle>.tar.gz -C \"$HOME\"");
    // Files NOT present must not be listed.
    expect(readme).not.toContain("`.muse/user-memory.json`");

    // The exported allowlist surface stays stable for downstream
    // tools that mirror the manifest.
    expect(DEFAULT_EXPORT_FILES).toContain("tasks.json");
    expect(DEFAULT_EXPORT_FILES).toContain("user-memory.json");
  });

  it("NOTES_ONLY_TOOL_ALLOWLIST excludes web/search/fetch tools by design (goal 047)", async () => {
    const { NOTES_ONLY_TOOL_ALLOWLIST } = await import("../src/commands-ask.js");
    // Whitelist is exactly the notes + memory surface — nothing else.
    expect([...NOTES_ONLY_TOOL_ALLOWLIST].sort()).toEqual(["muse.context", "muse.notes", "muse.notes-multi"]);
    // Negative assertions — the names below would betray the goal if
    // they crept into the allowlist, so guard them explicitly.
    expect([...NOTES_ONLY_TOOL_ALLOWLIST]).not.toContain("muse.search");
    expect([...NOTES_ONLY_TOOL_ALLOWLIST]).not.toContain("muse.fetch");
    expect([...NOTES_ONLY_TOOL_ALLOWLIST]).not.toContain("muse.url");
    expect([...NOTES_ONLY_TOOL_ALLOWLIST]).not.toContain("web_search");
  });

  it("resolveStatusWatchIntervalMs defaults to 5s and clamps to [1s, 3600s] (goal 046)", async () => {
    const { resolveStatusWatchIntervalMs } = await import("../src/commands-status.js");
    expect(resolveStatusWatchIntervalMs(undefined)).toBe(5_000);
    expect(resolveStatusWatchIntervalMs("")).toBe(5_000);
    expect(resolveStatusWatchIntervalMs("not-a-number")).toBe(5_000);
    expect(resolveStatusWatchIntervalMs("0")).toBe(5_000);
    expect(resolveStatusWatchIntervalMs("-3")).toBe(5_000);
    expect(resolveStatusWatchIntervalMs("10x")).toBe(5_000);
    expect(resolveStatusWatchIntervalMs("10min")).toBe(5_000);
    expect(resolveStatusWatchIntervalMs("10 seconds")).toBe(5_000);
    // Clean values pass through.
    expect(resolveStatusWatchIntervalMs("2")).toBe(2_000);
    expect(resolveStatusWatchIntervalMs("0.5")).toBe(1_000);
    expect(resolveStatusWatchIntervalMs("60")).toBe(60_000);
    // Upper clamp at 3600s.
    expect(resolveStatusWatchIntervalMs("99999")).toBe(3_600_000);
  });

  it("muse calendar tomorrow / this-week compute the right ranges (goal 021)", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "muse-cli-cal-quick-"));
    const fsp = await import("node:fs/promises");
    const calendarFile = path.join(root, "calendar.json");
    const now = new Date();
    const today = new Date(now);
    today.setHours(10, 0, 0, 0);
    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(11, 0, 0, 0);
    const monthAway = new Date(now);
    monthAway.setDate(monthAway.getDate() + 30);
    monthAway.setHours(9, 0, 0, 0);

    const events = [
      { id: "ev_today", title: "Today's standup", startsAt: today.toISOString(), endsAt: new Date(today.getTime() + 30 * 60_000).toISOString(), allDay: false },
      { id: "ev_tomorrow", title: "Tomorrow's review", startsAt: tomorrow.toISOString(), endsAt: new Date(tomorrow.getTime() + 60 * 60_000).toISOString(), allDay: false },
      { id: "ev_month", title: "Next month", startsAt: monthAway.toISOString(), endsAt: new Date(monthAway.getTime() + 60 * 60_000).toISOString(), allDay: false }
    ];
    await fsp.writeFile(calendarFile, JSON.stringify({ events }), "utf8");

    const prev = process.env.MUSE_CALENDAR_FILE;
    process.env.MUSE_CALENDAR_FILE = calendarFile;
    try {
      const { io: io1, output: out1 } = captureOutput();
      const program1 = createProgram({ ...io1, fetch: async () => { throw new Error("api off"); } });
      await program1.parseAsync(["node", "muse", "calendar", "tomorrow", "--local", "--json"], { from: "node" });
      const r1 = JSON.parse(out1.join("")) as { events: Array<{ id: string }>; total: number };
      expect(r1.events.map((e) => e.id)).toEqual(["ev_tomorrow"]);

      const { io: io2, output: out2 } = captureOutput();
      const program2 = createProgram({ ...io2, fetch: async () => { throw new Error("api off"); } });
      await program2.parseAsync(["node", "muse", "calendar", "this-week", "--local", "--json"], { from: "node" });
      const r2 = JSON.parse(out2.join("")) as { events: Array<{ id: string }> };
      // ev_today is fixed at 10:00 today; ev_tomorrow at 11:00 tomorrow.
      // Depending on weekday + current hour, either may already be in
      // the past (today) or after end-of-week (tomorrow when today is
      // Sunday). What's invariant: ev_month (30 days away) is NEVER
      // in this-week's range. That's the lock-in.
      expect(r2.events.map((e) => e.id)).not.toContain("ev_month");
    } finally {
      if (prev === undefined) delete process.env.MUSE_CALENDAR_FILE;
      else process.env.MUSE_CALENDAR_FILE = prev;
    }
  });

  it("muse history --kind X empty output tailors the empty hint to the requested kind (goal 022)", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "muse-cli-hist-emptyhint-"));
    const fsp = await import("node:fs/promises");
    const remindersHistoryFile = path.join(root, "reminder-history.json");
    const followupsFile = path.join(root, "followups.json");
    await fsp.writeFile(remindersHistoryFile, JSON.stringify({ entries: [], version: 1 }), "utf8");
    await fsp.writeFile(followupsFile, JSON.stringify({ followups: [] }), "utf8");

    const prev = {
      reminderHistory: process.env.MUSE_REMINDER_HISTORY_FILE,
      followups: process.env.MUSE_FOLLOWUPS_FILE
    };
    process.env.MUSE_REMINDER_HISTORY_FILE = remindersHistoryFile;
    process.env.MUSE_FOLLOWUPS_FILE = followupsFile;
    try {
      const { io, output } = captureOutput();
      const program = createProgram({ ...io, fetch: async () => { throw new Error("no fetch"); } });
      await program.parseAsync(["node", "muse", "history", "--kind", "followup"], { from: "node" });
      expect(output.join("")).toContain("no followup activity yet");
    } finally {
      if (prev.reminderHistory === undefined) delete process.env.MUSE_REMINDER_HISTORY_FILE;
      else process.env.MUSE_REMINDER_HISTORY_FILE = prev.reminderHistory;
      if (prev.followups === undefined) delete process.env.MUSE_FOLLOWUPS_FILE;
      else process.env.MUSE_FOLLOWUPS_FILE = prev.followups;
    }
  });

  it("muse doctor --local prints an overall verdict footer + exits non-zero on fail (goal 030)", async () => {
    // Force the "fail" branch by un-setting MUSE_MODEL / every provider key.
    const prev = {
      muse_model: process.env.MUSE_MODEL,
      muse_default_model: process.env.MUSE_DEFAULT_MODEL,
      gemini: process.env.GEMINI_API_KEY,
      anthropic: process.env.ANTHROPIC_API_KEY,
      openai: process.env.OPENAI_API_KEY,
      openrouter: process.env.OPENROUTER_API_KEY,
      google: process.env.GOOGLE_API_KEY,
      modelKeysFile: process.env.MUSE_MODEL_KEYS_FILE
    };
    delete process.env.MUSE_MODEL;
    delete process.env.MUSE_DEFAULT_MODEL;
    delete process.env.GEMINI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.GOOGLE_API_KEY;
    process.env.MUSE_MODEL_KEYS_FILE = path.join(await mkdtemp(path.join(tmpdir(), "muse-cli-doctor-fail-")), "missing.json");
    const prevOllama = process.env.OLLAMA_BASE_URL;
    delete process.env.OLLAMA_BASE_URL;
    try {
      const { io, output } = captureOutput();
      const program = createProgram({ ...io, fetch: async () => { throw new Error("api off"); } });
      await program.parseAsync(["node", "muse", "doctor", "--local"], { from: "node" });
      const text = output.join("");
      expect(text).toContain("Overall: FAIL");
      expect(process.exitCode).toBe(1);
      process.exitCode = 0;
    } finally {
      const restore = (envKey: keyof typeof prev, k: string): void => {
        if (prev[envKey] === undefined) delete process.env[k];
        else process.env[k] = prev[envKey];
      };
      restore("muse_model", "MUSE_MODEL");
      restore("muse_default_model", "MUSE_DEFAULT_MODEL");
      restore("gemini", "GEMINI_API_KEY");
      restore("anthropic", "ANTHROPIC_API_KEY");
      restore("openai", "OPENAI_API_KEY");
      restore("openrouter", "OPENROUTER_API_KEY");
      restore("google", "GOOGLE_API_KEY");
      restore("modelKeysFile", "MUSE_MODEL_KEYS_FILE");
      if (prevOllama === undefined) delete process.env.OLLAMA_BASE_URL;
      else process.env.OLLAMA_BASE_URL = prevOllama;
    }
  });

  it("muse search --site <domain> prepends site:<domain> to the query (goal 017)", async () => {
    const originalFetch = globalThis.fetch;
    const prev = process.env.MUSE_SEARXNG_URL;
    let capturedUrl = "";
    try {
      process.env.MUSE_SEARXNG_URL = "http://searx.test.local";
      globalThis.fetch = (async (input: RequestInfo | URL): Promise<Response> => {
        capturedUrl = String(input);
        return new Response(JSON.stringify({ results: [{ title: "x", url: "https://example.com/y" }] }), {
          headers: { "content-type": "application/json" },
          status: 200
        });
      }) as typeof globalThis.fetch;
      const { io } = captureOutput();
      const program = createProgram({ ...io, fetch: async () => { throw new Error("api off"); } });
      await program.parseAsync(["node", "muse", "search", "best deals", "--site", "example.com", "--json"], { from: "node" });
      expect(capturedUrl).toContain("site%3Aexample.com");

      // Reject shell-meta-ish domains.
      const { io: io2 } = captureOutput();
      const program2 = createProgram({ ...io2, fetch: async () => { throw new Error("api off"); } });
      program2.exitOverride();
      await expect(program2.parseAsync(["node", "muse", "search", "x", "--site", "bad;site", "--json"], { from: "node" }))
        .rejects.toThrow(/--site must be a bare domain/u);
    } finally {
      globalThis.fetch = originalFetch;
      if (prev !== undefined) process.env.MUSE_SEARXNG_URL = prev;
      else delete process.env.MUSE_SEARXNG_URL;
    }
  });

  it("muse search --to-notes <path> writes a markdown note with title + numbered results (goal 016)", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "muse-cli-search-tonotes-"));
    const fsp = await import("node:fs/promises");
    const notesDir = path.join(root, "notes");
    await fsp.mkdir(notesDir, { recursive: true });
    const originalFetch = globalThis.fetch;
    const prev = { searxng: process.env.MUSE_SEARXNG_URL, notes: process.env.MUSE_NOTES_DIR };
    process.env.MUSE_NOTES_DIR = notesDir;
    delete process.env.MUSE_SEARXNG_URL;
    try {
      globalThis.fetch = (async (): Promise<Response> => {
        return new Response(
          `<a rel="nofollow" class="result__a" href="https://example.com/one">First Hit</a>` +
          `<a class="result__snippet" href="x">first body</a>`,
          { status: 200 }
        );
      }) as typeof globalThis.fetch;

      const { io } = captureOutput();
      const program = createProgram({ ...io, fetch: async () => { throw new Error("api off"); } });
      await program.parseAsync(["node", "muse", "search", "rust async", "--to-notes", "research/rust.md", "--json"], { from: "node" });
      const written = await fsp.readFile(path.join(notesDir, "research/rust.md"), "utf8");
      expect(written).toContain("# Search: rust async");
      expect(written).toContain("First Hit");
      expect(written).toContain("https://example.com/one");

      // --overwrite required for an existing file.
      const { io: io2 } = captureOutput();
      const program2 = createProgram({ ...io2, fetch: async () => { throw new Error("api off"); } });
      await program2.parseAsync(["node", "muse", "search", "rust again", "--to-notes", "research/rust.md", "--json"], { from: "node" });
      expect(process.exitCode).toBe(1);
      process.exitCode = 0;

      const { io: io3 } = captureOutput();
      const program3 = createProgram({ ...io3, fetch: async () => { throw new Error("api off"); } });
      await program3.parseAsync(["node", "muse", "search", "rust again", "--to-notes", "research/rust.md", "--overwrite", "--json"], { from: "node" });
      const after = await fsp.readFile(path.join(notesDir, "research/rust.md"), "utf8");
      expect(after).toContain("# Search: rust again");
    } finally {
      globalThis.fetch = originalFetch;
      if (prev.searxng !== undefined) process.env.MUSE_SEARXNG_URL = prev.searxng;
      if (prev.notes === undefined) delete process.env.MUSE_NOTES_DIR;
      else process.env.MUSE_NOTES_DIR = prev.notes;
    }
  });

  it("muse search --to-notes scrubs credentials from backend snippets before write (goal 140)", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "muse-search-tonotes-redact-"));
    const fsp = await import("node:fs/promises");
    const notesDir = path.join(root, "notes");
    await fsp.mkdir(notesDir, { recursive: true });
    const originalFetch = globalThis.fetch;
    const prev = { searxng: process.env.MUSE_SEARXNG_URL, notes: process.env.MUSE_NOTES_DIR };
    process.env.MUSE_NOTES_DIR = notesDir;
    delete process.env.MUSE_SEARXNG_URL;
    try {
      // Fake DDG backend whose snippet quotes a leaked OpenAI key
      // AND whose title carries a github PAT shape. The saved note
      // must NOT carry verbatim secrets.
      globalThis.fetch = (async (): Promise<Response> => {
        return new Response(
          `<a rel="nofollow" class="result__a" href="https://example.com/leak">` +
          `Leak post: ghp_abcdefghijklmnopqrstuvwxyzABCDEF</a>` +
          `<a class="result__snippet" href="x">` +
          `Page demonstrates rotate sk-proj-abcdefghijklmnopqrstuvwxyz workflow</a>`,
          { status: 200 }
        );
      }) as typeof globalThis.fetch;

      const { io } = captureOutput();
      const program = createProgram({ ...io, fetch: async () => { throw new Error("api off"); } });
      await program.parseAsync(
        ["node", "muse", "search", "key rotation", "--to-notes", "research/keys.md", "--json"],
        { from: "node" }
      );
      const written = await fsp.readFile(path.join(notesDir, "research/keys.md"), "utf8");
      // Verbatim secrets MUST NOT survive to disk.
      expect(written).not.toContain("sk-proj-abcdefghijklmnopqrstuvwxyz");
      expect(written).not.toContain("ghp_abcdefghijklmnopqrstuvwxyzABCDEF");
      // Redaction markers DO survive.
      expect(written).toContain("[redacted-openai-key]");
      expect(written).toContain("[redacted-github-pat]");
      // Surrounding prose + URL pass through unchanged — URLs are
      // identifiers, mangling them breaks the note.
      expect(written).toContain("Page demonstrates rotate ");
      expect(written).toContain("https://example.com/leak");
      expect(written).toContain("# Search: key rotation");
    } finally {
      globalThis.fetch = originalFetch;
      if (prev.searxng !== undefined) process.env.MUSE_SEARXNG_URL = prev.searxng;
      if (prev.notes === undefined) delete process.env.MUSE_NOTES_DIR;
      else process.env.MUSE_NOTES_DIR = prev.notes;
    }
  });

  it("muse search formatted output strips ANSI / control characters from untrusted backend text", async () => {
    const { stripUntrustedTerminalChars } = await import("../src/commands-search.js");
    // Direct unit checks on the helper:
    expect(stripUntrustedTerminalChars("Hello\x1b[2J\x1b[H")).toBe("Hello[2J[H");
    expect(stripUntrustedTerminalChars("a\x07b\x00c")).toBe("abc");
    expect(stripUntrustedTerminalChars("ok\nstays")).toBe("ok\nstays");
    // C1 range (e.g. \x9b "CSI") is also stripped — some terminals
    // honour the bare CSI as start-of-escape-sequence.
    expect(stripUntrustedTerminalChars("title\x9b31mEVIL")).toBe("title31mEVIL");

    // End-to-end: a backend whose snippet embeds a bare ESC[2J does
    // NOT make it through to stdout.
    const originalFetch = globalThis.fetch;
    const prev = process.env.MUSE_SEARXNG_URL;
    try {
      delete process.env.MUSE_SEARXNG_URL;
      globalThis.fetch = (async (): Promise<Response> => {
        return new Response(
          `<a rel="nofollow" class="result__a" href="https://example.com/one">Plain Title</a>` +
          `<a class="result__snippet" href="x">snippet \x1b[2J\x07with control bytes</a>`,
          { status: 200 }
        );
      }) as typeof globalThis.fetch;

      const { io, output } = captureOutput();
      const program = createProgram({ ...io, fetch: async () => { throw new Error("api fetch off"); } });
      await program.parseAsync(["node", "muse", "search", "test"], { from: "node" });
      const text = output.join("");
      expect(text).toContain("snippet [2Jwith control bytes"); // the ESC + BEL are gone, the literal "[2J" survives as plain text
      expect(text).not.toMatch(/\x1b/u);
      expect(text).not.toMatch(/\x07/u);
    } finally {
      globalThis.fetch = originalFetch;
      if (prev !== undefined) process.env.MUSE_SEARXNG_URL = prev;
      else delete process.env.MUSE_SEARXNG_URL;
    }
  });

  it("resolveOllamaUrl reads OLLAMA_BASE_URL from env first, then ~/.muse/models.json, then default", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "muse-cli-ollama-url-"));
    const fsp = await import("node:fs/promises");
    const modelKeysFile = path.join(root, "models.json");
    const prev = {
      ollama: process.env.OLLAMA_BASE_URL,
      modelKeysFile: process.env.MUSE_MODEL_KEYS_FILE
    };
    delete process.env.OLLAMA_BASE_URL;
    process.env.MUSE_MODEL_KEYS_FILE = modelKeysFile;
    const { resolveOllamaUrl } = await import("../src/ollama-url.js");
    try {
      // Default (no env, no file).
      expect(resolveOllamaUrl()).toBe("http://127.0.0.1:11434");

      // File-only (wizard wrote ollama URL via `muse setup model`).
      await fsp.writeFile(modelKeysFile, JSON.stringify({
        providers: { ollama: { token: "http://192.168.1.10:11434/" } }
      }), "utf8");
      expect(resolveOllamaUrl()).toBe("http://192.168.1.10:11434");

      // Env wins on conflict.
      process.env.OLLAMA_BASE_URL = "http://localhost:9999//";
      expect(resolveOllamaUrl()).toBe("http://localhost:9999");
    } finally {
      const restore = (envKey: keyof typeof prev, k: string): void => {
        if (prev[envKey] === undefined) delete process.env[k];
        else process.env[k] = prev[envKey];
      };
      restore("ollama", "OLLAMA_BASE_URL");
      restore("modelKeysFile", "MUSE_MODEL_KEYS_FILE");
    }
  });

  it("setup-model wizard suggests 127.0.0.1 for Ollama, not localhost (goal 273)", async () => {
    const { SETUP_MODEL_PROVIDER_SPECS } = await import("../src/setup-model.js");
    const ollama = SETUP_MODEL_PROVIDER_SPECS.find((s) => s.id === "ollama");
    expect(ollama).toBeDefined();
    // Must match the runtime canonical default (resolveOllamaUrl):
    // a localhost hint steers IPv6 hosts into a phantom
    // "unreachable" since Ollama binds IPv4.
    expect(ollama?.placeholderHint).toBe("http://127.0.0.1:11434");
    expect(ollama?.placeholderHint).not.toContain("localhost");
  });

  it("muse doctor --local model env probe reads MUSE_MODEL from ~/.muse/models.json suggestedModel, not just env", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "muse-cli-doctor-models-"));
    const fsp = await import("node:fs/promises");
    const modelKeysFile = path.join(root, "models.json");
    const prev = {
      muse_model: process.env.MUSE_MODEL,
      muse_default_model: process.env.MUSE_DEFAULT_MODEL,
      gemini: process.env.GEMINI_API_KEY,
      anthropic: process.env.ANTHROPIC_API_KEY,
      openai: process.env.OPENAI_API_KEY,
      openrouter: process.env.OPENROUTER_API_KEY,
      ollama: process.env.OLLAMA_BASE_URL,
      modelKeysFile: process.env.MUSE_MODEL_KEYS_FILE
    };
    delete process.env.MUSE_MODEL;
    delete process.env.MUSE_DEFAULT_MODEL;
    delete process.env.GEMINI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.OLLAMA_BASE_URL;
    process.env.MUSE_MODEL_KEYS_FILE = modelKeysFile;
    try {
      // No env, no file → fail.
      const { io: io1, output: out1 } = captureOutput();
      const program1 = createProgram({ ...io1, fetch: async () => { throw new Error("api fetch off"); } });
      await program1.parseAsync(["node", "muse", "doctor", "--local", "--json"], { from: "node" });
      const r1 = JSON.parse(out1.join("")) as { checks: Array<{ name: string; status: string; detail: string }> };
      const probe1 = r1.checks.find((c) => c.name === "model env");
      expect(probe1).toBeDefined();
      expect(probe1!.status).toBe("fail");

      // File-only with suggestedModel — picked up via the merge.
      await fsp.writeFile(modelKeysFile, JSON.stringify({
        providers: {
          gemini: { token: "gem-from-file", suggestedModel: "gemini-2.5-pro" }
        }
      }), "utf8");
      const { io: io2, output: out2 } = captureOutput();
      const program2 = createProgram({ ...io2, fetch: async () => { throw new Error("api fetch off"); } });
      await program2.parseAsync(["node", "muse", "doctor", "--local", "--json"], { from: "node" });
      const r2 = JSON.parse(out2.join("")) as { checks: Array<{ name: string; status: string; detail: string }> };
      const probe2 = r2.checks.find((c) => c.name === "model env");
      expect(probe2).toBeDefined();
      expect(probe2!.status).toBe("ok");
      expect(probe2!.detail).toBe("gemini-2.5-pro");

      // File without suggestedModel but with a token → warn ("inferred
      // from GEMINI_API_KEY"). Confirms the GEMINI_API_KEY token from
      // the merged env is what the warn-path picks up.
      await fsp.writeFile(modelKeysFile, JSON.stringify({
        providers: { gemini: { token: "gem-from-file" } }
      }), "utf8");
      const { io: io3, output: out3 } = captureOutput();
      const program3 = createProgram({ ...io3, fetch: async () => { throw new Error("api fetch off"); } });
      await program3.parseAsync(["node", "muse", "doctor", "--local", "--json"], { from: "node" });
      const r3 = JSON.parse(out3.join("")) as { checks: Array<{ name: string; status: string; detail: string }> };
      const probe3 = r3.checks.find((c) => c.name === "model env");
      expect(probe3).toBeDefined();
      expect(probe3!.status).toBe("warn");
      expect(probe3!.detail).toContain("GEMINI_API_KEY");
    } finally {
      const restore = (envKey: keyof typeof prev, k: string): void => {
        if (prev[envKey] === undefined) delete process.env[k];
        else process.env[k] = prev[envKey];
      };
      restore("muse_model", "MUSE_MODEL");
      restore("muse_default_model", "MUSE_DEFAULT_MODEL");
      restore("gemini", "GEMINI_API_KEY");
      restore("anthropic", "ANTHROPIC_API_KEY");
      restore("openai", "OPENAI_API_KEY");
      restore("openrouter", "OPENROUTER_API_KEY");
      restore("ollama", "OLLAMA_BASE_URL");
      restore("modelKeysFile", "MUSE_MODEL_KEYS_FILE");
    }
  });

  it("muse doctor --local --json reports the searxng probe across unset / unreachable / healthy states", async () => {
    const originalFetch = globalThis.fetch;
    const prev = process.env.MUSE_SEARXNG_URL;
    try {
      // 1) Unset → "ok" with the DDG-fallback explainer.
      delete process.env.MUSE_SEARXNG_URL;
      const { io: io1, output: out1 } = captureOutput();
      const program1 = createProgram({ ...io1, fetch: async () => { throw new Error("api fetch off"); } });
      await program1.parseAsync(["node", "muse", "doctor", "--local", "--json"], { from: "node" });
      const r1 = JSON.parse(out1.join("")) as { checks: Array<{ name: string; status: string; detail: string }> };
      const probe1 = r1.checks.find((c) => c.name === "searxng");
      expect(probe1).toBeDefined();
      expect(probe1!.status).toBe("ok");
      expect(probe1!.detail).toContain("MUSE_SEARXNG_URL not set");

      // 2) Reachable + JSON-format works → "ok".
      process.env.MUSE_SEARXNG_URL = "http://searx.test.local";
      globalThis.fetch = (async (input: RequestInfo | URL): Promise<Response> => {
        const url = String(input);
        if (url.endsWith("/healthz")) return new Response("OK", { status: 200 });
        if (url.includes("/search?q=health&format=json")) {
          return new Response(JSON.stringify({ results: [{ title: "x", url: "y" }] }), {
            headers: { "content-type": "application/json" },
            status: 200
          });
        }
        return new Response("unexpected", { status: 404 });
      }) as typeof globalThis.fetch;
      const { io: io2, output: out2 } = captureOutput();
      const program2 = createProgram({ ...io2, fetch: async () => { throw new Error("api fetch off"); } });
      await program2.parseAsync(["node", "muse", "doctor", "--local", "--json"], { from: "node" });
      const r2 = JSON.parse(out2.join("")) as { checks: Array<{ name: string; status: string; detail: string }> };
      const probe2 = r2.checks.find((c) => c.name === "searxng");
      expect(probe2).toBeDefined();
      expect(probe2!.status).toBe("ok");
      expect(probe2!.detail).toContain("JSON format enabled");

      // 3) /healthz down → "fail".
      globalThis.fetch = (async () => { throw new Error("connection refused"); }) as typeof globalThis.fetch;
      const { io: io3, output: out3 } = captureOutput();
      const program3 = createProgram({ ...io3, fetch: async () => { throw new Error("api fetch off"); } });
      await program3.parseAsync(["node", "muse", "doctor", "--local", "--json"], { from: "node" });
      const r3 = JSON.parse(out3.join("")) as { checks: Array<{ name: string; status: string; detail: string }> };
      const probe3 = r3.checks.find((c) => c.name === "searxng");
      expect(probe3).toBeDefined();
      expect(probe3!.status).toBe("fail");
      expect(probe3!.detail).toContain("not reachable");

      // 4) /healthz ok but JSON path returns 400 → "fail" with settings.yml hint.
      globalThis.fetch = (async (input: RequestInfo | URL): Promise<Response> => {
        const url = String(input);
        if (url.endsWith("/healthz")) return new Response("OK", { status: 200 });
        return new Response("format not enabled", { status: 400 });
      }) as typeof globalThis.fetch;
      const { io: io4, output: out4 } = captureOutput();
      const program4 = createProgram({ ...io4, fetch: async () => { throw new Error("api fetch off"); } });
      await program4.parseAsync(["node", "muse", "doctor", "--local", "--json"], { from: "node" });
      const r4 = JSON.parse(out4.join("")) as { checks: Array<{ name: string; status: string; detail: string }> };
      const probe4 = r4.checks.find((c) => c.name === "searxng");
      expect(probe4).toBeDefined();
      expect(probe4!.status).toBe("fail");
      expect(probe4!.detail).toContain("settings.yml");
    } finally {
      globalThis.fetch = originalFetch;
      if (prev !== undefined) process.env.MUSE_SEARXNG_URL = prev;
      else delete process.env.MUSE_SEARXNG_URL;
    }
  });

  it("muse status surfaces an active session DND lock (so a paused-notices user isn't confused)", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "muse-cli-status-dnd-"));
    const fsp = await import("node:fs/promises");
    const lockFile = path.join(root, "session-lock.json");
    const until = new Date(Date.now() + 2 * 60 * 60_000).toISOString();
    await fsp.writeFile(lockFile, JSON.stringify({ until, reason: "deep work" }), "utf8");

    const prev = process.env.MUSE_SESSION_LOCK_FILE;
    process.env.MUSE_SESSION_LOCK_FILE = lockFile;
    try {
      const j = captureOutput();
      const pj = createProgram({ ...j.io, fetch: async () => { throw new Error("no fetch"); } });
      await pj.parseAsync(["node", "muse", "status", "--json"], { from: "node" });
      const snap = JSON.parse(j.output.join("")) as { session: { dnd: boolean; until?: string } };
      expect(snap.session.dnd).toBe(true);
      expect(snap.session.until).toBe(until);

      const t = captureOutput();
      const pt = createProgram({ ...t.io, fetch: async () => { throw new Error("no fetch"); } });
      await pt.parseAsync(["node", "muse", "status"], { from: "node" });
      expect(t.output.join("")).toContain("(DND) proactive notices paused");
    } finally {
      if (prev === undefined) { delete process.env.MUSE_SESSION_LOCK_FILE; } else { process.env.MUSE_SESSION_LOCK_FILE = prev; }
    }
  });

  it("muse status marks an urgent due-soon task with ⚠ (parity with tasks list / today / the muse.status tool)", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "muse-cli-status-urgent-"));
    const fsp = await import("node:fs/promises");
    const tasksFile = path.join(root, "tasks.json");
    const soon = new Date(Date.now() + 60 * 60_000).toISOString();
    await fsp.writeFile(tasksFile, JSON.stringify({
      tasks: [
        { id: "tsk_urgent", title: "Pay rent", status: "open", dueAt: soon, urgent: true, createdAt: "2026-05-12T00:00:00Z" },
        { id: "tsk_normal", title: "Water plants", status: "open", dueAt: soon, createdAt: "2026-05-12T00:00:00Z" }
      ]
    }), "utf8");

    const prev = process.env.MUSE_TASKS_FILE;
    process.env.MUSE_TASKS_FILE = tasksFile;
    try {
      // JSON: the urgent flag rides the due24h entries.
      const j = captureOutput();
      const pj = createProgram({ ...j.io, fetch: async () => { throw new Error("no fetch"); } });
      await pj.parseAsync(["node", "muse", "status", "--json"], { from: "node" });
      const snap = JSON.parse(j.output.join("")) as { tasks: { due24h: Array<{ title: string; urgent?: boolean }> } };
      const urgent = snap.tasks.due24h.find((t) => t.title === "Pay rent");
      const normal = snap.tasks.due24h.find((t) => t.title === "Water plants");
      expect(urgent?.urgent).toBe(true);
      expect(normal?.urgent).toBe(false);

      // Text: ⚠ prepends the urgent task, not the normal one.
      const t = captureOutput();
      const pt = createProgram({ ...t.io, fetch: async () => { throw new Error("no fetch"); } });
      await pt.parseAsync(["node", "muse", "status"], { from: "node" });
      const out = t.output.join("");
      expect(out).toContain("⚠ Pay rent");
      // The normal task has the bullet directly before its title — no ⚠.
      expect(out).toContain("· Water plants");
      expect(out).not.toContain("⚠ Water plants");
    } finally {
      if (prev === undefined) { delete process.env.MUSE_TASKS_FILE; } else { process.env.MUSE_TASKS_FILE = prev; }
    }
  });

  it("muse status surfaces standing-objective counts + the escalated needs-you signal", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "muse-cli-status-obj-"));
    const fsp = await import("node:fs/promises");
    const userId = "stark";
    const objectivesFile = path.join(root, "objectives.json");
    await fsp.writeFile(objectivesFile, JSON.stringify({
      objectives: [
        { id: "obj_a", userId, createdAt: "2026-05-12T00:00:00Z", spec: "watch the build until green", kind: "until", status: "active" },
        { id: "obj_b", userId, createdAt: "2026-05-12T00:00:00Z", spec: "ship the Q3 memo — blocked on sign-off", kind: "until", status: "escalated" },
        { id: "obj_c", userId, createdAt: "2026-05-11T00:00:00Z", spec: "old done one", kind: "notify", status: "done" },
        { id: "obj_d", userId, createdAt: "2026-05-10T00:00:00Z", spec: "dropped one", kind: "watch", status: "cancelled" },
        // Different userId — must NOT count.
        { id: "obj_other", userId: "rhodey", createdAt: "2026-05-12T00:00:00Z", spec: "other user", kind: "until", status: "active" }
      ]
    }), "utf8");

    const prev = process.env.MUSE_OBJECTIVES_FILE;
    process.env.MUSE_OBJECTIVES_FILE = objectivesFile;
    try {
      const { io, output } = captureOutput();
      const program = createProgram({ ...io, fetch: async () => { throw new Error("no fetch"); } });
      await program.parseAsync(["node", "muse", "status", "--user", userId, "--json"], { from: "node" });
      const snap = JSON.parse(output.join("")) as {
        objectives: { active: number; escalated: number; done: number; cancelled: number; total: number; escalatedSample?: string };
      };
      // rhodey's active objective is dropped by the userId filter.
      expect(snap.objectives).toMatchObject({ active: 1, escalated: 1, done: 1, cancelled: 1, total: 4 });
      // The escalated objective's spec is surfaced as the needs-you signal.
      expect(snap.objectives.escalatedSample).toBe("ship the Q3 memo — blocked on sign-off");
    } finally {
      if (prev === undefined) delete process.env.MUSE_OBJECTIVES_FILE;
      else process.env.MUSE_OBJECTIVES_FILE = prev;
    }
  });

  it("muse status surfaces followup + episode + pattern counts when the stores carry data", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "muse-cli-status-tracks-"));
    const fsp = await import("node:fs/promises");
    const userId = "stark";
    const followupsFile = path.join(root, "followups.json");
    const episodesFile = path.join(root, "episodes.json");
    const patternsFiredFile = path.join(root, "patterns-fired.json");
    await fsp.writeFile(followupsFile, JSON.stringify({
      followups: [
        { id: "fu_a", userId, scheduledFor: "2030-01-01T09:00:00Z", status: "scheduled", summary: "Q3 budget memo check", createdAt: "2026-05-12T00:00:00Z" },
        { id: "fu_b", userId, scheduledFor: "2030-02-01T09:00:00Z", status: "scheduled", summary: "Later promise", createdAt: "2026-05-13T00:00:00Z" },
        { id: "fu_c", userId, scheduledFor: "2026-05-10T09:00:00Z", status: "fired", summary: "Older fired", firedAt: "2026-05-10T09:30:00Z", createdAt: "2026-05-09T00:00:00Z" },
        { id: "fu_d", userId, scheduledFor: "2026-05-09T09:00:00Z", status: "cancelled", summary: "Dropped", cancelReason: "user-cancelled", createdAt: "2026-05-08T00:00:00Z" },
        // Different userId — should NOT count.
        { id: "fu_other", userId: "rhodey", scheduledFor: "2030-01-01T09:00:00Z", status: "scheduled", summary: "Other user", createdAt: "2026-05-12T00:00:00Z" }
      ]
    }), "utf8");
    await fsp.writeFile(episodesFile, JSON.stringify({
      episodes: [
        { id: "ep_1", userId, startedAt: "2026-05-10T22:00:00Z", endedAt: "2026-05-10T22:18:00Z", summary: "First session" },
        { id: "ep_2", userId, startedAt: "2026-05-12T22:00:00Z", endedAt: "2026-05-12T22:30:00Z", summary: "Second, newest session" },
        { id: "ep_other", userId: "rhodey", startedAt: "2026-05-11T22:00:00Z", endedAt: "2026-05-11T22:18:00Z", summary: "Other user" }
      ]
    }), "utf8");
    await fsp.writeFile(patternsFiredFile, JSON.stringify({
      fired: [
        { patternId: "abc123", firedAtMs: 1_700_000_000_000 },
        { patternId: "def456", firedAtMs: 1_800_000_000_000 }
      ]
    }), "utf8");

    const prev = {
      followups: process.env.MUSE_FOLLOWUPS_FILE,
      episodes: process.env.MUSE_EPISODES_FILE,
      patterns: process.env.MUSE_PATTERNS_FIRED_FILE
    };
    process.env.MUSE_FOLLOWUPS_FILE = followupsFile;
    process.env.MUSE_EPISODES_FILE = episodesFile;
    process.env.MUSE_PATTERNS_FIRED_FILE = patternsFiredFile;
    try {
      const { io, output } = captureOutput();
      const program = createProgram({ ...io, fetch: async () => { throw new Error("no fetch"); } });
      await program.parseAsync(["node", "muse", "status", "--user", userId, "--json"], { from: "node" });
      const snap = JSON.parse(output.join("")) as {
        followups: { scheduled: number; fired: number; cancelled: number; total: number; nextScheduledFor?: string };
        episodes: { total: number; lastEndedAt?: string };
        patterns: { total: number; lastFiredAtIso?: string };
      };

      // userId filter: rhodey's followup + episode are dropped.
      expect(snap.followups).toMatchObject({ scheduled: 2, fired: 1, cancelled: 1, total: 4 });
      // Next-scheduled picks the earliest of the two scheduled.
      expect(snap.followups.nextScheduledFor).toBe("2030-01-01T09:00:00Z");

      expect(snap.episodes.total).toBe(2);
      // Newest endedAt wins.
      expect(snap.episodes.lastEndedAt).toBe("2026-05-12T22:30:00Z");

      // Patterns sidecar isn't user-scoped — both records count.
      expect(snap.patterns.total).toBe(2);
      // Latest firedAtMs (1.8 T) → ISO.
      expect(snap.patterns.lastFiredAtIso).toBe(new Date(1_800_000_000_000).toISOString());
    } finally {
      const restore = (k: keyof typeof prev, envKey: string): void => {
        if (prev[k] === undefined) delete process.env[envKey];
        else process.env[envKey] = prev[k];
      };
      restore("followups", "MUSE_FOLLOWUPS_FILE");
      restore("episodes", "MUSE_EPISODES_FILE");
      restore("patterns", "MUSE_PATTERNS_FIRED_FILE");
    }
  });

  it("apiRequest formats an HTML 404 into a one-line hint instead of dumping the body", async () => {
    const { formatApiErrorResponse } = await import("../src/program-helpers.js");
    // A multi-KB HTML 404 (what Next.js dev server returns when
    // the user points --api-url at the web port (3000) instead of
    // the muse API. Goal 001 moved the API default to 3030 so the
    // collision no longer happens on a clean install).
    const htmlBody = `<!DOCTYPE html><html><head><title>404</title></head><body>${"<script>".repeat(500)}</body></html>`;
    const fakeResponse = {
      status: 404,
      statusText: "Not Found",
      headers: {
        get(name: string): string | null {
          return name.toLowerCase() === "content-type" ? "text/html; charset=utf-8" : null;
        }
      }
    };
    const err = formatApiErrorResponse(fakeResponse, htmlBody, "http://127.0.0.1:3030");
    expect(err.message).toContain("Muse API 404 at http://127.0.0.1:3030");
    expect(err.message).toContain("response was HTML, not JSON");
    expect(err.message).toContain("--api-url");
    expect(err.message).not.toContain("<!DOCTYPE");
    expect(err.message).not.toContain("<script>");
  });

  it("apiRequest formats a non-HTML 4xx body but caps it at 240 chars", async () => {
    const { formatApiErrorResponse } = await import("../src/program-helpers.js");
    const longJson = `{"error":"${"x".repeat(500)}"}`;
    const fakeResponse = {
      status: 422,
      statusText: "Unprocessable Entity",
      headers: { get: (): string | null => "application/json" }
    };
    const err = formatApiErrorResponse(fakeResponse, longJson, "http://localhost:3030");
    expect(err.message).toMatch(/^Muse API 422:/);
    // Trimmed preview + ellipsis indicator (240 chars + 1 for the ellipsis).
    expect(err.message.length).toBeLessThan(280);
    expect(err.message).toContain("…");
  });

  it("apiRequest surfaces the Muse error envelope cleanly instead of raw JSON (goal 175)", async () => {
    const { formatApiErrorResponse } = await import("../src/program-helpers.js");
    const envelope = JSON.stringify({
      blockReason: null,
      content: null,
      errorCode: "AGENT_RUN_FAILED",
      errorMessage: "Ollama /api/chat failed with 404: model 'xyz' not found",
      metadata: {},
      success: false
    });
    const fakeResponse = {
      status: 500,
      statusText: "Internal Server Error",
      headers: { get: (): string | null => "application/json" }
    };
    const err = formatApiErrorResponse(fakeResponse, envelope, "http://localhost:3030");
    expect(err.message).toBe(
      "Muse API 500 (AGENT_RUN_FAILED): Ollama /api/chat failed with 404: model 'xyz' not found"
    );
    expect(err.message).not.toContain("blockReason");
    expect(err.message).not.toContain("{");
  });

  it("apiRequest keeps the raw preview for JSON without an errorMessage envelope (goal 175)", async () => {
    const { formatApiErrorResponse } = await import("../src/program-helpers.js");
    const fakeResponse = {
      status: 422,
      statusText: "Unprocessable Entity",
      headers: { get: (): string | null => "application/json" }
    };
    const err = formatApiErrorResponse(fakeResponse, `{"error":"bad input"}`, "http://localhost:3030");
    expect(err.message).toBe(`Muse API 422: {"error":"bad input"}`);
  });

  it("apiRequest falls back to statusText when the body is empty", async () => {
    const { formatApiErrorResponse } = await import("../src/program-helpers.js");
    const fakeResponse = {
      status: 500,
      statusText: "Internal Server Error",
      headers: { get: (): string | null => null }
    };
    const err = formatApiErrorResponse(fakeResponse, "", "http://localhost:3030");
    expect(err.message).toBe("Muse API 500: Internal Server Error");
  });

  it("muse status surfaces the log-file / last-notice inconsistency instead of saying '(not yet created)'", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "muse-cli-status-loginconsist-"));
    const fsp = await import("node:fs/promises");
    const proactiveHistoryFile = path.join(root, "proactive-history.json");
    const logFile = path.join(root, "notifications.log");

    // Seed proactive history with a 'log' delivery — the log file
    // itself stays missing.
    await fsp.writeFile(proactiveHistoryFile, JSON.stringify({
      entries: [{
        kind: "calendar",
        itemId: "evt_a",
        startIso: "2026-05-12T11:00:00.000Z",
        title: "Q3 memo",
        providerId: "log",
        destination: "@me",
        text: "Send the Q3 memo",
        firedAtIso: "2026-05-12T11:49:47.830Z",
        status: "delivered"
      }],
      version: 1
    }), "utf8");

    const prev = {
      proactive: process.env.MUSE_PROACTIVE_HISTORY_FILE,
      log: process.env.MUSE_MESSAGING_LOG_FILE
    };
    process.env.MUSE_PROACTIVE_HISTORY_FILE = proactiveHistoryFile;
    process.env.MUSE_MESSAGING_LOG_FILE = logFile;
    try {
      const { io, output } = captureOutput();
      const program = createProgram({ ...io, fetch: async () => { throw new Error("no fetch"); } });
      await program.parseAsync(["node", "muse", "status", "--user", "stark"], { from: "node" });
      const text = output.join("");
      // Old (misleading) wording is gone:
      expect(text).not.toContain("(not yet created)");
      // New diagnosis is surfaced:
      expect(text).toContain("file missing — proactive history shows a 'log' delivery");
      expect(text).toContain("2026-05-12T11:49:47.830Z");
    } finally {
      if (prev.proactive === undefined) delete process.env.MUSE_PROACTIVE_HISTORY_FILE;
      else process.env.MUSE_PROACTIVE_HISTORY_FILE = prev.proactive;
      if (prev.log === undefined) delete process.env.MUSE_MESSAGING_LOG_FILE;
      else process.env.MUSE_MESSAGING_LOG_FILE = prev.log;
    }
  });

  it("muse status reports the inferred model when MUSE_MODEL is unset but a provider key resolves one", async () => {
    const prev = {
      muse_model: process.env.MUSE_MODEL,
      muse_default_model: process.env.MUSE_DEFAULT_MODEL,
      gemini: process.env.GEMINI_API_KEY,
      anthropic: process.env.ANTHROPIC_API_KEY,
      openai: process.env.OPENAI_API_KEY,
      openrouter: process.env.OPENROUTER_API_KEY,
      ollama: process.env.OLLAMA_BASE_URL,
      modelKeysFile: process.env.MUSE_MODEL_KEYS_FILE,
      localOnly: process.env.MUSE_LOCAL_ONLY
    };
    // Block the real ~/.muse/models.json overlay so the wizard
    // can't leak into the env-only case.
    delete process.env.MUSE_MODEL;
    delete process.env.MUSE_DEFAULT_MODEL;
    delete process.env.GEMINI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.OLLAMA_BASE_URL;
    // This case tests CLOUD-key inference, which is gated behind the
    // local-only opt-out (local-first ignores ambient cloud keys by default).
    process.env.MUSE_LOCAL_ONLY = "false";
    process.env.MUSE_MODEL_KEYS_FILE = path.join(await mkdtemp(path.join(tmpdir(), "muse-status-modelinf-")), "missing.json");
    try {
      // 1) GEMINI_API_KEY only → inferred gemini/gemini-2.0-flash.
      process.env.GEMINI_API_KEY = "gem-test";
      const { io: io1, output: out1 } = captureOutput();
      const program1 = createProgram({ ...io1, fetch: async () => { throw new Error("no fetch"); } });
      await program1.parseAsync(["node", "muse", "status", "--user", "stark", "--json"], { from: "node" });
      const snap1 = JSON.parse(out1.join("")) as { model?: string; modelInferredFrom?: string };
      expect(snap1.model).toBe("gemini/gemini-2.0-flash");
      expect(snap1.modelInferredFrom).toBe("GEMINI_API_KEY");

      // Formatted output annotates the line.
      const { io: io1f, output: out1f } = captureOutput();
      const program1f = createProgram({ ...io1f, fetch: async () => { throw new Error("no fetch"); } });
      await program1f.parseAsync(["node", "muse", "status", "--user", "stark"], { from: "node" });
      expect(out1f.join("")).toContain("model: gemini/gemini-2.0-flash (inferred from GEMINI_API_KEY)");

      // 2) MUSE_MODEL explicit → no inference annotation.
      process.env.MUSE_MODEL = "gemini-2.5-pro";
      const { io: io2, output: out2 } = captureOutput();
      const program2 = createProgram({ ...io2, fetch: async () => { throw new Error("no fetch"); } });
      await program2.parseAsync(["node", "muse", "status", "--user", "stark", "--json"], { from: "node" });
      const snap2 = JSON.parse(out2.join("")) as { model?: string; modelInferredFrom?: string };
      expect(snap2.model).toBe("gemini-2.5-pro");
      expect(snap2.modelInferredFrom).toBeUndefined();

      // 3) Nothing resolvable → unset.
      delete process.env.MUSE_MODEL;
      delete process.env.GEMINI_API_KEY;
      const { io: io3, output: out3 } = captureOutput();
      const program3 = createProgram({ ...io3, fetch: async () => { throw new Error("no fetch"); } });
      await program3.parseAsync(["node", "muse", "status", "--user", "stark", "--json"], { from: "node" });
      const snap3 = JSON.parse(out3.join("")) as { model?: string; modelInferredFrom?: string };
      expect(snap3.model).toBeUndefined();
      expect(snap3.modelInferredFrom).toBeUndefined();
    } finally {
      const restore = (envKey: keyof typeof prev, k: string): void => {
        if (prev[envKey] === undefined) delete process.env[k];
        else process.env[k] = prev[envKey];
      };
      restore("muse_model", "MUSE_MODEL");
      restore("muse_default_model", "MUSE_DEFAULT_MODEL");
      restore("gemini", "GEMINI_API_KEY");
      restore("anthropic", "ANTHROPIC_API_KEY");
      restore("openai", "OPENAI_API_KEY");
      restore("openrouter", "OPENROUTER_API_KEY");
      restore("ollama", "OLLAMA_BASE_URL");
      restore("modelKeysFile", "MUSE_MODEL_KEYS_FILE");
      restore("localOnly", "MUSE_LOCAL_ONLY");
    }
  });

  it("muse status surfaces configured providers from env AND from the muse-setup-model credentials file", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "muse-cli-status-providers-"));
    const fsp = await import("node:fs/promises");
    const modelKeysFile = path.join(root, "models.json");
    const prev = {
      gemini: process.env.GEMINI_API_KEY,
      anthropic: process.env.ANTHROPIC_API_KEY,
      openai: process.env.OPENAI_API_KEY,
      openrouter: process.env.OPENROUTER_API_KEY,
      ollama: process.env.OLLAMA_BASE_URL,
      modelKeysFile: process.env.MUSE_MODEL_KEYS_FILE
    };
    delete process.env.GEMINI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.OLLAMA_BASE_URL;
    // Point at a non-existent file first so the real ~/.muse/models.json
    // on the dev box can't leak through and inflate the count.
    process.env.MUSE_MODEL_KEYS_FILE = modelKeysFile;
    try {
      // Env-only case.
      process.env.GEMINI_API_KEY = "gem-test";
      process.env.OLLAMA_BASE_URL = "http://localhost:11434";
      const { io, output } = captureOutput();
      const program = createProgram({ ...io, fetch: async () => { throw new Error("no fetch"); } });
      await program.parseAsync(["node", "muse", "status", "--user", "stark", "--json"], { from: "node" });
      const snap = JSON.parse(output.join("")) as {
        providers: { configured: readonly string[]; total: number };
      };
      expect(snap.providers.total).toBe(2);
      expect(snap.providers.configured).toEqual(["gemini", "ollama"]);

      const { io: io2, output: out2 } = captureOutput();
      const program2 = createProgram({ ...io2, fetch: async () => { throw new Error("no fetch"); } });
      await program2.parseAsync(["node", "muse", "status", "--user", "stark"], { from: "node" });
      expect(out2.join("")).toContain("providers: 2 configured — gemini, ollama");

      // File-only case: drop the env keys, write the wizard's models.json
      // shape — anthropic via file, gemini via file. The fix asserts that
      // these show up even though no shell export ran.
      delete process.env.GEMINI_API_KEY;
      delete process.env.OLLAMA_BASE_URL;
      await fsp.writeFile(modelKeysFile, JSON.stringify({
        providers: {
          anthropic: { token: "ant-from-file" },
          gemini: { token: "gem-from-file", suggestedModel: "gemini-2.5-pro" }
        }
      }), "utf8");
      const { io: io3, output: out3 } = captureOutput();
      const program3 = createProgram({ ...io3, fetch: async () => { throw new Error("no fetch"); } });
      await program3.parseAsync(["node", "muse", "status", "--user", "stark", "--json"], { from: "node" });
      const snap3 = JSON.parse(out3.join("")) as { providers: { configured: readonly string[]; total: number } };
      expect(snap3.providers.total).toBe(2);
      // Order is fixed by the canonical-checks list, not by file iteration:
      // gemini first, anthropic second.
      expect(snap3.providers.configured).toEqual(["gemini", "anthropic"]);

      // Empty-state: drop the file, drop env. Expect 0 configured.
      await fsp.rm(modelKeysFile);
      const { io: io4, output: out4 } = captureOutput();
      const program4 = createProgram({ ...io4, fetch: async () => { throw new Error("no fetch"); } });
      await program4.parseAsync(["node", "muse", "status", "--user", "stark"], { from: "node" });
      expect(out4.join("")).toContain("providers: 0 configured");
    } finally {
      const restore = (envKey: keyof typeof prev, k: string): void => {
        if (prev[envKey] === undefined) delete process.env[k];
        else process.env[k] = prev[envKey];
      };
      restore("gemini", "GEMINI_API_KEY");
      restore("anthropic", "ANTHROPIC_API_KEY");
      restore("openai", "OPENAI_API_KEY");
      restore("openrouter", "OPENROUTER_API_KEY");
      restore("ollama", "OLLAMA_BASE_URL");
      restore("modelKeysFile", "MUSE_MODEL_KEYS_FILE");
    }
  });

  it("muse status surfaces reminder pending/fired/overdue counts and next due entry", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "muse-cli-status-reminders-"));
    const fsp = await import("node:fs/promises");
    const remindersFile = path.join(root, "reminders.json");
    const past = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const soon = new Date(Date.now() + 30 * 60 * 1000).toISOString();
    const later = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    await fsp.writeFile(remindersFile, JSON.stringify({
      reminders: [
        { id: "rem_overdue", text: "Call vet (overdue)", dueAt: past, status: "pending", createdAt: "2026-05-10T00:00:00Z" },
        { id: "rem_soon", text: "Pick up dry cleaning", dueAt: soon, status: "pending", createdAt: "2026-05-12T00:00:00Z" },
        { id: "rem_later", text: "Submit Q3 memo", dueAt: later, status: "pending", createdAt: "2026-05-12T01:00:00Z" },
        { id: "rem_done", text: "Already fired", dueAt: past, status: "fired", firedAt: past, createdAt: "2026-05-09T00:00:00Z" }
      ]
    }), "utf8");

    const prev = process.env.MUSE_REMINDERS_FILE;
    process.env.MUSE_REMINDERS_FILE = remindersFile;
    try {
      const { io, output } = captureOutput();
      const program = createProgram({ ...io, fetch: async () => { throw new Error("no fetch"); } });
      await program.parseAsync(["node", "muse", "status", "--user", "stark", "--json"], { from: "node" });
      const snap = JSON.parse(output.join("")) as {
        reminders: { pending: number; fired: number; overdue: number; total: number; nextDueAt?: string; nextText?: string };
      };

      expect(snap.reminders).toMatchObject({ pending: 3, fired: 1, overdue: 1, total: 4 });
      expect(snap.reminders.nextDueAt).toBe(past);
      expect(snap.reminders.nextText).toBe("Call vet (overdue)");

      const { io: io2, output: out2 } = captureOutput();
      const program2 = createProgram({ ...io2, fetch: async () => { throw new Error("no fetch"); } });
      await program2.parseAsync(["node", "muse", "status", "--user", "stark"], { from: "node" });
      const text = out2.join("");
      expect(text).toContain("reminders: 3 pending (1 overdue), 1 fired");
      expect(text).toContain("Call vet (overdue)");
    } finally {
      if (prev !== undefined) process.env.MUSE_REMINDERS_FILE = prev;
      else delete process.env.MUSE_REMINDERS_FILE;
    }
  });

  it("muse episode search --json (substring) matches summary + topics case-insensitively", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "muse-cli-episode-search-"));
    const episodesFile = path.join(root, "episodes.json");
    const fsp = await import("node:fs/promises");
    const prev = process.env.MUSE_EPISODES_FILE;
    process.env.MUSE_EPISODES_FILE = episodesFile;
    try {
      await fsp.writeFile(episodesFile, JSON.stringify({
        episodes: [
          { id: "ep_a", userId: "stark", startedAt: "2026-05-12T22:00:00Z", endedAt: "2026-05-12T22:18:00Z", summary: "Q3 BUDGET memo discussion.", topics: ["Q3 budget memo", "Notion"] },
          { id: "ep_b", userId: "stark", startedAt: "2026-05-11T22:00:00Z", endedAt: "2026-05-11T22:18:00Z", summary: "Wedding venue shortlist.", topics: ["wedding"] }
        ]
      }), "utf8");

      // Summary substring match (case-insensitive).
      const { io: io1, output: out1 } = captureOutput();
      const program1 = createProgram({ ...io1, fetch: async () => { throw new Error("no fetch"); } });
      await program1.parseAsync(["node", "muse", "episode", "search", "budget", "--json"], { from: "node" });
      const r1 = JSON.parse(out1.join("")) as { mode: string; total: number; episodes: Array<{ id: string }> };
      expect(r1.mode).toBe("substring");
      expect(r1.total).toBe(1);
      expect(r1.episodes[0]!.id).toBe("ep_a");

      // Topic match.
      const { io: io2, output: out2 } = captureOutput();
      const program2 = createProgram({ ...io2, fetch: async () => { throw new Error("no fetch"); } });
      await program2.parseAsync(["node", "muse", "episode", "search", "notion", "--json"], { from: "node" });
      const r2 = JSON.parse(out2.join("")) as { total: number; episodes: Array<{ id: string }> };
      expect(r2.total).toBe(1);
      expect(r2.episodes[0]!.id).toBe("ep_a");

      // Empty query rejects.
      const { io: io3 } = captureOutput();
      const program3 = createProgram({ ...io3, fetch: async () => { throw new Error("no fetch"); } });
      program3.exitOverride();
      // commander treats <query...> as required, so a no-arg call should reject; but `search` with empty " " also rejects from our own guard.
      await expect(program3.parseAsync(["node", "muse", "episode", "search", "   ", "--json"], { from: "node" }))
        .rejects.toThrow(/query is required/u);
    } finally {
      if (prev !== undefined) process.env.MUSE_EPISODES_FILE = prev;
      else delete process.env.MUSE_EPISODES_FILE;
    }
  });

  it("muse episode remove drops a single record; clear requires --yes and wipes the file", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "muse-cli-episode-remove-"));
    const episodesFile = path.join(root, "episodes.json");
    const fsp = await import("node:fs/promises");
    const prev = process.env.MUSE_EPISODES_FILE;
    process.env.MUSE_EPISODES_FILE = episodesFile;
    try {
      await fsp.writeFile(episodesFile, JSON.stringify({
        episodes: [
          { id: "ep_keep", userId: "stark", startedAt: "2026-05-12T22:00:00Z", endedAt: "2026-05-12T22:18:00Z", summary: "Keep me" },
          { id: "ep_drop", userId: "stark", startedAt: "2026-05-11T22:00:00Z", endedAt: "2026-05-11T22:18:00Z", summary: "Drop me" }
        ]
      }), "utf8");

      // Remove one — survives the other.
      const { io: io1 } = captureOutput();
      const program1 = createProgram({ ...io1, fetch: async () => { throw new Error("no fetch"); } });
      await program1.parseAsync(["node", "muse", "episode", "remove", "ep_drop"], { from: "node" });
      const after1 = JSON.parse(await fsp.readFile(episodesFile, "utf8")) as { episodes: Array<{ id: string }> };
      expect(after1.episodes.map((e) => e.id)).toEqual(["ep_keep"]);

      // clear without --yes rejects.
      const { io: io2 } = captureOutput();
      const program2 = createProgram({ ...io2, fetch: async () => { throw new Error("no fetch"); } });
      program2.exitOverride();
      await expect(program2.parseAsync(["node", "muse", "episode", "clear"], { from: "node" }))
        .rejects.toThrow(/Refusing to clear without --yes/u);

      // clear --yes wipes.
      const { io: io3, output: out3 } = captureOutput();
      const program3 = createProgram({ ...io3, fetch: async () => { throw new Error("no fetch"); } });
      await program3.parseAsync(["node", "muse", "episode", "clear", "--yes", "--json"], { from: "node" });
      const result = JSON.parse(out3.join("")) as { cleared: boolean; removed: number };
      expect(result).toEqual({ cleared: true, removed: 1 });
      const after2 = JSON.parse(await fsp.readFile(episodesFile, "utf8")) as { episodes: unknown[] };
      expect(after2.episodes).toEqual([]);
    } finally {
      if (prev !== undefined) process.env.MUSE_EPISODES_FILE = prev;
      else delete process.env.MUSE_EPISODES_FILE;
    }
  });

  it("muse pattern list runs both detectors and surfaces clusters; respects --min-confidence + --limit", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "muse-cli-pat-list-"));
    // aggregateActivitySignals resolves paths against $HOME — mirror its
    // default `~/.muse/notes` layout so an option-less call finds them.
    const museDir = path.join(root, ".muse");
    const notesDir = path.join(museDir, "notes");
    const fsp = await import("node:fs/promises");
    await fsp.mkdir(museDir);
    await fsp.mkdir(notesDir);
    await fsp.mkdir(path.join(notesDir, "journal"));
    // Three Tuesdays at 21:30 local → strong cluster.
    const tuesdays = [
      new Date(2026, 3, 14, 21, 30),
      new Date(2026, 3, 21, 21, 30),
      new Date(2026, 3, 28, 21, 30)
    ];
    for (let i = 0; i < tuesdays.length; i++) {
      const file = path.join(notesDir, "journal", `entry-${i.toString()}.md`);
      await fsp.writeFile(file, "x", "utf8");
      const secs = tuesdays[i]!.getTime() / 1000;
      await fsp.utimes(file, secs, secs);
    }
    const prev = {
      activity: process.env.MUSE_ACTIVITY_LOG_FILE,
      home: process.env.HOME,
      notes: process.env.MUSE_NOTES_DIR,
      tasks: process.env.MUSE_TASKS_FILE
    };
    process.env.HOME = root;
    process.env.MUSE_NOTES_DIR = notesDir;
    process.env.MUSE_TASKS_FILE = path.join(root, "no-tasks.json");
    process.env.MUSE_ACTIVITY_LOG_FILE = path.join(root, "no-activity.jsonl");
    try {
      // List with no filter → at least one cluster surfaces.
      const { io: io1, output: out1 } = captureOutput();
      const program1 = createProgram({ ...io1, fetch: async () => { throw new Error("no fetch"); } });
      await program1.parseAsync(["node", "muse", "pattern", "list", "--json"], { from: "node" });
      const listed = JSON.parse(out1.join("")) as { patterns: Array<{ category: string; confidence: number }>; total: number };
      expect(listed.total).toBeGreaterThan(0);
      const tod = listed.patterns.find((p) => p.category === "time-of-day-action");
      expect(tod).toBeDefined();
      expect(tod!.confidence).toBeGreaterThan(0);

      // Goal 177 — an out-of-range --min-confidence is now
      // rejected (was: silently fell back to 0 and showed
      // everything, masking the user's intent).
      const { io: io2 } = captureOutput();
      const program2 = createProgram({ ...io2, fetch: async () => { throw new Error("no fetch"); } });
      await expect(
        program2.parseAsync(["node", "muse", "pattern", "list", "--min-confidence", "1.01", "--json"], { from: "node" })
      ).rejects.toThrow(/--min-confidence must be a number in \[0, 1\]/u);

      // --limit caps the slice
      const { io: io3, output: out3 } = captureOutput();
      const program3 = createProgram({ ...io3, fetch: async () => { throw new Error("no fetch"); } });
      await program3.parseAsync(["node", "muse", "pattern", "list", "--limit", "1", "--json"], { from: "node" });
      const capped = JSON.parse(out3.join("")) as { total: number };
      expect(capped.total).toBe(1);
    } finally {
      const restore = (key: keyof typeof prev, envKey: string): void => {
        if (prev[key] === undefined) { delete process.env[envKey]; } else { process.env[envKey] = prev[key]!; }
      };
      restore("home", "HOME");
      restore("notes", "MUSE_NOTES_DIR");
      restore("tasks", "MUSE_TASKS_FILE");
      restore("activity", "MUSE_ACTIVITY_LOG_FILE");
    }
  });

  it("muse pattern fired lists cooldown records newest-first; reset --yes wipes them", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "muse-cli-pat-fired-"));
    const firedFile = path.join(root, "patterns-fired.json");
    const fsp = await import("node:fs/promises");
    const prev = process.env.MUSE_PATTERNS_FIRED_FILE;
    process.env.MUSE_PATTERNS_FIRED_FILE = firedFile;
    try {
      await fsp.writeFile(firedFile, JSON.stringify({
        fired: [
          { patternId: "abc123def456", firedAtMs: 1_000_000_000_000 },
          { patternId: "deadbeef0001", firedAtMs: 1_700_000_000_000 },
          { patternId: "abc123def456", firedAtMs: 1_500_000_000_000 }
        ]
      }), "utf8");

      // Fired list — newest first.
      const { io: io1, output: out1 } = captureOutput();
      const program1 = createProgram({ ...io1, fetch: async () => { throw new Error("no fetch"); } });
      await program1.parseAsync(["node", "muse", "pattern", "fired", "--json"], { from: "node" });
      const listed = JSON.parse(out1.join("")) as { fired: Array<{ patternId: string; firedAtMs: number }>; total: number };
      expect(listed.total).toBe(3);
      expect(listed.fired[0]!.firedAtMs).toBe(1_700_000_000_000);
      expect(listed.fired[2]!.firedAtMs).toBe(1_000_000_000_000);

      // reset without --yes refuses.
      const { io: io2 } = captureOutput();
      const program2 = createProgram({ ...io2, fetch: async () => { throw new Error("no fetch"); } });
      program2.exitOverride();
      await expect(program2.parseAsync(["node", "muse", "pattern", "reset"], { from: "node" }))
        .rejects.toThrow(/Refusing to reset without --yes/u);

      // reset --yes wipes.
      const { io: io3, output: out3 } = captureOutput();
      const program3 = createProgram({ ...io3, fetch: async () => { throw new Error("no fetch"); } });
      await program3.parseAsync(["node", "muse", "pattern", "reset", "--yes", "--json"], { from: "node" });
      const result = JSON.parse(out3.join("")) as { cleared: boolean; removed: number; keptDismissals: number };
      expect(result).toEqual({ cleared: true, keptDismissals: 0, removed: 3 });
      const after = JSON.parse(await fsp.readFile(firedFile, "utf8")) as { fired: unknown[] };
      expect(after.fired).toEqual([]);
    } finally {
      if (prev !== undefined) process.env.MUSE_PATTERNS_FIRED_FILE = prev;
      else delete process.env.MUSE_PATTERNS_FIRED_FILE;
    }
  });

  it("readSessionBoundaries returns [] when last-chat.jsonl is missing", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "muse-cli-boundary-missing-"));
    const prev = process.env.HOME;
    process.env.HOME = root;
    try {
      const { readSessionBoundaries } = await import("../src/chat-history.js");
      expect(await readSessionBoundaries()).toEqual([]);
    } finally {
      if (prev !== undefined) process.env.HOME = prev;
      else delete process.env.HOME;
    }
  });

  it("muse followup cancel flips scheduled → cancelled; rejects already-fired", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "muse-cli-followup-cancel-"));
    const followupsFile = path.join(root, "followups.json");
    const fsp = await import("node:fs/promises");
    const prev = process.env.MUSE_FOLLOWUPS_FILE;
    process.env.MUSE_FOLLOWUPS_FILE = followupsFile;
    try {
      await fsp.writeFile(followupsFile, JSON.stringify({
        followups: [
          { createdAt: "2026-05-10T00:00:00Z", id: "fu_target", scheduledFor: "2026-05-11T09:00:00Z", status: "scheduled", summary: "Cancel me", userId: "stark" },
          { createdAt: "2026-05-10T00:00:00Z", firedAt: "2026-05-10T13:00:00Z", id: "fu_done", scheduledFor: "2026-05-10T12:00:00Z", status: "fired", summary: "Already fired", userId: "stark" }
        ]
      }), "utf8");

      const { io: io1, output: out1 } = captureOutput();
      const program1 = createProgram({ ...io1, fetch: async () => { throw new Error("no fetch"); } });
      await program1.parseAsync(["node", "muse", "followup", "cancel", "fu_target", "--reason", "out-of-scope", "--json"], { from: "node" });
      const patched = JSON.parse(out1.join("")) as { id: string; status: string; cancelReason: string };
      expect(patched.id).toBe("fu_target");
      expect(patched.status).toBe("cancelled");
      expect(patched.cancelReason).toBe("out-of-scope");

      // Second cancel on the same id surfaces "already cancelled" instead of silently no-op.
      const { io: io2 } = captureOutput();
      const program2 = createProgram({ ...io2, fetch: async () => { throw new Error("no fetch"); } });
      program2.exitOverride();
      await expect(program2.parseAsync(["node", "muse", "followup", "cancel", "fu_target"], { from: "node" }))
        .rejects.toThrow(/already cancelled/u);

      // Cancelling an already-fired entry also rejects.
      const { io: io3 } = captureOutput();
      const program3 = createProgram({ ...io3, fetch: async () => { throw new Error("no fetch"); } });
      program3.exitOverride();
      await expect(program3.parseAsync(["node", "muse", "followup", "cancel", "fu_done"], { from: "node" }))
        .rejects.toThrow(/already fired/u);
    } finally {
      if (prev !== undefined) process.env.MUSE_FOLLOWUPS_FILE = prev;
      else delete process.env.MUSE_FOLLOWUPS_FILE;
    }
  });

  it("muse status surfaces persona.workingHours from memory (goal 147)", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "muse-cli-status-working-hours-"));
    const fsp = await import("node:fs/promises");
    const userMemoryFile = path.join(root, "user-memory.json");

    const prevMemoryFile = process.env.MUSE_USER_MEMORY_FILE;
    process.env.MUSE_USER_MEMORY_FILE = userMemoryFile;
    try {
      await fsp.writeFile(userMemoryFile, JSON.stringify({
        users: {
          stark: {
            facts: { name: "Stark" },
            preferences: { working_hours: "9-18" },
            updatedAt: "2026-05-15T00:00:00Z"
          }
        }
      }), "utf8");

      // JSON shape carries the raw string.
      const { io: io1, output: out1 } = captureOutput();
      const program1 = createProgram({ ...io1, fetch: async () => { throw new Error("no fetch"); } });
      await program1.parseAsync(["node", "muse", "status", "--user", "stark", "--json"], { from: "node" });
      const snap = JSON.parse(out1.join("")) as { persona: { workingHours?: string } };
      expect(snap.persona.workingHours).toBe("9-18");

      // Text renderer prints the line.
      const { io: io2, output: out2 } = captureOutput();
      const program2 = createProgram({ ...io2, fetch: async () => { throw new Error("no fetch"); } });
      await program2.parseAsync(["node", "muse", "status", "--user", "stark"], { from: "node" });
      expect(out2.join("")).toContain("working hours: 9-18");

      // Missing → omitted from JSON (no "(none)" filler).
      await fsp.writeFile(userMemoryFile, JSON.stringify({
        users: { stark: { facts: {}, preferences: {}, updatedAt: "2026-05-15T00:00:00Z" } }
      }), "utf8");
      const { io: io3, output: out3 } = captureOutput();
      const program3 = createProgram({ ...io3, fetch: async () => { throw new Error("no fetch"); } });
      await program3.parseAsync(["node", "muse", "status", "--user", "stark", "--json"], { from: "node" });
      const snap3 = JSON.parse(out3.join("")) as { persona: { workingHours?: string } };
      expect(snap3.persona.workingHours).toBeUndefined();

      // Whitespace-only treated as missing.
      await fsp.writeFile(userMemoryFile, JSON.stringify({
        users: {
          stark: {
            facts: {},
            preferences: { working_hours: "   " },
            updatedAt: "2026-05-15T00:00:00Z"
          }
        }
      }), "utf8");
      const { io: io4, output: out4 } = captureOutput();
      const program4 = createProgram({ ...io4, fetch: async () => { throw new Error("no fetch"); } });
      await program4.parseAsync(["node", "muse", "status", "--user", "stark", "--json"], { from: "node" });
      const snap4 = JSON.parse(out4.join("")) as { persona: { workingHours?: string } };
      expect(snap4.persona.workingHours).toBeUndefined();
    } finally {
      if (prevMemoryFile === undefined) delete process.env.MUSE_USER_MEMORY_FILE;
      else process.env.MUSE_USER_MEMORY_FILE = prevMemoryFile;
    }
  });

  it("muse status surfaces persona.currentFocus from memory (goal 146)", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "muse-cli-status-focus-"));
    const fsp = await import("node:fs/promises");
    const userMemoryFile = path.join(root, "user-memory.json");

    const prevMemoryFile = process.env.MUSE_USER_MEMORY_FILE;
    process.env.MUSE_USER_MEMORY_FILE = userMemoryFile;
    try {
      // Preferences win over facts (active-context.ts precedence).
      await fsp.writeFile(userMemoryFile, JSON.stringify({
        users: {
          stark: {
            facts: { name: "Stark", current_focus: "fact-side" },
            preferences: { current_focus: "Q3 budget memo" },
            updatedAt: "2026-05-15T00:00:00Z"
          }
        }
      }), "utf8");

      // --json surfaces the field.
      const { io: io1, output: out1 } = captureOutput();
      const program1 = createProgram({ ...io1, fetch: async () => { throw new Error("no fetch"); } });
      await program1.parseAsync(["node", "muse", "status", "--user", "stark", "--json"], { from: "node" });
      const snap = JSON.parse(out1.join("")) as { persona: { currentFocus?: string } };
      expect(snap.persona.currentFocus).toBe("Q3 budget memo");

      // Text renderer prints a one-line "current focus" entry.
      const { io: io2, output: out2 } = captureOutput();
      const program2 = createProgram({ ...io2, fetch: async () => { throw new Error("no fetch"); } });
      await program2.parseAsync(["node", "muse", "status", "--user", "stark"], { from: "node" });
      expect(out2.join("")).toContain("current focus: Q3 budget memo");

      // Falls back to facts when preferences.current_focus absent.
      await fsp.writeFile(userMemoryFile, JSON.stringify({
        users: {
          stark: {
            facts: { current_focus: "fact-only focus" },
            preferences: {},
            updatedAt: "2026-05-15T00:00:00Z"
          }
        }
      }), "utf8");
      const { io: io3, output: out3 } = captureOutput();
      const program3 = createProgram({ ...io3, fetch: async () => { throw new Error("no fetch"); } });
      await program3.parseAsync(["node", "muse", "status", "--user", "stark", "--json"], { from: "node" });
      const snap3 = JSON.parse(out3.join("")) as { persona: { currentFocus?: string } };
      expect(snap3.persona.currentFocus).toBe("fact-only focus");

      // Missing → omitted from JSON (no fake "(none)" string).
      await fsp.writeFile(userMemoryFile, JSON.stringify({
        users: { stark: { facts: {}, preferences: {}, updatedAt: "2026-05-15T00:00:00Z" } }
      }), "utf8");
      const { io: io4, output: out4 } = captureOutput();
      const program4 = createProgram({ ...io4, fetch: async () => { throw new Error("no fetch"); } });
      await program4.parseAsync(["node", "muse", "status", "--user", "stark", "--json"], { from: "node" });
      const snap4 = JSON.parse(out4.join("")) as { persona: { currentFocus?: string } };
      expect(snap4.persona.currentFocus).toBeUndefined();
    } finally {
      if (prevMemoryFile === undefined) delete process.env.MUSE_USER_MEMORY_FILE;
      else process.env.MUSE_USER_MEMORY_FILE = prevMemoryFile;
    }
  });

  it("muse status reads memory + trust at user@slot when MUSE_PERSONA is set (goal 104)", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "muse-cli-status-effective-key-"));
    const fsp = await import("node:fs/promises");
    const userMemoryFile = path.join(root, "user-memory.json");
    const trustFile = path.join(root, "trust.json");
    // Seed two records: bare `stark` (the bug-state default) AND the
    // slot-keyed `stark@work` record. A slot-aware status MUST pick
    // the second one when MUSE_PERSONA=work.
    await fsp.writeFile(userMemoryFile, JSON.stringify({
      users: {
        stark: { facts: { name: "Stark (home)" }, preferences: {}, updatedAt: "2026-05-13T00:00:00Z" },
        "stark@work": {
          facts: { name: "Stark (work)", role: "ceo" },
          preferences: { tone: "professional", "veto:no_emoji": "skip emoji on work-slot" },
          updatedAt: "2026-05-15T00:00:00Z"
        }
      }
    }), "utf8");
    await fsp.writeFile(trustFile, JSON.stringify({
      users: {
        stark: { trustedTools: ["calendar.list"], blockedTools: [] },
        "stark@work": { trustedTools: ["mail.send"], blockedTools: ["shell.exec"] }
      }
    }), "utf8");

    const prevMemoryFile = process.env.MUSE_USER_MEMORY_FILE;
    const prevTrustFile = process.env.MUSE_TRUST_FILE;
    const prevPersona = process.env.MUSE_PERSONA;
    process.env.MUSE_USER_MEMORY_FILE = userMemoryFile;
    process.env.MUSE_TRUST_FILE = trustFile;
    process.env.MUSE_PERSONA = "work";
    try {
      const { io, output } = captureOutput();
      const program = createProgram({ ...io, fetch: async () => { throw new Error("no fetch"); } });
      await program.parseAsync(["node", "muse", "status", "--user", "stark", "--json"], { from: "node" });
      const snap = JSON.parse(output.join("")) as {
        persona: {
          userId: string;
          slot?: string;
          effectiveUserKey?: string;
          factCount: number;
          preferenceCount: number;
          vetoCount: number;
          updatedAt?: string;
        };
      };

      // Snap surfaces the composed key + counts from the WORK record.
      expect(snap.persona.userId).toBe("stark");
      expect(snap.persona.slot).toBe("work");
      expect(snap.persona.effectiveUserKey).toBe("stark@work");
      expect(snap.persona.factCount).toBe(2);            // name + role
      expect(snap.persona.preferenceCount).toBe(2);      // tone + veto:no_emoji
      expect(snap.persona.vetoCount).toBe(1);
      expect(snap.persona.updatedAt).toBe("2026-05-15T00:00:00Z");

      // With no MUSE_PERSONA, status falls back to the bare record
      // and effectiveUserKey is omitted from the snap.
      delete process.env.MUSE_PERSONA;
      const { io: io2, output: out2 } = captureOutput();
      const program2 = createProgram({ ...io2, fetch: async () => { throw new Error("no fetch"); } });
      await program2.parseAsync(["node", "muse", "status", "--user", "stark", "--json"], { from: "node" });
      const snap2 = JSON.parse(out2.join("")) as {
        persona: { factCount: number; slot?: string; effectiveUserKey?: string };
      };
      expect(snap2.persona.slot).toBeUndefined();
      expect(snap2.persona.effectiveUserKey).toBeUndefined();
      expect(snap2.persona.factCount).toBe(1);           // just "name"
    } finally {
      if (prevMemoryFile === undefined) delete process.env.MUSE_USER_MEMORY_FILE;
      else process.env.MUSE_USER_MEMORY_FILE = prevMemoryFile;
      if (prevTrustFile === undefined) delete process.env.MUSE_TRUST_FILE;
      else process.env.MUSE_TRUST_FILE = prevTrustFile;
      if (prevPersona === undefined) delete process.env.MUSE_PERSONA;
      else process.env.MUSE_PERSONA = prevPersona;
    }
  });

  it("muse status surfaces active persona slot (MUSE_PERSONA) and template (~/.muse/persona.json) (goal 098)", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "muse-cli-status-persona-"));
    const fsp = await import("node:fs/promises");
    const personaFile = path.join(root, "persona.json");
    await fsp.writeFile(personaFile, JSON.stringify({ activeId: "jarvis", custom: {} }), "utf8");

    const prevPersonaFile = process.env.MUSE_PERSONA_FILE;
    const prevPersonaEnv = process.env.MUSE_PERSONA;
    process.env.MUSE_PERSONA_FILE = personaFile;
    process.env.MUSE_PERSONA = "work";
    try {
      // --json shape carries slot + template fields.
      const { io, output } = captureOutput();
      const program = createProgram({ ...io, fetch: async () => { throw new Error("no fetch"); } });
      await program.parseAsync(["node", "muse", "status", "--user", "stark", "--json"], { from: "node" });
      const snap = JSON.parse(output.join("")) as {
        persona: {
          slot?: string;
          slotSource?: string;
          template: { activeId: string; isBuiltin: boolean; preambleBytes: number; description?: string };
        };
      };
      expect(snap.persona.slot).toBe("work");
      expect(snap.persona.slotSource).toBe("MUSE_PERSONA");
      expect(snap.persona.template.activeId).toBe("jarvis");
      expect(snap.persona.template.isBuiltin).toBe(true);
      expect(snap.persona.template.preambleBytes).toBeGreaterThan(0);

      // Text renderer surfaces the same in human form.
      const { io: io2, output: out2 } = captureOutput();
      const program2 = createProgram({ ...io2, fetch: async () => { throw new Error("no fetch"); } });
      await program2.parseAsync(["node", "muse", "status", "--user", "stark"], { from: "node" });
      const text = out2.join("");
      expect(text).toContain("slot: work (from MUSE_PERSONA)");
      expect(text).toMatch(/template: jarvis \(built-in, \d+-byte preamble\)/u);

      // With env unset, slot is dropped from JSON.
      delete process.env.MUSE_PERSONA;
      const { io: io3, output: out3 } = captureOutput();
      const program3 = createProgram({ ...io3, fetch: async () => { throw new Error("no fetch"); } });
      await program3.parseAsync(["node", "muse", "status", "--user", "stark", "--json"], { from: "node" });
      const snap3 = JSON.parse(out3.join("")) as { persona: { slot?: string; template: { activeId: string } } };
      expect(snap3.persona.slot).toBeUndefined();
      expect(snap3.persona.template.activeId).toBe("jarvis");
    } finally {
      if (prevPersonaFile !== undefined) process.env.MUSE_PERSONA_FILE = prevPersonaFile;
      else delete process.env.MUSE_PERSONA_FILE;
      if (prevPersonaEnv !== undefined) process.env.MUSE_PERSONA = prevPersonaEnv;
      else delete process.env.MUSE_PERSONA;
    }
  });

  it("parseKindSegment accepts singular + plural and hints on typos (goal 119)", async () => {
    const { parseKindSegment } = await import("../src/commands-memory.js");

    // Happy path: both singular and plural for both kinds.
    expect(parseKindSegment("fact")).toBe("facts");
    expect(parseKindSegment("facts")).toBe("facts");
    expect(parseKindSegment("preference")).toBe("preferences");
    expect(parseKindSegment("preferences")).toBe("preferences");
    // Whitespace + case-insensitive.
    expect(parseKindSegment("  Fact  ")).toBe("facts");

    // One-edit typo on either kind → error message names the typo
    // verbatim AND suggests the right form.
    try {
      parseKindSegment("facs");
      throw new Error("expected throw");
    } catch (cause) {
      expect((cause as Error).message).toContain("got 'facs'");
      expect((cause as Error).message).toContain("did you mean 'fact'?");
    }

    // Two-edit typo on the longer form lands inside the
    // length-aware cap for the longer candidate.
    try {
      parseKindSegment("preferene");
      throw new Error("expected throw");
    } catch (cause) {
      expect((cause as Error).message).toContain("did you mean 'preference'?");
    }

    // Unrelated input → still throws but no false-positive suggestion.
    try {
      parseKindSegment("foobarbaz-nope");
      throw new Error("expected throw");
    } catch (cause) {
      expect((cause as Error).message).toContain("kind must be 'fact' or 'preference'");
      expect((cause as Error).message).not.toContain("did you mean");
    }
  });

  it("muse search --time <typo> rejects with a closest-match hint (goal 133)", async () => {
    // One-edit typo on the canonical "week".
    const { io: io1 } = captureOutput();
    const program1 = createProgram({ ...io1, fetch: async () => { throw new Error("no fetch"); } });
    program1.exitOverride();
    await expect(program1.parseAsync(
      ["node", "muse", "search", "Q3 budget", "--time", "weak"],
      { from: "node" }
    )).rejects.toThrow(/did you mean 'week'\?/u);

    // Plural slip on "month" → suggests month.
    const { io: io2 } = captureOutput();
    const program2 = createProgram({ ...io2, fetch: async () => { throw new Error("no fetch"); } });
    program2.exitOverride();
    await expect(program2.parseAsync(
      ["node", "muse", "search", "Q3 budget", "--time", "months"],
      { from: "node" }
    )).rejects.toThrow(/did you mean 'month'\?/u);

    // Unrelated input → error fires, no false-positive suggestion.
    const { io: io3 } = captureOutput();
    const program3 = createProgram({ ...io3, fetch: async () => { throw new Error("no fetch"); } });
    program3.exitOverride();
    await expect(program3.parseAsync(
      ["node", "muse", "search", "Q3 budget", "--time", "totally-unrelated"],
      { from: "node" }
    )).rejects.toThrow(/--time must be one of/u);
  });

  it("muse watch-folder --provider <typo> suggests the closest registered provider (goal 132)", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "muse-watch-folder-typo-"));
    const prevTg = process.env.MUSE_TELEGRAM_BOT_TOKEN;
    const prevExitCode = process.exitCode;
    process.env.MUSE_TELEGRAM_BOT_TOKEN = "fake-token";  // makes 'telegram' a registered provider
    process.exitCode = 0;
    try {
      // One-edit typo for "telegram".
      const { io, output } = captureOutput();
      const program = createProgram({ ...io, fetch: async () => { throw new Error("no fetch"); } });
      await program.parseAsync(
        ["node", "muse", "watch-folder", "--provider", "telegrma", "--path", root],
        { from: "node" }
      );
      const text = output.join("");
      expect(text).toContain("Provider 'telegrma' is not registered");
      expect(text).toContain("did you mean --provider telegram?");
      expect(process.exitCode).toBe(1);

      // Unrelated input → no false-positive suggestion.
      process.exitCode = 0;
      const { io: io2, output: out2 } = captureOutput();
      const program2 = createProgram({ ...io2, fetch: async () => { throw new Error("no fetch"); } });
      await program2.parseAsync(
        ["node", "muse", "watch-folder", "--provider", "totally-unknown-provider-name", "--path", root],
        { from: "node" }
      );
      const text2 = out2.join("");
      expect(text2).toContain("is not registered");
      expect(text2).not.toContain("did you mean");
    } finally {
      process.exitCode = prevExitCode;
      if (prevTg === undefined) delete process.env.MUSE_TELEGRAM_BOT_TOKEN;
      else process.env.MUSE_TELEGRAM_BOT_TOKEN = prevTg;
    }
  });

  it("muse mcp use <typo-preset> suggests the closest valid preset (goal 131)", async () => {
    // One-edit typo for "filesystem".
    const { io: io1, output: out1 } = captureOutput();
    const program1 = createProgram({ ...io1, fetch: async () => { throw new Error("no fetch"); } });
    program1.exitOverride();
    await expect(program1.parseAsync(["node", "muse", "mcp", "use", "filsystem"], { from: "node" }))
      .rejects.toBeDefined();
    expect(out1.join("")).toContain("did you mean 'filesystem'?");

    // Unrelated input — error fires + lists available, no false-positive suggestion.
    const { io: io2, output: out2 } = captureOutput();
    const program2 = createProgram({ ...io2, fetch: async () => { throw new Error("no fetch"); } });
    program2.exitOverride();
    await expect(program2.parseAsync(["node", "muse", "mcp", "use", "totally-unknown-preset"], { from: "node" }))
      .rejects.toBeDefined();
    const text2 = out2.join("");
    expect(text2).toContain("Unknown preset 'totally-unknown-preset'");
    expect(text2).not.toContain("did you mean");
    // Available list is still surfaced for guidance.
    expect(text2).toContain("Available:");
  });

  it("muse routine pluralises 'day' in the sessions summary (goal 129)", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "muse-routine-plural-"));
    const fsp = await import("node:fs/promises");
    const activityFile = path.join(root, "activity.jsonl");
    const prev = process.env.MUSE_ACTIVITY_FILE;
    process.env.MUSE_ACTIVITY_FILE = activityFile;
    try {
      // Singular: one session on one day → "across 1 day".
      await fsp.writeFile(activityFile, JSON.stringify({
        tsIso: "2026-05-13T09:00:00Z",
        userId: "stark",
        kind: "repl-start"
      }) + "\n", "utf8");

      const { io: io1, output: out1 } = captureOutput();
      const program1 = createProgram({ ...io1, fetch: async () => { throw new Error("no fetch"); } });
      await program1.parseAsync(["node", "muse", "routine", "--user", "stark"], { from: "node" });
      const text1 = out1.join("");
      expect(text1).toContain("across 1 day ");
      expect(text1).not.toContain("day(s)");

      // Plural: three distinct days → "across 3 days".
      await fsp.writeFile(activityFile, [
        { tsIso: "2026-05-13T09:00:00Z", userId: "stark", kind: "repl-start" },
        { tsIso: "2026-05-14T10:00:00Z", userId: "stark", kind: "repl-start" },
        { tsIso: "2026-05-15T11:00:00Z", userId: "stark", kind: "repl-start" }
      ].map((row) => JSON.stringify(row)).join("\n") + "\n", "utf8");

      const { io: io2, output: out2 } = captureOutput();
      const program2 = createProgram({ ...io2, fetch: async () => { throw new Error("no fetch"); } });
      await program2.parseAsync(["node", "muse", "routine", "--user", "stark"], { from: "node" });
      const text2 = out2.join("");
      expect(text2).toContain("across 3 days ");
      expect(text2).not.toContain("day(s)");
    } finally {
      if (prev === undefined) delete process.env.MUSE_ACTIVITY_FILE;
      else process.env.MUSE_ACTIVITY_FILE = prev;
    }
  });

  it("maybeCompactLastChatHistory scrubs credential shapes from the LLM summary before write (goal 138)", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "muse-chat-compact-redact-"));
    const fsp = await import("node:fs/promises");
    const prev = process.env.HOME;
    process.env.HOME = root;
    try {
      const {
        HISTORY_COMPACT_THRESHOLD,
        appendLastChatTurn,
        maybeCompactLastChatHistory
      } = await import("../src/chat-history.js");

      // Seed last-chat.jsonl with enough lines (> threshold) to
      // trigger compaction. Each appendLastChatTurn writes 2 lines.
      const seedTurns = Math.ceil((HISTORY_COMPACT_THRESHOLD + 4) / 2);
      for (let i = 0; i < seedTurns; i += 1) {
        await appendLastChatTurn({ message: `turn ${i.toString()}`, response: `reply ${i.toString()}` });
      }

      // Stub provider hallucinates a credential into the summary.
      const stubProvider = {
        async *stream() {
          yield {
            type: "text-delta",
            text: "User asked about key rotation; remembered sk-proj-abcdefghijklmnopqrstuvwxyz for context."
          };
        }
      } as unknown as Parameters<typeof maybeCompactLastChatHistory>[0];

      const result = await maybeCompactLastChatHistory(stubProvider, "stub-model");
      expect(result.compacted).toBe(true);
      // Returned summary is the scrubbed form (callers read it).
      expect(result.summary).toContain("[redacted-openai-key]");
      expect(result.summary).not.toContain("sk-proj-abcdefghijklmnopqrstuvwxyz");

      // On-disk file carries the scrubbed summary too.
      const onDisk = await fsp.readFile(path.join(root, ".muse", "last-chat.jsonl"), "utf8");
      expect(onDisk).toContain("[redacted-openai-key]");
      expect(onDisk).not.toContain("sk-proj-abcdefghijklmnopqrstuvwxyz");
      // Surrounding prose survives.
      expect(onDisk).toContain("User asked about key rotation");
    } finally {
      if (prev !== undefined) process.env.HOME = prev;
      else delete process.env.HOME;
    }
  });

  it("muse maintenance compact --keep-days strict Number() parse (goal 144)", async () => {
    const { io, output } = captureOutput();
    const prevExitCode = process.exitCode;
    process.exitCode = 0;
    try {
      // Unit-slip "7d" rejected (Number.parseFloat would have eaten the d).
      const program = createProgram({ ...io, fetch: async () => { throw new Error("no fetch"); } });
      await program.parseAsync(["node", "muse", "maintenance", "compact", "--keep-days", "7d"], { from: "node" });
      expect(output.join("")).toContain("--keep-days must be a non-negative number");
      expect(output.join("")).toContain("got '7d'");
      expect(process.exitCode).toBe(1);

      // Negative rejected.
      process.exitCode = 0;
      const { io: io2, output: out2 } = captureOutput();
      const program2 = createProgram({ ...io2, fetch: async () => { throw new Error("no fetch"); } });
      await program2.parseAsync(["node", "muse", "maintenance", "compact", "--keep-days", "-3"], { from: "node" });
      expect(out2.join("")).toContain("--keep-days must be a non-negative number");
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = prevExitCode;
    }
  });

  it("muse watch-folder --default-lead-minutes strict Number() parse (goal 144)", async () => {
    const { tmpdir } = await import("node:os");
    const root = await mkdtemp(path.join(tmpdir(), "muse-watch-lead-"));
    const prevExitCode = process.exitCode;
    process.exitCode = 0;
    try {
      // Unit-slip "60m" rejected.
      const { io, output } = captureOutput();
      const program = createProgram({ ...io, fetch: async () => { throw new Error("no fetch"); } });
      await program.parseAsync(
        ["node", "muse", "watch-folder", "--path", root, "--default-lead-minutes", "60m"],
        { from: "node" }
      );
      expect(output.join("")).toContain("--default-lead-minutes must be >= 1");
      expect(output.join("")).toContain("got '60m'");
      expect(process.exitCode).toBe(1);

      // 0 rejected (must be >= 1).
      process.exitCode = 0;
      const { io: io2, output: out2 } = captureOutput();
      const program2 = createProgram({ ...io2, fetch: async () => { throw new Error("no fetch"); } });
      await program2.parseAsync(
        ["node", "muse", "watch-folder", "--path", root, "--default-lead-minutes", "0"],
        { from: "node" }
      );
      expect(out2.join("")).toContain("--default-lead-minutes must be >= 1");
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = prevExitCode;
    }
  });

  it("muse feeds today --hours rejects non-numeric / non-positive input (goal 143)", async () => {
    const { io } = captureOutput();

    // Non-numeric → error with the offending input verbatim.
    const program1 = createProgram({ ...io, fetch: async () => { throw new Error("no fetch"); } });
    program1.exitOverride();
    await expect(program1.parseAsync(["node", "muse", "feeds", "today", "--hours", "abc"], { from: "node" }))
      .rejects.toThrow(/--hours must be a positive number \(got 'abc'\)/u);

    // Common typo (forgot to drop the unit) — `4h` → still rejected.
    const program2 = createProgram({ ...io, fetch: async () => { throw new Error("no fetch"); } });
    program2.exitOverride();
    await expect(program2.parseAsync(["node", "muse", "feeds", "today", "--hours", "4h"], { from: "node" }))
      .rejects.toThrow(/--hours must be a positive number/u);

    // 0 / negative rejected explicitly.
    const program3 = createProgram({ ...io, fetch: async () => { throw new Error("no fetch"); } });
    program3.exitOverride();
    await expect(program3.parseAsync(["node", "muse", "feeds", "today", "--hours", "0"], { from: "node" }))
      .rejects.toThrow(/--hours must be > 0/u);

    const program4 = createProgram({ ...io, fetch: async () => { throw new Error("no fetch"); } });
    program4.exitOverride();
    await expect(program4.parseAsync(["node", "muse", "feeds", "today", "--hours", "-3"], { from: "node" }))
      .rejects.toThrow(/--hours must be > 0/u);

    // Whitespace-only rejected.
    const program5 = createProgram({ ...io, fetch: async () => { throw new Error("no fetch"); } });
    program5.exitOverride();
    await expect(program5.parseAsync(["node", "muse", "feeds", "today", "--hours", "   "], { from: "node" }))
      .rejects.toThrow(/--hours must not be empty/u);

    // Happy path: positive number passes validation, default keeps
    // working without the flag.
    const program6 = createProgram({ ...io, fetch: async () => { throw new Error("no fetch"); } });
    await expect(program6.parseAsync(["node", "muse", "feeds", "today", "--hours", "12"], { from: "node" })).resolves.toBeDefined();
    const program7 = createProgram({ ...io, fetch: async () => { throw new Error("no fetch"); } });
    await expect(program7.parseAsync(["node", "muse", "feeds", "today"], { from: "node" })).resolves.toBeDefined();
  });

  it("muse feeds list --json + muse feeds today --json envelopes carry the `total` field — convention parity with followup / remind / actions / objectives", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "muse-cli-feeds-json-"));
    const feedsFile = path.join(root, "feeds.json");
    const fsp = await import("node:fs/promises");
    const prev = process.env.MUSE_FEEDS_FILE;
    process.env.MUSE_FEEDS_FILE = feedsFile;
    try {
      const now = new Date().toISOString();
      const recent = new Date(Date.now() - 30 * 60 * 1000).toISOString();
      await fsp.writeFile(feedsFile, JSON.stringify({
        version: 1,
        feeds: [
          { id: "a", url: "https://a.test/feed", name: "A", lastFetchedAt: now, entries: [
            { id: "e1", title: "T1", link: "https://a.test/1", publishedAt: recent, summary: "" }
          ] },
          { id: "b", url: "https://b.test/feed", name: "B", lastFetchedAt: now, entries: [] }
        ]
      }), "utf8");

      const { io: io1, output: out1 } = captureOutput();
      const program1 = createProgram({ ...io1, fetch: async () => { throw new Error("no fetch"); } });
      await program1.parseAsync(["node", "muse", "feeds", "list", "--json"], { from: "node" });
      const listed = JSON.parse(out1.join("")) as { feeds: Array<{ id: string }>; total: number };
      expect(listed.total, "feeds list --json must carry `total` (convention parity with goals 552/553)").toBe(2);
      expect(listed.feeds.map((f) => f.id)).toEqual(["a", "b"]);

      const { io: io2, output: out2 } = captureOutput();
      const program2 = createProgram({ ...io2, fetch: async () => { throw new Error("no fetch"); } });
      await program2.parseAsync(["node", "muse", "feeds", "today", "--hours", "2", "--json"], { from: "node" });
      const today = JSON.parse(out2.join("")) as { entries: Array<{ id: string }>; hours: number; total: number };
      expect(today.total, "feeds today --json must carry `total` (convention parity)").toBe(1);
      expect(today.hours).toBe(2);
      expect(today.entries[0]?.id).toBe("e1");
    } finally {
      if (prev === undefined) delete process.env.MUSE_FEEDS_FILE;
      else process.env.MUSE_FEEDS_FILE = prev;
    }
  });

  it("muse remind list rejects --status typos with a closest-match hint (goal 137)", async () => {
    const { io } = captureOutput();

    // One-edit typo for "fired" → suggests "fired".
    const program1 = createProgram({ ...io, fetch: async () => { throw new Error("not reached"); } });
    program1.exitOverride();
    await expect(program1.parseAsync(
      ["node", "muse", "--api-url", "http://api.test", "remind", "list", "--status", "fire"],
      { from: "node" }
    )).rejects.toThrow(/did you mean 'fired'\?/u);

    // Plural slip on "due" → suggests "due".
    const program2 = createProgram({ ...io, fetch: async () => { throw new Error("not reached"); } });
    program2.exitOverride();
    await expect(program2.parseAsync(
      ["node", "muse", "--api-url", "http://api.test", "remind", "list", "--status", "dues"],
      { from: "node" }
    )).rejects.toThrow(/did you mean 'due'\?/u);

    // Unrelated input → error fires, no false-positive suggestion.
    const program3 = createProgram({ ...io, fetch: async () => { throw new Error("not reached"); } });
    program3.exitOverride();
    await expect(program3.parseAsync(
      ["node", "muse", "--api-url", "http://api.test", "remind", "list", "--status", "totally-unrelated"],
      { from: "node" }
    )).rejects.toThrow(/--status must be one of: pending, fired, all, due/u);

    // Happy path: a valid value passes validation.
    const program4 = createProgram({ ...io, fetch: async () => new Response(JSON.stringify({ reminders: [], status: "pending", total: 0 })) });
    await expect(program4.parseAsync(
      ["node", "muse", "--api-url", "http://api.test", "remind", "list", "--status", "pending"],
      { from: "node" }
    )).resolves.toBeDefined();
  });

  it("muse remind list --local resolves dueAt ties by id asc, independent of file-array insertion order", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "muse-cli-remind-tie-"));
    const remindersFile = path.join(root, "reminders.json");
    const fsp = await import("node:fs/promises");
    const prev = process.env.MUSE_REMINDERS_FILE;
    process.env.MUSE_REMINDERS_FILE = remindersFile;
    try {
      const sameDueAt = "2099-01-01T09:00:00.000Z";
      await fsp.writeFile(remindersFile, JSON.stringify({
        reminders: [
          { createdAt: "2026-05-20T00:00:00.000Z", dueAt: sameDueAt, id: "rem_b", status: "pending", text: "B" },
          { createdAt: "2026-05-20T00:00:00.000Z", dueAt: sameDueAt, id: "rem_a", status: "pending", text: "A" },
          { createdAt: "2026-05-20T00:00:00.000Z", dueAt: sameDueAt, id: "rem_c", status: "pending", text: "C" }
        ]
      }), "utf8");
      const { io, output } = captureOutput();
      const program = createProgram({ ...io, fetch: async () => { throw new Error("fetch in --local"); } });
      await program.parseAsync(["node", "muse", "remind", "list", "--local", "--json"], { from: "node" });
      const listed = JSON.parse(output.join("")) as { reminders: Array<{ id: string }>; total: number };
      expect(listed.total).toBe(3);
      expect(listed.reminders.map((r) => r.id), "ties on dueAt resolve by id asc — independent of file-array insertion order").toEqual(["rem_a", "rem_b", "rem_c"]);
    } finally {
      if (prev === undefined) delete process.env.MUSE_REMINDERS_FILE;
      else process.env.MUSE_REMINDERS_FILE = prev;
    }
  });

  it("muse tasks list rejects --status typos with a closest-match hint (goal 125)", async () => {
    const { io } = captureOutput();
    const program = createProgram({ ...io, fetch: async () => { throw new Error("not reached — should reject before fetch"); } });
    program.exitOverride();

    // One-edit typo for "done" → suggests "done".
    await expect(program.parseAsync(
      ["node", "muse", "--api-url", "http://api.test", "tasks", "list", "--status", "doe"],
      { from: "node" }
    )).rejects.toThrow(/did you mean 'done'\?/u);

    // Two-edit typo on "all" → suggests "all".
    const program2 = createProgram({ ...io, fetch: async () => { throw new Error("not reached"); } });
    program2.exitOverride();
    await expect(program2.parseAsync(
      ["node", "muse", "--api-url", "http://api.test", "tasks", "list", "--status", "al"],
      { from: "node" }
    )).rejects.toThrow(/did you mean 'all'\?/u);

    // Unrelated input — error fires + names the valid set, no
    // false-positive suggestion.
    const program3 = createProgram({ ...io, fetch: async () => { throw new Error("not reached"); } });
    program3.exitOverride();
    await expect(program3.parseAsync(
      ["node", "muse", "--api-url", "http://api.test", "tasks", "list", "--status", "totally-unrelated"],
      { from: "node" }
    )).rejects.toThrow(/--status must be one of: open, done, all/u);

    // Happy path: a valid value passes validation and the fetch
    // stub fires. parseAsync resolves to the Command instance —
    // we just assert it doesn't reject.
    const program4 = createProgram({ ...io, fetch: async () => new Response(JSON.stringify({ status: "open", tasks: [], total: 0 })) });
    await expect(program4.parseAsync(
      ["node", "muse", "--api-url", "http://api.test", "tasks", "list", "--status", "open"],
      { from: "node" }
    )).resolves.toBeDefined();
  });

  it("muse trust revoke / unblock hint when the tool wasn't actually listed (goal 118)", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "muse-trust-typo-"));
    const fsp = await import("node:fs/promises");
    const trustFile = path.join(root, "trust.json");
    // Seed: stark has `muse.notes.write` trusted and `shell.exec`
    // blocked. The test will revoke a typo'd trusted name and
    // unblock a typo'd blocked name; both should warn + suggest.
    // `version: 1` is required by readTrustFile or the parser
    // falls back to an empty TrustFile.
    await fsp.writeFile(trustFile, JSON.stringify({
      version: 1,
      users: {
        stark: {
          trustedTools: ["muse.notes.write", "muse.calendar.list"],
          blockedTools: ["shell.exec", "browser.close_page"]
        }
      }
    }), "utf8");

    const prevTrustFile = process.env.MUSE_TRUST_FILE;
    const prevUser = process.env.MUSE_USER_ID;
    process.env.MUSE_TRUST_FILE = trustFile;
    process.env.MUSE_USER_ID = "stark";
    try {
      // revoke with a one-edit typo → warning names the closest match.
      const { io: io1, output: out1 } = captureOutput();
      const program1 = createProgram({ ...io1, fetch: async () => { throw new Error("no fetch"); } });
      await program1.parseAsync(["node", "muse", "trust", "revoke", "muse.notes.writes"], { from: "node" });
      const text1 = out1.join("");
      expect(text1).toContain("'muse.notes.writes' was not in the trusted list");
      expect(text1).toContain("did you mean 'muse.notes.write'?");
      expect(text1).toContain("muse trust list");
      // No "Revoked '...'" success line.
      expect(text1).not.toMatch(/Revoked 'muse\.notes\.writes'/u);

      // unblock with a one-edit typo → same shape.
      const { io: io2, output: out2 } = captureOutput();
      const program2 = createProgram({ ...io2, fetch: async () => { throw new Error("no fetch"); } });
      await program2.parseAsync(["node", "muse", "trust", "unblock", "shell.exe"], { from: "node" });
      const text2 = out2.join("");
      expect(text2).toContain("'shell.exe' was not in the blocked list");
      expect(text2).toContain("did you mean 'shell.exec'?");
      expect(text2).not.toMatch(/Unblocked 'shell\.exe'/u);

      // Unrelated string → warning fires but no false-positive suggestion.
      const { io: io3, output: out3 } = captureOutput();
      const program3 = createProgram({ ...io3, fetch: async () => { throw new Error("no fetch"); } });
      await program3.parseAsync(["node", "muse", "trust", "revoke", "totally-unrelated-tool-name"], { from: "node" });
      const text3 = out3.join("");
      expect(text3).toContain("was not in the trusted list");
      expect(text3).not.toContain("did you mean");

      // Happy path: real revoke still emits the success line.
      const { io: io4, output: out4 } = captureOutput();
      const program4 = createProgram({ ...io4, fetch: async () => { throw new Error("no fetch"); } });
      await program4.parseAsync(["node", "muse", "trust", "revoke", "muse.notes.write"], { from: "node" });
      expect(out4.join("")).toMatch(/Revoked 'muse\.notes\.write'/u);
    } finally {
      if (prevTrustFile === undefined) delete process.env.MUSE_TRUST_FILE;
      else process.env.MUSE_TRUST_FILE = prevTrustFile;
      if (prevUser === undefined) delete process.env.MUSE_USER_ID;
      else process.env.MUSE_USER_ID = prevUser;
    }
  });

  it("muse trust grant / block surfaces a transition warning when the tool was previously in the opposite list", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "muse-trust-transition-"));
    const fsp = await import("node:fs/promises");
    const trustFile = path.join(root, "trust.json");
    await fsp.writeFile(trustFile, JSON.stringify({
      version: 1,
      users: {
        stark: {
          trustedTools: ["muse.tasks.add"],
          blockedTools: ["shell.exec"]
        }
      }
    }), "utf8");

    const prevTrustFile = process.env.MUSE_TRUST_FILE;
    const prevUser = process.env.MUSE_USER_ID;
    process.env.MUSE_TRUST_FILE = trustFile;
    process.env.MUSE_USER_ID = "stark";
    try {
      // Granting a previously-BLOCKED tool surfaces the transition.
      const { io: io1, output: out1 } = captureOutput();
      const program1 = createProgram({ ...io1, fetch: async () => { throw new Error("no fetch"); } });
      await program1.parseAsync(["node", "muse", "trust", "grant", "shell.exec"], { from: "node" });
      const text1 = out1.join("");
      expect(text1).toContain("Granted 'shell.exec'");
      expect(
        text1,
        "grant of a previously-blocked tool must surface the transition — silent demotion of a security gate is the bug"
      ).toContain("previously BLOCKED — now moved to trusted");

      // Granting a fresh tool (not in either list) does NOT add the transition tail.
      const { io: io2, output: out2 } = captureOutput();
      const program2 = createProgram({ ...io2, fetch: async () => { throw new Error("no fetch"); } });
      await program2.parseAsync(["node", "muse", "trust", "grant", "muse.notes.read"], { from: "node" });
      const text2 = out2.join("");
      expect(text2).toContain("Granted 'muse.notes.read'");
      expect(text2, "additive grant must NOT pretend there was a transition").not.toContain("previously");

      // Blocking a previously-TRUSTED tool surfaces the inverse transition.
      const { io: io3, output: out3 } = captureOutput();
      const program3 = createProgram({ ...io3, fetch: async () => { throw new Error("no fetch"); } });
      await program3.parseAsync(["node", "muse", "trust", "block", "muse.tasks.add"], { from: "node" });
      const text3 = out3.join("");
      expect(text3).toContain("Blocked 'muse.tasks.add'");
      expect(text3).toContain("previously TRUSTED — now moved to blocked");

      // Blocking a fresh tool (not in either list) — no transition tail.
      const { io: io4, output: out4 } = captureOutput();
      const program4 = createProgram({ ...io4, fetch: async () => { throw new Error("no fetch"); } });
      await program4.parseAsync(["node", "muse", "trust", "block", "browser.fill_form"], { from: "node" });
      const text4 = out4.join("");
      expect(text4).toContain("Blocked 'browser.fill_form'");
      expect(text4).not.toContain("previously");
    } finally {
      if (prevTrustFile === undefined) delete process.env.MUSE_TRUST_FILE;
      else process.env.MUSE_TRUST_FILE = prevTrustFile;
      if (prevUser === undefined) delete process.env.MUSE_USER_ID;
      else process.env.MUSE_USER_ID = prevUser;
    }
  });
});

describe("uniqueCommandPrefix", () => {
  const names = ["status", "stats", "tasks", "today", "remind", "recall"];

  it("resolves an unambiguous prefix to the single matching command", () => {
    expect(uniqueCommandPrefix("rem", names)).toBe("remind");
    expect(uniqueCommandPrefix("tas", names)).toBe("tasks");
  });

  it("is case-insensitive", () => {
    expect(uniqueCommandPrefix("REM", names)).toBe("remind");
  });

  it("returns undefined for an ambiguous prefix instead of guessing", () => {
    // "stat" → status AND stats; "t" handled by the length guard.
    expect(uniqueCommandPrefix("stat", names)).toBeUndefined();
    expect(uniqueCommandPrefix("re", names)).toBeUndefined(); // remind + recall
  });

  it("requires at least 2 chars (a 1-char prefix is too weak to disambiguate)", () => {
    expect(uniqueCommandPrefix("t", names)).toBeUndefined();
    expect(uniqueCommandPrefix("", names)).toBeUndefined();
    expect(uniqueCommandPrefix("  ", names)).toBeUndefined();
  });

  it("returns undefined when nothing starts with the prefix", () => {
    expect(uniqueCommandPrefix("zzz", names)).toBeUndefined();
  });

  it("an exact full command name is still a unique prefix of itself", () => {
    expect(uniqueCommandPrefix("today", names)).toBe("today");
  });
});
