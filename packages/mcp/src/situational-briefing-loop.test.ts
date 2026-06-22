import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MessagingProviderRegistry, TelegramProvider } from "@muse/messaging";
import { describe, expect, it } from "vitest";

import { addObjective, type StandingObjective } from "@muse/stores";
import { runDueSituationalBriefing } from "./situational-briefing-loop.js";
import type { BriefingImminent } from "@muse/proactivity";
import { OpenMeteoWeatherProvider } from "./weather.js";

function fakeJsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    headers: { "content-type": "application/json" },
    status: 200
  });
}

function fixtures() {
  const dir = mkdtempSync(join(tmpdir(), "muse-briefing-deliver-"));
  return { objectivesFile: join(dir, "objectives.json"), sidecarFile: join(dir, "briefing-fired.json") };
}

const NOW = new Date("2026-05-19T09:00:00.000Z");

function objective(overrides: Partial<StandingObjective> = {}): StandingObjective {
  return {
    createdAt: "2026-05-19T08:00:00.000Z",
    id: "obj_deploy",
    kind: "until",
    spec: "watch the deploy until it is green",
    status: "active",
    userId: "stark",
    ...overrides
  };
}

const imminent: BriefingImminent[] = [
  { kind: "calendar", startsAt: new Date(NOW.getTime() + 15 * 60_000), title: "Q3 review" }
];

