import { describe, expect, it } from "vitest";

import { assessDaemonResourceAdmission, daemonResourcePolicyEnvironment, describeDaemonResourceAdmission, resolveDaemonResourcePolicy } from "./daemon-resource-admission.js";

describe("assessDaemonResourceAdmission", () => {
  const healthy = { cpuCount: 8, freeMemoryBytes: 4 * 1024 * 1024 * 1024, load1: 1 };

  it("admits heavyweight work under conservative local headroom", () => {
    expect(assessDaemonResourceAdmission({}, healthy)).toEqual({ status: "admit" });
  });

  it("defers heavyweight work for low memory or CPU pressure", () => {
    expect(assessDaemonResourceAdmission({}, { ...healthy, freeMemoryBytes: 512 * 1024 * 1024 }))
      .toEqual({ reason: "low-free-memory", status: "defer" });
    expect(assessDaemonResourceAdmission({}, { ...healthy, load1: 6 }))
      .toEqual({ reason: "cpu-load", status: "defer" });
  });

  it("uses bounded daemon-only overrides and fails open on invalid observations", () => {
    expect(assessDaemonResourceAdmission({ MUSE_DAEMON_MIN_FREE_MEMORY_MB: "256" }, { ...healthy, freeMemoryBytes: 512 * 1024 * 1024 }))
      .toEqual({ status: "admit" });
    expect(assessDaemonResourceAdmission({ MUSE_DAEMON_RESOURCE_GUARD: "false" }, { ...healthy, load1: 99 }))
      .toEqual({ status: "admit" });
    expect(assessDaemonResourceAdmission({}, { ...healthy, load1: Number.NaN })).toEqual({ status: "admit" });
  });

  it("normalizes one shared policy while allowing only valid explicit overrides into a resident environment", () => {
    expect(resolveDaemonResourcePolicy({
      MUSE_DAEMON_MAX_LOAD_PER_CORE: "0.5",
      MUSE_DAEMON_MIN_FREE_MEMORY_MB: "2048",
      MUSE_DAEMON_RESOURCE_GUARD: "off"
    })).toEqual({ guardEnabled: false, maxLoadPerCore: 0.5, minFreeMemoryMb: 2048 });
    expect(daemonResourcePolicyEnvironment({
      MUSE_DAEMON_MAX_LOAD_PER_CORE: "100",
      MUSE_DAEMON_MIN_FREE_MEMORY_MB: "2048.5",
      MUSE_DAEMON_RESOURCE_GUARD: "YES",
      OPENAI_API_KEY: "must-not-persist"
    })).toEqual({ MUSE_DAEMON_MIN_FREE_MEMORY_MB: "2048.5", MUSE_DAEMON_RESOURCE_GUARD: "true" });
  });

  it("describes the policy and deferral without exposing process or model details", () => {
    const snapshot = { ...healthy, freeMemoryBytes: 512 * 1024 * 1024 };
    const admission = assessDaemonResourceAdmission({}, snapshot);
    expect(describeDaemonResourceAdmission(resolveDaemonResourcePolicy({}), snapshot, admission, "LaunchAgent"))
      .toContain("heavy background work deferred (low-free-memory)");
  });
});
