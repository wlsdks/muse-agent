/**
 * Weather provider behind a model-neutral abstraction (the way
 * calendar did). Read-only world-sensing via Open-Meteo (free, no API
 * key) — `.claude/rules/outbound-safety.md` governs only actions
 * toward a third party, so weather needs no approval gate. Lives in
 * @muse/mcp so both the CLI (`muse weather`) and the proactive
 * briefing daemon can reuse it.
 */

import { fetchWithRetry, type RetryOptions } from "./http-retry.js";
import { resolveRelativeTimePhrase } from "./loopback-relative-time.js";

export { fetchWithRetry, isRetriableStatus, parseRetryAfterMs, type RetryOptions } from "./http-retry.js";

/**
 * The calendar date (YYYY-MM-DD) of an instant AS SEEN in a given IANA timezone.
 * A daily forecast's days are the LOCATION's local calendar days, so "tomorrow"
 * for a far-west city must be resolved in that city's zone — not the server's —
 * or a KST user asking for LA weather gets the wrong day. Deterministic (ICU),
 * machine-timezone-independent.
 */
export function isoInZone(instant: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", { day: "2-digit", month: "2-digit", timeZone, year: "numeric" }).formatToParts(instant);
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** A forecast target: an explicit calendar date, or a relative phrase to resolve in the location's zone. */
export type ForecastTarget = { readonly iso: string } | { readonly relative: string; readonly now: () => Date };

const GEOCODE_URL = "https://geocoding-api.open-meteo.com/v1/search";
const FORECAST_URL = "https://api.open-meteo.com/v1/forecast";

export interface GeocodedLocation {
  readonly name: string;
  /** First-level administrative region (US state, KR 도, …) — disambiguates same-name cities. */
  readonly admin1?: string;
  readonly country?: string;
  readonly latitude: number;
  readonly longitude: number;
  readonly timezone?: string;
}

export interface CurrentWeather {
  readonly temperatureC: number;
  readonly apparentC?: number;
  readonly humidityPct?: number;
  readonly windSpeedKmh?: number;
  readonly code: number;
  readonly condition: string;
  readonly observedAtIso?: string;
  readonly timezone?: string;
}

export interface RainOutlook {
  /** ISO local time of the next notable-rain hour. */
  readonly atIso: string;
  readonly condition: string;
  readonly probabilityPct?: number;
}

export interface RainOutlookOptions {
  readonly now?: () => Date;
  /** Only look this many hours ahead. Default 12. */
  readonly withinHours?: number;
  /** Minimum precipitation probability to flag. Default 50. */
  readonly minProbabilityPct?: number;
}

export interface DailyForecast {
  /** Local calendar date, YYYY-MM-DD. */
  readonly dateIso: string;
  readonly code: number;
  readonly condition: string;
  readonly tempMaxC: number;
  readonly tempMinC: number;
  readonly precipitationProbabilityMaxPct?: number;
}

export interface WeatherProvider {
  geocode(query: string): Promise<GeocodedLocation | undefined>;
  currentWeather(location: GeocodedLocation): Promise<CurrentWeather>;
  /** Next notable-rain hour within the horizon, or undefined if dry. Optional. */
  rainOutlook?(location: GeocodedLocation, options?: RainOutlookOptions): Promise<RainOutlook | undefined>;
  /** Daily forecast for the next `days` calendar days (today first). Optional. */
  dailyForecast?(location: GeocodedLocation, options?: { readonly days?: number }): Promise<DailyForecast[]>;
}

// WMO weather interpretation codes (open-meteo `weather_code`). Only the
// documented buckets — an unknown code reports its number so the user
// still gets a signal rather than a silent "clear".
const WMO_WEATHER_CODES: Readonly<Record<number, string>> = {
  0: "clear sky",
  1: "mainly clear",
  2: "partly cloudy",
  3: "overcast",
  45: "fog",
  48: "depositing rime fog",
  51: "light drizzle",
  53: "moderate drizzle",
  55: "dense drizzle",
  56: "light freezing drizzle",
  57: "dense freezing drizzle",
  61: "slight rain",
  63: "moderate rain",
  65: "heavy rain",
  66: "light freezing rain",
  67: "heavy freezing rain",
  71: "slight snow",
  73: "moderate snow",
  75: "heavy snow",
  77: "snow grains",
  80: "slight rain showers",
  81: "moderate rain showers",
  82: "violent rain showers",
  85: "slight snow showers",
  86: "heavy snow showers",
  95: "thunderstorm",
  96: "thunderstorm with slight hail",
  99: "thunderstorm with heavy hail"
};

export function describeWeatherCode(code: number): string {
  return WMO_WEATHER_CODES[code] ?? `weather code ${code.toString()}`;
}

/**
 * Render a location as "City, Region, Country", omitting absent parts.
 * The region (admin1) disambiguates same-name cities (Springfield, Illinois
 * vs Springfield, Missouri); it's dropped when it merely repeats the city
 * name (Seoul's admin1 is "Seoul") so the line never reads "Seoul, Seoul".
 */
export function formatPlace(location: GeocodedLocation): string {
  const region = location.admin1 && location.admin1 !== location.name ? location.admin1 : undefined;
  return [location.name, region, location.country].filter(Boolean).join(", ");
}

export function formatWeather(location: GeocodedLocation, current: CurrentWeather): string {
  const place = formatPlace(location);
  const parts = [`${current.condition}, ${Math.round(current.temperatureC).toString()}°C`];
  if (typeof current.apparentC === "number") {
    parts.push(`feels ${Math.round(current.apparentC).toString()}°C`);
  }
  if (typeof current.humidityPct === "number") {
    parts.push(`humidity ${Math.round(current.humidityPct).toString()}%`);
  }
  if (typeof current.windSpeedKmh === "number") {
    parts.push(`wind ${Math.round(current.windSpeedKmh).toString()} km/h`);
  }
  return `${place}: ${parts.join(" · ")}`;
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export class OpenMeteoWeatherProvider implements WeatherProvider {
  constructor(
    private readonly fetchImpl: typeof globalThis.fetch = globalThis.fetch,
    private readonly retryOptions: RetryOptions = {}
  ) {}

  async geocode(query: string): Promise<GeocodedLocation | undefined> {
    const url = `${GEOCODE_URL}?name=${encodeURIComponent(query)}&count=1&language=en&format=json`;
    const response = await fetchWithRetry(this.fetchImpl, url, this.retryOptions);
    if (!response.ok) {
      throw new Error(`geocoding failed (${response.status.toString()})`);
    }
    const body = await response.json() as { results?: Array<Record<string, unknown>> };
    const first = body.results?.[0];
    const latitude = numberOrUndefined(first?.latitude);
    const longitude = numberOrUndefined(first?.longitude);
    if (!first || latitude === undefined || longitude === undefined) {
      return undefined;
    }
    return {
      latitude,
      longitude,
      name: typeof first.name === "string" ? first.name : query,
      ...(typeof first.admin1 === "string" ? { admin1: first.admin1 } : {}),
      ...(typeof first.country === "string" ? { country: first.country } : {}),
      ...(typeof first.timezone === "string" ? { timezone: first.timezone } : {})
    };
  }

  async currentWeather(location: GeocodedLocation): Promise<CurrentWeather> {
    const params = new URLSearchParams({
      current: "temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m",
      latitude: location.latitude.toString(),
      longitude: location.longitude.toString(),
      timezone: location.timezone ?? "auto"
    });
    const response = await fetchWithRetry(this.fetchImpl, `${FORECAST_URL}?${params.toString()}`, this.retryOptions);
    if (!response.ok) {
      throw new Error(`forecast failed (${response.status.toString()})`);
    }
    const body = await response.json() as { current?: Record<string, unknown> };
    const current = body.current ?? {};
    const code = numberOrUndefined(current.weather_code) ?? 0;
    return {
      apparentC: numberOrUndefined(current.apparent_temperature),
      code,
      condition: describeWeatherCode(code),
      humidityPct: numberOrUndefined(current.relative_humidity_2m),
      observedAtIso: typeof current.time === "string" ? current.time : undefined,
      temperatureC: numberOrUndefined(current.temperature_2m) ?? 0,
      timezone: location.timezone,
      windSpeedKmh: numberOrUndefined(current.wind_speed_10m)
    };
  }

  async rainOutlook(location: GeocodedLocation, options: RainOutlookOptions = {}): Promise<RainOutlook | undefined> {
    const now = (options.now ?? (() => new Date()))();
    const withinHours = Number.isFinite(options.withinHours) ? Math.max(1, options.withinHours as number) : 12;
    const minProb = Number.isFinite(options.minProbabilityPct) ? (options.minProbabilityPct as number) : 50;
    const params = new URLSearchParams({
      forecast_days: "2",
      hourly: "precipitation_probability,weather_code",
      latitude: location.latitude.toString(),
      longitude: location.longitude.toString(),
      timezone: location.timezone ?? "auto"
    });
    const response = await fetchWithRetry(this.fetchImpl, `${FORECAST_URL}?${params.toString()}`, this.retryOptions);
    if (!response.ok) {
      throw new Error(`forecast failed (${response.status.toString()})`);
    }
    const body = await response.json() as { hourly?: { time?: unknown[]; precipitation_probability?: unknown[]; weather_code?: unknown[] } };
    const times = body.hourly?.time ?? [];
    const probs = body.hourly?.precipitation_probability ?? [];
    const codes = body.hourly?.weather_code ?? [];
    const horizon = now.getTime() + withinHours * 3_600_000;
    for (let i = 0; i < times.length; i += 1) {
      const time = times[i];
      if (typeof time !== "string") {
        continue;
      }
      const at = Date.parse(time);
      if (!Number.isFinite(at) || at < now.getTime() || at > horizon) {
        continue;
      }
      const prob = numberOrUndefined(probs[i]);
      if (prob !== undefined && prob >= minProb) {
        const code = numberOrUndefined(codes[i]) ?? 0;
        return { atIso: time, condition: describeWeatherCode(code), probabilityPct: prob };
      }
    }
    return undefined;
  }

  async dailyForecast(location: GeocodedLocation, options: { readonly days?: number } = {}): Promise<DailyForecast[]> {
    const days = Number.isFinite(options.days) ? Math.max(1, Math.min(16, Math.trunc(options.days as number))) : 7;
    const params = new URLSearchParams({
      daily: "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max",
      forecast_days: days.toString(),
      latitude: location.latitude.toString(),
      longitude: location.longitude.toString(),
      timezone: location.timezone ?? "auto"
    });
    const response = await fetchWithRetry(this.fetchImpl, `${FORECAST_URL}?${params.toString()}`, this.retryOptions);
    if (!response.ok) {
      throw new Error(`forecast failed (${response.status.toString()})`);
    }
    const body = await response.json() as {
      daily?: { time?: unknown[]; weather_code?: unknown[]; temperature_2m_max?: unknown[]; temperature_2m_min?: unknown[]; precipitation_probability_max?: unknown[] };
    };
    const times = body.daily?.time ?? [];
    const codes = body.daily?.weather_code ?? [];
    const maxes = body.daily?.temperature_2m_max ?? [];
    const mins = body.daily?.temperature_2m_min ?? [];
    const probs = body.daily?.precipitation_probability_max ?? [];
    const out: DailyForecast[] = [];
    for (let i = 0; i < times.length; i += 1) {
      const dateIso = times[i];
      const tempMaxC = numberOrUndefined(maxes[i]);
      const tempMinC = numberOrUndefined(mins[i]);
      if (typeof dateIso !== "string" || tempMaxC === undefined || tempMinC === undefined) {
        continue;
      }
      const code = numberOrUndefined(codes[i]) ?? 0;
      const prob = numberOrUndefined(probs[i]);
      out.push({
        code,
        condition: describeWeatherCode(code),
        dateIso,
        tempMaxC,
        tempMinC,
        ...(prob !== undefined ? { precipitationProbabilityMaxPct: prob } : {})
      });
    }
    return out;
  }
}

/**
 * One-line forecast for a day — "2026-05-25: moderate rain, 14–21°C,
 * rain 70%". Pure so the tool / a test can render it without HTTP.
 */
export function formatDailyForecast(day: DailyForecast): string {
  const range = `${Math.round(day.tempMinC).toString()}–${Math.round(day.tempMaxC).toString()}°C`;
  const rain = day.precipitationProbabilityMaxPct !== undefined ? `, rain ${day.precipitationProbabilityMaxPct.toString()}%` : "";
  return `${day.dateIso}: ${day.condition}, ${range}${rain}`;
}

/**
 * One-line rain heads-up for a briefing — "rain likely ~15:00 (moderate
 * rain, 70%)". The time is the HH:MM of the outlook's local ISO hour.
 */
export function formatRainHeadsUp(outlook: RainOutlook): string {
  const hhmm = /T(\d{2}:\d{2})/u.exec(outlook.atIso)?.[1] ?? outlook.atIso;
  const pct = outlook.probabilityPct !== undefined ? `, ${outlook.probabilityPct.toString()}%` : "";
  return `rain likely ~${hhmm} (${outlook.condition}${pct})`;
}

/**
 * Resolve a place + a target calendar date (YYYY-MM-DD) to a one-line
 * forecast string for that day, or `undefined` if the place can't be
 * found / the day is past the forecast horizon / the lookup fails.
 * Fail-soft like {@link resolveWeatherLine}.
 */
export async function resolveForecastLine(
  provider: WeatherProvider,
  query: string,
  target: ForecastTarget
): Promise<{ readonly date: string; readonly line: string } | undefined> {
  if (!provider.dailyForecast) {
    return undefined;
  }
  try {
    const location = await provider.geocode(query);
    if (!location) {
      return undefined;
    }
    // A relative phrase ("tomorrow") is the LOCATION's local day, resolved in its
    // zone; an explicit ISO date is the same calendar day everywhere.
    let targetDateIso: string;
    if ("iso" in target) {
      targetDateIso = target.iso;
    } else {
      const instant = resolveRelativeTimePhrase(target.relative, target.now);
      if (!instant) {
        return undefined;
      }
      targetDateIso = location.timezone ? isoInZone(instant, location.timezone) : isoInZone(instant, "UTC");
    }
    const days = await provider.dailyForecast(location, { days: 16 });
    const match = days.find((day) => day.dateIso === targetDateIso);
    if (!match) {
      return undefined;
    }
    const place = formatPlace(location);
    return { date: targetDateIso, line: `${place} — ${formatDailyForecast(match)}` };
  } catch {
    return undefined;
  }
}

/**
 * Resolve a place name to a one-line current-weather string, or
 * `undefined` if the place can't be found / the lookup fails. Used by
 * the proactive briefing to ground a heads-up ("rain — leave early")
 * without throwing into the briefing path.
 */
export async function resolveWeatherLine(
  provider: WeatherProvider,
  query: string
): Promise<string | undefined> {
  try {
    const location = await provider.geocode(query);
    if (!location) {
      return undefined;
    }
    const line = formatWeather(location, await provider.currentWeather(location));
    if (provider.rainOutlook) {
      try {
        const outlook = await provider.rainOutlook(location);
        if (outlook) {
          return `${line} — ${formatRainHeadsUp(outlook)}`;
        }
      } catch {
        // keep the base current-weather line — a forecast blip never drops it
      }
    }
    return line;
  } catch {
    return undefined;
  }
}