describe("runDueSituationalBriefing — P8-b2 contract-faithful real-channel delivery, deduped", () => {
  function telegram(posts: { url: string; body: string }[]) {
    return new TelegramProvider({
      baseUrl: "https://tg.test",
      fetch: async (url, init) => {
        posts.push({ body: String(init?.body), url: String(url) });
        return fakeJsonResponse({ ok: true, result: { message_id: 7 } });
      },
      token: "BOT-TOK"
    });
  }

  it("POSTs ONE synthesised briefing over the real provider's HTTP send and dedupes within the window", async () => {
    const { objectivesFile, sidecarFile } = fixtures();
    await addObjective(objectivesFile, objective());
    const posts: { url: string; body: string }[] = [];
    const messagingRegistry = new MessagingProviderRegistry([telegram(posts)]);

    const opts = {
      destination: "555",
      imminent,
      messagingRegistry,
      now: () => NOW,
      objectivesFile,
      providerId: "telegram",
      sidecarFile,
      windowMs: 4 * 60 * 60_000
    };

    const first = await runDueSituationalBriefing(opts);
    expect(first).toEqual({ delivered: 1 });
    expect(posts).toHaveLength(1);
    expect(posts[0]!.url).toBe("https://tg.test/botBOT-TOK/sendMessage");
    const body = JSON.parse(posts[0]!.body) as { chat_id: string; text: string };
    expect(body.chat_id).toBe("555");
    // ONE message synthesising the imminent item AND the objective.
    expect(body.text).toContain("[Briefing]");
    expect(body.text).toContain("in 15 min: Q3 review");
    expect(body.text).toContain("watch the deploy until it is green");

    // Second tick within the window → the real sidecar dedupes it.
    const second = await runDueSituationalBriefing(opts);
    expect(second).toEqual({ delivered: 0, reason: "in-window" });
    expect(posts).toHaveLength(1);
  });

  it("does not POST when there is nothing worth briefing", async () => {
    const { objectivesFile, sidecarFile } = fixtures();
    await addObjective(objectivesFile, objective({ status: "done" }));
    const posts: { url: string; body: string }[] = [];
    const summary = await runDueSituationalBriefing({
      destination: "555",
      imminent: [],
      messagingRegistry: new MessagingProviderRegistry([telegram(posts)]),
      now: () => NOW,
      objectivesFile,
      providerId: "telegram",
      sidecarFile
    });
    expect(summary).toEqual({ delivered: 0, reason: "nothing-to-say" });
    expect(posts).toHaveLength(0);
  });

  it("grounds the briefing with a seeded location's (HTTP-faked) forecast", async () => {
    const { objectivesFile, sidecarFile } = fixtures();
    await addObjective(objectivesFile, objective());
    const posts: { url: string; body: string }[] = [];
    // Real OpenMeteoWeatherProvider, only the HTTP boundary faked.
    const weatherProvider = new OpenMeteoWeatherProvider((async (input: string | URL) => {
      const url = String(input);
      if (url.includes("geocoding-api.open-meteo.com")) {
        return fakeJsonResponse({ results: [{ country: "South Korea", latitude: 37.566, longitude: 126.978, name: "Seoul", timezone: "Asia/Seoul" }] });
      }
      return fakeJsonResponse({ current: { temperature_2m: 22, weather_code: 3 } });
    }) as unknown as typeof globalThis.fetch);

    const summary = await runDueSituationalBriefing({
      destination: "555",
      imminent,
      messagingRegistry: new MessagingProviderRegistry([telegram(posts)]),
      now: () => NOW,
      objectivesFile,
      providerId: "telegram",
      sidecarFile,
      weatherLocation: "Seoul",
      weatherProvider
    });
    expect(summary).toEqual({ delivered: 1 });
    const body = JSON.parse(posts[0]!.body) as { text: string };
    expect(body.text).toContain("Weather: Seoul, South Korea: overcast, 22°C");
    // Still carries the imminent item — weather is supplementary.
    expect(body.text).toContain("in 15 min: Q3 review");
  });

  it("grounds the briefing with unread inbox items from the email provider (P11)", async () => {
    const { objectivesFile, sidecarFile } = fixtures();
    await addObjective(objectivesFile, objective());
    const posts: { url: string; body: string }[] = [];
    const emailProvider = {
      listRecent: async () => [
        { from: "Alice <a@x.com>", id: "m1", snippet: "draft", subject: "Q3 plan", unread: true },
        { from: "Bob <b@y.com>", id: "m2", snippet: "noon", subject: "lunch", unread: false }
      ]
    };
    const summary = await runDueSituationalBriefing({
      destination: "555",
      emailProvider,
      imminent,
      messagingRegistry: new MessagingProviderRegistry([telegram(posts)]),
      now: () => NOW,
      objectivesFile,
      providerId: "telegram",
      sidecarFile
    });
    expect(summary).toEqual({ delivered: 1 });
    const body = JSON.parse(posts[0]!.body) as { text: string };
    expect(body.text).toContain("Inbox: 1 unread — “Q3 plan” (Alice)");
    expect(body.text).toContain("in 15 min: Q3 review"); // still carries imminent
    expect(body.text).not.toContain("lunch"); // read message excluded
  });

  it("does NOT fire on weather alone — weather is supplementary, never a trigger", async () => {
    const { objectivesFile, sidecarFile } = fixtures();
    await addObjective(objectivesFile, objective({ status: "done" }));
    const posts: { url: string; body: string }[] = [];
    let weatherFetched = false;
    const weatherProvider = new OpenMeteoWeatherProvider((async () => {
      weatherFetched = true;
      return fakeJsonResponse({ results: [] });
    }) as unknown as typeof globalThis.fetch);
    const summary = await runDueSituationalBriefing({
      destination: "555",
      imminent: [],
      messagingRegistry: new MessagingProviderRegistry([telegram(posts)]),
      now: () => NOW,
      objectivesFile,
      providerId: "telegram",
      sidecarFile,
      weatherLocation: "Seoul",
      weatherProvider
    });
    expect(summary).toEqual({ delivered: 0, reason: "nothing-to-say" });
    expect(posts).toHaveLength(0);
    // No content ⇒ no wasted weather HTTP call.
    expect(weatherFetched).toBe(false);
  });

  it("re-briefs once the situation-window has elapsed", async () => {
    const { objectivesFile, sidecarFile } = fixtures();
    await addObjective(objectivesFile, objective());
    const posts: { url: string; body: string }[] = [];
    const messagingRegistry = new MessagingProviderRegistry([telegram(posts)]);
    const base = {
      destination: "555",
      imminent,
      messagingRegistry,
      objectivesFile,
      providerId: "telegram",
      sidecarFile,
      windowMs: 60_000
    };
    await runDueSituationalBriefing({ ...base, now: () => NOW });
    expect(posts).toHaveLength(1);
    // 61s later — window elapsed → a fresh briefing is allowed.
    const later = new Date(NOW.getTime() + 61_000);
    const again = await runDueSituationalBriefing({ ...base, now: () => later });
    expect(again).toEqual({ delivered: 1 });
    expect(posts).toHaveLength(2);
  });
});
