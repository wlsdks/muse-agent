import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseResidentDaemonHeartbeatReceipt } from "@muse/runtime-state";
import { describe, expect, it, vi } from "vitest";

import { createResidentDaemonHeartbeatWriter } from "./resident-daemon-heartbeat.js";

describe("resident daemon heartbeat writer", () => {
  it("writes owner-only lease-backed receipts with monotonic progress", async () => {
    const directory = await mkdtemp(join(tmpdir(), "muse-resident-heartbeat-"));
    const times = [
      new Date("2026-07-22T03:00:00.000Z"),
      new Date("2026-07-22T03:01:00.000Z"),
      new Date("2026-07-22T03:02:00.000Z")
    ];
    const writer = createResidentDaemonHeartbeatWriter({
      acquiredAtMs: Date.parse("2026-07-22T02:59:59.000Z"),
      directory,
      expectedCadenceMs: 60_000,
      generation: "resident_generation_01",
      now: () => times.shift()!,
      pid: 4321
    });

    const first = await writer.recordLiveness();
    const second = await writer.recordProgress();
    const third = await writer.recordLiveness();

    expect([first.sequence, second.sequence, third.sequence]).toEqual([1, 2, 3]);
    expect(first.lastProgressAt).toBe("2026-07-22T02:59:59.000Z");
    expect(second.lastProgressAt).toBe("2026-07-22T03:01:00.000Z");
    expect(third.lastProgressAt).toBe(second.lastProgressAt);
    expect(parseResidentDaemonHeartbeatReceipt(await readFile(writer.file, "utf8"))).toEqual(third);
    if (process.platform !== "win32") {
      expect((await stat(writer.file)).mode & 0o777).toBe(0o600);
    }
  });

  it("allows a replacement generation to restart its sequence without reusing authority", async () => {
    const directory = await mkdtemp(join(tmpdir(), "muse-resident-heartbeat-replace-"));
    const base = {
      acquiredAtMs: Date.parse("2026-07-22T02:59:59.000Z"),
      directory,
      expectedCadenceMs: 60_000,
      now: () => new Date("2026-07-22T03:00:00.000Z"),
      pid: 4321
    };
    const first = createResidentDaemonHeartbeatWriter({
      ...base,
      generation: "resident_generation_01"
    });
    await first.recordProgress();
    const replacement = createResidentDaemonHeartbeatWriter({
      ...base,
      generation: "resident_generation_02"
    });

    expect(await replacement.recordProgress()).toMatchObject({
      generation: "resident_generation_02",
      sequence: 1
    });
  });

  it("serializes concurrent writes and never regresses progress when the clock moves backward", async () => {
    const persisted: string[] = [];
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const times = [
      new Date("2026-07-22T03:00:00.000Z"),
      new Date("2026-07-22T02:00:00.000Z")
    ];
    const writeFile = vi.fn(async (_file: string, text: string) => {
      if (persisted.length === 0) await firstBlocked;
      persisted.push(text);
    });
    const writer = createResidentDaemonHeartbeatWriter({
      acquiredAtMs: Date.parse("2026-07-22T02:59:59.000Z"),
      directory: "/private/test",
      expectedCadenceMs: 60_000,
      generation: "resident_generation_01",
      now: () => times.shift()!,
      pid: 4321,
      writeFile
    });

    const first = writer.recordProgress();
    const second = writer.recordProgress();
    await Promise.resolve();
    expect(writeFile).toHaveBeenCalledOnce();
    releaseFirst();
    const [one, two] = await Promise.all([first, second]);

    expect([one.sequence, two.sequence]).toEqual([1, 2]);
    expect(two.at).toBe(one.at);
    expect(two.lastProgressAt).toBe(one.lastProgressAt);
    expect(parseResidentDaemonHeartbeatReceipt(persisted[1]!)).toEqual(two);
  });

  it("surfaces atomic write failures instead of reporting progress", async () => {
    const writeFile = vi.fn(async () => {
      throw new Error("PRIVATE storage failure");
    });
    const writer = createResidentDaemonHeartbeatWriter({
      acquiredAtMs: Date.parse("2026-07-22T02:59:59.000Z"),
      directory: "/private/test",
      expectedCadenceMs: 60_000,
      generation: "resident_generation_01",
      now: () => new Date("2026-07-22T03:00:00.000Z"),
      pid: 4321,
      writeFile
    });

    await expect(writer.recordLiveness()).rejects.toThrow();
    expect(writeFile).toHaveBeenCalledOnce();
  });
});
