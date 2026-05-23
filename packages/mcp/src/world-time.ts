/**
 * World-time: resolve a place / IANA zone and render the current local
 * time there, DST-correct via the platform `Intl` zone database. Shared
 * by the CLI (`muse time`) and the agent `world_time` tool so both
 * answer "what time is it in Tokyo?" deterministically — never a
 * model guess. Pure + dependency-free; read-only.
 */

import type { JsonObject } from "@muse/shared";
import type { MuseTool } from "@muse/tools";

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

export interface WorldTimeToolDeps {
  /** Injectable clock (test only). */
  readonly now?: () => Date;
}

/**
 * Agent tool: the current time in a place. Use when the user asks what
 * time it is somewhere ("what time is it in Tokyo?", "is it morning in
 * London?"); do NOT use for the user's own local time questions the
 * model already knows, or for scheduling math.
 */
export function createWorldTimeTool(deps: WorldTimeToolDeps = {}): MuseTool {
  const now = deps.now ?? (() => new Date());
  return {
    definition: {
      description:
        "Current local time in a place or timezone. Use when the user asks what time it is somewhere else — e.g. 'what time is it in Tokyo?', 'is it morning in London?'. Pass a city name ('Tokyo', 'New York') or an IANA zone ('Asia/Tokyo'). Do not use for date math or the user's own timezone.",
      domain: "system",
      inputSchema: {
        additionalProperties: false,
        properties: {
          place: {
            description: "City or IANA timezone, e.g. 'Tokyo', 'New York', or 'Asia/Tokyo'.",
            type: "string"
          }
        },
        required: ["place"],
        type: "object"
      },
      keywords: ["time", "timezone", "clock", "hour", "시간", "몇시"],
      name: "world_time",
      risk: "read"
    },
    execute: async (args): Promise<JsonObject> => {
      const place = typeof args["place"] === "string" ? args["place"].trim() : "";
      if (place.length === 0) {
        return { error: "place is required (a city or IANA timezone, e.g. 'Tokyo')" };
      }
      const zone = resolveTimezone(place);
      if (!zone) {
        return { error: `unknown place / timezone '${place}' — try a city (Tokyo, 'New York') or an IANA zone (Asia/Tokyo)` };
      }
      return { place, time: formatTimeInZone(zone, now()), zone };
    }
  };
}
