/**
 * `muse weather <location>` — current conditions via Open-Meteo
 * (free, no API key). Read-only world-sensing, so no outbound-safety
 * gate applies. The provider lives in @muse/mcp so the proactive
 * briefing daemon can reuse it; this file is just the CLI surface.
 */

import { OpenMeteoWeatherProvider, formatDailyForecast, formatRainHeadsUp, formatWeather, type GeocodedLocation, type CurrentWeather, type WeatherProvider } from "@muse/domain-tools";
import type { Command } from "commander";

import type { ProgramIO } from "./program.js";

interface WeatherOptions {
  readonly json?: boolean;
  readonly days?: string;
}

export function registerWeatherCommand(program: Command, io: ProgramIO, provider?: WeatherProvider): void {
  program
    .command("weather")
    .description("Show current weather + rain heads-up for a place (Open-Meteo, free, no key). Omit the place for your configured home (MUSE_WEATHER_LOCATION).")
    .argument("[location...]", "Place name, e.g. 'Seoul' or 'San Francisco' (default: MUSE_WEATHER_LOCATION)")
    .option("--json", "Emit the resolved location + current conditions as JSON")
    .option("--days <n>", "Show a multi-day daily forecast (1-16) instead of just current conditions")
    .action(async (locationParts: readonly string[], options: WeatherOptions) => {
      const query = locationParts.join(" ").trim() || (process.env.MUSE_WEATHER_LOCATION?.trim() ?? "");
      if (query.length === 0) {
        io.stderr("usage: muse weather <location>  (or set MUSE_WEATHER_LOCATION for your home)\n");
        process.exitCode = 1;
        return;
      }
      const weather = provider ?? new OpenMeteoWeatherProvider(io.fetch ?? globalThis.fetch);
      let location: GeocodedLocation | undefined;
      try {
        location = await weather.geocode(query);
      } catch (cause) {
        io.stderr(`muse weather: lookup failed: ${cause instanceof Error ? cause.message : String(cause)}\n`);
        process.exitCode = 1;
        return;
      }
      if (!location) {
        io.stderr(`muse weather: could not find a place named '${query}'.\n`);
        process.exitCode = 1;
        return;
      }
      if (options.days !== undefined) {
        const days = Number(options.days);
        if (!Number.isFinite(days) || days < 1) {
          io.stderr("muse weather: --days must be a positive number (1-16).\n");
          process.exitCode = 1;
          return;
        }
        if (!weather.dailyForecast) {
          io.stderr("muse weather: this provider has no multi-day forecast.\n");
          process.exitCode = 1;
          return;
        }
        let forecast;
        try {
          forecast = await weather.dailyForecast(location, { days: Math.trunc(days) });
        } catch (cause) {
          io.stderr(`muse weather: forecast failed: ${cause instanceof Error ? cause.message : String(cause)}\n`);
          process.exitCode = 1;
          return;
        }
        if (options.json) {
          io.stdout(`${JSON.stringify({ forecast, location }, null, 2)}\n`);
          return;
        }
        const place = location.country ? `${location.name}, ${location.country}` : location.name;
        io.stdout(`${place} — forecast:\n`);
        for (const day of forecast) {
          io.stdout(`  ${formatDailyForecast(day)}\n`);
        }
        return;
      }
      let current: CurrentWeather;
      try {
        current = await weather.currentWeather(location);
      } catch (cause) {
        io.stderr(`muse weather: forecast failed: ${cause instanceof Error ? cause.message : String(cause)}\n`);
        process.exitCode = 1;
        return;
      }
      if (options.json) {
        io.stdout(`${JSON.stringify({ current, location }, null, 2)}\n`);
        return;
      }
      let line = formatWeather(location, current);
      if (weather.rainOutlook) {
        try {
          const outlook = await weather.rainOutlook(location);
          if (outlook) {
            line += ` — ${formatRainHeadsUp(outlook)}`;
          }
        } catch {
          // a forecast blip just omits the heads-up — keep the base line
        }
      }
      io.stdout(`${line}\n`);
    });
}
