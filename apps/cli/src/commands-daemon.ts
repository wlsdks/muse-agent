/**
 * `muse daemon` — run Muse's background daemons in one foreground
 * process the user can launch directly, instead of needing the full
 * `apps/api` server. Today it drives the proactive-notice tick;
 * additional ticks (followup / objectives / ambient / web-watch)
 * attach to the same launcher in later slices.
 *
 *   muse daemon          — run continuously, one tick per interval
 *   muse daemon --once   — run exactly one tick of each enabled
 *                          daemon, then exit (no infinite loop, no
 *                          process.exit — the testable seam)
 */

import type { Command } from "commander";

import {
  buildCalendarRegistry,
  buildMessagingRegistry,
  createMessagingPollDispatchers,
  createGateEmbedder,
  decayContradictedStrategies,
  distillQueuedCorrections,
  parseBoolean,
  resolveContactsFile,
  resolveEpisodesFile,
  resolveFollowupsFile,
  resolveLearningPauseFile,
  resolveNotesDir,
  resolveObjectivesFile,
  resolvePatternsFiredFile,
  resolvePlaybookFile,
  resolveProactiveHistoryFile,
  resolveRemindersFile,
  resolveSuppressedLessonsFile,
  resolveRecallHitsFile,
  resolveFadedMemoriesFile,
  resolveTasksFile,
  type DecayContradictedDeps,
  type DistillQueuedDeps
} from "@muse/autoconfigure";
import { clusterByTextSimilarity, mergePlaybookStrategies, PLAYBOOK_AVOID_BELOW, strategyTextSimilarity, synthesizePatternSuggestion, validateMergeCoverage, adjustConfidenceFloor, sdtCriterion, summarizeNoticeResponses } from "@muse/agent-core";
import { FileUserMemoryStore } from "@muse/memory";
import type { PatternMatch } from "@muse/memory";
import type { MessagingProviderRegistry } from "@muse/messaging";
import {
  createAmbientNoticeRunner,
  createMessagingObjectiveActuator,
  createModelObjectiveEvaluator,
  createProposingObjectiveActuator,
  createWebWatchRunner,
  deriveBriefingImminent,
  deriveCalendarBriefingImminent,
  FileAmbientSignalSource,
  formatBirthdayBriefLine,
  gateProactiveNoticeSink,
  isQuietHour,
  homeWatchesFromConfig,
  parseQuietHours,
  MacOsActiveWindowSource,
  parseAmbientNoticeRules,
  queryContacts,
  resolveUpcomingBirthdays,
  runDueCheckins,
  runDueFollowups,
  runDueObjectives,
  runDuePatternNotices,
  runDueProactiveNotices,
  readEpisodes,
  resolveLearnQueueFile,
  GmailEmailProvider,
  type EmailProvider,
  decayStalePlaybookRewards,
  isLearningPaused,
  queryPlaybook,
  recordPlaybookStrategy,
  removePlaybookStrategy,
  runDueReminders,
  runDueSituationalBriefing,
  selectUpcomingConflicts,
  webWatchesFromConfig,
  CHROME_DEVTOOLS_MCP_SERVER_NAME,
  type AmbientNoticeRunner,
  type BriefingCalendarLister,
  type ChromeSnapshotConnection,
  type ProactiveNoticeSink,
  type WebWatchRunner,
  readProactiveHistory,
  readRecallHits,
  writeFadedMemoryKeys
} from "@muse/mcp";
import type { MuseTool } from "@muse/tools";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { buildLaunchAgentPlist, LAUNCH_AGENT_LABEL, resolveLaunchAgentFile } from "./commands-daemon-launchagent.js";
import { readDaemonConfig, resolveDaemonConfigFile, writeDaemonConfig } from "./commands-daemon-config.js";
export { buildLaunchAgentPlist, resolveLaunchAgentFile } from "./commands-daemon-launchagent.js";
import { dirname, join } from "node:path";

import { checkinsFile } from "./commands-checkins.js";
import { deliverEveningRecapIfDue, gatherEveningRecap } from "./commands-recap.js";
import { closestCommandName } from "./closest-command.js";
import { parseBoundedFlag } from "./commands-proactive.js";
import { DEFAULT_REFLECTION_INTERVAL_MS, resolveReflectionsFile, runReflectionPass, shouldRunReflection } from "./commands-reflections.js";
import { syncEmailsToNotes } from "./email-sync.js";
import { createIndexedProactiveInvestigator } from "./proactive-notes-recall.js";
import { consolidatePlaybook } from "./playbook-consolidate.js";
import { runMemoryConsolidationTick } from "./memory-consolidate-tick.js";
import { promoteRecalledMemories, resolveMemoryUserId } from "./commands-memory.js";
import type { ProgramIO } from "./program.js";
import { randomUUID } from "node:crypto";
import { DEFAULT_EMBED_MODEL } from "./embed-model-default.js";

type FollowupModel = {
  readonly modelProvider: Parameters<typeof runDueFollowups>[0]["modelProvider"];
  readonly model: string;
};

export interface DaemonHelpers {
  /** Test seam — defaults to `process.env`. */
  readonly env?: () => NodeJS.ProcessEnv;
  /**
   * Test seam — inject a contract-faithful messaging registry rather
   * than building one from env, so a smoke can assert delivery against
   * a capturing fake provider.
   */
  readonly buildMessagingRegistry?: (env: NodeJS.ProcessEnv) => MessagingProviderRegistry;
  /**
   * Test seam — fully resolve the model the followup tick synthesizes
   * with, instead of building the runtime assembly (which reads the
   * real env). Tests inject a fake model or `undefined` (skip).
   */
  readonly resolveFollowupModel?: (env: NodeJS.ProcessEnv) => Promise<FollowupModel | undefined>;
  /** Test seam — inject the fetch the web-watch tick snapshots with. */
  readonly fetchImpl?: typeof globalThis.fetch;
  /** Test seam — inject the osascript runner for the macOS ambient source. */
  readonly ambientMacosRun?: (script: string) => Promise<string | undefined>;
  /**
   * Chrome DevTools MCP connection for `source:"chrome"` web-watches.
   * Without one, chrome-source watches are skipped (fail-soft) and the
   * daemon stays up. Tests inject a contract-faithful fake.
   */
  readonly chromeConnection?: ChromeSnapshotConnection;
  /**
   * Knowledge enricher for the ambient tick — given what the user is
   * looking at, returns a "Related: …" line from their own notes so an
   * ambient notice carries relevant context. Absent → no enrichment.
   */
  readonly knowledgeEnrich?: (query: string) => Promise<string | undefined> | string | undefined;
  /** Test seam — inject the calendar lister the briefing's imminent uses. */
  readonly briefingCalendarLister?: BriefingCalendarLister;
  /**
   * Test seam — inject the distiller the self-learning tick turns a queued
   * correction into a strategy with, so a smoke can assert an unattended
   * distill (and the brake) without a live LLM. Absent → the real local-Qwen
   * distiller (an `undefined` return ⇒ no strategy written, the grounding fence).
   */
  readonly selfLearnDistill?: DistillQueuedDeps["distill"];
  /**
   * Test seam — inject the correction-vs-strategy polarity classifier the
   * autonomous SUBTRACTIVE correction-decay uses, so a smoke can drive the decay
   * (a NEW correction that CONTRADICTS an injected strategy drops it below the
   * inject line) without a live LLM. Absent → the real model-backed classifier.
   */
  readonly contradictionClassify?: DecayContradictedDeps["classify"];
  /**
   * Test seam — inject the email source the continuous email-sync tick reads, so a
   * smoke can drive Gmail→notes ingestion (a contract-faithful real GmailEmailProvider
   * with a fake fetch) without a live Gmail round-trip. Absent → the real provider
   * built from MUSE_GMAIL_TOKEN.
   */
  readonly emailSyncProvider?: Pick<EmailProvider, "listRecent">;
  /**
   * Test seams — inject the LLM merge + the held-out coverage validator the
   * autonomous playbook-consolidate tick uses, so a smoke can drive a real
   * merge of near-duplicate PROBATION strategies (and the safety contract:
   * merged stays on probation, never graduates) without a live LLM/embedder.
   */
  readonly consolidateMerge?: (texts: readonly string[]) => Promise<string | undefined>;
  readonly consolidateValidate?: (originals: readonly string[], merged: string) => Promise<{ readonly accept: boolean; readonly reason: string; readonly lost?: readonly string[] }>;
  /**
   * Test seam — inject the messaging poll so a smoke can assert the daemon
   * pulls new inbound (which the inbox-injection cursor then makes recallable)
   * without a live Telegram/Discord/Slack round-trip. Absent → the real
   * `createMessagingPollDispatchers(env, registry).pollAll`.
   */
  readonly messagingPoll?: () => Promise<{
    readonly ingestedByProvider: Readonly<Record<string, number>>;
    readonly errors: readonly { readonly providerId: string; readonly message: string }[];
  }>;
  /**
   * Test seam — inject the calendar lister the conflict-watch tick scans, so a
   * smoke can drive a proactive double-booking notice (and the dedup contract:
   * the same clash notifies ONCE across ticks) without a real calendar provider.
   * Absent → the registered calendar provider's `listEvents`.
   */
  readonly conflictWatchCalendarLister?: (range: { readonly from: Date; readonly to: Date }) => Promise<readonly { readonly title: string; readonly startsAt: Date; readonly endsAt: Date }[]>;
}

