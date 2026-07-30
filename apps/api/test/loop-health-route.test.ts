import { describe, expect, it } from "vitest";
import {
  admitTriggerToJournal,
  createTriggerAdmissionJournal,
  createTriggerEnvelope
} from "@muse/shared";

import { buildServer } from "../src/server.js";
import { createAuthService } from "./helpers/test-auth.js";

describe("GET /api/loop-health", () => {
  it("reports missing evidence as unknown instead of fabricating green health", async () => {
    const server = buildServer({ logger: false });

    const response = await server.inject({ method: "GET", url: "/api/loop-health" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      adaptation: { level: "unknown", reasons: ["adaptation-evidence-missing"] },
      agent: { level: "unknown", reasons: ["agent-evidence-missing"] },
      event: { level: "unknown", reasons: ["event-evidence-missing"] },
      level: "unknown"
    });
    await server.close();
  });

  it("combines current agent, event, and adaptation evidence into healthy supervision", async () => {
    const endedAt = new Date(Date.now() - 1_000).toISOString();
    const now = new Date();
    const journal = admitTriggerToJournal(
      createTriggerAdmissionJournal({ maxPending: 2 }),
      {
        envelope: createTriggerEnvelope({
          generation: "route-event-g1",
          occurredAt: now,
          receivedAt: now,
          source: "cron",
          sourceId: "daily-brief"
        }),
        now
      }
    ).journal;
    const server = buildServer({
      adaptationLoopHealthSnapshot: () => Object.freeze({
        evidenceId: "learning_promotion_route",
        evidenceVerified: true,
        status: "promoted"
      }),
      agentLoopHealthSnapshot: () => Object.freeze({
        endedAt,
        terminalReason: "goal-verified",
        terminalStatus: "completed",
        verificationEvidenceId: "eval:route",
        verificationStatus: "passed"
      }),
      eventLoopHealthSnapshot: async () => Object.freeze({
        journal,
        workStates: Object.freeze([])
      }),
      logger: false
    });

    const response = await server.inject({ method: "GET", url: "/api/loop-health" });
    const body = response.json();

    expect(response.statusCode).toBe(200);
    expect(body.adaptation).toEqual({ level: "healthy", reasons: [] });
    expect(body.agent).toEqual({ level: "healthy", reasons: [] });
    expect(body.event).toMatchObject({
      counts: { queued: 1 },
      level: "healthy",
      reasons: []
    });
    expect(body.level).toBe("healthy");
    expect(body.reasons).toEqual([]);
    expect(body.generatedAt).not.toBe(endedAt);
    await server.close();
  });

  it("fails event observation closed to unknown when its snapshot throws", async () => {
    const server = buildServer({
      eventLoopHealthSnapshot: async () => {
        throw new TypeError("invalid trigger admission journal");
      },
      logger: false
    });

    const response = await server.inject({ method: "GET", url: "/api/loop-health" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      event: { level: "unknown", reasons: ["event-evidence-missing"] },
      level: "unknown"
    });
    await server.close();
  });

  it("is not in the public-route allowlist when authentication is required", async () => {
    const authService = createAuthService();
    const account = authService.register({
      email: "loop_health_owner",
      name: "Loop Health Owner",
      password: "password-1"
    });
    const server = buildServer({
      authService,
      logger: false,
      requireAuth: true
    });

    const denied = await server.inject({ method: "GET", url: "/api/loop-health" });
    const allowed = await server.inject({
      headers: { authorization: `Bearer ${account.token}` },
      method: "GET",
      url: "/api/loop-health"
    });

    expect(denied.statusCode).toBe(401);
    expect(allowed.statusCode).toBe(200);
    await server.close();
  });
});
