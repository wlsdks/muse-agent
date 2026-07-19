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

describe("runDueSituationalBriefing — contract-faithful real-channel delivery, deduped", () => {
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

  it("grounds the briefing with unread inbox items from the email provider", async () => {
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

  // S6: the reconfirm-question addendum (the day-rhythm briefing's PUSH
  // counterpart of the Home "Muse가 확인하고 싶은 것" pull card). The caller
  // (`makeBriefingTick`) supplies `reconfirmCard` ONLY for a day-rhythm-driven
  // tick — these tests exercise the addendum's own contract in isolation.
  describe("reconfirmCard addendum (S6)", () => {
    it("appends the question + reply instruction when eligible, and records delivery ONLY after the send", async () => {
      const { objectivesFile, sidecarFile } = fixtures();
      await addObjective(objectivesFile, objective());
      const posts: { url: string; body: string }[] = [];
      const delivered: { slotId: string; at: Date }[] = [];

      const summary = await runDueSituationalBriefing({
        destination: "555",
        imminent,
        messagingRegistry: new MessagingProviderRegistry([telegram(posts)]),
        now: () => NOW,
        objectivesFile,
        onReconfirmDelivered: async (slotId, at) => {
          delivered.push({ at, slotId });
        },
        providerId: "telegram",
        reconfirmCard: () => ({ question: "진안의 말투 — 이렇게 추측하고 있어요: '간결한 답변'. 아직 맞나요?", slotId: "pref-tone" }),
        sidecarFile
      });

      expect(summary).toEqual({ delivered: 1 });
      const body = JSON.parse(posts[0]!.body) as { text: string };
      expect(body.text).toContain("[Briefing]");
      expect(body.text).toContain("in 15 min: Q3 review"); // the normal briefing content is intact
      expect(body.text).toContain("[Muse가 확인하고 싶은 것]");
      expect(body.text).toContain("진안의 말투");
      expect(body.text).toContain("아니야");
      expect(delivered).toEqual([{ at: NOW, slotId: "pref-tone" }]);
    });

    it("byte-identical briefing when reconfirmCard is omitted entirely (legacy env-flag path parity)", async () => {
      const fixturesA = fixtures();
      const fixturesB = fixtures();
      await addObjective(fixturesA.objectivesFile, objective());
      await addObjective(fixturesB.objectivesFile, objective());
      const withoutAddendum: { url: string; body: string }[] = [];
      const withAddendum: { url: string; body: string }[] = [];

      await runDueSituationalBriefing({
        destination: "555", imminent, messagingRegistry: new MessagingProviderRegistry([telegram(withoutAddendum)]),
        now: () => NOW, objectivesFile: fixturesA.objectivesFile, providerId: "telegram", sidecarFile: fixturesA.sidecarFile
      });
      // Same inputs, but with a reconfirmCard resolver present — since it
      // returns undefined (no card), the sent text must be byte-identical.
      await runDueSituationalBriefing({
        destination: "555", imminent, messagingRegistry: new MessagingProviderRegistry([telegram(withAddendum)]),
        now: () => NOW, objectivesFile: fixturesB.objectivesFile, providerId: "telegram",
        reconfirmCard: () => undefined,
        sidecarFile: fixturesB.sidecarFile
      });

      const bodyA = JSON.parse(withoutAddendum[0]!.body) as { text: string };
      const bodyB = JSON.parse(withAddendum[0]!.body) as { text: string };
      expect(bodyB.text).toBe(bodyA.text);
      expect(bodyA.text).not.toContain("Muse가 확인하고 싶은 것");
    });

    it("byte-identical briefing when the resolver returns undefined (no reconfirmable slot / already answered today)", async () => {
      const { objectivesFile, sidecarFile } = fixtures();
      await addObjective(objectivesFile, objective());
      const posts: { url: string; body: string }[] = [];
      let resolverCalled = false;

      const summary = await runDueSituationalBriefing({
        destination: "555",
        imminent,
        messagingRegistry: new MessagingProviderRegistry([telegram(posts)]),
        now: () => NOW,
        objectivesFile,
        providerId: "telegram",
        reconfirmCard: () => {
          resolverCalled = true;
          return undefined;
        },
        sidecarFile
      });

      expect(summary).toEqual({ delivered: 1 });
      expect(resolverCalled).toBe(true);
      const body = JSON.parse(posts[0]!.body) as { text: string };
      expect(body.text).not.toContain("Muse가 확인하고 싶은 것");
      expect(body.text).toContain("[Briefing]");
    });

    it("does not consult the resolver (or send an addendum) when there is nothing to brief", async () => {
      const { objectivesFile, sidecarFile } = fixtures();
      await addObjective(objectivesFile, objective({ status: "done" }));
      const posts: { url: string; body: string }[] = [];
      let resolverCalled = false;

      const summary = await runDueSituationalBriefing({
        destination: "555",
        imminent: [],
        messagingRegistry: new MessagingProviderRegistry([telegram(posts)]),
        now: () => NOW,
        objectivesFile,
        providerId: "telegram",
        reconfirmCard: () => {
          resolverCalled = true;
          return { question: "should never appear", slotId: "x" };
        },
        sidecarFile
      });

      expect(summary).toEqual({ delivered: 0, reason: "nothing-to-say" });
      expect(resolverCalled).toBe(false);
      expect(posts).toHaveLength(0);
    });

    it("a resolver throw is treated as no card — the briefing still sends, unaffected", async () => {
      const { objectivesFile, sidecarFile } = fixtures();
      await addObjective(objectivesFile, objective());
      const posts: { url: string; body: string }[] = [];

      const summary = await runDueSituationalBriefing({
        destination: "555",
        imminent,
        messagingRegistry: new MessagingProviderRegistry([telegram(posts)]),
        now: () => NOW,
        objectivesFile,
        providerId: "telegram",
        reconfirmCard: () => {
          throw new Error("store unavailable");
        },
        sidecarFile
      });

      expect(summary).toEqual({ delivered: 1 });
      const body = JSON.parse(posts[0]!.body) as { text: string };
      expect(body.text).not.toContain("Muse가 확인하고 싶은 것");
    });

    it("onReconfirmDelivered is NOT called when the send itself fails", async () => {
      const { objectivesFile, sidecarFile } = fixtures();
      await addObjective(objectivesFile, objective());
      const failingProvider = new TelegramProvider({
        baseUrl: "https://tg.test",
        fetch: async () => {
          throw new Error("network down");
        },
        token: "BOT-TOK"
      });
      const delivered: string[] = [];

      await expect(runDueSituationalBriefing({
        destination: "555",
        imminent,
        messagingRegistry: new MessagingProviderRegistry([failingProvider]),
        now: () => NOW,
        objectivesFile,
        onReconfirmDelivered: async (slotId) => {
          delivered.push(slotId);
        },
        providerId: "telegram",
        reconfirmCard: () => ({ question: "q", slotId: "pref-tone" }),
        sidecarFile
      })).rejects.toThrow();

      expect(delivered).toEqual([]);
    });

    it("a delivery-record write failure never undoes the already-sent message", async () => {
      const { objectivesFile, sidecarFile } = fixtures();
      await addObjective(objectivesFile, objective());
      const posts: { url: string; body: string }[] = [];

      const summary = await runDueSituationalBriefing({
        destination: "555",
        imminent,
        messagingRegistry: new MessagingProviderRegistry([telegram(posts)]),
        now: () => NOW,
        objectivesFile,
        onReconfirmDelivered: async () => {
          throw new Error("sidecar write failed");
        },
        providerId: "telegram",
        reconfirmCard: () => ({ question: "q", slotId: "pref-tone" }),
        sidecarFile
      });

      expect(summary).toEqual({ delivered: 1 });
      expect(posts).toHaveLength(1);
    });
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
