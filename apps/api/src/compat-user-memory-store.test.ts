import type { FastifyReply, FastifyRequest } from "fastify";
import { describe, expect, it } from "vitest";

import type { CompatibilityRouteOptions } from "./compat-routes.js";
import { canAccessUserMemory, toUserMemoryResponse, updateUserMemory } from "./compat-user-memory-store.js";

// Direct coverage for the user-memory access gate + store helpers (untested).
// canAccessUserMemory is the PRIVACY boundary behind Muse's "it can't tell
// anyone": with auth configured, a caller may read ONLY their own memory; an
// empty/anonymous user is always denied; the auth-disabled personal default
// allows the single real user. updateUserMemory routes facts vs preferences and
// rejects an empty key/value; toUserMemoryResponse normalizes the timestamp.

const request = (over: { userId?: string; body?: unknown; auth?: { userId: string } } = {}): FastifyRequest =>
  ({ body: over.body ?? {}, headers: {}, params: { userId: over.userId ?? "u1" }, ...(over.auth ? { auth: over.auth } : {}) }) as unknown as FastifyRequest;
const opts = (o: Partial<CompatibilityRouteOptions> = {}): CompatibilityRouteOptions => o as CompatibilityRouteOptions;
const reply = (): { r: FastifyReply; captured: { status: number | null; payload: unknown } } => {
  const captured = { payload: null as unknown, status: null as number | null };
  return { captured, r: { status: (c: number) => { captured.status = c; return { send: (p: unknown) => { captured.payload = p; } }; } } as unknown as FastifyReply };
};

describe("canAccessUserMemory — the privacy gate", () => {
  it("denies an empty or anonymous user id outright", async () => {
    expect(await canAccessUserMemory(request({ userId: "" }), opts(), "")).toBe(false);
    expect(await canAccessUserMemory(request(), opts(), "anonymous")).toBe(false);
  });

  it("allows any real user when auth is DISABLED (personal-use default)", async () => {
    expect(await canAccessUserMemory(request(), opts(), "u1")).toBe(true);
  });

  it("with auth ENABLED, allows only the caller's OWN memory and denies another user's", async () => {
    const authService = { authenticateBearer: async () => ({ userId: "u1" }) } as unknown as CompatibilityRouteOptions["authService"];
    expect(await canAccessUserMemory(request({ auth: { userId: "u1" } }), opts({ authService }), "u1")).toBe(true);
    expect(await canAccessUserMemory(request({ auth: { userId: "u1" } }), opts({ authService }), "u2")).toBe(false); // another user → denied
  });

  it("with auth ENABLED, denies when no identity resolves", async () => {
    const authService = { authenticateBearer: async () => undefined } as unknown as CompatibilityRouteOptions["authService"];
    expect(await canAccessUserMemory(request(), opts({ authService }), "u1")).toBe(false);
  });
});

describe("updateUserMemory", () => {
  it("routes facts to upsertFact and preferences to upsertPreference (trimmed key/value)", async () => {
    const calls: unknown[][] = [];
    const userMemoryStore = {
      upsertFact: async (u: string, k: string, v: string) => { calls.push(["fact", u, k, v]); },
      upsertPreference: async (u: string, k: string, v: string) => { calls.push(["pref", u, k, v]); }
    } as unknown as CompatibilityRouteOptions["userMemoryStore"];

    const out = await updateUserMemory(request({ body: { key: " spouse ", value: " Mina " }, userId: "u1" }), reply().r, "facts", opts({ userMemoryStore }));
    expect(out).toEqual({ updated: true });
    expect(calls[0]).toEqual(["fact", "u1", "spouse", "Mina"]);

    await updateUserMemory(request({ body: { key: "tone", value: "concise" }, userId: "u1" }), reply().r, "preferences", opts({ userMemoryStore }));
    expect(calls[1]).toEqual(["pref", "u1", "tone", "concise"]);
  });

  it("rejects an empty key or value with a 400", async () => {
    const { captured, r } = reply();
    await updateUserMemory(request({ body: { key: "", value: "x" } }), r, "facts", opts({}));
    expect(captured.status).toBe(400);
  });
});

describe("toUserMemoryResponse", () => {
  it("normalizes a Date updatedAt to ISO and copies recentTopics", () => {
    expect(toUserMemoryResponse({ facts: { a: "b" }, preferences: {}, recentTopics: ["x"], updatedAt: new Date(1_000) }))
      .toEqual({ facts: { a: "b" }, preferences: {}, recentTopics: ["x"], updatedAt: "1970-01-01T00:00:01.000Z" });
  });
});
