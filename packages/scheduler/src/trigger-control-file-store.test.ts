import {
  chmod,
  mkdir,
  lstat,
  mkdtemp,
  readFile,
  stat,
  symlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createTriggerEnvelope } from "@muse/shared";
import { FileTriggerAdmissionJournalStore } from "@muse/stores";
import { describe, expect, it } from "vitest";

import {
  TriggerControlFileStore,
  TriggerControlFileStoreError
} from "./trigger-control-file-store.js";

const at = new Date("2026-07-30T08:00:00.000Z");

function envelope(generation = "occurrence-1") {
  return createTriggerEnvelope({
    generation,
    occurredAt: at,
    receivedAt: at,
    source: "reminder",
    sourceId: "reminder-1"
  });
}

async function tempStore(maxPending = 2) {
  const root = await mkdtemp(join(tmpdir(), "muse-trigger-control-"));
  const file = join(root, "trigger-control.json");
  return { file, store: new TriggerControlFileStore(file, { maxPending }) };
}

describe("TriggerControlFileStore", () => {
  it("imports a legacy journal read-only and writes only the new file on first mutation", async () => {
    const root = await mkdtemp(join(tmpdir(), "muse-trigger-control-migration-"));
    const legacyFile = join(root, "trigger-admission-journal.json");
    const controlFile = join(root, "trigger-control.json");
    const legacy = new FileTriggerAdmissionJournalStore({
      file: legacyFile,
      maxEntries: 8,
      maxPending: 2
    });
    const completed = envelope("legacy-completed");
    const queued = envelope("legacy-queued");
    await legacy.admit({ envelope: completed, now: at });
    await legacy.settle({
      at: new Date("2026-07-30T08:00:30.000Z"),
      dedupKey: completed.dedupKey,
      outcome: "completed"
    });
    await legacy.admit({ envelope: queued, now: at });
    await legacy.admit({
      envelope: envelope("legacy-shadowed"),
      now: at,
      shadowOnly: true
    });
    const legacyJournal = await legacy.read();
    const legacyBytes = await readFile(legacyFile);
    const store = new TriggerControlFileStore(
      controlFile,
      { maxEntries: 8, maxPending: 2 },
      { legacyJournalFile: legacyFile }
    );

    const imported = await store.snapshot();
    expect(imported.journal).toEqual(legacyJournal);
    expect(imported.workStates).toEqual([
      expect.objectContaining({
        dedupKey: completed.dedupKey,
        status: "completed"
      })
    ]);
    await expect(lstat(controlFile)).rejects.toMatchObject({ code: "ENOENT" });

    await store.admit({ envelope: envelope("new-occurrence"), now: at });
    if (process.platform !== "win32") {
      expect((await stat(controlFile)).mode & 0o777).toBe(0o600);
    }
    expect(await readFile(legacyFile)).toEqual(legacyBytes);
    const restarted = new TriggerControlFileStore(
      controlFile,
      { maxEntries: 8, maxPending: 2 },
      { legacyJournalFile: legacyFile }
    );
    expect((await restarted.snapshot()).journal.entries).toHaveLength(4);
    await writeFile(legacyFile, "{", { mode: 0o600 });
    expect((await restarted.snapshot()).journal.entries).toHaveLength(4);
  });

  it("fails closed on corrupt, unsafe, or mismatched legacy state without creating control state", async () => {
    const root = await mkdtemp(join(tmpdir(), "muse-trigger-control-legacy-failure-"));
    const controlFile = join(root, "trigger-control.json");
    const legacyFile = join(root, "legacy.json");
    await writeFile(legacyFile, "{", { mode: 0o600 });
    const corrupt = new TriggerControlFileStore(
      controlFile,
      { maxPending: 2 },
      { legacyJournalFile: legacyFile }
    );
    await expect(corrupt.snapshot()).rejects.toMatchObject({ code: "corrupt-state" });
    await expect(lstat(controlFile)).rejects.toMatchObject({ code: "ENOENT" });

    if (process.platform !== "win32") {
      const target = join(root, "legacy-target.json");
      const link = join(root, "legacy-link.json");
      await writeFile(target, "{}", { mode: 0o600 });
      await symlink(target, link);
      const unsafe = new TriggerControlFileStore(
        controlFile,
        { maxPending: 2 },
        { legacyJournalFile: link }
      );
      await expect(unsafe.snapshot()).rejects.toMatchObject({ code: "unsafe-file" });
      await expect(lstat(controlFile)).rejects.toMatchObject({ code: "ENOENT" });
    }

    const mismatchedFile = join(root, "legacy-mismatched.json");
    const mismatchedJournal = new FileTriggerAdmissionJournalStore({
      file: mismatchedFile,
      maxPending: 1
    });
    await mismatchedJournal.admit({ envelope: envelope("mismatch"), now: at });
    const mismatched = new TriggerControlFileStore(
      controlFile,
      { maxPending: 2 },
      { legacyJournalFile: mismatchedFile }
    );
    await expect(mismatched.snapshot()).rejects.toMatchObject({
      code: "configuration-mismatch"
    });
    await expect(lstat(controlFile)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("persists an admitted trigger as owner-only state and reloads it after restart", async () => {
    const { file, store } = await tempStore();
    expect((await store.snapshot()).revision).toBe(0);

    const admitted = await store.admit({ envelope: envelope(), now: at });
    expect(admitted.decision.action).toBe("execute");
    expect(admitted.recorded).toBe(true);
    expect(admitted.state.revision).toBe(1);
    if (process.platform !== "win32") {
      expect((await stat(file)).mode & 0o777).toBe(0o600);
    }

    const restarted = new TriggerControlFileStore(file, { maxPending: 2 });
    expect(await restarted.snapshot()).toEqual(admitted.state);
  });

  it("serializes concurrent duplicate admission and does not rewrite the winning bytes", async () => {
    const { file, store } = await tempStore();
    const occurrence = envelope();
    const results = await Promise.all([
      store.admit({ envelope: occurrence, now: at }),
      store.admit({ envelope: occurrence, now: at })
    ]);

    expect(results.filter((result) => result.recorded)).toHaveLength(1);
    expect((await store.snapshot()).revision).toBe(1);
    const before = await readFile(file);
    const replay = await store.admit({ envelope: occurrence, now: at });
    expect(replay.recorded).toBe(false);
    expect(replay.decision.reasons).toContain("duplicate");
    expect(await readFile(file)).toEqual(before);
  });

  it("keeps lock-free snapshots valid while atomic replacements are in flight", async () => {
    const { file, store } = await tempStore(64);
    const reader = new TriggerControlFileStore(file, { maxPending: 64 });
    const writes = Array.from({ length: 32 }, (_unused, index) =>
      store.admit({
        envelope: envelope(`occurrence-${(index + 1).toString()}`),
        now: at,
        shadowOnly: true
      }));
    const reads = Array.from({ length: 64 }, async () => {
      const snapshot = await reader.snapshot();
      expect(snapshot.revision).toBeGreaterThanOrEqual(0);
    });

    await expect(Promise.all([...writes, ...reads])).resolves.toHaveLength(96);
    expect((await reader.snapshot()).journal.entries).toHaveLength(32);
  });

  it("retains claim and terminal settlement across a new store instance", async () => {
    const { file, store } = await tempStore();
    const occurrence = envelope();
    await store.admit({ envelope: occurrence, now: at });
    await store.claim({
      at,
      dedupKey: occurrence.dedupKey,
      leaseDurationMs: 60_000,
      leaseToken: "lease-1",
      maxAttempts: 2
    });

    const restarted = new TriggerControlFileStore(file, { maxPending: 2 });
    const settled = await restarted.settle({
      at: new Date("2026-07-30T08:00:30.000Z"),
      dedupKey: occurrence.dedupKey,
      leaseToken: "lease-1",
      outcome: "succeeded"
    });
    expect(settled.workStates[0]?.status).toBe("completed");
    expect(settled.journal.entries[0]?.state).toBe("completed");
    expect((await restarted.snapshot()).stateId).toBe(settled.stateId);
  });

  it("durably reconciles an expired final lease exactly once", async () => {
    const { file, store } = await tempStore();
    const occurrence = envelope("expired-final");
    await store.admit({ envelope: occurrence, now: at });
    await store.claim({
      at,
      dedupKey: occurrence.dedupKey,
      leaseDurationMs: 1_000,
      leaseToken: "lease-expired",
      maxAttempts: 1
    });

    const reconciled = await store.reconcileExpired(
      new Date("2026-07-30T08:00:01.000Z")
    );
    expect(reconciled).toMatchObject({
      journal: {
        entries: [{ state: "dead-lettered", terminalReason: "lease-expired" }]
      },
      workStates: [{ status: "dead-lettered", terminalReason: "lease-expired" }]
    });
    const bytes = await readFile(file);
    const replay = await store.reconcileExpired(
      new Date("2026-07-30T08:00:02.000Z")
    );
    expect(replay.stateId).toBe(reconciled.stateId);
    expect(await readFile(file)).toEqual(bytes);
  });

  it("fails closed on corrupt state or configuration drift without changing bytes", async () => {
    const { file, store } = await tempStore();
    await writeFile(file, "{", { mode: 0o600 });
    const corrupt = await readFile(file);
    await expect(store.admit({ envelope: envelope(), now: at })).rejects.toMatchObject({
      code: "corrupt-state"
    });
    expect(await readFile(file)).toEqual(corrupt);

    const other = await tempStore(1);
    await other.store.admit({ envelope: envelope(), now: at });
    const beforeDrift = await readFile(other.file);
    const drifted = new TriggerControlFileStore(other.file, { maxPending: 2 });
    await expect(drifted.snapshot()).rejects.toEqual(
      new TriggerControlFileStoreError("configuration-mismatch")
    );
    expect(await readFile(other.file)).toEqual(beforeDrift);
  });

  it("rejects symlinks and non-owner-only files without replacing them", async () => {
    if (process.platform === "win32") return;
    const root = await mkdtemp(join(tmpdir(), "muse-trigger-control-unsafe-"));
    const target = join(root, "target.json");
    const link = join(root, "link.json");
    await writeFile(target, "target", { mode: 0o600 });
    await symlink(target, link);
    const linked = new TriggerControlFileStore(link, { maxPending: 2 });
    await expect(linked.admit({ envelope: envelope(), now: at })).rejects.toMatchObject({
      code: "unsafe-file"
    });
    expect((await lstat(link)).isSymbolicLink()).toBe(true);
    expect(await readFile(target, "utf8")).toBe("target");

    const { file, store } = await tempStore();
    await writeFile(file, "{}", { mode: 0o600 });
    await chmod(file, 0o644);
    const before = await readFile(file);
    await expect(store.admit({ envelope: envelope(), now: at })).rejects.toMatchObject({
      code: "unsafe-file"
    });
    expect(await readFile(file)).toEqual(before);
  });

  it("fails closed on a missing state beneath a symlinked or non-private parent", async () => {
    if (process.platform === "win32") return;
    const root = await mkdtemp(join(tmpdir(), "muse-trigger-control-parent-"));
    const targetParent = join(root, "target");
    const linkedParent = join(root, "linked");
    await mkdir(targetParent, { mode: 0o700 });
    await symlink(targetParent, linkedParent);
    const linked = new TriggerControlFileStore(join(linkedParent, "state.json"), { maxPending: 2 });
    await expect(linked.snapshot()).rejects.toMatchObject({ code: "unsafe-file" });

    const unsafeParent = join(root, "unsafe");
    await mkdir(unsafeParent, { mode: 0o700 });
    await chmod(unsafeParent, 0o777);
    const unsafe = new TriggerControlFileStore(join(unsafeParent, "state.json"), { maxPending: 2 });
    await expect(unsafe.snapshot()).rejects.toMatchObject({ code: "unsafe-file" });
  });

  it("reclaims an exact owner-private lock whose owner process is gone", async () => {
    const { file, store } = await tempStore();
    const lock = `${file}.lock`;
    await writeFile(lock, "v1:2147483647:00000000-0000-4000-8000-000000000000", { mode: 0o600 });

    await expect(store.admit({ envelope: envelope(), now: at })).resolves.toMatchObject({
      recorded: true
    });
    await expect(lstat(lock)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
