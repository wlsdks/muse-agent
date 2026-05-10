import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AgentRuntime } from "@muse/agent-core";
import { createMuseRuntimeAssembly } from "@muse/autoconfigure";
import { isCancel, password, text } from "@clack/prompts";
import { Command } from "commander";
import {
  credentialPath,
  deleteStoredToken,
  isRecord,
  readStoredToken,
  writeStoredToken
} from "./credential-store.js";

// Re-exported for the test in `apps/cli/test/program.test.ts:5,26`
// which imports `defaultCredentialPath` from `program.js`.
export { defaultCredentialPath } from "./credential-store.js";
import { renderMuseStatusTui, type MuseStatusTuiModel } from "./tui.js";
import { registerAuthCommands } from "./commands-auth.js";
import { registerConfigCommands } from "./commands-config.js";
import { registerListenCommand } from "./commands-listen.js";
import { registerMcpCommands } from "./commands-mcp.js";
import { registerOrchestrateCommands } from "./commands-orchestrate.js";
import { registerCalendarCommands } from "./commands-calendar.js";
import { registerMemoryCommands } from "./commands-memory.js";
import { registerMessagingCommands } from "./commands-messaging.js";
import { registerRemindCommands } from "./commands-remind.js";
import { registerNotesCommands } from "./commands-notes.js";
import { registerSchedulerCommands, registerSetupCommands } from "./commands-scheduler-setup.js";
import { registerSpecsCommands } from "./commands-specs.js";
import { registerTasksCommands } from "./commands-tasks.js";
import { registerTodayCommands, type TodayCommandShells } from "./commands-today.js";
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
  /**
   * Optional TTS + speaker shells used by `today --brief --speak`.
   * Tests inject fakes; production calls fall through to the
   * configured voice registry + afplay/aplay.
   */
  readonly todayShells?: TodayCommandShells;
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
      io.stdout(`${configPath(io)}\n`);
    });

  registerConfigCommands(program, io, { readConfigStore, setConfigValue, writeConfigStore, writeOutput });

  program
    .command("spec")
    .description("Print the fixed runtime stack")
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

  registerListenCommand(program, io, { apiRequest });
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
  registerMessagingCommands(program, io, { apiRequest, writeOutput });
  registerRemindCommands(program, io, { apiRequest, writeOutput });
  registerNotesCommands(program, io, { apiRequest, writeOutput });
  registerSchedulerCommands(program, io, { apiRequest, writeOutput });
  registerSetupCommands(program, io);
  registerTasksCommands(program, io, { apiRequest, writeOutput });
  registerTodayCommands(program, io, {
    apiRequest,
    writeOutput,
    ...(io.todayShells ? { shells: io.todayShells } : {})
  });
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
  let response: Response;
  try {
    response = await (io.fetch ?? globalThis.fetch)(new URL(path, baseUrl).toString(), {
      body: body ? JSON.stringify(dropUndefined(body)) : undefined,
      headers: {
        ...(body ? { "content-type": "application/json" } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {})
      },
      method: method ?? (body ? "POST" : "GET")
    });
  } catch (error) {
    throw friendlyFetchError(baseUrl, error);
  }
  const text = await response.text();

  if (!response.ok) {
    throw new Error(`Muse API ${response.status}: ${text || response.statusText}`);
  }

  return text.length > 0 ? JSON.parse(text) as unknown : undefined;
}

/**
 * Translate node-fetch / undici network errors into a single-line message
 * the user can act on. Without this, `ECONNREFUSED` surfaces as a raw
 * undici stack trace whenever the API server isn't running — which for a
 * personal-mode CLI is the most common state.
 */
function friendlyFetchError(baseUrl: string, error: unknown): Error {
  const cause = isRecord(error) && isRecord(error.cause) ? error.cause : undefined;
  const code = cause && typeof cause.code === "string" ? cause.code : undefined;
  if (code === "ECONNREFUSED") {
    return new Error(
      `Muse API not reachable at ${baseUrl} — start it with \`pnpm --filter @muse/api dev\` or set --api-url.`
    );
  }
  if (code === "ENOTFOUND") {
    return new Error(`Muse API host unresolved (${baseUrl}). Check --api-url.`);
  }
  const message = error instanceof Error ? error.message : String(error);
  return new Error(`Muse API request failed: ${message}`);
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

// Encrypted credential storage lives in `./credential-store.ts`.
// `readStoredToken` / `writeStoredToken` / `deleteStoredToken` /
// `credentialPath` are imported from there; the AES-256-GCM cipher
// + scrypt key derivation + on-disk JSON shape are co-located in
// that module. Re-imported here so `readApiOptions` (and the
// auth-command DI shape) can keep using the same names.

function configPath(io: ProgramIO): string {
  return io.configDir ? path.join(io.configDir, "config.json") : defaultConfigPath();
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

