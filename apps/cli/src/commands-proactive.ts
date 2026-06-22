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
import { buildGroundingReverify } from "@muse/agent-core";
import type { CalendarEvent } from "@muse/calendar";
import { appendProactiveHistory, readProactiveHistory, readTasks, writeTasks, type PersistedTask } from "@muse/stores";
import { runDueProactiveNotices } from "@muse/proactivity";
import { homedir } from "node:os";
import { join } from "node:path";

import { closestCommandName } from "./closest-command.js";
import { registerProactiveTrustSubcommands } from "./commands-proactive-trust.js";
import { createIndexedProactiveInvestigator } from "./proactive-notes-recall.js";
import { createTerminalProactiveSink } from "./proactive-terminal-sink.js";
import type { ProgramIO } from "./program.js";
import { resolveDefaultUserKey } from "./user-id.js";

export interface ProactiveHelpers {
  /** Test seam — defaults to `process.env`. */
  readonly env?: () => NodeJS.ProcessEnv;
}

// Absent → fallback. A genuine number is truncated and clamped
// to max; a non-numeric / unit-slip / below-min value rejects
// with an actionable message instead of silently running the
// daemon at a wrong cadence — `Number()` not `parseInt` so
// `30abc` rejects, not 30.
export function parseBoundedFlag(
  raw: string | undefined,
  flag: string,
  min: number,
  max: number,
  fallback: number
): number {
  if (raw === undefined || raw.trim().length === 0) {
    return fallback;
  }
  const parsed = Number(raw.trim());
  if (!Number.isFinite(parsed) || parsed < min) {
    throw new Error(`${flag} must be an integer in [${min.toString()}, ${max.toString()}] (got '${raw}')`);
  }
  return Math.min(max, Math.trunc(parsed));
}

