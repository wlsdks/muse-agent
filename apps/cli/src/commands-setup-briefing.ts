/**
 * `muse setup briefing` — one-command morning-briefing preset: every day at
 * a chosen local time, `muse today`'s deterministic content (tasks + next
 * 24h calendar + recent notes; no LLM) lands on the configured daemon
 * channel. Config lives in the same daemon-config file `muse daemon --init`
 * writes (a `dailyBrief` block); the daemon tick (`makeDailyBriefTick`,
 * daemon-delivery-ticks.ts) reads it LIVE every tick, so re-running this
 * wizard takes effect without a daemon restart.
 */

import { isCancel, text } from "@clack/prompts";
import type { Command } from "commander";
import { classifyDaemonLoopHeartbeat, defaultProactiveHeartbeatDir, readProactiveHeartbeat } from "@muse/stores";

import { isNoInput } from "./cli-context.js";
import { readDaemonConfig, resolveDaemonConfigFile, writeDaemonConfig } from "./commands-daemon-config.js";
import { formatDaemonLivenessNotice, SCHEDULER_ADD_DAEMON_STALE_MS } from "./commands-scheduler-setup.js";
import { DEFAULT_DAILY_BRIEF_TIME, parseDailyBriefTime } from "./daily-brief.js";
import type { ProgramIO } from "./program.js";

export interface SetupBriefingHelpers {
  /** Test seam — defaults to `process.env`. */
  readonly env?: () => NodeJS.ProcessEnv;
  /** Test seam — injectable clock for the daemon-liveness check. */
  readonly now?: () => Date;
  /** Test seam — override the heartbeat dir instead of `defaultProactiveHeartbeatDir(env)`. */
  readonly heartbeatDir?: string;
  /** Test seam — replaces the interactive `text()` prompt; `undefined` return = cancelled. */
  readonly promptTime?: (defaultValue: string) => Promise<string | undefined>;
}

async function defaultPromptTime(defaultValue: string): Promise<string | undefined> {
  const result = await text({
    defaultValue,
    message: "What local time should the daily brief arrive? (24-hour HH:MM)",
    placeholder: defaultValue,
    validate: (value) => {
      const candidate = (value ?? "").trim() || defaultValue;
      try {
        parseDailyBriefTime(candidate);
        return undefined;
      } catch (cause) {
        return cause instanceof Error ? cause.message : "invalid time";
      }
    }
  });
  if (isCancel(result)) {
    return undefined;
  }
  const trimmed = String(result).trim();
  return trimmed.length > 0 ? trimmed : defaultValue;
}

export function registerSetupBriefingCommand(
  program: Command,
  io: ProgramIO,
  helpers: SetupBriefingHelpers = {}
): void {
  const setupRoot = program.commands.find((cmd) => cmd.name() === "setup");
  if (!setupRoot) {
    throw new Error("registerSetupBriefingCommand: 'setup' command group must be registered first.");
  }
  setupRoot
    .command("briefing")
    .description("One-command daily brief preset — `muse today`'s deterministic content, delivered on your configured channel at a fixed local time")
    .option("--time <HH:MM>", "Local delivery time, 24-hour (default 08:30, or the currently configured time)")
    .option("--off", "Disable the daily brief (keeps the configured time for next time)")
    .action(async (options: { readonly time?: string; readonly off?: boolean }) => {
      const e = helpers.env?.() ?? process.env;
      const configFile = resolveDaemonConfigFile(e);
      const existing = readDaemonConfig(configFile);
      const currentEnabled = existing.dailyBrief?.enabled ?? false;
      const currentTime = existing.dailyBrief?.time ?? DEFAULT_DAILY_BRIEF_TIME;
      const provider = (e.MUSE_PROACTIVE_PROVIDER ?? existing.provider ?? "log").trim();
      const destination = (e.MUSE_PROACTIVE_DESTINATION ?? existing.destination ?? "@me").trim();

      io.stdout(`Daily brief: ${currentEnabled ? `enabled at ${currentTime}` : "disabled"} → ${provider}:${destination}\n`);

      if (options.off) {
        writeDaemonConfig(configFile, { ...existing, dailyBrief: { enabled: false, time: currentTime } });
        io.stdout(`Daily brief disabled (time kept: ${currentTime}). Re-enable any time with \`muse setup briefing\`.\n`);
        return;
      }

      let timeInput = options.time?.trim();
      if (!timeInput && !isNoInput()) {
        timeInput = await (helpers.promptTime ?? defaultPromptTime)(currentTime);
        if (timeInput === undefined) {
          io.stdout("Cancelled — no changes made.\n");
          return;
        }
      }
      timeInput = timeInput?.trim() || currentTime;

      let parsed: { readonly hour: number; readonly minute: number };
      try {
        parsed = parseDailyBriefTime(timeInput);
      } catch (cause) {
        io.stderr(`muse setup briefing: ${cause instanceof Error ? cause.message : String(cause)}\n`);
        process.exitCode = 1;
        return;
      }
      const normalizedTime = `${parsed.hour.toString().padStart(2, "0")}:${parsed.minute.toString().padStart(2, "0")}`;

      writeDaemonConfig(configFile, { ...existing, dailyBrief: { enabled: true, time: normalizedTime } });
      io.stdout(`Daily brief enabled at ${normalizedTime} → ${provider}:${destination}.\n`);
      io.stdout(`Fires via \`muse daemon\` (\`muse daemon --install\` to survive logout).\n`);

      // Fail-LOUD (not fail-close): the config is already saved above, so a
      // stale/absent daemon must be surfaced loudly — mirrors `scheduler add`'s
      // liveness check (SCHEDULER_ADD_DAEMON_STALE_MS / formatDaemonLivenessNotice).
      const heartbeatDir = helpers.heartbeatDir ?? defaultProactiveHeartbeatDir(e);
      const now = helpers.now ?? (() => new Date());
      const heartbeat = await readProactiveHeartbeat(heartbeatDir);
      const verdict = classifyDaemonLoopHeartbeat(heartbeat, { nowMs: now().getTime(), staleMs: SCHEDULER_ADD_DAEMON_STALE_MS });
      io.stdout(formatDaemonLivenessNotice(verdict));
    });
}
