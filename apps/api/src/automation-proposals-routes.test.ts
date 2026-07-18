import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { TimeOfDayMatch } from "@muse/memory";
import { readRejectedProposals } from "@muse/stores";
import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { registerAutomationProposalsRoutes, type AutomationProposalsResponse } from "./automation-proposals-routes.js";

let root: string;
let rejectedProposalsFile: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "muse-automation-proposals-api-"));
  rejectedProposalsFile = join(root, "automation-rejected-proposals.json");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const NOW = new Date("2026-07-20T09:30:00.000Z");

function tod(overrides: Partial<TimeOfDayMatch> = {}): TimeOfDayMatch {
  return {
    bucket: {
      distinctDays: 3,
      hourBand: "9-12",
      matches: 3,
      pathFamily: "journal",
      weekday: "Mon"
    },
    category: "time-of-day-action",
    confidence: 0.9,
    id: "tod-1",
    relatedPaths: ["/notes/journal/a.md"],
    suggestion: "You usually edit journal notes around 9-12 on Mons.",
    ...overrides
  };
}

describe("GET /api/automation/proposals", () => {
  it("401s when auth is required and no bearer token is supplied", async () => {
    const server = Fastify();
    registerAutomationProposalsRoutes(server, {
      authService: {} as never,
      detectPatterns: async () => [],
      now: () => NOW,
      rejectedProposalsFile
    });
    const res = await server.inject({ method: "GET", url: "/api/automation/proposals" });
    expect(res.statusCode).toBe(401);
  });

  it("returns an empty proposals array when the injected detector finds nothing", async () => {
    const server = Fastify();
    registerAutomationProposalsRoutes(server, {
      authService: undefined,
      detectPatterns: async () => [],
      now: () => NOW,
      rejectedProposalsFile
    });
    const res = await server.inject({ method: "GET", url: "/api/automation/proposals" });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as AutomationProposalsResponse;
    expect(body).toEqual({ proposals: [] });
  });

  it("bridges a fake provider's matches into proposals via the SAME evidence gate", async () => {
    const server = Fastify();
    registerAutomationProposalsRoutes(server, {
      authService: undefined,
      detectPatterns: async () => [tod()],
      now: () => NOW,
      rejectedProposalsFile
    });
    const res = await server.inject({ method: "GET", url: "/api/automation/proposals" });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as AutomationProposalsResponse;
    expect(body.proposals).toHaveLength(1);
    expect(body.proposals[0]).toMatchObject({ category: "time-of-day-action", cronExpression: "0 9 * * 1", id: "tod-1" });
  });

  it("a weak match (below the evidence gate) never appears — the bridge's fail-close gate, not this route", async () => {
    const server = Fastify();
    registerAutomationProposalsRoutes(server, {
      authService: undefined,
      detectPatterns: async () => [tod({ confidence: 0.2 })],
      now: () => NOW,
      rejectedProposalsFile
    });
    const res = await server.inject({ method: "GET", url: "/api/automation/proposals" });
    const body = JSON.parse(res.body) as AutomationProposalsResponse;
    expect(body.proposals).toEqual([]);
  });

  it("filters out a previously-rejected id from the GET response", async () => {
    const server = Fastify();
    registerAutomationProposalsRoutes(server, {
      authService: undefined,
      detectPatterns: async () => [tod()],
      now: () => NOW,
      rejectedProposalsFile
    });
    const before = await server.inject({ method: "GET", url: "/api/automation/proposals" });
    expect((JSON.parse(before.body) as AutomationProposalsResponse).proposals).toHaveLength(1);

    await server.inject({ method: "POST", url: "/api/automation/proposals/tod-1/reject" });

    const after = await server.inject({ method: "GET", url: "/api/automation/proposals" });
    expect((JSON.parse(after.body) as AutomationProposalsResponse).proposals).toEqual([]);
  });

  it("a detector that throws degrades to an empty proposals list rather than 500ing", async () => {
    const server = Fastify();
    registerAutomationProposalsRoutes(server, {
      authService: undefined,
      detectPatterns: async () => {
        throw new Error("boom");
      },
      now: () => NOW,
      rejectedProposalsFile
    });
    const res = await server.inject({ method: "GET", url: "/api/automation/proposals" });
    expect(res.statusCode).toBe(200);
    expect((JSON.parse(res.body) as AutomationProposalsResponse).proposals).toEqual([]);
  });
});

describe("POST /api/automation/proposals/:id/reject", () => {
  it("401s when auth is required and no bearer token is supplied", async () => {
    const server = Fastify();
    registerAutomationProposalsRoutes(server, {
      authService: {} as never,
      detectPatterns: async () => [],
      now: () => NOW,
      rejectedProposalsFile
    });
    const res = await server.inject({ method: "POST", url: "/api/automation/proposals/tod-1/reject" });
    expect(res.statusCode).toBe(401);
  });

  it("400s on an empty/whitespace id and persists NOTHING", async () => {
    const server = Fastify();
    registerAutomationProposalsRoutes(server, {
      authService: undefined,
      detectPatterns: async () => [],
      now: () => NOW,
      rejectedProposalsFile
    });
    const res = await server.inject({ method: "POST", url: "/api/automation/proposals/%20/reject" });
    expect(res.statusCode).toBe(400);
    expect(await readRejectedProposals(rejectedProposalsFile)).toEqual([]);
  });

  it("persists the exact id + a rejectedAt timestamp and returns { ok: true }", async () => {
    const server = Fastify();
    registerAutomationProposalsRoutes(server, {
      authService: undefined,
      detectPatterns: async () => [],
      now: () => NOW,
      rejectedProposalsFile
    });
    const res = await server.inject({ method: "POST", url: "/api/automation/proposals/tod-1/reject" });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true });
    const stored = await readRejectedProposals(rejectedProposalsFile);
    expect(stored).toEqual([{ id: "tod-1", rejectedAt: NOW.toISOString() }]);
  });

  it("rejecting the same id twice does not duplicate the entry", async () => {
    const server = Fastify();
    registerAutomationProposalsRoutes(server, {
      authService: undefined,
      detectPatterns: async () => [],
      now: () => NOW,
      rejectedProposalsFile
    });
    await server.inject({ method: "POST", url: "/api/automation/proposals/tod-1/reject" });
    await server.inject({ method: "POST", url: "/api/automation/proposals/tod-1/reject" });
    const stored = await readRejectedProposals(rejectedProposalsFile);
    expect(stored).toHaveLength(1);
  });
});
