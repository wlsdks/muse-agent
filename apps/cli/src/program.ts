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
import { closestCommandName } from "./closest-command.js";
import { applyCommandGroups } from "./command-groups.js";
import { MUSE_TAGLINE } from "./muse-identity.js";
import { formatSpec } from "./muse-spec.js";
import { MUSE_CLI_VERSION } from "./muse-version.js";
import { attachUnknownSubcommandGuidance } from "./unknown-subcommand.js";
import { buildMusePersona, formatCurrentContextLine } from "./muse-persona.js";
import {
  appendLastChatTurn,
  clearLastChatHistory,
  readLastChatHistory
} from "./chat-history.js";
import {
  apiRequest,
  chatTurnPersistText,
  configPath,
  dropUndefined,
  readApiOptions,
  readConfigStore,
  renderActiveContext,
  resolveAuthToken,
  setConfigValue,
  streamRemoteChat,
  unsetConfigValue,
  writeConfigStore,
  writeOutput,
  writeRunLog
} from "./program-helpers.js";
import {
  createTuiChatSubmitter,
  parseAgentMode,
  readPipedStdin,
  resolveChatMessage,
  runLocalChat
} from "./chat-repl.js";

export { readPipedStdin };
import { renderMuseStatusTui, type MuseStatusTuiModel } from "./tui.js";
import { registerAuthCommands } from "./commands-auth.js";
import { registerConfigCommands } from "./commands-config.js";
import { registerListenCommand } from "./commands-listen.js";
import { registerMcpCommands } from "./commands-mcp.js";
import { registerAgentsCommands } from "./commands-agents.js";
import { registerDaemonCommands } from "./commands-daemon.js";
import { registerIngestCommand } from "./chat-export-ingest.js";
import { registerOnboardCommand } from "./commands-onboard.js";
import { registerProactiveCommands } from "./commands-proactive.js";
import { registerReflectionsCommand } from "./commands-reflections.js";
import { registerLearnedCommand } from "./commands-learned.js";
import { registerSwarmCommands, type CouncilGatherOverride } from "./commands-swarm.js";
import { registerProposeCommands } from "./commands-propose.js";
import { registerSkillsCommands } from "./commands-skills.js";
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
import { registerCommitmentsCommands } from "./commands-commitments.js";
import { registerCheckinsCommands } from "./commands-checkins.js";
import { registerUserCommands } from "./commands-user.js";
import { registerPatternCommands } from "./commands-pattern.js";
import { registerSearchCommand } from "./commands-search.js";
import { registerCsvCommand } from "./commands-csv.js";
import { registerLogoCommand } from "./commands-logo.js";
import { registerSummarizeCommand } from "./commands-summarize.js";
import { registerBenfordCommand } from "./commands-benford.js";
import { registerKeywordsCommand } from "./commands-keywords.js";
import { registerOnThisDayCommand } from "./commands-on-this-day.js";
import { registerTrendCommand } from "./commands-trend.js";
import { registerDiversityCommand } from "./commands-diversity.js";
import { registerFindCommand } from "./commands-find.js";
import { registerHistoryCommand } from "./commands-history.js";
import { registerOpenCommand } from "./commands-open.js";
import { registerNotesCommands } from "./commands-notes.js";
import { registerSchedulerCommands, registerSetupCommands } from "./commands-scheduler-setup.js";
import { registerSetupLocalCommand } from "./commands-setup-local.js";
import { registerSetupVoiceCommand } from "./commands-setup-voice.js";
import { registerBriefCommand } from "./commands-brief.js";
import { registerRecapCommand } from "./commands-recap.js";
import { registerApprovalCommands } from "./commands-approval.js";
import { loadImageAttachment, registerAskCommand } from "./commands-ask.js";
import { registerDemoCommand } from "./commands-demo.js";
import { registerExportCommand } from "./commands-export.js";
import { registerCompletionCommand } from "./commands-completion.js";
import { registerImportCommand } from "./commands-import.js";
import { registerFeedsCommand } from "./commands-feeds.js";
import { registerGlanceCommand } from "./commands-glance.js";
import { registerPersonaCommand } from "./commands-persona.js";
import { loadActivePersonaPreamble } from "./persona-store.js";
import { registerReadCommand } from "./commands-read.js";
import { registerRecallCommand } from "./commands-recall.js";
import { registerShowCommand } from "./commands-show.js";
import { registerTimeCommand } from "./timezone.js";
import { registerPrivacyCommand } from "./commands-privacy.js";
import { registerWeekCommand } from "./commands-week.js";
import { registerWeatherCommand } from "./weather.js";
import { registerMaintenanceCommand } from "./commands-maintenance.js";
import { registerMetricsCommands } from "./commands-metrics.js";
import { registerSessionCommands } from "./commands-session.js";
import { registerJobCommands } from "./commands-jobs.js";
import { registerNotesRagCommands } from "./commands-notes-rag.js";
import { registerNoteCommand } from "./commands-note.js";
import { registerRememberCommands } from "./commands-remember.js";
import { registerStatusCommand } from "./commands-status.js";
import { registerRoutineCommand } from "./commands-routine.js";
import { registerTrustCommands } from "./commands-trust.js";
import { registerWatchFolderCommand } from "./commands-watch-folder.js";
import { registerAgentNoticesCommands } from "./commands-agent-notices.js";
import { registerWebhookCommand } from "./commands-webhook.js";
import { registerActionsCommands } from "./commands-actions.js";
import { registerApprovalsCommands } from "./commands-approvals.js";
import { registerAnomalyCommand } from "./commands-anomaly.js";
import { registerContactsCommands } from "./commands-contacts.js";
import { registerEmailCommands } from "./commands-email.js";
import { registerHomeCommands } from "./commands-home.js";
import { registerInboxCommand } from "./commands-inbox.js";
import { registerObjectivesCommands } from "./commands-objectives.js";
import { registerPlaybookCommands } from "./commands-playbook.js";
import { registerWebActionCommands } from "./commands-web-action.js";
import { registerSpecsCommands } from "./commands-specs.js";
import { registerTasksCommands } from "./commands-tasks.js";
import { registerTelemetryCommands } from "./commands-telemetry.js";
import { registerTodayCommands, type TodayCommandShells } from "./commands-today.js";
import { registerVoiceCommands } from "./commands-voice.js";

