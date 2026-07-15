/**
 * `muse quiet` — the persisted quiet-hours (do-not-disturb) setting every
 * UNASKED-notice daemon (API + CLI `muse daemon`) re-resolves live, per
 * tick, via `@muse/proactivity`'s `resolveEffectiveQuietHours` (env wins,
 * then this persisted setting). Same file + same precedence as the web
 * Settings quiet-hours control (`@muse/stores`'s daemon-settings file) — set
 * it here or there, either daemon picks it up on its NEXT tick, no restart.
 * Reminders and the daily brief are user-asked and are NEVER gated by this
 * setting (see `apps/api/src/tick-daemons.ts`'s `liveQuietHours` doc comment).
 *
 *   muse quiet                — show the effective window + where it came from
 *   muse quiet 23:00-08:00    — set + enable
 *   muse quiet off            — disable (keeps the range remembered for next time)
 */

import type { Command } from "commander";

import { parseQuietHours } from "@muse/proactivity";
import { readQuietHoursSettingSync, resolveDaemonSettingsFile, writeQuietHoursSetting } from "@muse/stores";

import { resolveCliLanguage, t } from "./cli-i18n.js";
import { readConfigStore } from "./program-config.js";
import type { ProgramIO } from "./program.js";

export interface QuietCommandHelpers {
  /** Test seam — defaults to `process.env`. */
  readonly env?: () => NodeJS.ProcessEnv;
}

function describeEffective(
  env: NodeJS.ProcessEnv,
  settingsFile: string
): { readonly text: string; readonly source: "env" | "persisted" | "none" } {
  const envRaw = env.MUSE_REMINDER_QUIET_HOURS?.trim();
  if (envRaw && parseQuietHours(envRaw)) {
    return { source: "env", text: envRaw };
  }
  const persisted = readQuietHoursSettingSync(settingsFile);
  if (persisted?.enabled && parseQuietHours(persisted.range)) {
    return { source: "persisted", text: persisted.range };
  }
  return { source: "none", text: "" };
}

export function registerQuietCommand(program: Command, io: ProgramIO, helpers: QuietCommandHelpers = {}): void {
  const env = () => helpers.env?.() ?? process.env;

  program
    .command("quiet")
    .description("Show or set quiet hours (do-not-disturb window) for background daemons — reminders and the daily brief are never affected")
    .argument("[range]", "HH:MM-HH:MM to set + enable, or 'off' to disable (omit to show the current effective window)")
    .action(async (range?: string) => {
      const e = env();
      const settingsFile = resolveDaemonSettingsFile(e);

      if (range === undefined) {
        await resolveCliLanguage(e, () => readConfigStore(io));
        const effective = describeEffective(e, settingsFile);
        const persisted = readQuietHoursSettingSync(settingsFile);
        if (effective.source === "env") {
          io.stdout(`quiet hours: ${effective.text} (from env MUSE_REMINDER_QUIET_HOURS — this wins over the persisted setting)\n`);
        } else if (effective.source === "persisted") {
          io.stdout(`quiet hours: ${effective.text} (persisted, enabled)\n`);
        } else {
          io.stdout(`${t("quiet.notSet")}\n`);
        }
        if (persisted && effective.source !== "persisted") {
          io.stdout(`  persisted setting: ${persisted.range} (${persisted.enabled ? "enabled" : "disabled"})\n`);
        }
        io.stdout(`  reminders + the daily brief always fire regardless (user-asked, not ambient chatter)\n`);
        return;
      }

      if (range.trim().toLowerCase() === "off") {
        const current = readQuietHoursSettingSync(settingsFile);
        await writeQuietHoursSetting(settingsFile, current ? { enabled: false, range: current.range } : null);
        io.stdout(`quiet hours: disabled\n`);
        return;
      }

      if (!parseQuietHours(range)) {
        io.stderr(`Invalid quiet-hours range "${range}" — expected HH:MM-HH:MM (e.g. 23:00-08:00).\n`);
        process.exitCode = 1;
        return;
      }

      await writeQuietHoursSetting(settingsFile, { enabled: true, range: range.trim() });
      io.stdout(`quiet hours: set to ${range.trim()} and enabled\n`);
    });
}
