import { describe, expect, it } from "vitest";

import { createWeatherTool, formatDailyForecast, OpenMeteoWeatherProvider, resolveForecastLine, type DailyForecast, type GeocodedLocation, type WeatherProvider } from "../src/index.js";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}
const noWait = { baseDelayMs: 0, sleep: async () => {} };
const SEOUL: GeocodedLocation = { latitude: 37.57, longitude: 126.98, name: "Seoul", timezone: "Asia/Seoul" };

describe("OpenMeteoWeatherProvider.dailyForecast", () => {
  it("requests the daily params and parses entries (skipping malformed)", async () => {
    let url = "";
    const fetchImpl = (async (u: string) => {
      url = u;
      return jsonResponse({
        daily: {
          time: ["2026-05-25", "2026-05-26", "bad"],
          weather_code: [61, 0, 0],
          temperature_2m_max: [21, 24, "x"],
          temperature_2m_min: [14, 15, 9],
          precipitation_probability_max: [70, 10, 0]
        }
      });
    }) as unknown as typeof globalThis.fetch;
    const provider = new OpenMeteoWeatherProvider(fetchImpl, noWait);
    const days = await provider.dailyForecast(SEOUL, { days: 3 });
    expect(url).toContain("daily=weather_code");
    expect(url).toContain("forecast_days=3");
    expect(days).toHaveLength(2); // the "bad"/"x" row is dropped
    expect(days[0]).toMatchObject({ condition: "slight rain", dateIso: "2026-05-25", precipitationProbabilityMaxPct: 70, tempMaxC: 21, tempMinC: 14 });
  });

  it("recovers from a transient 503 (retry-hardened like the rest of the read path)", async () => {
    let n = 0;
    const fetchImpl = (async () => {
      n += 1;
      return n === 1
        ? new Response("", { status: 503 })
        : jsonResponse({ daily: { time: ["2026-05-25"], weather_code: [0], temperature_2m_max: [20], temperature_2m_min: [10], precipitation_probability_max: [5] } });
    }) as unknown as typeof globalThis.fetch;
    const provider = new OpenMeteoWeatherProvider(fetchImpl, noWait);
    expect(await provider.dailyForecast(SEOUL, { days: 1 })).toHaveLength(1);
    expect(n).toBe(2);
  });
});

describe("formatDailyForecast", () => {
  it("renders a one-line day summary with the temp range and rain chance", () => {
    const day: DailyForecast = { code: 61, condition: "slight rain", dateIso: "2026-05-25", precipitationProbabilityMaxPct: 70, tempMaxC: 21.4, tempMinC: 13.8 };
    expect(formatDailyForecast(day)).toBe("2026-05-25: slight rain, 14–21°C, rain 70%");
  });
});

const FORECAST: DailyForecast[] = [
  { code: 0, condition: "clear sky", dateIso: "2026-05-25", precipitationProbabilityMaxPct: 5, tempMaxC: 24, tempMinC: 15 },
  { code: 61, condition: "slight rain", dateIso: "2026-05-26", precipitationProbabilityMaxPct: 80, tempMaxC: 19, tempMinC: 13 }
];

function forecastProvider(): WeatherProvider {
  return {
    currentWeather: async () => ({ code: 0, condition: "clear sky", temperatureC: 20 }),
    dailyForecast: async () => FORECAST,
    geocode: async () => SEOUL
  };
}

describe("resolveForecastLine", () => {
  it("returns the matching day's line + date, or undefined past the horizon", async () => {
    expect(await resolveForecastLine(forecastProvider(), "Seoul", { iso: "2026-05-26" })).toEqual({ date: "2026-05-26", line: "Seoul — 2026-05-26: slight rain, 13–19°C, rain 80%" });
    expect(await resolveForecastLine(forecastProvider(), "Seoul", { iso: "2030-01-01" })).toBeUndefined();
  });

  it("returns undefined for a provider that can't forecast", async () => {
    const noForecast: WeatherProvider = { currentWeather: async () => ({ code: 0, condition: "clear", temperatureC: 20 }), geocode: async () => SEOUL };
    expect(await resolveForecastLine(noForecast, "Seoul", { iso: "2026-05-26" })).toBeUndefined();
  });
});

describe("weather tool — `when` selects an upcoming day's forecast", () => {
  const now = () => new Date("2026-05-25T08:00:00+09:00");
  const tool = createWeatherTool({ defaultLocation: "Seoul", now, provider: forecastProvider() });

  it("declares the `when` parameter", () => {
    expect(tool.definition.inputSchema.properties).toHaveProperty("when");
  });

  it("'tomorrow' returns the next day's forecast (not current weather)", async () => {
    const out = await tool.execute({ when: "tomorrow" }) as { found: boolean; forecast?: string; date?: string };
    expect(out.found).toBe(true);
    expect(out.date).toBe("2026-05-26");
    expect(out.forecast).toContain("slight rain");
  });

  it("an explicit date past the horizon reports not-found with the date", async () => {
    const out = await tool.execute({ when: "2030-01-01" }) as { found: boolean; date?: string };
    expect(out.found).toBe(false);
    expect(out.date).toBe("2030-01-01");
  });

  it("an unparseable `when` is reported clearly", async () => {
    const out = await tool.execute({ when: "someday maybe" }) as { found: boolean; reason?: string };
    expect(out.found).toBe(false);
    expect(out.reason).toContain("couldn't understand");
  });

  it("WITHOUT `when` it still returns current weather", async () => {
    const out = await tool.execute({}) as { found: boolean; weather?: string };
    expect(out.found).toBe(true);
    expect(out.weather).toContain("Seoul");
  });
});