export function registerProactiveCommands(program: Command, io: ProgramIO, helpers: ProactiveHelpers = {}): void {
  const env = () => helpers.env?.() ?? process.env;

  const proactive = program
    .command("proactive")
    .description("Proactive surfacing utilities (test / scan against MUSE_PROACTIVE_* env)");

  registerProactiveTrustSubcommands(proactive, io);

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
        const known = registry.list().map((p) => p.id);
        const suggestion = closestCommandName(provider, known);
        const hint = suggestion ? ` — did you mean '${suggestion}'?` : "";
        io.stderr(
          `messaging provider '${provider}' is not registered${hint} — set the relevant token ` +
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
      // The --lead-minutes flag is strict; an absent flag falls
      // back to the env default (env keeps its lenient contract —
      // out of the strict-numeric line's CLI-flag scope).
      const leadMinutes = parseBoundedFlag(
        options.leadMinutes,
        "--lead-minutes",
        1,
        1_440,
        Number.parseInt(e.MUSE_PROACTIVE_LEAD_MINUTES?.trim() ?? "10", 10) || 10
      );
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
        const { readTasks } = await import("@muse/stores");
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
    .option(
      "--ignore-routine",
      "Fire notices even outside the user's routine_active_hours window (default: quiet hours suppress notices)"
    )
    .option(
      "--speak",
      "Also play each delivered notice aloud via the configured TTS (requires MUSE_VOICE_TTS=piper + MUSE_PIPER_VOICE)"
    )
    .action(async (options: {
      readonly interval: string;
      readonly leadMinutes: string;
      readonly provider?: string;
      readonly destination?: string;
      readonly user?: string;
      readonly ignoreRoutine?: boolean;
      readonly speak?: boolean;
    }) => {
      const e = env();
      const interval = parseBoundedFlag(options.interval, "--interval", 5, 86_400, 60);
      const leadMinutes = parseBoundedFlag(options.leadMinutes, "--lead-minutes", 1, 1_440, 10);
      const provider = (options.provider ?? e.MUSE_PROACTIVE_PROVIDER ?? "log").trim();
      const destination = (options.destination ?? e.MUSE_PROACTIVE_DESTINATION ?? "@me").trim();

      const messagingRegistry = buildMessagingRegistry(e);
      if (!messagingRegistry.has(provider)) {
        const known = messagingRegistry.list().map((p) => p.id);
        const suggestion = closestCommandName(provider, known);
        const hint = suggestion ? ` — did you mean --provider ${suggestion}?` : "";
        io.stderr(`Provider '${provider}' is not registered${hint}. Try --provider log (always available).\n`);
        process.exitCode = 1;
        return;
      }
      // Resolve TTS once for --speak. Synthesised notices play
      // through afplay/aplay. Failures are non-fatal.
      let speakFn: ((text: string) => Promise<void>) | undefined;
      if (options.speak) {
        try {
          const { buildVoiceRegistry } = await import("@muse/autoconfigure");
          const voiceReg = buildVoiceRegistry(e);
          const tts = voiceReg?.primaryTts();
          if (tts) {
            const { synthesizeAndPlay } = await import("./voice-playback.js");
            speakFn = async (text) => {
              try {
                await synthesizeAndPlay(tts, { text });
              } catch (cause) {
                io.stderr(`speak failed: ${cause instanceof Error ? cause.message : String(cause)}\n`);
              }
            };
          } else {
            io.stderr("--speak: TTS not configured (set MUSE_VOICE_TTS=piper + MUSE_PIPER_VOICE). Continuing text-only.\n");
          }
        } catch (cause) {
          io.stderr(`--speak setup failed: ${cause instanceof Error ? cause.message : String(cause)}\n`);
        }
      }

      // When --speak is on, wrap the messaging registry so every
      // successful send ALSO fires the TTS. Single source of truth
      // for "what JARVIS said" — log file + speaker stay in sync.
      const effectiveMessagingRegistry = speakFn
        ? new Proxy(messagingRegistry, {
            get(target, prop, receiver) {
              if (prop === "send") {
                return async (providerId: string, message: { destination: string; text: string }) => {
                  const result = await target.send(providerId, message);
                  void speakFn!(message.text);
                  return result;
                };
              }
              return Reflect.get(target, prop, receiver);
            }
          })
        : messagingRegistry;

      const calendarRegistry = buildCalendarRegistry(e);
      const tasksFile = resolveTasksFile(e);
      const historyFile = resolveProactiveHistoryFile(e);
      // Honour MUSE_PROACTIVE_SIDECAR_FILE so tests + tmp invocations
      // don't collide with the user's real ~/.muse/proactive-fired.json
      // dedupe state.
      const sidecarFile = e.MUSE_PROACTIVE_SIDECAR_FILE?.trim()?.length
        ? e.MUSE_PROACTIVE_SIDECAR_FILE.trim()
        : join(homedir(), ".muse", "proactive-fired.json");
      const trustLedgerFile = e.MUSE_PROACTIVE_TRUST_FILE?.trim()?.length
        ? e.MUSE_PROACTIVE_TRUST_FILE.trim()
        : join(homedir(), ".muse", "proactive-trust.json");
      const dailyCap = parseBoundedFlag(e.MUSE_PROACTIVE_DAILY_CAP, "MUSE_PROACTIVE_DAILY_CAP", 0, 1_000, 0);
      const proactiveInvestigator = createIndexedProactiveInvestigator();

      // Pull the persona for the configured user so Phase D synthesis
      // addresses the user by name + honours language/style prefs
      // ("Stark님, Q3 메모가 5분 후 마감입니다" instead of the generic
      // "Send Q3 budget memo due in 5 min"). Best-effort — assembly
      // and persona resolution failures fall back to the generic
      // synthesis prompt.
      const userId = resolveDefaultUserKey({ override: options.user, env: e });
      let personaPreamble: string | undefined;
      let agentModel: string | undefined;
      let modelProvider: Parameters<typeof runDueProactiveNotices>[0]["modelProvider"];
      let activeHourSet: Set<number> | undefined;
      try {
        const { createMuseRuntimeAssembly } = await import("@muse/autoconfigure");
        const assembly = createMuseRuntimeAssembly();
        if (assembly.modelProvider && assembly.defaultModel) {
          modelProvider = assembly.modelProvider as unknown as Parameters<typeof runDueProactiveNotices>[0]["modelProvider"];
          agentModel = assembly.defaultModel;
        }
        const userMemory = await Promise.resolve(assembly.userMemoryStore.findByUserId(userId));
        if (userMemory) {
          const { buildMusePersona } = await import("./program.js");
          personaPreamble = buildMusePersona(userMemory, userId);
          // Parse routine_active_hours fact (e.g. "09,14,20") into a
          // set of "active" hours +/- 1 for the quiet-hours gate.
          const routineRaw = userMemory.facts?.routine_active_hours;
          if (routineRaw && typeof routineRaw === "string") {
            const hours = routineRaw.split(",")
              .map((h) => Number.parseInt(h.trim(), 10))
              .filter((h) => Number.isInteger(h) && h >= 0 && h <= 23);
            if (hours.length > 0) {
              activeHourSet = new Set();
              for (const h of hours) {
                // Active band: ±2 hours so even one-data-point users
                // get a sensible window. JARVIS doesn't expect Tony
                // to be precise to the minute.
                for (let off = -2; off <= 2; off += 1) {
                  activeHourSet.add((h + off + 24) % 24);
                }
              }
            }
          }
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
      if (activeHourSet && !options.ignoreRoutine) {
        const sortedHours = [...activeHourSet].sort((a, b) => a - b);
        io.stdout(`  quiet-hours: active band = ${sortedHours.map((h) => h.toString().padStart(2, "0")).join(",")}; ticks outside this window will be skipped\n`);
      } else if (options.ignoreRoutine && activeHourSet) {
        io.stdout(`  quiet-hours: routine known but --ignore-routine set; firing all hours\n`);
      }
      // Attached to a terminal → that terminal is the surface the
      // user is looking at; render notices there (prompt-safe,
      // control-byte-stripped) instead of only the messaging log.
      // Piped / detached / systemd (no TTY) keeps the messaging path.
      const terminalSink = process.stdout.isTTY === true
        ? createTerminalProactiveSink({ write: (chunk) => { io.stdout(chunk); } })
        : undefined;
      if (terminalSink) {
        io.stdout(`  delivery: this terminal (messaging is the fallback when detached)\n`);
      }

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
        // Quiet-hours gate: if we know the user's routine and the
        // current hour isn't in the active band, skip this tick —
        // UNLESS any imminent task is flagged `urgent: true`, in
        // which case JARVIS interrupts even at 3 AM.
        if (activeHourSet && !options.ignoreRoutine && !activeHourSet.has(startedAt.getHours())) {
          let urgentImminent = false;
          try {
            const tasksNow = await readTasks(tasksFile);
            const cutoff = startedAt.getTime() + leadMinutes * 60_000;
            urgentImminent = tasksNow.some((t: PersistedTask) =>
              t.status === "open"
              && t.urgent === true
              && typeof t.dueAt === "string"
              && new Date(t.dueAt).getTime() <= cutoff
              && new Date(t.dueAt).getTime() >= startedAt.getTime()
            );
          } catch { /* ignore — fall through to skip */ }
          if (!urgentImminent) {
            // Quiet — sleep until the next interval. No log spam.
            if (!stopped) {
              await new Promise((resolve) => setTimeout(resolve, interval * 1000));
            }
            continue;
          }
          io.stdout(`[${startedAt.toISOString()}] quiet-hours override: imminent urgent task — firing\n`);
        }
        try {
          const summary = await runDueProactiveNotices({
            ...(agentModel ? { agentModel } : {}),
            ...(modelProvider ? { modelProvider } : {}),
            // Faithfulness-gate the synthesized Phase D notice — a confabulated push
            // detail fails CLOSE to the verbatim store line (same judge as reflection).
            ...(modelProvider && agentModel ? { reverify: buildGroundingReverify(modelProvider, agentModel) } : {}),
            ...(personaPreamble ? { personaPreamble } : {}),
            ...(terminalSink
              ? { activitySource: { lastActivityMs: () => Date.now() }, terminalSink }
              : modelProvider
                ? { activitySource: { lastActivityMs: () => Date.now() } }
                : {}),
            ...(calendarRegistry.list().length > 0 ? { calendarRegistry } : {}),
            destination,
            historyFile,
            investigate: proactiveInvestigator,
            leadMinutes,
            messagingRegistry: effectiveMessagingRegistry,
            providerId: provider,
            sidecarFile,
            tasksFile,
            trustLedgerFile,
            ...(dailyCap > 0 ? { dailyCap } : {})
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

  // ── Two-way proactive — reply to the last notice ──────────────
  //
  // The classic JARVIS exchange:
  //   JARVIS: "Sir, you have a meeting in 5 minutes."
  //   Tony:   "Push it to 10."
  //   JARVIS: <pushes the meeting>
  //
  // Muse implements this by looking up the most-recent delivered
  // entry in ~/.muse/proactive-history.json and applying the
  // requested action to the underlying task. Only tasks are
  // supported today — calendar back-edits go through the calendar
  // provider's update path, which differs per backend; deferred.
  const lastDeliveredTask = async (): Promise<{
    readonly entry: Awaited<ReturnType<typeof readProactiveHistory>>[number];
    readonly tasksFile: string;
  } | undefined> => {
    const e = env();
    const file = resolveProactiveHistoryFile(e);
    const tasksFile = resolveTasksFile(e);
    const entries = await readProactiveHistory(file, 50);
    for (let i = entries.length - 1; i >= 0; i -= 1) {
      const entry = entries[i]!;
      if (entry.status === "delivered" && entry.kind === "task") {
        return { entry, tasksFile };
      }
    }
    return undefined;
  };

  const parseDuration = (s: string): number | undefined => {
    const match = /^([0-9]+)\s*(s|m|h|d)?$/i.exec(s.trim());
    if (!match) return undefined;
    const n = Number(match[1]);
    const unit = (match[2] ?? "m").toLowerCase();
    const ms = unit === "s" ? 1000 : unit === "h" ? 3_600_000 : unit === "d" ? 86_400_000 : 60_000;
    return n * ms;
  };

  proactive
    .command("done")
    .description("Mark the task from the most recent proactive notice as done")
    .action(async () => {
      const last = await lastDeliveredTask();
      if (!last) {
        io.stderr("No recent delivered task notice. Run `muse proactive watch` first.\n");
        process.exitCode = 1;
        return;
      }
      const { entry, tasksFile } = last;
      const tasks = await readTasks(tasksFile);
      const index = tasks.findIndex((t) => t.id === entry.itemId);
      if (index < 0) {
        io.stderr(`Task ${entry.itemId} no longer in ${tasksFile} (already deleted?).\n`);
        process.exitCode = 1;
        return;
      }
      const next = [...tasks];
      next[index] = { ...next[index]!, completedAt: new Date().toISOString(), status: "done" };
      await writeTasks(tasksFile, next);
      io.stdout(`Marked "${entry.title}" done.\n`);
      const e = env();
      await appendProactiveHistory(resolveProactiveHistoryFile(e), {
        destination: entry.destination,
        firedAtIso: new Date().toISOString(),
        itemId: entry.itemId,
        kind: "task",
        providerId: "cli-reply",
        startIso: entry.startIso,
        status: "delivered",
        text: `↩ user: done`,
        title: entry.title
      });
    });

  proactive
    .command("snooze")
    .description("Push the most recent proactive task's dueAt by a duration (e.g. '10m', '1h', '30s')")
    .argument("<duration>", "Duration: <number><s|m|h|d>; bare number is minutes")
    .action(async (duration: string) => {
      const ms = parseDuration(duration);
      if (!ms) {
        io.stderr(`Could not parse '${duration}'. Try '10m', '1h', '30s'.\n`);
        process.exitCode = 1;
        return;
      }
      const last = await lastDeliveredTask();
      if (!last) {
        io.stderr("No recent delivered task notice. Run `muse proactive watch` first.\n");
        process.exitCode = 1;
        return;
      }
      const { entry, tasksFile } = last;
      const tasks = await readTasks(tasksFile);
      const index = tasks.findIndex((t) => t.id === entry.itemId);
      if (index < 0) {
        io.stderr(`Task ${entry.itemId} no longer in ${tasksFile}.\n`);
        process.exitCode = 1;
        return;
      }
      const current = tasks[index]!;
      const baselineMs = current.dueAt ? new Date(current.dueAt).getTime() : Date.now();
      const newDue = new Date(Math.max(Date.now(), baselineMs) + ms).toISOString();
      const next = [...tasks];
      next[index] = { ...current, dueAt: newDue, status: "open" };
      await writeTasks(tasksFile, next);
      io.stdout(`Snoozed "${entry.title}" — new dueAt ${newDue}\n`);
      const e = env();
      // Also clear the sidecar entry for this id so the next proactive
      // tick re-fires at the new dueAt instead of staying deduped.
      const sidecarFile = e.MUSE_PROACTIVE_SIDECAR_FILE?.trim()?.length
        ? e.MUSE_PROACTIVE_SIDECAR_FILE.trim()
        : join(homedir(), ".muse", "proactive-fired.json");
      try {
        const { readProactiveFired, writeProactiveFired } = await import("@muse/proactivity");
        const fired = await readProactiveFired(sidecarFile);
        const purged = fired.filter((e2) => !(e2.kind === "task" && e2.id === entry.itemId));
        if (purged.length !== fired.length) {
          await writeProactiveFired(sidecarFile, purged);
        }
      } catch { /* sidecar absent / corrupt — next tick will rebuild */ }
      await appendProactiveHistory(resolveProactiveHistoryFile(e), {
        destination: entry.destination,
        firedAtIso: new Date().toISOString(),
        itemId: entry.itemId,
        kind: "task",
        providerId: "cli-reply",
        startIso: newDue,
        status: "delivered",
        text: `↩ user: snooze ${duration}`,
        title: entry.title
      });
    });

  proactive
    .command("dismiss")
    .description("Acknowledge the most recent proactive notice without changing the task — purely a log entry")
    .action(async () => {
      const last = await lastDeliveredTask();
      if (!last) {
        io.stderr("No recent delivered notice.\n");
        process.exitCode = 1;
        return;
      }
      const { entry } = last;
      const e = env();
      await appendProactiveHistory(resolveProactiveHistoryFile(e), {
        destination: entry.destination,
        firedAtIso: new Date().toISOString(),
        itemId: entry.itemId,
        kind: entry.kind,
        providerId: "cli-reply",
        startIso: entry.startIso,
        status: "delivered",
        text: `↩ user: dismiss`,
        title: entry.title
      });
      io.stdout(`Dismissed "${entry.title}" (no state change).\n`);
    });

  proactive
    .command("history")
    .description("Audit recent proactive notices from ~/.muse/proactive-history.json")
    .option("--limit <count>", "Max entries (newest first, default 20, cap 500)", "20")
    .option("--json", "Print the raw entries as JSON")
    .action(async (options: { readonly limit?: string; readonly json?: boolean }) => {
      const e = env();
      const file = resolveProactiveHistoryFile(e);
      const limit = parseBoundedFlag(options.limit, "--limit", 1, 500, 20);
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
