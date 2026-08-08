import { describe, expect, it } from "vitest";

import { admitAutomationRoute } from "./automation-route-admission.js";

const resolvedRoute = {
  destination: "owner-a",
  localOnly: false,
  providerId: "telegram",
  reason: null,
  source: "explicit-config" as const,
  status: "resolved" as const
};

describe("admitAutomationRoute", () => {
  it("admits only a canonical resolved route and normalizes its endpoint fields", () => {
    const admission = admitAutomationRoute({
      localOnly: false,
      resolveRoute: () => ({ ...resolvedRoute, destination: "  owner-a  ", providerId: " telegram " })
    });

    expect(admission).toEqual({ admitted: true, route: resolvedRoute });
  });

  it("does not synthesize a route from raw provider and destination fields", () => {
    const admission = admitAutomationRoute({
      localOnly: true,
      resolveRoute: () => ({ destination: "owner-a", providerId: "telegram" })
    });

    expect(admission).toEqual({
      admitted: false,
      route: {
        destination: null,
        localOnly: true,
        providerId: null,
        reason: "paired-route-inspection-unavailable",
        source: null,
        status: "unconfigured"
      }
    });
  });

  it("keeps a resolved receipt with blank endpoints unavailable after trimming", () => {
    const admission = admitAutomationRoute({
      localOnly: false,
      resolveRoute: () => ({ ...resolvedRoute, destination: "  ", providerId: "\t" })
    });

    expect(admission.admitted).toBe(false);
    expect(admission.route).toEqual({ ...resolvedRoute, destination: "", providerId: "" });
  });

  it("preserves canonical reasons and the captured local-only posture", () => {
    const admission = admitAutomationRoute({
      localOnly: true,
      resolveRoute: () => ({
        destination: null,
        localOnly: true,
        providerId: null,
        reason: "malformed-paired-route",
        source: null,
        status: "unconfigured"
      })
    });

    expect(admission).toEqual({
      admitted: false,
      route: {
        destination: null,
        localOnly: true,
        providerId: null,
        reason: "malformed-paired-route",
        source: null,
        status: "unconfigured"
      }
    });
  });

  it("catches resolver throws exactly once without exposing the thrown value", () => {
    let calls = 0;
    const admission = admitAutomationRoute({
      localOnly: true,
      resolveRoute: () => {
        calls += 1;
        throw new Error("private route detail");
      }
    });

    expect(calls).toBe(1);
    expect(admission).toEqual({
      admitted: false,
      route: {
        destination: null,
        localOnly: true,
        providerId: null,
        reason: "paired-route-inspection-unavailable",
        source: null,
        status: "unconfigured"
      }
    });
    expect(JSON.stringify(admission)).not.toContain("private route detail");
  });

  it("fails closed when a route getter throws and strips unknown fields", () => {
    const route = {
      destination: "owner-a",
      localOnly: true,
      providerId: "telegram",
      reason: "remote-route-blocked-by-local-only",
      source: "explicit-config",
      status: "blocked-local-only",
      get credential(): string {
        throw new Error("credential getter");
      },
      get provider(): unknown {
        return { credential: "secret" };
      }
    };
    Object.defineProperty(route, "localOnly", {
      configurable: true,
      enumerable: true,
      get: () => { throw new Error("localOnly getter"); }
    });

    const admission = admitAutomationRoute({ localOnly: true, resolveRoute: () => route });

    expect(admission).toEqual({
      admitted: false,
      route: {
        destination: null,
        localOnly: true,
        providerId: null,
        reason: "paired-route-inspection-unavailable",
        source: null,
        status: "unconfigured"
      }
    });
    expect(JSON.stringify(admission)).not.toContain("secret");
  });
});
