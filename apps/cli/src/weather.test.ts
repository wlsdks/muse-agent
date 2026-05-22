import { Command } from "commander";
import { describe, expect, it } from "vitest";

import {
  describeWeatherCode,
  formatWeather,
  OpenMeteoWeatherProvider,
  registerWeatherCommand,
  type CurrentWeather,
  type GeocodedLocation
} from "./weather.js";

const SEOUL: GeocodedLocation = { country: "South Korea", latitude: 37.566, longitude: 126.978, name: "Seoul", timezone: "Asia/Seoul" };

// Routes the two open-meteo endpoints by host: geocoding vs forecast.
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
});

describe("OpenMeteoWeatherProvider", () => {
  it("geocodes a place name to coordinates", async () => {
    const provider = new OpenMeteoWeatherProvider(fakeFetch({
      geocode: { results: [{ country: "South Korea", latitude: 37.566, longitude: 126.978, name: "Seoul", timezone: "Asia/Seoul" }] }
    }));
    expect(await provider.geocode("Seoul")).toEqual(SEOUL);
  });

  it("returns undefined for an unknown place (empty results)", async () => {
    const provider = new OpenMeteoWeatherProvider(fakeFetch({ geocode: { results: [] } }));
    expect(await provider.geocode("Xyzzyville")).toBeUndefined();
  });

  it("parses current weather and maps the weather code", async () => {
    const provider = new OpenMeteoWeatherProvider(fakeFetch({
      forecast: { current: { apparent_temperature: 19.4, relative_humidity_2m: 55, temperature_2m: 21.6, time: "2026-05-22T15:00", weather_code: 61, wind_speed_10m: 12.3 } }
    }));
    const current = await provider.currentWeather(SEOUL);
    expect(current).toMatchObject({ code: 61, condition: "slight rain", temperatureC: 21.6, apparentC: 19.4, humidityPct: 55, windSpeedKmh: 12.3 });
  });
});

describe("muse weather command", () => {
  function run(args: string[], fetchImpl: typeof globalThis.fetch) {
    const output: string[] = [];
    const io = { fetch: fetchImpl, stderr: (m: string) => output.push(m), stdout: (m: string) => output.push(m) };
    const program = new Command();
    program.exitOverride();
    registerWeatherCommand(program, io);
    return { output, run: program.parseAsync(["node", "muse", "weather", ...args]) };
  }

  it("seeded location → the printed answer reflects the (HTTP-faked) forecast", async () => {
    const fetchImpl = fakeFetch({
      geocode: { results: [{ country: "South Korea", latitude: 37.566, longitude: 126.978, name: "Seoul", timezone: "Asia/Seoul" }] },
      forecast: { current: { apparent_temperature: 19, relative_humidity_2m: 55, temperature_2m: 22, weather_code: 3, wind_speed_10m: 10 } }
    });
    const { output, run: done } = run(["Seoul"], fetchImpl);
    await done;
    const text = output.join("");
    expect(text).toContain("Seoul, South Korea: overcast, 22°C");
  });

  it("unknown place → a clear not-found error, exit 1, no forecast line", async () => {
    const prevExit = process.exitCode;
    const fetchImpl = fakeFetch({ geocode: { results: [] } });
    const { output, run: done } = run(["Xyzzyville"], fetchImpl);
    await done;
    expect(output.join("")).toContain("could not find a place named 'Xyzzyville'");
    expect(process.exitCode).toBe(1);
    process.exitCode = prevExit;
  });
});
