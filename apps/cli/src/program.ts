import { homedir } from "node:os";
import path from "node:path";

import type { AgentRuntime } from "@muse/agent-core";
import { Command, Option } from "commander";
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
import { cliContextFromGlobals, setCliContext } from "./cli-context.js";
import { formatUnknownSubcommand } from "./unknown-subcommand.js";
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
import { loadActivePersonaPreamble } from "./persona-store.js";
import type { MuseStatusTuiModel } from "./tui.js";
import type { CouncilGatherOverride } from "./commands-swarm.js";
import type { TodayCommandShells } from "./commands-today.js";
import { COMMAND_STUBS } from "./command-manifest.js";
import { LOADER_BY_NAME, type LazyDeps } from "./command-loaders.js";
import { registerCompletionCommand } from "./commands-completion.js";

/**
 * Thrown by a group's default-subcommand guard to ABORT the default action
 * (e.g. setup's status dashboard) when an unrecognized positional was passed
 * (`muse setup lcoal`). Commander only lets a `preAction` hook cancel the
 * action by throwing; the parseAsync wrapper swallows this sentinel so the
 * grounded guidance the hook already wrote is the only output (no bug-report
 * footer from the top-level error formatter).
 */
class UnknownSubcommandAbort extends Error {}

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

/**
 * The one-line getting-started hint shown at the very top of `muse --help`,
 * before the (100+ command) tree. clig.dev "help": orient a newcomer to the
 * two fastest on-ramps rather than dropping them into a wall of commands.
 * Pure string → directly testable. Both named commands are real.
 */
export function museGettingStartedHint(): string {
  return "New here? Run `muse` to start chatting, or `muse setup` to configure a model.";
}

/**
 * The docs / support footer line for `muse --help`. clig.dev "help": point to
 * where to go for more (docs + the local self-check). Pure string.
 */
export function museHelpDocsLine(): string {
  return "Docs & support: https://github.com/wlsdks/Muse  ·  run `muse doctor` to check your setup.";
}

/**
 * Examples block for `muse chat --help` (chat is defined here in the hub).
 * clig.dev: a few real, copy-pasteable examples beat a bare option list.
 */