// Followups REQUIRE a model to synthesize their message. The real
// daemon builds it from the runtime assembly (best-effort — if the
// model can't be resolved, the followup tick is skipped, not fatal).
async function defaultFollowupModel(_env: NodeJS.ProcessEnv): Promise<FollowupModel | undefined> {
  try {
    const { createMuseRuntimeAssembly } = await import("@muse/autoconfigure");
    const assembly = createMuseRuntimeAssembly();
    if (assembly.modelProvider && assembly.defaultModel) {
      return {
        model: assembly.defaultModel,
        modelProvider: assembly.modelProvider as unknown as FollowupModel["modelProvider"]
      };
    }
  } catch { /* fail-soft — followup tick skipped when no model */ }
  return undefined;
}

/**
 * Stop flag for the daemon foreground loop with an INTERRUPTIBLE
 * sleep: `stop()` both flips `stopped` and wakes any in-flight
 * `sleep()` so ctrl-c exits at once instead of waiting out the tick
 * interval. Testable without real signals or real timers.
 */
export class DaemonStopSignal {
  private isStopped = false;
  private readonly wakers = new Set<() => void>();

  get stopped(): boolean {
    return this.isStopped;
  }

  stop(): void {
    if (this.isStopped) return;
    this.isStopped = true;
    for (const wake of this.wakers) {
      wake();
    }
    this.wakers.clear();
  }

  sleep(ms: number): Promise<void> {
    if (this.isStopped) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.wakers.delete(wake);
        resolve();
      }, ms);
      const wake = (): void => {
        clearTimeout(timer);
        resolve();
      };
      this.wakers.add(wake);
    });
  }
}

/**
 * Run `tick` every `intervalMs` until `signal` stops, returning the
 * number of completed ticks. A tick that throws is reported via
 * `onError` and does NOT stop the loop (an unattended daemon survives
 * a transient tick failure). The sleep is the signal's interruptible
 * one by default; tests inject a synchronous `sleep` to drive it.
 */
export async function runDaemonLoop(opts: {
  readonly tick: () => Promise<void>;
  readonly intervalMs: number;
  readonly signal: DaemonStopSignal;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly onError?: (cause: unknown) => void;
}): Promise<number> {
  const sleep = opts.sleep ?? ((ms: number) => opts.signal.sleep(ms));
  let ticks = 0;
  while (!opts.signal.stopped) {
    try {
      await opts.tick();
      ticks += 1;
    } catch (cause) {
      opts.onError?.(cause);
    }
    if (!opts.signal.stopped) {
      await sleep(opts.intervalMs);
    }
  }
  return ticks;
}

// Adapt the MCP stack's projected Chrome DevTools tools into the
// `ChromeSnapshotConnection` (just `callTool`) that web-watch needs.
// `take_snapshot` / `navigate_page` map to the `chrome-devtools.*`
// MuseTools' execute.
export function chromeSnapshotConnectionFromTools(tools: readonly MuseTool[]): ChromeSnapshotConnection {
  const byName = new Map(tools.map((tool) => [tool.definition.name, tool]));
  return {
    callTool: async (toolName, args) => {
      const tool = byName.get(`${CHROME_DEVTOOLS_MCP_SERVER_NAME}.${toolName}`);
      if (!tool) {
        throw new Error(`chrome-devtools tool '${toolName}' is not available`);
      }
      // The projected MCP tool ignores the context; web-watch is read-only.
      return tool.execute(args as unknown as Parameters<MuseTool["execute"]>[0], { runId: "muse-daemon-web-watch" });
    }
  };
}

// Best-effort real Chrome connection at daemon startup: only when
// MUSE_CHROME_DEVTOOLS_ENABLED (assembleMcpStack auto-registers the
// chrome-devtools server then), connect it and adapt its tools. Any
// failure (Chrome not on the debug port, connect refused) yields
// `undefined` so chrome-source watches skip fail-soft and the daemon
// stays up. The real browser handshake is verified manually, not in CI.
async function defaultChromeConnection(env: NodeJS.ProcessEnv): Promise<ChromeSnapshotConnection | undefined> {
  if (!parseBoolean(env.MUSE_CHROME_DEVTOOLS_ENABLED, false)) return undefined;
  try {
    const { createMuseRuntimeAssembly } = await import("@muse/autoconfigure");
    const { manager } = createMuseRuntimeAssembly().mcp;
    await manager.initializeFromStore();
    const connected = await manager.connect(CHROME_DEVTOOLS_MCP_SERVER_NAME);
    if (!connected) return undefined;
    return chromeSnapshotConnectionFromTools(manager.toMuseTools());
  } catch {
    return undefined;
  }
}

// Best-effort real ambient enricher: when
// MUSE_BRIEFING_RELATED_KNOWLEDGE_ENABLED, build createKnowledgeEnricher
// over the user's notes dir + a local Ollama embedder (hybrid+MMR
// retrieval), so an ambient notice's "Related" line is a real note.
// Any failure (no Ollama, no notes) → undefined → plain notices.
async function defaultKnowledgeEnrich(env: NodeJS.ProcessEnv): Promise<((query: string) => Promise<string | undefined>) | undefined> {
  if (!parseBoolean(env.MUSE_BRIEFING_RELATED_KNOWLEDGE_ENABLED, false)) return undefined;
  try {
    const { createKnowledgeEnricher, createOllamaEmbedder, resolveNotesDir } = await import("@muse/autoconfigure");
    const { LocalDirNotesProvider } = await import("@muse/mcp");
    const notesDir = resolveNotesDir(env as unknown as Parameters<typeof resolveNotesDir>[0]);
    return createKnowledgeEnricher({
      embed: createOllamaEmbedder(env.MUSE_KNOWLEDGE_SEARCH_EMBED_MODEL?.trim() ?? DEFAULT_EMBED_MODEL),
      notesProvider: new LocalDirNotesProvider({ notesDir })
    });
  } catch {
    return undefined;
  }
}

