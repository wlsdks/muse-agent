/**
 * `weather` agent tool — on-demand current weather + rain heads-up for
 * a place, so a `muse ask` conversation can answer "what's the weather
 * in Seoul?" / "will it rain this afternoon?". Read-only; open-meteo
 * needs no API key (zero-cost), so it's always available. Reuses
 * `resolveWeatherLine` (incl. the rain heads-up).
 */

import type { JsonObject } from "@muse/shared";
import type { MuseTool } from "@muse/tools";

import { resolveRelativeTimePhrase } from "./loopback-relative-time.js";
import { OpenMeteoWeatherProvider, resolveForecastLine, resolveWeatherLine, type WeatherProvider } from "./weather.js";

export interface WeatherToolDeps {
  readonly provider?: WeatherProvider;
  /** Default location for a bare "what's the weather?" — the user's configured home. */
  readonly defaultLocation?: string;
  readonly now?: () => Date;
}

function localDateIso(date: Date): string {
  const y = date.getFullYear().toString().padStart(4, "0");
  const m = (date.getMonth() + 1).toString().padStart(2, "0");
  const d = date.getDate().toString().padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * True only for a real calendar date in YYYY-MM-DD form. The round-trip through
 * Date.UTC rejects impossible days the regex alone accepts — month 13, day 45,
 * Feb 30 — so the tool never echoes a fabricated date back to the model as a
 * real-but-out-of-range day.
 */
function isValidCalendarDate(iso: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(iso);
  if (!m) return false;
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(year, month - 1, day));
  return dt.getUTCFullYear() === year && dt.getUTCMonth() === month - 1 && dt.getUTCDate() === day;
}

/** Resolve a `when` phrase ("tomorrow", "Saturday", "2026-05-30") to a local YYYY-MM-DD, or undefined. */
function resolveTargetDateIso(when: string, now: () => Date): string | undefined {
  if (/^\d{4}-\d{2}-\d{2}/u.test(when)) {
    const candidate = when.slice(0, 10);
    return isValidCalendarDate(candidate) ? candidate : undefined;
  }
  const resolved = resolveRelativeTimePhrase(when, now);
  return resolved ? localDateIso(resolved) : undefined;
}

export function createWeatherTool(deps: WeatherToolDeps = {}): MuseTool {
  const provider = deps.provider ?? new OpenMeteoWeatherProvider();
  const defaultLocation = deps.defaultLocation?.trim();
  const now = deps.now ?? (() => new Date());
  const hasDefault = Boolean(defaultLocation && defaultLocation.length > 0);
  const locationDesc = hasDefault
    ? `Place name, e.g. 'Seoul' or 'London, UK'. Omit for the user's home (${defaultLocation!}).`
    : "Place name to look up, e.g. 'Seoul' or 'London, UK'.";
  return {
    definition: {
      description: hasDefault
        ? "Get the weather for the user's home (omit `location`) or a place. Without `when` it's the current weather + rain heads-up; pass `when` ('tomorrow', 'Saturday', a date) for that upcoming day's forecast (up to ~16 days). Use for weather / temperature / will-it-rain. Read-only."
        : "Get the weather for a place. Without `when` it's the current weather + rain heads-up; pass `when` ('tomorrow', 'Saturday', a date) for that upcoming day's forecast (up to ~16 days). Use for weather / temperature / will-it-rain. Read-only.",
      domain: "system",
      inputSchema: {
        additionalProperties: false,
        properties: {
          location: { description: locationDesc, type: "string" },
          when: { description: "An upcoming day to forecast, e.g. 'tomorrow', 'Saturday', '2026-05-30'. Omit for the current weather.", type: "string" }
        },
        // location is required ONLY when no home default is configured.
        ...(hasDefault ? {} : { required: ["location"] }),
        type: "object"
      },
      keywords: ["weather", "temperature", "rain", "raining", "forecast", "umbrella", "sunny", "cloudy", "snow", "snowing", "humid", "windy", "날씨", "비", "기온", "우산", "눈"],
      name: "weather",
      risk: "read"
    },
    execute: async (args): Promise<JsonObject> => {
      const requested = typeof args["location"] === "string" ? args["location"].trim() : "";
      const location = requested.length > 0 ? requested : (defaultLocation ?? "");
      if (location.length === 0) {
        return { found: false, reason: "location is required (e.g. Seoul) — no home location is configured" };
      }
      const when = typeof args["when"] === "string" ? args["when"].trim() : "";
      if (when.length > 0) {
        const targetDateIso = resolveTargetDateIso(when, now);
        if (!targetDateIso) {
          return { found: false, location, reason: `couldn't understand the day '${when}' — try 'tomorrow', 'Saturday', or a date like 2026-05-30` };
        }
        const forecast = await resolveForecastLine(provider, location, targetDateIso);
        return forecast
          ? { date: targetDateIso, forecast, found: true, location }
          : { date: targetDateIso, found: false, location, reason: "no forecast for that day (past, or beyond the ~16-day horizon), or the lookup failed" };
      }
      const line = await resolveWeatherLine(provider, location);
      return line
        ? { found: true, location, weather: line }
        : { found: false, location, reason: "couldn't find that location or the weather lookup failed" };
    }
  };
}
