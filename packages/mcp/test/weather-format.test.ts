import { describe, expect, it } from "vitest";

import { describeWeatherCode, formatWeather } from "../src/weather.js";

describe("describeWeatherCode", () => {
  it("maps a known WMO code to its description", () => {
    expect(describeWeatherCode(0)).toBe("clear sky");
    expect(describeWeatherCode(3)).toBe("overcast");
  });

  it("falls back to a labelled code for an unknown value", () => {
    expect(describeWeatherCode(999)).toBe("weather code 999");
  });
});

describe("formatWeather", () => {
  it("renders place + condition + rounded temp and appends each optional metric only when present", () => {
    const full = formatWeather(
      { country: "KR", name: "Seoul" },
      { apparentC: 20.2, condition: "Clear", humidityPct: 55.4, temperatureC: 21.6, windSpeedKmh: 12.7 }
    );
    // values are Math.round-ed (21.6→22, 20.2→20, 55.4→55, 12.7→13)
    expect(full).toBe("Seoul, KR: Clear, 22°C · feels 20°C · humidity 55% · wind 13 km/h");
  });

  it("omits the country when absent and drops each optional metric that is not a number", () => {
    expect(formatWeather({ name: "Seoul" }, { condition: "Clear", temperatureC: 21 })).toBe("Seoul: Clear, 21°C");
  });
});
