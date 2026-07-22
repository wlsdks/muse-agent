import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  describeDaemonResourceAdmissionReceipt,
  readDaemonResourceAdmissionReceipt,
  resolveDaemonResourceReceiptFile,
  resourceAdmissionReceipt,
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
      expect(describeDaemonResourceAdmissionReceipt(receipt)).toBe("last transition deferred (cpu-load) at 2026-07-22T00:00:00.000Z");
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

  it("uses an explicit test path or a bounded Muse-home default", () => {
    expect(resolveDaemonResourceReceiptFile({ MUSE_DAEMON_RESOURCE_RECEIPT_FILE: " /tmp/receipt.json " })).toBe("/tmp/receipt.json");
    expect(resolveDaemonResourceReceiptFile({ HOME: "/tmp/muse-home" })).toBe("/tmp/muse-home/.muse/daemon-resource-admission.json");
  });
});
