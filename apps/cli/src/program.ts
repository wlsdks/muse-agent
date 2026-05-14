import path from "node:path";

import type { AgentRuntime } from "@muse/agent-core";
import { Command } from "commander";
import {
  credentialPath,
  deleteStoredToken,
  isRecord,
  readStoredToken,
  writeStoredToken
} from "./credential-store.js";
import { formatCitations } from "./human-formatters.js";
import { buildMusePersona, formatCurrentContextLine } from "./muse-persona.js";
import {
  appendLastChatTurn,
  clearLastChatHistory,
  readLastChatHistory
} from "./chat-history.js";
import {
  apiRequest,
  configPath,
  dropUndefined,
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
import {
  createTuiChatSubmitter,
  parseAgentMode,
  readPipedStdin,
  resolveChatMessage,
  runChatRepl,
  runLocalChat
} from "./chat-repl.js";

// Re-exported for the test in `apps/cli/test/program.test.ts:5,26`
// which imports `defaultCredentialPath` from `program.js`.
export { defaultCredentialPath } from "./credential-store.js";
// `writeRunLog` + `readPipedStdin` were historically exported from
// program.ts. The implementations now live in ./program-helpers.ts
// and ./chat-repl.ts; the re-exports keep historical import paths
// working.
export { writeRunLog };
export { readPipedStdin };
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
import { registerFollowupCommands } from "./commands-followup.js";
import { registerEpisodeCommands } from "./commands-episode.js";
import { registerPatternCommands } from "./commands-pattern.js";
import { registerSearchCommand } from "./commands-search.js";
import { registerHistoryCommand } from "./commands-history.js";
import { registerOpenCommand } from "./commands-open.js";
import { registerNotesCommands } from "./commands-notes.js";
import { registerSchedulerCommands, registerSetupCommands } from "./commands-scheduler-setup.js";
import { registerSetupLocalCommand } from "./commands-setup-local.js";
import { registerSetupVoiceCommand } from "./commands-setup-voice.js";
import { registerBriefCommand } from "./commands-brief.js";
import { registerApprovalCommands } from "./commands-approval.js";
import { registerAskCommand } from "./commands-ask.js";
import { registerExportCommand } from "./commands-export.js";
import { registerImportCommand } from "./commands-import.js";
import { registerJobCommands } from "./commands-jobs.js";
import { registerNotesRagCommands } from "./commands-notes-rag.js";
import { registerRememberCommands } from "./commands-remember.js";
import { registerStatusCommand } from "./commands-status.js";
import { registerRoutineCommand } from "./commands-routine.js";
import { registerTrustCommands } from "./commands-trust.js";
import { registerWatchFolderCommand } from "./commands-watch-folder.js";
import { registerAgentNoticesCommands } from "./commands-agent-notices.js";
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

// `defaultConfigPath` lives in ./program-helpers.ts; re-export for
// the test that imports it from `./program.js`.
export { defaultConfigPath } from "./program-helpers.js";

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
  registerFollowupCommands(program, io);
  registerEpisodeCommands(program, io);
  registerPatternCommands(program, io);
  registerSearchCommand(program, io);
  registerHistoryCommand(program, io);
  registerOpenCommand(program, io);
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
  registerExportCommand(program, io);
  registerImportCommand(program, io);
  registerWatchFolderCommand(program, io);
  registerRoutineCommand(program, io);
  registerTrustCommands(program, io);
  registerWebhookCommand(program, io);
  registerAgentNoticesCommands(program, io, { apiRequest });
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

  // Goal 060 — `muse` with no subcommand should print help instead
  // of exiting silently / surfacing a confusing "unknown command"
  // error. Commander's default behavior shows help text via
  // `outputHelp`; we route it through `io.stdout` so tests can
  // capture it the same way they capture any other command output.
  program.action(() => {
    program.outputHelp();
  });

  return program;
}


// JARVIS persona helpers (`buildMusePersona`,
// `formatCurrentContextLine`) live in ./muse-persona.ts and are
// imported at the top of this file. They're re-exported below so
// the historical `./program.js` import path keeps working for
// muse-persona.test.ts and other consumers.
export { buildMusePersona, formatCurrentContextLine };

// Chat-history + activity-log lifecycle helpers live in
// ./chat-history.ts. Re-exported below so the historical
// `./program.js` path keeps working for tests and downstream
// consumers (`appendActivity`, `maybeCompactLastChatHistory`).
export { appendActivity, maybeCompactLastChatHistory } from "./chat-history.js";

// Auth / HTTP / SSE / config helpers live in ./program-helpers.ts.
// Imported at the top of this file; re-exported below so the
// historical `./program.js` path keeps working for any external
// consumer (currently none — tests use the createProgram entry).



