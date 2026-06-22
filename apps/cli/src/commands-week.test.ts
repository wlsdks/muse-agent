import type { DailyForecast, WeatherProvider } from "@muse/domain-tools";
import { describe, expect, it } from "vitest";

import { formatWeekAgenda, formatWeekForecast, groupWeekAgenda, resolveWeekForecasts } from "./commands-week.js";

const now = new Date("2026-06-05T09:00:00"); // local Friday

const fcDay = (over: Partial<DailyForecast>): DailyForecast =>
  ({ code: 2, condition: "Partly cloudy", dateIso: "2026-06-05", tempMaxC: 24.6, tempMinC: 14.2, ...over });

describe("groupWeekAgenda — bucket the next 7 days by local calendar day", () => {
  it("groups events / due tasks / birthdays under the right day, timed events first by time", () => {
    const week = groupWeekAgenda({
      birthdays: [{ daysUntil: 2, name: "Mina" }],
      events: [
        { startsAtIso: "2026-06-05T14:00:00", title: "Lunch" },
        { startsAtIso: "2026-06-05T10:00:00", title: "Standup" }
      ],
      tasks: [{ dueAt: "2026-06-05T23:00:00", title: "Pay rent" }]
    }, now);
    expect(week[0]!.label).toBe("Today — Fri, Jun 5");
    // timed events sorted by time, THEN the untimed task
    expect(week[0]!.lines).toEqual(["10:00 Standup", "14:00 Lunch", "☑ Pay rent (due)"]);
    // birthday 2 days out lands under that day's bucket
    const sunday = week.find((d) => d.lines.some((l) => l.includes("Mina")))!;
    expect(sunday.lines).toContain("🎂 Mina's birthday");
  });

  it("labels day 0 'Today' and day 1 'Tomorrow', and SKIPS empty days", () => {
    const week = groupWeekAgenda({
      birthdays: [],
      events: [{ startsAtIso: "2026-06-06T11:00:00", title: "Dentist" }], // tomorrow only
      tasks: []
    }, now);
    expect(week).toHaveLength(1); // only the day with the event
    expect(week[0]!.label).toBe("Tomorrow — Sat, Jun 6");
    expect(week[0]!.lines).toEqual(["11:00 Dentist"]);
  });

  it("ignores items outside the 7-day window and drops unparseable dates", () => {
    const week = groupWeekAgenda({
      birthdays: [{ daysUntil: 30, name: "Far" }], // beyond the window (daysUntil 30 ≥ 7)
      events: [{ startsAtIso: "not-a-date", title: "Bad" }],
      tasks: [{ dueAt: "2026-07-20T10:00:00", title: "Next month" }]
    }, now);
    expect(week).toEqual([]);
  });

  it("strips untrusted terminal escapes from a third-party event title", () => {
    const week = groupWeekAgenda({ birthdays: [], events: [{ startsAtIso: "2026-06-05T10:00:00", title: "Stand\u001b[31mup" }], tasks: [] }, now);
    expect(week[0]!.lines[0]).not.toContain("\u001b");
    expect(week[0]!.lines[0]).toContain("10:00");
  });
});

describe("formatWeekAgenda", () => {
  it("renders day headers and indented items", () => {
    const out = formatWeekAgenda([{ label: "Today — Fri, Jun 5", lines: ["10:00 Standup", "☑ Pay rent (due)"] }]);
    expect(out).toContain("📅 This week:");
    expect(out).toContain("  Today — Fri, Jun 5");
    expect(out).toContain("    10:00 Standup");
  });

  it("reports a clear week when nothing is scheduled", () => {
    expect(formatWeekAgenda([])).toContain("Your week ahead is clear");
  });

  it("renders the day's forecast in the header after the label", () => {
    const out = formatWeekAgenda([{ forecast: "Sunny, 18–27°C", label: "Today — Fri, Jun 5", lines: ["10:00 Standup"] }]);
    expect(out).toContain("  Today — Fri, Jun 5 — Sunny, 18–27°C");
    expect(out).toContain("    10:00 Standup");
  });
});

describe("groupWeekAgenda — weather forecast attached per day", () => {
  it("attaches each day's forecast to its header AND shows a forecast-only (free) day", () => {
    const week = groupWeekAgenda({
      birthdays: [],
      events: [{ startsAtIso: "2026-06-05T10:00:00", title: "Standup" }], // today
      forecasts: [
        { dateIso: "2026-06-05", summary: "Sunny, 18–27°C" },        // today (has an event)
        { dateIso: "2026-06-07", summary: "Rain, 14–19°C, rain 80%" } // a free day — still shows
      ],
      tasks: []
    }, now);
    expect(week.find((d) => d.label.startsWith("Today"))!.forecast).toBe("Sunny, 18–27°C");
    const freeDay = week.find((d) => d.forecast?.startsWith("Rain"))!;
    expect(freeDay.lines).toEqual([]);   // no agenda items, but the day appears for its weather
    expect(freeDay.label).toContain("Jun 7");
  });

  it("with no forecasts passed, behaviour is unchanged (empty days skipped, no forecast field)", () => {
    const week = groupWeekAgenda({ birthdays: [], events: [{ startsAtIso: "2026-06-06T11:00:00", title: "Dentist" }], tasks: [] }, now);
    expect(week).toHaveLength(1);
    expect(week[0]!.forecast).toBeUndefined();
  });
});

describe("formatWeekForecast — compact per-day weather for the header", () => {
  it("is condition + rounded range + rain, with NO date prefix", () => {
    expect(formatWeekForecast(fcDay({ precipitationProbabilityMaxPct: 30 }))).toBe("Partly cloudy, 14–25°C, rain 30%");
    expect(formatWeekForecast(fcDay({}))).toBe("Partly cloudy, 14–25°C");
  });
});

describe("resolveWeekForecasts — multi-day forecast for the week, gracefully absent", () => {
  const provider = (days: readonly DailyForecast[]): WeatherProvider => ({
    currentWeather: async () => ({ code: 0, condition: "Clear", temperatureC: 20 }),
    dailyForecast: async () => [...days],
    geocode: async () => ({ country: "KR", latitude: 37.5, longitude: 127, name: "Seoul" })
  });

  it("returns per-day summaries keyed by date when a location is configured", async () => {
    const out = await resolveWeekForecasts({ MUSE_WEATHER_LOCATION: "Seoul" }, 2, provider([
      fcDay({ condition: "Sunny", dateIso: "2026-06-05" }),
      fcDay({ condition: "Rain", dateIso: "2026-06-06", precipitationProbabilityMaxPct: 70 })
    ]));
    expect(out).toEqual([
      { dateIso: "2026-06-05", summary: "Sunny, 14–25°C" },
      { dateIso: "2026-06-06", summary: "Rain, 14–25°C, rain 70%" }
    ]);
  });

  it("returns [] when no MUSE_WEATHER_LOCATION is set (weather simply omitted, never errors)", async () => {
    expect(await resolveWeekForecasts({}, 7, provider([fcDay({})]))).toEqual([]);
  });
});
