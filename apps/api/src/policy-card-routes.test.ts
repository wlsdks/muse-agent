import type {
  OwnerTaughtPolicyCardPreviewResult,
  OwnerTaughtPolicyCardPreviewService
} from "@muse/autoconfigure";
import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";

import {
  parseOwnerTaughtPolicyCardRequest,
  registerPolicyCardRoutes
} from "./policy-card-routes.js";
import { buildServer } from "./server.js";

const OPPORTUNITY_ID = `learning_opportunity_${"a".repeat(64)}`;

function server(preview?: OwnerTaughtPolicyCardPreviewService) {
  const app = Fastify();
  registerPolicyCardRoutes(app, { authService: undefined, ...(preview ? { preview } : {}) });
  return app;
}

describe("owner-taught Policy Card routes", () => {
  it("parses only one exact bounded display request", () => {
    expect(parseOwnerTaughtPolicyCardRequest(OPPORTUNITY_ID, {
      detail: "compact",
      locale: "ko",
      nextStep: "direct"
    })).toEqual({ detail: "compact", locale: "ko", nextStep: "direct" });
    expect(parseOwnerTaughtPolicyCardRequest("opportunity", {
      detail: "compact",
      locale: "ko",
      nextStep: "direct"
    })).toEqual({ errorMessage: "policy card opportunityId is invalid" });
    expect(parseOwnerTaughtPolicyCardRequest(OPPORTUNITY_ID, {
      detail: "compact",
      locale: "ko",
      nextStep: "direct",
      write: true
    })).toEqual({ errorMessage: "policy card request has invalid fields" });
    expect(parseOwnerTaughtPolicyCardRequest(OPPORTUNITY_ID, {
      detail: "expanded",
      locale: "ko",
      nextStep: "direct"
    })).toEqual({ errorMessage: "policy card request has invalid values" });
  });

  it("forwards one exact read-only request and preserves the finite result", async () => {
    const rendered = {
      card: { cardVersion: "attunegraph-policy-card.v1" },
      schemaVersion: 1,
      status: "rendered"
    } as unknown as OwnerTaughtPolicyCardPreviewResult;
    const preview = vi.fn(async () => rendered);
    const app = server({ preview });
    const response = await app.inject({
      method: "POST",
      payload: { detail: "compact", locale: "en", nextStep: "contextual" },
      url: `/api/attunement/learning-opportunities/${OPPORTUNITY_ID}/policy-card-preview`
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("private, no-store");
    expect(response.json()).toEqual(rendered);
    expect(preview).toHaveBeenCalledOnce();
    expect(preview).toHaveBeenCalledWith({
      detail: "compact",
      locale: "en",
      nextStep: "contextual",
      opportunityId: OPPORTUNITY_ID
    });
    await app.close();
  });

  it("fails closed when the service is absent, throws, or input drifts", async () => {
    const absent = server();
    const absentResponse = await absent.inject({
      method: "POST",
      payload: { detail: "compact", locale: "en", nextStep: "direct" },
      url: `/api/attunement/learning-opportunities/${OPPORTUNITY_ID}/policy-card-preview`
    });
    expect(absentResponse.statusCode).toBe(503);
    expect(absentResponse.json()).toEqual({
      reason: "service-not-configured",
      schemaVersion: 1,
      status: "unavailable"
    });
    await absent.close();

    const failing = server({ preview: vi.fn(async () => {
      throw new Error("private failure");
    }) });
    const failedResponse = await failing.inject({
      method: "POST",
      payload: { detail: "compact", locale: "en", nextStep: "direct" },
      url: `/api/attunement/learning-opportunities/${OPPORTUNITY_ID}/policy-card-preview`
    });
    expect(failedResponse.statusCode).toBe(503);
    expect(failedResponse.json()).toEqual({
      reason: "service-failure",
      schemaVersion: 1,
      status: "unavailable"
    });
    await failing.close();

    const drifted = server({ preview: vi.fn() });
    const driftedResponse = await drifted.inject({
      method: "POST",
      payload: { detail: "compact", locale: "en", nextStep: "direct", apply: true },
      url: `/api/attunement/learning-opportunities/${OPPORTUNITY_ID}/policy-card-preview`
    });
    expect(driftedResponse.statusCode).toBe(400);
    await drifted.close();
  });

  it("is registered on the production server and denies anonymous preview", async () => {
    const preview = vi.fn();
    const app = buildServer({
      authService: {
        authenticateBearer: vi.fn(async () => undefined)
      } as never,
      logger: false,
      ownerTaughtPolicyCardPreview: { preview },
      requireAuth: true
    });
    const response = await app.inject({
      method: "POST",
      payload: { detail: "compact", locale: "ko", nextStep: "contextual" },
      url: `/api/attunement/learning-opportunities/${OPPORTUNITY_ID}/policy-card-preview`
    });

    expect(response.statusCode).toBe(401);
    expect(response.headers["cache-control"]).toBe("private, no-store");
    expect(preview).not.toHaveBeenCalled();
    await app.close();
  });
});
