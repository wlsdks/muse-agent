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
  parseBoolean,
  resolveContactsFile,
  resolveFollowupsFile,
  resolveObjectivesFile,
  resolvePatternsFiredFile,
  resolveProactiveHistoryFile,
  resolveRemindersFile,
  resolveTasksFile
} from "@muse/autoconfigure";
import { synthesizePatternSuggestion } from "@muse/agent-core";
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
  runDueReminders,
  runDueSituationalBriefing,
  webWatchesFromConfig,
  CHROME_DEVTOOLS_MCP_SERVER_NAME,
  type AmbientNoticeRunner,
  type BriefingCalendarLister,
  type ChromeSnapshotConnection,
  type ProactiveNoticeSink,
  type WebWatchRunner
} from "@muse/mcp";
import type { MuseTool } from "@muse/tools";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { checkinsFile } from "./commands-checkins.js";
import { closestCommandName } from "./closest-command.js";
import { parseBoundedFlag } from "./commands-proactive.js";
import { createIndexedProactiveInvestigator } from "./proactive-notes-recall.js";
import type { ProgramIO } from "./program.js";

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

interface DaemonConfig {
  readonly provider?: string;
  readonly destination?: string;
}

function resolveDaemonConfigFile(env: NodeJS.ProcessEnv): string {
  const explicit = env.MUSE_DAEMON_CONFIG_FILE?.trim();
  if (explicit && explicit.length > 0) return explicit;
  const home = env.HOME?.trim()?.length ? env.HOME.trim() : homedir();
  return join(home, ".config", "muse", "daemon.json");
}

// Tolerant: a missing / malformed config file yields no defaults
// (the daemon still runs from flags + env), never throws.
function readDaemonConfig(file: string): DaemonConfig {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return {};
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const config: { provider?: string; destination?: string } = {};
    if (typeof parsed.provider === "string") config.provider = parsed.provider;
    if (typeof parsed.destination === "string") config.destination = parsed.destination;
    return config;
  } catch {
    return {};
  }
}

function writeDaemonConfig(file: string, config: DaemonConfig): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

const LAUNCH_AGENT_LABEL = "com.muse.daemon";

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// A macOS LaunchAgent plist that keeps `muse daemon` resident: it
// starts at login (RunAtLoad) and is restarted if it exits
// (KeepAlive), so the daemon survives logout / reboot.
export function buildLaunchAgentPlist(opts: {
  readonly label: string;
  readonly programArguments: readonly string[];
  readonly stdoutPath: string;
  readonly stderrPath: string;
}): string {
  const args = opts.programArguments
    .map((arg) => `    <string>${xmlEscape(arg)}</string>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xmlEscape(opts.label)}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${xmlEscape(opts.stdoutPath)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(opts.stderrPath)}</string>
</dict>
</plist>
`;
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
      embed: createOllamaEmbedder(env.MUSE_KNOWLEDGE_SEARCH_EMBED_MODEL?.trim() ?? "nomic-embed-text"),
      notesProvider: new LocalDirNotesProvider({ notesDir })
    });
  } catch {
    return undefined;
  }
}

function resolveLaunchAgentFile(env: NodeJS.ProcessEnv): string {
  const explicit = env.MUSE_DAEMON_PLIST_FILE?.trim();
  if (explicit && explicit.length > 0) return explicit;
  const home = env.HOME?.trim()?.length ? env.HOME.trim() : homedir();
  return join(home, "Library", "LaunchAgents", `${LAUNCH_AGENT_LABEL}.plist`);
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
        // The resolved source paths — the first thing to check when a
        // tick "isn't firing": is it reading the file you think it is?
        io.stdout(`sources:\n`);
        io.stdout(`  config:     ${configFile}\n`);
        io.stdout(`  tasks:      ${tasksFile}\n`);
        io.stdout(`  reminders:  ${remindersFile}\n`);
        io.stdout(`  followups:  ${followupsFile}\n`);
        io.stdout(`  objectives: ${objectivesFile}\n`);
        // Will it come back after a reboot? (P22-6 launchd install)
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
        const summary = await runDuePatternNotices({
          destination,
          patternsFiredFile: resolvePatternsFiredFile(e),
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
