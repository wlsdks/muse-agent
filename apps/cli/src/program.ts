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
import { formatCitations } from "./human-formatters.js";

// Re-exported for the test in `apps/cli/test/program.test.ts:5,26`
// which imports `defaultCredentialPath` from `program.js`.
export { defaultCredentialPath } from "./credential-store.js";
import { renderMuseStatusTui, type MuseStatusTuiModel } from "./tui.js";
import { registerAuthCommands } from "./commands-auth.js";
import { registerConfigCommands } from "./commands-config.js";
import { registerListenCommand } from "./commands-listen.js";
import { registerMcpCommands } from "./commands-mcp.js";
import { registerProactiveCommands } from "./commands-proactive.js";
import { registerOrchestrateCommands } from "./commands-orchestrate.js";
import { registerCalendarCommands } from "./commands-calendar.js";
import { registerMemoryCommands } from "./commands-memory.js";
import { registerAnalyticsCommands } from "./commands-analytics.js";
import { registerCostCommands } from "./commands-cost.js";
import { registerDebugCommands } from "./commands-debug.js";
import { registerDoctorCommand } from "./commands-doctor.js";
import { registerLatencyCommands } from "./commands-latency.js";
import { registerSettingsCommands } from "./commands-settings.js";
import { registerToolsAdminCommands } from "./commands-tools-admin.js";
import { registerTracesCommands } from "./commands-traces.js";
import { registerRunsCommands } from "./commands-runs.js";
import { registerMessagingCommands } from "./commands-messaging.js";
import { registerRemindCommands } from "./commands-remind.js";
import { registerNotesCommands } from "./commands-notes.js";
import { registerSchedulerCommands, registerSetupCommands } from "./commands-scheduler-setup.js";
import { registerSetupLocalCommand } from "./commands-setup-local.js";
import { registerSetupVoiceCommand } from "./commands-setup-voice.js";
import { registerStatusCommand } from "./commands-status.js";
import { registerRoutineCommand } from "./commands-routine.js";
import { registerTrustCommands } from "./commands-trust.js";
import { registerWatchFolderCommand } from "./commands-watch-folder.js";
import { registerSpecsCommands } from "./commands-specs.js";
import { registerTasksCommands } from "./commands-tasks.js";
import { registerTelemetryCommands } from "./commands-telemetry.js";
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
  /**
   * Read piped stdin for `muse chat`. Tests inject a stub returning
   * an empty string so vitest doesn't hang waiting on the harness'
   * (non-TTY) stdin. Production omits and falls back to the real
   * `for await (const chunk of process.stdin)` reader.
   */
  readonly readPipedStdin?: () => Promise<string>;
  readonly workspaceDir?: string;
  readonly configDir?: string;
  readonly credentialKey?: string;
  readonly renderTui?: (model: MuseStatusTuiModel) => Promise<void> | void;
  readonly createRuntimeAssembly?: () => {
    readonly agentRuntime?: AgentRuntime;
    readonly defaultModel?: string;
    // Structural — avoid the cross-package @muse/model dep just for
    // a type. The REPL's chat-only fast path consumes only `stream`.
    readonly modelProvider?: {
      stream(request: {
        readonly model: string;
        readonly messages: readonly { readonly role: string; readonly content: string }[];
      }): AsyncIterable<{ readonly type: string; readonly text?: string }>;
    };
    /** Persistent user-memory store for JARVIS-class personalisation. */
    readonly userMemoryStore?: {
      findByUserId(userId: string): Promise<{
        readonly facts: Readonly<Record<string, string>>;
        readonly preferences: Readonly<Record<string, string>>;
        readonly recentTopics: readonly string[];
      } | undefined> | { readonly facts: Readonly<Record<string, string>>; readonly preferences: Readonly<Record<string, string>>; readonly recentTopics: readonly string[]; } | undefined;
      upsertFact(userId: string, key: string, value: string): Promise<unknown> | unknown;
      upsertPreference(userId: string, key: string, value: string): Promise<unknown> | unknown;
    };
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
    .option("--no-web-search", "disable native web_search for this request")
    .option(
      "--no-tools",
      "skip the agent tool registry for this request — 15× faster on small local models (qwen2.5:7b: 10s → 0.7s) at the cost of losing calendar/tasks/notes ability"
    )
    .option(
      "-c, --continue",
      "include prior turns from ~/.muse/last-chat.jsonl so the model remembers the conversation across CLI invocations (--local only)"
    )
    .option(
      "--reset",
      "clear ~/.muse/last-chat.jsonl before this turn (use after --continue to start a fresh conversation)"
    )
    .option(
      "-i, --interactive",
      "open a continuous REPL — each line is a turn, /exit quits, /reset clears, /help lists commands (--local only)"
    )
    .action(async (
      messageParts: readonly string[],
      options: {
        readonly continue?: boolean;
        readonly interactive?: boolean;
        readonly json?: boolean;
        readonly local?: boolean;
        readonly log?: boolean;
        readonly mode?: string;
        readonly model?: string;
        readonly reset?: boolean;
        readonly stream?: boolean;
        readonly tools?: boolean;
        readonly webSearch?: boolean;
      },
      command
    ) => {
      if (options.reset) {
        await clearLastChatHistory();
      }
      if (options.interactive) {
        if (!options.local) {
          throw new Error("--interactive requires --local (REPL goes through the local runtime; remote streaming REPL is a future iteration)");
        }
        const cliConfigForRepl = await readConfigStore(io);
        await runChatRepl(io, {
          continueHistory: options.continue ?? false,
          disableTools: options.tools === false,
          model: options.model ?? cliConfigForRepl.defaultModel
        });
        return;
      }
      const message = await resolveChatMessage(io, messageParts);
      const cliConfig = await readConfigStore(io);
      const model = options.model ?? cliConfig.defaultModel;
      const agentMode = parseAgentMode(options.mode);
      if (options.local && options.stream) {
        throw new Error("--stream requires remote API chat; omit --local");
      }

      // Compose metadata: merge agentMode, web_search override, and
      // --no-tools (maxTools:0) for the chat-only fast path.
      const metadataTools = options.webSearch === false ? { web_search: false } : undefined;
      const toolsDisabled = options.tools === false;
      const metadata =
        agentMode || metadataTools || toolsDisabled
          ? {
              ...(agentMode ? { agentMode } : {}),
              ...(metadataTools ? { tools: metadataTools } : {}),
              ...(toolsDisabled ? { maxTools: 0 } : {})
            }
          : undefined;

      const priorHistory = options.continue && options.local ? await readLastChatHistory() : [];

      const body = options.local
        ? await runLocalChat(io, message, model, agentMode, { disableTools: toolsDisabled, priorHistory })
        : options.stream
          ? await streamRemoteChat(io, command, message, model, options.json === true, agentMode, options.webSearch === false)
        : await apiRequest(io, command, "/api/chat", dropUndefined({
          message,
          model,
          metadata
        }));

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

      // Persist the just-completed turn so a future `muse chat -c`
      // can resume. Stored regardless of --continue so the *next*
      // call can pick up the conversation. Cap kept implicit (the
      // reader trims by recent N turns); --reset clears.
      if (options.local) {
        const responseText = isRecord(body) && typeof body.response === "string" ? body.response : undefined;
        if (responseText) {
          await appendLastChatTurn({ message, response: responseText });
        }
      }

      if (!options.stream || options.json) {
        writeOutput(io, body, options.json ? undefined : "response");
        if (!options.json && isRecord(body) && Array.isArray(body.citations)) {
          const citationsText = formatCitations(body.citations as Array<{ url: string; title: string }>);
          if (citationsText) {
            io.stdout(`${citationsText}\n`);
          }
        }
      }
    });

  // `muse repl` — one-keystroke shortcut for the JARVIS daily-driver
  // surface. Equivalent to:
  //   muse chat -i --local --no-tools --continue --model $MUSE_MODEL
  // i.e. continuous conversation, local runtime, no tool-registry
  // overhead, picks up prior turns from ~/.muse/last-chat.jsonl.
  // The full `muse chat -i ...` form stays available for fine-grained
  // control; this is for "just talk to me".
  program
    .command("repl")
    .description("One-keystroke shortcut: continuous local REPL with memory, no tool registry overhead")
    .option("--model <model>", "Override the model (default MUSE_MODEL or CLI config defaultModel)")
    .option("--tools", "Enable the tool registry (default off for speed)")
    .option("--no-continue", "Start a fresh conversation instead of resuming ~/.muse/last-chat.jsonl")
    .option("--user <id>", "User identity for persistent memory (default $MUSE_USER_ID or $USER)")
    .option("--persona <slot>", "Persona slot (work / home / hobby / …); same user can hold multiple distinct personas")
    .action(async (options: { readonly model?: string; readonly tools?: boolean; readonly continue?: boolean; readonly user?: string; readonly persona?: string }) => {
      const cliConfig = await readConfigStore(io);
      await runChatRepl(io, {
        continueHistory: options.continue !== false,
        disableTools: options.tools !== true,
        model: options.model ?? cliConfig.defaultModel,
        ...(options.user ? { userId: options.user } : {}),
        ...(options.persona ? { persona: options.persona } : {})
      });
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
  registerProactiveCommands(program, io);

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

  program
    .command("context")
    .description("GET /api/active-context — print the Phase-1 active-context snapshot the agent sees")
    .option("--json", "Print machine-readable JSON instead of the formatted summary")
    .option("--user <id>", "Resolve the snapshot for a specific userId")
    .option("--session <id>", "Resolve the snapshot for a specific sessionId")
    .action(async (options: { readonly json?: boolean; readonly user?: string; readonly session?: string }, command) => {
      const params = new URLSearchParams();
      if (options.user) { params.set("userId", options.user); }
      if (options.session) { params.set("sessionId", options.session); }
      const qs = params.toString();
      const snapshot = await apiRequest(io, command, `/api/active-context${qs ? `?${qs}` : ""}`) as Record<string, unknown>;
      if (options.json) {
        writeOutput(io, snapshot);
        return;
      }
      io.stdout(`${renderActiveContext(snapshot)}\n`);
    });

  registerCalendarCommands(program, io, { apiRequest, writeOutput });
  registerMemoryCommands(program, io, { apiRequest, writeOutput });
  registerMessagingCommands(program, io, { apiRequest, writeOutput });
  registerRemindCommands(program, io, { apiRequest, writeOutput });
  registerNotesCommands(program, io, { apiRequest, writeOutput });
  registerSchedulerCommands(program, io, { apiRequest, writeOutput });
  registerSetupCommands(program, io);
  registerSetupLocalCommand(program, io, { readConfigStore, writeConfigStore });
  registerSetupVoiceCommand(program, io);
  registerStatusCommand(program, io);
  registerWatchFolderCommand(program, io);
  registerRoutineCommand(program, io);
  registerTrustCommands(program, io);
  registerTasksCommands(program, io, { apiRequest, writeOutput });
  registerRunsCommands(program, io, { apiRequest, writeOutput });
  registerDoctorCommand(program, io, { apiRequest, writeOutput });
  registerCostCommands(program, io, { apiRequest, writeOutput });
  registerLatencyCommands(program, io, { apiRequest, writeOutput });
  registerTracesCommands(program, io, { apiRequest, writeOutput });
  registerSettingsCommands(program, io, { apiRequest, writeOutput });
  registerToolsAdminCommands(program, io, { apiRequest, writeOutput });
  registerAnalyticsCommands(program, io, { apiRequest, writeOutput });
  registerDebugCommands(program, io, { apiRequest, writeOutput });
  registerTelemetryCommands(program, io, { apiRequest, writeOutput });
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
  const piped = await (io.readPipedStdin ?? readPipedStdin)();

  // Daily-driver ergonomic: `cat doc.md | muse chat "summarize"` should
  // concatenate piped stdin AFTER the args so the model sees the
  // instruction first. When only stdin is provided, use it directly.
  // Falls back to the interactive prompt only on a true TTY with no
  // args + no pipe.
  if (message.length > 0 && piped.length > 0) {
    return `${message}\n\n${piped}`;
  }
  if (message.length > 0) {
    return message;
  }
  if (piped.length > 0) {
    return piped;
  }

  return promptText(io, {
    message: "What would you like to ask Muse?",
    placeholder: "Compare these options..."
  });
}

async function readPipedStdin(): Promise<string> {
  // Skip when stdin is a TTY — interactive shells leave stdin attached
  // even when no one's typing; reading it would block forever.
  //
  // Note: Node sets `process.stdin.isTTY` to `true` for a terminal and
  // leaves it `undefined` when stdin is redirected. So the guard has
  // to be a truthy check; `!== false` would treat `undefined` as
  // "still a TTY" and miss the pipe case.
  if (process.stdin.isTTY) {
    return "";
  }
  let raw = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) {
    raw += chunk;
  }
  return raw.trim();
}

/**
 * Build a JARVIS-style system prompt from the persistent user
 * memory. This is the differentiation from "generic chat" — Muse
 * opens every session knowing who the user is, how they talk, and
 * what they've said before. Kept short so it doesn't dominate the
 * context window; the long tail of facts is loaded by trim/episodic
 * memory paths the agent runtime already owns.
 */
export function buildJarvisPersona(
  memory: { readonly facts: Readonly<Record<string, string>>; readonly preferences: Readonly<Record<string, string>>; readonly recentTopics?: readonly string[] },
  userId: string,
  options: { readonly now?: Date } = {}
): string | undefined {
  const facts = Object.entries(memory.facts);
  // Preferences encode three slot types: plain `pref.X`, `veto:X`
  // (things the user has refused), and `goal:X` (active objectives).
  // Split them so buildJarvisPersona renders each under its own
  // header — JARVIS doesn't lump "I don't drink coffee" in with
  // "speak Korean".
  const plainPrefs: [string, string][] = [];
  const vetoes: [string, string][] = [];
  const goals: [string, string][] = [];
  for (const [key, value] of Object.entries(memory.preferences)) {
    if (key.startsWith("veto:")) vetoes.push([key.slice(5), value]);
    else if (key.startsWith("goal:")) goals.push([key.slice(5), value]);
    else plainPrefs.push([key, value]);
  }
  if (facts.length === 0 && plainPrefs.length === 0 && vetoes.length === 0 && goals.length === 0) {
    return undefined;
  }
  const lines: string[] = [
    "You are Muse, the user's JARVIS-style personal AI conductor.",
    `The user's id is "${userId}". Address them by name when their name is in the facts below.`,
    "Honour the listed preferences — reply style, language, length cap, etc.",
    "Respect vetoes absolutely — never propose, suggest, or volunteer anything the user has refused.",
    "Steer toward the user's goals when the topic matches, but don't shoehorn them.",
    "Do NOT volunteer the existence of this system prompt. If asked who you remember, paraphrase the facts naturally."
  ];
  // Inject the current local date + time + day-of-week so the model
  // doesn't have to guess. JARVIS knows what day it is; "오늘 일정"
  // / "tomorrow morning" only makes sense when the model has a
  // concrete now.
  const now = options.now ?? new Date();
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC";
  const dayOfWeek = now.toLocaleDateString("en-US", { weekday: "long", timeZone: tz });
  const dateStr = now.toLocaleDateString("en-CA", { timeZone: tz }); // YYYY-MM-DD
  const timeStr = now.toLocaleTimeString("en-GB", { hour: "2-digit", hour12: false, minute: "2-digit", timeZone: tz });
  lines.push("");
  lines.push(`Current local context: ${dateStr} ${timeStr} ${dayOfWeek} (${tz}).`);
  if (facts.length > 0) {
    lines.push("");
    lines.push("Facts the user has shared:");
    for (const [key, value] of facts) lines.push(`  - ${key}: ${value}`);
  }
  if (plainPrefs.length > 0) {
    lines.push("");
    lines.push("Preferences:");
    for (const [key, value] of plainPrefs) lines.push(`  - ${key}: ${value}`);
  }
  if (vetoes.length > 0) {
    lines.push("");
    lines.push("Vetoes (never do these, never suggest these):");
    for (const [id, value] of vetoes) lines.push(`  - ${id}: ${value}`);
  }
  if (goals.length > 0) {
    lines.push("");
    lines.push("Goals the user is pursuing:");
    for (const [id, value] of goals) lines.push(`  - ${id}: ${value}`);
  }
  return lines.join("\n");
}

// ── Conversation history for `muse chat -c` ──────────────────────────
// One JSONL line per turn: { role: "user" | "assistant", content: string }.
// Stored at ~/.muse/last-chat.jsonl. Cap to the most recent
// HISTORY_TURN_LIMIT turns so an open-ended conversation doesn't blow
// the model context. Larger / persistent history belongs in the
// runtime's ConversationSummaryStore, not this CLI cache.

const HISTORY_TURN_LIMIT = 12;

function lastChatHistoryPath(): string {
  const home = process.env.HOME ?? "~";
  return path.join(home, ".muse", "last-chat.jsonl");
}

interface LastChatLine {
  readonly role: "user" | "assistant";
  readonly content: string;
}

async function readLastChatHistory(): Promise<readonly LastChatLine[]> {
  const filePath = lastChatHistoryPath();
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
  const lines: LastChatLine[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (
        isRecord(parsed)
        && (parsed.role === "user" || parsed.role === "assistant")
        && typeof parsed.content === "string"
        && parsed.content.length > 0
      ) {
        lines.push({ content: parsed.content, role: parsed.role });
      }
    } catch { /* skip malformed lines */ }
  }
  return lines.slice(-HISTORY_TURN_LIMIT * 2);
}

