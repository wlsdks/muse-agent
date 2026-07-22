import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  describeDaemonResourceAdmissionReceipt,
  readDaemonResourceAdmissionReceipt,
  resolveDaemonResourceReceiptFile,
  resourceAdmissionReceipt,
  withWorkloadBoundary,
  workloadDecisionReceipt,
  writeDaemonResourceAdmissionReceipt
} from "./daemon-resource-receipt.js";

describe("daemon resource admission receipt", () => {
  it("writes an owner-only latest-state receipt without snapshots, process data, or history", async () => {
    const directory = await mkdtemp(join(tmpdir(), "muse-resource-receipt-"));
    const file = join(directory, "nested", "receipt.json");
    try {
      const receipt = resourceAdmissionReceipt({ reason: "cpu-load", status: "defer" }, "2026-07-22T00:00:00.000Z");
      await writeDaemonResourceAdmissionReceipt(file, receipt);
      expect(await readDaemonResourceAdmissionReceipt(file)).toEqual(receipt);
      expect(JSON.parse(await readFile(file, "utf8"))).toEqual(receipt);
      expect((await (await import("node:fs/promises")).stat(file)).mode & 0o777).toBe(0o600);
      expect(describeDaemonResourceAdmissionReceipt(receipt, new Date("2026-07-22T01:00:00.000Z")))
        .toBe("legacy transition evidence deferred (cpu-load) at 2026-07-22T00:00:00.000Z");
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("preserves a full-governor decision beside a newly governed unit boundary", async () => {
    const directory = await mkdtemp(join(tmpdir(), "muse-workload-receipt-"));
    const file = join(directory, "receipt.json");
    try {
      const decision = workloadDecisionReceipt({ status: "admit" }, {
        cpuCount: 8,
        freeMemoryBytes: 4_000_000_000,
        idleMs: 300_000,
        load1: 1.25,
        onAcPower: true,
        platform: "darwin",
        processCpuSystemMicros: 20,
        processCpuUserMicros: 40,
        residentMemoryBytes: 100_000_000,
        thermalState: "nominal"
      }, 16, "2026-07-22T00:00:00.000Z");
      const receipt = withWorkloadBoundary(decision, {
        at: "2026-07-22T00:00:01.000Z",
        cpuDeltaMicros: 50,
        durationMs: 1_000,
        queueDepth: 15,
        rssAfterBytes: 100_000_010,
        rssBeforeBytes: 100_000_000,
        status: "completed",
        stopRequestedDuring: false,
        unit: "followup"
      });
      await writeDaemonResourceAdmissionReceipt(file, receipt);
      expect(await readDaemonResourceAdmissionReceipt(file)).toEqual(receipt);
      expect(receipt.decision.observation.cpu).toEqual({ count: 8, loadMilli: 1_250, status: "available" });
      expect(describeDaemonResourceAdmissionReceipt(receipt, new Date("2026-07-22T01:00:00.000Z")))
        .toContain("last unit followup completed");
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("rejects expanded v2 evidence and labels old history stale without calling it current", async () => {
    const directory = await mkdtemp(join(tmpdir(), "muse-workload-invalid-"));
    const file = join(directory, "receipt.json");
    try {
      const receipt = workloadDecisionReceipt({ reason: "active-user", status: "defer" }, {
        cpuCount: 8, freeMemoryBytes: 4_000_000_000, idleMs: 1, load1: 1, onAcPower: true, platform: "darwin"
      }, 9, "2026-07-20T00:00:00.000Z");
      const expanded = { ...receipt, decision: { ...receipt.decision, secret: "forbidden" } };
      await writeFile(file, JSON.stringify(expanded), "utf8");
      expect(await readDaemonResourceAdmissionReceipt(file)).toBeUndefined();
      expect(describeDaemonResourceAdmissionReceipt(receipt, new Date("2026-07-22T00:00:00.001Z")))
        .toContain("stale/unverified");
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("rejects oversized files and forbidden status-specific fields", async () => {
    const directory = await mkdtemp(join(tmpdir(), "muse-workload-bounds-"));
    const file = join(directory, "receipt.json");
    try {
      await writeFile(file, "x".repeat(65 * 1024), "utf8");
      expect(await readDaemonResourceAdmissionReceipt(file)).toBeUndefined();

      const admitted = workloadDecisionReceipt({ status: "admit" }, {
        cpuCount: 8, freeMemoryBytes: 4_000_000_000, load1: 1, platform: "linux"
      }, 1, "2026-07-22T00:00:00.000Z");
      const malformed = { ...admitted, decision: { ...admitted.decision, reason: "cpu-load" } };
      await writeFile(file, JSON.stringify(malformed), "utf8");
      expect(await readDaemonResourceAdmissionReceipt(file)).toBeUndefined();
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("rejects forbidden and missing boundary-conditional fields", async () => {
    const directory = await mkdtemp(join(tmpdir(), "muse-workload-boundary-fields-"));
    const file = join(directory, "receipt.json");
    try {
      const decision = workloadDecisionReceipt({ status: "admit" }, {
        cpuCount: 8, freeMemoryBytes: 4_000_000_000, load1: 1, platform: "linux"
      }, 1, "2026-07-22T00:00:00.000Z");
      const completed = {
        at: "2026-07-22T00:00:01.000Z", cpuDeltaMicros: 1, durationMs: 1, queueDepth: 0,
        rssAfterBytes: 2, rssBeforeBytes: 1, status: "completed", stopRequestedDuring: false,
        unit: "reflection"
      };
      for (const lastBoundary of [
        { ...completed, errorClass: "model" },
        { ...completed, boundaryLatencyMs: 1 },
        { ...completed, status: "failed" }
      ]) {
        await writeFile(file, JSON.stringify({ ...decision, lastBoundary }), "utf8");
        expect(await readDaemonResourceAdmissionReceipt(file)).toBeUndefined();
      }
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("treats malformed, expanded, or unavailable evidence as absent", async () => {
    const directory = await mkdtemp(join(tmpdir(), "muse-resource-receipt-invalid-"));
    const file = join(directory, "receipt.json");
    try {
      await writeFile(file, JSON.stringify({ at: "2026-07-22T00:00:00.000Z", schema: "muse.daemon-resource-admission.v1", status: "admit", snapshot: 1 }), "utf8");
      expect(await readDaemonResourceAdmissionReceipt(file)).toBeUndefined();
      expect(await readDaemonResourceAdmissionReceipt(join(directory, "missing.json"))).toBeUndefined();
      expect(describeDaemonResourceAdmissionReceipt(undefined)).toBe("no prior transition evidence");
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("keeps owner pause out of the frozen legacy v1 reason set", async () => {
    const directory = await mkdtemp(join(tmpdir(), "muse-resource-receipt-owner-pause-"));
    const file = join(directory, "receipt.json");
    try {
      expect(() => resourceAdmissionReceipt({ reason: "owner-paused", status: "defer" }, "2026-07-22T00:00:00.000Z"))
        .toThrow("legacy resource receipt only supports");
      await writeFile(file, JSON.stringify({ at: "2026-07-22T00:00:00.000Z", reason: "owner-paused", schema: "muse.daemon-resource-admission.v1", status: "defer" }), "utf8");
      expect(await readDaemonResourceAdmissionReceipt(file)).toBeUndefined();
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("uses an explicit test path or a bounded Muse-home default", () => {
    expect(resolveDaemonResourceReceiptFile({ MUSE_DAEMON_RESOURCE_RECEIPT_FILE: " /tmp/receipt.json " })).toBe("/tmp/receipt.json");
    expect(resolveDaemonResourceReceiptFile({ HOME: "/tmp/muse-home" })).toBe("/tmp/muse-home/.muse/daemon-resource-admission.json");
  });
});