interface CliPromptAdapter {
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
  /**
   * Test seam — bypass createMuseRuntimeAssembly + real peer HTTP in the
   * council action. When present, replaces the gatherCouncil call for each
   * debate round. Absent in production.
   */
  readonly councilGatherOverride?: CouncilGatherOverride;
  /**
   * Test seam — inject a fake model + embedder for the council synthesis step,
   * so tests can exercise synthesizeCouncilAnswer (including semantic outlier
   * screening) without a live Ollama. Absent in production.
   */
  readonly councilSynthesisOverride?: {
    readonly model: string;
    readonly modelProvider: import("@muse/model").ModelProvider;
    readonly embed?: (text: string) => Promise<readonly number[]>;
  };
  /**
   * Test seam — inject a fake embedder used ONLY for the semantic consensus gate,
   * without requiring a full synthesis model. Lets assembled-path tests verify the
   * consensus-gate's cross-lingual behavior in isolation. Absent in production.
   */
  readonly councilEmbedOverride?: (text: string) => Promise<readonly number[]>;
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

/**
 * The "first 60 seconds" quickstart block appended to `muse --help` /
 * the piped (non-TTY) first screen. The discovery surface for someone
 * who runs `muse` in a script / CI / `muse | cat` — commander's bare
 * command list alone doesn't say what to DO first or that Muse is
 * local-first. Every line is a REAL command (no fabricated guidance),
 * leads with the local-by-default identity, and orders the steps by
 * fastest-path-to-value. Pure string → directly testable.
 */
export function museQuickstartHelp(): string {
  return [
    "Quickstart (local-first — your data stays on your machine):",
    "  muse                  start chatting with your local model",
    "  muse setup local      install / point at a local Ollama model",
    "  muse remember \"...\"    teach Muse a fact or preference about you",
    "  muse status           see what Muse knows + your privacy posture",
    "",
    "Muse runs on a LOCAL model by default; cloud egress is refused unless you opt out.",
    "Run `muse <command> --help` for any command's options."
  ].join("\n");
}

export function createProgram(io: ProgramIO = defaultIO): Command {
  const program = new Command();

  program
    .name("muse")
    .description(MUSE_TAGLINE)
    .version(MUSE_CLI_VERSION)
    .option("--api-url <url>", "Muse API base URL")
    .option("--token <token>", "Bearer token for authenticated API calls")
    .configureOutput({
      writeErr: io.stderr,
      writeOut: io.stdout
    });

  // Muse exposes ~80 commands; insertion order makes `muse --help` an
  // unscannable wall. Sort commands + options alphabetically so a name is
  // findable by its first letter (the quickstart block below still
  // highlights the daily-driver few).

  program.configureHelp({ sortSubcommands: true, sortOptions: true });

  program.addHelpText("after", () => `\n${museQuickstartHelp()}`);

  program
    .command("config-path")
    .description("Print the active Muse config path")
    .action(() => {
      io.stdout(`${configPath(io)}\n`);
    });

  registerConfigCommands(program, io, { readConfigStore, setConfigValue, unsetConfigValue, writeConfigStore, writeOutput });

  program
    .command("spec")
    .description("Print the fixed runtime stack")
    .option("--json", "Print machine-readable JSON")
    .action((options: { readonly json?: boolean }) => {
      io.stdout(formatSpec(options.json));
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
    .option(
      "--image <path>",
      "Attach a local image (PNG/JPEG/GIF/WebP/HEIC) for the model to SEE — local vision via gemma4 (--local only). e.g. `muse chat --local --image receipt.jpg '이거 정리해줘'`."
    )
    .action(async (
      messageParts: readonly string[],
      options: {
        readonly continue?: boolean;
        readonly image?: string;
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
        // The interactive surface is the Ink chat (same as a bare `muse`); the
        // old readline REPL has been retired.
        if (!process.stdin.isTTY || !process.stdout.isTTY) {
          throw new Error("--interactive needs an interactive terminal (TTY)");
        }
        const cliConfigForChat = await readConfigStore(io);
        const chatModel = options.model ?? cliConfigForChat.defaultModel;
        const { runChatInk } = await import("./chat-ink.js");
        await runChatInk({
          continueHistory: options.continue !== false,
          ...(chatModel ? { model: chatModel } : {})
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
      // Multimodal: --image attaches a local image for the model to see. Vision
      // runs through the local agent runtime → Ollama adapter, so it requires
      // --local (the remote API path has no image channel).
      let imageAttachments: ReadonlyArray<{ readonly mimeType: string; readonly dataBase64: string }> = [];
      if (options.image) {
        if (!options.local) {
          throw new Error("--image requires --local (local vision via gemma4; the remote API path has no image channel)");
        }
        const loaded = await loadImageAttachment(options.image);
        if (!loaded.ok) {
          io.stderr(`${loaded.error}\n`);
          process.exitCode = 1;
          return;
        }
        imageAttachments = [loaded.attachment];
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

      // runLocalChat self-loads the persona; the remote paths need
      // it passed explicitly as systemPrompt. dropUndefined strips
      // an empty (default-persona) value so the request is unchanged.
      const personaPreamble = options.local
        ? ""
        : (await loadActivePersonaPreamble().catch(() => "")).trim();

      const body = options.local
        ? await runLocalChat(io, message, model, agentMode, { disableTools: toolsDisabled, priorHistory, ...(imageAttachments.length > 0 ? { imageAttachments } : {}) })
        : options.stream
          ? await streamRemoteChat(io, command, message, model, options.json === true, agentMode, options.webSearch === false, personaPreamble)
        : await apiRequest(io, command, "/api/chat", dropUndefined({
          message,
          model,
          metadata,
          systemPrompt: personaPreamble.length > 0 ? personaPreamble : undefined
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
        // Persist the CUE-FREE twin (responseForHistory) so the display-only
        // source-check warnings runLocalChat appended aren't replayed as trusted
        // grounding evidence on the next session's priorHistory (poisoned-source
        // poisoned-source defense; parity with the Ink chat). See chatTurnPersistText.
        const responseText = chatTurnPersistText(body);
        if (responseText) {
          // Persist the per-turn untrusted-source verdict so a later episode capture
          // marks the episode trusted:false even for this one-shot turn (EP-1b).
          const responseUntrusted = isRecord(body) && body.untrustedOnly === true;
          await appendLastChatTurn({ message, response: responseText, responseUntrusted });
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
  registerSwarmCommands(program, io);
  registerReflectionsCommand(program, io);
  registerLearnedCommand(program, io);
  registerProposeCommands(program, io);
  registerDaemonCommands(program, io);
  registerSkillsCommands(program, io);
  registerAgentsCommands(program, io);
  registerIngestCommand(program, io);
  registerOnboardCommand(program, io);

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
  registerCommitmentsCommands(program, io);
  registerCheckinsCommands(program, io);
  registerUserCommands(program, io);
  registerPatternCommands(program, io);
  registerSearchCommand(program, io);
  registerFindCommand(program, io);
  registerCsvCommand(program, io);
  registerLogoCommand(program, io);
  registerSummarizeCommand(program, io);
  registerBenfordCommand(program, io);
  registerKeywordsCommand(program, io);
  registerOnThisDayCommand(program, io);
  registerTrendCommand(program, io);
  registerDiversityCommand(program, io);
  registerHistoryCommand(program, io);
  registerOpenCommand(program, io);
  registerNotesCommands(program, io, { apiRequest, writeOutput });
  registerSchedulerCommands(program, io, { apiRequest, writeOutput });
  registerSetupCommands(program, io);
  registerSetupLocalCommand(program, io, { readConfigStore, writeConfigStore });
  registerSetupVoiceCommand(program, io);
  registerStatusCommand(program, io);
  registerBriefCommand(program, io);
  registerRecapCommand(program, io);
  registerRememberCommands(program, io);
  registerNotesRagCommands(program, io);
  registerJobCommands(program, io);
  registerApprovalCommands(program, io);
  registerAskCommand(program, io);
  registerDemoCommand(program, io);
  registerExportCommand(program, io);
  registerImportCommand(program, io);
  registerSessionCommands(program, io);
  registerCompletionCommand(program, io);
  registerMetricsCommands(program, io, { apiRequest, writeOutput });
  registerMaintenanceCommand(program, io);
  registerShowCommand(program, io);
  registerWeatherCommand(program, io);
  registerPrivacyCommand(program, io);
  registerWeekCommand(program, io);
  registerTimeCommand(program, io);
  registerReadCommand(program, io);
  registerGlanceCommand(program, io);
  registerRecallCommand(program, io);
  registerNoteCommand(program, io);
  registerFeedsCommand(program, io);
  registerPersonaCommand(program, io);
  registerWatchFolderCommand(program, io);
  registerRoutineCommand(program, io);
  registerTrustCommands(program, io);
  registerWebhookCommand(program, io);
  registerAgentNoticesCommands(program, io, { apiRequest });
  registerTasksCommands(program, io, { apiRequest, writeOutput });
  registerObjectivesCommands(program, io);
  registerPlaybookCommands(program, io);
  registerActionsCommands(program, io);
  registerApprovalsCommands(program, io);
  registerContactsCommands(program, io);
  registerAnomalyCommand(program, io);
  registerInboxCommand(program, io);
  registerEmailCommands(program, io);
  registerWebActionCommands(program, io);
  registerHomeCommands(program, io);
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

  // A typo'd subcommand of a group (`muse memory bogus`) otherwise hit
  // commander's dead-end "unknown command 'bogus'"; ground it like the
  // top-level catch-all does, with a suggestion + the real subcommand list.
  attachUnknownSubcommandGuidance(program, io.stderr);

  // Group the 100+ top-level commands under ordered headings in `--help` so
  // the daily-driver commands surface first instead of a flat wall.
  applyCommandGroups(program);

  // Catch-all positional: no arg → print help; unknown arg →
  // closest-command suggestion instead of commander's confusing
  // "too many arguments". Usage line is overridden below so the
  // help banner stays "muse [options] [command]".
  program.argument("[unknown_subcommand]");
  program.allowExcessArguments(true);
  program.usage("[options] [command]");
  program.action(async (unknownSubcommand?: string) => {
    const attempted = typeof unknownSubcommand === "string" ? unknownSubcommand.trim() : "";
    if (attempted.length === 0) {
      // Like `claude` / `codex`: a bare `muse` in an interactive terminal
      // opens the Ink chat with a bottom input BOX. CJK composition is kept
      // inside the box via Ink's `useCursor` (the real cursor is placed at
      // the input column each render). `muse repl` stays on readline as a
      // guaranteed-CJK-safe fallback. Piped / non-TTY keeps the help banner.
      if (process.stdin.isTTY && process.stdout.isTTY) {
        const cliConfig = await readConfigStore(io);
        const { runChatInk } = await import("./chat-ink.js");
        await runChatInk({
          continueHistory: true,
          ...(cliConfig.defaultModel ? { model: cliConfig.defaultModel } : {})
        });
        return;
      }
      program.outputHelp();
      return;
    }
    io.stderr(formatUnknownCommand(attempted, listAllCommandNames(program)));
    process.exitCode = 1;
  });

  return program;
}

/**
 * Flatten the root program's `.commands` array into
 * a deduped list of names (skips hidden / `*` placeholder
 * entries). Used by the unknown-subcommand fallback to ground
 * the "Did you mean …" suggestion.
 */
function listAllCommandNames(program: Command): readonly string[] {
  const seen = new Set<string>();
  for (const cmd of program.commands) {
    const name = cmd.name();
    if (!name || name === "*") continue;
    seen.add(name);
  }
  return Array.from(seen).sort();
}

/**
 * Prefix fallback for the "Did you mean" suggestion: users
 * naturally abbreviate (`muse cal` → `calendar`,
 * `muse sched` → `scheduler-setup`), which pure Levenshtein
 * misses (5+ edits, far over the length-aware cap). Only suggest
 * when EXACTLY ONE command has the prefix — an ambiguous prefix
 * ("re" → recall/remember/remind) must stay silent rather than
 * guess wrong.
 */
export function uniqueCommandPrefix(input: string, names: readonly string[]): string | undefined {
  const prefix = input.trim().toLowerCase();
  if (prefix.length < 2) return undefined;
  const matches = names.filter((name) => name.toLowerCase().startsWith(prefix));
  return matches.length === 1 ? matches[0] : undefined;
}

// The daily-driver + onboarding commands a new user most likely wants.
// Filtered against the LIVE registry before display, so the discovery
// hint can only ever name a command that actually exists (fabrication 0).
const POPULAR_COMMANDS = ["chat", "ask", "status", "today", "remember", "setup"] as const;

/**
 * The stderr block for an unknown `muse <x>`. A close/prefix match gets a
 * "Did you mean" nudge; when nothing is close (a real typo / a new user
 * guessing), a bare "unknown command" + "run --help" (which dumps 100+
 * commands) is a dead end — so surface a short list of POPULAR commands
 * (intersected with the real registry) as a discovery on-ramp. Pure +
 * exported so the guidance is gradeable without spawning the CLI.
 */
export function formatUnknownCommand(attempted: string, known: readonly string[]): string {
  const suggestion = closestCommandName(attempted, known) ?? uniqueCommandPrefix(attempted, known);
  const lines = [`error: unknown command '${attempted}'`];
  if (suggestion) {
    lines.push(`Did you mean 'muse ${suggestion}'?`);
    lines.push("Run `muse --help` for the list of commands.");
  } else {
    const popular = POPULAR_COMMANDS.filter((name) => known.includes(name));
    if (popular.length > 0) {
      lines.push(`Popular commands: ${popular.map((name) => `muse ${name}`).join(" · ")}`);
    }
    lines.push("Run `muse --help` for the full list of commands.");
  }
  return `${lines.join("\n")}\n`;
}


// JARVIS persona helpers (`buildMusePersona`,
// `formatCurrentContextLine`) live in ./muse-persona.ts and are
// imported at the top of this file. They're re-exported below so
// the historical `./program.js` import path keeps working for
// muse-persona.test.ts and other consumers.
export { buildMusePersona, formatCurrentContextLine };


// Auth / HTTP / SSE / config helpers live in ./program-helpers.ts.
// Imported at the top of this file; re-exported below so the
// historical `./program.js` path keeps working for any external
// consumer (currently none — tests use the createProgram entry).



