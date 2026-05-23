import { describe, expect, it } from "vitest";

import { OpenMeteoWeatherProvider, createWeatherTool } from "../src/index.js";

const SEOUL_GEOCODE = { results: [{ country: "South Korea", latitude: 37.566, longitude: 126.978, name: "Seoul", timezone: "Asia/Seoul" }] };

function provider(opts: { geocode?: unknown; forecast?: unknown; geocodeStatus?: number } = {}) {
  const fetchImpl = (async (input: string) => {
    const url = String(input);
    if (url.includes("geocoding-api.open-meteo.com")) {
      return new Response(JSON.stringify(opts.geocode ?? SEOUL_GEOCODE), { status: opts.geocodeStatus ?? 200 });
    }
    return new Response(JSON.stringify(opts.forecast ?? { current: { temperature_2m: 18, weather_code: 1 } }), { status: 200 });
  }) as unknown as typeof globalThis.fetch;
  return new OpenMeteoWeatherProvider(fetchImpl, { baseDelayMs: 0, sleep: async () => {} });
}

describe("createWeatherTool — on-demand weather perception", () => {
  it("is risk:read and returns a weather line for a found location", async () => {
    const tool = createWeatherTool({ provider: provider() });
    expect(tool.definition.risk).toBe("read");
    const out = await tool.execute({ location: "Seoul" }) as { found: boolean; weather?: string };
    expect(out.found).toBe(true);
    expect(out.weather).toContain("Seoul");
    expect(out.weather).toContain("18");
  });

  it("reports found:false for an empty location (no guess)", async () => {
    const out = await createWeatherTool({ provider: provider() }).execute({ location: "  " }) as { found: boolean };
    expect(out.found).toBe(false);
  });

  it("reports found:false when the place can't be geocoded", async () => {
    const tool = createWeatherTool({ provider: provider({ geocode: { results: [] } }) });
    const out = await tool.execute({ location: "Nowheresville" }) as { found: boolean };
    expect(out.found).toBe(false);
  });

  it("its location parameter is described (one-shot tool-calling bar)", async () => {
    const props = (createWeatherTool().definition.inputSchema as { properties: Record<string, { description?: string }> }).properties;
    expect((props.location.description ?? "").length).toBeGreaterThan(0);
    expect(props.location.description ?? "").toContain("e.g.");
  });

  it("with a defaultLocation, a no-arg call uses the configured home + location is not required", async () => {
    const tool = createWeatherTool({ defaultLocation: "Seoul", provider: provider() });
    const schema = tool.definition.inputSchema as { required?: string[]; properties: Record<string, { description?: string }> };
    expect(schema.required).toBeUndefined(); // location optional when a home default exists
    expect(schema.properties.location.description).toContain("Seoul");
    const out = await tool.execute({}) as { found: boolean; location?: string; weather?: string };
    expect(out.found).toBe(true);
    expect(out.location).toBe("Seoul");
    expect(out.weather).toContain("Seoul");
  });

  it("an explicit location still overrides the default", async () => {
    const tool = createWeatherTool({ defaultLocation: "Seoul", provider: provider({ geocode: { results: [{ latitude: 51.5, longitude: -0.1, name: "London", timezone: "Europe/London" }] } }) });
    const out = await tool.execute({ location: "London" }) as { location?: string };
    expect(out.location).toBe("London");
  });

  it("without a defaultLocation, location stays required and a no-arg call is found:false", async () => {
    const tool = createWeatherTool({ provider: provider() });
    expect((tool.definition.inputSchema as { required?: string[] }).required).toEqual(["location"]);
    expect(await tool.execute({})).toMatchObject({ found: false });
  });
});
