import { Command } from "commander";

export interface ProgramIO {
  readonly fetch?: typeof globalThis.fetch;
  readonly stdout: (message: string) => void;
  readonly stderr: (message: string) => void;
}

const defaultIO: ProgramIO = {
  stderr: (message) => {
    process.stderr.write(message);
  },
  stdout: (message) => {
    process.stdout.write(message);
  }
};

export function defaultConfigPath(home = process.env.HOME ?? "~"): string {
  return `${home}/.config/muse/config.json`;
}

export function createProgram(io: ProgramIO = defaultIO): Command {
  const program = new Command();

  program
    .name("muse")
    .description("Model-agnostic inspirational AI agent")
    .version("0.0.0")
    .option("--api-url <url>", "Muse API base URL")
    .option("--token <token>", "Bearer token for authenticated API calls")
    .configureOutput({
      writeErr: io.stderr,
      writeOut: io.stdout
    });

  program
    .command("config-path")
    .description("Print the active Muse config path")
    .action(() => {
      io.stdout(`${defaultConfigPath()}\n`);
    });

  program
    .command("spec")
    .description("Print the fixed migration stack")
    .option("--json", "Print machine-readable JSON")
    .action((options: { readonly json?: boolean }) => {
      const spec = {
        agentCore: "model-agnostic",
        cli: "typescript + ink",
        database: "postgresql + kysely",
        runner: "rust",
        server: "fastify"
      };

      if (options.json) {
        io.stdout(`${JSON.stringify(spec, null, 2)}\n`);
        return;
      }

      io.stdout("Muse stack: TypeScript, Node.js, Fastify, PostgreSQL, Kysely, Ink, Rust runner\n");
    });

  program
    .command("chat")
    .description("Run a chat request through the Muse API")
    .argument("<message...>", "User message")
    .option("--model <model>", "Model name")
    .option("--json", "Print machine-readable JSON")
    .action(async (
      messageParts: readonly string[],
      options: { readonly json?: boolean; readonly model?: string },
      command
    ) => {
      const body = await apiRequest(io, command, "/api/chat", {
        message: messageParts.join(" "),
        model: options.model
      });

      writeOutput(io, body, options.json ? undefined : "response");
    });

  const mcp = program.command("mcp").description("Manage MCP servers");

  mcp
    .command("list")
    .description("List MCP servers")
    .action(async (_options, command) => {
      writeOutput(io, await apiRequest(io, command, "/api/mcp/servers"));
    });

  mcp
    .command("add")
    .description("Register an MCP server")
    .argument("<name>", "Server name")
    .requiredOption("--transport <type>", "stdio, sse, streamable, or http")
    .option("--config <json>", "Transport config JSON", "{}")
    .option("--description <text>", "Description")
    .option("--no-auto-connect", "Do not connect immediately")
    .action(async (name: string, options, command) => {
      writeOutput(io, await apiRequest(io, command, "/api/mcp/servers", {
        autoConnect: options.autoConnect,
        config: parseJsonObject(options.config),
        description: options.description,
        name,
        transportType: options.transport
      }));
    });

  mcp
    .command("connect")
    .description("Connect an MCP server")
    .argument("<name>", "Server name")
    .action(async (name: string, _options, command) => {
      writeOutput(
        io,
        await apiRequest(io, command, `/api/mcp/servers/${encodeURIComponent(name)}/connect`, undefined, "POST")
      );
    });

  mcp
    .command("disconnect")
    .description("Disconnect an MCP server")
    .argument("<name>", "Server name")
    .action(async (name: string, _options, command) => {
      writeOutput(
        io,
        await apiRequest(io, command, `/api/mcp/servers/${encodeURIComponent(name)}/disconnect`, undefined, "POST")
      );
    });

  mcp
    .command("tools")
    .description("List MCP tools")
    .argument("[name]", "Optional server name")
    .action(async (name: string | undefined, _options, command) => {
      const path = name
        ? `/api/mcp/servers/${encodeURIComponent(name)}/tools`
        : "/api/mcp/tools";
      writeOutput(io, await apiRequest(io, command, path));
    });

  mcp
    .command("call")
    .description("Call a connected MCP tool")
    .argument("<server>", "Server name")
    .argument("<tool>", "Tool name")
    .option("--args <json>", "Tool arguments JSON", "{}")
    .action(async (serverName: string, toolName: string, options, command) => {
      writeOutput(io, await apiRequest(
        io,
        command,
        `/api/mcp/servers/${encodeURIComponent(serverName)}/tools/${encodeURIComponent(toolName)}/call`,
        { args: parseJsonObject(options.args) }
      ));
    });

  const scheduler = program.command("scheduler").description("Manage scheduled jobs");

  scheduler
    .command("list")
    .description("List scheduled jobs")
    .action(async (_options, command) => {
      writeOutput(io, await apiRequest(io, command, "/api/scheduler/jobs"));
    });

  scheduler
    .command("create-agent")
    .description("Create an agent scheduled job")
    .argument("<name>", "Job name")
    .argument("<cron>", "Cron expression")
    .argument("<prompt...>", "Agent prompt")
    .option("--model <model>", "Agent model")
    .option("--disabled", "Create disabled")
    .action(async (name: string, cronExpression: string, promptParts: readonly string[], options, command) => {
      writeOutput(io, await apiRequest(io, command, "/api/scheduler/jobs", {
        agentModel: options.model,
        agentPrompt: promptParts.join(" "),
        cronExpression,
        enabled: !options.disabled,
        jobType: "agent",
        name
      }));
    });

  scheduler
    .command("trigger")
    .description("Trigger a scheduled job")
    .argument("<job-id>", "Job ID")
    .action(async (jobId: string, _options, command) => {
      writeOutput(
        io,
        await apiRequest(io, command, `/api/scheduler/jobs/${encodeURIComponent(jobId)}/trigger`, undefined, "POST")
      );
    });

  scheduler
    .command("dry-run")
    .description("Dry-run a scheduled job")
    .argument("<job-id>", "Job ID")
    .action(async (jobId: string, _options, command) => {
      writeOutput(
        io,
        await apiRequest(io, command, `/api/scheduler/jobs/${encodeURIComponent(jobId)}/dry-run`, undefined, "POST")
      );
    });

  return program;
}

