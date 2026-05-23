/**
 * `muse time [place]` — the current time in a place / timezone. A JARVIS
 * should answer "what time is it in Tokyo?" reliably (DST-correct), not
 * guess — so resolution is deterministic via the platform `Intl` zone
 * database, with a small alias table for the cities people actually say.
 * Pure + dependency-free. Read-only.
 */

import type { Command } from "commander";

import type { ProgramIO } from "./program.js";

/** Common spoken names / abbreviations → IANA zone. Keys are lower-cased. */
const TIMEZONE_ALIASES: Readonly<Record<string, string>> = {
  "berlin": "Europe/Berlin",
  "chicago": "America/Chicago",
  "dubai": "Asia/Dubai",
  "hong kong": "Asia/Hong_Kong",
  "hk": "Asia/Hong_Kong",
  "la": "America/Los_Angeles",
  "london": "Europe/London",
  "los angeles": "America/Los_Angeles",
  "madrid": "Europe/Madrid",
  "mumbai": "Asia/Kolkata",
  "new york": "America/New_York",
  "nyc": "America/New_York",
  "paris": "Europe/Paris",
  "san francisco": "America/Los_Angeles",
  "sf": "America/Los_Angeles",
  "seoul": "Asia/Seoul",
  "shanghai": "Asia/Shanghai",
  "singapore": "Asia/Singapore",
  "sydney": "Australia/Sydney",
  "tokyo": "Asia/Tokyo",
  "toronto": "America/Toronto",
  "utc": "UTC"
};

/** True when `Intl` accepts `zone` as a real IANA timezone. */
function isValidIanaZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve a user phrase to an IANA timezone: a known alias ("tokyo"),
 * or a raw IANA zone the platform recognises ("Asia/Tokyo"). Returns
 * undefined when neither — the caller reports it rather than guessing.
 */
export function resolveTimezone(input: string): string | undefined {
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  const alias = TIMEZONE_ALIASES[trimmed.toLowerCase()];
  if (alias) {
    return alias;
  }
  return isValidIanaZone(trimmed) ? trimmed : undefined;
}

/** "Sun 09:00" — weekday + 24h clock in `zone`, machine-timezone-independent. */
export function formatTimeInZone(zone: string, at: Date): string {
  return new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    hour12: false,
    minute: "2-digit",
    timeZone: zone,
    weekday: "short"
  }).format(at);
}

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