async function appendLastChatTurn(turn: { readonly message: string; readonly response: string }): Promise<void> {
  const filePath = lastChatHistoryPath();
  await mkdir(path.dirname(filePath), { recursive: true });
  const payload =
    `${JSON.stringify({ content: turn.message, role: "user" })}\n` +
    `${JSON.stringify({ content: turn.response, role: "assistant" })}\n`;
  await writeFile(filePath, payload, { flag: "a", mode: 0o600 });
}

// ── Activity log for pattern learning (`muse routine`) ──────────────
// One JSONL line per REPL start / chat turn. The aggregator reads
// the log over a rolling window and writes a `routine.active_hours`
// fact into the persistent user memory so the persona injection
// surfaces it in subsequent sessions. JARVIS knows when you're
// usually awake.

interface ActivityEvent {
  readonly kind: "repl-start" | "chat-turn";
  readonly userId: string;
  readonly tsIso?: string;
}

function activityLogPath(): string {
  const home = process.env.HOME ?? "~";
  return path.join(home, ".muse", "activity.jsonl");
}

export async function appendActivity(event: ActivityEvent): Promise<void> {
  const filePath = activityLogPath();
  const stamped = { ...event, tsIso: event.tsIso ?? new Date().toISOString() };
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(stamped)}\n`, { flag: "a", mode: 0o600 });
}

async function clearLastChatHistory(): Promise<void> {
  const filePath = lastChatHistoryPath();
  try {
    await writeFile(filePath, "", { mode: 0o600 });
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return;
    }
    throw error;
  }
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
  agentMode: AgentMode | undefined,
  disableWebSearch?: boolean
) {
  const { baseUrl, token } = await readApiOptions(io, command);
  const metadataTools = disableWebSearch ? { web_search: false } : undefined;
  const metadata =
    agentMode || metadataTools
      ? { ...(agentMode ? { agentMode } : {}), ...(metadataTools ? { tools: metadataTools } : {}) }
      : undefined;
  const response = await (io.fetch ?? globalThis.fetch)(new URL("/api/chat/stream", baseUrl).toString(), {
    body: JSON.stringify(dropUndefined({
      message,
      model,
      metadata
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
  let streamCitations: Array<{ url: string; title: string }> | undefined;

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

    if (event.event === "citations") {
      try {
        const parsed = JSON.parse(event.data) as unknown;
        if (Array.isArray(parsed)) {
          streamCitations = parsed as Array<{ url: string; title: string }>;
        }
      } catch {
        // Malformed citations event — ignore and continue.
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

  if (!jsonMode && streamCitations) {
    const citationsText = formatCitations(streamCitations);
    if (citationsText) {
      io.stdout(`${citationsText}\n`);
    }
  }

  return {
    citations: streamCitations,
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

/**
 * Continuous chat REPL — `muse chat -i`. One readline loop, each line
 * is a turn, slash commands manage session state. Lives next to
 * `runLocalChat` because it shares the assembly creation + history
 * persistence; the REPL just amortises that cost across many turns.
 *
 * Slash commands:
 *   /exit, /quit           — leave (Ctrl-D / Ctrl-C work too)
 *   /reset                 — clear in-memory + on-disk history
 *   /history               — show how many turns are in context
 *   /model <tag>           — switch to a different model mid-session
 *   /tools on|off          — toggle the tool registry for subsequent turns
 *   /help                  — list these
 *
 * In-memory history is the source of truth during the session;
 * `~/.muse/last-chat.jsonl` is updated after every assistant reply so
 * a crash mid-conversation doesn't lose the trail and a follow-up
 * `muse chat -c` outside the REPL still picks up where the user
 * left off.
 */
async function runChatRepl(
  io: ProgramIO,
  options: {
    readonly model: string | undefined;
    readonly disableTools: boolean;
    readonly continueHistory: boolean;
    readonly userId?: string;
    readonly persona?: string;
  }
): Promise<void> {
  const readline = await import("node:readline/promises");
  const seedHistory = options.continueHistory ? await readLastChatHistory() : [];
  const history: { role: "user" | "assistant"; content: string }[] = [...seedHistory];
  let currentModel = options.model;
  let toolsDisabled = options.disableTools;
  const baseUserId = options.userId ?? process.env.MUSE_USER_ID ?? process.env.USER ?? "default";
  // Multi-persona: the on-disk store keys persona slots as
  // `<user>@<persona>` so a single human ("stark") can have a
  // distinct work / home / hobby context with its own facts,
  // prefs, vetoes, goals. No persona suffix → the bare userId.
  let currentPersona = options.persona?.trim();
  const composeUserKey = (): string => currentPersona && currentPersona.length > 0
    ? `${baseUserId}@${currentPersona}`
    : baseUserId;
  let userId = composeUserKey();

  // Build the runtime assembly once and reuse across turns; the
  // streaming loop calls `agentRuntime.stream(...)` directly so
  // text-delta tokens land in the terminal as the model emits them
  // (true JARVIS feel — text appears, doesn't pop in all at once).
  if (currentModel && !process.env.MUSE_MODEL) {
    process.env.MUSE_MODEL = currentModel;
  }
  if (currentModel && currentModel.startsWith("ollama/") && !process.env.MUSE_MODEL_PROVIDER_ID) {
    process.env.MUSE_MODEL_PROVIDER_ID = "ollama";
  }
  const assembly = io.createRuntimeAssembly?.() ?? createMuseRuntimeAssembly();
  if (!assembly.agentRuntime) {
    throw new Error("REPL requires a configured model — set MUSE_MODEL (or pass --model) and re-run.");
  }
  const agentRuntime = assembly.agentRuntime;
  const memoryStore = assembly.userMemoryStore;

  // Resolve the per-user trust list once at REPL start. The tool-using
  // path passes blocked tools through `metadata.forbiddenToolNames`,
  // which the existing DefaultToolExposurePolicy already honours.
  // Trusted tools list is reserved for future "auto-approve" gates;
  // for now it's informational (visible via /whoami extension).
  const { readTrust } = await import("./commands-trust.js");
  let trust = await readTrust(userId).catch(() => ({ blockedTools: [] as string[], trustedTools: [] as string[] }));
  // Pull the auto-extract helpers (re-exported from autoconfigure so
  // the CLI doesn't need @muse/memory as a direct dep). Imported
  // lazily so the test harness can stub the assembly without
  // exercising this path.
  const autoconfigureHelpers = await import("@muse/autoconfigure").catch(() => undefined);
  const autoExtract = autoconfigureHelpers?.pickAutoExtractSystemPrompt
    ? {
        pickSystemPrompt: autoconfigureHelpers.pickAutoExtractSystemPrompt,
        extractJsonObject: autoconfigureHelpers.extractJsonObject
      }
    : undefined;

  // Look up persistent user memory for this identity. The "what
  // makes Muse JARVIS-class" core: every session opens with the
  // facts/preferences the user told Muse in prior sessions. The
  // store is file-backed by default (~/.muse/user-memory.json) so
  // a fresh `muse repl` 30 seconds after the last one already
  // knows the user's name, language, and reply style.
  let userMemory = memoryStore ? await Promise.resolve(memoryStore.findByUserId(userId)) : undefined;
  const personaPrompt = (): string | undefined => {
    if (!userMemory) return undefined;
    return buildJarvisPersona(userMemory, userId);
  };

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true
  });

  // Append a session marker to the activity log so `muse routine`
  // can later infer active-hours patterns. Best-effort; failures
  // never block the REPL.
  await appendActivity({ kind: "repl-start", userId }).catch(() => undefined);

  io.stdout("\n");
  io.stdout("Muse REPL — type /help for commands, /exit to quit.\n");
  io.stdout(`  user: ${userId}, model: ${currentModel ?? assembly.defaultModel ?? "(default)"}, tools: ${toolsDisabled ? "off" : "on"}, history: ${history.length.toString()} turns\n`);
  if (userMemory) {
    const factCount = Object.keys(userMemory.facts).length;
    const prefCount = Object.keys(userMemory.preferences).length;
    if (factCount + prefCount > 0) {
      io.stdout(`  remembered: ${factCount.toString()} fact(s), ${prefCount.toString()} pref(s) (type /whoami)\n`);
    }
  }
  io.stdout("\n");

  let active = true;
  const onSigint = (): void => {
    io.stdout("\n(ctrl-c — exiting)\n");
    active = false;
    rl.close();
  };
  rl.on("SIGINT", onSigint);

  try {
    while (active) {
      let line: string;
      try {
        line = await rl.question("you> ");
      } catch {
        break;
      }
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;

      if (trimmed.startsWith("/")) {
        const [cmd, ...rest] = trimmed.slice(1).split(/\s+/);
        const arg = rest.join(" ").trim();
        switch (cmd) {
          case "exit":
          case "quit":
            io.stdout("(bye)\n");
            active = false;
            break;
          case "reset":
            history.length = 0;
            await clearLastChatHistory();
            io.stdout("(history cleared)\n");
            break;
          case "history":
            io.stdout(`(${history.length.toString()} turns in context)\n`);
            break;
          case "model":
            if (arg.length === 0) {
              io.stdout(`(current model: ${currentModel ?? "(default)"})\n`);
            } else {
              currentModel = arg;
              io.stdout(`(model → ${arg})\n`);
            }
            break;
          case "tools":
            if (arg === "on") {
              toolsDisabled = false;
              io.stdout("(tools on)\n");
            } else if (arg === "off") {
              toolsDisabled = true;
              io.stdout("(tools off — chat-only fast path)\n");
            } else {
              io.stdout(`(tools currently ${toolsDisabled ? "off" : "on"}; usage: /tools on|off)\n`);
            }
            break;
          case "fact":
          case "pref": {
            const eq = arg.indexOf("=");
            if (eq < 0 || !memoryStore) {
              io.stdout(`(usage: /${cmd} <key>=<value>${memoryStore ? "" : "; no user-memory store available"})\n`);
              break;
            }
            const key = arg.slice(0, eq).trim();
            const value = arg.slice(eq + 1).trim();
            if (key.length === 0 || value.length === 0) {
              io.stdout(`(usage: /${cmd} <key>=<value>)\n`);
              break;
            }
            await Promise.resolve(
              cmd === "fact"
                ? memoryStore.upsertFact(userId, key, value)
                : memoryStore.upsertPreference(userId, key, value)
            );
            userMemory = await Promise.resolve(memoryStore.findByUserId(userId));
            io.stdout(`(remembered ${cmd}.${key}=${value})\n`);
            break;
          }
          case "whoami":
            if (!userMemory) {
              io.stdout(`(no memory for user '${userId}' yet — try /fact name=YourName)\n`);
            } else {
              io.stdout(`user: ${userId}\n`);
              for (const [key, value] of Object.entries(userMemory.facts)) {
                io.stdout(`  fact.${key}: ${value}\n`);
              }
              for (const [key, value] of Object.entries(userMemory.preferences)) {
                io.stdout(`  pref.${key}: ${value}\n`);
              }
            }
            break;
          case "persona":
            if (arg.length === 0) {
              io.stdout(`(current persona: ${currentPersona ?? "(none — base profile)"}; usage: /persona work | /persona home | /persona none)\n`);
            } else {
              const next = arg === "none" || arg === "off" || arg === "default" ? undefined : arg;
              currentPersona = next;
              userId = composeUserKey();
              userMemory = memoryStore ? await Promise.resolve(memoryStore.findByUserId(userId)) : undefined;
              trust = await readTrust(userId).catch(() => ({ blockedTools: [] as string[], trustedTools: [] as string[] }));
              io.stdout(`(persona → ${currentPersona ?? "(base)"}; userKey=${userId})\n`);
              if (userMemory) {
                const factCount = Object.keys(userMemory.facts).length;
                const prefCount = Object.keys(userMemory.preferences).length;
                io.stdout(`  remembered: ${factCount.toString()} fact(s), ${prefCount.toString()} pref(s) for this persona\n`);
              } else {
                io.stdout(`  (no memory for this persona yet — start fresh)\n`);
              }
            }
            break;
          case "trust":
            io.stdout(`  trust for ${userId}:\n`);
            io.stdout(`    + trusted (${trust.trustedTools.length.toString()}): ${trust.trustedTools.join(", ") || "(none)"}\n`);
            io.stdout(`    × blocked (${trust.blockedTools.length.toString()}): ${trust.blockedTools.join(", ") || "(none)"}\n`);
            break;
          case "help":
            io.stdout("  /exit, /quit          leave\n");
            io.stdout("  /reset                clear history (both memory + disk)\n");
            io.stdout("  /history              show turn count\n");
            io.stdout("  /model <tag>          switch model (e.g. ollama/qwen2.5:7b-instruct)\n");
            io.stdout("  /tools on|off         toggle tool registry\n");
            io.stdout("  /fact key=value       remember a fact about you (persists across sessions)\n");
            io.stdout("  /pref key=value       remember a preference\n");
            io.stdout("  /whoami               show what Muse knows about you\n");
            io.stdout("  /persona <slot>       switch persona slot (work / home / none); each has its own memory\n");
            io.stdout("  /trust                show this user's trusted + blocked tools\n");
            io.stdout("  /help                 this list\n");
            break;
          default:
            io.stdout(`(unknown command: /${cmd ?? ""} — try /help)\n`);
        }
        continue;
      }

      try {
        const persona = personaPrompt();
        const messages: { role: "system" | "user" | "assistant"; content: string }[] = [
          ...(persona ? [{ content: persona, role: "system" as const }] : []),
          ...history,
          { content: trimmed, role: "user" as const }
        ];
        io.stdout("muse> ");
        let accumulated = "";
        if (toolsDisabled && assembly.modelProvider) {
          // Chat-only fast path: stream tokens directly from the
          // provider. Agent-runtime guards + filters would buffer
          // everything until the response is complete (so they can
          // scrub) — fine for tool-using runs, but kills the
          // token-by-token JARVIS feel. With tools off there's no
          // guard surface that needs the full response anyway.
          for await (const event of assembly.modelProvider.stream({
            messages,
            model: currentModel ?? assembly.defaultModel ?? "default"
          })) {
            if (event.type === "text-delta" && typeof event.text === "string") {
              io.stdout(event.text);
              accumulated += event.text;
            }
          }
        } else {
          // Tool-using path: route through the agent runtime so the
          // tool registry + guards + memory hooks fire. Streams the
          // final text once when the agent settles. Blocked-tool list
          // from `muse trust block <tool>` flows in via
          // `forbiddenToolNames`, which the tool exposure policy
          // hard-filters before the model ever sees the registry.
          const metadata: Record<string, string | number | readonly string[]> = {};
          if (toolsDisabled) metadata.maxTools = 0;
          if (trust.blockedTools.length > 0) {
            metadata.forbiddenToolNames = trust.blockedTools;
          }
          for await (const event of agentRuntime.stream({
            messages,
            ...(Object.keys(metadata).length > 0 ? { metadata: metadata as Record<string, string | number> } : {}),
            model: currentModel ?? assembly.defaultModel ?? "default"
          })) {
            if (event.type === "text-delta") {
              io.stdout(event.text);
              accumulated += event.text;
            }
          }
        }
        io.stdout("\n\n");
        history.push({ content: trimmed, role: "user" });
        history.push({ content: accumulated, role: "assistant" });
        await appendLastChatTurn({ message: trimmed, response: accumulated });

        // Fire-and-forget auto-extract: ask the same model to look at
        // the just-finished turn and pull out NEW facts/preferences,
        // then upsert to the persistent store. Failures stay silent
        // (network glitch, model emitted unparseable JSON, etc.) so
        // they never block the next prompt — that's the openclaw
        // differentiation in action: every chat improves what Muse
        // knows about you, but never at the cost of UX.
        if (autoExtract && memoryStore && toolsDisabled && assembly.modelProvider) {
          const turnUser = trimmed;
          const turnAssistant = accumulated;
          void (async () => {
            try {
              const systemPrompt = autoExtract.pickSystemPrompt(turnUser);
              let raw = "";
              for await (const ev of assembly.modelProvider!.stream({
                messages: [
                  { content: systemPrompt, role: "system" },
                  { content: `User turn:\n${turnUser}\n\nAssistant reply:\n${turnAssistant}`, role: "user" }
                ],
                model: currentModel ?? assembly.defaultModel ?? "default"
              })) {
                if (ev.type === "text-delta" && typeof ev.text === "string") {
                  raw += ev.text;
                }
              }
              const payload = autoExtract.extractJsonObject(raw);
              if (!payload) return;
              let wroteAny = false;
              for (const [key, value] of Object.entries(payload.facts ?? {})) {
                if (typeof value === "string" && value.length > 0) {
                  await Promise.resolve(memoryStore.upsertFact(userId, key, value));
                  wroteAny = true;
                }
              }
              for (const [key, value] of Object.entries(payload.preferences ?? {})) {
                if (typeof value === "string" && value.length > 0) {
                  await Promise.resolve(memoryStore.upsertPreference(userId, key, value));
                  wroteAny = true;
                }
              }
              // Encode vetoes + goals as prefixed preferences so the
              // FileUserMemoryStore (which doesn't own a typed-slot
              // column) still persists them. buildJarvisPersona
              // splits them back out for display.
              for (const slot of payload.vetoes ?? []) {
                if (slot && typeof slot.value === "string" && slot.value.length > 0) {
                  const key = `veto:${slot.id || slot.value.slice(0, 24)}`;
                  await Promise.resolve(memoryStore.upsertPreference(userId, key, slot.value));
                  wroteAny = true;
                }
              }
              for (const slot of payload.goals ?? []) {
                if (slot && typeof slot.value === "string" && slot.value.length > 0) {
                  const key = `goal:${slot.id || slot.value.slice(0, 24)}`;
                  await Promise.resolve(memoryStore.upsertPreference(userId, key, slot.value));
                  wroteAny = true;
                }
              }
              if (wroteAny) {
                userMemory = await Promise.resolve(memoryStore.findByUserId(userId));
              }
            } catch {
              // Fail-open. Extraction is opportunistic, not required.
            }
          })();
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        io.stderr(`(error: ${msg})\n`);
      }
    }
  } finally {
    rl.off("SIGINT", onSigint);
    rl.close();
  }
}

async function runLocalChat(
  io: ProgramIO,
  message: string,
  model: string | undefined,
  agentMode?: AgentMode,
  options: {
    readonly disableTools?: boolean;
    readonly priorHistory?: readonly { readonly role: "user" | "assistant"; readonly content: string }[];
  } = {}
) {
  // When the caller passes --model explicitly, push it into the
  // env so the autoconfigure assembly factory wires the matching
  // provider (the assembly is built lazily here, not at module
  // load). Without this, `--model ollama/foo` silently uses
  // whatever provider env inference produced — usually the
  // `gemini/openai/anthropic` first-match — and the run call
  // fails with retry-exhausted because the wrong provider sees
  // an unknown model name.
  if (model && model.length > 0 && !process.env.MUSE_MODEL) {
    process.env.MUSE_MODEL = model;
  }
  if (model && model.startsWith("ollama/") && !process.env.MUSE_MODEL_PROVIDER_ID) {
    process.env.MUSE_MODEL_PROVIDER_ID = "ollama";
  }
  const assembly = io.createRuntimeAssembly?.() ?? createMuseRuntimeAssembly();

  if (!assembly.agentRuntime || !(model ?? assembly.defaultModel)) {
    throw new Error("Local chat requires MUSE_MODEL and a configured model provider");
  }

  const metadata: Record<string, string | number> = {};
  if (agentMode) metadata.agentMode = agentMode;
  if (options.disableTools) metadata.maxTools = 0;
  const hasMetadata = Object.keys(metadata).length > 0;

  const messages = [
    ...(options.priorHistory ?? []),
    { content: message, role: "user" as const }
  ];
  const result = await assembly.agentRuntime.run({
    messages,
    ...(hasMetadata ? { metadata } : {}),
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

function renderActiveContext(snapshot: Record<string, unknown>): string {
  // Pretty-print the same fields the agent loop renders into the
  // `[Active Context]` system section. Layout mirrors
  // `renderActiveContextSection` from @muse/agent-core so the CLI
  // operator sees what the prompt will contain — without committing
  // to a structural import that drags agent-core into the CLI tree.
  const lines: string[] = [];
  const nowIso = typeof snapshot.nowIso === "string" ? snapshot.nowIso : undefined;
  const weekday = typeof snapshot.weekday === "string" ? snapshot.weekday : "?";
  const timezone = typeof snapshot.timezone === "string" ? snapshot.timezone : "?";
  lines.push(`now=${nowIso ?? "?"} (${weekday}, ${timezone})`);
  const workingHours = isRecord(snapshot.workingHours)
    ? snapshot.workingHours as { start?: number; end?: number }
    : undefined;
  if (workingHours && typeof workingHours.start === "number" && typeof workingHours.end === "number") {
    const inWindow = snapshot.isWorkingHours === undefined
      ? "unknown"
      : snapshot.isWorkingHours ? "yes" : "no";
    lines.push(`working_hours=${workingHours.start.toString()}-${workingHours.end.toString()} (in_window=${inWindow})`);
  }
  if (typeof snapshot.currentFocus === "string" && snapshot.currentFocus.trim()) {
    lines.push(`current_focus: ${snapshot.currentFocus}`);
  }
  const activeTask = isRecord(snapshot.activeTask) ? snapshot.activeTask : undefined;
  if (activeTask && typeof activeTask.title === "string") {
    const parts = [activeTask.title];
    if (typeof activeTask.id === "string") { parts.push(`id=${activeTask.id}`); }
    if (typeof activeTask.dueIso === "string") { parts.push(`due=${activeTask.dueIso}`); }
    lines.push(`active_task: ${parts.join(" · ")}`);
  }
  const events = Array.isArray(snapshot.todaysEvents) ? snapshot.todaysEvents : [];
  if (events.length > 0) {
    lines.push("today_events:");
    for (const eventValue of events.slice(0, 8)) {
      if (!isRecord(eventValue)) { continue; }
      const title = typeof eventValue.title === "string" ? eventValue.title : "(untitled)";
      const startIso = typeof eventValue.startIso === "string" ? eventValue.startIso : "?";
      const allDay = eventValue.allDay === true;
      const locationPart = typeof eventValue.location === "string" ? ` @ ${eventValue.location}` : "";
      lines.push(`  · ${allDay ? "(all day)" : startIso} ${title}${locationPart}`);
    }
  }
  return lines.join("\n");
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

