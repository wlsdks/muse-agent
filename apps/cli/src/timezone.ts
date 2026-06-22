/**
 * `muse time [place]` — the current time in a place / timezone. A JARVIS
 * should answer "what time is it in Tokyo?" reliably (DST-correct), not
 * guess — so resolution is deterministic via the platform `Intl` zone
 * database, with a small alias table for the cities people actually say.
 * Pure + dependency-free. Read-only.
 */

import { formatTimeInZone, resolveTimezone } from "@muse/domain-tools";
import type { Command } from "commander";

import type { ProgramIO } from "./program.js";

export { formatTimeInZone, resolveTimezone } from "@muse/domain-tools";

export function registerTimeCommand(program: Command, io: ProgramIO): void {
  program
    .command("time")
    .description("Current time in a place / timezone — e.g. `muse time tokyo` or `muse time Asia/Tokyo` (omit for local)")
    .argument("[place...]", "City or IANA timezone (omit for the local timezone)")
    .option("--json", "Emit a structured payload")
    .action((placeParts: readonly string[], options: { readonly json?: boolean }) => {
      const now = new Date();
      const place = placeParts.join(" ").trim();
      if (place.length === 0) {
        const localZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
        if (options.json) {
          io.stdout(`${JSON.stringify({ local: true, time: formatTimeInZone(localZone, now), zone: localZone })}\n`);
          return;
        }
        io.stdout(`Local time: ${formatTimeInZone(localZone, now)} (${localZone})\n`);
        return;
      }
      const zone = resolveTimezone(place);
      if (!zone) {
        io.stderr(`muse time: don't recognise '${place}' — pass a known city (tokyo, london, 'new york') or an IANA zone (Asia/Tokyo).\n`);
        process.exitCode = 1;
        return;
      }
      const time = formatTimeInZone(zone, now);
      if (options.json) {
        io.stdout(`${JSON.stringify({ place, time, zone })}\n`);
        return;
      }
      io.stdout(`${time} in ${place} (${zone})\n`);
    });
}
