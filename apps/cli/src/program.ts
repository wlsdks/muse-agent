import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { hostname, homedir, userInfo } from "node:os";
import path from "node:path";
import type { AgentRuntime } from "@muse/agent-core";
import { createMuseRuntimeAssembly } from "@muse/autoconfigure";
import { Command } from "commander";
import { renderMuseStatusTui, type MuseStatusTuiModel } from "./tui.js";

export interface ProgramIO {
  readonly fetch?: typeof globalThis.fetch;
  readonly stdout: (message: string) => void;
  readonly stderr: (message: string) => void;
  readonly workspaceDir?: string;
  readonly configDir?: string;
  readonly credentialKey?: string;
  readonly renderTui?: (model: MuseStatusTuiModel) => Promise<void> | void;
  readonly createRuntimeAssembly?: () => {
    readonly agentRuntime?: AgentRuntime;
    readonly defaultModel?: string;
  };
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

export function defaultCredentialPath(home = process.env.HOME ?? homedir()): string {
  return `${home}/.config/muse/credentials.json`;
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
    .command("tui")
    .description("Open the Muse terminal status UI")
    .option("--local", "Show local mode instead of remote API mode")
    .action(async (options: { readonly local?: boolean }, command) => {
      const { baseUrl } = await readApiOptions(io, command, { includeStoredToken: false });
      await (io.renderTui ?? renderMuseStatusTui)({
        apiUrl: baseUrl,
        configPath: configPath(io),
        credentialPath: credentialPath(io),
        mode: options.local ? "local" : "remote",
        workspaceRunsPath: path.join(io.workspaceDir ?? process.cwd(), ".muse", "runs")
      });
    });

  program
    .command("chat")
    .description("Run a chat request through the Muse API")
    .argument("<message...>", "User message")
    .option("--local", "Run through the local shared agent runtime instead of the API")
    .option("--model <model>", "Model name")
    .option("--stream", "Stream remote chat over SSE")
    .option("--json", "Print machine-readable JSON")
    .option("--no-log", "Do not write .muse/runs JSONL state")
    .action(async (
      messageParts: readonly string[],
      options: {
        readonly json?: boolean;
        readonly local?: boolean;
        readonly log?: boolean;
        readonly model?: string;
        readonly stream?: boolean;
      },
      command
    ) => {
      const message = messageParts.join(" ");
      if (options.local && options.stream) {
        throw new Error("--stream requires remote API chat; omit --local");
      }

      const body = options.local
        ? await runLocalChat(io, message, options.model)
        : options.stream
          ? await streamRemoteChat(io, command, message, options.model, options.json === true)
        : await apiRequest(io, command, "/api/chat", {
          message,
          model: options.model
        });

      if (options.log !== false) {
        const apiOptions = await readApiOptions(io, command, { includeStoredToken: false });
        await writeRunLog(io.workspaceDir ?? process.cwd(), {
          apiUrl: apiOptions.baseUrl,
          message,
          model: options.model,
          response: body,
          source: options.local ? "cli.local" : options.stream ? "cli.remote.stream" : "cli.remote"
        });
      }

      if (!options.stream || options.json) {
        writeOutput(io, body, options.json ? undefined : "response");
      }
    });

  const auth = program.command("auth").description("Manage CLI credentials");

  auth
    .command("login")
    .description("Store a bearer token in the encrypted CLI credential store")
    .argument("<token>", "Bearer token to store")
    .action(async (token: string, _options, command) => {
      const { baseUrl } = await readApiOptions(io, command, { includeStoredToken: false });
      await writeStoredToken(io, baseUrl, token);
      io.stdout(`Stored Muse API token for ${baseUrl}\n`);
    });

  auth
    .command("status")
    .description("Check whether a token is stored for the active API URL")
    .option("--json", "Print machine-readable JSON")
    .action(async (options: { readonly json?: boolean }, command) => {
      const { baseUrl } = await readApiOptions(io, command, { includeStoredToken: false });
      const token = await readStoredToken(io, baseUrl);
      const status = {
        apiUrl: baseUrl,
        credentialPath: credentialPath(io),
        hasToken: Boolean(token)
      };

      if (options.json) {
        writeOutput(io, status);
        return;
      }

      io.stdout(token ? `Stored Muse API token for ${baseUrl}\n` : `No stored Muse API token for ${baseUrl}\n`);
    });

  auth
    .command("logout")
    .description("Remove the stored bearer token for the active API URL")
    .action(async (_options, command) => {
      const { baseUrl } = await readApiOptions(io, command, { includeStoredToken: false });
      await deleteStoredToken(io, baseUrl);
      io.stdout(`Removed Muse API token for ${baseUrl}\n`);
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
  const { baseUrl, token } = await readApiOptions(io, command);
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

async function streamRemoteChat(
  io: ProgramIO,
  command: Command,
  message: string,
  model: string | undefined,
  jsonMode: boolean
) {
  const { baseUrl, token } = await readApiOptions(io, command);
  const response = await (io.fetch ?? globalThis.fetch)(new URL("/api/chat/stream", baseUrl).toString(), {
    body: JSON.stringify(dropUndefined({ message, model })),
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {})
    },
    method: "POST"
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Muse API ${response.status}: ${text || response.statusText}`);
  }

  let output = "";

  for await (const event of readSseEvents(response)) {
    if (event.event === "error") {
      throw new Error(`Muse API stream error: ${event.data}`);
    }

    if (event.event === "message") {
      output += event.data;
      if (!jsonMode) {
        io.stdout(event.data);
      }
      continue;
    }

    if (event.event === "done") {
      break;
    }
  }

  if (!jsonMode && !output.endsWith("\n")) {
    io.stdout("\n");
  }

  return {
    response: output,
    streamed: true
  };
}

async function runLocalChat(io: ProgramIO, message: string, model: string | undefined) {
  const assembly = io.createRuntimeAssembly?.() ?? createMuseRuntimeAssembly();

  if (!assembly.agentRuntime || !(model ?? assembly.defaultModel)) {
    throw new Error("Local chat requires MUSE_MODEL and a configured model provider");
  }

  const result = await assembly.agentRuntime.run({
    messages: [{ content: message, role: "user" }],
    model: model ?? assembly.defaultModel ?? "default"
  });

  return {
    response: result.response.output,
    runId: result.runId,
    toolsUsed: result.toolsUsed ?? []
  };
}

interface ApiOptions {
  readonly baseUrl: string;
  readonly token?: string;
}

interface ReadApiOptionsOptions {
  readonly includeStoredToken?: boolean;
}

async function readApiOptions(
  io: ProgramIO,
  command: Command,
  readOptions: ReadApiOptionsOptions = {}
): Promise<ApiOptions> {
  const globalOptions = command.optsWithGlobals() as { readonly apiUrl?: string; readonly token?: string };
  const baseUrl = globalOptions.apiUrl ?? process.env.MUSE_API_URL ?? "http://127.0.0.1:3000";
  const explicitToken = globalOptions.token ?? process.env.MUSE_API_TOKEN;

  return {
    baseUrl,
    token: explicitToken ?? (readOptions.includeStoredToken === false ? undefined : await readStoredToken(io, baseUrl))
  };
}

interface CredentialStore {
  readonly tokens: Record<string, StoredCredential>;
}

interface StoredCredential {
  readonly token: string;
  readonly updatedAt: string;
}

interface EncryptedCredentialFile {
  readonly algorithm: "aes-256-gcm";
  readonly data: string;
  readonly iv: string;
  readonly salt: string;
  readonly tag: string;
  readonly version: 1;
}

async function readStoredToken(io: ProgramIO, baseUrl: string): Promise<string | undefined> {
  return (await readCredentialStore(io)).tokens[baseUrl]?.token;
}

async function writeStoredToken(io: ProgramIO, baseUrl: string, token: string): Promise<void> {
  const store = await readCredentialStore(io);
  await writeCredentialStore(io, {
    tokens: {
      ...store.tokens,
      [baseUrl]: {
        token,
        updatedAt: new Date().toISOString()
      }
    }
  });
}

async function deleteStoredToken(io: ProgramIO, baseUrl: string): Promise<void> {
  const store = await readCredentialStore(io);
  const { [baseUrl]: _removed, ...tokens } = store.tokens;
  await writeCredentialStore(io, { tokens });
}

async function readCredentialStore(io: ProgramIO): Promise<CredentialStore> {
  try {
    const raw = await readFile(credentialPath(io), "utf8");
    const file = JSON.parse(raw) as unknown;
    if (!isEncryptedCredentialFile(file)) {
      throw new Error("Invalid Muse credential store format");
    }

    const plaintext = decryptCredentialPayload(io, file);
    const store = JSON.parse(plaintext) as unknown;
    if (!isCredentialStore(store)) {
      throw new Error("Invalid Muse credential payload");
    }

    return store;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return { tokens: {} };
    }

    throw error;
  }
}

async function writeCredentialStore(io: ProgramIO, store: CredentialStore): Promise<void> {
  const filePath = credentialPath(io);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(encryptCredentialPayload(io, JSON.stringify(store)), null, 2)}\n`, {
    mode: 0o600
  });
  await chmod(filePath, 0o600);
}

function encryptCredentialPayload(io: ProgramIO, plaintext: string): EncryptedCredentialFile {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = deriveCredentialKey(io, salt);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  return {
    algorithm: "aes-256-gcm",
    data: encrypted.toString("base64"),
    iv: iv.toString("base64"),
    salt: salt.toString("base64"),
    tag: tag.toString("base64"),
    version: 1
  };
}

function decryptCredentialPayload(io: ProgramIO, file: EncryptedCredentialFile): string {
  const salt = Buffer.from(file.salt, "base64");
  const iv = Buffer.from(file.iv, "base64");
  const tag = Buffer.from(file.tag, "base64");
  const key = deriveCredentialKey(io, salt);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(Buffer.from(file.data, "base64")), decipher.final()]).toString("utf8");
}

function deriveCredentialKey(io: ProgramIO, salt: Buffer): Buffer {
  return scryptSync(io.credentialKey ?? process.env.MUSE_CREDENTIAL_KEY ?? localCredentialSecret(), salt, 32);
}

function localCredentialSecret(): string {
  return [
    "muse-cli",
    userInfo().username,
    homedir(),
    hostname()
  ].join(":");
}

function credentialPath(io: ProgramIO): string {
  return io.configDir ? path.join(io.configDir, "credentials.json") : defaultCredentialPath();
}

function configPath(io: ProgramIO): string {
  return io.configDir ? path.join(io.configDir, "config.json") : defaultConfigPath();
}

function isEncryptedCredentialFile(value: unknown): value is EncryptedCredentialFile {
  return isRecord(value)
    && value.version === 1
    && value.algorithm === "aes-256-gcm"
    && typeof value.data === "string"
    && typeof value.iv === "string"
    && typeof value.salt === "string"
    && typeof value.tag === "string";
}

function isCredentialStore(value: unknown): value is CredentialStore {
  return isRecord(value)
    && isRecord(value.tokens)
    && Object.values(value.tokens).every((credential) => isRecord(credential)
      && typeof credential.token === "string"
      && typeof credential.updatedAt === "string");
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && "code" in value;
}

interface SseEvent {
  readonly data: string;
  readonly event: string;
}

async function* readSseEvents(response: Response): AsyncIterable<SseEvent> {
  let buffer = "";

  for await (const chunk of readResponseChunks(response)) {
    buffer += chunk;
    const parts = buffer.split(/\r?\n\r?\n/u);
    buffer = parts.pop() ?? "";

    for (const part of parts) {
      const event = parseSseEvent(part);
      if (event) {
        yield event;
      }
    }
  }

  const event = parseSseEvent(buffer);
  if (event) {
    yield event;
  }
}

async function* readResponseChunks(response: Response): AsyncIterable<string> {
  if (!response.body) {
    yield await response.text();
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      yield decoder.decode(value, { stream: true });
    }

    const tail = decoder.decode();
    if (tail.length > 0) {
      yield tail;
    }
  } finally {
    reader.releaseLock();
  }
}