export function registerDaemonCommands(program: Command, io: ProgramIO, helpers: DaemonHelpers = {}): void {
  const env = () => helpers.env?.() ?? process.env;
  const makeMessaging = helpers.buildMessagingRegistry ?? ((e: NodeJS.ProcessEnv) => buildMessagingRegistry(e));

  program
    .command("daemon")
    .description("Run Muse's background daemon (proactive notices) in one process. --once runs a single tick and exits.")
    .option("--once", "Run exactly one tick of each enabled daemon, then exit")
    .option("--print", "Also echo every delivered notice to stdout (watch the daemon work in the foreground)")
    .option("--status", "Print which daemon ticks are enabled for the current config, then exit")
    .option("--init", "Write the resolved provider + destination to the daemon config file, then exit")
    .option("--install", "Write a macOS LaunchAgent plist so the daemon survives logout/reboot, then exit")
    .option("--interval <seconds>", "Tick interval in seconds (default 60)", "60")
    .option("--lead-minutes <minutes>", "Imminent-window lead in minutes (default 10)", "10")
    .option("--provider <id>", "Messaging provider id (default MUSE_PROACTIVE_PROVIDER, else 'log')")
    .option("--destination <id>", "Messaging destination — chat/channel id or log tag (default MUSE_PROACTIVE_DESTINATION or '@me')")
    .action(async (options: {
      readonly once?: boolean;
      readonly print?: boolean;
      readonly status?: boolean;
      readonly init?: boolean;
      readonly install?: boolean;
      readonly interval: string;
      readonly leadMinutes: string;
      readonly provider?: string;
      readonly destination?: string;
    }) => {
      const e = env();
      const interval = parseBoundedFlag(options.interval, "--interval", 5, 86_400, 60);
      const leadMinutes = parseBoundedFlag(options.leadMinutes, "--lead-minutes", 1, 1_440, 10);
      // Precedence: flag > env > config file > hardcoded default. The
      // config file (muse daemon --init) lets the user persist
      // provider/destination once instead of exporting env vars.
      const configFile = resolveDaemonConfigFile(e);
      const fileConfig = readDaemonConfig(configFile);
      const provider = (options.provider ?? e.MUSE_PROACTIVE_PROVIDER ?? fileConfig.provider ?? "log").trim();
      const destination = (options.destination ?? e.MUSE_PROACTIVE_DESTINATION ?? fileConfig.destination ?? "@me").trim();

      if (options.init) {
        writeDaemonConfig(configFile, { destination, provider });
        io.stdout(`muse daemon config written to ${configFile}\n  provider=${provider}, destination=${destination}\n`);
        return;
      }

      if (options.install) {
        const plistFile = resolveLaunchAgentFile(e);
        const home = e.HOME?.trim()?.length ? e.HOME.trim() : homedir();
        const logDir = join(home, ".muse", "logs");
        // argv[1] is the muse CLI entry at runtime; node + that path
        // gives launchd an absolute, login-shell-independent command.
        const cliEntry = process.argv[1] ?? "muse";
        const plist = buildLaunchAgentPlist({
          label: LAUNCH_AGENT_LABEL,
          programArguments: [process.execPath, cliEntry, "daemon"],
          stderrPath: join(logDir, "daemon.err.log"),
          stdoutPath: join(logDir, "daemon.out.log")
        });
        mkdirSync(dirname(plistFile), { recursive: true });
        writeFileSync(plistFile, plist, "utf8");
        io.stdout(`muse daemon LaunchAgent written to ${plistFile}\n  load it with:  launchctl load -w ${plistFile}\n  logs: ${logDir}\n`);
        return;
      }

      const baseMessagingRegistry = makeMessaging(e);
      if (!baseMessagingRegistry.has(provider)) {
        const known = baseMessagingRegistry.list().map((p) => p.id);
        const suggestion = closestCommandName(provider, known);
        const hint = suggestion ? ` — did you mean --provider ${suggestion}?` : "";
        io.stderr(`Provider '${provider}' is not registered${hint}. Try --provider log (always available).\n`);
        process.exitCode = 1;
        return;
      }
      // --print echoes every delivered notice to stdout too, so a
      // user running `muse daemon` in the foreground watches it work
      // inline — JARVIS speaking in the room, not only to the channel.
      const messagingRegistry: MessagingProviderRegistry = options.print
        ? new Proxy(baseMessagingRegistry, {
            get(target, prop, receiver) {
              if (prop === "send") {
                return async (providerId: string, message: { destination: string; text: string }) => {
                  const result = await target.send(providerId, message);
                  io.stdout(`  📨 ${message.destination}: ${message.text}\n`);
                  return result;
                };
              }
              return Reflect.get(target, prop, receiver);
            }
          })
        : baseMessagingRegistry;

      const calendarRegistry = buildCalendarRegistry(e);
      const tasksFile = resolveTasksFile(e);
      const historyFile = resolveProactiveHistoryFile(e);
      const sidecarFile = e.MUSE_PROACTIVE_SIDECAR_FILE?.trim()?.length
        ? e.MUSE_PROACTIVE_SIDECAR_FILE.trim()
        : join(homedir(), ".muse", "proactive-fired.json");
      const trustLedgerFile = e.MUSE_PROACTIVE_TRUST_FILE?.trim()?.length
        ? e.MUSE_PROACTIVE_TRUST_FILE.trim()
        : join(homedir(), ".muse", "proactive-trust.json");
      const dailyCapRaw = e.MUSE_PROACTIVE_DAILY_CAP ? Number(e.MUSE_PROACTIVE_DAILY_CAP) : 0;
      const dailyCap = Number.isFinite(dailyCapRaw) && dailyCapRaw > 0 ? Math.trunc(dailyCapRaw) : 0;
      const followupsFile = resolveFollowupsFile(e);
      const remindersFile = resolveRemindersFile(e);
      const followupModel = await (helpers.resolveFollowupModel ?? defaultFollowupModel)(e);

      // Shared sink: every perception tick (ambient, web-watch, home-watch)
      // routes its notice to the same messaging destination as proactive.
      const rawNoticeSink: ProactiveNoticeSink = {
        deliver: async (notice) => {
          await messagingRegistry.send(provider, {
            destination,
            text: `${notice.title}: ${notice.text}`
          });
        }
      };
      // Quiet hours (do-not-disturb): suppress ambient/awareness chatter
      // during the window so the resident daemon doesn't ping at 3am. Only
      // gates this sink (ambient/web-watch/home-watch) — user-scheduled
      // reminders/follow-ups fire on their own path and are unaffected, so an
      // urgent "pay rent today" reminder still comes through. Same window
      // parser the API ticks use.
      const quietHours = parseQuietHours(e.MUSE_PROACTIVE_QUIET_HOURS?.trim() || e.MUSE_REMINDER_QUIET_HOURS?.trim());
      const noticeSink: ProactiveNoticeSink = gateProactiveNoticeSink(rawNoticeSink, {
        ...(quietHours ? { quietHours } : {}),
        onSuppress: options.print
          ? (notice): void => io.stdout(`  🌙 quiet hours — held: ${notice.title}\n`)
          : undefined
      });

      // Shared knowledge enricher (ambient "Related" line + briefing
      // related-note) — resolved once, reused by both ticks.
      const knowledgeEnrich = helpers.knowledgeEnrich ?? await defaultKnowledgeEnrich(e);

      // Ambient perception is rule-based (no model). Active only when
      // MUSE_AMBIENT_RULES is configured; otherwise the tick is skipped.
      const ambientRaw = e.MUSE_AMBIENT_RULES?.trim();
      let ambientRunner: AmbientNoticeRunner | undefined;
      if (ambientRaw) {
        let ambientRules: ReturnType<typeof parseAmbientNoticeRules>;
        try {
          ambientRules = parseAmbientNoticeRules(ambientRaw);
        } catch {
          ambientRules = [];
        }
        if (ambientRules.length > 0) {
          // Real macOS active-window perception when opted in on darwin
          // (or whenever a test injects the osascript runner); otherwise
          // the file source an external OS helper writes.
          const useMacos = e.MUSE_AMBIENT_SOURCE?.trim() === "macos"
            && (helpers.ambientMacosRun !== undefined || process.platform === "darwin");
          let ambientSource;
          if (useMacos) {
            ambientSource = new MacOsActiveWindowSource({
              includeClipboard: parseBoolean(e.MUSE_AMBIENT_CLIPBOARD, false),
              ...(helpers.ambientMacosRun ? { run: helpers.ambientMacosRun } : {})
            });
            io.stdout(`  ambient source: macOS active window\n`);
          } else {
            const ambientFile = e.MUSE_AMBIENT_FILE?.trim()?.length
              ? e.MUSE_AMBIENT_FILE.trim()
              : join(homedir(), ".muse", "ambient.json");
            ambientSource = new FileAmbientSignalSource(ambientFile);
          }
          ambientRunner = createAmbientNoticeRunner({
            rules: ambientRules,
            sink: noticeSink,
            source: ambientSource,
            ...(knowledgeEnrich ? { enrich: knowledgeEnrich } : {})
          });
        }
      }

      // Web-watch is read-only page polling. Active only when
      // MUSE_WEB_WATCH_CONFIG is configured; otherwise the tick is skipped.
      const webWatchRaw = e.MUSE_WEB_WATCH_CONFIG?.trim();
      let webWatchRunner: WebWatchRunner | undefined;
      if (webWatchRaw) {
        const chromeConnection = helpers.chromeConnection ?? await defaultChromeConnection(e);
        const watches = webWatchesFromConfig(webWatchRaw, {
          ...(helpers.fetchImpl ? { fetchImpl: helpers.fetchImpl } : {}),
          ...(chromeConnection ? { chromeConnection } : {})
        });
        if (watches.length > 0) {
          webWatchRunner = createWebWatchRunner({ sink: noticeSink, watches });
        }
      }

      // Home-watch: read-only Home Assistant entity-state polling (e.g.
      // "front door unlocked"). Active only with config + HA creds; a
      // firing watch never acts on the home (outbound-safety).
      const homeWatchRaw = e.MUSE_HOME_WATCH_CONFIG?.trim();
      const haBaseUrl = e.MUSE_HOMEASSISTANT_URL?.trim();
      const haToken = e.MUSE_HOMEASSISTANT_TOKEN?.trim();
      let homeWatchRunner: WebWatchRunner | undefined;
      if (homeWatchRaw && haBaseUrl && haToken) {
        const homeWatches = homeWatchesFromConfig(homeWatchRaw, {
          baseUrl: haBaseUrl,
          token: haToken,
          ...(helpers.fetchImpl ? { fetchImpl: helpers.fetchImpl } : {})
        });
        if (homeWatches.length > 0) {
          homeWatchRunner = createWebWatchRunner({ sink: noticeSink, watches: homeWatches });
        }
      }

      // Standing objectives re-evaluate via the model and notify on the
      // same channel when met. Needs a model — skipped without one.
      const objectivesFile = resolveObjectivesFile(e);
      // Draft-first mode (MUSE_OBJECTIVES_PROPOSE): a met objective
      // PROPOSES its message for the user to confirm (`muse propose`)
      // instead of the daemon sending it autonomously.
      const proposedActionsFile = e.MUSE_PROPOSED_ACTIONS_FILE?.trim()?.length
        ? e.MUSE_PROPOSED_ACTIONS_FILE.trim()
        : join(homedir(), ".muse", "proposed-actions.json");
      const objectivesActuator = !followupModel
        ? undefined
        : parseBoolean(e.MUSE_OBJECTIVES_PROPOSE, false)
          ? createProposingObjectiveActuator({ destination, providerId: provider, proposedActionsFile })
          : createMessagingObjectiveActuator({ destination, providerId: provider, registry: messagingRegistry });
      const objectivesEvaluate = followupModel
        ? createModelObjectiveEvaluator({ model: followupModel.model, modelProvider: followupModel.modelProvider })
        : undefined;

      if (options.status) {
        io.stdout(`muse daemon — readiness (provider=${provider}, destination=${destination}):\n`);
        io.stdout(`  proactive:  enabled\n`);
        io.stdout(`  reminders:  enabled\n`);
        io.stdout(`  followup:   ${followupModel ? "enabled" : "disabled (no model resolved)"}\n`);
        io.stdout(`  ambient:    ${ambientRunner ? "enabled" : "disabled (set MUSE_AMBIENT_RULES)"}\n`);
        io.stdout(`  web-watch:  ${webWatchRunner ? "enabled" : "disabled (set MUSE_WEB_WATCH_CONFIG)"}\n`);
        io.stdout(`  home-watch: ${homeWatchRunner ? "enabled" : "disabled (set MUSE_HOME_WATCH_CONFIG + HA creds)"}\n`);
        io.stdout(`  objectives: ${objectivesEvaluate && objectivesActuator ? "enabled" : "disabled (no model resolved)"}\n`);
        io.stdout(`  briefing:   ${parseBoolean(e.MUSE_BRIEFING_ENABLED, false) ? "enabled" : "disabled (set MUSE_BRIEFING_ENABLED)"}\n`);
        io.stdout(`  self-learn: ${parseBoolean(e.MUSE_SELFLEARN_ENABLED, false) && followupModel ? "enabled (distill + decay + consolidate)" : "disabled (set MUSE_SELFLEARN_ENABLED + a model)"}\n`);
        io.stdout(`  recap:      ${parseBoolean(e.MUSE_RECAP_ENABLED, false) ? `enabled (evening, after ${(e.MUSE_RECAP_HOUR ?? "21").toString()}:00)` : "disabled (set MUSE_RECAP_ENABLED)"}\n`);
        io.stdout(`  email-sync: ${parseBoolean(e.MUSE_EMAIL_SYNC_ENABLED, false) && e.MUSE_GMAIL_TOKEN?.trim() ? "enabled (recent emails → recall)" : "disabled (set MUSE_EMAIL_SYNC_ENABLED + MUSE_GMAIL_TOKEN)"}\n`);
        io.stdout(`  msg-poll:   ${parseBoolean(e.MUSE_MESSAGING_POLL_ENABLED, false) ? "enabled (new inbound → recallable)" : "disabled (set MUSE_MESSAGING_POLL_ENABLED)"}\n`);
        io.stdout(`  conflicts:  ${parseBoolean(e.MUSE_CONFLICT_WATCH_ENABLED, false) ? `enabled (warns of upcoming double-bookings, next ${(e.MUSE_CONFLICT_WATCH_WITHIN_DAYS ?? "7").toString()}d)` : "disabled (set MUSE_CONFLICT_WATCH_ENABLED)"}\n`);
        // The resolved source paths — the first thing to check when a
        // tick "isn't firing": is it reading the file you think it is?
        io.stdout(`sources:\n`);
        io.stdout(`  config:     ${configFile}\n`);
        io.stdout(`  tasks:      ${tasksFile}\n`);
        io.stdout(`  reminders:  ${remindersFile}\n`);
        io.stdout(`  followups:  ${followupsFile}\n`);
        io.stdout(`  objectives: ${objectivesFile}\n`);
        // Will it come back after a reboot? (launchd install)
        const plistFile = resolveLaunchAgentFile(e);
        io.stdout(existsSync(plistFile)
          ? `autostart:    installed (${plistFile})\n`
          : `autostart:    not installed (run \`muse daemon --install\`)\n`);
        return;
      }

      const proactiveInvestigator = createIndexedProactiveInvestigator();
      const proactiveTick = async (): Promise<void> => {
        const summary = await runDueProactiveNotices({
          ...(calendarRegistry.list().length > 0 ? { calendarRegistry } : {}),
          destination,
          historyFile,
          investigate: proactiveInvestigator,
          leadMinutes,
          messagingRegistry,
          providerId: provider,
          ...(quietHours ? { quietHours } : {}),
          sidecarFile,
          tasksFile,
          trustLedgerFile,
          ...(dailyCap > 0 ? { dailyCap } : {})
        });
        const tag = `[${new Date().toISOString()}]`;
        io.stdout(`${tag} proactive: fired ${summary.fired.toString()}/${summary.imminent.toString()} imminent`);
        if (summary.errors.length > 0) {
          io.stdout(`, ${summary.errors.length.toString()} error(s)`);
          for (const error of summary.errors) {
            io.stdout(`\n  ! ${error}`);
          }
        }
        io.stdout("\n");
      };

      const remindersTick = async (): Promise<void> => {
        const summary = await runDueReminders({
          destination,
          file: remindersFile,
          providerId: provider,
          registry: messagingRegistry
        });
        const tag = `[${new Date().toISOString()}]`;
        io.stdout(`${tag} reminders: fired ${summary.delivered.toString()}/${summary.due.toString()} due`);
        if (summary.errors.length > 0) {
          io.stdout(`, ${summary.errors.length.toString()} error(s)`);
          for (const error of summary.errors) {
            io.stdout(`\n  ! ${error}`);
          }
        }
        io.stdout("\n");
      };

      const followupTick = async (): Promise<void> => {
        if (!followupModel) {
          io.stdout(`[${new Date().toISOString()}] followup: skipped (no model resolved)\n`);
          return;
        }
        const summary = await runDueFollowups({
          destination,
          file: followupsFile,
          model: followupModel.model,
          modelProvider: followupModel.modelProvider,
          providerId: provider,
          registry: messagingRegistry
        });
        const tag = `[${new Date().toISOString()}]`;
        io.stdout(`${tag} followup: fired ${summary.delivered.toString()}/${summary.due.toString()} due`);
        if (summary.errors.length > 0) {
          io.stdout(`, ${summary.errors.length.toString()} error(s)`);
          for (const error of summary.errors) {
            io.stdout(`\n  ! ${error}`);
          }
        }
        io.stdout("\n");
      };

      const checkinsTick = async (): Promise<void> => {
        const summary = await runDueCheckins({
          destination,
          file: checkinsFile(e),
          providerId: provider,
          registry: messagingRegistry,
          ...(quietHours ? { quietHours } : {})
        });
        const tag = `[${new Date().toISOString()}]`;
        io.stdout(`${tag} checkins: fired ${summary.delivered.toString()}/${summary.due.toString()} due`);
        if (summary.errors.length > 0) {
          io.stdout(`, ${summary.errors.length.toString()} error(s)`);
          for (const error of summary.errors) io.stdout(`\n  ! ${error}`);
        }
        io.stdout("\n");
      };

      const renderPatternFacts = (match: PatternMatch): string =>
        match.category === "weekly-task"
          ? `weekly recurring task on ${match.bucket.weekday}; recent: ${match.relatedTitles.slice(0, 3).join("; ")}; ${match.bucket.matches.toString()}× over ${match.bucket.distinctWeeks.toString()} weeks`
          : `recurring action: ${match.bucket.weekday} ${match.bucket.hourBand}, area "${match.bucket.pathFamily}"; ${match.bucket.matches.toString()}× over ${match.bucket.distinctDays.toString()} days`;

      const patternTick = async (): Promise<void> => {
        if (quietHours && isQuietHour(new Date().getHours(), quietHours)) {
          io.stdout(`[${new Date().toISOString()}] pattern: held (quiet hours)\n`);
          return;
        }
        // SDT criterion (Green & Swets): the pattern category's firing floor
        // adapts to the user's OWN response history — dismiss-heavy raises it,
        // acted-on lowers it. Fail-soft to the default floor on any error.
        let minConfidence: number | undefined;
        try {
          const history = await readProactiveHistory(resolveProactiveHistoryFile(e));
          const stats = summarizeNoticeResponses(history.map((entry) => ({ kind: entry.kind, text: entry.text })));
          const patternStats = stats.get("pattern");
          if (patternStats && patternStats.acted + patternStats.dismissed >= 3) {
            minConfidence = adjustConfidenceFloor(0.7, sdtCriterion(patternStats));
          }
        } catch { /* default floor */ }
        const summary = await runDuePatternNotices({
          destination,
          patternsFiredFile: resolvePatternsFiredFile(e),
          ...(minConfidence !== undefined ? { select: { minConfidence } } : {}),
          providerId: provider,
          registry: messagingRegistry,
          ...(followupModel
            ? {
                composeSuggestion: (match: PatternMatch): Promise<string | undefined> =>
                  synthesizePatternSuggestion(
                    {
                      category: match.category,
                      confidence: match.confidence,
                      fallbackSuggestion: match.suggestion,
                      groundedFacts: renderPatternFacts(match)
                    },
                    {
                      model: followupModel.model,
                      modelProvider: followupModel.modelProvider as Parameters<typeof synthesizePatternSuggestion>[1]["modelProvider"]
                    }
                  )
              }
            : {})
        });
        io.stdout(`[${new Date().toISOString()}] pattern: delivered ${summary.delivered.toString()}/${summary.fireable.toString()} fireable\n`);
      };

      const ambientTick = async (): Promise<void> => {
        if (!ambientRunner) {
          io.stdout(`[${new Date().toISOString()}] ambient: skipped (no rules)\n`);
          return;
        }
        const summary = await ambientRunner.tick();
        io.stdout(`[${new Date().toISOString()}] ambient: delivered ${summary.delivered.toString()}\n`);
      };

      const webWatchTick = async (): Promise<void> => {
        if (!webWatchRunner) {
          io.stdout(`[${new Date().toISOString()}] web-watch: skipped (no config)\n`);
          return;
        }
        const summary = await webWatchRunner.tick();
        io.stdout(`[${new Date().toISOString()}] web-watch: delivered ${summary.delivered.toString()}\n`);
      };

      const objectivesTick = async (): Promise<void> => {
        if (!objectivesEvaluate || !objectivesActuator) {
          io.stdout(`[${new Date().toISOString()}] objectives: skipped (no model resolved)\n`);
          return;
        }
        const summary = await runDueObjectives({
          act: objectivesActuator.act,
          escalate: objectivesActuator.escalate,
          evaluate: objectivesEvaluate,
          file: objectivesFile
        });
        const tag = `[${new Date().toISOString()}]`;
        io.stdout(`${tag} objectives: ${summary.fired.length.toString()} fired, ${summary.escalated.length.toString()} escalated of ${summary.due.toString()} due`);
        if (summary.errors.length > 0) {
          io.stdout(`, ${summary.errors.length.toString()} error(s)`);
          for (const error of summary.errors) {
            io.stdout(`\n  ! ${error}`);
          }
        }
        io.stdout("\n");
      };

      const homeWatchTick = async (): Promise<void> => {
        if (!homeWatchRunner) {
          io.stdout(`[${new Date().toISOString()}] home-watch: skipped (no config)\n`);
          return;
        }
        const summary = await homeWatchRunner.tick();
        io.stdout(`[${new Date().toISOString()}] home-watch: delivered ${summary.delivered.toString()}\n`);
      };

      // Situational briefing — a periodic digest (objective status +
      // imminent tasks + a related note), self-deduped by its sidecar
      // (default 4h window). Opt-in via MUSE_BRIEFING_ENABLED.
      const briefingTick = async (): Promise<void> => {
        if (!parseBoolean(e.MUSE_BRIEFING_ENABLED, false)) {
          io.stdout(`[${new Date().toISOString()}] briefing: skipped (set MUSE_BRIEFING_ENABLED)\n`);
          return;
        }
        const now = new Date();
        let imminent: Awaited<ReturnType<typeof deriveBriefingImminent>> = [];
        try {
          imminent = await deriveBriefingImminent(tasksFile, { leadMinutes, now });
        } catch { /* fail-soft — brief objective status only */ }
        const calendarLister = helpers.briefingCalendarLister
          ?? (calendarRegistry.list().length > 0 ? (range: Parameters<BriefingCalendarLister>[0]) => calendarRegistry.listEvents(range) : undefined);
        if (calendarLister) {
          try {
            imminent = [...imminent, ...(await deriveCalendarBriefingImminent(calendarLister, { leadMinutes, now }))];
          } catch { /* fail-soft — calendar unavailable */ }
        }
        const summary = await runDueSituationalBriefing({
          birthdayLine: async () => {
            try {
              const contacts = await queryContacts(resolveContactsFile(e));
              return formatBirthdayBriefLine(resolveUpcomingBirthdays(contacts, { now, withinDays: 7 }));
            } catch {
              return undefined;
            }
          },
          destination,
          imminent,
          messagingRegistry,
          now: () => now,
          objectivesFile,
          providerId: provider,
          sidecarFile: e.MUSE_BRIEFING_SIDECAR_FILE?.trim()?.length
            ? e.MUSE_BRIEFING_SIDECAR_FILE.trim()
            : join(homedir(), ".muse", "briefing-fired.json"),
          ...(knowledgeEnrich ? { relatedKnowledge: knowledgeEnrich } : {})
        });
        io.stdout(`[${now.toISOString()}] briefing: ${summary.delivered > 0 ? "delivered" : "quiet (deduped or nothing to say)"}\n`);
      };

      // Grounded "dreaming" — the daemon synthesises reflections from recent
      // episodes while idle. Off by default; throttled to a slow cadence
      // (default 6h) so it isn't a model call every tick. Silent unless it adds.
      const reflectionIntervalRaw = e.MUSE_REFLECTION_INTERVAL_MS ? Number(e.MUSE_REFLECTION_INTERVAL_MS) : DEFAULT_REFLECTION_INTERVAL_MS;
      const reflectionIntervalMs = Number.isFinite(reflectionIntervalRaw) && reflectionIntervalRaw > 0 ? reflectionIntervalRaw : DEFAULT_REFLECTION_INTERVAL_MS;
      let lastReflectionMs: number | undefined;
      const reflectionTick = async (): Promise<void> => {
        if (!parseBoolean(e.MUSE_REFLECTION_ENABLED, false) || !followupModel) return;
        const nowMs = Date.now();
        if (!shouldRunReflection(lastReflectionMs, nowMs, reflectionIntervalMs)) return;
        lastReflectionMs = nowMs;
        try {
          const episodes = (await readEpisodes(resolveEpisodesFile(e))).slice(-30);
          const inputs = episodes.map((ep) => ({ id: ep.id, text: ep.summary }));
          const added = await runReflectionPass(inputs, {
            model: followupModel.model,
            modelProvider: followupModel.modelProvider as Parameters<typeof runReflectionPass>[1]["modelProvider"],
            reflectionsFile: resolveReflectionsFile(e),
            embed: createGateEmbedder(e)
          });
          if (added > 0) io.stdout(`[${new Date(nowMs).toISOString()}] reflections: +${added.toString()} (see \`muse reflections\`)\n`);
        } catch { /* fail-soft — dreaming is a background nicety */ }
      };

      // Continuous email ingestion — the always-on half of `muse email sync`: the
      // daemon pulls recent inbox emails into recallable notes on its own tick, so
      // your email is kept in the cited-recall corpus WITHOUT a manual command (the
      // map's "always-on connector" gap; mirrors the messaging poll). Opt-in
      // (MUSE_EMAIL_SYNC_ENABLED + MUSE_GMAIL_TOKEN), interval-throttled, fail-soft
      // (a Gmail blip never breaks the daemon). Read-only + written locally as notes.
      const DEFAULT_EMAIL_SYNC_INTERVAL_MS = 15 * 60 * 1000;
      const emailSyncIntervalRaw = e.MUSE_EMAIL_SYNC_INTERVAL_MS ? Number(e.MUSE_EMAIL_SYNC_INTERVAL_MS) : DEFAULT_EMAIL_SYNC_INTERVAL_MS;
      const emailSyncIntervalMs = Number.isFinite(emailSyncIntervalRaw) && emailSyncIntervalRaw > 0 ? emailSyncIntervalRaw : DEFAULT_EMAIL_SYNC_INTERVAL_MS;
      const emailSyncLimitRaw = e.MUSE_EMAIL_SYNC_LIMIT ? Number(e.MUSE_EMAIL_SYNC_LIMIT) : 20;
      const emailSyncLimit = Number.isFinite(emailSyncLimitRaw) && emailSyncLimitRaw > 0 ? Math.min(100, Math.trunc(emailSyncLimitRaw)) : 20;
      let lastEmailSyncMs: number | undefined;
      const emailSyncTick = async (): Promise<void> => {
        if (!parseBoolean(e.MUSE_EMAIL_SYNC_ENABLED, false)) return;
        const token = e.MUSE_GMAIL_TOKEN?.trim();
        const provider = helpers.emailSyncProvider ?? (token ? new GmailEmailProvider(token) : undefined);
        if (!provider) return; // opt-in: no token, no sync
        const nowMs = Date.now();
        if (lastEmailSyncMs !== undefined && nowMs - lastEmailSyncMs < emailSyncIntervalMs) return;
        lastEmailSyncMs = nowMs;
        try {
          const written = await syncEmailsToNotes(provider, resolveNotesDir(e), emailSyncLimit);
          if (written > 0) io.stdout(`[${new Date(nowMs).toISOString()}] email-sync: ${written.toString()} email(s) → recall (ask about them with \`muse ask\`)\n`);
        } catch { /* fail-soft — a Gmail blip must never break the daemon */ }
      };

      // Unattended learning — the daemon distills the corrections you made in
      // past sessions (queued at correction time) into learned strategies with
      // NO manual `muse playbook distill`. Off by default; brake-first (the
      // learning-pause kill switch is checked inside distillQueuedCorrections,
      // one distill per tick); every write lands on PROBATION until a real
      // reinforce graduates it. Silent unless it actually learns something.
      const DEFAULT_SELFLEARN_INTERVAL_MS = 5 * 60 * 1000;
      const selfLearnIntervalRaw = e.MUSE_SELFLEARN_INTERVAL_MS ? Number(e.MUSE_SELFLEARN_INTERVAL_MS) : DEFAULT_SELFLEARN_INTERVAL_MS;
      const selfLearnIntervalMs = Number.isFinite(selfLearnIntervalRaw) && selfLearnIntervalRaw > 0 ? selfLearnIntervalRaw : DEFAULT_SELFLEARN_INTERVAL_MS;
      let lastSelfLearnMs: number | undefined;
      const selfLearnTick = async (): Promise<void> => {
        if (!parseBoolean(e.MUSE_SELFLEARN_ENABLED, false) || !followupModel) return;
        const nowMs = Date.now();
        if (lastSelfLearnMs !== undefined && nowMs - lastSelfLearnMs < selfLearnIntervalMs) return;
        lastSelfLearnMs = nowMs;
        try {
          const playbookFile = resolvePlaybookFile(e);
          // Snapshot probation BEFORE distill so we can act ONLY on this tick's
          // new corrections (the subtractive decay below is driven by what you
          // JUST corrected, not the whole bank re-scanned every tick).
          const probationBefore = new Set(
            (await queryPlaybook(playbookFile)).filter((p) => p.probation === true).map((p) => p.id)
          );
          const recorded = await distillQueuedCorrections({
            model: followupModel.model,
            modelProvider: followupModel.modelProvider as DistillQueuedDeps["modelProvider"],
            embed: createGateEmbedder(e),
            queueFile: resolveLearnQueueFile(e),
            playbookFile,
            suppressedLessonsFile: resolveSuppressedLessonsFile(e),
            pauseFile: resolveLearningPauseFile(e),
            ...(helpers.selfLearnDistill ? { distill: helpers.selfLearnDistill } : {})
          });
          if (recorded > 0) {
            io.stdout(`[${new Date(nowMs).toISOString()}] learned: +${recorded.toString()} strateg${recorded === 1 ? "y" : "ies"} from your corrections (see \`muse learned\`)\n`);
            // FELT self-learning: deliver the autonomous-learning event
            // to the user's CHANNEL — not just this console they don't watch —
            // so a background daemon's learning is PERCEIVED, not silent (loop-v2
            // "felt self-learning"). Quiet-hours-gated + fail-soft like every
            // notice. SAFE: the strategy stays PROBATION — this only SURFACES it,
            // never auto-applies it (the honesty-sensitive injection path is
            // untouched; nothing graduates without the user's own reinforce).
            await noticeSink.deliver({
              kind: "self-learn",
              text: `I noted ${recorded.toString()} strateg${recorded === 1 ? "y" : "ies"} from how you've corrected me lately — review with \`muse learned\` (nothing changes how I answer until you reinforce it).`,
              title: "Learned from your corrections"
            });
          }
          // Subtractive correction-decay: a NEW correction that
          // CONTRADICTS a strategy Muse currently APPLIES drops that strategy
          // below the inject line, unattended, so a LATER session stops applying
          // it. SIGN-SAFE: decay-only (never graduates), polarity-gated +
          // fail-closed (only a confident `contradict` acts), injected-only,
          // brake-first; reversible by a `muse playbook reward`.
          const newProbation = (await queryPlaybook(playbookFile))
            .filter((p) => p.probation === true && !probationBefore.has(p.id));
          if (newProbation.length > 0) {
            // Single-user daemon: this tick's new corrections are one user's. Decay
            // that user's injected strategies the corrections contradict.
            const userId = newProbation[0]!.userId;
            const decayed = await decayContradictedStrategies({
              corrections: newProbation.filter((p) => p.userId === userId).map((p) => ({ id: p.id, text: p.source ?? p.text })),
              model: followupModel.model,
              modelProvider: followupModel.modelProvider as DecayContradictedDeps["modelProvider"],
              pauseFile: resolveLearningPauseFile(e),
              playbookFile,
              userId,
              ...(helpers.contradictionClassify ? { classify: helpers.contradictionClassify } : {})
            });
            if (decayed.length > 0) {
              const first = decayed[0]!;
              io.stdout(`[${new Date(nowMs).toISOString()}] unlearned: stopped applying ${decayed.length.toString()} strateg${decayed.length === 1 ? "y" : "ies"} you contradicted (see \`muse learned\`)\n`);
              await noticeSink.deliver({
                kind: "self-learn",
                text: decayed.length === 1
                  ? `You corrected me, so I've stopped applying "${first.text}" going forward. If that was wrong, reinforce it with \`muse playbook reward ${first.id}\`.`
                  : `You corrected me, so I've stopped applying ${decayed.length.toString()} preferences I was using (see \`muse learned\`). Reinforce any I got wrong with \`muse playbook reward <id>\`.`,
                title: "Stopped applying a contradicted preference"
              });
            }
          }
        } catch { /* fail-soft — background learning must never break the daemon */ }
      };

      // Disuse-decay — the FORGETTING half of continuous RL over the learned
      // bank (slice 1 distills new strategies; this fades old ones). A
      // positive-reward strategy you stopped using sinks back toward neutral so
      // a one-off thumbs-up can't steer the agent forever. Same MUSE_SELFLEARN
      // switch + the learning-pause brake (a paused user's bank is frozen);
      // model-free, so it runs without a model, on a slow daily cadence.
      const DEFAULT_SELFLEARN_DECAY_INTERVAL_MS = 24 * 60 * 60 * 1000;
      const decayIntervalRaw = e.MUSE_SELFLEARN_DECAY_INTERVAL_MS ? Number(e.MUSE_SELFLEARN_DECAY_INTERVAL_MS) : DEFAULT_SELFLEARN_DECAY_INTERVAL_MS;
      const decayIntervalMs = Number.isFinite(decayIntervalRaw) && decayIntervalRaw > 0 ? decayIntervalRaw : DEFAULT_SELFLEARN_DECAY_INTERVAL_MS;
      let lastDecayMs: number | undefined;
      const selfLearnDecayTick = async (): Promise<void> => {
        if (!parseBoolean(e.MUSE_SELFLEARN_ENABLED, false)) return;
        const nowMs = Date.now();
        if (lastDecayMs !== undefined && nowMs - lastDecayMs < decayIntervalMs) return;
        lastDecayMs = nowMs;
        try {
          if (await isLearningPaused(resolveLearningPauseFile(e))) return; // brake: paused ⇒ bank frozen
          const playbookFile = resolvePlaybookFile(e);
          const beforeReward = new Map((await queryPlaybook(playbookFile)).map((s) => [s.id, s.reward ?? 0]));
          const decayed = await decayStalePlaybookRewards(playbookFile, { nowMs });
          if (decayed > 0) {
            io.stdout(`[${new Date(nowMs).toISOString()}] decay: ${decayed.toString()} stale strateg${decayed === 1 ? "y" : "ies"} faded toward neutral\n`);
            // FELT forgetting: when a preference you TAUGHT crosses from
            // healthy into near-forgotten (reward >1 → ≤1) purely from disuse, tell
            // you so you can RESCUE it before it's gone — the symmetric other half
            // of the learned-notice (slice 4). SAFE: surfacing only; the decay
            // itself is the existing model-free RL, untouched.
            const fading = (await queryPlaybook(playbookFile))
              .filter((s) => { const prev = beforeReward.get(s.id); return prev !== undefined && prev > 1 && (s.reward ?? 0) <= 1; })
              .sort((a, b) => (a.reward ?? 0) - (b.reward ?? 0))[0];
            if (fading) {
              await noticeSink.deliver({
                kind: "self-learn-decay",
                text: `A preference you taught me — "${fading.text}" — is fading from disuse. Reinforce it with \`muse playbook reward ${fading.id.slice(0, 8)}\` to keep it.`,
                title: "A preference is fading"
              });
            }
          }
        } catch { /* fail-soft — background maintenance must never break the daemon */ }
      };

      // Autonomous playbook CONSOLIDATE — the unattended distill (slice 1) writes
      // PROBATION strategies; exact/lexical near-duplicates are deduped at write
      // time, but SEMANTIC paraphrases the lexical dedup misses still accumulate.
      // This merges near-duplicate PROBATION strategies into one via the LLM
      // merger behind the SkillOpt held-out coverage gate (a merge commits only
      // if the result still covers every original; else the originals are kept).
      // SAFETY: it operates ONLY on probation strategies and the merged strategy
      // STAYS on probation — autonomous consolidation NEVER graduates a guess
      // into the injected block (graduation stays bound to a positive user act),
      // and the graduated/injected bank is never touched. Brake-first: ≤1 cluster
      // per tick, the same MUSE_SELFLEARN switch + learning-pause brake, off
      // without a model.
      const DEFAULT_SELFLEARN_CONSOLIDATE_INTERVAL_MS = 6 * 60 * 60 * 1000;
      const consolidateIntervalRaw = e.MUSE_SELFLEARN_CONSOLIDATE_INTERVAL_MS ? Number(e.MUSE_SELFLEARN_CONSOLIDATE_INTERVAL_MS) : DEFAULT_SELFLEARN_CONSOLIDATE_INTERVAL_MS;
      const consolidateIntervalMs = Number.isFinite(consolidateIntervalRaw) && consolidateIntervalRaw > 0 ? consolidateIntervalRaw : DEFAULT_SELFLEARN_CONSOLIDATE_INTERVAL_MS;
      let lastConsolidateMs: number | undefined;
      const playbookConsolidateTick = async (): Promise<void> => {
        if (!parseBoolean(e.MUSE_SELFLEARN_ENABLED, false) || !followupModel) return;
        const nowMs = Date.now();
        if (lastConsolidateMs !== undefined && nowMs - lastConsolidateMs < consolidateIntervalMs) return;
        lastConsolidateMs = nowMs;
        try {
          if (await isLearningPaused(resolveLearningPauseFile(e))) return; // brake: paused ⇒ bank frozen
          const playbookFile = resolvePlaybookFile(e);
          // The playbook file is a single-user ~/.muse bucket — operate on the
          // whole file (no external userId resolution); the merged strategy
          // inherits the cluster's userId.
          const entries = await queryPlaybook(playbookFile);
          // ONLY fresh PENDING learnings: probation AND not-yet-avoided. The
          // graduated / avoided bank is never autonomously merged.
          const pending = entries.filter((x) => x.probation === true && (x.reward ?? 0) > PLAYBOOK_AVOID_BELOW);
          const clusters = clusterByTextSimilarity(pending, (x) => x.text, strategyTextSimilarity, 0.6).filter((c) => c.length >= 2);
          if (clusters.length === 0) return;
          const cluster = clusters[0]!; // ≤1 per tick (brake-first)
          const userId = cluster[0]!.userId;
          const tag = cluster.find((x) => x.tag)?.tag;
          const merge = helpers.consolidateMerge ?? ((texts) =>
            mergePlaybookStrategies(texts, { model: followupModel.model, modelProvider: followupModel.modelProvider as Parameters<typeof mergePlaybookStrategies>[1]["modelProvider"] }));
          const validate = helpers.consolidateValidate ?? (async (originals: readonly string[], mergedText: string) => {
            const verdict = await validateMergeCoverage(originals.map((t) => ({ label: t, text: t })), { label: mergedText.slice(0, 40), text: mergedText }, { embed: createGateEmbedder(e) });
            return { accept: verdict.accept, lost: verdict.lost, reason: verdict.reason };
          });
          const { merged } = await consolidatePlaybook([cluster], {
            apply: true,
            log: () => { /* the daemon logs the single outcome below */ },
            merge,
            // SAFETY: the merged strategy STAYS on probation — never graduate.
            record: async (text) => {
              await recordPlaybookStrategy(playbookFile, {
                createdAt: new Date(nowMs).toISOString(),
                id: `pb_${randomUUID()}`,
                origin: "grounded",
                probation: true,
                text,
                userId,
                ...(tag ? { tag } : {})
              });
            },
            remove: async (id) => { await removePlaybookStrategy(playbookFile, id); },
            validate
          });
          if (merged > 0) io.stdout(`[${new Date(nowMs).toISOString()}] consolidate: merged ${cluster.length.toString()} near-duplicate pending learning(s) into 1 (still on probation; see \`muse learned\`)\n`);
        } catch { /* fail-soft — background maintenance must never break the daemon */ }
      };

      let lastMemoryConsolidateMs: number | undefined;
      const memoryConsolidateTick = async (): Promise<void> => {
        const sleepPromoteEnabled = parseBoolean(e.MUSE_SLEEP_PROMOTE, false);
        const persist = sleepPromoteEnabled
          ? async () => {
              const userId = resolveMemoryUserId(undefined);
              const store = new FileUserMemoryStore();
              const result = await promoteRecalledMemories({
                store,
                userId,
                readHits: () => readRecallHits(resolveRecallHitsFile(e))
              });
              return { promoted: result.promoted.length };
            }
          : undefined;
        const nextState = await runMemoryConsolidationTick({
          enabled: parseBoolean(e.MUSE_SELFLEARN_ENABLED, false),
          nowMs: Date.now(),
          lastRunMs: lastMemoryConsolidateMs,
          readHits: () => readRecallHits(resolveRecallHitsFile(e)),
          log: (line) => io.stdout(line + "\n"),
          useActrRanking: true, // rank fade/promote by ACT-R activation like the manual path
          persistFade: (fadeKeys) => writeFadedMemoryKeys(resolveFadedMemoriesFile(e), fadeKeys, Date.now()),
          ...(persist !== undefined ? { persist } : {})
        });
        lastMemoryConsolidateMs = nextState.lastRunMs;
      };

      // Evening recap — a once-a-day proactive digest of what got done today +
      // what's coming up, delivered after MUSE_RECAP_HOUR (default 21:00) and
      // self-deduped to once per calendar day via a sidecar. Off by default;
      // turns `muse recap` from an on-demand report into anticipation.
      const recapHourRaw = e.MUSE_RECAP_HOUR ? Number(e.MUSE_RECAP_HOUR) : 21;
      const recapHour = Number.isFinite(recapHourRaw) && recapHourRaw >= 0 && recapHourRaw <= 23 ? Math.trunc(recapHourRaw) : 21;
      const recapSidecar = e.MUSE_RECAP_SIDECAR_FILE?.trim()?.length
        ? e.MUSE_RECAP_SIDECAR_FILE.trim()
        : join(homedir(), ".muse", "recap-fired.json");
      const recapTick = async (): Promise<void> => {
        if (!parseBoolean(e.MUSE_RECAP_ENABLED, false)) return;
        let lastFiredISO: string | undefined;
        try {
          lastFiredISO = (JSON.parse(readFileSync(recapSidecar, "utf8")) as { lastFired?: string }).lastFired;
        } catch { /* no sidecar yet ⇒ never fired */ }
        try {
          const outcome = await deliverEveningRecapIfDue({
            now: new Date(),
            recapHour,
            ...(lastFiredISO !== undefined ? { lastFiredISO } : { lastFiredISO: undefined }),
            gather: (now) => gatherEveningRecap(e, now),
            send: async (text) => { await messagingRegistry.send(provider, { destination, text }); },
            recordFired: (when) => {
              try {
                mkdirSync(dirname(recapSidecar), { recursive: true });
                writeFileSync(recapSidecar, JSON.stringify({ lastFired: when.toISOString() }), "utf8");
              } catch { /* fail-soft */ }
            }
          });
          if (outcome === "fired") io.stdout(`[${new Date().toISOString()}] recap: delivered the evening recap\n`);
        } catch { /* fail-soft — the recap is a daily nicety, never break the daemon */ }
      };

      // Continuous messaging ingestion — pull new inbound (Telegram / Discord /
      // Slack) into the inbox on a throttle; the inbox-injection cursor then
      // makes it recallable via `muse ask` WITHOUT a manual `muse messaging
      // poll`. Off by default; the providers' own update offsets dedup so a
      // re-poll only fetches what's new.
      const pollMessaging = helpers.messagingPoll ?? createMessagingPollDispatchers(e, messagingRegistry).pollAll;
      const DEFAULT_MSG_POLL_INTERVAL_MS = 5 * 60 * 1000;
      const msgPollIntervalRaw = e.MUSE_MESSAGING_POLL_INTERVAL_MS ? Number(e.MUSE_MESSAGING_POLL_INTERVAL_MS) : DEFAULT_MSG_POLL_INTERVAL_MS;
      const msgPollIntervalMs = Number.isFinite(msgPollIntervalRaw) && msgPollIntervalRaw > 0 ? msgPollIntervalRaw : DEFAULT_MSG_POLL_INTERVAL_MS;
      let lastMsgPollMs: number | undefined;
      const messagingPollTick = async (): Promise<void> => {
        if (!parseBoolean(e.MUSE_MESSAGING_POLL_ENABLED, false)) return;
        const nowMs = Date.now();
        if (lastMsgPollMs !== undefined && nowMs - lastMsgPollMs < msgPollIntervalMs) return;
        lastMsgPollMs = nowMs;
        try {
          const result = await pollMessaging();
          const total = Object.values(result.ingestedByProvider).reduce((sum, n) => sum + n, 0);
          if (total > 0) io.stdout(`[${new Date(nowMs).toISOString()}] messaging-poll: +${total.toString()} new message${total === 1 ? "" : "s"} ingested (recallable via \`muse ask\`)\n`);
        } catch { /* fail-soft — a transient poll failure must never break the daemon */ }
      };

      // Proactive double-booking watch — scan the upcoming calendar window for
      // overlapping events and warn ONCE per clash (a Friday conflict caught on
      // Wednesday). Detection already exists for the `muse today` pull; this is
      // the missing PUSH. Off by default; throttled; a key-dedup sidecar means a
      // standing clash never re-spams. Fail-soft.
      const conflictWatchLister = helpers.conflictWatchCalendarLister
        ?? (calendarRegistry.list().length > 0
          ? (range: { from: Date; to: Date }) => calendarRegistry.listEvents(range)
          : undefined);
      const conflictWatchSidecar = e.MUSE_CONFLICT_WATCH_SIDECAR_FILE?.trim()?.length
        ? e.MUSE_CONFLICT_WATCH_SIDECAR_FILE.trim()
        : join(homedir(), ".muse", "conflict-watch-fired.json");
      const conflictWithinRaw = e.MUSE_CONFLICT_WATCH_WITHIN_DAYS ? Number(e.MUSE_CONFLICT_WATCH_WITHIN_DAYS) : 7;
      const conflictWithinDays = Number.isFinite(conflictWithinRaw) && conflictWithinRaw > 0 ? Math.trunc(conflictWithinRaw) : 7;
      const DEFAULT_CONFLICT_WATCH_INTERVAL_MS = 30 * 60 * 1000;
      const conflictIntervalRaw = e.MUSE_CONFLICT_WATCH_INTERVAL_MS ? Number(e.MUSE_CONFLICT_WATCH_INTERVAL_MS) : DEFAULT_CONFLICT_WATCH_INTERVAL_MS;
      const conflictIntervalMs = Number.isFinite(conflictIntervalRaw) && conflictIntervalRaw > 0 ? conflictIntervalRaw : DEFAULT_CONFLICT_WATCH_INTERVAL_MS;
      let lastConflictWatchMs: number | undefined;
      const conflictWatchTick = async (): Promise<void> => {
        if (!parseBoolean(e.MUSE_CONFLICT_WATCH_ENABLED, false)) return;
        if (!conflictWatchLister) return;
        const nowMs = Date.now();
        if (lastConflictWatchMs !== undefined && nowMs - lastConflictWatchMs < conflictIntervalMs) return;
        lastConflictWatchMs = nowMs;
        const now = new Date(nowMs);
        try {
          const events = await conflictWatchLister({ from: now, to: new Date(nowMs + conflictWithinDays * 86_400_000) });
          const notices = selectUpcomingConflicts(
            events.map((ev) => ({ title: ev.title, startsAt: ev.startsAt, endsAt: ev.endsAt })),
            { now, withinDays: conflictWithinDays }
          );
          if (notices.length === 0) return;
          let firedKeys: string[] = [];
          try {
            const parsed = JSON.parse(readFileSync(conflictWatchSidecar, "utf8")) as { keys?: unknown };
            if (Array.isArray(parsed.keys)) firedKeys = parsed.keys.filter((k): k is string => typeof k === "string");
          } catch { /* no sidecar yet ⇒ nothing fired */ }
          const fresh = notices.filter((n) => !firedKeys.includes(n.key));
          if (fresh.length === 0) return;
          const text = `Heads up — upcoming calendar conflict${fresh.length === 1 ? "" : "s"}:\n${fresh.map((n) => `• ${n.line}`).join("\n")}`;
          await messagingRegistry.send(provider, { destination, text });
          try {
            mkdirSync(dirname(conflictWatchSidecar), { recursive: true });
            writeFileSync(conflictWatchSidecar, JSON.stringify({ keys: [...firedKeys, ...fresh.map((n) => n.key)].slice(-200) }), "utf8");
          } catch { /* fail-soft — dedup persistence is best-effort */ }
          io.stdout(`[${now.toISOString()}] conflict-watch: warned of ${fresh.length.toString()} upcoming double-booking${fresh.length === 1 ? "" : "s"}\n`);
        } catch { /* fail-soft — a calendar hiccup must never break the daemon */ }
      };

      const runTick = async (): Promise<void> => {
        await proactiveTick();
        await remindersTick();
        await followupTick();
        await checkinsTick();
        await patternTick();
        await ambientTick();
        await webWatchTick();
        await objectivesTick();
        await homeWatchTick();
        await briefingTick();
        await reflectionTick();
        await emailSyncTick();
        await selfLearnTick();
        await selfLearnDecayTick();
        await playbookConsolidateTick();
        await memoryConsolidateTick();
        await recapTick();
        await messagingPollTick();
        await conflictWatchTick();
      };

      io.stdout(`muse daemon — provider=${provider}, destination=${destination}, lead ${leadMinutes.toString()} min\n`);

      if (options.once) {
        await runTick();
        io.stdout("daemon --once complete\n");
        return;
      }

      const signal = new DaemonStopSignal();
      const stop = (): void => {
        if (signal.stopped) return;
        io.stdout("\n(stopping)\n");
        signal.stop();
      };
      process.on("SIGINT", stop);
      process.on("SIGTERM", stop);

      io.stdout(`  running every ${interval.toString()} s — ctrl-c to stop\n`);
      await runDaemonLoop({
        intervalMs: interval * 1000,
        onError: (cause) => {
          io.stderr(`tick error: ${cause instanceof Error ? cause.message : String(cause)}\n`);
        },
        signal,
        tick: runTick
      });
    });
}
