import Fastify from "fastify";
import { classifyDeliverySafety, createUnverifiedDeliverySafetyResult } from "@muse/runtime-state";
import { afterEach, describe, expect, it, vi } from "vitest";

import { registerDoctorRoutes } from "./doctor-routes.js";
import { buildServer } from "./server.js";

function canonicalResult() {
  return classifyDeliverySafety({
    baseProviderLocal: true,
    deliveryBrake: "released",
    environmentProbe: "ok",
    followups: { overdue: 0, scheduled: 0, status: "ok" },
    localOnlyEffective: true,
    localOnlyPersisted: true,
    pendingDrafts: { count: 1, status: "ok" },
    providerLock: { localOnly: true, mismatch: false, observation: "verified" },
    reminders: { overdue: 0, scheduled: 0, status: "ok" },
    selfLearnDisabled: true,
    selfLearningHold: "engaged"
  });
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("GET /api/doctor delivery safety", () => {
  it("attaches the exact supplied canonical result once without changing existing checks", async () => {
    vi.stubEnv("OLLAMA_BASE_URL", "http://127.0.0.1:1");
    const expected = canonicalResult();
    const deliverySafety = vi.fn(async () => expected);
    const server = Fastify();
    registerDoctorRoutes(server, { authService: undefined, deliverySafety });

    const response = await server.inject({ method: "GET", url: "/api/doctor" });
    const body = response.json();

    expect(response.statusCode).toBe(200);
    expect(body.deliverySafety).toEqual(expected);
    expect(body.checks).toBeInstanceOf(Array);
    expect(body).toEqual(expect.objectContaining({
      pid: expect.any(Number),
      startedAtIso: expect.any(String),
      version: expect.any(String)
    }));
    expect(deliverySafety).toHaveBeenCalledTimes(1);
  });

  it("preserves the same supplier reference through buildServer", async () => {
    vi.stubEnv("OLLAMA_BASE_URL", "http://127.0.0.1:1");
    const expected = canonicalResult();
    const deliverySafety = vi.fn(async () => expected);
    const server = buildServer({
      deliverySafety,
      env: { HOME: "/isolated-delivery-safety" },
      logger: false
    });

    const response = await server.inject({ method: "GET", url: "/api/doctor" });

    expect(response.statusCode).toBe(200);
    expect(response.json().deliverySafety).toEqual(expected);
    expect(deliverySafety).toHaveBeenCalledTimes(1);
    await server.close();
  });

  it.each([
    ["absent", undefined],
    ["throwing", vi.fn(async () => {
      throw new Error("PRIVATE /owner/path provider=secret payload=secret");
    })]
  ] as const)("fails closed for an %s supplier instead of returning 500", async (_name, deliverySafety) => {
    vi.stubEnv("OLLAMA_BASE_URL", "http://127.0.0.1:1");
    const server = Fastify();
    registerDoctorRoutes(server, { authService: undefined, deliverySafety });

    const response = await server.inject({ method: "GET", url: "/api/doctor" });

    expect(response.statusCode).toBe(200);
    expect(response.json().deliverySafety).toEqual(createUnverifiedDeliverySafetyResult());
    expect(response.body).not.toMatch(/PRIVATE|owner|path|provider=|payload|secret/iu);
  });

  it("does not resolve delivery safety before authentication succeeds", async () => {
    const deliverySafety = vi.fn(async () => canonicalResult());
    const server = Fastify();
    registerDoctorRoutes(server, { authService: {} as never, deliverySafety });

    const response = await server.inject({ method: "GET", url: "/api/doctor" });

    expect(response.statusCode).toBe(401);
    expect(deliverySafety).not.toHaveBeenCalled();
  });
});
