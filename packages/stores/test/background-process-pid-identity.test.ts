import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  getBackgroundProcess,
  pidIdentityMatches,
  reconcileBackgroundProcesses,
  registerBackgroundProcess,
  spawnBackgroundProcess,
  stopBackgroundProcess,
  type BackgroundProcessRecord,
  type BackgroundSpawner,
  type SpawnedChild
} from "../src/index.js";

function tmpFile(): string {
  return join(mkdtempSync(join(tmpdir(), "muse-bgpid-")), "processes.json");
}

const rec = (over: Partial<BackgroundProcessRecord>): BackgroundProcessRecord => ({
  id: "p",
  pid: 4242,
  command: "npm run dev",
  startedAt: "2026-06-24T00:00:00.000Z",
  status: "running",
  ...over
});

const now = () => new Date("2026-06-24T12:00:00.000Z");

describe("pidIdentityMatches", () => {
  it("matches when the record has no osStartTime (legacy, unverifiable)", () => {
    expect(pidIdentityMatches({ osStartTime: undefined }, "anything")).toBe(true);
    expect(pidIdentityMatches({ osStartTime: undefined }, undefined)).toBe(true);
  });

  it("matches when the current start-time equals the recorded one", () => {
    expect(pidIdentityMatches({ osStartTime: "A" }, "A")).toBe(true);
  });

  it("does not match when the current start-time differs", () => {
    expect(pidIdentityMatches({ osStartTime: "A" }, "B")).toBe(false);
  });

  it("does not match when the current start-time is unreadable (pid gone)", () => {
    expect(pidIdentityMatches({ osStartTime: "A" }, undefined)).toBe(false);
  });
});

describe("spawnBackgroundProcess captures osStartTime", () => {
  class FakeChild implements SpawnedChild {
    pid = 1234;
    onExit(): void {
      /* not exercised here */
    }
  }

  function fakeSpawner(child: FakeChild): BackgroundSpawner {
    return { spawn: () => child };
  }

  it("stores the OS start-time returned by the injected reader", async () => {
    const file = tmpFile();
    const record = await spawnBackgroundProcess("npm run dev", {}, {
      storeFile: file,
      spawner: fakeSpawner(new FakeChild()),
      logFileFor: (id) => `/logs/${id}.log`,
      now: () => new Date("2026-06-24T00:00:00.000Z"),
      newId: () => "bg1",
      readProcessStartTime: (pid) => (pid === 1234 ? "Wed Jun 24 00:00:00 2026" : undefined)
    });
    expect(record.osStartTime).toBe("Wed Jun 24 00:00:00 2026");
  });

  it("omits the field when the reader returns undefined", async () => {
    const file = tmpFile();
    const record = await spawnBackgroundProcess("npm run dev", {}, {
      storeFile: file,
      spawner: fakeSpawner(new FakeChild()),
      logFileFor: (id) => `/logs/${id}.log`,
      now: () => new Date("2026-06-24T00:00:00.000Z"),
      newId: () => "bg1",
      readProcessStartTime: () => undefined
    });
    expect(record.osStartTime).toBeUndefined();
  });
});

describe("stopBackgroundProcess — PID-reuse identity check", () => {
  it("does NOT kill when the pid was reused (start-time mismatch) — fail-closed to exited", async () => {
    const file = tmpFile();
    await registerBackgroundProcess(file, rec({ id: "a", pid: 999, osStartTime: "A" }));
    const killed: number[] = [];
    const result = await stopBackgroundProcess(file, "a", (pid) => killed.push(pid), now, () => "B");
    expect(result).toBe("pid_reused");
    expect(killed).toEqual([]);
    expect(await getBackgroundProcess(file, "a")).toMatchObject({ status: "exited", endedAt: "2026-06-24T12:00:00.000Z" });
  });

  it("kills when the pid's identity still matches", async () => {
    const file = tmpFile();
    await registerBackgroundProcess(file, rec({ id: "a", pid: 999, osStartTime: "A" }));
    const killed: number[] = [];
    const result = await stopBackgroundProcess(file, "a", (pid) => killed.push(pid), now, () => "A");
    expect(result).toBe("stopped");
    expect(killed).toEqual([999]);
    expect((await getBackgroundProcess(file, "a"))?.status).toBe("killed");
  });

  it("kills a legacy record (no osStartTime) even with a reader provided — can't verify, preserves prior behavior", async () => {
    const file = tmpFile();
    await registerBackgroundProcess(file, rec({ id: "a", pid: 999 }));
    const killed: number[] = [];
    const result = await stopBackgroundProcess(file, "a", (pid) => killed.push(pid), now, () => "whatever");
    expect(result).toBe("stopped");
    expect(killed).toEqual([999]);
  });

  it("kills when no reader is provided at all — back-compat with the pre-fix call signature", async () => {
    const file = tmpFile();
    await registerBackgroundProcess(file, rec({ id: "a", pid: 999, osStartTime: "A" }));
    const killed: number[] = [];
    const result = await stopBackgroundProcess(file, "a", (pid) => killed.push(pid), now);
    expect(result).toBe("stopped");
    expect(killed).toEqual([999]);
  });
});

describe("reconcileBackgroundProcesses — PID-reuse identity check", () => {
  it("marks exited when isAlive is true but the start-time no longer matches (pid reused)", async () => {
    const file = tmpFile();
    await registerBackgroundProcess(file, rec({ id: "a", pid: 100, osStartTime: "A" }));
    const reconciled = await reconcileBackgroundProcesses(file, () => true, now, () => "B");
    expect(reconciled).toEqual(["a"]);
    expect((await getBackgroundProcess(file, "a"))?.status).toBe("exited");
  });

  it("leaves it running when isAlive is true and the start-time matches", async () => {
    const file = tmpFile();
    await registerBackgroundProcess(file, rec({ id: "a", pid: 100, osStartTime: "A" }));
    const reconciled = await reconcileBackgroundProcesses(file, () => true, now, () => "A");
    expect(reconciled).toEqual([]);
    expect((await getBackgroundProcess(file, "a"))?.status).toBe("running");
  });

  it("marks exited when isAlive is false, regardless of the reader", async () => {
    const file = tmpFile();
    await registerBackgroundProcess(file, rec({ id: "a", pid: 100, osStartTime: "A" }));
    const reconciled = await reconcileBackgroundProcesses(file, () => false, now, () => "A");
    expect(reconciled).toEqual(["a"]);
    expect((await getBackgroundProcess(file, "a"))?.status).toBe("exited");
  });
});
