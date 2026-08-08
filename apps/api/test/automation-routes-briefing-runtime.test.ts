import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MessagingProviderRegistry, type MessagingProvider } from "@muse/messaging";
import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { registerAutomationRoutes, type AutomationUpcomingResponse } from "../src/automation-routes.js";
import { createBriefingRuntimeStatusStore } from "../src/briefing-runtime-status.js";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "muse-automation-briefing-runtime-"));
});

afterEach(async () => {
  await rm(root, { force: true, recursive: true });
});

function registry(): MessagingProviderRegistry {
  const provider: MessagingProvider = {
    describe: () => ({ description: "test provider", displayName: "Telegram", id: "telegram" }),
    id: "telegram",
    send: async (message) => ({ destination: message.destination, messageId: "unused", providerId: "telegram" })
  };
  return new MessagingProviderRegistry([provider]);
}

function env() {
  return {
    HOME: root,
    MUSE_FOLLOWUPS_FILE: join(root, "followups.json"),
    MUSE_INTERRUPTION_LEDGER_FILE: join(root, "interruption-ledger.json"),
    MUSE_PENDING_APPROVALS_FILE: join(root, "pending-approvals.json"),
    MUSE_PROACTIVE_DESTINATION: "gateway-owner",
    MUSE_PROACTIVE_PROVIDER: "telegram",
    MUSE_REMINDERS_FILE: join(root, "reminders.json")
  };
}

describe("GET /api/automation/upcoming — briefing runtime projection", () => {
  it("keeps the no-observation read path read-only and preserves the Gateway route", async () => {
    const runtimeStatus = createBriefingRuntimeStatusStore();
    const getRuntimeStatus = vi.fn(runtimeStatus.get);
    const server = Fastify();
    registerAutomationRoutes(server, {
      authService: undefined,
      briefingRuntimeStatus: getRuntimeStatus,
      env: env(),
      messagingRegistry: registry()
    });

    try {
      const response = await server.inject({ method: "GET", url: "/api/automation/upcoming" });
      const body = response.json() as AutomationUpcomingResponse;

      expect(response.statusCode).toBe(200);
      expect(body.briefingRuntime).toBeNull();
      expect(body.gateway).toEqual({
        destination: "gateway-owner",
        localOnly: false,
        providerId: "telegram",
        reason: null,
        source: "explicit-config",
        status: "resolved"
      });
      expect(runtimeStatus.get()).toBeNull();
      expect(getRuntimeStatus).toHaveBeenCalledOnce();
    } finally {
      await server.close();
    }
  });

  it("projects the observed callback status without exposing raw route error details", async () => {
    const runtimeStatus = createBriefingRuntimeStatusStore();
    runtimeStatus.record({
      decision: "route-unavailable",
      errorCount: 10_000,
      imminentCount: -2,
      lastRoute: {
        destination: null,
        localOnly: true,
        providerId: null,
        reason: "remote-route-blocked-by-local-only",
        source: "explicit-config",
        status: "blocked-local-only",
        rawError: "private route failure details"
      } as never,
      observedAtIso: "2026-08-08T01:02:03.000Z"
    });
    const getRuntimeStatus = vi.fn(runtimeStatus.get);
    const server = Fastify();
    registerAutomationRoutes(server, {
      authService: undefined,
      briefingRuntimeStatus: getRuntimeStatus,
      env: env(),
      messagingRegistry: registry()
    });

    try {
      const response = await server.inject({ method: "GET", url: "/api/automation/upcoming" });
      const body = response.json() as AutomationUpcomingResponse;

      expect(response.statusCode).toBe(200);
      expect(body.briefingRuntime).toEqual({
        lastDecision: "route-unavailable",
        lastDeliveredCount: 0,
        lastErrorCount: 9_999,
        lastImminentCount: 0,
        lastObservedAtIso: "2026-08-08T01:02:03.000Z",
        lastRoute: {
          destination: null,
          localOnly: true,
          providerId: null,
          reason: "remote-route-blocked-by-local-only",
          source: "explicit-config",
          status: "blocked-local-only"
        }
      });
      expect(body.gateway.status).toBe("resolved");
      expect(response.body).not.toContain("private route failure details");
      expect(runtimeStatus.get()).toEqual(body.briefingRuntime);
    } finally {
      await server.close();
    }
  });
});
