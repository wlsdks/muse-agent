import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { atomicWriteFile } from "@muse/stores";
import { describe, expect, it, vi } from "vitest";

import {
  applyResidentDaemonInstallTransaction,
  parseResidentDaemonInstallReceipt,
  resolveResidentDaemonInstallStateFiles,
  residentDaemonArtifactDigest
} from "./resident-daemon-install-state.js";

function fixture() {
  const home = mkdtempSync(join(tmpdir(), "muse-daemon-install-"));
  const artifactFile = join(home, "Library", "LaunchAgents", "com.muse.daemon.plist");
  mkdirSync(dirname(artifactFile), { recursive: true });
  return {
    artifactFile,
    files: resolveResidentDaemonInstallStateFiles({ HOME: home }),
    home
  };
}

describe("resident daemon install transaction", () => {
  it("installs atomically and reruns idempotently with a versioned owner-only receipt", async () => {
    const state = fixture();
    const activate = vi.fn(async () => true);
    const deactivate = vi.fn(async () => undefined);
    const input = {
      activate,
      artifactFile: state.artifactFile,
      deactivate,
      desiredArtifact: "<plist>v1</plist>\n",
      files: state.files,
      now: () => new Date("2026-07-26T00:00:00.000Z"),
      productVersion: "1.0.0"
    };

    const installed = await applyResidentDaemonInstallTransaction(input);
    const rerun = await applyResidentDaemonInstallTransaction(input);

    expect(installed).toMatchObject({ changed: true, ok: true, receipt: { phase: "verified" } });
    expect(rerun).toMatchObject({ changed: false, ok: true, receipt: { phase: "verified" } });
    expect(readFileSync(state.artifactFile, "utf8")).toBe(input.desiredArtifact);
    const receipt = parseResidentDaemonInstallReceipt(readFileSync(state.files.receiptFile, "utf8"));
    expect(receipt).toMatchObject({
      artifactDigest: residentDaemonArtifactDigest(input.desiredArtifact),
      phase: "verified",
      productVersion: "1.0.0"
    });
    expect(receipt?.sequence).toBeGreaterThan(installed.receipt?.sequence ?? 0);
    expect(parseResidentDaemonInstallReceipt(JSON.stringify({
      ...receipt,
      productVersion: "01.0.0-."
    }))).toBeUndefined();
    expect(activate).toHaveBeenCalledTimes(2);
    expect(deactivate).toHaveBeenCalledOnce();
  });

  it("backs up exact prior bytes and restores them when activation fails", async () => {
    const state = fixture();
    const prior = "<plist>prior</plist>\n";
    writeFileSync(state.artifactFile, prior);
    let activations = 0;
    const result = await applyResidentDaemonInstallTransaction({
      activate: async () => {
        activations += 1;
        return activations > 1;
      },
      artifactFile: state.artifactFile,
      deactivate: async () => undefined,
      desiredArtifact: "<plist>broken</plist>\n",
      files: state.files,
      now: () => new Date("2026-07-26T00:00:00.000Z"),
      productVersion: "1.1.0"
    });

    expect(result).toMatchObject({
      changed: true,
      ok: false,
      reason: "activation-failed",
      rolledBack: true
    });
    expect(readFileSync(state.artifactFile, "utf8")).toBe(prior);
    expect(result.receipt?.backupFile).toBeTruthy();
    expect(readFileSync(result.receipt!.backupFile!, "utf8")).toBe(prior);
    expect(result.receipt?.phase).toBe("rolled-back");
  });

  it("resumes a crash after prepared receipt without accepting unrelated artifact drift", async () => {
    const state = fixture();
    const prior = "<plist>prior</plist>\n";
    writeFileSync(state.artifactFile, prior);
    let writes = 0;
    const interrupted = await applyResidentDaemonInstallTransaction({
      activate: async () => true,
      artifactFile: state.artifactFile,
      deactivate: async () => undefined,
      desiredArtifact: "<plist>next</plist>\n",
      files: state.files,
      productVersion: "1.1.0",
      writePrivate: async (file, contents) => {
        writes += 1;
        if (file === state.artifactFile) throw new Error("simulated crash");
        await atomicWriteFile(file, contents, { mode: 0o600 });
      }
    });
    expect(interrupted).toMatchObject({ changed: true, ok: false, reason: "persistence-failed" });
    expect(parseResidentDaemonInstallReceipt(readFileSync(state.files.receiptFile, "utf8")))
      .toMatchObject({ phase: "prepared" });

    const resumed = await applyResidentDaemonInstallTransaction({
      activate: async () => true,
      artifactFile: state.artifactFile,
      deactivate: async () => undefined,
      desiredArtifact: "<plist>next</plist>\n",
      files: state.files,
      productVersion: "1.1.0"
    });
    expect(resumed).toMatchObject({ changed: true, ok: true, receipt: { phase: "verified" } });
    expect(readFileSync(state.artifactFile, "utf8")).toBe("<plist>next</plist>\n");

    writeFileSync(state.files.receiptFile, readFileSync(state.files.receiptFile, "utf8").replace(
      "\"phase\":\"verified\"",
      "\"phase\":\"prepared\""
    ));
    chmodSync(state.files.receiptFile, 0o600);
    writeFileSync(state.artifactFile, "<plist>attacker drift</plist>\n");
    const drifted = await applyResidentDaemonInstallTransaction({
      activate: async () => true,
      artifactFile: state.artifactFile,
      deactivate: async () => undefined,
      desiredArtifact: "<plist>next</plist>\n",
      files: state.files,
      productVersion: "1.1.0"
    });
    expect(drifted).toMatchObject({ changed: false, ok: false, reason: "artifact-drift" });
    expect(writes).toBeGreaterThanOrEqual(2);
  });

  it("rejects stable-to-prerelease downgrade and corrupt receipt before service effects", async () => {
    const state = fixture();
    const activate = vi.fn(async () => true);
    const deactivate = vi.fn(async () => undefined);
    await applyResidentDaemonInstallTransaction({
      activate,
      artifactFile: state.artifactFile,
      deactivate,
      desiredArtifact: "<plist>v2</plist>\n",
      files: state.files,
      productVersion: "2.0.0"
    });
    activate.mockClear();
    deactivate.mockClear();
    const downgrade = await applyResidentDaemonInstallTransaction({
      activate,
      artifactFile: state.artifactFile,
      deactivate,
      desiredArtifact: "<plist>v1</plist>\n",
      files: state.files,
      productVersion: "1.9.9"
    });
    expect(downgrade).toMatchObject({ changed: false, ok: false, reason: "downgrade-refused" });
    expect(activate).not.toHaveBeenCalled();
    expect(deactivate).not.toHaveBeenCalled();

    writeFileSync(state.files.receiptFile, "{\"private\":true}\n");
    chmodSync(state.files.receiptFile, 0o600);
    const corrupt = await applyResidentDaemonInstallTransaction({
      activate,
      artifactFile: state.artifactFile,
      deactivate,
      desiredArtifact: "<plist>v3</plist>\n",
      files: state.files,
      productVersion: "3.0.0"
    });
    expect(corrupt).toMatchObject({ changed: false, ok: false, reason: "receipt-invalid" });
    expect(await readFile(state.artifactFile, "utf8")).toBe("<plist>v2</plist>\n");

    const prereleaseState = fixture();
    await applyResidentDaemonInstallTransaction({
      activate: async () => true,
      artifactFile: prereleaseState.artifactFile,
      deactivate: async () => undefined,
      desiredArtifact: "<plist>alpha-beta</plist>\n",
      files: prereleaseState.files,
      productVersion: "1.0.0-alpha-beta"
    });
    const prereleaseActivate = vi.fn(async () => true);
    const prereleaseDeactivate = vi.fn(async () => undefined);
    const hyphenDowngrade = await applyResidentDaemonInstallTransaction({
      activate: prereleaseActivate,
      artifactFile: prereleaseState.artifactFile,
      deactivate: prereleaseDeactivate,
      desiredArtifact: "<plist>alpha</plist>\n",
      files: prereleaseState.files,
      productVersion: "1.0.0-alpha"
    });
    expect(hyphenDowngrade).toMatchObject({
      changed: false,
      ok: false,
      reason: "downgrade-refused"
    });
    expect(prereleaseActivate).not.toHaveBeenCalled();
    expect(prereleaseDeactivate).not.toHaveBeenCalled();
  });

  it("rejects verified artifact drift and an untrusted receipt mode before service effects", async () => {
    const state = fixture();
    const activate = vi.fn(async () => true);
    const deactivate = vi.fn(async () => undefined);
    await applyResidentDaemonInstallTransaction({
      activate,
      artifactFile: state.artifactFile,
      deactivate,
      desiredArtifact: "<plist>stable</plist>\n",
      files: state.files,
      productVersion: "2.0.0"
    });

    activate.mockClear();
    deactivate.mockClear();
    const prereleaseDowngrade = await applyResidentDaemonInstallTransaction({
      activate,
      artifactFile: state.artifactFile,
      deactivate,
      desiredArtifact: "<plist>prerelease</plist>\n",
      files: state.files,
      productVersion: "2.0.0-beta.2"
    });
    expect(prereleaseDowngrade).toMatchObject({
      changed: false,
      ok: false,
      reason: "downgrade-refused"
    });

    writeFileSync(state.artifactFile, "<plist>next</plist>\n");
    const drifted = await applyResidentDaemonInstallTransaction({
      activate,
      artifactFile: state.artifactFile,
      deactivate,
      desiredArtifact: "<plist>next</plist>\n",
      files: state.files,
      productVersion: "2.1.0"
    });
    expect(drifted).toMatchObject({ changed: false, ok: false, reason: "artifact-drift" });

    writeFileSync(state.artifactFile, "<plist>stable</plist>\n");
    chmodSync(state.files.receiptFile, 0o644);
    const untrustedReceipt = await applyResidentDaemonInstallTransaction({
      activate,
      artifactFile: state.artifactFile,
      deactivate,
      desiredArtifact: "<plist>next</plist>\n",
      files: state.files,
      productVersion: "2.1.0"
    });
    expect(untrustedReceipt).toMatchObject({
      changed: false,
      ok: false,
      reason: "receipt-invalid"
    });
    expect(activate).not.toHaveBeenCalled();
    expect(deactivate).not.toHaveBeenCalled();
  });

  it("rejects a verified backup symlink and a writable artifact before service effects", async () => {
    const backupState = fixture();
    writeFileSync(backupState.artifactFile, "<plist>prior</plist>\n");
    const installed = await applyResidentDaemonInstallTransaction({
      activate: async () => true,
      artifactFile: backupState.artifactFile,
      deactivate: async () => undefined,
      desiredArtifact: "<plist>current</plist>\n",
      files: backupState.files,
      productVersion: "1.0.0"
    });
    const backupFile = installed.receipt!.backupFile!;
    const symlinkTarget = join(backupState.home, "replacement.artifact");
    writeFileSync(symlinkTarget, "<plist>prior</plist>\n", { mode: 0o600 });
    unlinkSync(backupFile);
    symlinkSync(symlinkTarget, backupFile);
    const activate = vi.fn(async () => true);
    const deactivate = vi.fn(async () => undefined);
    const unsafeBackup = await applyResidentDaemonInstallTransaction({
      activate,
      artifactFile: backupState.artifactFile,
      deactivate,
      desiredArtifact: "<plist>current</plist>\n",
      files: backupState.files,
      productVersion: "1.0.0"
    });
    expect(unsafeBackup).toMatchObject({
      changed: false,
      ok: false,
      reason: "backup-invalid"
    });
    expect(activate).not.toHaveBeenCalled();
    expect(deactivate).not.toHaveBeenCalled();

    const artifactState = fixture();
    await applyResidentDaemonInstallTransaction({
      activate: async () => true,
      artifactFile: artifactState.artifactFile,
      deactivate: async () => undefined,
      desiredArtifact: "<plist>current</plist>\n",
      files: artifactState.files,
      productVersion: "1.0.0"
    });
    chmodSync(artifactState.artifactFile, 0o666);
    const artifactActivate = vi.fn(async () => true);
    const artifactDeactivate = vi.fn(async () => undefined);
    const unsafeArtifact = await applyResidentDaemonInstallTransaction({
      activate: artifactActivate,
      artifactFile: artifactState.artifactFile,
      deactivate: artifactDeactivate,
      desiredArtifact: "<plist>current</plist>\n",
      files: artifactState.files,
      productVersion: "1.0.0"
    });
    expect(unsafeArtifact).toMatchObject({
      changed: false,
      ok: false,
      reason: "artifact-drift"
    });
    expect(artifactActivate).not.toHaveBeenCalled();
    expect(artifactDeactivate).not.toHaveBeenCalled();
  });

  it("rejects a tampered prepared backup before mutation", async () => {
    const state = fixture();
    const prior = "<plist>prior</plist>\n";
    writeFileSync(state.artifactFile, prior);
    const interrupted = await applyResidentDaemonInstallTransaction({
      activate: async () => true,
      artifactFile: state.artifactFile,
      deactivate: async () => undefined,
      desiredArtifact: "<plist>next</plist>\n",
      files: state.files,
      productVersion: "1.1.0",
      writePrivate: async (file, contents) => {
        if (file === state.artifactFile) throw new Error("simulated crash");
        await atomicWriteFile(file, contents, { mode: 0o600 });
      }
    });
    const prepared = parseResidentDaemonInstallReceipt(
      readFileSync(state.files.receiptFile, "utf8")
    );
    expect(interrupted).toMatchObject({ changed: true, ok: false, reason: "persistence-failed" });
    expect(prepared).toMatchObject({ phase: "prepared" });
    writeFileSync(prepared!.backupFile!, "<plist>tampered</plist>\n");
    chmodSync(prepared!.backupFile!, 0o600);

    const activate = vi.fn(async () => true);
    const deactivate = vi.fn(async () => undefined);
    const result = await applyResidentDaemonInstallTransaction({
      activate,
      artifactFile: state.artifactFile,
      deactivate,
      desiredArtifact: "<plist>next</plist>\n",
      files: state.files,
      productVersion: "1.1.0"
    });
    expect(result).toMatchObject({ changed: false, ok: false, reason: "backup-invalid" });
    expect(readFileSync(state.artifactFile, "utf8")).toBe(prior);
    expect(activate).not.toHaveBeenCalled();
    expect(deactivate).not.toHaveBeenCalled();
  });

  it("rolls back exact prior bytes when crash recovery cannot activate the prepared artifact", async () => {
    const state = fixture();
    const prior = "<plist>prior</plist>\n";
    const desired = "<plist>next</plist>\n";
    writeFileSync(state.artifactFile, prior);
    const interrupted = await applyResidentDaemonInstallTransaction({
      activate: async () => true,
      artifactFile: state.artifactFile,
      deactivate: async () => undefined,
      desiredArtifact: desired,
      files: state.files,
      productVersion: "1.1.0",
      writePrivate: async (file, contents) => {
        await atomicWriteFile(file, contents, { mode: 0o600 });
        if (file === state.artifactFile) throw new Error("crash after atomic artifact replace");
      }
    });
    expect(interrupted).toMatchObject({ changed: true, ok: false, reason: "persistence-failed" });
    expect(readFileSync(state.artifactFile, "utf8")).toBe(desired);
    expect(parseResidentDaemonInstallReceipt(readFileSync(state.files.receiptFile, "utf8")))
      .toMatchObject({ phase: "prepared" });

    let activations = 0;
    const recovered = await applyResidentDaemonInstallTransaction({
      activate: async () => {
        activations += 1;
        return activations > 1;
      },
      artifactFile: state.artifactFile,
      deactivate: async () => undefined,
      desiredArtifact: desired,
      files: state.files,
      productVersion: "1.1.0"
    });
    expect(recovered).toMatchObject({
      changed: true,
      ok: false,
      reason: "activation-failed",
      receipt: { phase: "rolled-back" },
      rolledBack: true
    });
    expect(readFileSync(state.artifactFile, "utf8")).toBe(prior);
  });

  it("persists rollback-failed and refuses blind retries", async () => {
    const state = fixture();
    writeFileSync(state.artifactFile, "<plist>prior</plist>\n");
    const activate = vi.fn(async () => false);
    const deactivate = vi.fn(async () => undefined);
    const failed = await applyResidentDaemonInstallTransaction({
      activate,
      artifactFile: state.artifactFile,
      deactivate,
      desiredArtifact: "<plist>broken</plist>\n",
      files: state.files,
      productVersion: "1.1.0"
    });
    expect(failed).toMatchObject({
      changed: true,
      ok: false,
      reason: "rollback-failed",
      receipt: { phase: "rollback-failed" },
      rolledBack: false
    });

    activate.mockClear();
    deactivate.mockClear();
    const retry = await applyResidentDaemonInstallTransaction({
      activate,
      artifactFile: state.artifactFile,
      deactivate,
      desiredArtifact: "<plist>broken</plist>\n",
      files: state.files,
      productVersion: "1.1.0"
    });
    expect(retry).toMatchObject({
      changed: false,
      ok: false,
      reason: "rollback-failed",
      receipt: { phase: "rollback-failed" }
    });
    expect(activate).not.toHaveBeenCalled();
    expect(deactivate).not.toHaveBeenCalled();
  });

  it("persists rollback-failed when a rollback effect throws", async () => {
    const state = fixture();
    writeFileSync(state.artifactFile, "<plist>prior</plist>\n");
    let deactivations = 0;
    const failed = await applyResidentDaemonInstallTransaction({
      activate: async () => false,
      artifactFile: state.artifactFile,
      deactivate: async () => {
        deactivations += 1;
        if (deactivations > 1) throw new Error("rollback unload failed");
      },
      desiredArtifact: "<plist>broken</plist>\n",
      files: state.files,
      productVersion: "1.1.0"
    });
    expect(failed).toMatchObject({
      changed: true,
      ok: false,
      reason: "rollback-failed",
      receipt: { phase: "rollback-failed" },
      rolledBack: false
    });

    const activate = vi.fn(async () => true);
    const deactivate = vi.fn(async () => undefined);
    const retry = await applyResidentDaemonInstallTransaction({
      activate,
      artifactFile: state.artifactFile,
      deactivate,
      desiredArtifact: "<plist>broken</plist>\n",
      files: state.files,
      productVersion: "1.1.0"
    });
    expect(retry).toMatchObject({ changed: false, ok: false, reason: "rollback-failed" });
    expect(activate).not.toHaveBeenCalled();
    expect(deactivate).not.toHaveBeenCalled();
  });
});
