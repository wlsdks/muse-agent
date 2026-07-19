import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readReconfirmCardAnsweredDate } from "@muse/stores";
import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { registerUserModelReconfirmRoutes, type UserModelReconfirmRoutesOptions } from "./user-model-reconfirm-routes.js";

import type { UserModel, UserModelSlot } from "@muse/memory";

// Local-time constructor (not a UTC ISO string) so the sidecar's LOCAL date
// key is deterministic regardless of the test machine's timezone offset.
const NOW = new Date(2026, 6, 16, 12, 0, 0);
const daysAgo = (d: number): Date => new Date(NOW.getTime() - d * 24 * 60 * 60_000);

let dir: string;
let answeredFile: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "api-reconfirm-card-"));
  answeredFile = join(dir, "reconfirm-card-answered.json");
});

afterEach(async () => {
  await rm(dir, { force: true, recursive: true });
});

function fakeStore(slots: readonly UserModelSlot[]) {
  const calls = { removes: [] as string[], upserts: [] as UserModelSlot[] };
  const model: UserModel = {
    goals: slots.filter((s): s is Extract<UserModelSlot, { kind: "goal" }> => s.kind === "goal"),
    preferences: slots.filter((s): s is Extract<UserModelSlot, { kind: "preference" }> => s.kind === "preference"),
    schedule: slots.filter((s): s is Extract<UserModelSlot, { kind: "schedule" }> => s.kind === "schedule"),
    vetoes: slots.filter((s): s is Extract<UserModelSlot, { kind: "veto" }> => s.kind === "veto")
  };
  return {
    calls,
    store: {
      findByUserId: async () => ({ userModel: model }),
      removeUserModelSlot: async (_userId: string, id: string) => {
        calls.removes.push(id);
        return { facts: {}, preferences: {}, recentTopics: [], updatedAt: new Date(), userId: "u" };
      },
      upsertUserModelSlot: async (_userId: string, slot: UserModelSlot) => {
        calls.upserts.push(slot);
        return { facts: {}, preferences: {}, recentTopics: [], updatedAt: new Date(), userId: "u" };
      }
    }
  };
}

function makeServer(options: Partial<UserModelReconfirmRoutesOptions> = {}) {
  const server = Fastify();
  registerUserModelReconfirmRoutes(server, {
    authService: undefined,
    defaultUserId: "stark",
    now: () => NOW,
    reconfirmCardAnsweredFile: answeredFile,
    ...options
  });
  return server;
}

describe("GET /api/user-model/reconfirm-card", () => {
  it("returns { card: null } when there is no user memory store configured", async () => {
    const server = makeServer({ userMemoryStore: undefined });
    const res = await server.inject({ method: "GET", url: "/api/user-model/reconfirm-card" });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ card: null });
  });

  it("returns { card: null } when no slot has faded below the reconfirm threshold", async () => {
    const { store } = fakeStore([
      { id: "asserted", kind: "preference", updatedAt: daysAgo(90), value: "concise" }
    ]);
    const server = makeServer({ userMemoryStore: store });
    const res = await server.inject({ method: "GET", url: "/api/user-model/reconfirm-card" });
    expect(JSON.parse(res.body)).toEqual({ card: null });
  });

  it("returns the SINGLE most-decayed slot as a card, with question/category/evidence", async () => {
    const { store } = fakeStore([
      { confidence: 0.8, id: "less-stale", kind: "preference", updatedAt: daysAgo(31), value: "dark mode" },
      { confidence: 0.8, id: "most-stale", kind: "preference", category: "말투", updatedAt: daysAgo(90), value: "간결한 답변" }
    ]);
    const server = makeServer({ userMemoryStore: store });
    const res = await server.inject({ method: "GET", url: "/api/user-model/reconfirm-card" });
    const body = JSON.parse(res.body) as { card: { slotId: string; question: string; category: string; evidence?: string } | null };
    expect(body.card?.slotId).toBe("most-stale");
    expect(body.card?.category).toBe("preference");
    expect(body.card?.question).toContain("말투");
    expect(body.card?.question).toContain("간결한 답변");
    expect(body.card?.evidence).toBeDefined();
  });

  it("returns { card: null } once a card was already answered TODAY (per-day gate)", async () => {
    const { store } = fakeStore([
      { confidence: 0.8, id: "stale", kind: "preference", updatedAt: daysAgo(90), value: "dark mode" }
    ]);
    const server = makeServer({ userMemoryStore: store });
    await server.inject({
      method: "POST",
      payload: { verdict: "confirm" },
      url: "/api/user-model/reconfirm-card/stale"
    });
    const res = await server.inject({ method: "GET", url: "/api/user-model/reconfirm-card" });
    expect(JSON.parse(res.body)).toEqual({ card: null });
  });

  it("merely VIEWING the card never consumes the day — repeated GETs keep returning it", async () => {
    const { store } = fakeStore([
      { confidence: 0.8, id: "stale", kind: "preference", updatedAt: daysAgo(90), value: "dark mode" }
    ]);
    const server = makeServer({ userMemoryStore: store });
    const first = await server.inject({ method: "GET", url: "/api/user-model/reconfirm-card" });
    const second = await server.inject({ method: "GET", url: "/api/user-model/reconfirm-card" });
    expect(JSON.parse(first.body).card?.slotId).toBe("stale");
    expect(JSON.parse(second.body).card?.slotId).toBe("stale");
  });
});

