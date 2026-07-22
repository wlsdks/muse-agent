import { describe, expect, it } from "vitest";

import { assessDaemonResourceAdmission } from "./daemon-resource-admission.js";

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
});
