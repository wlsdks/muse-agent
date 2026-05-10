import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { hostname, homedir, userInfo } from "node:os";
import path from "node:path";
import type { AgentRuntime } from "@muse/agent-core";
import { createMuseRuntimeAssembly } from "@muse/autoconfigure";
import { isCancel, password, text } from "@clack/prompts";
import { Command } from "commander";
import { renderMuseStatusTui, type MuseStatusTuiModel } from "./tui.js";
import { registerAuthCommands } from "./commands-auth.js";
import { registerConfigCommands } from "./commands-config.js";
import { registerMcpCommands } from "./commands-mcp.js";
import { registerOrchestrateCommands } from "./commands-orchestrate.js";
import { registerCalendarCommands } from "./commands-calendar.js";
import { registerMemoryCommands } from "./commands-memory.js";
import { registerSchedulerCommands, registerSetupCommands } from "./commands-scheduler-setup.js";
import { registerSpecsCommands } from "./commands-specs.js";
import { registerVoiceCommands } from "./commands-voice.js";

export interface CliPromptAdapter {
  text(options: { readonly message: string; readonly placeholder?: string }): Promise<string>;
  password(options: { readonly message: string }): Promise<string>;
}

export interface ProgramIO {
  readonly fetch?: typeof globalThis.fetch;
  readonly stdout: (message: string) => void;
  readonly stderr: (message: string) => void;
  readonly prompts?: CliPromptAdapter;
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
      io.stdout(`${configPath(io)}\n`);
    });

  registerConfigCommands(program, io, { readConfigStore, setConfigValue, writeConfigStore, writeOutput });

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
      const [cliConfig, token] = await Promise.all([
        readConfigStore(io),
        readStoredToken(io, baseUrl)
      ]);
      await (io.renderTui ?? renderMuseStatusTui)({
        apiUrl: baseUrl,
        auth: { hasToken: Boolean(token) },
        chat: {
          defaultModel: cliConfig.defaultModel,
          submit: createTuiChatSubmitter(io, command, {
            local: options.local === true,
            model: cliConfig.defaultModel
          })
        },
        configPath: configPath(io),
        credentialPath: credentialPath(io),
        mode: options.local ? "local" : "remote",
        workspaceRunsPath: path.join(io.workspaceDir ?? process.cwd(), ".muse", "runs")
      });
    });

  program
    .command("chat")
    .description("Run a chat request through the Muse API")
    .argument("[message...]", "User message")
    .option("--local", "Run through the local shared agent runtime instead of the API")
    .option("--model <model>", "Model name")
    .option("--mode <mode>", "Agent mode: 'react' (default) or 'plan_execute'")
    .option("--stream", "Stream remote chat over SSE")
    .option("--json", "Print machine-readable JSON")
    .option("--no-log", "Do not write .muse/runs JSONL state")
    .action(async (
      messageParts: readonly string[],
      options: {
        readonly json?: boolean;
        readonly local?: boolean;
        readonly log?: boolean;
        readonly mode?: string;
        readonly model?: string;
        readonly stream?: boolean;
      },
      command
    ) => {
      const message = await resolveChatMessage(io, messageParts);
      const cliConfig = await readConfigStore(io);
      const model = options.model ?? cliConfig.defaultModel;
      const agentMode = parseAgentMode(options.mode);
      if (options.local && options.stream) {
        throw new Error("--stream requires remote API chat; omit --local");
      }

      const body = options.local
        ? await runLocalChat(io, message, model, agentMode)
        : options.stream
          ? await streamRemoteChat(io, command, message, model, options.json === true, agentMode)
        : await apiRequest(io, command, "/api/chat", {
          message,
          model,
          ...(agentMode ? { metadata: { agentMode } } : {})
        });

      if (options.log !== false) {
        const apiOptions = await readApiOptions(io, command, { includeStoredToken: false });
        await writeRunLog(io.workspaceDir ?? process.cwd(), {
          apiUrl: apiOptions.baseUrl,
          message,
          model,
          response: body,
          source: options.local ? "cli.local" : options.stream ? "cli.remote.stream" : "cli.remote"
        });
      }

      if (!options.stream || options.json) {
        writeOutput(io, body, options.json ? undefined : "response");
      }
    });

  registerAuthCommands(program, io, {
    credentialPath,
    deleteStoredToken,
    readApiOptions,
    readStoredToken,
    resolveAuthToken,
    writeOutput,
    writeStoredToken
  });

  registerMcpCommands(program, io, { apiRequest, writeOutput });

  registerSpecsCommands(program, io, { apiRequest, writeOutput });

  registerOrchestrateCommands(program, io, { apiRequest, writeOutput });

  program
    .command("runtime")
    .description("GET /api/muse/runtime — capabilities, locales, tool risk counts, default model")
    .action(async (_options, command) => {
      writeOutput(io, await apiRequest(io, command, "/api/muse/runtime"));
    });

  program
    .command("loopback")
    .description("GET /api/muse/loopback — catalog of all loopback MCP servers Muse can plug in")
    .action(async (_options, command) => {
      writeOutput(io, await apiRequest(io, command, "/api/muse/loopback"));
    });

  program
    .command("snapshot")
    .description("GET /api/admin/muse/snapshot — latency, token cost, SLO, drift, cost, budgets, follow-ups (admin)")
    .action(async (_options, command) => {
      writeOutput(io, await apiRequest(io, command, "/api/admin/muse/snapshot"));
    });

  registerCalendarCommands(program, io, { apiRequest, writeOutput });
  registerMemoryCommands(program, io, { apiRequest, writeOutput });
  registerSchedulerCommands(program, io, { apiRequest, writeOutput });
  registerSetupCommands(program, io);
  registerVoiceCommands(program, io, { apiRequest, readApiOptions, writeOutput });

  return program;
}

