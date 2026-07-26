import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createApiServerOptions } from "@muse/autoconfigure";
import {
  DELIVERY_SAFETY_REASON,
  createUnverifiedDeliverySafetyResult
} from "@muse/runtime-state";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildServer } from "./server.js";
import type { ServerOptions } from "./server-options.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("delivery-safety production transitive fallback", () => {
  it("keeps API assembly, buildServer, Doctor, and personal status on one canonical fallback", async () => {
    vi.stubEnv("OLLAMA_BASE_URL", "http://127.0.0.1:1");
    const root = mkdtempSync(join(tmpdir(), "muse-delivery-transitive-"));
    const rawSecret = "PRIVATE /owner/secret-path provider=secret payload=secret";
    const dependency = vi.fn(async () => {
      throw new Error(rawSecret);
    });
    const env = {
      HOME: root,
      MUSE_SCHEDULER_PERSIST: "false",
      MUSE_TASK_MEMORY_PERSIST: "false",
      MUSE_USER_ID: "owner"
    };
    const assembled = createApiServerOptions({
      deliverySafetyDependencies: { residentInspection: dependency },
      env
    });
    const supplier = vi.fn(assembled.deliverySafety);
    const authService = {
      authenticateBearer: async (token: string | undefined) =>
        token === "owner-token" ? { expiresAt: new Date("2026-07-27T12:00:00.000Z"), userId: "owner" } : undefined
    } as unknown as NonNullable<ServerOptions["authService"]>;
    const server = buildServer({
      ...assembled,
      authService,
      deliverySafety: supplier,
      env,
      logger: false,
      requireAuth: true
    });
    const headers = { authorization: "Bearer owner-token" };
    const expected = createUnverifiedDeliverySafetyResult();

    const doctor = await server.inject({ headers, method: "GET", url: "/api/doctor" });
    const personal = await server.inject({ headers, method: "GET", url: "/api/personal-status" });

    expect(doctor.statusCode).toBe(200);
    expect(personal.statusCode).toBe(200);
    expect(doctor.json().deliverySafety).toEqual(expected);
    expect(personal.json().deliverySafety).toEqual(expected);
    expect(expected.reasonCodes).toContain(DELIVERY_SAFETY_REASON.deliveryBrakeUnverified);
    expect(expected.reasonCodes).not.toContain(DELIVERY_SAFETY_REASON.deliveryBrakeEngaged);
    expect(supplier).toHaveBeenCalledTimes(2);
    expect(dependency).toHaveBeenCalledTimes(2);
    expect(`${doctor.body}\n${personal.body}`).not.toContain(rawSecret);
    expect(`${doctor.body}\n${personal.body}`).not.toMatch(/\/owner\/secret-path|provider=secret|payload=secret/iu);

    const unauthenticated = await server.inject({ method: "GET", url: "/api/doctor" });
    const invalidQuery = await server.inject({
      headers,
      method: "GET",
      url: "/api/personal-status?userId=other"
    });

    expect(unauthenticated.statusCode).toBe(401);
    expect(invalidQuery.statusCode).toBe(400);
    expect(supplier).toHaveBeenCalledTimes(2);
    expect(dependency).toHaveBeenCalledTimes(2);
    await server.close();
  });
});