export function museChatExamples(): string {
  return [
    "Examples:",
    "  muse chat \"what's on my plate today?\"      one-shot question via the API",
    "  muse chat --local \"summarise my notes\"     run on your local model, no server",
    "  muse chat -i --local                        open an interactive REPL",
    "  muse chat --local --image receipt.jpg \"정리해줘\"   attach an image (local vision)",
    "  muse chat --local -c --resume conv_ab12cd34 \"continue where we left off\"   resume a specific past conversation (see `muse chats list`)"
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
    .option("--no-setup", "Skip the first-run setup wizard and start chat directly")
    .option("--no-color", "Disable ANSI colour output (also honours NO_COLOR / FORCE_COLOR / TERM=dumb)")
    .option("-q, --quiet", "Suppress non-essential output (tips, spinners); keep primary output + errors")
    .option("--no-input", "Never prompt — take the safe non-interactive default instead of blocking")
    .configureOutput({
      writeErr: io.stderr,
      writeOut: io.stdout
    });

  // Populate the process-wide CLI UX context from the parsed global flags
  // BEFORE any command action runs, so every command / spinner / formatter
  // reads a single consistent signal for --quiet / --no-input / --no-color.
  // Absent flags → today's behaviour (no regression).
  program.hook("preAction", () => {
    setCliContext(cliContextFromGlobals(program.opts()));
  });

  // Muse exposes ~80 commands; insertion order makes `muse --help` an
  // unscannable wall. Sort commands + options alphabetically so a name is
  // findable by its first letter (the quickstart block below still
  // highlights the daily-driver few).

  program.configureHelp({ sortSubcommands: true, sortOptions: true });

  // A one-line getting-started hint renders FIRST (clig.dev: greet a newcomer
  // before the 100-command wall). The quickstart block + a docs/support line
  // render AFTER the grouped command tree.
  program.addHelpText("beforeAll", (helpContext) =>
    helpContext.command === program ? `${museGettingStartedHint()}\n` : ""
  );
  program.addHelpText("after", () => `\n${museQuickstartHelp()}\n\n${museHelpDocsLine()}`);

  program
    .command("config-path")
    .description("Print the active Muse config path")
    .action(() => {
      io.stdout(`${configPath(io)}\n`);
    });

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
      const { renderMuseStatusTui } = await import("./tui.js");
      const { createTuiChatSubmitter } = await import("./chat-repl.js");
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
    .addHelpText("after", () => `\n${museChatExamples()}`)
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
      "include prior turns from the active conversation so the model remembers it across CLI invocations (--local only)"
    )
    .option(
      "--reset",
      "clear the active conversation's turns before this turn (use after --continue to start a fresh conversation)"
    )
    .option(
      "--resume <id>",
      "switch the active conversation to this id/prefix before this turn (see `muse chats list`) — like `muse chats resume` but inline"
    )
    .option(
      "-i, --interactive",
      "open a continuous REPL — each line is a turn, /exit quits, /new starts a fresh conversation, /help lists commands (--local only)"
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
        readonly resume?: string;
        readonly stream?: boolean;
        readonly tools?: boolean;
        readonly webSearch?: boolean;
      },
      command
    ) => {
      // A non-blocking, ONCE-EVER nudge toward `muse daemon --install` — see
      // daemon-offer.ts's doc comment for the full gating contract. Skipped
      // under --json so scripted callers never see stray non-JSON output.
      if (!options.json) {
        const { maybeOfferDaemonInstall } = await import("./daemon-offer.js");
        await maybeOfferDaemonInstall({ env: process.env, print: (line) => io.stderr(`${line}\n`) }).catch(() => false);
      }
      if (options.resume) {
        const { resumeConversation } = await import("./chat-history.js");
        const resolution = await resumeConversation(options.resume);
        if (resolution.status === "not-found") {
          throw new Error(`No conversation found with id "${options.resume}". Run 'muse chats' to see the list.`);
        }
        if (resolution.status === "ambiguous") {
          const previews = resolution.candidates.map((c) => `${c.id} (${c.title})`).join(", ");
          throw new Error(`Ambiguous conversation id "${options.resume}" — matches ${resolution.candidates.length.toString()}: ${previews}`);
        }
      }
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
      const { resolveChatMessage, parseAgentMode, runLocalChat } = await import("./chat-repl.js");
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
        const { loadImageAttachment } = await import("./commands-ask.js");
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

  // The diagnostics endpoints below are single-line HTTP GETs with no heavy
  // imports, so they stay eager (a lazy-import round-trip would cost more than
  // the command does). Everything else is a lazy stub — see registerCommandStubs.
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

  // `completion` reads the LIVE command list to emit its script, so it stays
  // eager — it is itself a leaf module (a few ms) and enumerates the stubs.
  registerCompletionCommand(program, io);

  // Commander suppresses its implicit `help` command whenever the program has
  // its own action handler (Muse's catch-all does), so `muse help ask` fell
  // through to the unknown-command path. Register an explicit one so the
  // git/npm/docker convention `muse help <cmd>` == `muse <cmd> --help` holds.
  // The invoked-command hydrator (below) loads `<cmd>`'s real module before
  // parse, so the printed help is the full command's, not the lazy stub's.
  program
    .command("help [command]")
    .description("Show help for a command (`muse help ask` == `muse ask --help`), or the top-level help with no argument")
    .action((commandName?: string) => {
      const target = typeof commandName === "string" ? commandName.trim() : "";
      if (target.length === 0) {
        program.outputHelp();
        return;
      }
      const match = program.commands.find((command) => command.name() === target);
      if (!match) {
        io.stderr(formatUnknownCommand(target, listAllCommandNames(program)));
        process.exitCode = 1;
        return;
      }
      match.outputHelp();
    });

  // One shared dependency bag handed to every lazily-loaded registrar; each
  // destructures the subset it needs and ignores the rest, so a single object
  // serves all of them. `shells` is present only when the test harness injects
  // TTS/speaker fakes for `today --brief --speak`.
  const lazyDeps: LazyDeps = {
    apiRequest,
    writeOutput,
    readConfigStore,
    setConfigValue,
    unsetConfigValue,
    writeConfigStore,
    readApiOptions,
    resolveAuthToken,
    credentialPath,
    deleteStoredToken,
    readStoredToken,
    writeStoredToken,
    ...(io.todayShells ? { shells: io.todayShells } : {})
  };

  // Register a lightweight STUB (name + description + help term + subcommand
  // names) for every remaining command WITHOUT importing its handler. `--help`,
  // completion, and did-you-mean render off these stubs; the real module + its
  // action are pulled in on first invocation by the parseAsync wrapper below.
  // This is what keeps `--version` / `--help` / `completion` / a light command
  // off the ~100-module import tax.
  registerCommandStubs(program);

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
        const {
          firstRunSkipRequested,
          isFirstRunMarkerPresent,
          providerKeyPresent,
          runFirstRunSetupInteractive,
          shouldRunFirstRunSetup
        } = await import("./first-run.js");
        let cliConfig = await readConfigStore(io);
        const noSetupFlag = (program.opts() as { setup?: boolean }).setup === false;
        const home = io.configDir ? path.dirname(configPath(io)) : homedir();
        if (shouldRunFirstRunSetup({
          configuredModel: cliConfig.defaultModel,
          envModel: process.env.MUSE_MODEL ?? process.env.MUSE_DEFAULT_MODEL,
          interactive: true,
          markerPresent: isFirstRunMarkerPresent(home),
          providerKeyPresent: providerKeyPresent(process.env),
          skipRequested: firstRunSkipRequested(process.env, noSetupFlag)
        })) {
          await runFirstRunSetupInteractive({
            home,
            readConfig: () => readConfigStore(io),
            writeConfig: (config) => writeConfigStore(io, config),
            ...(io.fetch ? { fetch: io.fetch } : {})
          });
          // Pick up any defaultModel the wizard just wrote.
          cliConfig = await readConfigStore(io);
        }
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

  // Lazy dispatch: wrap parseAsync so the invoked command's REAL module graph
  // is imported + registered (replacing its stub) just before commander
  // dispatches. `--version`, `--help`, completion, and did-you-mean never name
  // a lazy command, so they run off the stubs alone and skip the heavy imports.
  const loadedLoaderIds = new Set<string>();
  const originalParseAsync = program.parseAsync.bind(program);
  program.parseAsync = (async (
    argv?: readonly string[],
    parseOptions?: { readonly from?: "node" | "electron" | "user" }
  ): Promise<Command> => {
    const effectiveArgv = argv ?? process.argv;
    await hydrateInvokedCommand(
      program,
      io,
      lazyDeps,
      loadedLoaderIds,
      effectiveArgv,
      parseOptions?.from ?? "node"
    );
    try {
      return await originalParseAsync(argv as string[] | undefined, parseOptions as never);
    } catch (error) {
      // The default-subcommand guard aborts via this sentinel AFTER writing its
      // own grounded guidance + setting exitCode; swallow it so the top-level
      // error formatter doesn't print a second (bug-report) message.
      if (error instanceof UnknownSubcommandAbort) return program;
      throw error;
    }
  }) as typeof program.parseAsync;

  return program;
}

