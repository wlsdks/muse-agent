import { describe, expect, it } from "vitest";

import type { CompatibilityRouteOptions } from "./compat-routes.js";
import { dashboardSummary } from "./compat-dashboard.js";

// Direct coverage for the admin dashboard summary (untested module). Its
// load-bearing aggregations are the scheduler attention counts and — core to
// Muse's edge — the RESPONSE-TRUST rollup (boundary failures, output-guard
// modified/rejected, UNVERIFIED responses). Driven through fully-faked stores.

const optionsWith = (over: Record<string, unknown>): CompatibilityRouteOptions => over as unknown as CompatibilityRouteOptions;

describe("dashboardSummary", () => {
  it("aggregates scheduler attention counts (disabled jobs excluded from failed/agent)", async () => {
    const jobs = [
      { enabled: true, jobType: "agent", lastStatus: "running", name: "j1" },
      { enabled: true, jobType: "mcp", lastStatus: "failed", name: "j2" },
      { enabled: false, jobType: "agent", lastStatus: "failed", name: "j3" }, // disabled → not counted in failed/agent
      { enabled: true, jobType: "agent", lastStatus: "success", name: "j4" }
    ];
    const out = await dashboardSummary(optionsWith({
      scheduler: { executionStore: { findRecent: async () => [] }, store: { list: async () => jobs } }
    }));
    expect(out.scheduler).toEqual({ agentJobs: 2, attentionBacklog: 2, enabledJobs: 3, failedJobs: 1, runningJobs: 1, totalJobs: 4 });
  });

  it("rolls up the MCP server status counts", async () => {
    const out = await dashboardSummary(optionsWith({
      mcp: { manager: { getStatus: (n: string) => (n === "a" ? "connected" : "disabled"), listServers: async () => [{ name: "a" }, { name: "b" }] } }
    }));
    expect(out.mcp).toEqual({ statusCounts: { CONNECTED: 1, DISABLED: 1 }, total: 2 });
  });

  it("computes the response-trust rollup — boundary failures, guard actions, and UNVERIFIED responses", async () => {
    const events = [
      { payload: { metadata: { channel: "chat" }, reason: "blocked" }, type: "guard_rejection" },
      { payload: { action: "modified", metadata: { policy: "pii" } }, type: "output_guard_action" },
      { payload: { action: "rejected" }, type: "output_guard_action" },
      { payload: { metadata: { grounded: true, verified: false } }, type: "agent_run" }, // unverified → counted
      { payload: { metadata: { grounded: true, verified: true } }, type: "agent_run" } // fully verified → not counted
    ];
    const out = await dashboardSummary(optionsWith({
      admin: { observability: { metrics: { recordedEvents: () => events } } }
    }));
    expect(out.responseTrust).toEqual({ boundaryFailures: 1, outputGuardModified: 1, outputGuardRejected: 1, unverifiedResponses: 1 });
    // guard_rejection + 2 output_guard_action surface as recent trust events (agent_runs excluded); newest first, guard_rejection is a warning.
    expect(out.recentTrustEvents).toHaveLength(3);
    expect(out.recentTrustEvents.at(-1)).toMatchObject({ severity: "warning", type: "guard_rejection" });
  });

  it("returns all-zero / empty rollups when no stores are configured", async () => {
    const out = await dashboardSummary(optionsWith({}));
    expect(out.scheduler).toEqual({ agentJobs: 0, attentionBacklog: 0, enabledJobs: 0, failedJobs: 0, runningJobs: 0, totalJobs: 0 });
    expect(out.mcp).toEqual({ statusCounts: {}, total: 0 });
    expect(out.responseTrust).toEqual({ boundaryFailures: 0, outputGuardModified: 0, outputGuardRejected: 0, unverifiedResponses: 0 });
  });
});
