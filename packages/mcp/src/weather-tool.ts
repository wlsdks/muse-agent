/**
 * `weather` agent tool — on-demand current weather + rain heads-up for
 * a place, so a `muse ask` conversation can answer "what's the weather
 * in Seoul?" / "will it rain this afternoon?". Read-only; open-meteo
 * needs no API key (zero-cost), so it's always available. Reuses
 * `resolveWeatherLine` (incl. the goal-795 rain heads-up).
 */

import type { JsonObject } from "@muse/shared";
import type { MuseTool } from "@muse/tools";

import { OpenMeteoWeatherProvider, resolveWeatherLine, type WeatherProvider } from "./weather.js";

export interface WeatherToolDeps {
  readonly provider?: WeatherProvider;
  /** Default location for a bare "what's the weather?" — the user's configured home. */
  readonly defaultLocation?: string;
}

export function createWeatherTool(deps: WeatherToolDeps = {}): MuseTool {
  const provider = deps.provider ?? new OpenMeteoWeatherProvider();
  const defaultLocation = deps.defaultLocation?.trim();
  const locationDesc = defaultLocation && defaultLocation.length > 0
    ? `Place name, e.g. 'Seoul' or 'London, UK'. Omit for the user's home (${defaultLocation}).`
    : "Place name to look up, e.g. 'Seoul' or 'London, UK'.";
  return {
    definition: {
      description: defaultLocation && defaultLocation.length > 0
        ? "Get the current weather (and a rain heads-up). Omit `location` for the user's home location; pass a place for elsewhere. Use when the user asks about the weather, temperature, or whether it will rain. Read-only."
        : "Get the current weather (and a rain heads-up) for a place. Use when the user asks about the weather, temperature, or whether it will rain; do not use for general facts or forecasts beyond today. Read-only.",
      domain: "system",
      inputSchema: {
        additionalProperties: false,
        properties: {
          location: { description: locationDesc, type: "string" }
        },
        // location is required ONLY when no home default is configured.
        ...(defaultLocation && defaultLocation.length > 0 ? {} : { required: ["location"] }),
        type: "object"
      },
      keywords: ["weather", "temperature", "rain", "forecast", "umbrella"],
      name: "weather",
      risk: "read"
    },
    execute: async (args): Promise<JsonObject> => {
      const requested = typeof args["location"] === "string" ? args["location"].trim() : "";
      const location = requested.length > 0 ? requested : (defaultLocation ?? "");
      if (location.length === 0) {
        return { found: false, reason: "location is required (e.g. Seoul) — no home location is configured" };
      }
      const line = await resolveWeatherLine(provider, location);
      return line
        ? { found: true, location, weather: line }
        : { found: false, location, reason: "couldn't find that location or the weather lookup failed" };
    }
  };
}
