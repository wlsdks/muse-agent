import path from "node:path";

import type { AgentRuntime } from "@muse/agent-core";
import { createMuseRuntimeAssembly } from "@muse/autoconfigure";
import { Command } from "commander";
import {
  credentialPath,
  deleteStoredToken,
  isRecord,
  readStoredToken,
  writeStoredToken
} from "./credential-store.js";
import { formatCitations } from "./human-formatters.js";
import { buildJarvisPersona, formatCurrentContextLine } from "./jarvis-persona.js";
import {
  appendActivity,
  appendLastChatTurn,
  clearLastChatHistory,
  maybeCompactLastChatHistory,
  parseRoutineUpdateMs,
  readLastChatHistory
} from "./chat-history.js";
import {
  apiRequest,
  configPath,
  dropUndefined,
  promptText,
  readApiOptions,
  readConfigStore,
  renderActiveContext,
  resolveAuthToken,
  setConfigValue,
  streamRemoteChat,
  writeConfigStore,
  writeOutput,
  writeRunLog
} from "./program-helpers.js";

// Re-exported for the test in `apps/cli/test/program.test.ts:5,26`
// which imports `defaultCredentialPath` from `program.js`.
export { defaultCredentialPath } from "./credential-store.js";
// `writeRunLog` was historically exported from program.ts. The
// implementation now lives in ./program-helpers.ts; this re-export
// keeps any external caller using the historical path working.
export { writeRunLog };
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
import { registerBriefCommand } from "./commands-brief.js";
import { registerApprovalCommands } from "./commands-approval.js";
import { registerAskCommand } from "./commands-ask.js";
import { registerJobCommands } from "./commands-jobs.js";
import { registerNotesRagCommands } from "./commands-notes-rag.js";
import { registerRememberCommands } from "./commands-remember.js";
import { registerStatusCommand } from "./commands-status.js";
import { registerRoutineCommand } from "./commands-routine.js";
import { registerTrustCommands } from "./commands-trust.js";
import { registerWatchFolderCommand } from "./commands-watch-folder.js";
import { registerWebhookCommand } from "./commands-webhook.js";
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
      deleteByUserId(userId: string): Promise<boolean> | boolean;
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
  registerBriefCommand(program, io);
  registerRememberCommands(program, io);
  registerNotesRagCommands(program, io);
  registerJobCommands(program, io);
  registerApprovalCommands(program, io);
  registerAskCommand(program, io);
  registerWatchFolderCommand(program, io);
  registerRoutineCommand(program, io);
  registerTrustCommands(program, io);
  registerWebhookCommand(program, io);
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

