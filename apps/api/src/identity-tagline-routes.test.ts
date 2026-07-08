import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { contentFreePool } from "./identity-tagline.js";
import { registerIdentityTaglineRoutes, type IdentityTaglineRoutesOptions } from "./identity-tagline-routes.js";

import type { UserMemory, UserMemoryStore } from "@muse/memory";

let dir: string;
let stateFile: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "api-tagline-"));
  stateFile = join(dir, "state.json");
});

afterEach(async () => {
  await rm(dir, { force: true, recursive: true });
});

function storeReturning(memory: UserMemory | undefined): UserMemoryStore {
  return { findByUserId: async () => memory } as unknown as UserMemoryStore;
}

function makeServer(options: Partial<IdentityTaglineRoutesOptions>) {
  const server = Fastify();
  registerIdentityTaglineRoutes(server, { authService: undefined, stateFile, ...options });
  return server;
}

async function fetchTagline(server: ReturnType<typeof makeServer>, lang = "ko") {
  const res = await server.inject({ method: "GET", url: `/api/identity-tagline?lang=${lang}` });
  return { body: JSON.parse(res.body) as { tagline: string; grounded: boolean }, status: res.statusCode };
}

describe("GET /api/identity-tagline", () => {
  it("returns a GROUNDED subtitle echoing a stored fact", async () => {
    const memory = { facts: { drink: "커피" }, preferences: {}, recentTopics: [], updatedAt: new Date(), userId: "me" };
    const server = makeServer({ userMemoryStore: storeReturning(memory as unknown as UserMemory) });
    const { status, body } = await fetchTagline(server);
    expect(status).toBe(200);
    expect(body.grounded).toBe(true);
    expect(body.tagline).toContain("커피");
  });

  it("falls back to a content-free line for an EMPTY profile (never invents a trait)", async () => {
    const server = makeServer({ userMemoryStore: storeReturning(undefined) });
    const { status, body } = await fetchTagline(server);
    expect(status).toBe(200);
    expect(body.grounded).toBe(false);
    expect(new Set(contentFreePool("ko")).has(body.tagline)).toBe(true);
  });

  it("is fail-soft: a throwing store still returns 200 with a content-free line, never a 500", async () => {
    const store = { findByUserId: async () => { throw new Error("store down"); } } as unknown as UserMemoryStore;
    const server = makeServer({ userMemoryStore: store });
    const { status, body } = await fetchTagline(server);
    expect(status).toBe(200);
    expect(new Set(contentFreePool("ko")).has(body.tagline)).toBe(true);
  });

  it("uses the injected model for a grounded re-phrase, gated by the fabrication check", async () => {
    const memory = { facts: { drink: "커피" }, preferences: {}, recentTopics: [], updatedAt: new Date(), userId: "me" };
    const model = vi.fn(async () => "커피와 함께");
    const server = makeServer({ userMemoryStore: storeReturning(memory as unknown as UserMemory), model });
    const { body } = await fetchTagline(server);
    expect(model).toHaveBeenCalledOnce();
    expect(body.tagline).toBe("커피와 함께");
    expect(body.grounded).toBe(true);
  });

  it("varies across successive opens (no immediate repeat) via persisted rotation state", async () => {
    const server = makeServer({ userMemoryStore: storeReturning(undefined) });
    const first = await fetchTagline(server);
    const second = await fetchTagline(server);
    expect(second.body.tagline).not.toBe(first.body.tagline);
  });
});
