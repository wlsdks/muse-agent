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

// A provider whose HTTP layer keeps failing the way a real outage does — a
// persistent transient status (retries exhaust → throw), a network reject, or a
// 200 with a non-JSON body (malformed third-party response). Drives the REAL
// OpenMeteoWeatherProvider + fetchWithRetry, not a stubbed provider.
function failingProvider(mode: "status" | "reject" | "malformed", status = 503) {
  const fetchImpl = (async () => {
    if (mode === "reject") throw new Error("ECONNRESET");
    if (mode === "malformed") return new Response("<html>503 from a proxy</html>", { status: 200 });
    return new Response("", { status });
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

  // Reliability under a real-world outage: a tool that THROWS on a transient
  // upstream failure breaks the agent's tool loop. The current-weather path must
  // degrade to found:false, never reject.
  it("current weather: a persistent 503 (retries exhausted) → found:false, the tool never throws", async () => {
    const tool = createWeatherTool({ provider: failingProvider("status", 503) });
    const out = await tool.execute({ location: "Seoul" }) as { found: boolean; reason?: string };
    expect(out.found).toBe(false);
    expect(out.reason).toBeDefined();
  });

  it("current weather: a network reject → found:false, the tool never throws", async () => {
    const tool = createWeatherTool({ provider: failingProvider("reject") });
    await expect(tool.execute({ location: "Seoul" })).resolves.toMatchObject({ found: false });
  });

  it("current weather: a 200 with a malformed (non-JSON) body → found:false, no parse-throw escapes", async () => {
    const tool = createWeatherTool({ provider: failingProvider("malformed") });
    await expect(tool.execute({ location: "Seoul" })).resolves.toMatchObject({ found: false });
  });

  it("forecast path (`when` set): a persistent 5xx → found:false with the date echoed, no throw", async () => {
    const tool = createWeatherTool({ now: () => new Date("2026-05-30T00:00:00Z"), provider: failingProvider("status", 502) });
    const out = await tool.execute({ location: "Seoul", when: "2026-05-31" }) as { found: boolean; date?: string };
    expect(out.found).toBe(false);
    expect(out.date).toBe("2026-05-31");
  });

  it("rejects an IMPOSSIBLE calendar date instead of echoing it as a real out-of-range day", async () => {
    // The 12B can emit a date-arithmetic slip ('2026-02-30', month 13). The old
    // code matched the \d{4}-\d{2}-\d{2} shape and echoed `date: '2026-02-30'`
    // with reason "no forecast for that day" — asserting an impossible day is a
    // real day out of range (a grounded-lie). Now it routes to "couldn't
    // understand the day", and never reaches the provider.
    const tool = createWeatherTool({ now: () => new Date("2026-05-30T00:00:00Z"), provider: provider() });
    for (const bad of ["2026-13-45", "2026-02-30", "2026-00-10"]) {
      const out = await tool.execute({ location: "Seoul", when: bad }) as { found: boolean; date?: string; reason?: string };
      expect(out.found).toBe(false);
      expect(out.date).toBeUndefined();
      expect(out.reason).toContain("couldn't understand");
    }
  });

  it("a full ISO timestamp still resolves to its (valid) date part", async () => {
    const tool = createWeatherTool({ now: () => new Date("2026-05-30T00:00:00Z"), provider: failingProvider("status", 502) });
    const out = await tool.execute({ location: "Seoul", when: "2026-05-31T15:00:00Z" }) as { date?: string };
    expect(out.date).toBe("2026-05-31");
  });
});
