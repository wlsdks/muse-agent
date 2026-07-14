/**
 * `muse digest` — read-only visibility into the interruption budget's daily
 * digest queue (`docs/design` interruption-budget plan §B3). When an UNASKED
 * notice loop (pattern / ambient / followup / background-exit / check-in) is
 * over its hourly/daily budget, it lands here instead of sending immediately;
 * the daemon's digest-tick compiles + sends the whole queue once a day.
 *
 * This command only LISTS — the flush itself is daemon-owned (apps/api's
 * `digest-tick.ts`, mirrored in the CLI daemon), matching the plan's
 * "flush is daemon-only, keep the command minimal" call.
 */

import { resolveDigestQueueFile, resolveDigestSentFile } from "@muse/autoconfigure";
import { DEFAULT_DIGEST_HOUR, formatDigestItemLine } from "@muse/proactivity";
import { digestAlreadySentToday, readDigestQueue } from "@muse/stores";
import type { Command } from "commander";

import type { ProgramIO } from "./program.js";

interface SharedOptions {
  readonly json?: boolean;
}

function localDigestQueueFile(): string {
  return resolveDigestQueueFile(process.env);
}

function localDigestSentFile(): string {
  return resolveDigestSentFile(process.env);
}

function resolveDigestHour(env: NodeJS.ProcessEnv): number {
  const raw = env.MUSE_DIGEST_HOUR ? Number(env.MUSE_DIGEST_HOUR) : undefined;
  return raw !== undefined && Number.isFinite(raw) && raw >= 0 && raw <= 23 ? Math.trunc(raw) : DEFAULT_DIGEST_HOUR;
}

/** Pure — human hint of when the next flush is expected, given the local hour. */
export function describeNextDigestFlush(now: Date, digestHour: number, alreadySentToday: boolean): string {
  const hourLabel = `${digestHour.toString().padStart(2, "0")}:00`;
  if (now.getHours() < digestHour) {
    return `today at ${hourLabel} local`;
  }
  if (now.getHours() === digestHour && !alreadySentToday) {
    return `any moment now (in the ${hourLabel} window)`;
  }
  return `tomorrow at ${hourLabel} local`;
}

export function registerDigestCommands(program: Command, io: ProgramIO): void {
  const digest = program
    .command("digest")
    .description("Notices the interruption budget deferred — compiled into one daily message by the background daemon");

  digest
    .command("list")
    .description("List notices waiting for the next daily digest flush (read-only — the flush itself runs in the daemon)")
    .option("--json", "Print the raw payload instead of the formatted list")
    .action(async (options: SharedOptions) => {
      const env = process.env;
      const now = new Date();
      const items = await readDigestQueue(localDigestQueueFile());
      const digestHour = resolveDigestHour(env);
      const alreadySentToday = await digestAlreadySentToday(localDigestSentFile(), now);
      const nextFlush = describeNextDigestFlush(now, digestHour, alreadySentToday);
      if (options.json) {
        io.stdout(`${JSON.stringify({ items, nextFlush, pending: items.length }, null, 2)}\n`);
        return;
      }
      if (items.length === 0) {
        io.stdout(`No notices pending. Next flush: ${nextFlush}.\n`);
        return;
      }
      const lines = items.map(formatDigestItemLine);
      io.stdout(`${lines.join("\n")}\n\n${items.length.toString()} pending — next flush: ${nextFlush}.\n`);
    });
}
