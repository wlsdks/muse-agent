import { describe, expect, it } from "vitest";

import { projectApiHealth } from "./api-readiness.js";

describe("API readiness projection", () => {
  it("keeps liveness up while no-model resident readiness is red", () => {
    expect(projectApiHealth({
      localOnly: true,
      modelConfigured: false,
      residentConfigured: false
    })).toEqual({
      degraded: true,
      dependencies: {
        model: "unavailable",
        network: "not-required",
        resident: "unavailable",
        stores: "ready"
      },
      liveness: { status: "up" },
      readiness: {
        reasons: ["model-unconfigured", "agent-runtime-unavailable"],
        status: "not-ready"
      }
    });
  });

  it("reports a local resident composition as ready without requiring public network", () => {
    expect(projectApiHealth({
      localOnly: true,
      modelConfigured: true,
      residentConfigured: true
    })).toMatchObject({
      degraded: false,
      dependencies: {
        model: "ready",
        network: "not-required",
        resident: "ready",
        stores: "ready"
      },
      readiness: { reasons: [], status: "ready" }
    });
  });

  it("fails closed on unavailable network and store dependencies with closed reason codes", () => {
    expect(projectApiHealth({
      dependencyReadiness: {
        network: "unavailable",
        stores: "unavailable"
      },
      localOnly: false,
      modelConfigured: true,
      residentConfigured: true
    })).toMatchObject({
      degraded: true,
      dependencies: {
        network: "unavailable",
        stores: "unavailable"
      },
      readiness: {
        reasons: ["network-unavailable", "stores-unavailable"],
        status: "not-ready"
      }
    });
  });

  it("rejects a not-required network claim when cloud posture requires network", () => {
    expect(projectApiHealth({
      dependencyReadiness: { network: "not-required" },
      localOnly: false,
      modelConfigured: true,
      residentConfigured: true
    })).toMatchObject({
      degraded: true,
      dependencies: { network: "unverified" },
      readiness: {
        reasons: ["network-unverified"],
        status: "not-ready"
      }
    });
  });

  it("does not let a snapshot claim absent configured dependencies are ready", () => {
    const projection = projectApiHealth({
      dependencyReadiness: { model: "ready", resident: "ready" },
      localOnly: true,
      modelConfigured: false,
      residentConfigured: false
    });
    expect(projection.dependencies.model).toBe("unavailable");
    expect(projection.dependencies.resident).toBe("unavailable");
  });

  it("distinguishes a configured model outage and rejects not-required resident claims", () => {
    const projection = projectApiHealth({
      dependencyReadiness: {
        model: "unavailable",
        resident: "not-required"
      },
      localOnly: true,
      modelConfigured: true,
      residentConfigured: true
    });
    expect(projection.dependencies.resident).toBe("unverified");
    expect(projection.readiness.reasons).toEqual([
      "model-unavailable",
      "agent-runtime-unverified"
    ]);
  });

  it("turns a corrupt snapshot getter into a secret-safe reason instead of throwing", () => {
    const dependencyReadiness = Object.defineProperty({}, "network", {
      get: () => {
        throw new Error("Authorization: Bearer owner-secret");
      }
    });
    const projection = projectApiHealth({
      dependencyReadiness,
      localOnly: true,
      modelConfigured: true,
      residentConfigured: true
    });
    expect(projection.readiness).toEqual({
      reasons: ["readiness-snapshot-unavailable"],
      status: "not-ready"
    });
    expect(JSON.stringify(projection)).not.toContain("owner-secret");
  });
});
