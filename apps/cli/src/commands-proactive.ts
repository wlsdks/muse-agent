/**
 * `muse proactive` — operator tools for the proactive surfacing
 * daemon (see `docs/design/proactive-surfacing.md`).
 *
 *   muse proactive test   — send a one-line test message to
 *                            MUSE_PROACTIVE_PROVIDER/DESTINATION so
 *                            the operator can verify the channel
 *                            without waiting on a real imminent event.
 *   muse proactive scan   — dry-run scan of the calendar + tasks
 *                            sources within the lead window; prints
 *                            what would fire next tick but does not
 *                            push and does not touch the sidecar.
 *
 * The daemon itself stays in apps/api; these commands only need the
 * messaging / calendar / tasks file resolution that
 * `@muse/autoconfigure` already exposes.
 */

import type { Command } from "commander";

import {
  buildCalendarRegistry,
  buildMessagingRegistry,
  resolveProactiveHistoryFile,
  resolveTasksFile
} from "@muse/autoconfigure";
import type { CalendarEvent } from "@muse/calendar";
import { readProactiveHistory, runDueProactiveNotices } from "@muse/mcp";
import { homedir } from "node:os";
import { join } from "node:path";

import type { ProgramIO } from "./program.js";

export interface ProactiveHelpers {
  /** Test seam — defaults to `process.env`. */
  readonly env?: () => NodeJS.ProcessEnv;
}