export async function readPipedStdin(): Promise<string> {
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

// JARVIS persona helpers (`buildJarvisPersona`,
// `formatCurrentContextLine`) live in ./jarvis-persona.ts and are
// imported at the top of this file. They're re-exported below so
// the historical `./program.js` import path keeps working for
// jarvis-persona.test.ts and other consumers.
export { buildJarvisPersona, formatCurrentContextLine };

// Chat-history + activity-log lifecycle helpers live in
// ./chat-history.ts. Re-exported below so the historical
// `./program.js` path keeps working for tests and downstream
// consumers (`appendActivity`, `maybeCompactLastChatHistory`).
export { appendActivity, maybeCompactLastChatHistory } from "./chat-history.js";

// Auth / HTTP / SSE / config helpers live in ./program-helpers.ts.
// Imported at the top of this file; re-exported below so the
// historical `./program.js` path keeps working for any external
// consumer (currently none — tests use the createProgram entry).

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
  // Long-session compaction: if last-chat.jsonl has grown past the
  // compact threshold, summarize the old turns and rewrite the file
  // before seeding history. Falls through cleanly on failure.
  if (options.continueHistory) {
    try {
      const probeAssembly = io.createRuntimeAssembly?.() ?? createMuseRuntimeAssembly();
      if (probeAssembly.modelProvider && (options.model ?? probeAssembly.defaultModel)) {
        const compaction = await maybeCompactLastChatHistory(
          probeAssembly.modelProvider as Parameters<typeof maybeCompactLastChatHistory>[0],
          options.model ?? probeAssembly.defaultModel ?? "default"
        );
        if (compaction.compacted) {
          process.stderr.write(`(compacted ${compaction.dropped.toString()} older line(s) into a summary)\n`);
        }
      }
    } catch { /* compaction is best-effort */ }
  }
  const seedHistory = options.continueHistory ? await readLastChatHistory() : [];
  const history: { role: "user" | "assistant"; content: string }[] = [...seedHistory];
  let currentModel = options.model;
  let toolsDisabled = options.disableTools;
  const baseUserId = options.userId ?? process.env.MUSE_USER_ID ?? process.env.USER ?? "default";
  // Multi-persona: the on-disk store keys persona slots as
  // `<user>@<persona>` so a single human ("stark") can have a
  // distinct work / home / hobby context with its own facts,
  // prefs, vetoes, goals. No persona suffix → the bare userId.
  // Persona resolution order: explicit --persona > shell env > none.
  // Setting `export MUSE_PERSONA=work` in a shell-rc lets the user
  // skip --persona on every invocation while keeping the in-session
  // /persona switch operational. P1 from agent-capability-audit.md.
  let currentPersona = options.persona?.trim() ?? process.env.MUSE_PERSONA?.trim();
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

  // Auto-refresh routine fact when stale (≥ 7 d since last update).
  // Background fire-and-forget — keeps the persona's
  // `routine_active_hours` current without forcing the user to
  // run `muse routine --apply` periodically. JARVIS keeps its
  // model of the user current.
  if (memoryStore) {
    const lastRoutineUpdateMs = parseRoutineUpdateMs(userMemory);
    const staleDays = (Date.now() - lastRoutineUpdateMs) / 86_400_000;
    if (staleDays >= 7) {
      void (async () => {
        try {
          const { activityPath, computeRoutine, readActivity } = await import("./commands-routine.js");
          const rows = await readActivity(activityPath());
          const cutoff = Date.now() - 30 * 86_400_000;
          const filtered = rows.filter((row) => row.userId === userId && new Date(row.tsIso).getTime() >= cutoff);
          if (filtered.length < 5) return; // not enough signal yet
          const summary = computeRoutine(filtered);
          if (summary.topHours.length === 0) return;
          const hoursFact = summary.topHours.map((h) => h.toString().padStart(2, "0")).join(",");
          const daysFact = summary.topDays.join(",");
          await Promise.resolve(memoryStore.upsertFact(userId, "routine_active_hours", hoursFact));
          if (daysFact) {
            await Promise.resolve(memoryStore.upsertFact(userId, "routine_active_days", daysFact));
          }
          userMemory = await Promise.resolve(memoryStore.findByUserId(userId));
        } catch { /* fail-open */ }
      })();
    }
  }

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
          case "remember": {
            // Natural-language LLM extraction → upsert into memory.
            // Mirrors the top-level `muse remember` command but works
            // in-REPL so the user can teach JARVIS mid-conversation.
            if (arg.length === 0 || !assembly.modelProvider) {
              io.stdout(`(usage: /remember <text>; requires a configured model)\n`);
              break;
            }
            try {
              const sysPrompt = autoExtract?.pickSystemPrompt(arg) ?? "Extract user facts as JSON.";
              let raw = "";
              for await (const ev of assembly.modelProvider.stream({
                messages: [
                  { content: sysPrompt, role: "system" },
                  { content: `User turn:\n${arg}\n\nAssistant reply:\n(no reply — extract from the statement)`, role: "user" }
                ],
                model: currentModel ?? assembly.defaultModel ?? "default"
              })) {
                if (ev.type === "text-delta" && typeof ev.text === "string") raw += ev.text;
              }
              const payload = autoExtract?.extractJsonObject(raw);
              if (!payload || !memoryStore) {
                io.stdout("(nothing extracted — try rephrasing)\n");
                break;
              }
              let wrote = 0;
              for (const [k, v] of Object.entries(payload.facts ?? {})) {
                if (typeof v === "string" && v.length > 0) {
                  await Promise.resolve(memoryStore.upsertFact(userId, k, v));
                  io.stdout(`  + fact.${k} = ${v}\n`);
                  wrote += 1;
                }
              }
              for (const [k, v] of Object.entries(payload.preferences ?? {})) {
                if (typeof v === "string" && v.length > 0) {
                  await Promise.resolve(memoryStore.upsertPreference(userId, k, v));
                  io.stdout(`  + pref.${k} = ${v}\n`);
                  wrote += 1;
                }
              }
              for (const slot of payload.vetoes ?? []) {
                if (slot && typeof slot.value === "string" && slot.value.length > 0) {
                  const k = `veto:${slot.id || slot.value.slice(0, 24)}`;
                  await Promise.resolve(memoryStore.upsertPreference(userId, k, slot.value));
                  io.stdout(`  + ${k} = ${slot.value}\n`);
                  wrote += 1;
                }
              }
              for (const slot of payload.goals ?? []) {
                if (slot && typeof slot.value === "string" && slot.value.length > 0) {
                  const k = `goal:${slot.id || slot.value.slice(0, 24)}`;
                  await Promise.resolve(memoryStore.upsertPreference(userId, k, slot.value));
                  io.stdout(`  + ${k} = ${slot.value}\n`);
                  wrote += 1;
                }
              }
              userMemory = await Promise.resolve(memoryStore.findByUserId(userId));
              io.stdout(`(remembered ${wrote.toString()} item(s))\n`);
            } catch (cause) {
              io.stderr(`(/remember failed: ${cause instanceof Error ? cause.message : String(cause)})\n`);
            }
            break;
          }
          case "forget": {
            if (arg.length === 0 || !memoryStore) {
              io.stdout(`(usage: /forget <key> | /forget --all)\n`);
              break;
            }
            if (arg === "--all" || arg === "all") {
              const dropped = await Promise.resolve(memoryStore.deleteByUserId(userId));
              userMemory = undefined;
              io.stdout(dropped ? `(wiped all memory for ${userId})\n` : `(no memory to wipe)\n`);
              break;
            }
            const k = arg;
            if (!userMemory) {
              io.stdout(`(no memory for ${userId})\n`);
              break;
            }
            const factHit = userMemory.facts[k];
            const prefHit = userMemory.preferences[k] ?? userMemory.preferences[`veto:${k}`] ?? userMemory.preferences[`goal:${k}`];
            if (factHit === undefined && prefHit === undefined) {
              io.stdout(`(key '${k}' not in memory)\n`);
              break;
            }
            // Wipe + rebuild-without (mirrors top-level forget).
            const snapshot = userMemory;
            await Promise.resolve(memoryStore.deleteByUserId(userId));
            for (const [fk, fv] of Object.entries(snapshot.facts)) {
              if (fk !== k) await Promise.resolve(memoryStore.upsertFact(userId, fk, fv));
            }
            for (const [pk, pv] of Object.entries(snapshot.preferences)) {
              if (pk === k || pk === `veto:${k}` || pk === `goal:${k}`) continue;
              await Promise.resolve(memoryStore.upsertPreference(userId, pk, pv));
            }
            userMemory = await Promise.resolve(memoryStore.findByUserId(userId));
            io.stdout(`(forgot ${k})\n`);
            break;
          }
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
            io.stdout("  /remember <text>      LLM-extract facts/prefs/vetoes/goals from natural language\n");
            io.stdout("  /forget <key>         drop a single fact/pref; /forget --all wipes the persona\n");
            io.stdout("  /help                 this list\n");
            break;
          default:
            io.stdout(`(unknown command: /${cmd ?? ""} — try /help)\n`);
        }
        continue;
      }

      try {
        const persona = personaPrompt();
        // Always ground the model in `now`. When persona is set,
        // buildJarvisPersona already includes the date line; with
        // empty memory, fall back to a system message containing
        // just the date. Same fix as commands-ask.ts iter #15 —
        // JARVIS shouldn't lose track of what day it is when the
        // user hasn't filed any personal facts.
        const systemContent = persona ?? formatCurrentContextLine();
        const messages: { role: "system" | "user" | "assistant"; content: string }[] = [
          { content: systemContent, role: "system" as const },
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

  // Ground the model in `now` even on the non-interactive
  // `muse chat --local "msg"` path. Same fix family as iter #15
  // (`muse ask`) and iter #16 (REPL): runLocalChat previously sent
  // ZERO system content, so questions like "what's today's date?"
  // got hallucinated answers (e.g. "Friday 2026-05-12" when the
  // real local now was Wednesday 2026-05-13). Persona/user-memory
  // loading is intentionally NOT done here — the chat one-shot
  // path doesn't have userId plumbed, and the most common
  // hallucination class is the date one. The agent runtime is
  // free to append its own system prompt; this prefix just
  // guarantees the date is always present.
  const messages = [
    { content: formatCurrentContextLine(), role: "system" as const },
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