/**
 * Register a lightweight STUB for every lazily-loaded command: enough for
 * `muse --help`, shell completion, and did-you-mean (name + description +
 * help term + subcommand names) WITHOUT importing the handler. The stub is
 * never dispatched — the parseAsync wrapper swaps in the real command on first
 * invocation — so the placeholder option (which only forces the " [options]"
 * help suffix) and empty-description subcommand stubs are display-only.
 */
function registerCommandStubs(program: Command): void {
  for (const stub of COMMAND_STUBS) {
    const command = program.command(stub.name).description(stub.description);
    if (stub.argsTerm) {
      command.argument(stub.argsTerm);
    }
    if (stub.hasOptions) {
      command.addOption(new Option("--__lazy_help_marker__").hideHelp());
    }
    for (const sub of stub.subcommands) {
      command.command(sub).description("");
    }
  }
}

/**
 * The positional operands a given argv targets, in order, skipping global
 * options (and the value of the two value-taking global flags). Empty when the
 * line names no command (bare `muse`, `--help`, `--version`) so those surfaces
 * stay on the stubs. `[0]` is the invoked command; `muse help <cmd>` uses `[1]`
 * to hydrate the command whose help is requested.
 */
function commandOperands(argv: readonly string[], from: "node" | "electron" | "user"): string[] {
  const args = from === "user" ? [...argv] : argv.slice(from === "electron" ? 1 : 2);
  const valueOptions = new Set(["--api-url", "--token"]);
  const operands: string[] = [];
  let literal = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (typeof arg !== "string") continue;
    if (literal) {
      operands.push(arg);
      continue;
    }
    if (arg === "--") {
      literal = true;
      continue;
    }
    if (arg.startsWith("-")) {
      if (valueOptions.has(arg)) i += 1;
      continue;
    }
    operands.push(arg);
  }
  return operands;
}