export function registerProactiveCommands(program: Command, io: ProgramIO, helpers: ProactiveHelpers = {}): void {
  const env = () => helpers.env?.() ?? process.env;

  const proactive = program
    .command("proactive")
    .description("Proactive surfacing utilities (test / scan against MUSE_PROACTIVE_* env)");

  proactive
    .command("test")
    .description("Send a one-line test message to MUSE_PROACTIVE_PROVIDER/DESTINATION to verify the channel")
    .option("--text <message>", "Override the test message", "⏰ Muse proactive test — channel is working.")
    .action(async (options: { readonly text: string }, command) => {
      const e = env();
      const provider = e.MUSE_PROACTIVE_PROVIDER?.trim();
      const destination = e.MUSE_PROACTIVE_DESTINATION?.trim();
      if (!provider || provider.length === 0 || !destination || destination.length === 0) {
        io.stderr("MUSE_PROACTIVE_PROVIDER and MUSE_PROACTIVE_DESTINATION must be set.\n");
        command.error("Missing proactive config", { exitCode: 1 });
        return;
      }
      const registry = buildMessagingRegistry(e);
      if (!registry.has(provider)) {
        io.stderr(
          `messaging provider '${provider}' is not registered — set the relevant token ` +
            `(e.g. MUSE_TELEGRAM_BOT_TOKEN / MUSE_DISCORD_BOT_TOKEN / MUSE_SLACK_BOT_TOKEN / MUSE_LINE_CHANNEL_ACCESS_TOKEN).\n`
        );
        command.error("Provider not registered", { exitCode: 1 });
        return;
      }
      try {
        await registry.send(provider, { destination, text: options.text });
        io.stdout(`Sent test message via ${provider} → ${destination}\n`);
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        io.stderr(`Failed: ${message}\n`);
        command.error("Send failed", { exitCode: 1 });
      }
    });

  proactive
    .command("scan")
    .description("Dry-run scan of imminent calendar events + due-soon tasks — prints what would fire next tick")
    .option("--lead-minutes <minutes>", "Override MUSE_PROACTIVE_LEAD_MINUTES for this scan (default 10)")
    .action(async (options: { readonly leadMinutes?: string }, _command) => {
      const e = env();
      const leadMinutes = options.leadMinutes
        ? Math.max(1, Number.parseInt(options.leadMinutes, 10) || 10)
        : Number.parseInt(e.MUSE_PROACTIVE_LEAD_MINUTES?.trim() ?? "10", 10) || 10;
      const now = new Date();
      const cutoff = new Date(now.getTime() + leadMinutes * 60_000);

      const calendarRegistry = buildCalendarRegistry(e);
      const tasksFile = resolveTasksFile(e);

      const lines: string[] = [];
      lines.push(`Window: ${now.toISOString()} → ${cutoff.toISOString()} (${leadMinutes.toString()} min)`);

      try {
        const events = calendarRegistry.list().length > 0
          ? await calendarRegistry.listEvents({ from: now, to: cutoff })
          : [];
        const imminent = events.filter((event: CalendarEvent) => !event.allDay && event.startsAt >= now && event.startsAt <= cutoff);
        if (imminent.length === 0) {
          lines.push("Calendar: (no imminent events)");
        } else {
          lines.push(`Calendar: ${imminent.length.toString()} imminent event(s)`);
          for (const event of imminent) {
            const minutesAway = Math.round((event.startsAt.getTime() - now.getTime()) / 60_000);
            lines.push(`  · ${event.title} in ${minutesAway.toString()} min${event.location ? ` (${event.location})` : ""}`);
          }
        }
      } catch (cause) {
        lines.push(`Calendar: ERROR ${cause instanceof Error ? cause.message : String(cause)}`);
      }

      try {
        const { readTasks } = await import("@muse/mcp");
        const tasks = await readTasks(tasksFile);
        const dueSoon = tasks.filter((task) => {
          if (task.status !== "open" || !task.dueAt || task.proactive === false) return false;
          const due = new Date(task.dueAt);
          return !Number.isNaN(due.getTime()) && due >= now && due <= cutoff;
        });
        if (dueSoon.length === 0) {
          lines.push("Tasks: (no due-soon tasks)");
        } else {
          lines.push(`Tasks: ${dueSoon.length.toString()} due-soon task(s)`);
          for (const task of dueSoon) {
            const minutesAway = Math.round((new Date(task.dueAt!).getTime() - now.getTime()) / 60_000);
            lines.push(`  · ${task.title} due in ${minutesAway.toString()} min`);
          }
        }
      } catch (cause) {
        lines.push(`Tasks: ERROR ${cause instanceof Error ? cause.message : String(cause)}`);
      }

      io.stdout(`${lines.join("\n")}\n`);
    });

  proactive
    .command("watch")
    .description("Run the proactive daemon in the foreground — every interval, fire imminent notices via the configured messaging provider")
    .option("--interval <seconds>", "Tick interval (default 60)", "60")
    .option("--lead-minutes <minutes>", "Lead window in minutes (default 10)", "10")
    .option(
      "--provider <id>",
      "Messaging provider id (default MUSE_PROACTIVE_PROVIDER, falling back to 'log' so users without external tokens still see notices)"
    )
    .option(
      "--destination <id>",
      "Messaging destination — chat id / channel id / log tag (default MUSE_PROACTIVE_DESTINATION or '@me')"
    )
    .option(
      "--user <id>",
      "User identity whose persona personalises proactive notices (default $MUSE_USER_ID or $USER)"
    )
    .action(async (options: {
      readonly interval: string;
      readonly leadMinutes: string;
      readonly provider?: string;
      readonly destination?: string;
      readonly user?: string;
    }) => {
      const e = env();
      const interval = Math.max(5, Number.parseInt(options.interval, 10) || 60);
      const leadMinutes = Math.max(1, Number.parseInt(options.leadMinutes, 10) || 10);
      const provider = (options.provider ?? e.MUSE_PROACTIVE_PROVIDER ?? "log").trim();
      const destination = (options.destination ?? e.MUSE_PROACTIVE_DESTINATION ?? "@me").trim();

      const messagingRegistry = buildMessagingRegistry(e);
      if (!messagingRegistry.has(provider)) {
        io.stderr(`Provider '${provider}' is not registered. Try --provider log (always available).\n`);
        process.exitCode = 1;
        return;
      }
      const calendarRegistry = buildCalendarRegistry(e);
      const tasksFile = resolveTasksFile(e);
      const historyFile = resolveProactiveHistoryFile(e);
      // Honour MUSE_PROACTIVE_SIDECAR_FILE so tests + tmp invocations
      // don't collide with the user's real ~/.muse/proactive-fired.json
      // dedupe state.
      const sidecarFile = e.MUSE_PROACTIVE_SIDECAR_FILE?.trim()?.length
        ? e.MUSE_PROACTIVE_SIDECAR_FILE.trim()
        : join(homedir(), ".muse", "proactive-fired.json");

      // Pull the persona for the configured user so Phase D synthesis
      // addresses the user by name + honours language/style prefs
      // ("Stark님, Q3 메모가 5분 후 마감입니다" instead of the generic
      // "Send Q3 budget memo due in 5 min"). Best-effort — assembly
      // and persona resolution failures fall back to the generic
      // synthesis prompt.
      const userId = (options.user ?? e.MUSE_USER_ID ?? e.USER ?? "default").trim();
      let personaPreamble: string | undefined;
      let agentModel: string | undefined;
      let modelProvider: Parameters<typeof runDueProactiveNotices>[0]["modelProvider"];
      try {
        const { createMuseRuntimeAssembly } = await import("@muse/autoconfigure");
        const assembly = createMuseRuntimeAssembly();
        if (assembly.modelProvider && assembly.defaultModel) {
          modelProvider = assembly.modelProvider as unknown as Parameters<typeof runDueProactiveNotices>[0]["modelProvider"];
          agentModel = assembly.defaultModel;
        }
        const userMemory = await Promise.resolve(assembly.userMemoryStore.findByUserId(userId));
        if (userMemory) {
          const { buildJarvisPersona } = await import("./program.js");
          personaPreamble = buildJarvisPersona(userMemory, userId);
        }
      } catch { /* fail-open — synthesis falls back to generic */ }

      io.stdout(`muse proactive watch — every ${interval.toString()} s, lead ${leadMinutes.toString()} min\n`);
      io.stdout(`  provider=${provider}, destination=${destination}\n`);
      io.stdout(`  tasksFile=${tasksFile}\n`);
      io.stdout(`  historyFile=${historyFile}\n`);
      if (personaPreamble && agentModel && modelProvider) {
        io.stdout(`  persona: ${userId} (Phase D agent synthesis active via ${agentModel})\n`);
      } else if (agentModel && modelProvider) {
        io.stdout(`  persona: (none for user '${userId}' — generic Phase D)\n`);
      }
      io.stdout(`  (Ctrl-C to stop)\n\n`);

      let stopped = false;
      const stop = (): void => {
        if (stopped) return;
        stopped = true;
        io.stdout("\n(ctrl-c — stopping)\n");
        process.exit(0);
      };
      process.on("SIGINT", stop);
      process.on("SIGTERM", stop);

      while (!stopped) {
        const startedAt = new Date();
        try {
          const summary = await runDueProactiveNotices({
            ...(agentModel ? { agentModel } : {}),
            ...(modelProvider ? { modelProvider } : {}),
            ...(personaPreamble ? { personaPreamble } : {}),
            ...(modelProvider ? { activitySource: { lastActivityMs: () => Date.now() } } : {}),
            ...(calendarRegistry.list().length > 0 ? { calendarRegistry } : {}),
            destination,
            historyFile,
            leadMinutes,
            messagingRegistry,
            providerId: provider,
            sidecarFile,
            tasksFile
          });
          const tag = `[${startedAt.toISOString()}]`;
          if (summary.fired > 0 || summary.errors.length > 0) {
            io.stdout(`${tag} fired ${summary.fired.toString()}/${summary.imminent.toString()} imminent`);
            if (summary.errors.length > 0) {
              io.stdout(`, ${summary.errors.length.toString()} error(s)`);
              for (const error of summary.errors) {
                io.stdout(`\n  ! ${error}`);
              }
            }
            io.stdout("\n");
          } else {
            io.stdout(`${tag} 0/${summary.imminent.toString()} imminent (quiet)\n`);
          }
        } catch (cause) {
          io.stderr(`tick error: ${cause instanceof Error ? cause.message : String(cause)}\n`);
        }
        if (!stopped) {
          await new Promise((resolve) => setTimeout(resolve, interval * 1000));
        }
      }
    });

  proactive
    .command("history")
    .description("Audit recent proactive notices from ~/.muse/proactive-history.json")
    .option("--limit <count>", "Max entries (newest first, default 20, cap 500)", "20")
    .option("--json", "Print the raw entries as JSON")
    .action(async (options: { readonly limit?: string; readonly json?: boolean }) => {
      const e = env();
      const file = resolveProactiveHistoryFile(e);
      const limit = Math.max(1, Math.min(500, Number.parseInt(options.limit ?? "20", 10) || 20));
      const entries = await readProactiveHistory(file, limit);
      if (options.json) {
        io.stdout(`${JSON.stringify({ entries, total: entries.length }, null, 2)}\n`);
        return;
      }
      if (entries.length === 0) {
        io.stdout(`No proactive history yet (${file})\n`);
        return;
      }
      io.stdout(`${entries.length.toString()} entry/entries (newest first):\n`);
      for (const entry of entries) {
        const flag = entry.status === "delivered" ? "✓" : "✗";
        const head = `${flag} [${entry.firedAtIso}] ${entry.kind}:${entry.itemId.slice(0, 12)} via ${entry.providerId}`;
        io.stdout(`${head}\n  ${entry.title} — ${entry.text}\n`);
        if (entry.status === "failed" && entry.error) {
          io.stdout(`  ! ${entry.error}\n`);
        }
      }
    });
}
