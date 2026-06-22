import { describe, expect, it } from "vitest";

import { OpenMeteoWeatherProvider, type GeocodedLocation } from "../src/index.js";

const SEOUL: GeocodedLocation = { country: "South Korea", latitude: 37.566, longitude: 126.978, name: "Seoul", timezone: "Asia/Seoul" };

function pad(n: number): string {
  return String(n).padStart(2, "0");
}
function localHour(d: Date): string {
  return `${d.getFullYear().toString()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:00`;
}

function forecastFetch(hourly: { time: string[]; precipitation_probability: number[]; weather_code: number[] }, status = 200): typeof globalThis.fetch {
  return (async (input: string | URL) => {
    const url = String(input);
    if (url.includes("geocoding-api.open-meteo.com")) {
      return new Response(JSON.stringify({ results: [SEOUL] }), { status: 200 });
    }
    // One forecast body carries both current (currentWeather) and hourly (rainOutlook).
    return new Response(JSON.stringify({ current: { temperature_2m: 18, weather_code: 1 }, hourly }), { status });
  }) as unknown as typeof globalThis.fetch;
}

describe("OpenMeteoWeatherProvider.rainOutlook — next notable-rain hour", () => {
  it("returns the first future hour above the probability threshold", async () => {
    const now = new Date("2026-05-23T12:00:00");
    const provider = new OpenMeteoWeatherProvider(forecastFetch({
      precipitation_probability: [10, 20, 70, 80],
      time: ["2026-05-23T12:00", "2026-05-23T13:00", "2026-05-23T15:00", "2026-05-23T16:00"],
      weather_code: [1, 2, 63, 80]
    }), { baseDelayMs: 0, sleep: async () => {} });
    const outlook = await provider.rainOutlook(SEOUL, { now: () => now });
    expect(outlook).toEqual({ atIso: "2026-05-23T15:00", condition: "moderate rain", probabilityPct: 70 });
  });

  it("returns undefined when the next 12h are dry (all below threshold)", async () => {
    const now = new Date("2026-05-23T12:00:00");
    const provider = new OpenMeteoWeatherProvider(forecastFetch({
      precipitation_probability: [10, 20, 30],
      time: ["2026-05-23T13:00", "2026-05-23T14:00", "2026-05-23T15:00"],
      weather_code: [1, 2, 2]
    }), { baseDelayMs: 0, sleep: async () => {} });
    expect(await provider.rainOutlook(SEOUL, { now: () => now })).toBeUndefined();
  });

  it("ignores past hours and hours beyond the horizon", async () => {
    const now = new Date("2026-05-23T12:00:00");
    const provider = new OpenMeteoWeatherProvider(forecastFetch({
      precipitation_probability: [90, 90],
      time: ["2026-05-23T09:00", "2026-05-24T20:00"], // one past, one >12h ahead
      weather_code: [63, 63]
    }), { baseDelayMs: 0, sleep: async () => {} });
    expect(await provider.rainOutlook(SEOUL, { now: () => now, withinHours: 12 })).toBeUndefined();
  });
});

describe("resolveWeatherLine — folds a rain heads-up into the briefing weather line", () => {
  it("appends the next-rain heads-up when rain is forecast", async () => {
    const now = new Date();
    const t2 = new Date(now.getTime() + 2 * 3_600_000);
    const t3 = new Date(now.getTime() + 3 * 3_600_000);
    const provider = new OpenMeteoWeatherProvider(forecastFetch({
      precipitation_probability: [10, 75],
      time: [localHour(t2), localHour(t3)],
      weather_code: [1, 63]
    }), { baseDelayMs: 0, sleep: async () => {} });
    const { resolveWeatherLine } = await import("../src/index.js");
    const line = await resolveWeatherLine(provider, "Seoul");
    expect(line).toContain("rain likely");
    expect(line).toContain("moderate rain");
    expect(line).toContain(`${pad(t3.getHours())}:00`);
  });
});