/**
 * Import + register the real command graph for the command an argv invokes,
 * replacing its stub. Idempotent per loader (a loader owning several top-level
 * names loads once) and a no-op for non-command / already-loaded lines.
 */
async function hydrateInvokedCommand(
  program: Command,
  io: ProgramIO,
  deps: LazyDeps,
  loadedLoaderIds: Set<string>,
  argv: readonly string[],
  from: "node" | "electron" | "user"
): Promise<void> {
  const operands = commandOperands(argv, from);
  // `muse help <cmd>` must render <cmd>'s REAL help, so hydrate the targeted
  // command (operand after `help`) rather than the eager `help` command itself.
  const target = operands[0] === "help" ? operands[1] : operands[0];
  if (!target) return;
  const loader = LOADER_BY_NAME.get(target);
  if (!loader || loadedLoaderIds.has(loader.id)) return;
  loadedLoaderIds.add(loader.id);
  for (const name of loader.names) {
    const index = program.commands.findIndex((command) => command.name() === name);
    if (index >= 0) {
      (program.commands as Command[]).splice(index, 1);
    }
  }
  await loader.load(program, io, deps);
  // Re-group so the freshly-real command lands under its `--help` heading, and
  // ground typo'd subcommands of any group it just introduced.
  applyCommandGroups(program);
  attachLoadedSubcommandGuidance(program, io.stderr, loader.names);
}

/**
 * Wire the grounded unknown-subcommand block onto the groups a lazy loader just
 * introduced (mirrors the eager `attachUnknownSubcommandGuidance`, but scoped to
 * the newly-loaded names so groups aren't double-wired across invocations).
 */
function attachLoadedSubcommandGuidance(
  program: Command,
  stderr: (text: string) => void,
  names: readonly string[]
): void {
  for (const name of names) {
    const group = program.commands.find((command) => command.name() === name);
    if (!group) continue;
    const subs = group.commands
      .map((sub) => sub.name())
      .filter((subName): subName is string => Boolean(subName) && subName !== "*");
    if (subs.length === 0) continue;
    const knownSubs = [...subs].sort();
    group.on("command:*", (operands: readonly string[]) => {
      stderr(`${formatUnknownSubcommand(name, operands[0] ?? "", knownSubs)}\n`);
      process.exitCode = 1;
    });
    attachDefaultSubcommandGuard(group, stderr, name, knownSubs);
  }
}

/**
 * Ground an unrecognized positional to a group whose default subcommand would
 * otherwise SWALLOW it. Commander routes a bare `muse setup lcoal` to the
 * `isDefault` `status` subcommand (excess args are inherited-allowed), so
 * `command:*` never fires and the typo silently prints the status dashboard.
 * When the default subcommand takes ZERO declared positionals, ANY leading
 * operand that isn't a real subcommand is an unknown-subcommand attempt — so a
 * `preAction` hook on that default rejects it with the same grounded guidance
 * the other groups use, while a NO-operand invocation (`muse setup`) still
 * runs the dashboard. Groups whose default legitimately takes a positional
 * (e.g. `remind add <when> <text>`) are left untouched.
 */
function attachDefaultSubcommandGuard(
  group: Command,
  stderr: (text: string) => void,
  groupName: string,
  knownSubs: readonly string[]
): void {
  const defaultName = (group as { _defaultCommandName?: string })._defaultCommandName;
  if (!defaultName) return;
  const defaultCommand = group.commands.find((command) => command.name() === defaultName);
  if (!defaultCommand) return;
  const declaredArgs =
    (defaultCommand as { registeredArguments?: readonly unknown[]; _args?: readonly unknown[] })
      .registeredArguments ??
    (defaultCommand as { _args?: readonly unknown[] })._args ??
    [];
  if (declaredArgs.length > 0) return;
  const knownSet = new Set(knownSubs);
  defaultCommand.hook("preAction", (_thisCommand, actionCommand) => {
    const attempted = actionCommand.args[0];
    if (typeof attempted !== "string" || attempted.length === 0 || knownSet.has(attempted)) {
      return;
    }
    stderr(`${formatUnknownSubcommand(groupName, attempted, knownSubs)}\n`);
    process.exitCode = 1;
    throw new UnknownSubcommandAbort();
  });
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


