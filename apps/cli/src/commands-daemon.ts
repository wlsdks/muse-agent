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
  resolveFollowupsFile,
  resolveObjectivesFile,
  resolveProactiveHistoryFile,
  resolveTasksFile
} from "@muse/autoconfigure";
import type { MessagingProviderRegistry } from "@muse/messaging";
import {
  createAmbientNoticeRunner,
  createMessagingObjectiveActuator,
  createModelObjectiveEvaluator,
  createWebWatchRunner,
  FileAmbientSignalSource,
  parseAmbientNoticeRules,
  runDueFollowups,
  runDueObjectives,
  runDueProactiveNotices,
  webWatchesFromConfig,
  type AmbientNoticeRunner,
  type ProactiveNoticeSink,
  type WebWatchRunner
} from "@muse/mcp";
import { homedir } from "node:os";
import { join } from "node:path";

import { closestCommandName } from "./closest-command.js";
import { parseBoundedFlag } from "./commands-proactive.js";
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

export function registerDaemonCommands(program: Command, io: ProgramIO, helpers: DaemonHelpers = {}): void {
  const env = () => helpers.env?.() ?? process.env;
  const makeMessaging = helpers.buildMessagingRegistry ?? ((e: NodeJS.ProcessEnv) => buildMessagingRegistry(e));

  program
    .command("daemon")
    .description("Run Muse's background daemon (proactive notices) in one process. --once runs a single tick and exits.")
    .option("--once", "Run exactly one tick of each enabled daemon, then exit")
    .option("--interval <seconds>", "Tick interval in seconds (default 60)", "60")
    .option("--lead-minutes <minutes>", "Imminent-window lead in minutes (default 10)", "10")
    .option("--provider <id>", "Messaging provider id (default MUSE_PROACTIVE_PROVIDER, else 'log')")
    .option("--destination <id>", "Messaging destination — chat/channel id or log tag (default MUSE_PROACTIVE_DESTINATION or '@me')")
    .action(async (options: {
      readonly once?: boolean;
      readonly interval: string;
      readonly leadMinutes: string;
      readonly provider?: string;
      readonly destination?: string;
    }) => {
      const e = env();
      const interval = parseBoundedFlag(options.interval, "--interval", 5, 86_400, 60);
      const leadMinutes = parseBoundedFlag(options.leadMinutes, "--lead-minutes", 1, 1_440, 10);
      const provider = (options.provider ?? e.MUSE_PROACTIVE_PROVIDER ?? "log").trim();
      const destination = (options.destination ?? e.MUSE_PROACTIVE_DESTINATION ?? "@me").trim();

      const messagingRegistry = makeMessaging(e);
      if (!messagingRegistry.has(provider)) {
        const known = messagingRegistry.list().map((p) => p.id);
        const suggestion = closestCommandName(provider, known);
        const hint = suggestion ? ` — did you mean --provider ${suggestion}?` : "";
        io.stderr(`Provider '${provider}' is not registered${hint}. Try --provider log (always available).\n`);
        process.exitCode = 1;
        return;
      }

      const calendarRegistry = buildCalendarRegistry(e);
      const tasksFile = resolveTasksFile(e);
      const historyFile = resolveProactiveHistoryFile(e);
      const sidecarFile = e.MUSE_PROACTIVE_SIDECAR_FILE?.trim()?.length
        ? e.MUSE_PROACTIVE_SIDECAR_FILE.trim()
        : join(homedir(), ".muse", "proactive-fired.json");
      const followupsFile = resolveFollowupsFile(e);
      const followupModel = await (helpers.resolveFollowupModel ?? defaultFollowupModel)(e);

      // Shared sink: every perception tick (ambient, web-watch) routes
      // its notice to the same messaging destination as proactive.
      const noticeSink: ProactiveNoticeSink = {
        deliver: async (notice) => {
          await messagingRegistry.send(provider, {
            destination,
            text: `${notice.title}: ${notice.text}`
          });
        }
      };

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
          const ambientFile = e.MUSE_AMBIENT_FILE?.trim()?.length
            ? e.MUSE_AMBIENT_FILE.trim()
            : join(homedir(), ".muse", "ambient.json");
          ambientRunner = createAmbientNoticeRunner({
            rules: ambientRules,
            sink: noticeSink,
            source: new FileAmbientSignalSource(ambientFile)
          });
        }
      }

      // Web-watch is read-only page polling. Active only when
      // MUSE_WEB_WATCH_CONFIG is configured; otherwise the tick is skipped.
      const webWatchRaw = e.MUSE_WEB_WATCH_CONFIG?.trim();
      let webWatchRunner: WebWatchRunner | undefined;
      if (webWatchRaw) {
        const watches = webWatchesFromConfig(
          webWatchRaw,
          helpers.fetchImpl ? { fetchImpl: helpers.fetchImpl } : {}
        );
        if (watches.length > 0) {
          webWatchRunner = createWebWatchRunner({ sink: noticeSink, watches });
        }
      }

      // Standing objectives re-evaluate via the model and notify on the
      // same channel when met. Needs a model — skipped without one.
      const objectivesFile = resolveObjectivesFile(e);
      const objectivesActuator = followupModel
        ? createMessagingObjectiveActuator({ destination, providerId: provider, registry: messagingRegistry })
        : undefined;
      const objectivesEvaluate = followupModel
        ? createModelObjectiveEvaluator({ model: followupModel.model, modelProvider: followupModel.modelProvider })
        : undefined;

      const proactiveTick = async (): Promise<void> => {
        const summary = await runDueProactiveNotices({
          ...(calendarRegistry.list().length > 0 ? { calendarRegistry } : {}),
          destination,
          historyFile,
          leadMinutes,
          messagingRegistry,
          providerId: provider,
          sidecarFile,
          tasksFile
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

      const runTick = async (): Promise<void> => {
        await proactiveTick();
        await followupTick();
        await ambientTick();
        await webWatchTick();
        await objectivesTick();
      };

      io.stdout(`muse daemon — provider=${provider}, destination=${destination}, lead ${leadMinutes.toString()} min\n`);

      if (options.once) {
        await runTick();
        io.stdout("daemon --once complete\n");
        return;
      }

      let stopped = false;
      const stop = (): void => {
        if (stopped) return;
        stopped = true;
        io.stdout("\n(stopping)\n");
        process.exit(0);
      };
      process.on("SIGINT", stop);
      process.on("SIGTERM", stop);

      io.stdout(`  running every ${interval.toString()} s — ctrl-c to stop\n`);
      while (!stopped) {
        try {
          await runTick();
        } catch (cause) {
          io.stderr(`tick error: ${cause instanceof Error ? cause.message : String(cause)}\n`);
        }
        if (!stopped) {
          await new Promise((resolve) => setTimeout(resolve, interval * 1000));
        }
      }
    });
}
