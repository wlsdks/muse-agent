import {
  chmod,
  lstat,
  mkdtemp,
  readFile,
  stat,
  symlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  activateQualificationLearningHold,
  inspectQualificationLearningHold
} from "./qualification-learning-hold-store.js";

describe("qualification learning hold store", () => {
  it("treats a missing file as inactive and valid activation as idempotent owner-only state", async () => {
    const root = await mkdtemp(join(tmpdir(), "muse-qualification-hold-"));
    const file = join(root, "hold.json");
    const activatedAt = "2026-07-26T06:00:00.000Z";

    expect(await inspectQualificationLearningHold(file)).toEqual({ engaged: false, state: "inactive" });
    const first = await activateQualificationLearningHold(file, {
      activatedAt,
      holdId: "personal-agent-v1"
    });
    const before = await readFile(file);
    const second = await activateQualificationLearningHold(file, {
      activatedAt: "2026-07-26T07:00:00.000Z",
      holdId: "personal-agent-v1"
    });
    const after = await readFile(file);

    expect(second).toEqual(first);
    expect(after).toEqual(before);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(await inspectQualificationLearningHold(file)).toEqual({
      engaged: true,
      record: first,
      state: "active"
    });
  });

  it.each([
    ["invalid-json", "{"],
    ["invalid-schema", JSON.stringify({ active: false, schemaVersion: 1 })],
    ["invalid-schema", JSON.stringify({
      active: true,
      activatedAt: "not-an-iso-date",
      holdId: "personal-agent-v1",
      reason: "personal-agent-qualification",
      schemaVersion: 1
    })]
  ])("fails closed on an existing %s record", async (failure, contents) => {
    const root = await mkdtemp(join(tmpdir(), "muse-qualification-hold-invalid-"));
    const file = join(root, "hold.json");
    await writeFile(file, contents, { mode: 0o600 });

    expect(await inspectQualificationLearningHold(file)).toEqual({
      engaged: true,
      failure,
      state: "invalid"
    });
    await expect(activateQualificationLearningHold(file, {
      activatedAt: "2026-07-26T06:00:00.000Z",
      holdId: "personal-agent-v1"
    })).rejects.toThrow(/fail-closed/u);
    expect(await readFile(file, "utf8")).toBe(contents);
  });

  it("fails closed when an existing record is unreadable", async () => {
    if (process.platform === "win32" || (typeof process.getuid === "function" && process.getuid() === 0)) return;
    const root = await mkdtemp(join(tmpdir(), "muse-qualification-hold-unreadable-"));
    const file = join(root, "hold.json");
    await writeFile(file, "{}");
    await chmod(file, 0o000);
    try {
      expect(await inspectQualificationLearningHold(file)).toEqual({
        engaged: true,
        failure: "unreadable",
        state: "invalid"
      });
    } finally {
      await chmod(file, 0o600);
    }
  });

  it("fails closed without following or replacing a dangling symlink", async () => {
    if (process.platform === "win32") return;
    const root = await mkdtemp(join(tmpdir(), "muse-qualification-hold-symlink-"));
    const file = join(root, "hold.json");
    const target = join(root, "missing-target.json");
    await symlink(target, file);

    expect(await inspectQualificationLearningHold(file)).toEqual({
      engaged: true,
      failure: "unsafe-file-type",
      state: "invalid"
    });
    await expect(activateQualificationLearningHold(file, {
      activatedAt: "2026-07-26T06:00:00.000Z",
      holdId: "personal-agent-v1"
    })).rejects.toThrow(/fail-closed/u);
    expect((await lstat(file)).isSymbolicLink()).toBe(true);
    await expect(readFile(target)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects an otherwise valid record with non-owner-only permissions without rewriting it", async () => {
    if (process.platform === "win32") return;
    const root = await mkdtemp(join(tmpdir(), "muse-qualification-hold-permissions-"));
    const file = join(root, "hold.json");
    const contents = JSON.stringify({
      active: true,
      activatedAt: "2026-07-26T06:00:00.000Z",
      holdId: "personal-agent-v1",
      reason: "personal-agent-qualification",
      schemaVersion: 1
    });
    await writeFile(file, contents, { mode: 0o666 });
    await chmod(file, 0o666);

    expect(await inspectQualificationLearningHold(file)).toEqual({
      engaged: true,
      failure: "unsafe-permissions",
      state: "invalid"
    });
    await expect(activateQualificationLearningHold(file, {
      activatedAt: "2026-07-26T07:00:00.000Z",
      holdId: "personal-agent-v1"
    })).rejects.toThrow(/fail-closed/u);
    expect(await readFile(file, "utf8")).toBe(contents);
    expect((await stat(file)).mode & 0o777).toBe(0o666);
  });

  it("rejects non-canonical timestamps, unsafe ids, and conflicting active ids", async () => {
    const root = await mkdtemp(join(tmpdir(), "muse-qualification-hold-validation-"));
    const file = join(root, "hold.json");
    await expect(activateQualificationLearningHold(file, {
      activatedAt: "2026-07-26T06:00:00Z",
      holdId: "personal-agent-v1"
    })).rejects.toThrow(/canonical ISO/u);
    await expect(activateQualificationLearningHold(file, {
      activatedAt: "2026-07-26T06:00:00.000Z",
      holdId: "../escape"
    })).rejects.toThrow(/hold id/u);
    await activateQualificationLearningHold(file, {
      activatedAt: "2026-07-26T06:00:00.000Z",
      holdId: "personal-agent-v1"
    });
    await expect(activateQualificationLearningHold(file, {
      activatedAt: "2026-07-26T07:00:00.000Z",
      holdId: "other-hold"
    })).rejects.toThrow(/already active/u);
  });

  it("serializes concurrent activation so one durable record is authoritative", async () => {
    const root = await mkdtemp(join(tmpdir(), "muse-qualification-hold-concurrent-"));
    const sameIdFile = join(root, "same-id.json");
    const sameId = await Promise.all([
      activateQualificationLearningHold(sameIdFile, {
        activatedAt: "2026-07-26T06:00:00.000Z",
        holdId: "personal-agent-v1"
      }),
      activateQualificationLearningHold(sameIdFile, {
        activatedAt: "2026-07-26T06:00:01.000Z",
        holdId: "personal-agent-v1"
      })
    ]);
    expect(sameId[1]).toEqual(sameId[0]);
    expect((await inspectQualificationLearningHold(sameIdFile)).state).toBe("active");

    const conflictingFile = join(root, "conflicting-id.json");
    const conflicting = await Promise.allSettled([
      activateQualificationLearningHold(conflictingFile, {
        activatedAt: "2026-07-26T06:00:00.000Z",
        holdId: "hold-a"
      }),
      activateQualificationLearningHold(conflictingFile, {
        activatedAt: "2026-07-26T06:00:01.000Z",
        holdId: "hold-b"
      })
    ]);
    expect(conflicting.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(conflicting.filter((result) => result.status === "rejected")).toHaveLength(1);
    const persisted = await inspectQualificationLearningHold(conflictingFile);
    expect(persisted.state).toBe("active");
    if (persisted.state === "active") {
      expect(["hold-a", "hold-b"]).toContain(persisted.record.holdId);
    }
  });
});
