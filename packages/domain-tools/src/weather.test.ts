import { describe, expect, it } from "vitest";

import {
  describeWeatherCode,
  formatWeather,
  OpenMeteoWeatherProvider,
  resolveWeatherLine,
  type CurrentWeather,
  type GeocodedLocation
} from "./weather.js";

const SEOUL: GeocodedLocation = { country: "South Korea", latitude: 37.566, longitude: 126.978, name: "Seoul", timezone: "Asia/Seoul" };

function fakeFetch(handlers: { geocode?: unknown; forecast?: unknown; geocodeStatus?: number; forecastStatus?: number }): typeof globalThis.fetch {
  return (async (input: string | URL) => {
    const url = String(input);
    if (url.includes("geocoding-api.open-meteo.com")) {
      return new Response(JSON.stringify(handlers.geocode ?? { results: [] }), { status: handlers.geocodeStatus ?? 200 });
    }
    if (url.includes("api.open-meteo.com/v1/forecast")) {
      return new Response(JSON.stringify(handlers.forecast ?? {}), { status: handlers.forecastStatus ?? 200 });
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as unknown as typeof globalThis.fetch;
}

const SEOUL_GEOCODE = { results: [{ country: "South Korea", latitude: 37.566, longitude: 126.978, name: "Seoul", timezone: "Asia/Seoul" }] };

describe("describeWeatherCode", () => {
  it("maps documented WMO codes to text", () => {
    expect(describeWeatherCode(0)).toBe("clear sky");
    expect(describeWeatherCode(61)).toBe("slight rain");
    expect(describeWeatherCode(95)).toBe("thunderstorm");
  });

  it("reports an unknown code's number rather than a misleading default", () => {
    expect(describeWeatherCode(123)).toBe("weather code 123");
  });
});

describe("formatWeather", () => {
  it("renders place + condition + temp and the optional fields when present", () => {
    const current: CurrentWeather = {
      apparentC: 19.4, code: 2, condition: "partly cloudy", humidityPct: 55, observedAtIso: "2026-05-22T15:00", temperatureC: 21.6, timezone: "Asia/Seoul", windSpeedKmh: 12.3
    };
    expect(formatWeather(SEOUL, current)).toBe("Seoul, South Korea: partly cloudy, 22°C · feels 19°C · humidity 55% · wind 12 km/h");
  });

  it("omits optional fields that are absent", () => {
    expect(formatWeather({ latitude: 0, longitude: 0, name: "Null Island" }, { code: 0, condition: "clear sky", temperatureC: 30 }))
      .toBe("Null Island: clear sky, 30°C");
  });

  it("inserts the region to disambiguate same-name cities", () => {
    const clear: CurrentWeather = { code: 0, condition: "clear sky", temperatureC: 20 };
    const illinois: GeocodedLocation = { name: "Springfield", admin1: "Illinois", country: "United States", latitude: 39.8, longitude: -89.6 };
    const missouri: GeocodedLocation = { name: "Springfield", admin1: "Missouri", country: "United States", latitude: 37.2, longitude: -93.3 };
    expect(formatWeather(illinois, clear)).toBe("Springfield, Illinois, United States: clear sky, 20°C");
    // The same city name in a different state renders a DIFFERENT line — real disambiguation.
    expect(formatWeather(missouri, clear)).toBe("Springfield, Missouri, United States: clear sky, 20°C");
    expect(formatWeather(illinois, clear)).not.toBe(formatWeather(missouri, clear));
  });

  it("drops a region that merely repeats the city name (no 'Seoul, Seoul')", () => {
    expect(formatWeather({ name: "Seoul", admin1: "Seoul", country: "South Korea", latitude: 37.566, longitude: 126.978 }, { code: 0, condition: "clear sky", temperatureC: 20 }))
      .toBe("Seoul, South Korea: clear sky, 20°C");
  });
});

describe("OpenMeteoWeatherProvider", () => {
  it("geocodes a place name to coordinates", async () => {
    const provider = new OpenMeteoWeatherProvider(fakeFetch({ geocode: SEOUL_GEOCODE }));
    expect(await provider.geocode("Seoul")).toEqual(SEOUL);
  });

  it("returns undefined for an unknown place (empty results)", async () => {
    const provider = new OpenMeteoWeatherProvider(fakeFetch({ geocode: { results: [] } }));
    expect(await provider.geocode("Xyzzyville")).toBeUndefined();
  });

  it("captures admin1 (the real region), never the country_code, and omits it when absent", async () => {
    const withRegion = new OpenMeteoWeatherProvider(fakeFetch({
      geocode: { results: [{ name: "Springfield", admin1: "Illinois", country: "United States", country_code: "US", latitude: 39.8, longitude: -89.6 }] }
    }));
    // admin1 is the region field; the ISO country_code ("US") must NOT be substituted for it.
    expect(await withRegion.geocode("Springfield")).toMatchObject({ admin1: "Illinois", country: "United States" });
    const noRegion = new OpenMeteoWeatherProvider(fakeFetch({ geocode: SEOUL_GEOCODE }));
    expect(await noRegion.geocode("Seoul")).not.toHaveProperty("admin1");
  });

  it("parses current weather and maps the weather code", async () => {
    const provider = new OpenMeteoWeatherProvider(fakeFetch({
      forecast: { current: { apparent_temperature: 19.4, relative_humidity_2m: 55, temperature_2m: 21.6, time: "2026-05-22T15:00", weather_code: 61, wind_speed_10m: 12.3 } }
    }));
    expect(await provider.currentWeather(SEOUL)).toMatchObject({ code: 61, condition: "slight rain", temperatureC: 21.6, apparentC: 19.4, humidityPct: 55, windSpeedKmh: 12.3 });
  });
});

describe("resolveWeatherLine", () => {
  it("resolves a place name to a one-line current-weather string", async () => {
    const provider = new OpenMeteoWeatherProvider(fakeFetch({
      geocode: SEOUL_GEOCODE,
      forecast: { current: { temperature_2m: 22, weather_code: 3 } }
    }));
    expect(await resolveWeatherLine(provider, "Seoul")).toBe("Seoul, South Korea: overcast, 22°C");
  });

  it("returns undefined (fail-soft) when the place is unknown or the lookup throws", async () => {
    expect(await resolveWeatherLine(new OpenMeteoWeatherProvider(fakeFetch({ geocode: { results: [] } })), "Nowhere")).toBeUndefined();
    expect(await resolveWeatherLine(new OpenMeteoWeatherProvider(fakeFetch({ geocode: SEOUL_GEOCODE, forecastStatus: 500 })), "Seoul")).toBeUndefined();
  });
});
