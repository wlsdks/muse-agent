import { describe, expect, it } from "vitest";

import { OpenMeteoWeatherProvider, resolveWeatherLine } from "../src/weather.js";

/**
 * P19 target-completion audit (the P→P seam check). 753 added
 * retry-with-backoff to the weather provider's fetches; this proves
 * the retry COMPOSES with its real consumer — `resolveWeatherLine`,
 * the proactive-briefing path — so a transient blip yields a weather
 * line instead of the briefing silently dropping it. The retry is
 * load-bearing here, shown before/after.
 */

function geocodeOk(): Response {
  return new Response(JSON.stringify({ results: [{ country: "KR", latitude: 37.57, longitude: 126.98, name: "Seoul", timezone: "Asia/Seoul" }] }), { status: 200 });
}
function forecastOk(): Response {
  return new Response(JSON.stringify({ current: { temperature_2m: 21, weather_code: 0 } }), { status: 200 });
}
function status(code: number): Response {
  return new Response("", { status: code });
}

function sequenceFetch(factories: Array<() => Response>) {
  let index = 0;
  const fetchImpl = (async () => {
    const factory = factories[Math.min(index, factories.length - 1)]!;
    index += 1;
    return factory();
  }) as unknown as typeof globalThis.fetch;
  return fetchImpl;
}

const noWait = { baseDelayMs: 0, sleep: async () => {} };

describe("P19 audit — weather retry composes with the briefing consumer", () => {
  it("resolveWeatherLine returns a line through a transient 503 (retry recovers the briefing)", async () => {
    const provider = new OpenMeteoWeatherProvider(
      sequenceFetch([() => status(503), geocodeOk, forecastOk]),
      noWait
    );
    const line = await resolveWeatherLine(provider, "Seoul");
    expect(line).toBeDefined();
    expect(line).toContain("Seoul");
    expect(line).toContain("21°C");
  });

  it("WITHOUT retry the same transient 503 drops the weather line (retry is load-bearing)", async () => {
    const provider = new OpenMeteoWeatherProvider(
      sequenceFetch([() => status(503), geocodeOk, forecastOk]),
      { ...noWait, retries: 0 }
    );
    // resolveWeatherLine swallows the geocode throw → undefined; the
    // briefing would have no weather line. This is exactly the gap 753 closed.
    expect(await resolveWeatherLine(provider, "Seoul")).toBeUndefined();
  });
});
