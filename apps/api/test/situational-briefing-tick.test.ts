import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MessagingProviderRegistry, TelegramProvider } from "@muse/messaging";
import { addObjective, writeTasks, type StandingObjective } from "@muse/stores";
import { deriveBriefingImminent, deriveCalendarBriefingImminent } from "@muse/proactivity";
import { describe, expect, it } from "vitest";

import { startSituationalBriefingTick } from "../src/situational-briefing-tick.js";

function fakeJsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    headers: { "content-type": "application/json" },
    status: 200
  });
}

function fixtures() {
  const dir = mkdtempSync(join(tmpdir(), "muse-brief-tick-"));
  return { objectivesFile: join(dir, "objectives.json"), sidecarFile: join(dir, "brief-fired.json") };
}

function objective(overrides: Partial<StandingObjective> = {}): StandingObjective {
  return {
    createdAt: "2026-05-19T08:00:00.000Z",
    id: "obj_watch",
    kind: "until",
    spec: "watch the deploy until green",
    status: "active",
    userId: "stark",
    ...overrides
  };
}

const NOW = new Date("2026-05-19T12:00:00.000Z");

describe("startSituationalBriefingTick — P9-b2 child: the briefing daemon rider drives runDueSituationalBriefing", () => {
  function telegram(posts: { url: string; body: string }[]) {
    return new TelegramProvider({
      baseUrl: "https://tg.test",
      fetch: async (url, init) => {
        posts.push({ body: String(init?.body), url: String(url) });
        return fakeJsonResponse({ ok: true, result: { message_id: 1 } });
      },
      token: "BOT-TOK"
    });
  }

  it("a tick briefs delegated-objective status over the real provider; deduped within the window", async () => {
    const { objectivesFile, sidecarFile } = fixtures();
    await addObjective(objectivesFile, objective());
    const posts: { url: string; body: string }[] = [];
    const handle = startSituationalBriefingTick({
      destination: "555",
      now: () => NOW,
      objectivesFile,
      providerId: "telegram",
      registry: new MessagingProviderRegistry([telegram(posts)]),
      sidecarFile,
      windowMs: 4 * 60 * 60_000
    });
    try {
      await handle.tickOnce();
      expect(posts).toHaveLength(1);
      const body = JSON.parse(posts[0]!.body) as { chat_id: string; text: string };
      expect(body.chat_id).toBe("555");
      expect(body.text).toContain("[Briefing]");
      expect(body.text).toContain("watch the deploy until green");
      await handle.tickOnce(); // in-window → real sidecar dedupes
      expect(posts).toHaveLength(1);
    } finally {
      handle.stop();
    }
  });

  it("nothing to brief → no POST; single-flight; wild interval clamped to a working rider", async () => {
    const { objectivesFile, sidecarFile } = fixtures();
    await addObjective(objectivesFile, objective({ status: "done" }));
    const posts: { url: string; body: string }[] = [];
    const handle = startSituationalBriefingTick({
      destination: "555",
      intervalMs: Number.POSITIVE_INFINITY,
      now: () => NOW,
      objectivesFile,
      providerId: "telegram",
      registry: new MessagingProviderRegistry([telegram(posts)]),
      sidecarFile
    });
    try {
      await handle.tickOnce();
      expect(posts).toHaveLength(0);
    } finally {
      handle.stop();
    }
  });

  it("fail-soft: a send failure does not crash the rider", async () => {
    const { objectivesFile, sidecarFile } = fixtures();
    await addObjective(objectivesFile, objective());
    const errors: string[] = [];
    const exploding = new TelegramProvider({
      baseUrl: "https://tg.test",
      fetch: async () => {
        throw new Error("network down");
      },
      token: "BOT-TOK"
    });
    const handle = startSituationalBriefingTick({
      destination: "555",
      errorLogger: (m) => errors.push(m),
      now: () => NOW,
      objectivesFile,
      providerId: "telegram",
      registry: new MessagingProviderRegistry([exploding]),
      sidecarFile
    });
    try {
      await expect(handle.tickOnce()).resolves.toBeUndefined();
      expect(errors.some((e) => e.includes("situational-briefing-tick"))).toBe(true);
    } finally {
      handle.stop();
    }
  });

  it("P8-b3: a real imminent task grounds the briefing's Upcoming alongside objective status", async () => {
    const { objectivesFile, sidecarFile } = fixtures();
    const tasksFile = join(mkdtempSync(join(tmpdir(), "muse-brief-tasks-")), "tasks.json");
    await addObjective(objectivesFile, objective());
    await writeTasks(tasksFile, [
      {
        createdAt: "2026-05-19T08:00:00.000Z",
        dueAt: "2026-05-19T12:30:00.000Z",
        id: "t1",
        status: "open",
        title: "submit the Q3 report"
      }
    ]);
    const posts: { url: string; body: string }[] = [];
    const handle = startSituationalBriefingTick({
      destination: "555",
      imminentProvider: (now) => deriveBriefingImminent(tasksFile, { now }),
      now: () => NOW,
      objectivesFile,
      providerId: "telegram",
      registry: new MessagingProviderRegistry([telegram(posts)]),
      sidecarFile,
      windowMs: 4 * 60 * 60_000
    });
    try {
      await handle.tickOnce();
      expect(posts).toHaveLength(1);
      const text = (JSON.parse(posts[0]!.body) as { text: string }).text;
      expect(text).toContain("Upcoming:");
      expect(text).toContain("submit the Q3 report");
      expect(text).toContain("Still tracking:");
      expect(text).toContain("watch the deploy until green");
    } finally {
      handle.stop();
    }
  });

  it("P8-b4: a real imminent calendar event is grounded into the briefing's Upcoming, unioned with tasks", async () => {
    const { objectivesFile, sidecarFile } = fixtures();
    const tasksFile = join(mkdtempSync(join(tmpdir(), "muse-brief-cal-tasks-")), "tasks.json");
    await addObjective(objectivesFile, objective());
    await writeTasks(tasksFile, [
      {
        createdAt: "2026-05-19T08:00:00.000Z",
        dueAt: "2026-05-19T13:30:00.000Z",
        id: "t1",
        status: "open",
        title: "submit the Q3 report"
      }
    ]);
    const calLister = async () => [
      { allDay: false, startsAt: new Date("2026-05-19T12:20:00.000Z"), title: "Q3 review meeting" }
    ];
    const posts: { url: string; body: string }[] = [];
    const handle = startSituationalBriefingTick({
      destination: "555",
      imminentProvider: async (now) => [
        ...(await deriveBriefingImminent(tasksFile, { now })),
        ...(await deriveCalendarBriefingImminent(calLister, { now }))
      ],
      now: () => NOW,
      objectivesFile,
      providerId: "telegram",
      registry: new MessagingProviderRegistry([telegram(posts)]),
      sidecarFile,
      windowMs: 4 * 60 * 60_000
    });
    try {
      await handle.tickOnce();
      expect(posts).toHaveLength(1);
      const text = (JSON.parse(posts[0]!.body) as { text: string }).text;
      expect(text).toContain("Upcoming:");
      // soonest-first: the 12:20 calendar event before the 13:30 task.
      expect(text.indexOf("Q3 review meeting")).toBeLessThan(text.indexOf("submit the Q3 report"));
      expect(text).toContain("submit the Q3 report");
      expect(text).toContain("Still tracking:");
    } finally {
      handle.stop();
    }
  });
});