function parseSseEvent(value: string): SseEvent | undefined {
  if (value.trim().length === 0) {
    return undefined;
  }

  let event = "message";
  const data: string[] = [];

  for (const line of value.split(/\r?\n/u)) {
    if (line.startsWith("event:")) {
      event = readSseField(line);
      continue;
    }

    if (line.startsWith("data:")) {
      data.push(readSseField(line));
    }
  }

  return {
    data: data.join("\n"),
    event
  };
}

function readSseField(line: string): string {
  const value = line.slice(line.indexOf(":") + 1);
  return value.startsWith(" ") ? value.slice(1) : value;
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

interface RunLogInput {
  readonly apiUrl?: string;
  readonly message: string;
  readonly model?: string;
  readonly response: unknown;
  readonly source?: "cli.local" | "cli.remote" | "cli.remote.stream";
}

export async function writeRunLog(workspaceDir: string, input: RunLogInput, now = new Date()): Promise<string> {
  const runDir = path.join(workspaceDir, ".muse", "runs");
  const runId = readResponseRunId(input.response) ?? `cli-${now.getTime()}`;
  const filePath = path.join(runDir, `${runId}.jsonl`);
  const event = {
    apiUrl: input.apiUrl ?? process.env.MUSE_API_URL ?? "http://127.0.0.1:3000",
    message: input.message,
    model: input.model ?? null,
    recordedAt: now.toISOString(),
    response: input.response,
    source: input.source ?? "cli.remote",
    type: "chat.completed"
  };

  await mkdir(runDir, { recursive: true });
  await writeFile(filePath, `${JSON.stringify(event)}\n`, { flag: "a" });
  return filePath;
}

function readResponseRunId(value: unknown): string | undefined {
  if (isRecord(value) && typeof value.runId === "string" && value.runId.trim().length > 0) {
    return value.runId;
  }

  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