async function apiRequest(
  io: ProgramIO,
  command: Command,
  path: string,
  body?: Record<string, unknown>,
  method?: "GET" | "POST"
) {
  const options = command.optsWithGlobals() as { readonly apiUrl?: string; readonly token?: string };
  const baseUrl = options.apiUrl ?? process.env.MUSE_API_URL ?? "http://127.0.0.1:3000";
  const token = options.token ?? process.env.MUSE_API_TOKEN;
  const response = await (io.fetch ?? globalThis.fetch)(new URL(path, baseUrl).toString(), {
    body: body ? JSON.stringify(dropUndefined(body)) : undefined,
    headers: {
      ...(body ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {})
    },
    method: method ?? (body ? "POST" : "GET")
  });
  const text = await response.text();

  if (!response.ok) {
    throw new Error(`Muse API ${response.status}: ${text || response.statusText}`);
  }

  return text.length > 0 ? JSON.parse(text) as unknown : undefined;
}

function writeOutput(io: ProgramIO, value: unknown, textField?: string): void {
  if (textField && isRecord(value) && typeof value[textField] === "string") {
    io.stdout(`${value[textField]}\n`);
    return;
  }

  io.stdout(`${JSON.stringify(value, null, 2)}\n`);
}

function parseJsonObject(value: string): Record<string, unknown> {
  const parsed = JSON.parse(value) as unknown;

  if (!isRecord(parsed)) {
    throw new Error("Expected a JSON object");
  }

  return parsed;
}

function dropUndefined(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter((entry) => entry[1] !== undefined));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