describe("POST /api/user-model/reconfirm-card/:slotId", () => {
  it("400s on an invalid verdict — no store mutation, no sidecar write", async () => {
    const { store, calls } = fakeStore([
      { confidence: 0.8, id: "stale", kind: "preference", updatedAt: daysAgo(90), value: "dark mode" }
    ]);
    const server = makeServer({ userMemoryStore: store });
    const res = await server.inject({
      method: "POST",
      payload: { verdict: "maybe" },
      url: "/api/user-model/reconfirm-card/stale"
    });
    expect(res.statusCode).toBe(400);
    expect(calls.upserts).toHaveLength(0);
    expect(calls.removes).toHaveLength(0);
    expect(await readReconfirmCardAnsweredDate(answeredFile)).toBeUndefined();
  });

  it("404s on an unknown slotId — NO sidecar write (a failed answer must not consume the day)", async () => {
    const { store, calls } = fakeStore([
      { confidence: 0.8, id: "stale", kind: "preference", updatedAt: daysAgo(90), value: "dark mode" }
    ]);
    const server = makeServer({ userMemoryStore: store });
    const res = await server.inject({
      method: "POST",
      payload: { verdict: "confirm" },
      url: "/api/user-model/reconfirm-card/ghost"
    });
    expect(res.statusCode).toBe(404);
    expect(calls.upserts).toHaveLength(0);
    expect(calls.removes).toHaveLength(0);
    expect(await readReconfirmCardAnsweredDate(answeredFile)).toBeUndefined();

    // The day is still open — the GET must still surface the real card.
    const getRes = await server.inject({ method: "GET", url: "/api/user-model/reconfirm-card" });
    expect(JSON.parse(getRes.body).card?.slotId).toBe("stale");
  });

  it("confirm applies the SAME mutation runUserModelReview uses (confidence cleared, updatedAt bumped) and marks the sidecar", async () => {
    const { store, calls } = fakeStore([
      { confidence: 0.8, id: "stale", kind: "preference", category: "style", updatedAt: daysAgo(90), value: "dark mode" }
    ]);
    const server = makeServer({ userMemoryStore: store });
    const res = await server.inject({
      method: "POST",
      payload: { verdict: "confirm" },
      url: "/api/user-model/reconfirm-card/stale"
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ recorded: true, verdict: "confirm" });
    expect(calls.upserts).toHaveLength(1);
    expect(calls.upserts[0]).toMatchObject({ category: "style", id: "stale", kind: "preference", updatedAt: NOW, value: "dark mode" });
    expect("confidence" in calls.upserts[0]!).toBe(false);
    expect(calls.removes).toHaveLength(0);
    expect(await readReconfirmCardAnsweredDate(answeredFile)).toBe("2026-07-16");
  });

  it("reject removes the slot (same mutation as --reject) and marks the sidecar", async () => {
    const { store, calls } = fakeStore([
      { confidence: 0.2, id: "stale", kind: "preference", updatedAt: daysAgo(90), value: "x" }
    ]);
    const server = makeServer({ userMemoryStore: store });
    const res = await server.inject({
      method: "POST",
      payload: { verdict: "reject" },
      url: "/api/user-model/reconfirm-card/stale"
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ recorded: true, verdict: "reject" });
    expect(calls.removes).toEqual(["stale"]);
    expect(calls.upserts).toHaveLength(0);
    expect(await readReconfirmCardAnsweredDate(answeredFile)).toBe("2026-07-16");
  });
});

describe("serialized-store shape (live-caught regression)", () => {
  it("a snapshot whose slot updatedAt is an ISO STRING (file-store round-trip) still yields a card, not a 500", async () => {
    const stringDateStore = {
      findByUserId: async () => ({
        userModel: {
          goals: [],
          preferences: [
            { confidence: 0.12, id: "pref_am", kind: "preference", updatedAt: "2026-06-01T09:00:00.000Z", value: "아침 집중" }
          ],
          schedule: [],
          vetoes: []
        }
      })
    };
    const server = makeServer({ userMemoryStore: stringDateStore as never });
    const res = await server.inject({ method: "GET", url: "/api/user-model/reconfirm-card" });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { card: { slotId: string } | null };
    expect(body.card?.slotId).toBe("pref_am");
    await server.close();
  });
});