async function resolveChatMessage(io: ProgramIO, messageParts: readonly string[]): Promise<string> {
  const message = messageParts.join(" ").trim();

  if (message.length > 0) {
    return message;
  }

  return promptText(io, {
    message: "What would you like to ask Muse?",
    placeholder: "Compare these options..."
  });
}

async function resolveAuthToken(io: ProgramIO, token: string | undefined): Promise<string> {
  const trimmed = token?.trim();

  if (trimmed) {
    return trimmed;
  }

  return promptPassword(io, { message: "Muse API token" });
}

async function promptText(
  io: ProgramIO,
  options: { readonly message: string; readonly placeholder?: string }
): Promise<string> {
  const value = io.prompts
    ? await io.prompts.text(options)
    : await text(options);

  return readPromptValue(value, "Prompt was cancelled");
}

async function promptPassword(io: ProgramIO, options: { readonly message: string }): Promise<string> {
  const value = io.prompts
    ? await io.prompts.password(options)
    : await password(options);

  return readPromptValue(value, "Authentication was cancelled");
}

function readPromptValue(value: unknown, cancelMessage: string): string {
  if (isCancel(value)) {
    throw new Error(cancelMessage);
  }

  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error("Interactive input must not be empty");
  }

  return value.trim();
}

async function apiRequest(
  io: ProgramIO,
  command: Command,
  path: string,
  body?: Record<string, unknown>,
  method?: "GET" | "POST" | "PUT" | "DELETE"
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
  jsonMode: boolean,
  agentMode: AgentMode | undefined
) {
  const { baseUrl, token } = await readApiOptions(io, command);
  const response = await (io.fetch ?? globalThis.fetch)(new URL("/api/chat/stream", baseUrl).toString(), {
    body: JSON.stringify(dropUndefined({
      message,
      model,
      ...(agentMode ? { metadata: { agentMode } } : {})
    })),
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

function createTuiChatSubmitter(
  io: ProgramIO,
  command: Command,
  options: { readonly local: boolean; readonly model?: string }
): (message: string) => Promise<string> {
  return async (message: string) => {
    const body = options.local
      ? await runLocalChat(io, message, options.model)
      : await apiRequest(io, command, "/api/chat", {
        message,
        model: options.model
      });
    const apiOptions = await readApiOptions(io, command, { includeStoredToken: false });

    await writeRunLog(io.workspaceDir ?? process.cwd(), {
      apiUrl: apiOptions.baseUrl,
      message,
      model: options.model,
      response: body,
      source: options.local ? "cli.local" : "cli.remote"
    });

    return readChatResponseText(body);
  };
}

async function runLocalChat(io: ProgramIO, message: string, model: string | undefined, agentMode?: AgentMode) {
  const assembly = io.createRuntimeAssembly?.() ?? createMuseRuntimeAssembly();

  if (!assembly.agentRuntime || !(model ?? assembly.defaultModel)) {
    throw new Error("Local chat requires MUSE_MODEL and a configured model provider");
  }

  const result = await assembly.agentRuntime.run({
    messages: [{ content: message, role: "user" }],
    ...(agentMode ? { metadata: { agentMode } } : {}),
    model: model ?? assembly.defaultModel ?? "default"
  });

  return {
    response: result.response.output,
    runId: result.runId,
    toolsUsed: result.toolsUsed ?? []
  };
}

type AgentMode = "react" | "plan_execute";

function parseAgentMode(value: string | undefined): AgentMode | undefined {
  if (value === undefined) {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === "react" || normalized === "plan_execute") {
    return normalized;
  }
  throw new Error(`--mode must be 'react' or 'plan_execute' (got '${value}')`);
}

function readChatResponseText(value: unknown): string {
  if (isRecord(value) && typeof value.response === "string") {
    return value.response;
  }

  if (isRecord(value) && typeof value.content === "string") {
    return value.content;
  }

  return JSON.stringify(value);
}

interface ApiOptions {
  readonly baseUrl: string;
  readonly token?: string;
}

interface MuseCliConfig {
  readonly apiUrl?: string;
  readonly defaultModel?: string;
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
  const config = await readConfigStore(io);
  const baseUrl = globalOptions.apiUrl ?? process.env.MUSE_API_URL ?? config.apiUrl ?? "http://127.0.0.1:3000";
  const explicitToken = globalOptions.token ?? process.env.MUSE_API_TOKEN;

  return {
    baseUrl,
    token: explicitToken ?? (readOptions.includeStoredToken === false ? undefined : await readStoredToken(io, baseUrl))
  };
}

async function readConfigStore(io: ProgramIO): Promise<MuseCliConfig> {
  try {
    const raw = await readFile(configPath(io), "utf8");
    const parsed = JSON.parse(raw) as unknown;

    if (!isRecord(parsed)) {
      throw new Error("Invalid Muse config format");
    }

    return {
      ...(typeof parsed.apiUrl === "string" && parsed.apiUrl.trim().length > 0 ? { apiUrl: parsed.apiUrl } : {}),
      ...(typeof parsed.defaultModel === "string" && parsed.defaultModel.trim().length > 0
        ? { defaultModel: parsed.defaultModel }
        : {})
    };
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return {};
    }

    throw error;
  }
}

async function writeConfigStore(io: ProgramIO, config: MuseCliConfig): Promise<void> {
  const filePath = configPath(io);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await chmod(filePath, 0o600);
}

function setConfigValue(config: MuseCliConfig, key: string, value: string): MuseCliConfig {
  const trimmed = value.trim();

  if (trimmed.length === 0) {
    throw new Error("Config value must not be empty");
  }

  if (key === "apiUrl") {
    return { ...config, apiUrl: trimmed };
  }

  if (key === "defaultModel") {
    return { ...config, defaultModel: trimmed };
  }

  throw new Error(`Unsupported config key: ${key}`);
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
