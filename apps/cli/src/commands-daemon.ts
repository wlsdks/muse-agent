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
  resolveProactiveHistoryFile,
  resolveTasksFile
} from "@muse/autoconfigure";
import type { MessagingProviderRegistry } from "@muse/messaging";
import { runDueProactiveNotices } from "@muse/mcp";
import { homedir } from "node:os";
import { join } from "node:path";

import { closestCommandName } from "./closest-command.js";
import { parseBoundedFlag } from "./commands-proactive.js";
import type { ProgramIO } from "./program.js";

export interface DaemonHelpers {
  /** Test seam — defaults to `process.env`. */
  readonly env?: () => NodeJS.ProcessEnv;
  /**
   * Test seam — inject a contract-faithful messaging registry rather
   * than building one from env, so a smoke can assert delivery against
   * a capturing fake provider.
   */
  readonly buildMessagingRegistry?: (env: NodeJS.ProcessEnv) => MessagingProviderRegistry;
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

      io.stdout(`muse daemon — provider=${provider}, destination=${destination}, lead ${leadMinutes.toString()} min\n`);

      if (options.once) {
        await proactiveTick();
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
          await proactiveTick();
        } catch (cause) {
          io.stderr(`tick error: ${cause instanceof Error ? cause.message : String(cause)}\n`);
        }
        if (!stopped) {
          await new Promise((resolve) => setTimeout(resolve, interval * 1000));
        }
      }
    });
}
